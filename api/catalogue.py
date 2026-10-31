"""Catalogue reader: the recorded sessions in ``data/``, flattened for the API.

The repo carries the catalogue as ``data/index.json`` (one entry per session,
each with one or more ``devices``) plus the full per-device JSON under
``data/sessions/`` and an SVG preview per device under ``data/previews/``.

Two device-file layouts exist and both are used:

    data/sessions/{stamp}__{tag}.json   743 devices
    data/sessions/{stamp}.json          499 devices

``device()`` tries the tagged file first, then the stamp-only file.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# repo root: the directory that contains data/
CATALOGUE_ROOT = Path(__file__).resolve().parent.parent

CHANNELS = ["TP9", "AF7", "AF8", "TP10"]
BANDS = ["delta", "theta", "alpha", "beta", "gamma"]

_SAFE = re.compile(r"[A-Za-z0-9._-]+")


def number(value):
    """A JSON number, or None for anything else (bool, str, null)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def _per_channel(mapping):
    """{channel: number} reduced to exactly CHANNELS, missing -> None."""
    if not isinstance(mapping, dict):
        return {ch: None for ch in CHANNELS}
    return {ch: number(mapping.get(ch)) for ch in CHANNELS}


class Catalogue:
    """Read-only view over ``data/``. Safe to share between handlers."""

    def __init__(self, root):
        self.root = Path(root)
        self.index_path = self.root / "data" / "index.json"
        if not self.index_path.is_file():
            raise FileNotFoundError(f"catalogue index not found: {self.index_path}")
        with self.index_path.open("r", encoding="utf-8") as fh:
            index = json.load(fh)
        self.built = index.get("built")
        self._sessions = {}
        self._device_count = 0
        for session in index.get("sessions") or []:
            stamp = session.get("stamp")
            if not stamp:
                continue
            self._sessions[stamp] = session
            self._device_count += len(session.get("devices") or [])
        self._rows = None

    # ---------------------------------------------------------------- helpers
    def _preview_url(self, device):
        preview = device.get("preview")
        if isinstance(preview, str) and preview.strip():
            return f"data/previews/{preview}"
        return None

    @staticmethod
    def _pick_device(session):
        devices = session.get("devices") or []
        if not devices:
            return {}
        for device in devices:
            if device.get("usable") is True:
                return device
        return devices[0]

    def _flat_row(self, session):
        device = self._pick_device(session)
        bands_median = device.get("bands_median")
        bands = {}
        for band in BANDS:
            source = bands_median.get(band) if isinstance(bands_median, dict) else None
            bands[band] = _per_channel(source)
        return {
            "stamp": session.get("stamp"),
            "date": session.get("date"),
            "minutes": number(session.get("minutes")),
            "project_folder": session.get("project_folder"),
            "source": session.get("source"),
            "n_devices": session.get("n_devices"),
            "usable": device.get("usable"),
            "duration_s": number(device.get("duration_s")),
            "fs_hz": number(device.get("fs_est")),
            "raw_rms_uv": _per_channel(device.get("raw_rms_uv")),
            "clean_frac": _per_channel(device.get("clean_epoch_frac")),
            "bands": bands,
            "preview_url": self._preview_url(device),
        }

    def _load_device_file(self, stamp, tag=None):
        """The parsed device JSON, or None when neither file layout exists."""
        names = []
        if tag and _SAFE.fullmatch(str(tag)):
            names.append(f"{stamp}__{tag}.json")
        if _SAFE.fullmatch(str(stamp)):
            names.append(f"{stamp}.json")
        for name in names:
            path = self.root / "data" / "sessions" / name
            if path.is_file():
                try:
                    with path.open("r", encoding="utf-8") as fh:
                        return json.load(fh)
                except (OSError, ValueError):
                    return None
        return None

    # ------------------------------------------------------------------- API
    def stats(self):
        return {"sessions": len(self._sessions), "devices": self._device_count}

    def rows(self):
        """Every session flattened to one row, newest first. Treat as read-only."""
        if self._rows is None:
            rows = [self._flat_row(s) for s in self._sessions.values()]
            rows.sort(key=lambda r: (r["date"] or "", r["stamp"] or ""), reverse=True)
            self._rows = rows
        return self._rows

    def query(self, limit=50, offset=0, usable_only=False, project=None, since=None, until=None):
        """Filtered window over ``rows()`` plus the pre-window total."""
        rows = self.rows()
        if usable_only:
            rows = [r for r in rows if r["usable"] is True]
        if project:
            wanted = project.strip().casefold()
            rows = [r for r in rows
                    if isinstance(r["project_folder"], str)
                    and r["project_folder"].casefold() == wanted]
        if since:
            rows = [r for r in rows if (r["date"] or "")[:10] >= since]
        if until:
            rows = [r for r in rows if (r["date"] or "")[:10] <= until]
        total = len(rows)
        start = max(0, int(offset))
        return rows[start:start + limit], total

    def session(self, stamp):
        """Index entry with per-device ``detail`` and ``preview_url``."""
        session = self._sessions.get(stamp)
        if session is None:
            return None
        out = dict(session)
        devices = []
        for device in session.get("devices") or []:
            row = dict(device)
            row["detail"] = self._load_device_file(stamp, device.get("tag"))
            row["preview_url"] = self._preview_url(device)
            devices.append(row)
        out["devices"] = devices
        return out

    def device(self, stamp, tag):
        """One device's full JSON with ``preview_url``; None when no file matches."""
        if stamp not in self._sessions:     # no probing for files outside the index
            return None
        raw = self._load_device_file(stamp, tag)
        if raw is None:
            return None
        out = dict(raw)
        out["preview_url"] = self._preview_url(raw)
        return out

    def has_stamp(self, stamp):
        return stamp in self._sessions
