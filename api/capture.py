"""Local JSONL capture of every relay frame, plus readers for replay.

The relay keeps raw streams server-side but exposes no download route, so the
only way to own the history is to record it while it arrives:

    {"recv_ts": 1793414821.927, "frame": {...upstream frame verbatim...}}

One file per pseudonym, rotated past ``rotate_bytes`` (a raw-tier sharer is
roughly 16 MB/hour). Two bounds matter for a long-running service:

* at most ``max_open`` file handles are kept open (least-recently-written is
  closed first), so a relay that churns pseudonyms cannot exhaust descriptors;
* summaries are counted incrementally -- a growing file is only re-read from the
  byte where the last scan stopped -- so ``/captures`` stays cheap without ever
  reporting a stale frame count.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")
_SAFE = re.compile(r"[A-Za-z0-9._-]+")
THROTTLE_SECONDS = 2.0   # a warning may repeat at most this often
MAX_OPEN_FILES = 32      # open capture handles; older ones are closed (not deleted)
RESUME_MEMORY = 512      # evicted paths remembered so a capture is never split

# path -> {"pos", "frames", "eeg", "sharers", "started"}; guarded by _CACHE_LOCK
_CACHE = {}
_CACHE_LOCK = threading.Lock()


def utc_stamp(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y%m%dT%H%M%S")


def _iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


def sanitize(pseudonym):
    return _UNSAFE.sub("_", str(pseudonym or "unknown")).strip("._") or "unknown"


def _base_name(pseudonym, when):
    """A filename that is safe and unambiguous: altered pseudonyms keep a digest."""
    safe = sanitize(pseudonym)
    label = str(pseudonym)
    if safe != label:                       # 'a b' and 'a_b' must not collide
        safe = f"{safe}-{hashlib.sha1(label.encode('utf-8')).hexdigest()[:8]}"
    return f"{safe}__{utc_stamp(when)}"


class CaptureWriter:
    """Append-only JSONL writer: one file per pseudonym, bounded open handles.

    Closing a handle never splits a capture: the file's path is remembered, so a
    sharer whose handle was evicted resumes appending to the same file. A new
    file is only minted on first sight or when ``rotate_bytes`` is passed.
    """

    def __init__(self, path, rotate_bytes=64 * 1024 * 1024, max_open=MAX_OPEN_FILES):
        self.dir = Path(path)
        self.rotate_bytes = int(rotate_bytes)
        self.max_open = max(1, int(max_open))
        self._files = OrderedDict()        # pseudonym -> {"fh", "bytes", "path"}
        self._closed = OrderedDict()       # pseudonym -> {"path", "bytes"}, bounded
        self.written = 0
        self.failed = 0
        self.rejected = 0                  # frames with non-finite numbers
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

    def _remember(self, pseudonym, path, size):
        self._closed[pseudonym] = {"path": path, "bytes": size}
        self._closed.move_to_end(pseudonym)
        while len(self._closed) > RESUME_MEMORY:
            self._closed.popitem(last=False)

    def _close_one(self, pseudonym):
        entry = self._files.pop(pseudonym, None)
        if entry is None:
            return
        try:
            size = entry["fh"].tell()
            entry["fh"].close()
        except OSError:
            size = entry["bytes"]
        self._remember(pseudonym, entry["path"], size)

    def _admit(self, pseudonym, entry):
        while len(self._files) >= self.max_open:
            self._close_one(next(iter(self._files)))   # least recently written
        self._files[pseudonym] = entry
        return entry

    def _new_file(self, pseudonym):
        self._closed.pop(pseudonym, None)             # rotation: start afresh
        self._close_one(pseudonym)
        self.dir.mkdir(parents=True, exist_ok=True)
        base = _base_name(pseudonym, time.time())
        path = self.dir / f"{base}.jsonl"
        n = 1
        while path.exists():                          # same second: never clobber
            path = self.dir / f"{base}-{n}.jsonl"
            n += 1
        handle = path.open("a", encoding="utf-8")
        return self._admit(pseudonym, {"fh": handle, "bytes": 0, "path": path})

    def _resume(self, pseudonym):
        remembered = self._closed.pop(pseudonym, None)
        if remembered is not None:
            try:
                handle = remembered["path"].open("a", encoding="utf-8")
            except OSError:
                handle = None
            if handle is not None:
                try:
                    size = handle.tell()
                except OSError:
                    size = remembered["bytes"]
                return self._admit(pseudonym, {"fh": handle, "bytes": size,
                                               "path": remembered["path"]})
        return self._new_file(pseudonym)

    # ----------------------------------------------------------------------- API
    def paths(self):
        """The files currently open, for logging and tests."""
        return [entry["path"] for entry in self._files.values()]

    def write(self, pseudonym, frame):
        """Append one frame plus its receive time, then flush."""
        try:
            payload = {"recv_ts": time.time(), "frame": frame}
            try:
                # allow_nan=False keeps the archive valid JSON: a frame carrying
                # inf/nan would be written as `Infinity` and poison every reader
                line = json.dumps(payload, ensure_ascii=False, allow_nan=False,
                                  separators=(",", ":")) + "\n"
            except ValueError:
                self.rejected += 1
                self._log_error("dropped a frame containing non-finite numbers")
                return
            entry = self._files.get(pseudonym)
            if entry is None:
                entry = self._resume(pseudonym)
            elif entry["bytes"] >= self.rotate_bytes:
                entry = self._new_file(pseudonym)
            else:
                self._files.move_to_end(pseudonym)
            handle = entry["fh"]
            handle.write(line)
            handle.flush()
            entry["bytes"] += len(line.encode("utf-8"))
            self.written += 1
        except (OSError, TypeError, ValueError, OverflowError) as exc:
            self.failed += 1
            self._close_one(pseudonym)
            self._log_error(f"capture write failed: {exc}")

    def close(self):
        for pseudonym in list(self._files):
            self._close_one(pseudonym)


def parse_line(raw):
    """One archive line -> {"recv_ts", "frame"}, or None when unusable."""
    if not raw:
        return None
    try:
        entry = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(entry, dict):
        return None
    frame = entry.get("frame")
    recv_ts = entry.get("recv_ts")
    if not isinstance(frame, dict) or not isinstance(recv_ts, (int, float)):
        return None
    return {"recv_ts": float(recv_ts), "frame": frame}


def read_frames(path):
    """Yield {"recv_ts": float, "frame": {...}}, skipping malformed lines."""
    with Path(path).open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            entry = parse_line(line.strip())
            if entry is not None:
                yield entry


def _fresh_state():
    return {"pos": 0, "frames": 0, "eeg": 0, "sharers": set(), "started": None}


def _scan_append(path, state):
    """Count the complete lines appended since ``state['pos']``."""
    with path.open("rb") as fh:
        fh.seek(state["pos"])
        data = fh.read()
    end = data.rfind(b"\n")             # a half-written tail line is left for later
    if end < 0:
        return
    for raw in data[:end + 1].splitlines():
        entry = parse_line(raw)
        if entry is None:
            continue
        state["frames"] += 1
        if state["started"] is None:
            state["started"] = entry["recv_ts"]
        frame = entry["frame"]
        if frame.get("t") == "eeg":
            state["eeg"] += 1
        pseudonym = frame.get("pseudonym")
        if isinstance(pseudonym, str) and pseudonym:
            state["sharers"].add(pseudonym)
    state["pos"] += end + 1


def _summary(path):
    """One capture summary, counted incrementally and never served stale."""
    name = str(path)
    with _CACHE_LOCK:
        try:
            stat = path.stat()
        except OSError:
            return None
        state = _CACHE.get(name)
        if state is None or stat.st_size < state["pos"]:
            state = _fresh_state()      # new file, or truncated and rewritten
        if stat.st_size > state["pos"]:
            try:
                _scan_append(path, state)
            except OSError:
                return None
        _CACHE[name] = state
        started = state["started"]
        return {
            "id": path.stem,
            "file": path.name,
            "bytes": stat.st_size,
            "started_at": _iso(started if started is not None else stat.st_mtime),
            "frames": state["frames"],
            "eeg_frames": state["eeg"],
            "sharers": sorted(state["sharers"]),
        }


def list_captures(directory):
    """One summary per ``*.jsonl`` in ``directory``, sorted by file name."""
    d = Path(directory)
    paths = sorted(d.glob("*.jsonl")) if d.is_dir() else []
    entries = [summary for summary in (_summary(path) for path in paths)
               if summary is not None]
    live = {str(path) for path in paths}
    with _CACHE_LOCK:
        for name in [key for key in _CACHE
                     if Path(key).parent == d and key not in live]:
            _CACHE.pop(name, None)
    return entries


def capture_path(directory, capture_id):
    if not _SAFE.fullmatch(str(capture_id) or ""):
        return None
    path = Path(directory) / f"{capture_id}.jsonl"
    return path if path.is_file() else None


def find_capture(directory, capture_id):
    """The summary for one capture id, or None -- without scanning the others."""
    path = capture_path(directory, capture_id)
    return None if path is None else _summary(path)
