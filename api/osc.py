"""OSC/UDP emitter: brain features as float messages for a MIDI-CC bridge.

``python-osc`` is not a dependency of this service, so the encoding is done by
hand -- it is four lines of ``struct``. The addresses match what
``osc_cc_bridge.py`` (Projects/20260805_BallToSound) consumes: one datagram per
address, all-float arguments, indexed with ``(address, index)`` rules.
"""

from __future__ import annotations

import errno
import math
import socket
import struct
import time

from catalogue import BANDS, CHANNELS, OPTIC_SITES

HSI_CONTACT = {1: 1.0, 2: 0.5, 3: 0.25, 4: 0.0}


def _osc_string(text):
    data = text.encode("utf-8")
    pad = 4 - (len(data) % 4)
    return data + b"\0" * pad


def encode_message(address, floats):
    """One OSC message: address, ",fff..." typetag, big-endian float32 args."""
    if not address.startswith("/"):
        raise ValueError(f"OSC address must start with '/': {address!r}")
    body = b"".join(struct.pack(">f", float(v)) for v in floats)
    return _osc_string(address) + _osc_string("," + "f" * len(floats)) + body


def _as_float(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _contact_code(hsi):
    try:
        return int(hsi)
    except (TypeError, ValueError):
        return None


def _band_mean(values, hsi):
    """Mean over the channels in contact (hsi 1 or 2); 0.0 when none are."""
    picks = []
    for channel, value in zip(CHANNELS, values or []):
        number = _as_float(value)
        if number is None:
            continue
        if hsi.get(channel) in (1, 2):
            picks.append(number)
    return sum(picks) / len(picks) if picks else 0.0


def _band_vector(bands, hsi):
    out = []
    for band in BANDS:
        per_band = (bands or {}).get(band) or []
        out.append(_band_mean(per_band, hsi))
    return out


def _contact_vector(hsi):
    out = []
    for channel in CHANNELS:
        code = _contact_code(hsi.get(channel))
        out.append(HSI_CONTACT.get(code, 0.0))
    return out


def _flag(block, key):
    return 1.0 if (block or {}).get(key) else 0.0


def _active(block, key):
    return _as_float((block or {}).get(key)) or 0.0


def _aux_contact(aux, key):
    """One aux electrode as 1.0..0.0, reusing the hsi -> contact table."""
    entry = aux.get(key)
    code = _contact_code(entry.get("hsi")) if isinstance(entry, dict) else None
    return HSI_CONTACT.get(code, 0.0)


class OscEmitter:
    """Sends the feature set of one sharer to ``host:port`` over UDP."""

    def __init__(self, host, port, sharer="any"):
        self.host = host
        self.port = int(port)
        self.sharer = sharer or "any"
        self.sent = 0
        self.frames = 0
        self.errors = 0
        self.dropped = 0
        self._last_error_log = 0.0
        self._on_error = None
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setblocking(False)
        try:
            # resolve once: a hostname here would cost a getaddrinfo per datagram,
            # on the event loop, and a slow resolver would freeze every stream
            self._addr = socket.getaddrinfo(self.host, self.port, 0,
                                            socket.SOCK_DGRAM)[0][4]
        except OSError as exc:
            self._sock.close()
            raise OSError(f"cannot resolve {self.host}:{self.port}: {exc}") from exc

    @property
    def target(self):
        return f"{self.host}:{self.port}"

    def set_error_logger(self, fn):
        self._on_error = fn

    def _log_error(self, message):
        now = time.time()
        if self._on_error and now - self._last_error_log >= 2.0:
            self._last_error_log = now
            self._on_error(message)

    def close(self):
        try:
            self._sock.close()
        except OSError:
            pass

    def _pick(self, state):
        sharers = (state or {}).get("sharers") or []
        if not sharers:
            return None
        if self.sharer == "any":
            return sharers[0]
        for sharer in sharers:
            if sharer.get("pseudonym") == self.sharer:
                return sharer
        return None

    def emit(self, state):
        """Send every message for the chosen sharer; returns the datagram count."""
        sharer = self._pick(state)
        if sharer is None:
            return 0
        hsi = sharer.get("hsi") or {}
        bands = sharer.get("bands") or {}
        rel = _band_vector(bands.get("rel"), hsi)
        abs_ = _band_vector(bands.get("abs"), hsi)
        arousal = sharer.get("arousal") or {}
        index = _as_float(arousal.get("index"))
        if arousal.get("label") == "no_claim":
            index = None
        hr = sharer.get("hr") or {}
        bpm = _as_float(hr.get("bpm")) if hr.get("ok") else None
        rms = [_as_float(v) or 0.0 for v in (sharer.get("rms") or [])][:4]
        rms += [0.0] * (4 - len(rms))

        valid = sharer.get("valid") or {}
        imu = sharer.get("imu") or {}
        optics = sharer.get("optics") or {}
        raw_accel = (imu.get("accel") or [])[:3]
        raw_accel += [None] * (3 - len(raw_accel))
        gyro = [(_as_float(v) or 0.0) for v in (imu.get("gyro") or [])][:3]
        gyro += [0.0] * (3 - len(gyro))
        accel = [(_as_float(v) or 0.0) for v in raw_accel]
        has_accel = all(_as_float(v) is not None for v in raw_accel)
        motion = abs(math.sqrt(sum(v * v for v in accel)) - 1.0) if has_accel else 0.0
        aux = [_aux_contact(sharer.get("aux") or {}, key) for key in ("AUX_L", "AUX_R")]
        sites = optics.get("sites") or {}
        ratio = [_as_float((sites.get(name) or {}).get("ratio")) or 0.0 for name in OPTIC_SITES]

        messages = [
            ("/eeg/bands", rel),
            ("/eeg/bands/abs", abs_),
            ("/eeg/contact", _contact_vector(hsi)),
            ("/eeg/alpha", [rel[2]]),
            ("/eeg/arousal", [index if index is not None else 0.0]),
            ("/eeg/hr", [bpm if bpm is not None else 0.0]),
            ("/eeg/rms", rms),
            ("/eeg/bands/valid", [_flag(valid, "bands")]),
            ("/eeg/arousal/valid", [_flag(valid, "arousal")]),
            ("/eeg/hr/valid", [_flag(valid, "hr")]),
            ("/eeg/aux", aux),
            ("/imu/gyro", gyro),
            ("/imu/accel", accel),
            ("/imu/motion", [motion]),
            ("/optics/ratio", ratio),
            ("/optics/r730", [_active(sites.get(name) or {}, "r730") for name in OPTIC_SITES]),
            ("/optics/r850", [_active(sites.get(name) or {}, "r850") for name in OPTIC_SITES]),
            ("/optics/valid", [1.0 if any(_as_float((sites.get(name) or {}).get("ratio"))
                                          is not None for name in OPTIC_SITES) else 0.0]),
        ]
        count = 0
        for address, values in messages:
            try:
                self._sock.sendto(encode_message(address, values), self._addr)
                count += 1
            except OSError as exc:
                if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.ENOBUFS):
                    # UDP is lossy by nature: a full send buffer is a dropped
                    # datagram, not a fault worth warning about every tick
                    self.dropped += 1
                else:
                    self.errors += 1
                    self._log_error(f"osc send failed for {address}: {exc}")
        self.sent += count
        self.frames += 1
        return count
