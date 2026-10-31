#!/usr/bin/env python3
"""probe_live.py -- one-command diagnostic for a real headband on the service.

Points at a running ``api/server.py`` and reports what the streams actually
carry for one sharer: the measured frame rate, the channel layout, per-channel
dropouts, the validity gates, whether a capture on disk is growing, and whether
the service ever marked that sharer stale. Standard library only, so it runs
anywhere the service runs -- and it reads the service over HTTP, so it exercises
the same path a player does.

    python3 api/probe_live.py                          # 30 s, first sharer
    python3 api/probe_live.py --seconds 10 --sharer russet-grebe-53
    python3 api/probe_live.py --api http://127.0.0.1:8787 --decimate 4

Exit codes: ``0`` when eeg frames arrived (warnings are reported, not fatal),
``1`` when nothing streamed at all.
"""

from __future__ import annotations

import argparse
import http.client
import json
import socket
import sys
import threading
import time
from urllib.parse import quote, urlsplit

from catalogue import CHANNELS

NULL_SAMPLE_EVENTS = 20     # events used for the per-channel dropout fraction
DROP_WARN = 0.2             # a channel null in more than this share is a warning


# ------------------------------------------------------------------------ HTTP
def parse_target(text):
    """'http://host:port' (or bare 'host:port') -> (host, port)."""
    parts = urlsplit(text if "//" in text else f"//{text}")
    if not parts.hostname:
        raise SystemExit(f"--api expects a URL such as http://127.0.0.1:8787, got {text!r}")
    return parts.hostname, parts.port or 80


def get_json(host, port, path, timeout=10.0):
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("GET", path)
        response = conn.getresponse()
        status = response.status
        body = response.read()
    finally:
        conn.close()
    try:
        return status, json.loads(body)
    except ValueError:
        return status, None


def _event(block):
    """The JSON payload of one SSE block, or None for comments/keepalives."""
    for line in block.split(b"\n"):
        if line.startswith(b"data: "):
            try:
                return json.loads(line[6:])
            except ValueError:
                return None
    return None


def _read_events(host, port, path, seconds, on_event):
    """Feed every SSE event to ``on_event`` for ``seconds``; return an error.

    One socket timeout covers the whole window: a timeout *is* the end of the
    probe when a stream is silent, and ``http.client`` cannot be read again
    after one anyway ("cannot read from timed out object") -- retrying after a
    timeout ended a 30 s probe on a quiet sharer after 2 s.
    """
    conn = http.client.HTTPConnection(host, port, timeout=max(1.0, seconds + 1.0))
    try:
        conn.request("GET", path, headers={"Accept": "text/event-stream"})
        response = conn.getresponse()
        if response.status != 200:
            return f"HTTP {response.status}"
        buffer = b""
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                chunk = response.read1(65536)
            except (socket.timeout, TimeoutError):
                break                       # the window passed in silence
            except (OSError, http.client.HTTPException):
                break
            if not chunk:
                break                       # bye/leave closed the stream
            buffer += chunk
            while b"\n\n" in buffer:
                block, buffer = buffer.split(b"\n\n", 1)
                payload = _event(block)
                if payload is not None:
                    on_event(payload)
    finally:
        conn.close()
    return None


# ------------------------------------------------------------------ collectors
def collect_eeg(host, port, path, seconds, box):
    """Counts only: events, layout, sample widths, per-channel nulls."""

    def on_event(payload):
        kind = payload.get("t")
        if kind == "hello":
            box["fs"] = payload.get("fs")
            box["channels"] = payload.get("channels") or CHANNELS
            return
        if kind == "bye":
            box["bye"] = True
            return
        if kind != "eeg":
            return
        box["events"] += 1
        rows = payload.get("x") if isinstance(payload.get("x"), list) else []
        if box["rows"] is None:
            box["rows"] = len(rows)
        if len(rows) != box["rows"]:
            box["unequal"] += 1
        lengths = []
        for index, row in enumerate(rows):
            if not isinstance(row, list):
                continue
            lengths.append(len(row))
            if box["sample_min"] is None or len(row) < box["sample_min"]:
                box["sample_min"] = len(row)
            if box["sample_max"] is None or len(row) > box["sample_max"]:
                box["sample_max"] = len(row)
            if box["counted"] < NULL_SAMPLE_EVENTS and index < len(box["counts"]):
                box["counts"][index] += len(row)
                box["nulls"][index] += sum(1 for v in row if v is None)
        if lengths and min(lengths) != max(lengths):
            box["unequal"] += 1
        if box["counted"] < NULL_SAMPLE_EVENTS:
            box["counted"] += 1

    box["error"] = _read_events(host, port, path, seconds, on_event)


def collect_features(host, port, path, seconds, box):
    """The set of event types, the last valid flags, stale count, bye."""

    def on_event(payload):
        kind = payload.get("t")
        if kind not in box["types"]:
            box["types"].append(kind)
        if kind == "features":
            box["events"] += 1
            valid = payload.get("valid")
            if isinstance(valid, dict):
                for key in ("bands", "arousal", "hr"):
                    box["valid"][key] = bool(valid.get(key))
            if isinstance(payload.get("stale_s"), (int, float)):
                box["stale_s"] = payload["stale_s"]
        elif kind == "stale":
            box["stale"] += 1
        elif kind == "bye":
            box["bye"] = True

    box["error"] = _read_events(host, port, path, seconds, on_event)


def capture_totals(host, port):
    """{capture id: byte size} for the captures the service is holding."""
    status, body = get_json(host, port, "/api/v1/captures")
    if status != 200 or not isinstance(body, dict):
        return None
    out = {}
    for entry in body.get("captures") or []:
        if isinstance(entry, dict) and entry.get("id") is not None:
            out[entry["id"]] = (entry.get("bytes"), entry.get("frames"))
    return out


# ---------------------------------------------------------------------- report
def _percent(part, whole):
    return 100.0 * part / whole if whole else 0.0


def main(argv=None):
    args = build_parser().parse_args(argv)
    host, port = parse_target(args.api)

    status, body = get_json(host, port, "/api/v1/live/sharers")
    if status != 200 or not isinstance(body, dict):
        print(f"cannot read {args.api}/api/v1/live/sharers (HTTP {status})")
        return 1
    sharers = body.get("sharers") or []
    if not sharers:
        print("no sharer streaming: start the headband, then retry")
        return 1
    if args.sharer:
        match = [s for s in sharers if s.get("pseudonym") == args.sharer]
        if not match:
            print(f"no sharer {args.sharer!r}; streaming now: "
                  + ", ".join(str(s.get("pseudonym")) for s in sharers))
            return 1
        entry = match[0]
    else:
        entry = sharers[0]

    pseudonym = str(entry.get("pseudonym"))
    quoted = quote(pseudonym, safe="")
    print(f"sharer            {pseudonym:<24} tier {entry.get('tier')}"
          f"   stale_s {_short(entry.get('stale_s'))}")

    before = capture_totals(host, port)

    eeg = {"events": 0, "fs": None, "channels": CHANNELS, "rows": None,
           "sample_min": None, "sample_max": None, "unequal": 0, "counted": 0,
           "nulls": [0] * len(CHANNELS), "counts": [0] * len(CHANNELS),
           "bye": False, "error": None}
    features = {"events": 0, "types": [], "valid": {}, "stale": 0, "stale_s": None,
                "bye": False, "error": None}

    readers = [
        threading.Thread(target=collect_eeg, name="eeg", daemon=True, args=(
            host, port, f"/api/v1/live/{quoted}/eeg?decimate={args.decimate}",
            args.seconds, eeg)),
        threading.Thread(target=collect_features, name="features", daemon=True, args=(
            host, port, f"/api/v1/live/{quoted}/features", args.seconds, features)),
    ]
    for thread in readers:
        thread.start()
    for thread in readers:
        thread.join(timeout=args.seconds + 5.0)

    after = capture_totals(host, port)
    growing = "unknown"
    if before is not None and after is not None:
        changed = [key for key, value in after.items() if before.get(key) != value]
        growing = "yes" if changed else "no"

    widths = ("unknown" if eeg["sample_min"] is None
              else f"{eeg['sample_min']}..{eeg['sample_max']}")

    def dropout(nulls, counts):
        return f"{_percent(nulls, counts):.1f}%" if counts else "n/a"

    print(f"eeg events        {eeg['events']}   fs {_short(eeg['fs'] if eeg['events'] else None)}"
          f"   rows {_short(eeg['rows'])}   samples/row {widths}")
    print("nulls per channel "
          + "  ".join(f"{channel} {dropout(nulls, counts)}"
                      for channel, nulls, counts
                      in zip(eeg["channels"], eeg["nulls"], eeg["counts"])))
    print(f"features events   {features['events']}"
          f"   types {','.join(features['types']) or 'none'}")
    print("valid            "
          + "  ".join(f"{key} {features['valid'].get(key, '?')}"
                      for key in ("bands", "arousal", "hr")))
    print(f"capture growing   {growing}")

    if eeg["error"]:
        print(f"CHECK warn eeg stream: {eeg['error']}")
    if features["error"]:
        print(f"CHECK warn features stream: {features['error']}")
    if eeg["bye"]:
        print("CHECK warn the sharer left during the probe")
    if features["stale"]:
        print(f"CHECK warn the service reported this sharer stale "
              f"{features['stale']}x (silent for {_short(features['stale_s'])} s)")

    if not eeg["events"]:
        print(f"no eeg frames in {args.seconds}s")
        print("CHECK warn the sharer is listed but streams no samples: on a Muse "
              "this means the app is idle (it sends only device frames), "
              "the headband is off, or it is not worn")
        return 1

    if eeg["rows"] == len(CHANNELS) and not eeg["unequal"]:
        print("CHECK ok channel layout " + " ".join(CHANNELS))
    else:
        print(f"CHECK warn channel layout: {_short(eeg['rows'])} rows"
              f", {eeg['unequal']} frame(s) with uneven rows")

    rate = entry.get("eeg_hz")
    if isinstance(rate, (int, float)) and 200 <= rate <= 320:
        print(f"CHECK ok rate looks like a Muse ({rate:.0f} Hz)")
    else:
        print(f"CHECK warn rate {_short(rate)} Hz (a Muse runs 200..320 Hz)")

    for channel, nulls, counts in zip(eeg["channels"], eeg["nulls"], eeg["counts"]):
        share = _percent(nulls, counts) / 100.0
        if share > DROP_WARN:
            print(f"CHECK warn dropouts on {channel} ({share * 100:.1f}%)")

    if features["valid"].get("bands") is False:
        print("CHECK warn bands gated: no channel in contact")
    return 0


def _short(value):
    """One number as a compact string; None stays readable."""
    if value is None:
        return "n/a"
    if isinstance(value, float):
        return f"{value:.1f}"
    return str(value)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="api/probe_live.py",
        description="Read a live sharer off collective-api and report what the "
                    "streams actually carry.")
    parser.add_argument("--api", default="http://127.0.0.1:8787",
                        help="service base URL (default: http://127.0.0.1:8787)")
    parser.add_argument("--seconds", type=float, default=30.0,
                        help="how long to read both streams (default: 30)")
    parser.add_argument("--sharer", default=None, metavar="PSEUDONYM",
                        help="which sharer to probe (default: the first one listed)")
    parser.add_argument("--decimate", type=int, default=1,
                        help="eeg decimation passed to the stream (default: 1)")
    return parser


if __name__ == "__main__":
    sys.exit(main())
