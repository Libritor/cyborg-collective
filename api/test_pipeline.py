#!/usr/bin/env python3
"""End-to-end proof for ``api/``: fake relay -> hub -> capture -> SSE + OSC.

There is no sharer on the real relay most of the time, so the test hosts a
local WebSocket that speaks the relay's protocol and points the service at it
with ``--relay ws://127.0.0.1:<port>/live``. That exercises the real live path
(reconnect, state merge, capture writing, OSC emission) and leaves real capture
files behind for the replay routes.

    python3 api/test_pipeline.py     # prints "PASS <n> assertions", exit 0
"""

from __future__ import annotations

import asyncio
import http.client
import json
import math
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from capture import CaptureWriter, list_captures
from catalogue import CATALOGUE_ROOT, OPTIC_SITES, Catalogue
from relay import STATE_TYPES, RelayHub, valid_of
from server import build_patch

API_DIR = Path(__file__).resolve().parent
SERVER = API_DIR / "server.py"
PROBE = API_DIR / "probe_live.py"

# ports are chosen at run time so a demo (simulate.py + server.py) may hold the
# usual ones without colliding: see free_port() in main()
HTTP_PORT = 8789
WS_PORT = 8790
OSC_PORT = 5001
CHANNELS = ["TP9", "AF7", "AF8", "TP10"]
BANDS = ["delta", "theta", "alpha", "beta", "gamma"]
PSEUDONYM = "tester"

_assertions = 0
_failures = []


def check(condition, label):
    global _assertions
    _assertions += 1
    if condition:
        print(f"  ok   {label}")
    else:
        _failures.append(label)
        print(f"  FAIL {label}")


# ------------------------------------------------------------------- test input
def eeg_frame(seq, phase, samples=256):
    rows = []
    for channel in range(4):
        rows.append([round(40 * math.sin((i + phase) / 12.0 + channel) + 5 * channel, 4)
                     for i in range(samples)])
    return {"t": "eeg", "pseudonym": PSEUDONYM, "ts": 1793414821927 + seq, "seq": seq,
            "fs": 256, "x": rows}


def bands_frame(scale):
    rel = {}
    abs_ = {}
    for index, band in enumerate(BANDS):
        rel[band] = [round(scale * (0.1 * (index + 1) + 0.05 * ch), 4) for ch in range(3)] + [None]
        abs_[band] = [round(scale * (1.5 + index + ch), 4) for ch in range(4)]
    return {"t": "bands", "pseudonym": PSEUDONYM, "rel": rel, "abs": abs_}


def quality_frame():
    return {"t": "quality", "pseudonym": PSEUDONYM,
            "hsi": {"TP9": 1, "AF7": 2, "AF8": None, "TP10": 1}}


def arousal_frame():
    return {"t": "arousal", "pseudonym": PSEUDONYM, "index": 0.61, "label": "alert",
            "confidence": 0.8, "quality": {"score": 0.72}, "reason": ""}


def hr_frame():
    return {"t": "hr", "pseudonym": PSEUDONYM, "ok": True, "bpm": 68.0,
            "rmssd_ms": 41.0, "sdnn_ms": 55.0, "beats": 11, "source": "polar"}


def imu_frame():
    return {"t": "imu", "pseudonym": PSEUDONYM,
            "gyro": [0.5, -1.25, 2.0], "accel": [0.0, 0.02, 1.01]}


def optics_frame():
    return {"t": "optics", "pseudonym": PSEUDONYM, "ts": 1793414821927,
            "sites": {name: {"ratio": 1.05, "r730": 6.1, "r850": 7.6}
                      for name in OPTIC_SITES},
            "ppg": {"850nm_LEFT_OUTER": 68.0}}


def device_frame():
    """Aux electrodes ride in device frames, one frame per device."""
    return {"t": "device", "pseudonym": PSEUDONYM, "model": "muse", "battery": 88,
            "aux": [{"channel": "AUX_L", "hsi": 1, "std_uv": 12.5},
                    {"channel": "AUX_R", "hsi": 3, "std_uv": 30.1}]}


FIRST_FRAMES = [
    {"t": "snapshot", "people": [{"pseudonym": PSEUDONYM, "name": "Tester",
                                  "tier": "raw", "since": int(time.time() * 1000),
                                  "device": {"model": "muse"}, "last": {}}]},
    device_frame(),
    eeg_frame(0, 0),
    bands_frame(1.0),
    quality_frame(),
    arousal_frame(),
    hr_frame(),
    imu_frame(),
    optics_frame(),
]
# the steady state: eeg every tick (51 samples / 0.2 s = a 255 Hz stream), one
# other frame per tick, so a features stream sees every block several times a
# second and the rate estimator has a coherent signal to measure
REPEAT_FRAMES = [bands_frame(1.2), quality_frame(), arousal_frame(), hr_frame(),
                 imu_frame(), optics_frame()]
REPEAT_SAMPLES = 51
REPEAT_PERIOD = 0.2


# ------------------------------------------------------------------- fake relay
def start_fake_relay(port, stop, pause):
    from aiohttp import web

    async def ws_handler(request):
        response = web.WebSocketResponse()
        await response.prepare(request)
        try:
            for frame in FIRST_FRAMES:
                await response.send_str(json.dumps(frame))
                await asyncio.sleep(0.02)
            tick = 0
            while not stop.is_set():
                if pause.is_set():
                    # a sharer who goes silent: nothing arrives, nothing closes
                    await asyncio.sleep(0.05)
                    continue
                await response.send_str(
                    json.dumps(eeg_frame(1000 + tick, tick % 12, REPEAT_SAMPLES)))
                await response.send_str(json.dumps(REPEAT_FRAMES[tick % len(REPEAT_FRAMES)]))
                tick += 1
                await asyncio.sleep(REPEAT_PERIOD)
        finally:
            await response.close()
        return response

    async def run():
        app = web.Application()
        app.router.add_get("/live", ws_handler)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", port)
        await site.start()
        while not stop.is_set():
            await asyncio.sleep(0.05)
        await runner.cleanup()

    threading.Thread(target=lambda: asyncio.run(run()), daemon=True).start()


def wait_tcp(port, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.05)
    return False


# ------------------------------------------------------------------- OSC decode
def read_osc_string(buffer, offset):
    end = buffer.index(b"\0", offset)
    text = buffer[offset:end].decode("latin-1")
    offset = end + 1
    while offset % 4:
        offset += 1
    return text, offset


def decode_osc(datagram):
    address, offset = read_osc_string(datagram, 0)
    tags, offset = read_osc_string(datagram, offset)
    count = max(0, len(tags) - 1)
    values = struct.unpack(">" + "f" * count, datagram[offset:offset + 4 * count]) if count else ()
    return address, tags, list(values)


def start_udp_listener(port, box, stop):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    sock.settimeout(0.2)

    def run():
        while not stop.is_set():
            try:
                data, _ = sock.recvfrom(65535)
            except (socket.timeout, OSError):
                continue
            box.append(data)
        sock.close()

    threading.Thread(target=run, daemon=True).start()


# --------------------------------------------------------------------- HTTP/SSE
def get_json(port, path, timeout=10.0, method="GET"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    conn.request(method, path)
    response = conn.getresponse()
    body = response.read()
    status = response.status
    conn.close()
    try:
        return status, json.loads(body)
    except ValueError:
        return status, body.decode("utf-8", "replace")


def read_sse(port, path, want=None, timeout=20.0):
    """Collect SSE ``data:`` events; stop at ``want`` events, EOF, or timeout."""
    events = []
    buffer = b""
    deadline = time.time() + timeout
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    conn.request("GET", path, headers={"Accept": "text/event-stream"})
    response = conn.getresponse()
    while time.time() < deadline:
        if want is not None and len(events) >= want:
            break
        try:
            chunk = response.read1(65536)
        except (socket.timeout, TimeoutError, http.client.IncompleteRead):
            break
        except OSError:
            break
        if not chunk:
            break
        buffer += chunk
        while b"\n\n" in buffer:
            block, buffer = buffer.split(b"\n\n", 1)
            for line in block.split(b"\n"):
                if line.startswith(b"data: "):
                    events.append(json.loads(line[6:]))
    conn.close()
    return events


# ---------------------------------------------------------------------- helpers
def wait_for(fn, timeout=20.0, interval=0.1):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    global HTTP_PORT, WS_PORT, OSC_PORT
    HTTP_PORT, WS_PORT, OSC_PORT = free_port(), free_port(), free_port()
    workdir = Path(tempfile.mkdtemp(prefix="cc-api-test-"))
    captures = workdir / "captures"
    captures.mkdir()
    stop = threading.Event()
    pause = threading.Event()
    datagrams = []
    process = None

    print(f"workdir {workdir}")
    print(f"ports http={HTTP_PORT} ws={WS_PORT} osc={OSC_PORT}")
    start_fake_relay(WS_PORT, stop, pause)
    if not wait_tcp(WS_PORT):
        print("FAIL fake relay never accepted a connection")
        stop.set()
        return 1
    start_udp_listener(OSC_PORT, datagrams, stop)

    log = open(workdir / "server.log", "wb")
    command = [sys.executable, str(SERVER),
               "--port", str(HTTP_PORT),
               "--relay", f"ws://127.0.0.1:{WS_PORT}/live",
               "--captures", str(captures),
               "--osc", f"127.0.0.1:{OSC_PORT}",
               "--sse-keepalive", "1",
               "--stale-after", "0.5",
               "--log-level", "warning"]
    try:
        process = subprocess.Popen(command, cwd=str(API_DIR.parent),
                                   stdout=log, stderr=subprocess.STDOUT)

        print("health")
        health = wait_for(lambda: get_json(HTTP_PORT, "/api/v1/health")[1]
                          if _up(HTTP_PORT) else None)
        check(bool(health), "health endpoint answers")
        if not health:
            return _report(workdir)
        check(health.get("ok") is True, "health ok")
        check(health["catalogue"]["sessions"] == 1055, "catalogue sessions 1055")
        check(health["catalogue"]["devices"] == 1242, "catalogue devices 1242")
        check(health["osc"]["enabled"] is True
              and health["osc"]["target"] == f"127.0.0.1:{OSC_PORT}", "osc enabled at test port")

        print("relay connection")
        connected = wait_for(lambda: get_json(HTTP_PORT, "/api/v1/health")[1]
                             ["relay"]["connected"] or None, timeout=20.0)
        check(bool(connected), "relay connects to the fake relay")

        print("capture")

        def sharer_capture():
            # the hub also records snapshot/aggregate frames under "_relay";
            # the sharer's own file is the one carrying that pseudonym
            body = get_json(HTTP_PORT, "/api/v1/captures")[1]
            for entry in body.get("captures") or []:
                if entry["sharers"] == [PSEUDONYM] and entry["frames"] >= 8:
                    return entry
            return None

        capture = wait_for(sharer_capture, timeout=25.0)
        check(bool(capture), "capture recorded for the sharer")
        if not capture:
            return _report(workdir)
        capture_id = capture["id"]
        check(capture["sharers"] == [PSEUDONYM], "capture records the sharer pseudonym")
        check(capture["eeg_frames"] >= 1 and capture["frames"] >= 8,
              f"capture holds every frame type ({capture['frames']} frames,"
              f" {capture['eeg_frames']} eeg)")

        print("replay eeg")
        events = read_sse(HTTP_PORT, f"/api/v1/captures/{capture_id}/eeg?speed=50")
        check(bool(events) and events[0].get("t") == "hello", "replay starts with a hello event")
        eeg_events = [e for e in events if e.get("t") == "eeg"]
        check(len(eeg_events) >= 2, f"replay yields the captured eeg frames ({len(eeg_events)})")
        if eeg_events:
            first = eeg_events[0]
            check(len(first["x"]) == 4, "replay eeg carries four channels")
            check(len(first["x"][0]) == 256, "replay eeg row is 256 samples")
            check(first["unit"] == "uV", "replay eeg unit is uV")
            check(first["channels"] == CHANNELS, "replay eeg channel names")
            check(first["fs"] == 256.0, "replay eeg reports fs 256")
            check(eeg_events[0]["seq"] == 0 and eeg_events[1]["seq"] == 1, "replay seq counts events")

        print("replay eeg filtered")
        filtered = [e for e in read_sse(
            HTTP_PORT, f"/api/v1/captures/{capture_id}/eeg?speed=50&channels=AF7&decimate=4")
            if e.get("t") == "eeg"]
        check(len(filtered) >= 2, f"filtered replay yields eeg events ({len(filtered)})")
        if filtered:
            check(len(filtered[0]["x"]) == 1, "channels=AF7 keeps one row")
            check(len(filtered[0]["x"][0]) == 64, "decimate=4 keeps 64 samples")
            check(filtered[0]["channels"] == ["AF7"], "filtered channels echo AF7")
            check(filtered[0]["fs"] == 64.0, "filtered replay reports fs 64")

        print("replay features")
        features = [e for e in read_sse(
            HTTP_PORT, f"/api/v1/captures/{capture_id}/features?speed=50")
            if e.get("t") == "features"]
        check(bool(features), "features replay emits at least one event")
        if features:
            last = features[-1]
            delta = last["bands"]["rel"]["delta"]
            check(len(delta) == 4, "features bands.rel.delta has four entries")
            check(sum(1 for v in delta if v is None) == 1, "features keep the null channel")
            check(last["contact"]["AF8"] is None, "features contact keeps null for no-contact")
            check(last["contact"]["AF7"] == 2, "features contact carries hsi code 2")
            check(last["arousal"]["index"] == 0.61, "features arousal index")
            check(last["arousal"]["quality"] == 0.72, "features arousal quality score")
            check(last["hr"]["ok"] is True and last["hr"]["bpm"] == 68.0, "features hr bpm")
            check(last["eeg_hz"] is not None, "features report an eeg rate")
            check(last["stale_s"] is None, "a replay reports no staleness")

        print("live state")
        sharers = get_json(HTTP_PORT, "/api/v1/live/sharers")[1]
        check(sharers.get("relay") == "connected", "live/sharers says connected")
        found = [s for s in sharers.get("sharers", []) if s["pseudonym"] == PSEUDONYM]
        check(len(found) == 1, "live/sharers lists the fake sharer")
        if found:
            check(found[0]["hsi"]["TP9"] == 1 and found[0]["hsi"]["AF7"] == 2, "live hsi codes")
            check(len(found[0]["bands"]["rel"]["delta"]) == 4, "live bands rel delta")
            check(found[0]["hr"]["bpm"] == 68.0, "live hr bpm")
            check(isinstance(found[0].get("stale_s"), (int, float)) and found[0]["stale_s"] < 60,
                  "sharers expose stale_s (seconds since their last frame)")
            check(found[0]["valid"] == {"bands": True, "arousal": True, "hr": True},
                  "live sharers gate all three state blocks as valid")
            check(found[0]["imu"]["gyro"] == [0.5, -1.25, 2.0],
                  "live sharers carry the gyro axes")
            check(found[0]["aux"]["AUX_L"] == {"hsi": 1, "std_uv": 12.5},
                  "live sharers carry the left aux electrode")
            check(found[0]["aux"]["AUX_R"]["hsi"] == 3,
                  "live sharers carry the right aux electrode")
            check(found[0]["optics"]["sites"]["left_outer"]["ratio"] == 1.05,
                  "live sharers carry the fNIRS sites")
            check(found[0]["optics"]["ppg"] == {"850nm_LEFT_OUTER": 68.0},
                  "live sharers carry the ppg channels")

        print("live features stream")
        live = read_sse(HTTP_PORT, f"/api/v1/live/{PSEUDONYM}/features", want=12, timeout=20.0)
        check(bool(live) and live[0].get("t") == "hello", "live features hello first")
        live_features = [e for e in live if e.get("t") == "features"]
        check(bool(live_features), "live features streams an event")
        if live_features:
            latest = live_features[-1]
            check(len(latest["bands"]["rel"]["delta"]) == 4,
                  "live features bands.rel.delta has four entries")
            check(latest["valid"] == {"bands": True, "arousal": True, "hr": True},
                  "live features gate all three state blocks as valid")
            check(len(latest["imu"]["gyro"]) == 3, "live features imu.gyro has three axes")
            check(len(latest["imu"]["accel"]) == 3, "live features imu.accel has three axes")
            check(isinstance(latest["optics"]["sites"]["left_outer"]["ratio"], float),
                  "live features carry the fNIRS ratio")
            check(isinstance(latest["stale_s"], (int, float)) and latest["stale_s"] < 60,
                  "live features carry stale_s")

        print("catalogue sensing")
        row = (get_json(HTTP_PORT, "/api/v1/sessions?limit=1")[1].get("rows") or [{}])[0]
        for key in ("artifact_free_frac", "hsi_frac", "gyro_rms", "pulse", "battery"):
            check(key in row, f"session rows carry {key}")
        check(isinstance(row.get("hsi_frac"), dict) and row["hsi_frac"].get("TP9"),
              "hsi_frac keeps the per-channel code fractions")
        status, patch = get_json(
            HTTP_PORT, "/api/v1/sessions/drive__d0190f77e762/mindP482_2025-06-16--18-13-53/patch")
        check(status == 200 and patch.get("motion_rms") == 20.9148472521439,
              "patch reports the recorded gyro rms")
        check(isinstance(patch.get("pulse"), dict) and "bpm" in patch["pulse"],
              "patch carries a pulse object")

        print("probe_live")
        probe = subprocess.run(
            [sys.executable, str(PROBE), "--api", f"http://127.0.0.1:{HTTP_PORT}",
             "--seconds", "3"],
            capture_output=True, text=True, timeout=60)
        check(probe.returncode == 0, f"probe_live exits 0 ({probe.returncode})")
        check("eeg events" in probe.stdout, "probe_live reports eeg events")
        check("channel layout" in probe.stdout, "probe_live confirms the channel layout")
        if probe.returncode != 0:
            print(probe.stdout + probe.stderr)

        print("osc")
        osc_seen = wait_for(lambda: dict(_osc_map(datagrams))
                            if len(_osc_map(datagrams)) >= 18 else None, timeout=20.0)
        check(bool(osc_seen), "osc datagrams arrive")
        if osc_seen:
            expected = {
                "/eeg/bands": 5, "/eeg/bands/abs": 5, "/eeg/contact": 4,
                "/eeg/alpha": 1, "/eeg/arousal": 1, "/eeg/hr": 1, "/eeg/rms": 4,
                "/eeg/bands/valid": 1, "/eeg/arousal/valid": 1, "/eeg/hr/valid": 1,
                "/eeg/aux": 2, "/imu/gyro": 3, "/imu/accel": 3, "/imu/motion": 1,
                "/optics/ratio": 4, "/optics/r730": 4, "/optics/r850": 4,
                "/optics/valid": 1,
            }
            check(len(osc_seen) == 18, f"osc sends eighteen addresses ({len(osc_seen)})")
            check({address: len(values) for address, values in osc_seen.items()} == expected,
                  "every osc address carries the documented argument count")
            contact = osc_seen["/eeg/contact"]
            check(contact[0] == 1.0 and contact[1] == 0.5 and contact[2] == 0.0,
                  "/eeg/contact maps hsi 1/2/none to 1.0/0.5/0.0")
            check(abs(osc_seen["/eeg/arousal"][0] - 0.61) < 1e-6, "/eeg/arousal carries the index")
            check(abs(osc_seen["/eeg/hr"][0] - 68.0) < 1e-6, "/eeg/hr carries the bpm")
            check(osc_seen["/eeg/bands/valid"] in ([0.0], [1.0]),
                  "/eeg/bands/valid is a 0.0/1.0 gate")
            check(osc_seen["/eeg/bands/valid"] == [1.0],
                  "/eeg/bands/valid opens when a channel is in contact")
            check(osc_seen["/eeg/aux"] == [1.0, 0.25],
                  "/eeg/aux maps the aux electrodes through the same contact table")
            check(all(abs(v - w) < 1e-3 for v, w in zip(osc_seen["/imu/accel"], [0.0, 0.02, 1.01])),
                  "/imu/accel carries three axes")
            check(abs(osc_seen["/imu/motion"][0] - 0.0101) < 1e-3,
                  "/imu/motion is the deviation of |accel| from 1 g")
            check(all(abs(v - 1.05) < 1e-3 for v in osc_seen["/optics/ratio"]),
                  "/optics/ratio carries one value per fNIRS site")
            check(osc_seen["/optics/valid"] == [1.0], "/optics/valid opens when a site reports")

        print("stale heartbeat")
        _check_stale(HTTP_PORT, pause)
        print("probe on a silent sharer")
        _check_probe_silent(HTTP_PORT, pause)

        print("error paths")
        status, body = get_json(HTTP_PORT, "/api/v1/captures/nope/eeg")
        check(status == 404 and body.get("error") == "unknown capture",
              "unknown capture is a 404 JSON error")
        status, body = get_json(HTTP_PORT, f"/api/v1/captures/{capture_id}/eeg?channels=XX")
        check(status == 400 and "error" in body, "bad channel is a 400 JSON error")
        status, body = get_json(HTTP_PORT, "/api/v1/sessions/nope/nope")
        check(status == 404 and body.get("error") == "unknown stamp", "unknown stamp is a 404")
        status, body = get_json(HTTP_PORT, "/nope")
        check(status == 404 and body.get("error") == "not found",
              "an unknown path is a 404 JSON error, not 405")
        status, body = get_json(HTTP_PORT, "/api/v1/sessions", method="POST")
        check(status == 405 and isinstance(body, dict) and "error" in body,
              "a wrong method is a 405 JSON error")
        status, _ = get_json(HTTP_PORT, "/api/v1/sessions", method="OPTIONS")
        check(status == 204, "OPTIONS on a GET route is 204")
        status, _ = get_json(HTTP_PORT, "/nope", method="OPTIONS")
        check(status == 204, "OPTIONS on an unknown path is 204")
        status, body = get_json(HTTP_PORT, "/api/v1/sessions?since=2025-13-99")
        check(status == 400, "an impossible date is rejected")
        status, body = get_json(HTTP_PORT, f"/api/v1/captures/{capture_id}/eeg", method="HEAD")
        check(status == 405, "HEAD on a stream route is refused, not replayed")
        status, body = get_json(HTTP_PORT, f"/api/v1/live/{PSEUDONYM}/features", method="HEAD")
        check(status == 405, "HEAD on a live stream is refused")

        print("regressions")
        _check_capture_rotation(workdir)
        _check_capture_cache(workdir)
        _check_capture_limits(workdir)
        _check_subscriber_filter()
        _check_eeg_rate()
        _check_ghost_pruning()
        _check_validity()
        _check_catalogue_sensing()
        return _report(workdir)
    finally:
        stop.set()
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        log.close()


def _check_capture_rotation(workdir):
    """Interleaved sharers must land in one file each, not one file per frame.

    Regression: rotating whenever the pseudonym changed shredded a two-sharer
    capture into hundreds of 5-frame files.
    """
    directory = workdir / "rotation"
    writer = CaptureWriter(directory)
    frame = {"t": "eeg", "pseudonym": "a", "x": [[0.0] * 8] * 4}
    for index in range(200):
        writer.write("a" if index % 2 == 0 else "b", frame)
    writer.close()
    captures = list_captures(directory)
    check(len(captures) == 2, f"interleaved sharers produce one file each ({len(captures)})")
    check(all(c["frames"] == 100 for c in captures),
          "each interleaved file holds only its own frames")

    limited = workdir / "rotation-limit"
    small = CaptureWriter(limited, rotate_bytes=2048)
    for _ in range(60):
        small.write("a", frame)
    small.close()
    files = list_captures(limited)
    check(len(files) > 1, f"a pseudonym still rotates past rotate_bytes ({len(files)} files)")
    check(all(c["sharers"] == ["a"] for c in files), "rotated files stay with their pseudonym")


def _check_capture_cache(workdir):
    """Frame counts are exact, counted incrementally, and survive truncation."""
    directory = workdir / "cache"
    writer = CaptureWriter(directory)
    frame = {"t": "eeg", "pseudonym": "a", "x": [[0.0] * 4] * 4}
    for _ in range(5):
        writer.write("a", frame)
    writer.close()
    check(list_captures(directory)[0]["frames"] == 5, "capture summary counts the frames")
    path = next(directory.glob("*.jsonl"))
    with path.open("a", encoding="utf-8") as fh:
        for _ in range(3):
            fh.write(json.dumps({"recv_ts": time.time(), "frame": frame}) + "\n")
    check(list_captures(directory)[0]["frames"] == 8, "appended frames are counted")
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"recv_ts": 1, "frame": {"t": "ee')      # half-written tail line
    check(list_captures(directory)[0]["frames"] == 8, "a half-written line is not counted")
    with path.open("a", encoding="utf-8") as fh:
        fh.write('g", "pseudonym": "a"}}\n')
    check(list_captures(directory)[0]["frames"] == 9, "the completed line is counted")
    path.write_text(json.dumps({"recv_ts": time.time(), "frame": frame}) + "\n",
                    encoding="utf-8")
    check(list_captures(directory)[0]["frames"] == 1, "a truncated and rewritten file is recounted")


def _check_capture_limits(workdir):
    """Bounded handles, and no non-finite frame may poison the archive."""
    frame = {"t": "eeg", "pseudonym": "a", "x": [[0.0] * 4] * 4}
    many = CaptureWriter(workdir / "handles", max_open=8)
    for index in range(40):
        many.write(f"pseudonym-{index}", frame)
    check(len(many.paths()) == 8, f"open capture handles are capped ({len(many.paths())} of 40)")
    many.close()
    check(len(list((workdir / "handles").glob("*.jsonl"))) == 40,
          "closing a handle never loses the capture file")

    # evicting a handle must resume the same file, never start a new one
    shred = CaptureWriter(workdir / "shred", max_open=2)
    for _ in range(10):
        for index in range(4):
            shred.write(f"s{index}", frame)
    shred.close()
    split = list_captures(workdir / "shred")
    check(len(split) == 4, f"an evicted handle resumes its file ({len(split)} files for 4 sharers)")
    check(all(entry["frames"] == 10 for entry in split),
          "each resumed file keeps every frame of its sharer")

    poisoned = CaptureWriter(workdir / "nan")
    poisoned.write("a", frame)
    poisoned.write("a", {"t": "eeg", "pseudonym": "a", "ts": 1e999, "x": [[float("inf")]]})
    poisoned.close()
    lines = next((workdir / "nan").glob("*.jsonl")).read_text().splitlines()
    parsed = all(json.loads(line) for line in lines)
    check(poisoned.rejected == 1 and len(lines) == 1 and parsed,
          "a frame with non-finite numbers is rejected, archive stays valid JSON")


def _check_subscriber_filter():
    """A features stream must not be flooded (and lose state) by raw eeg frames."""
    hub = RelayHub("ws://unused.invalid/live")
    hub.handle_message({"t": "snapshot", "people": [{"pseudonym": "a", "tier": "raw"}]})
    features = hub.subscribe("a", STATE_TYPES)
    eeg = hub.subscribe("a", ("eeg",))
    hub.handle_message({"t": "eeg", "pseudonym": "a", "x": [[0.0] * 8] * 4})
    hub.handle_message({"t": "bands", "pseudonym": "a", "rel": {}, "abs": {}})
    check(features.qsize() == 1, "a features subscriber receives only state frames")
    check(eeg.qsize() == 1, "an eeg subscriber receives only eeg frames")
    hub.unsubscribe("a", features)
    hub.unsubscribe("a", eeg)
    check(hub._subs == {}, "unsubscribing removes the queues")

    # a filtered subscriber must still learn that the sharer left
    hub.handle_message({"t": "snapshot", "people": [{"pseudonym": "a", "tier": "raw"}]})
    watching = hub.subscribe("a", ("eeg", "leave"))
    hub.handle_message({"t": "leave", "pseudonym": "a"})
    kinds = []
    while not watching.empty():
        kinds.append(watching.get_nowait()["t"])
    check(kinds == ["leave"], "a stream subscriber receives the leave frame")
    check(not hub.has("a"), "leave empties the sharer state")


def _check_ghost_pruning():
    """A snapshot is the authoritative roster: sharers who left must disappear."""
    hub = RelayHub("ws://unused.invalid/live")
    hub.handle_message({"t": "snapshot", "people": [
        {"pseudonym": "a", "tier": "raw", "since": 1},
        {"pseudonym": "b", "tier": "raw", "since": 1}]})
    check([s["pseudonym"] for s in hub.sharers()] == ["a", "b"], "snapshot seeds the roster")
    hub.handle_message({"t": "snapshot", "people": [{"pseudonym": "a", "tier": "raw", "since": 1}]})
    check([s["pseudonym"] for s in hub.sharers()] == ["a"],
          "a smaller snapshot drops the sharer who left")
    hub.handle_message({"t": "snapshot", "people": []})
    check(hub.sharers() == [], "an empty snapshot clears the roster")
    hub.handle_message({"t": "bands", "pseudonym": "c", "rel": {}, "abs": {}})
    check([s["pseudonym"] for s in hub.sharers()] == ["c"],
          "a later frame re-creates a sharer")


def _check_eeg_rate():
    """eeg_hz is samples per second per channel, not summed over channels.

    Regression: summing all four channel rows reported 4x the real rate
    (1024 Hz for a 256 Hz stream).
    """
    hub = RelayHub("ws://unused.invalid/live")
    eeg = {"t": "eeg", "pseudonym": "rate", "x": [[0.0] * 32 for _ in range(4)]}
    hub.handle_message(eeg)
    time.sleep(0.125)
    hub.handle_message(dict(eeg))
    rate = hub.sharers()[0]["eeg_hz"]
    check(rate is not None and 200 <= rate <= 320,
          f"eeg_hz reports the per-channel rate ({round(rate or 0, 1)} for 32 samples / 0.125 s)")


def _check_stale(port, pause):
    """A silent sharer must be reported, not left looking alive forever.

    Nothing arrives to say a sharer died, so the streams need their own
    heartbeat: a keepalive period with no frames is a staleness measurement.
    """
    pause.set()
    try:
        events = read_sse(port, f"/api/v1/live/{PSEUDONYM}/features", timeout=3.5)
    finally:
        pause.clear()
    staleness = [e for e in events if e.get("t") == "stale"]
    check(bool(staleness), "a silent sharer emits a stale event")
    if staleness:
        check(staleness[0].get("pseudonym") == PSEUDONYM, "the stale event names the sharer")
        check(isinstance(staleness[0].get("stale_s"), (int, float))
              and staleness[0]["stale_s"] >= 0.5,
              "the stale event carries the measured silence")


def _check_probe_silent(port, pause):
    """A silent stream must not cut the probe short: the window is the window.

    Regression: ``http.client`` cannot be read again after a read timeout
    ("cannot read from timed out object"), so retrying after one ended a 30 s
    probe on a quiet sharer after 2 s -- reporting 0 events as if it had waited.
    """
    pause.set()
    try:
        started = time.time()
        probe = subprocess.run(
            [sys.executable, str(PROBE), "--api", f"http://127.0.0.1:{port}",
             "--seconds", "3"],
            capture_output=True, text=True, timeout=60)
        elapsed = time.time() - started
    finally:
        pause.clear()
    check(probe.returncode == 1, f"probe_live fails when no eeg arrives ({probe.returncode})")
    check("no eeg frames in 3" in probe.stdout, "probe_live says how long it waited")
    check(elapsed >= 2.9, f"probe_live reads the whole window in silence "
                          f"({elapsed:.1f}s of 3)")
    check("TP9 n/a" in probe.stdout, "probe_live reports no dropout figure when nothing arrived")


def _check_validity():
    """A zero and a gap must be distinguishable: validity is emit-only gating."""
    check(valid_of({}) == {"bands": False, "arousal": False, "hr": False},
          "valid_of gates every block for a sharer with no state")
    lost = {"quality": {"hsi": {"TP9": 4, "AF7": 4, "AF8": 4, "TP10": 4}},
            "bands": {"rel": {"delta": [0.1, 0.1, 0.1, 0.1]}}}
    check(valid_of(lost)["bands"] is False,
          "bands are gated when every channel reports hsi 4")
    empty = {"quality": {"hsi": {"TP9": 1, "AF7": None, "AF8": None, "TP10": None}},
             "bands": {"rel": {"delta": [None, None, None, None]}}}
    check(valid_of(empty)["bands"] is False,
          "bands are gated when every channel value is null")
    check(valid_of({"arousal": {"index": None, "label": "no_claim"}})["arousal"] is False,
          "arousal is gated with no index and no claim")
    check(valid_of({"arousal": {"index": 0.0, "label": "calm"}})["arousal"] is True,
          "an arousal of zero with a claim stays valid")
    check(valid_of({"hr": {"ok": False, "bpm": 68.0}})["hr"] is False,
          "hr is gated while the detector says it is not ok")


def _check_catalogue_sensing():
    """Sensing survives flattening, and /patch derives pulse and motion from it."""
    catalogue = Catalogue(CATALOGUE_ROOT)
    device = {"stamp": "s", "tag": "t", "usable": True,
              "pulse": {"channel": "850nm_LEFT_OUTER", "bpm_mean": 71.5,
                        "bpm_sd": 2.5, "windows": 4, "valid": 3},
              "battery": [88.0, 87.0], "gyro_rms": 12.5,
              "hsi": {"TP9": {"1": 1.0}, "AF7": {}},
              "artifact_free_frac": {"TP9": 0.9}}
    row = catalogue._flat_row({"stamp": "s", "devices": [device]})
    check(row["pulse"]["bpm_mean"] == 71.5 and row["pulse"]["valid"] == 3,
          "a session row keeps the pulse mean and its valid window count")
    check(row["battery"] == [88.0, 87.0], "a session row keeps the battery series")
    check(row["gyro_rms"] == 12.5, "a session row keeps the gyro rms")
    check(row["hsi_frac"] == {"TP9": {"1": 1.0}, "AF7": {}},
          "hsi_frac keeps a channel's code fractions and an empty mapping as {}")
    check("AF8" not in row["hsi_frac"],
          "hsi_frac omits channels the device does not report")
    check(row["artifact_free_frac"]["TP9"] == 0.9
          and row["artifact_free_frac"]["AF7"] is None,
          "artifact_free_frac is per channel, null where the device has none")
    patch = build_patch(dict(device, clean_epoch_frac={}))
    check(patch["pulse"] == {"bpm": 71.5, "valid": True},
          "patch derives pulse bpm and usability")
    check(patch["motion_rms"] == 12.5, "patch carries the motion rms")
    check(build_patch({"pulse": {"valid": 0}})["pulse"] == {"bpm": None, "valid": False},
          "a pulse with no valid windows is unusable")
    check(build_patch({})["pulse"] == {"bpm": None, "valid": False},
          "a device with no pulse reports an empty pulse, never null")


def _up(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def _osc_map(datagrams):
    """{address: last decoded float args} over the datagrams received so far."""
    out = {}
    for datagram in list(datagrams):
        try:
            address, _tags, values = decode_osc(datagram)
        except (ValueError, struct.error):
            continue
        out[address] = values
    return out


def _report(workdir):
    if _failures:
        print(f"\nFAIL {len(_failures)} of {_assertions} assertions")
        for label in _failures:
            print(f"  - {label}")
        print(f"server log: {workdir / 'server.log'}")
        return 1
    print(f"\nPASS {_assertions} assertions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
