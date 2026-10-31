"""Upstream relay client, per-sharer state hub, and fan-out.

The relay (``wss://cyborg-collective-relay.onrender.com/live``) speaks an
unauthenticated JSON WebSocket. Frames seen today: ``snapshot``, ``aggregate``,
``eeg``, ``bands``, ``quality``, ``arousal``, ``hr``, ``imu``, ``optics``,
``leave``, ``checkin``. Field names follow ``app.js`` (the page's ``handle()``).

The projections at the bottom (``bands_of``, ``hsi_of``, ...) are module
functions so live state and capture replay build the same payloads.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time

import aiohttp

from catalogue import BANDS, CHANNELS, number

DEFAULT_RELAY = "wss://cyborg-collective-relay.onrender.com/live"
FS_DEFAULT = 256
QUEUE_MAX = 64
# frame types that carry a person's merged state
STATE_TYPES = ("bands", "quality", "arousal", "hr")
# everything the page knows about; anything else is logged once and dropped
KNOWN_TYPES = {
    "snapshot", "aggregate", "join", "presence", "profile", "device", "wearable",
    "camera", "imu", "optics", "checkin", "quality", "arousal", "hr", "bands",
    "eeg", "leave", "checkins_changed", "shares_changed", "record_changed",
}
GLOBAL_PSEUDONYM = "_relay"  # capture bucket for snapshot/aggregate frames

log = logging.getLogger("collective-api.relay")


# ------------------------------------------------------------------ projections
def hsi_of(last):
    """{channel: hsi 1..4 | None} from the latest ``quality`` frame."""
    quality = last.get("quality") or {}
    raw = quality.get("hsi") if isinstance(quality.get("hsi"), dict) else {}
    out = {}
    for channel in CHANNELS:
        code = raw.get(channel)
        try:
            out[channel] = int(code) if code is not None else None
        except (TypeError, ValueError):
            out[channel] = None
    return out


def band_block(source):
    """{band: [4 values]} padded to CHANNELS, null preserved."""
    block = {}
    for band in BANDS:
        values = source.get(band) if isinstance(source, dict) else None
        row = list(values)[:len(CHANNELS)] if isinstance(values, list) else []
        row += [None] * (len(CHANNELS) - len(row))
        block[band] = [number(v) for v in row]
    return block


def bands_of(last):
    bands = last.get("bands") or {}
    return {"rel": band_block(bands.get("rel")), "abs": band_block(bands.get("abs"))}


def arousal_of(last):
    arousal = last.get("arousal") or {}
    quality = arousal.get("quality")
    score = quality.get("score") if isinstance(quality, dict) else None
    return {
        "index": number(arousal.get("index")),
        "label": arousal.get("label"),
        "confidence": number(arousal.get("confidence")),
        "quality": number(score),
        "reason": arousal.get("reason") or "",
    }


def hr_of(last):
    hr = last.get("hr") or {}
    return {
        "ok": bool(hr.get("ok")),
        "bpm": number(hr.get("bpm")),
        "rmssd_ms": number(hr.get("rmssd_ms")),
        "sdnn_ms": number(hr.get("sdnn_ms")),
        "beats": hr.get("beats"),
        "source": hr.get("source"),
    }


def rms_of(last):
    """RMS µV of the last ``eeg`` frame, one value per channel."""
    eeg = last.get("eeg") or {}
    rows = eeg.get("x") if isinstance(eeg.get("x"), list) else []
    out = []
    for index in range(len(CHANNELS)):
        row = rows[index] if index < len(rows) and isinstance(rows[index], list) else []
        picks = [v * v for v in row
                 if isinstance(v, (int, float)) and not isinstance(v, bool)]
        out.append((sum(picks) / len(picks)) ** 0.5 if picks else 0.0)
    return out


def features_of(last, eeg_hz=None):
    """The SSE ``features`` body shared by live streams and replays."""
    return {
        "bands": bands_of(last),
        "contact": hsi_of(last),
        "arousal": arousal_of(last),
        "hr": hr_of(last),
        "eeg_hz": number(eeg_hz),
    }


class RelayHub:
    """Keeps the latest state per sharer and multicasts frames to subscribers."""

    def __init__(self, url=DEFAULT_RELAY, on_frame=None):
        self.url = url
        self.on_frame = on_frame
        self.connected = False
        self.frames = 0
        self.last_frame_ts = None
        self.reconnects = 0
        self.bad_frames = 0
        self.unknown_frames = 0
        self.aggregate = None
        self._unknown_seen = set()
        self._state = {}                       # pseudonym -> sharer state
        self._subs = {}                        # pseudonym -> set[asyncio.Queue]

    # ------------------------------------------------------------------ wiring
    def _emit_frame(self, pseudonym, frame):
        if self.on_frame is None:
            return
        try:
            self.on_frame(pseudonym, frame)
        except Exception as exc:               # never break the socket loop
            log.warning("on_frame hook failed: %r", exc)

    # --------------------------------------------------------------- state keys
    def _ensure(self, pseudonym):
        state = self._state.get(pseudonym)
        if state is None:
            state = {
                "pseudonym": pseudonym,
                "name": None,
                "device": None,
                "tier": None,
                "since": None,
                "last": {},
                "eeg_hz": None,
                "last_eeg_ts": None,
            }
            self._state[pseudonym] = state
        return state

    def _seed_person(self, person):
        pseudonym = person.get("pseudonym")
        if not isinstance(pseudonym, str) or not pseudonym:
            return
        if person.get("tier") == "camera" or person.get("kind") == "camera":
            return
        state = self._ensure(pseudonym)
        state["name"] = person.get("name")
        state["device"] = person.get("device")
        state["tier"] = person.get("tier")
        state["since"] = person.get("since")
        last = person.get("last")
        if isinstance(last, dict):
            for key, value in last.items():
                if isinstance(value, dict):
                    state["last"][key] = value

    # ------------------------------------------------------------------ dispatch
    def handle_message(self, message):
        """Apply one decoded frame. Unknown types are logged once and dropped."""
        if not isinstance(message, dict):
            self.bad_frames += 1
            return
        kind = message.get("t")
        if not isinstance(kind, str):
            self.bad_frames += 1
            return
        pseudonym = message.get("pseudonym")
        if not isinstance(pseudonym, str) or not pseudonym:
            pseudonym = None

        if kind not in KNOWN_TYPES:
            self.unknown_frames += 1
            if kind not in self._unknown_seen:
                self._unknown_seen.add(kind)
                log.warning("relay sent unknown frame type %r; dropping it", kind)
            return

        self.frames += 1
        self.last_frame_ts = time.time()

        if kind == "snapshot":
            for person in message.get("people") or []:
                if isinstance(person, dict):
                    self._seed_person(person)
        elif kind == "aggregate":
            self.aggregate = message
        elif kind == "leave":
            if pseudonym:
                self._multicast(pseudonym, message)
                self._state.pop(pseudonym, None)
        elif pseudonym:
            state = self._ensure(pseudonym)
            if kind == "eeg":
                self._apply_eeg(state, message)
            else:
                state["last"][kind] = message
                if kind == "device":
                    state["device"] = message
                elif kind == "profile":
                    state["name"] = message.get("name") or state["name"]
            self._multicast(pseudonym, message)
        self._emit_frame(pseudonym or GLOBAL_PSEUDONYM, message)

    def _apply_eeg(self, state, message):
        rows = message.get("x")
        if not isinstance(rows, list):
            return
        state["last"]["eeg"] = message
        # fs is per channel: average the channel lengths, never their sum
        widths = [len(row) for row in rows if isinstance(row, list)]
        per_channel = sum(widths) / len(widths) if widths else 0
        now = time.time()
        previous = state["last_eeg_ts"]
        if previous is not None and now > previous and per_channel:
            hz = per_channel / (now - previous)
            current = state["eeg_hz"]
            state["eeg_hz"] = hz if current is None else (0.2 * hz + 0.8 * current)
        state["last_eeg_ts"] = now

    # ------------------------------------------------------------------ fan-out
    def subscribe(self, pseudonym):
        queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self._subs.setdefault(pseudonym, set()).add(queue)
        return queue

    def unsubscribe(self, pseudonym, queue):
        subs = self._subs.get(pseudonym)
        if not subs:
            return
        subs.discard(queue)
        if not subs:
            self._subs.pop(pseudonym, None)

    def _multicast(self, pseudonym, message):
        subs = self._subs.get(pseudonym)
        if not subs:
            return
        for queue in list(subs):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()         # drop the oldest, never block
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(message)
                except asyncio.QueueFull:
                    pass

    # ------------------------------------------------------------ public views
    def _sharer(self, state, with_rms=False):
        since = number(state.get("since"))
        now = time.time()
        last = state["last"]
        out = {
            "pseudonym": state["pseudonym"],
            "name": state.get("name"),
            "device": state.get("device"),
            "tier": state.get("tier"),
            "since": since,
            "hsi": hsi_of(last),
            "bands": bands_of(last),
            "arousal": arousal_of(last),
            "hr": hr_of(last),
            "eeg_hz": number(state.get("eeg_hz")),
            "age_s": max(0.0, now - since / 1000.0) if since is not None else None,
        }
        if with_rms:
            out["rms"] = rms_of(last)
        return out

    def sharers(self):
        return [self._sharer(s) for s in sorted(self._state.values(),
                                                key=lambda s: s["pseudonym"])]

    def osc_state(self):
        """The sharer projection plus per-channel RMS, for the OSC emitter."""
        return {"sharers": [self._sharer(s, with_rms=True)
                            for s in sorted(self._state.values(),
                                            key=lambda s: s["pseudonym"])]}

    def has(self, pseudonym):
        return pseudonym in self._state

    def features(self, pseudonym):
        """The SSE ``features`` payload for a known sharer, else None."""
        state = self._state.get(pseudonym)
        if state is None:
            return None
        return features_of(state["last"], state.get("eeg_hz"))

    def eeg_hz(self, pseudonym):
        state = self._state.get(pseudonym)
        return number(state.get("eeg_hz")) if state else None

    # ------------------------------------------------------------------ transport
    async def run(self):
        """Connect, read frames, reconnect forever with jittered backoff."""
        backoff = 1.0
        while True:
            try:
                timeout = aiohttp.ClientTimeout(total=None, sock_connect=30)
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.ws_connect(self.url, heartbeat=30,
                                                  max_msg_size=0) as ws:
                        self.connected = True
                        self.reconnects += 1
                        backoff = 1.0
                        log.info("relay connected: %s", self.url)
                        async for message in ws:
                            if message.type == aiohttp.WSMsgType.TEXT:
                                try:
                                    payload = json.loads(message.data)
                                except ValueError:
                                    self.bad_frames += 1
                                    continue
                                self.handle_message(payload)
                            elif message.type == aiohttp.WSMsgType.ERROR:
                                break
                            else:
                                break       # CLOSE / CLOSED / CLOSING / binary
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("relay connection failed: %r", exc)
            finally:
                self.connected = False

            delay = min(30.0, backoff) * (1 + random.uniform(-0.1, 0.1))
            log.info("relay reconnect in %.1fs", delay)
            await asyncio.sleep(delay)
            backoff = min(30.0, backoff * 2)

    def status(self):
        return {
            "url": self.url,
            "connected": self.connected,
            "frames": self.frames,
            "last_frame_ts": self.last_frame_ts,
        }
