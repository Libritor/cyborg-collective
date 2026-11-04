"""Feed the Quest's screen to go2rtc as raw H.264 on stdout, over Wi-Fi adb.

go2rtc runs this as an exec source when the first viewer opens the stream and
kills it when the last one leaves, so the headset only encodes while someone
watches. The picture comes from scrcpy's server (pushed to the headset, run
with app_process, raw_stream=true): the headset's own encoder, cropped on the
headset to one eye, no window and no time limit.

The headset's display sleeps when it is taken off, and a capture begun (or
running) across that sleep never delivers frames again, so this keeps one
capture session at a time and starts a fresh one whenever the frames stop:
it waits while the headset sleeps and reopens the capture when it wakes. Each
session begins with SPS/PPS and a keyframe; keyframes every ~2 s carry SPS/PPS
too, so viewers who join late, or whose player reconnects, start within ~2 s.

    streams:
      quest: exec:python -u quest_feed.py --serial <headset ip>:5555

Stand-alone check (writes 10 s to a file):
    python quest_feed.py --serial <headset ip>:5555 --seconds 10 > quest.h264
"""
import argparse
import os
import random
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ADB = os.environ.get("QUEST_ADB", "adb")
SERVER = os.path.join(HERE, "bin", "scrcpy", "scrcpy-win64-v5.0.1", "scrcpy-server")
VERSION = "5.0.1"
REMOTE = "/data/local/tmp/scrcpy-server-quest.jar"
GAP = 5.0            # seconds without a byte before the capture counts as stalled


def log(*a):
    print("[quest_feed]", time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def adb(serial, *args, timeout=30):
    return subprocess.run([ADB, "-s", serial, *args], capture_output=True, text=True, timeout=timeout)


def connected(serial):
    if serial in subprocess.run([ADB, "devices"], capture_output=True, text=True).stdout.split():
        return True
    r = subprocess.run([ADB, "connect", serial], capture_output=True, text=True, timeout=15)
    log("adb connect:", r.stdout.strip())
    return "connected" in r.stdout


def awake(serial):
    try:
        out = adb(serial, "shell", "dumpsys power | grep mWakefulness=", timeout=10).stdout
    except subprocess.TimeoutExpired:
        return False
    return "Awake" in out


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Session:
    """One scrcpy server on the headset and the local socket its video comes on."""

    def __init__(self, a):
        self.a, self.sock, self.srv, self.port = a, None, None, None

    def open(self):
        a = self.a
        # go2rtc stops this script with TerminateProcess, so no finally runs: the
        # headset can be left with a capture server (and the PC with its forward)
        # from an earlier run. Only one feed runs at a time, so clear them first.
        adb(a.serial, "shell", "pkill -f com.genymobile.scrcpy.Server")
        for line in subprocess.run([ADB, "forward", "--list"], capture_output=True, text=True).stdout.splitlines():
            f = line.split()
            if len(f) == 3 and f[0] == a.serial and f[2].startswith("localabstract:scrcpy_"):
                adb(a.serial, "forward", "--remove", f[1])
        r = adb(a.serial, "push", SERVER, REMOTE)
        if r.returncode != 0:
            raise RuntimeError("adb push: " + (r.stderr or r.stdout).strip())
        scid = "%08x" % random.randrange(1, 0x7FFFFFFF)
        self.port = free_port()
        adb(a.serial, "forward", f"tcp:{self.port}", f"localabstract:scrcpy_{scid}")
        # raw_stream turns off every header; the dummy byte (set after it, the
        # order counts) comes back on so the connect below can tell the server's
        # accept from adb's, without waiting for a first frame. A viewer who joins
        # mid-stream starts at the next keyframe and needs SPS/PPS with it; by
        # default the headset sends those once and a keyframe only every ~20 s.
        opts = [f"scid={scid}", "log_level=info", "tunnel_forward=true", "raw_stream=true", "send_dummy_byte=true",
                "audio=false", "control=false", "cleanup=true", f"max_size={a.max_size}",
                f"video_bit_rate={a.bit_rate}", f"max_fps={a.max_fps}", "video_codec=h264",
                f"video_codec_options=i-frame-interval:int={a.keyframe_every},prepend-sps-pps-to-idr-frames:int=1"]
        if a.crop:
            opts.append(f"crop={a.crop}")
        cmd = [ADB, "-s", a.serial, "shell", f"CLASSPATH={REMOTE}", "app_process", "/",
               "com.genymobile.scrcpy.Server", VERSION, *opts]
        self.srv = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        t0 = time.time()
        while time.time() - t0 < 15:          # the server listens a moment after it starts
            if self.srv.poll() is not None:
                raise RuntimeError("scrcpy server exited: " + (self.srv.stdout.read() or "").strip()[-400:])
            sock = None
            try:
                sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
                if sock.recv(1):              # the dummy byte; adb's own accept closes empty
                    self.sock = sock
                    self.sock.settimeout(GAP)
                    return scid
                sock.close()
            except OSError:
                if sock:
                    sock.close()
            time.sleep(0.3)
        raise RuntimeError("the headset's video server did not answer within 15 s")

    def close(self):
        if self.sock:
            self.sock.close()
        if self.srv:
            self.srv.terminate()
            try:
                self.srv.wait(timeout=3)
            except Exception:
                self.srv.kill()
        if self.port:
            adb(self.a.serial, "forward", "--remove", f"tcp:{self.port}")
        self.sock = self.srv = self.port = None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--serial", required=True, help="adb serial of the headset, e.g. 192.168.1.50:5555")
    ap.add_argument("--crop", default="", help="W:H:X:Y on the headset's display (empty = whole display)")
    ap.add_argument("--max-size", type=int, default=1440, help="longest side after the crop, pixels")
    ap.add_argument("--bit-rate", default="4M")
    ap.add_argument("--max-fps", type=int, default=30)
    ap.add_argument("--keyframe-every", type=int, default=1,
                    help="encoder keyframe interval, s (the headset doubles it: 1 gives ~2 s at 30 fps)")
    ap.add_argument("--give-up", type=float, default=300,
                    help="exit if no picture has come for this long (go2rtc restarts it for the next viewer)")
    ap.add_argument("--seconds", type=float, default=0, help="stop after this long (0 = until killed)")
    a = ap.parse_args()
    br = a.bit_rate.upper()                   # the server takes plain bits per second
    a.bit_rate = str(int(float(br[:-1]) * {"K": 1e3, "M": 1e6}[br[-1]]) if br[-1] in "KM" else int(br))

    out = sys.stdout.buffer
    end = time.time() + a.seconds if a.seconds else None
    last_data = time.time()
    s = Session(a)
    try:
        while end is None or time.time() < end:
            if time.time() - last_data > a.give_up:
                raise RuntimeError(f"no picture for {a.give_up:.0f} s")
            if not connected(a.serial):
                time.sleep(3)
                continue
            if not awake(a.serial):           # taken off: wait for it to be worn again
                time.sleep(2)
                continue
            try:
                scid = s.open()
            except Exception as e:
                log("capture did not start:", e)
                s.close()
                time.sleep(3)
                continue
            log(f"capturing from {a.serial} (scid {scid}, local port {s.port})")
            try:
                while end is None or time.time() < end:
                    b = s.sock.recv(65536)
                    if not b:
                        log("headset closed the video socket")
                        break
                    out.write(b)
                    out.flush()
                    last_data = time.time()
            except socket.timeout:
                log(f"no frames for {GAP:.0f} s (headset {'awake' if awake(a.serial) else 'asleep'}); reopening")
            s.close()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    finally:
        s.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log("error:", e)
        sys.exit(1)
