"""Local JSONL capture of every relay frame, plus readers for replay.

The relay keeps raw streams server-side but exposes no download route, so the
only way to own the history is to record it while it arrives:

    {"recv_ts": 1793414821.927, "frame": {...upstream frame verbatim...}}

One file per pseudonym, rotated when the pseudonym changes or the file passes
``rotate_bytes`` (a raw-tier sharer is roughly 16 MB/hour).
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
    """Append-only JSONL writer with rotation. Never raises into the socket loop."""

    def __init__(self, path, rotate_bytes=64 * 1024 * 1024):
        self.dir = Path(path)
        self.rotate_bytes = int(rotate_bytes)
        self._fh = None
        self._pseudonym = None
        self._bytes = 0
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
        self._close_file()
        self.dir.mkdir(parents=True, exist_ok=True)
        name = f"{sanitize(pseudonym)}__{utc_stamp(time.time())}.jsonl"
        path = self.dir / name
        if path.exists():  # same second, same person: do not clobber
            base = path.with_suffix("")
            n = 1
            while path.exists():
                path = base.with_name(f"{base.name}-{n}.jsonl")
                n += 1
        self._fh = path.open("a", encoding="utf-8")
        self._pseudonym = pseudonym
        self._bytes = 0

    def _close_file(self):
        if self._fh is not None:
            try:
                self._fh.close()
            except OSError:
                pass
        self._fh = None

    # ----------------------------------------------------------------------- API
    @property
    def path(self):
        return Path(self._fh.name) if self._fh is not None else None

    def write(self, pseudonym, frame):
        """Append one frame (plus its receive time) and flush."""
        try:
            if self._fh is None or pseudonym != self._pseudonym:
                self._open(pseudonym)
            elif self._bytes >= self.rotate_bytes:
                self._open(pseudonym)
            line = json.dumps({"recv_ts": time.time(), "frame": frame},
                              ensure_ascii=False, separators=(",", ":")) + "\n"
            self._fh.write(line)
            self._fh.flush()
            self._bytes += len(line.encode("utf-8"))
            self.written += 1
        except (OSError, TypeError, ValueError) as exc:
            self.failed += 1
            self._log_error(f"capture write failed: {exc}")

    def close(self):
        self._close_file()


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
    for entry in list_captures(directory):
        if entry["id"] == capture_id:
            return entry
    return None


def capture_path(directory, capture_id):
    if not _SAFE.fullmatch(str(capture_id) or ""):
        return None
    path = Path(directory) / f"{capture_id}.jsonl"
    return path if path.is_file() else None
