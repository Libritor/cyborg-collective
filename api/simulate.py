#!/usr/bin/env python3
"""simulate.py -- a stand-in for the Collective relay, for demos and drills.

Speaks the relay's WebSocket protocol verbatim (``snapshot``, ``eeg``,
``bands``, ``quality``, ``arousal``, ``hr``, ``aggregate``), so the service
under test cannot tell it apart from the real thing:

    python3 api/simulate.py                          # ws://127.0.0.1:8790/live
    python3 api/server.py --relay ws://127.0.0.1:8790/live --osc 127.0.0.1:5000

Then everything downstream is real: ``/api/v1/live/*``, SSE fan-out, JSONL
capture, and OSC/UDP. Nothing here is wired into the service's own code path;
it is only a synthetic upstream.

The signal is synthetic but not noise: band powers drift on slow oscillators,
EEG frames hold a real mixture of 10 Hz (alpha) and 6 Hz (theta), heart rate
breathes, and one channel's contact quality wanders -- numbers move in a way
you can watch in a stream and hear through a CC mapping.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import signal
import time

from aiohttp import web

CHANNELS = ["TP9", "AF7", "AF8", "TP10"]
BANDS = ["delta", "theta", "alpha", "beta", "gamma"]
FS = 256
AROUSAL_LABELS = [(0.33, "calm"), (0.66, "alert"), (1.01, "activated")]


class Voice:
    """One synthetic sharer: a deterministically drifting EEG + vitals."""

    def __init__(self, pseudonym, name, seed):
        self.pseudonym = pseudonym
        self.name = name
        self.seed = seed
        self.since = int(time.time() * 1000)
        self.seq = 0

    # ------------------------------------------------------------------ signal
    def _phase(self, index):
        return 0.7 * self.seed + index

    def alpha_amp(self, t):
        return 18.0 + 9.0 * math.sin(0.13 * t + self._phase(0))

    def eeg(self, t, samples):
        """One frame: `samples` samples per channel, `1/rate` seconds of signal."""
        rows = []
        for channel in range(4):
            alpha = self.alpha_amp(t) * (1.0 - 0.12 * channel)
            theta = 9.0 + 4.0 * math.sin(0.07 * t + channel)
            drift = 6.0 * math.sin(0.03 * t + 0.5 * channel)
            row = []
            for index in range(samples):
                clock = t + index / FS
                value = (alpha * math.sin(2 * math.pi * 10.0 * clock + 0.3 * channel)
                         + theta * math.sin(2 * math.pi * 6.0 * clock + 1.1 * channel)
                         + drift
                         + 2.5 * math.sin(2 * math.pi * 37.0 * clock + channel))
                row.append(round(value, 3))
            rows.append(row)
        self.seq += 1
        return {
            "t": "eeg", "pseudonym": self.pseudonym, "seq": self.seq,
            "ts": int(time.time() * 1000), "fs": FS, "x": rows,
        }

    def hsi(self, t):
        """Contact codes; TP10 wanders between good and poor so the reports move."""
        wander = 0.5 + 0.5 * math.sin(0.11 * t + self._phase(3))
        return {
            "TP9": 1,
            "AF7": 1 if wander < 0.6 else 2,
            "AF8": 2 if wander < 0.4 else 1,
            "TP10": 1 if wander < 0.35 else (2 if wander < 0.7 else 3),
        }

    def bands(self, t, contact):
        rel, abs_ = {}, {}
        for index, band in enumerate(BANDS):
            wave = math.sin(0.09 * t + index * 0.8 + self._phase(1))
            level = 0.5 + 0.42 * wave
            rel[band] = []
            abs_[band] = []
            for channel, name in enumerate(CHANNELS):
                share = max(0.02, min(1.0, level - 0.06 * channel))
                rel[band].append(None if contact[name] == 4 else round(share, 4))
                abs_[band].append(round(1.2 + share * 1.6 + 0.15 * channel, 4))
        return {"t": "bands", "pseudonym": self.pseudonym, "rel": rel, "abs": abs_}

    def quality(self, contact):
        return {"t": "quality", "pseudonym": self.pseudonym, "hsi": contact}

    def arousal(self, t):
        index = max(0.0, min(1.0, 0.5 + 0.34 * math.sin(0.06 * t + self._phase(2))))
        label = next(word for limit, word in AROUSAL_LABELS if index <= limit)
        return {
            "t": "arousal", "pseudonym": self.pseudonym, "index": round(index, 4),
            "label": label, "confidence": round(0.72 + 0.15 * math.sin(0.05 * t), 4),
            "quality": {"score": round(0.78 + 0.12 * math.sin(0.04 * t), 4)},
            "reason": "",
        }

    def hr(self, t):
        bpm = 62.0 + 9.0 * math.sin(0.05 * t + self._phase(0))
        return {
            "t": "hr", "pseudonym": self.pseudonym, "ok": True,
            "bpm": round(bpm, 2),
            "rmssd_ms": round(42.0 + 7.0 * math.sin(0.08 * t), 2),
            "sdnn_ms": round(55.0 + 9.0 * math.sin(0.06 * t), 2),
            "beats": 10 + int(2 * math.sin(0.1 * t)),
            "source": "polar",
        }

    def frames(self, t, samples):
        contact = self.hsi(t)
        return [
            self.eeg(t, samples),
            self.bands(t, contact),
            self.quality(contact),
            self.arousal(t),
            self.hr(t),
        ]

    def snapshot_entry(self):
        # the relay describes a person once; the hub seeds state from "last"
        return {
            "pseudonym": self.pseudonym, "name": self.name, "kind": "device",
            "tier": "raw", "since": self.since,
            "device": {"model": "Muse S (gen 2)", "battery": 87},
            "last": {},
        }


def make_voices(count, prefix):
    return [Voice(f"{prefix}-{index + 1:02d}", f"Demo {index + 1}", seed=index + 1)
            for index in range(count)]


async def run(args):
    voices = make_voices(args.people, args.prefix)
    clients: set[web.WebSocketResponse] = set()
    stats = {"frames": 0, "clients": 0, "started": time.time()}

    def snapshot():
        return {"t": "snapshot", "people": [voice.snapshot_entry() for voice in voices]}

    async def broadcast(frame):
        if not clients:
            return
        text = json.dumps(frame)
        for ws in list(clients):
            try:
                await ws.send_str(text)
            except (ConnectionResetError, RuntimeError):
                clients.discard(ws)

    async def ws_handler(request):
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        clients.add(ws)
        stats["clients"] = len(clients)
        await ws.send_str(json.dumps(snapshot()))
        print(f"  client connected from {request.remote} "
              f"({len(clients)} now, {len(voices)} sharers)", flush=True)
        try:
            async for message in ws:
                if message.type == web.WSMsgType.TEXT:
                    continue                      # the relay ignores client talk
                break
        finally:
            clients.discard(ws)
            stats["clients"] = len(clients)
        return ws

    async def pump():
        period = 1.0 / args.rate
        samples = max(1, round(FS / args.rate))
        started = time.time()
        last_report = 0.0
        last_aggregate = 0.0
        while True:
            await asyncio.sleep(period)
            now = time.time()
            elapsed = now - started
            for voice in voices:
                for frame in voice.frames(elapsed, samples):
                    await broadcast(frame)
                    stats["frames"] += 1
            if elapsed - last_aggregate >= 3.0:
                last_aggregate = elapsed
                await broadcast({
                    "t": "aggregate", "n": len(voices), "usable_n": len(voices),
                    "cameras": 0, "rel_alpha_mean": 0.52, "arousal_mean": 0.48,
                })
            if elapsed - last_report >= 1.0:
                last_report = elapsed
                print(f"  t={elapsed:6.1f}s  sent {stats['frames']:6d} frames  "
                      f"{len(voices)} sharer(s) x {samples} samples/frame @ {args.rate}/s  "
                      f"clients={stats['clients']}", flush=True)

    app = web.Application()
    app.router.add_get(args.path, ws_handler)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port)
    await site.start()

    print(f"simulate.py -- fake relay on ws://{args.host}:{args.port}{args.path}", flush=True)
    print(f"  sharers: {', '.join(v.pseudonym for v in voices)}", flush=True)
    print("  point the service at it:", flush=True)
    print(f"    python3 api/server.py --relay ws://{args.host}:{args.port}{args.path}"
          f" --osc 127.0.0.1:5000", flush=True)
    print("  then watch:", flush=True)
    print(f"    curl -s localhost:8787/api/v1/live/sharers", flush=True)
    print(f"    curl -N 'localhost:8787/api/v1/live/{voices[0].pseudonym}/"
          f"eeg?decimate=8'", flush=True)
    print(f"    curl -N localhost:8787/api/v1/live/{voices[0].pseudonym}/features", flush=True)

    task = asyncio.create_task(pump())
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
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await broadcast({"t": "leave", "pseudonym": voices[0].pseudonym})
        await runner.cleanup()
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        prog="api/simulate.py",
        description="A stand-in Collective relay: synthetic sharers over the real protocol.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--path", default="/live")
    parser.add_argument("--people", type=int, default=1, help="how many sharers (default 1)")
    parser.add_argument("--prefix", default="demo", help="pseudonym prefix (default demo)")
    parser.add_argument("--rate", type=float, default=8.0,
                        help="frames per second per sharer (default 8)")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.rate = max(0.5, min(30.0, args.rate))
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
