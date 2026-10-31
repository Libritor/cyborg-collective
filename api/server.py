"""collective-api -- HTTP/JSON + SSE access to the Collective's brain data.

Serves three things from one process:

  * the recorded catalogue in ``data/`` (sessions, devices, and a derived
    ``patch`` projection meant to be turned into sound by a player),
  * the live relay (WebSocket upstream -> SSE/JSON downstream), plus a live
    OSC/UDP feed for ``osc_cc_bridge.py`` -> IAC -> Ableton,
  * local JSONL captures of everything the relay sent, replayable over SSE.

Run:
    python3 api/server.py --port 8787
    python3 api/server.py --osc 127.0.0.1:5000

Every route is ``/api/v1/...`` and answers JSON with
``Access-Control-Allow-Origin: *``. The stream routes are ``text/event-stream``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import signal
import sys
import time
from pathlib import Path

from aiohttp import web

from capture import CaptureWriter, capture_path, find_capture, list_captures, read_frames
from catalogue import BANDS, CATALOGUE_ROOT, CHANNELS, Catalogue, number
from osc import OscEmitter
from relay import DEFAULT_RELAY, FS_DEFAULT, STATE_TYPES, RelayHub, features_of

SERVICE = "collective-api"
VERSION = "1.0.0"
KEEPALIVE_S = 15.0
REPLAY_MAX_DELAY = 5.0
CORS = {"Access-Control-Allow-Origin": "*"}
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")

log = logging.getLogger("collective-api")


class ApiError(Exception):
    """A handler-level error that becomes ``{"error": ...}`` with a status."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


# --------------------------------------------------------------------- plumbing
def json_response(payload, status=200):
    return web.json_response(payload, status=status, headers=CORS)


def error_response(message, status):
    return json_response({"error": message}, status=status)


@web.middleware
async def errors_and_cors(request, handler):
    """Turn ApiError into JSON, and put the CORS header on every response."""
    if request.method == "OPTIONS":
        return web.Response(status=204, headers={
            **CORS,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "content-type",
        })
    try:
        response = await handler(request)
    except ApiError as exc:
        return error_response(exc.message, exc.status)
    except web.HTTPException as exc:
        exc.headers.update(CORS)
        return exc
    if not response.prepared:
        response.headers.update(CORS)
    return response


def int_param(request, name, default, low, high):
    raw = request.query.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ApiError(f"{name} must be an integer", 400)
    if not low <= value <= high:
        raise ApiError(f"{name} must be between {low} and {high}", 400)
    return value


def float_param(request, name, default, low, high):
    raw = request.query.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ApiError(f"{name} must be a number", 400)
    if not low <= value <= high:
        raise ApiError(f"{name} must be between {low} and {high}", 400)
    return value


def date_param(request, name):
    raw = request.query.get(name)
    if raw is None or raw == "":
        return None
    if not DATE_RE.fullmatch(raw):
        raise ApiError(f"{name} must be YYYY-MM-DD", 400)
    return raw


def channels_param(request):
    """``channels`` query -> subset of CHANNELS in canonical order."""
    raw = request.query.get("channels")
    if not raw:
        return list(CHANNELS)
    picked = set()
    for part in raw.split(","):
        name = part.strip().upper()
        if not name:
            continue
        if name not in CHANNELS:
            raise ApiError(f"unknown channel {part.strip()!r}", 400)
        picked.add(name)
    if not picked:
        raise ApiError("channels must name at least one of " + ",".join(CHANNELS), 400)
    return [c for c in CHANNELS if c in picked]


def eeg_event(frame, pseudonym, channels, decimate, seq=None):
    """Normalise one upstream ``eeg`` frame into the SSE event shape."""
    rows = frame.get("x")
    if not isinstance(rows, list):
        rows = []
    selected = []
    for channel in channels:
        index = CHANNELS.index(channel)
        row = rows[index] if index < len(rows) and isinstance(rows[index], list) else []
        selected.append([
            v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
            for v in row[::decimate]
        ])
    fs = number(frame.get("fs")) or FS_DEFAULT
    ts = number(frame.get("ts"))
    return {
        "t": "eeg",
        "pseudonym": pseudonym,
        "ts": int(ts) if ts is not None else int(time.time() * 1000),
        "seq": seq if seq is not None else frame.get("seq"),
        "fs": round(fs / decimate, 3),
        "channels": channels,
        "unit": "uV",
        "x": selected,
    }


def count_captures(directory):
    path = Path(directory)
    if not path.is_dir():
        return 0
    return sum(1 for _ in path.glob("*.jsonl"))


def sse_headers():
    return {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        **CORS,
    }


async def sse_start(request):
    response = web.StreamResponse(headers=sse_headers())
    response.enable_chunked_encoding()
    await response.prepare(request)
    return response


async def sse_send(response, payload):
    data = json.dumps(payload, separators=(",", ":"))
    await response.write(b"data: " + data.encode("utf-8") + b"\n\n")


async def sse_queue(response, queue):
    """Yield queued frames, emitting a keepalive comment every KEEPALIVE_S."""
    while True:
        try:
            yield await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_S)
        except asyncio.TimeoutError:
            await response.write(b": keepalive\n\n")


def require_hub(request):
    hub = request.app["hub"]
    if hub is None:
        raise ApiError("relay disconnected", 503)
    return hub


# ------------------------------------------------------------------ projections
def build_patch(device):
    """The catalogue's one music-facing projection; strictly derived numbers."""
    bands = device.get("bands_median")
    if not isinstance(bands, dict):
        bands = {}
    log10 = {}
    for band in BANDS:
        source = bands.get(band)
        if not isinstance(source, dict):
            source = {}
        log10[band] = {ch: number(source.get(ch)) for ch in CHANNELS}

    norm = {}
    best = {}
    for band in BANDS:
        values = log10[band]
        pick = None
        top = None
        for channel in CHANNELS:
            value = values[channel]
            if value is not None and (top is None or value > top):
                pick, top = channel, value
        if top is None or top <= 0:
            norm[band] = {ch: 0.0 for ch in CHANNELS}
            best[band] = None
        else:
            norm[band] = {ch: (values[ch] / top if values[ch] is not None else None)
                          for ch in CHANNELS}
            best[band] = pick

    clean = device.get("clean_epoch_frac")
    if not isinstance(clean, dict):
        clean = {}
    return {
        "stamp": device.get("stamp"),
        "tag": device.get("tag"),
        "duration_s": number(device.get("duration_s")),
        "fs_hz": number(device.get("fs_est")),
        "contact": {ch: number(clean.get(ch)) for ch in CHANNELS},
        "bands_log10": log10,
        "bands_norm": norm,
        "best_channel": best,
    }


# --------------------------------------------------------------------- handlers
async def health(request):
    app = request.app
    hub = app["hub"]
    osc = app["osc"]
    relay = hub.status() if hub is not None else {
        "url": app["relay_url"], "connected": False, "frames": 0, "last_frame_ts": None,
    }
    return json_response({
        "ok": True,
        "service": SERVICE,
        "version": VERSION,
        "relay": relay,
        "catalogue": app["catalogue"].stats(),
        "captures": {"n": count_captures(app["captures_dir"]),
                     "dir": str(app["captures_dir"])},
        "osc": {
            "enabled": osc is not None,
            "target": osc.target if osc is not None else None,
            "sharer": osc.sharer if osc is not None else None,
            "messages": osc.sent if osc is not None else 0,
        },
    })


async def sessions_list(request):
    catalogue = request.app["catalogue"]
    limit = int_param(request, "limit", 50, 1, 500)
    offset = int_param(request, "offset", 0, 0, 10 ** 9)
    usable_only = (request.query.get("usable_only") or "").strip().lower() in ("1", "true", "yes")
    project = (request.query.get("project") or "").strip() or None
    rows, total = catalogue.query(
        limit=limit, offset=offset, usable_only=usable_only, project=project,
        since=date_param(request, "since"), until=date_param(request, "until"),
    )
    return json_response({"total": total, "limit": limit, "offset": offset, "rows": rows})


async def session_detail(request):
    catalogue = request.app["catalogue"]
    session = catalogue.session(request.match_info["stamp"])
    if session is None:
        raise ApiError("unknown stamp", 404)
    return json_response(session)


async def device_detail(request):
    catalogue = request.app["catalogue"]
    stamp, tag = request.match_info["stamp"], request.match_info["tag"]
    device = catalogue.device(stamp, tag)
    if device is None:
        raise ApiError("unknown tag" if catalogue.has_stamp(stamp) else "unknown stamp", 404)
    return json_response(device)


async def device_patch(request):
    catalogue = request.app["catalogue"]
    stamp, tag = request.match_info["stamp"], request.match_info["tag"]
    device = catalogue.device(stamp, tag)
    if device is None:
        raise ApiError("unknown tag" if catalogue.has_stamp(stamp) else "unknown stamp", 404)
    return json_response(build_patch(device))


async def live_sharers(request):
    hub = require_hub(request)
    return json_response({
        "relay": "connected" if hub.connected else "disconnected",
        "sharers": hub.sharers(),
        "ts": time.time(),
    })


async def live_eeg(request):
    hub = require_hub(request)
    pseudonym = request.match_info["pseudonym"]
    if not hub.has(pseudonym):
        raise ApiError("unknown pseudonym", 404)
    channels = channels_param(request)
    decimate = int_param(request, "decimate", 1, 1, 16)
    queue = hub.subscribe(pseudonym)
    response = await sse_start(request)
    seq = 0
    try:
        rate = hub.eeg_hz(pseudonym) or FS_DEFAULT
        await sse_send(response, {
            "t": "hello", "pseudonym": pseudonym,
            "fs": round(rate / decimate, 3), "channels": channels,
            "decimate": decimate,
        })
        async for frame in sse_queue(response, queue):
            if frame.get("t") != "eeg":
                continue
            await sse_send(response, eeg_event(frame, pseudonym, channels, decimate, seq=seq))
            seq += 1
    except (ConnectionResetError, RuntimeError):
        pass                      # client went away or the transport closed
    finally:
        hub.unsubscribe(pseudonym, queue)
    return response


async def live_features(request):
    hub = require_hub(request)
    pseudonym = request.match_info["pseudonym"]
    if not hub.has(pseudonym):
        raise ApiError("unknown pseudonym", 404)
    queue = hub.subscribe(pseudonym)
    response = await sse_start(request)
    try:
        await sse_send(response, {"t": "hello", "pseudonym": pseudonym,
                                  "eeg_hz": hub.eeg_hz(pseudonym)})
        async for frame in sse_queue(response, queue):
            if frame.get("t") not in STATE_TYPES:
                continue
            payload = hub.features(pseudonym) or {}
            await sse_send(response, {
                "t": "features", "pseudonym": pseudonym,
                "ts": int(time.time() * 1000), **payload,
            })
    except (ConnectionResetError, RuntimeError):
        pass
    finally:
        hub.unsubscribe(pseudonym, queue)
    return response


async def captures_list(request):
    return json_response({"captures": list_captures(request.app["captures_dir"])})


async def capture_detail(request):
    entry = find_capture(request.app["captures_dir"], request.match_info["capture_id"])
    if entry is None:
        raise ApiError("unknown capture", 404)
    return json_response(entry)


def replay_pacing(previous, current, speed):
    if previous is None:
        return 0.0
    return min(REPLAY_MAX_DELAY, max(0.0, (current - previous) / speed))


async def capture_eeg(request):
    directory = request.app["captures_dir"]
    capture_id = request.match_info["capture_id"]
    path = capture_path(directory, capture_id)
    if path is None:
        raise ApiError("unknown capture", 404)
    channels = channels_param(request)
    decimate = int_param(request, "decimate", 1, 1, 16)
    speed = float_param(request, "speed", 1.0, 0.1, 100.0)
    start = int_param(request, "start", 0, 0, 10 ** 9)

    response = await sse_start(request)
    try:
        await sse_send(response, {
            "t": "hello", "capture": capture_id, "channels": channels,
            "decimate": decimate, "speed": speed, "start": start,
        })
        seen = 0
        sent = 0
        previous = None
        for entry in read_frames(path):
            frame = entry["frame"]
            if frame.get("t") != "eeg":
                continue
            seen += 1
            if seen <= start:
                continue
            delay = replay_pacing(previous, entry["recv_ts"], speed)
            if delay > 0:
                await asyncio.sleep(delay)
            previous = entry["recv_ts"]
            pseudonym = frame.get("pseudonym") or capture_id
            await sse_send(response, eeg_event(frame, pseudonym, channels, decimate, seq=sent))
            sent += 1
    except (ConnectionResetError, RuntimeError):
        pass
    return response


async def capture_features(request):
    directory = request.app["captures_dir"]
    capture_id = request.match_info["capture_id"]
    path = capture_path(directory, capture_id)
    if path is None:
        raise ApiError("unknown capture", 404)
    speed = float_param(request, "speed", 1.0, 0.1, 100.0)
    start = int_param(request, "start", 0, 0, 10 ** 9)

    response = await sse_start(request)
    try:
        await sse_send(response, {"t": "hello", "capture": capture_id,
                                  "speed": speed, "start": start})
        merged = {}
        eeg_hz = None
        last_eeg_ts = None
        seen = 0
        previous = None
        for entry in read_frames(path):
            frame = entry["frame"]
            kind = frame.get("t")
            if kind == "eeg":
                rows = frame.get("x") if isinstance(frame.get("x"), list) else []
                widths = [len(row) for row in rows if isinstance(row, list)]
                per_channel = sum(widths) / len(widths) if widths else 0
                if last_eeg_ts is not None and entry["recv_ts"] > last_eeg_ts and per_channel:
                    rate = per_channel / (entry["recv_ts"] - last_eeg_ts)
                    eeg_hz = rate if eeg_hz is None else (0.2 * rate + 0.8 * eeg_hz)
                last_eeg_ts = entry["recv_ts"]
                continue
            if kind not in STATE_TYPES:
                continue
            merged[kind] = frame
            seen += 1
            if seen <= start:
                continue
            delay = replay_pacing(previous, entry["recv_ts"], speed)
            if delay > 0:
                await asyncio.sleep(delay)
            previous = entry["recv_ts"]
            await sse_send(response, {
                "t": "features",
                "capture": capture_id,
                "pseudonym": frame.get("pseudonym") or capture_id,
                "ts": int(entry["recv_ts"] * 1000),
                **features_of(merged, eeg_hz),
            })
    except (ConnectionResetError, RuntimeError):
        pass
    return response


# --------------------------------------------------------------------------- app
def build_app(catalogue, hub=None, captures_dir=None, osc=None, relay_url=DEFAULT_RELAY):
    app = web.Application(middlewares=[errors_and_cors])
    app["catalogue"] = catalogue
    app["hub"] = hub
    app["captures_dir"] = Path(captures_dir) if captures_dir is not None else Path("api/data/captures")
    app["osc"] = osc
    app["relay_url"] = relay_url

    router = app.router
    router.add_get("/api/v1/health", health)
    router.add_get("/api/v1/sessions", sessions_list)
    router.add_get("/api/v1/sessions/{stamp}", session_detail)
    router.add_get("/api/v1/sessions/{stamp}/{tag}", device_detail)
    router.add_get("/api/v1/sessions/{stamp}/{tag}/patch", device_patch)
    router.add_get("/api/v1/live/sharers", live_sharers)
    router.add_get("/api/v1/live/{pseudonym}/eeg", live_eeg)
    router.add_get("/api/v1/live/{pseudonym}/features", live_features)
    router.add_get("/api/v1/captures", captures_list)
    router.add_get("/api/v1/captures/{capture_id}", capture_detail)
    router.add_get("/api/v1/captures/{capture_id}/eeg", capture_eeg)
    router.add_get("/api/v1/captures/{capture_id}/features", capture_features)
    router.add_route("OPTIONS", "/{tail:.*}", lambda request: web.Response(status=204))
    return app


def parse_host_port(text):
    host, _, port = str(text).rpartition(":")
    if not host or not port.isdigit():
        raise SystemExit(f"--osc expects HOST:PORT, got {text!r}")
    return host, int(port)


async def serve(args):
    catalogue = Catalogue(args.root)
    captures_dir = Path(args.captures)
    captures_dir.mkdir(parents=True, exist_ok=True)

    osc = None
    if args.osc:
        host, port = parse_host_port(args.osc)
        osc = OscEmitter(host, port, args.osc_sharer)
        osc.set_error_logger(lambda message: log.warning("%s", message))

    writer = None
    if not args.no_capture:
        writer = CaptureWriter(captures_dir)
        writer.set_error_logger(lambda message: log.warning("%s", message))

    hub = None
    if not args.no_relay:
        hub = RelayHub(args.relay)

        def on_frame(pseudonym, frame):
            if writer is not None:
                writer.write(pseudonym, frame)
            if osc is not None and frame.get("t") in STATE_TYPES:
                osc.emit(hub.osc_state())

        hub.on_frame = on_frame

    app = build_app(catalogue, hub=hub, captures_dir=captures_dir, osc=osc,
                    relay_url=args.relay)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port)
    await site.start()

    task = asyncio.create_task(hub.run()) if hub is not None else None
    stats = catalogue.stats()
    log.info("%s %s on http://%s:%d  sessions=%d devices=%d relay=%s osc=%s captures=%s",
             SERVICE, VERSION, args.host, args.port, stats["sessions"], stats["devices"],
             "off" if hub is None else args.relay,
             "off" if osc is None else osc.target,
             "off" if writer is None else str(captures_dir))

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        await stop.wait()
    finally:
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if writer is not None:
            writer.close()
        if osc is not None:
            osc.close()
        await runner.cleanup()


def build_parser():
    parser = argparse.ArgumentParser(
        prog="api/server.py",
        description="Serve the Collective's recorded catalogue, live relay, "
                    "captures and OSC feed over HTTP.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--relay", default=DEFAULT_RELAY, help="relay WebSocket URL")
    parser.add_argument("--root", default=str(CATALOGUE_ROOT),
                        help="repo root containing data/ (default: parent of api/)")
    parser.add_argument("--captures", default=None,
                        help="capture directory (default: <root>/api/data/captures)")
    parser.add_argument("--no-capture", action="store_true", help="do not record frames")
    parser.add_argument("--no-relay", action="store_true",
                        help="do not connect upstream; /live/* answers 503")
    parser.add_argument("--osc", default=None, metavar="HOST:PORT",
                        help="send OSC/UDP here, e.g. 127.0.0.1:5000")
    parser.add_argument("--osc-sharer", default="any", metavar="PSEUDONYM|any",
                        help="which sharer feeds OSC (default: any = the first)")
    parser.add_argument("--log-level", default="info")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.captures is None:
        args.captures = str(Path(args.root) / "api" / "data" / "captures")
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
