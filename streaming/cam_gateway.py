"""A camera gateway for the Collective on this computer: one or more go2rtc
streams shown on 6ense.com under Live now, the picture fetched by each viewer's
browser straight from here, the relay carrying only the card.

    go2rtc (127.0.0.1:1984, never exposed)  <- the camera (RTSP/RTSPS)
       ^
    this proxy (127.0.0.1:PORT)  allow-list: the player socket for the named
       ^                          streams (/api/ws?src=NAME) and its HLS
       |                          fallback (/api/hls/...); /bags = []; else 404
    cloudflared quick tunnel  ->  https://<random>.trycloudflare.com
       |
    card -> relay /ingest at tier "camera": where the picture is served from,
            which cameras are on, how many watch; refreshed on change, a
            heartbeat every 15 s, "bye" on exit (the card disappears)

go2rtc's own API can add sources that run programs, which is why it stays on
localhost and only the player paths of the allowed streams pass the proxy.

    python cam_gateway.py --go2rtc bin/go2rtc.exe \
        --go2rtc-config go2rtc.yaml \
        --cloudflared bin/cloudflared.exe \
        --camera "h2c:Bambu Lab H2C:Bambu printer, live from the chamber camera:1920x1080"

The go2rtc config (outside the repo; it holds the camera's password) names the
streams, e.g. for a Bambu printer with LAN liveview / developer mode on:
    api: {listen: "127.0.0.1:1984"}
    rtsp: {listen: ""}
    webrtc: {listen: ""}
    streams:
      h2c: rtspx://bblp:<access code>@<printer ip>:322/streaming/live/1
"""
import argparse
import asyncio
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
import urllib.request

import websockets
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

GO2RTC = "127.0.0.1:1984"
RELAY = "wss://cyborg-collective-relay.onrender.com/ingest"
TUNNEL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

CAMERAS = []                 # [{"id", "model", "label", "w", "h"}]
ALLOWED = set()              # stream names a viewer may open
VIEWERS = {}                 # stream -> sockets open now
CHANGED = asyncio.Event()    # the card should be sent again
STARTED_MS = int(time.time() * 1000)
ONLINE = {"ok": True}        # the camera answered its last check (--probe)


def _response(status, body, ctype="text/plain; charset=utf-8", extra=None):
    reasons = {200: "OK", 403: "Forbidden", 404: "Not Found"}
    if isinstance(body, str):
        body = body.encode()
    h = Headers()
    h["Content-Type"] = ctype
    h["Content-Length"] = str(len(body))
    h["Access-Control-Allow-Origin"] = "*"
    h["Cache-Control"] = "no-store"
    h["Connection"] = "close"
    for k, v in (extra or {}).items():
        h[k] = v
    return Response(status, reasons.get(status, "OK"), h, body)


def _query(path):
    path, _, q = path.partition("?")
    return path, q


async def http_routes(connection, request):
    """Plain requests are answered here; only the player socket of an allowed
    stream goes on to the WebSocket handshake. Everything else is 404."""
    path, q = _query(request.path)
    if path == "/":
        return _response(200, "Collective camera gateway: the picture for 6ense.com. Nothing else is served here.\n")
    if path == "/bags":
        return _response(200, json.dumps({"bags": []}), "application/json")   # this gateway does not record
    if path == "/api/ws":
        m = re.fullmatch(r"src=([A-Za-z0-9_-]{1,32})", q or "")
        if not m or m.group(1) not in ALLOWED:
            return _response(403, "stream not offered\n")
        if "websocket" not in request.headers.get("Upgrade", "").lower():
            return _response(404, "")
        return None                                   # on to the WebSocket handshake
    if path.startswith("/api/hls/"):
        # the player's fallback where MSE is missing (older iPhones): go2rtc
        # hands out a playlist id over the player socket; playlist and segments
        # are fetched here by that id only
        name = path[len("/api/hls/"):]
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", name) or (q and not re.fullmatch(r"id=[A-Za-z0-9_-]{1,64}", q)):
            return _response(404, "")
        url = f"http://{GO2RTC}/api/hls/{name}" + (f"?{q}" if q else "")
        try:
            data, ctype = await asyncio.to_thread(_get, url)
        except Exception:
            return _response(404, "")
        return _response(200, data, ctype)
    return _response(404, "")


async def player(ws):
    """The player socket of an allowed stream, piped both ways to go2rtc."""
    _, q = _query(ws.request.path)
    src = q[len("src="):]
    VIEWERS[src] = VIEWERS.get(src, 0) + 1
    CHANGED.set()
    try:
        async with websockets.connect(f"ws://{GO2RTC}/api/ws?src={src}", max_size=None, compression=None,
                                      open_timeout=10, ping_interval=None) as up:
            async def down():
                async for m in up:
                    await ws.send(m)

            async def upward():
                async for m in ws:
                    await up.send(m)

            tasks = [asyncio.create_task(down()), asyncio.create_task(upward())]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in tasks:
                t.cancel()
    except (websockets.ConnectionClosed, OSError, asyncio.TimeoutError):
        pass
    finally:
        VIEWERS[src] = max(0, VIEWERS.get(src, 1) - 1)
        CHANGED.set()


def _get(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        return r.read(), r.headers.get("Content-Type", "application/octet-stream")


def card(base):
    return {"t": "camera", "ts": int(time.time() * 1000), "base": base, "owner": ARGS.owner,
            "cameras": [{"id": c["id"], "label": c["label"], "model": c["model"], "online": ONLINE["ok"],
                         "since": STARTED_MS, "viewers": VIEWERS.get(c["id"], 0), "note": ARGS.note,
                         "streams": {"hd": {"src": c["id"], "width": c["w"], "height": c["h"], "codec": "h264"}}}
                        for c in CAMERAS]}


async def announce(base, stop):
    """Keep the card on the relay until `stop` is set; reconnect with backoff."""
    session = secrets.token_hex(10)
    hello = {"t": "hello", "v": 1, "session": session, "pseudonym": ARGS.pseudonym, "tier": "camera",
             "device": CAMERAS[0]["model"] if CAMERAS else "camera", "app": "collective-cameras",
             "name": ARGS.owner}
    delay = 2
    while not stop.is_set():
        try:
            async with websockets.connect(ARGS.relay, open_timeout=20, ping_interval=20) as ws:
                await ws.send(json.dumps(hello))
                reply = json.loads(await asyncio.wait_for(ws.recv(), 20))
                if reply.get("t") != "ok":
                    raise RuntimeError(f"relay said {reply}")
                print(f"[gateway] on the relay as {reply.get('pseudonym')} (tier {reply.get('tier')}); "
                      f"card base {base}", flush=True)
                delay = 2
                await ws.send(json.dumps(card(base)))
                last = time.time()
                while not stop.is_set():
                    CHANGED.clear()
                    waits = [asyncio.create_task(CHANGED.wait()), asyncio.create_task(stop.wait())]
                    await asyncio.wait(waits, timeout=15, return_when=asyncio.FIRST_COMPLETED)
                    for w in waits:
                        w.cancel()
                    if stop.is_set():
                        break
                    if CHANGED.is_set() or time.time() - last > 60:
                        await ws.send(json.dumps(card(base)))
                        last = time.time()
                    else:
                        await ws.send(json.dumps({"t": "hb"}))
                await ws.send(json.dumps({"t": "bye", "reason": "gateway stopped"}))
                print("[gateway] bye sent; the card is off the page", flush=True)
                return
        except Exception as e:
            if stop.is_set():
                return
            print(f"[gateway] relay link lost ({e!r}); again in {delay} s", flush=True)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)


async def probe_loop(stop):
    """Every 30 s, is the camera's port answering? The card says on/off from
    it, so a printer that is switched off shows "camera off", not a dead player."""
    host, _, port = ARGS.probe.rpartition(":")
    while not stop.is_set():
        try:
            _, w = await asyncio.wait_for(asyncio.open_connection(host, int(port)), 5)
            w.close()
            ok = True
        except Exception:
            ok = False
        if ok != ONLINE["ok"]:
            ONLINE["ok"] = ok
            print(f"[gateway] camera {'back on' if ok else 'not answering'} ({ARGS.probe})", flush=True)
            CHANGED.set()
        try:
            await asyncio.wait_for(stop.wait(), 30)
        except asyncio.TimeoutError:
            pass


def start_go2rtc():
    p = subprocess.Popen([ARGS.go2rtc, "-config", ARGS.go2rtc_config],
                         stdout=open(ARGS.log_dir + "/go2rtc.log", "a"), stderr=subprocess.STDOUT,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for _ in range(40):
        try:
            urllib.request.urlopen(f"http://{GO2RTC}/api", timeout=1).close()
            return p
        except Exception:
            time.sleep(0.25)
    p.terminate()
    raise SystemExit("go2rtc did not answer on " + GO2RTC + " (see go2rtc.log)")


def start_tunnel():
    p = subprocess.Popen([ARGS.cloudflared, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{ARGS.port}"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, bufsize=1,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    log = open(ARGS.log_dir + "/cloudflared.log", "a")
    t0 = time.time()
    while time.time() - t0 < 60:
        line = p.stderr.readline()
        if not line:
            if p.poll() is not None:
                break
            continue
        log.write(line); log.flush()
        m = TUNNEL_RE.search(line)
        if m:
            import threading            # keep draining stderr so cloudflared never blocks
            threading.Thread(target=lambda: [log.write(l) or log.flush() for l in p.stderr], daemon=True).start()
            return p, m.group(0)
    p.terminate()
    raise SystemExit("cloudflared gave no tunnel address within 60 s (see cloudflared.log)")


async def main():
    stop = asyncio.Event()
    procs = []
    try:
        if ARGS.go2rtc:
            procs.append(start_go2rtc())
            print(f"[gateway] go2rtc up on {GO2RTC} (local only)", flush=True)
        base = ARGS.base
        if not base and ARGS.cloudflared:
            tp, base = start_tunnel()
            procs.append(tp)
            print(f"[gateway] public address {base}", flush=True)
        server = await serve(player, "127.0.0.1", ARGS.port, process_request=http_routes,
                             compression=None, max_size=2 ** 20, ping_interval=20)
        tasks = []
        announce_task = None
        if base and not ARGS.no_relay:
            announce_task = asyncio.create_task(announce(base, stop))
            tasks.append(announce_task)
        if ARGS.probe:
            tasks.append(asyncio.create_task(probe_loop(stop)))

        async def watch_helpers():
            # a dead tunnel leaves a card pointing nowhere: stop (the card comes
            # off), so whatever supervises this starts again with a new address
            while not stop.is_set():
                for p in procs:
                    if p.poll() is not None:
                        print(f"[gateway] helper {os.path.basename(p.args[0])} exited (code {p.returncode}); "
                              "stopping", flush=True)
                        stop.set()
                        return
                try:
                    await asyncio.wait_for(stop.wait(), 10)
                except asyncio.TimeoutError:
                    pass
        tasks.append(asyncio.create_task(watch_helpers()))
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:
                signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))
        if ARGS.stop_file:
            async def watch():
                while not stop.is_set():
                    if os.path.exists(ARGS.stop_file):
                        stop.set()
                    await asyncio.sleep(1)
            tasks.append(asyncio.create_task(watch()))
        await stop.wait()
        if announce_task is not None:
            try:
                await asyncio.wait_for(announce_task, 10)  # the bye
            except asyncio.TimeoutError:
                print("[gateway] relay did not take the bye in 10 s; it drops the card when the socket closes",
                      flush=True)
        server.close()
        await asyncio.sleep(0.5)
    finally:
        for p in procs:
            p.terminate()
        if ARGS.stop_file and getattr(ARGS, "remove_stop_file", True) and os.path.exists(ARGS.stop_file):
            os.remove(ARGS.stop_file)
        print("[gateway] stopped", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--camera", action="append", required=True,
                    help="STREAM:MODEL:LABEL[:WxH], STREAM a name in the go2rtc config")
    ap.add_argument("--go2rtc", help="go2rtc executable (omit if it already runs on 127.0.0.1:1984)")
    ap.add_argument("--go2rtc-config")
    ap.add_argument("--cloudflared", help="cloudflared executable: a quick tunnel gives the public address")
    ap.add_argument("--base", help="public https address of this gateway, if not using cloudflared")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--relay", default=RELAY)
    ap.add_argument("--owner", default="Alex")
    ap.add_argument("--pseudonym", default="camera-gateway-laptop")
    ap.add_argument("--note", default="")
    ap.add_argument("--no-relay", action="store_true", help="serve the stream but send no card")
    ap.add_argument("--stop-file", help="stop (and take the card down) when this file appears")
    ap.add_argument("--log-dir", default=".")
    ap.add_argument("--probe", help="HOST:PORT checked every 30 s; the card shows the camera off when it does not answer")
    ARGS = ap.parse_args()
    for spec in ARGS.camera:
        parts = spec.split(":")
        if len(parts) < 3 or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", parts[0]):
            raise SystemExit(f"--camera {spec!r}: STREAM:MODEL:LABEL[:WxH]")
        w, h = (int(v) for v in parts[3].split("x")) if len(parts) > 3 else (1920, 1080)
        CAMERAS.append({"id": parts[0], "model": parts[1][:48], "label": parts[2][:60], "w": w, "h": h})
        ALLOWED.add(parts[0])
    if ARGS.go2rtc and not ARGS.go2rtc_config:
        raise SystemExit("--go2rtc needs --go2rtc-config")
    os.makedirs(ARGS.log_dir, exist_ok=True)
    asyncio.run(main())
