"""Local JSONL capture of every relay frame, plus readers for replay.

The relay keeps raw streams server-side but exposes no download route, so the
only way to own the history is to record it while it arrives:

    {"recv_ts": 1793414821.927, "frame": {...upstream frame verbatim...}}

One file per pseudonym, kept open and rotated when that file passes
``rotate_bytes`` (a raw-tier sharer is roughly 16 MB/hour). Several sharers
stream at once, so the writer holds one handle each -- rotating on "the
pseudonym changed" would shred a capture into one file per interleaved frame.
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")
_SAFE = re.compile(r"[A-Za-z0-9._-]+")
THROTTLE_SECONDS = 2.0  # a warning may repeat at most this often


def utc_stamp(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y%m%dT%H%M%S")


def _iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


def sanitize(pseudonym):
    clean = _UNSAFE.sub("_", str(pseudonym or "unknown"))
    return clean.strip("._") or "unknown"


class CaptureWriter:
    """Append-only JSONL writer, one open file per pseudonym. Never raises."""

    def __init__(self, path, rotate_bytes=64 * 1024 * 1024):
        self.dir = Path(path)
        self.rotate_bytes = int(rotate_bytes)
        self._files = {}          # pseudonym -> {"fh": file, "bytes": int}
        self.written = 0
        self.failed = 0
        self._last_error_log = 0.0
        self._on_error = None

    # ------------------------------------------------------------------ internals
    def set_error_logger(self, fn):
        """fn(message) -> None, called at most once per THROTTLE_SECONDS."""
        self._on_error = fn

    def _log_error(self, message):
        now = time.time()
        if self._on_error and now - self._last_error_log >= THROTTLE_SECONDS:
            self._last_error_log = now
            self._on_error(message)

    def _open(self, pseudonym):
        self._close_one(pseudonym)
        self.dir.mkdir(parents=True, exist_ok=True)
        base = f"{sanitize(pseudonym)}__{utc_stamp(time.time())}"
        path = self.dir / f"{base}.jsonl"
        n = 1
        while path.exists():        # same second, same person: never clobber
            path = self.dir / f"{base}-{n}.jsonl"
            n += 1
        handle = path.open("a", encoding="utf-8")
        self._files[pseudonym] = {"fh": handle, "bytes": 0}
        return self._files[pseudonym]

    def _close_one(self, pseudonym):
        entry = self._files.pop(pseudonym, None)
        if entry is not None:
            try:
                entry["fh"].close()
            except OSError:
                pass

    # ----------------------------------------------------------------------- API
    def paths(self):
        """The files currently open, for logging."""
        return [Path(entry["fh"].name) for entry in self._files.values()]

    def write(self, pseudonym, frame):
        """Append one frame (plus its receive time) and flush."""
        try:
            entry = self._files.get(pseudonym)
            if entry is None or entry["bytes"] >= self.rotate_bytes:
                entry = self._open(pseudonym)
            line = json.dumps({"recv_ts": time.time(), "frame": frame},
                              ensure_ascii=False, separators=(",", ":")) + "\n"
            handle = entry["fh"]
            handle.write(line)
            handle.flush()
            entry["bytes"] += len(line.encode("utf-8"))
            self.written += 1
        except (OSError, TypeError, ValueError) as exc:
            self.failed += 1
            self._close_one(pseudonym)
            self._log_error(f"capture write failed: {exc}")

    def close(self):
        for pseudonym in list(self._files):
            self._close_one(pseudonym)


def read_frames(path):
    """Yield {"recv_ts": float, "frame": {...}}, skipping malformed lines."""
    with Path(path).open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue  # a truncated tail line is not fatal
            if not isinstance(entry, dict):
                continue
            frame = entry.get("frame")
            recv_ts = entry.get("recv_ts")
            if not isinstance(frame, dict) or not isinstance(recv_ts, (int, float)):
                continue
            yield {"recv_ts": float(recv_ts), "frame": frame}


def list_captures(directory):
    """One summary per ``*.jsonl`` in ``directory``, sorted by file name."""
    d = Path(directory)
    if not d.is_dir():
        return []
    out = []
    for path in sorted(d.glob("*.jsonl")):
        frames = eeg_frames = 0
        sharers = set()
        started = None
        try:
            for entry in read_frames(path):
                frames += 1
                if started is None:
                    started = entry["recv_ts"]
                frame = entry["frame"]
                if frame.get("t") == "eeg":
                    eeg_frames += 1
                pseudonym = frame.get("pseudonym")
                if isinstance(pseudonym, str) and pseudonym:
                    sharers.add(pseudonym)
            size = path.stat().st_size
        except OSError:
            continue
        if started is None:
            started = path.stat().st_mtime
        out.append({
            "id": path.stem,
            "file": path.name,
            "bytes": size,
            "started_at": _iso(started),
            "frames": frames,
            "eeg_frames": eeg_frames,
            "sharers": sorted(sharers),
        })
    return out


def find_capture(directory, capture_id):
    """The summary for one capture id, or None."""
    if not _SAFE.fullmatch(str(capture_id) or ""):
        return None
    name = f"{capture_id}.jsonl"
    path = Path(directory) / name
    if not path.is_file():
        return None
    for entry in list_captures(directory):
        if entry["file"] == name:
            return entry
    return None


def capture_path(directory, capture_id):
    if not _SAFE.fullmatch(str(capture_id) or ""):
        return None
    path = Path(directory) / f"{capture_id}.jsonl"
    return path if path.is_file() else None
