#!/usr/bin/env python3
"""One sitting from headset to print file: start the scan app on the Quest, wait for the scan, make the splat and
the solid, show them in the headset.

    python scan_session.py                    # with the controller: trigger on the object, walk round it, B
    python scan_session.py --hands-free 120   # no controller: look at the object, walk round it; saves by itself
                                              # after 120 pictures or a full circle
    python scan_session.py --save-after 90    # ask the headset to save 90 s after the scan starts
    python scan_session.py --live             # while scanning, a rough view of what is seen goes to 6ense.com as it happens
    python scan_session.py --publish          # afterwards, the trained splat goes on 6ense.com/scans/ (scan_publish.py)

--live and --publish send to a public website. --live: the headset app also casts depth rays for a coarse cloud of
coloured blobs (untrained: one blob per depth reading) and quest_splat.py passes them through the relay to the page's
Live section while the scan runs; it stops when the scan is saved. --publish: once the splat is trained, it is
compressed and put on the site with its solid and print files; the camera pictures are not. What a headset looks at
can include a room and the people in it: use either only where that may be shown.

What it does: checks the headset is on USB, puts the current build on it (unless --no-install), waits until the
headset is worn and past its "press the power button to enable cameras" screen (that needs a person: it is the
headset's privacy guard and is not worked around), starts Print What I See, follows its log until it says
"SCAN SAVED", pulls the scan, runs quest_scan.py, and opens the result in the Quest Browser (scan_view.py --quest;
press "Enter AR" there). Everything stays on this computer and the headset; nothing is sent to the printer.
"""
import argparse
import atexit
import os
import re
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = "com.mersivity.printsee"
ACT = PKG + "/com.unity3d.player.UnityPlayerGameActivity"
APK = os.path.join(os.path.expanduser("~"), "Mersivity", "MersivityQuest", "Builds", "PrintWhatISee.apk")
ENV = dict(os.environ, MSYS_NO_PATHCONV="1")
OUT_ROOT = os.path.join(os.path.expanduser("~"), "Downloads", "quest_scans")
LIVE_PORT = 8791


def log(*a):
    print("[session]", time.strftime("%H:%M:%S"), *a, flush=True)


def adb(*args, timeout=60):
    try:
        r = subprocess.run(["adb", *args], capture_output=True, text=True, env=ENV, timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        return 1, "timeout"


def headset_state():
    """-> 'none' (not on adb), 'asleep', 'privacy' (its camera privacy screen), 'awake'."""
    code, out = adb("get-state", timeout=10)
    if code != 0 or "device" not in out:
        return "none"
    _, power = adb("shell", "dumpsys", "power", timeout=20)
    if "mWakefulness=Awake" not in power:
        return "asleep"
    _, act = adb("shell", "dumpsys", "activity", "activities", timeout=20)
    top = next((l for l in act.splitlines() if "topResumedActivity" in l), "")
    return "privacy" if "SensorLock" in top else "awake"


def start_live(python, relay=None):
    """The rough live view: quest_splat.py listens for the splat packets the app sends through adb and passes them to
    the relay. It does not start the app (this script does, with both jobs asked for). -> (its process, its stop file)."""
    os.makedirs(OUT_ROOT, exist_ok=True)
    stop = os.path.join(OUT_ROOT, f"live_stop_{os.getpid()}")
    if os.path.exists(stop):
        os.remove(stop)
    cmd = [python, "-I", "-u", os.path.join(HERE, "quest_splat.py"), "--no-launch", "--port", str(LIVE_PORT), "--stop-file", stop]
    if relay:
        cmd += ["--relay", relay]
    logf = open(os.path.join(OUT_ROOT, "live.log"), "w")
    proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    time.sleep(3)
    if proc.poll() is not None:
        log("the live view did not start (Downloads\\quest_scans\\live.log says why); the scan goes on without it")
        return None, stop
    return proc, stop


def stop_live(proc, stop):
    if not proc or proc.poll() is not None:      # not started, or already stopped (this also runs when the script ends early)
        return
    open(stop, "w").close()                      # quest_splat.py looks for it every 5 s, says goodbye to the relay and saves
    try:
        proc.wait(30)
    except subprocess.TimeoutExpired:
        proc.kill()
    try:
        os.remove(stop)
    except OSError:
        pass
    log("the live view has stopped; its card leaves the page")


def newest_run():
    runs = [os.path.join(OUT_ROOT, d) for d in os.listdir(OUT_ROOT)] if os.path.isdir(OUT_ROOT) else []
    runs = [r for r in runs if os.path.exists(os.path.join(r, "web", "meta.json"))]
    return max(runs, key=lambda r: os.path.getmtime(os.path.join(r, "web", "meta.json"))) if runs else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hands-free", type=int, default=0, metavar="PICTURES")
    ap.add_argument("--save-after", type=float, default=0, metavar="SECONDS")
    ap.add_argument("--wait-min", type=float, default=30, help="how long to wait for the headset to be worn")
    ap.add_argument("--scan-min", type=float, default=20, help="how long to wait for the scan to be saved")
    ap.add_argument("--no-install", action="store_true")
    ap.add_argument("--no-view", action="store_true")
    ap.add_argument("--detach-view", action="store_true", help="leave the viewer running by itself and return")
    ap.add_argument("--steps", type=int, default=8000)
    ap.add_argument("--print-mm", type=float, default=120.0)
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--live", action="store_true", help="send a rough view of what is being scanned to 6ense.com while it is scanned (public)")
    ap.add_argument("--live-relay", help="where --live sends (default: the site's relay; 'off' records the rough view here only)")
    ap.add_argument("--publish", action="store_true", help="put the finished splat on 6ense.com/scans/ (public)")
    ap.add_argument("--title", help="for --publish: the scan's title on the site")
    ap.add_argument("--note", help="for --publish: the paragraph shown with it")
    a = ap.parse_args()

    if headset_state() == "none":
        log("no headset on adb: plug it in by USB and allow debugging inside the headset"); return 1
    if not a.no_install:
        if not os.path.exists(APK):
            log(f"no build at {APK}: run questbag\\printsee_build.ps1"); return 1
        code, out = adb("install", "-r", APK, timeout=300)
        if "Success" not in out:
            log("install failed:", out.strip()[-300:]); return 1
        log("the current build is on the headset")
    for p in ("android.permission.CAMERA", "horizonos.permission.HEADSET_CAMERA", "com.oculus.permission.USE_SCENE"):
        adb("shell", "pm", "grant", PKG, p)
    # the headset has to be on someone's head, past its privacy screen
    t0, told = time.time(), 0.0
    while True:
        st = headset_state()
        if st == "awake":
            break
        if time.time() - t0 > a.wait_min * 60:
            log(f"gave up after {a.wait_min:.0f} min: the headset is {st}"); return 2
        if time.time() - told > 30:
            told = time.time()
            log({"asleep": "waiting: put the headset on (or press its power button)",
                 "privacy": "waiting: the headset shows its camera privacy screen: press its power button once",
                 "none": "waiting: the headset dropped off USB"}[st])
        time.sleep(3)
    log("the headset is awake: starting Print What I See" + (f" (hands-free, {a.hands_free} pictures)" if a.hands_free else ""))
    adb("shell", "am", "force-stop", PKG)
    adb("logcat", "-c")
    start = ["shell", "am", "start", "-n", ACT]
    if a.hands_free:
        start += ["--ei", "printsee_scan", str(a.hands_free)]
    else:
        start += ["--ei", "printsee_record", "1"]              # pictures are kept from the start, whatever is looked at
    live, live_stop = (None, None)
    if a.live:
        live, live_stop = start_live(a.python, a.live_relay)
        atexit.register(stop_live, live, live_stop)            # also when this script is stopped with Ctrl-C
        if live:
            start += ["--ei", "printsee_splat", str(LIVE_PORT)]   # the app's splat sensor, beside the scan
            log("live: a rough view of what the headset sees is going to 6ense.com (Live now) while you scan"
                if a.live_relay != "off" else "live: the rough view is being recorded here only")
    adb(*start)
    if a.hands_free:
        log("look at the object from about half a metre, then walk slowly all the way round it, keeping it in the middle")
    else:
        log("to print something: pull the trigger on that ONE thing, walk slowly all the way round it until the dots are green, press B")
        log("to just capture the room: look and walk around, press B (or take the headset off)")

    # follow the app's log
    proc = subprocess.Popen(["adb", "logcat", "-v", "brief", "-s", "Unity:I"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=ENV,
                            encoding="utf-8", errors="replace")
    found = {"stamp": None, "pictures": 0, "started": None, "fail": None}

    def reader():
        last = 0.0
        for line in proc.stdout:
            if "[PrintSee]" not in line:
                continue
            msg = line.split("[PrintSee]", 1)[1].strip()
            m = re.search(r"SCAN SAVED (\S+): (\d+) pictures", msg)
            if m:
                found["stamp"], found["pictures"] = m.group(1), int(m.group(2))
                log("headset:", msg)
                return
            if msg.startswith("SCAN start"):
                found["started"] = time.time()
            m = re.match(r"scan: (\d+) pictures", msg)
            if m:
                found["pictures"] = int(m.group(1))
            if "AUTOSCAN FAIL" in msg or "cannot share its cameras" in msg or "not supported" in msg:
                found["fail"] = msg
            if time.time() - last > 4 or "SCAN" in msg or "camera ready" in msg:
                last = time.time()
                log("headset:", msg)

    th = threading.Thread(target=reader, daemon=True)
    th.start()
    t0, asked, checked, off = time.time(), False, time.time(), 0
    while th.is_alive():
        th.join(1.0)
        if found["fail"]:
            log("the app reported:", found["fail"]); break
        # the headset taken off without a save: its pictures are on its disk all the same
        if time.time() - checked > 6:
            checked = time.time()
            off = off + 1 if headset_state() != "awake" else 0
            if off >= 4 and found["pictures"] >= 20:
                log("the headset was taken off before a save"); break
        if a.save_after and found["started"] and not asked and time.time() - found["started"] > a.save_after:
            asked = True
            adb("shell", "touch", f"/sdcard/Android/data/{PKG}/files/save_now")
            log("asked the headset to save")
        if time.time() - t0 > a.scan_min * 60:
            log(f"no save after {a.scan_min:.0f} min"); break
    proc.kill()
    stop_live(live, live_stop)
    if not found["stamp"]:
        if found["pictures"] < 20:
            log(f"no scan to work on ({found['pictures']} pictures)"); return 3
        log(f"the scan was not saved, but its {found['pictures']} pictures are on the headset: using them")
    # the PC's part
    cmd = [a.python, "-I", os.path.join(HERE, "quest_scan.py"), "--steps", str(a.steps), "--print-mm", str(a.print_mm)]
    if found["stamp"]:
        cmd += ["--object", found["stamp"]]
    log("making the splat and the solid (a few minutes) ...")
    r = subprocess.run(cmd)
    if r.returncode != 0:
        log("quest_scan.py failed"); return 4
    if a.publish:
        run = newest_run()
        if not run:
            log("nothing to publish: no finished run")
        else:
            pub = [a.python, "-I", os.path.join(HERE, "scan_publish.py"), run]
            pub += (["--title", a.title] if a.title else []) + (["--note", a.note] if a.note else [])
            log(f"publishing {os.path.basename(run)} to 6ense.com/scans/ ...")
            if subprocess.run(pub).returncode != 0:
                log("publishing failed; the result is on this computer all the same")
    if a.detach_view:
        # the viewer keeps running by itself after this script ends (its log: Downloads\quest_scans\viewer.log)
        logf = open(os.path.join(os.path.expanduser("~"), "Downloads", "quest_scans", "viewer.log"), "w")
        subprocess.Popen([a.python, "-I", os.path.join(HERE, "scan_view.py"), "--quest"], stdout=logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                         creationflags=0x00000008 | 0x00000200)
        log("the viewer is running: in the headset press Enter AR in the browser page")
    elif not a.no_view:
        log("showing it: in the headset press Enter AR in the browser page; Ctrl-C here to stop")
        subprocess.run([a.python, "-I", os.path.join(HERE, "scan_view.py"), "--quest"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
