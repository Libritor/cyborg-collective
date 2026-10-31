# collective-api

HTTP/JSON + SSE access to the Collective's brain data, from one process:

- the **recorded catalogue** in `data/` (sessions, devices, plus a `patch`
  projection meant to be turned into sound),
- the **live relay** (`wss://cyborg-collective-relay.onrender.com/live`),
  re-published as JSON and as two SSE streams,
- an **OSC/UDP feed** of the same live features, for
  `osc_cc_bridge.py` → IAC Driver → Ableton Live,
- **local JSONL captures** of every frame the relay sent, replayable over SSE.

The static page (`index.html`, `app.js`) is untouched: this is a separate
service, not a build step.

## Run

```bash
python3 -m pip install -r api/requirements.txt      # aiohttp only
python3 api/server.py                               # http://127.0.0.1:8787
```

Frames are recorded to `api/data/captures/` (gitignored) while the service
runs. Useful flags:

```bash
python3 api/server.py --port 8787 --osc 127.0.0.1:5000        # + OSC/UDP
python3 api/server.py --osc 127.0.0.1:5000 --osc-sharer russet-grebe-53
python3 api/server.py --no-relay                              # catalogue only, /live/* -> 503
python3 api/server.py --no-capture --captures /tmp/cc         # no recording / elsewhere
python3 api/server.py --relay ws://127.0.0.1:8790/live        # another relay
```

`python3 api/test_pipeline.py` proves the whole path (fake relay → hub →
capture → SSE replay → OSC datagrams) and prints `PASS <n> assertions`.

## Endpoints

Everything lives under `/api/v1`, answers `application/json` with
`Access-Control-Allow-Origin: *`, and reports errors as `{"error": "..."}`
(`404` for unknown stamp/tag/capture/pseudonym, `503` when the relay is off,
`400` for a bad query parameter).

| Method | Path | Returns |
|---|---|---|
| GET | `/api/v1/health` | service, relay, catalogue, capture and OSC status |
| GET | `/api/v1/sessions` | `{total, limit, offset, rows}`; `limit` 1–500, `offset`, `usable_only`, `project`, `since`, `until` |
| GET | `/api/v1/sessions/{stamp}` | the index entry, each device carrying `detail` + `preview_url` |
| GET | `/api/v1/sessions/{stamp}/{tag}` | one device's full stored JSON |
| GET | `/api/v1/sessions/{stamp}/{tag}/patch` | the derived music projection (see below) |
| GET | `/api/v1/live/sharers` | who is streaming now, with hsi/bands/arousal/hr |
| GET | `/api/v1/live/{pseudonym}/eeg` | SSE raw EEG; `channels`, `decimate` (1–16) |
| GET | `/api/v1/live/{pseudonym}/features` | SSE band/contact/arousal/hr state |
| GET | `/api/v1/captures` | every local capture with frame counts |
| GET | `/api/v1/captures/{id}` | one capture entry |
| GET | `/api/v1/captures/{id}/eeg` | SSE replay; `speed` (0.1–100), `start`, `channels`, `decimate` |
| GET | `/api/v1/captures/{id}/features` | SSE replay of band/quality/arousal/hr frames |

```bash
curl -s localhost:8787/api/v1/health
curl -s 'localhost:8787/api/v1/sessions?limit=3&usable_only=1'
curl -s 'localhost:8787/api/v1/sessions?project=loose%20files&since=2025-01-01'
curl -s localhost:8787/api/v1/sessions/20251203_132222
curl -s localhost:8787/api/v1/sessions/20251203_132222/00_55_DA_B9_01_11
curl -s localhost:8787/api/v1/sessions/20251203_132222/00_55_DA_B9_01_11/patch
curl -s localhost:8787/api/v1/live/sharers
curl -s -N 'localhost:8787/api/v1/live/russet-grebe-53/eeg?channels=AF7,AF8&decimate=2'
curl -s -N localhost:8787/api/v1/live/russet-grebe-53/features
curl -s localhost:8787/api/v1/captures
curl -s localhost:8787/api/v1/captures/tester__20260101T000000
curl -s -N 'localhost:8787/api/v1/captures/tester__20260101T000000/eeg?speed=20'
curl -s -N 'localhost:8787/api/v1/captures/tester__20260101T000000/features?speed=20'
```

### Session rows

`/sessions` flattens each session to one row using its first `usable` device
(else its first device):

```json
{"stamp": "20251203_132222", "date": "2025-12-03T13:22:22", "minutes": 1.4,
 "project_folder": null, "source": "phone", "n_devices": 1, "usable": true,
 "duration_s": 84.921, "fs_hz": 258.03,
 "raw_rms_uv": {"TP9": 625.6, "AF7": 164.4, "AF8": 167.1, "TP10": 273.1},
 "clean_frac": {"TP9": 0.0, "AF7": 0.48, "AF8": 0.64, "TP10": 0.05},
 "bands": {"delta": {"TP9": 0.0, "AF7": 0.904, "AF8": 0.699, "TP10": 0.838}, "…": {}},
 "preview_url": "data/previews/20251203_132222__00_55_DA_B9_01_11.svg"}
```

`bands` are `bands_median` from the index (log10 µV²), `clean_frac` is
`clean_epoch_frac`, `fs_hz` is `fs_est`. A missing number is `null`; a device
without a preview file gets `preview_url: null`.

### `/patch`

The catalogue's only music-facing projection, strictly derived from stored
numbers:

```json
{"stamp": "20251203_132222", "tag": "00_55_DA_B9_01_11",
 "duration_s": 84.921, "fs_hz": 258.03,
 "contact": {"TP9": 0.0, "AF7": 0.476, "AF8": 0.643, "TP10": 0.048},
 "bands_log10": {"delta": {"TP9": 0.0, "AF7": 0.904, "AF8": 0.699, "TP10": 0.838}, "…": {}},
 "bands_norm": {"delta": {"TP9": 0.0, "AF7": 1.0, "AF8": 0.773, "TP10": 0.927}, "…": {}},
 "best_channel": {"delta": "AF7", "theta": "AF7", "alpha": "AF7", "beta": "TP10", "gamma": "TP10"}}
```

`bands_norm` divides each channel by that band's strongest channel (a band
whose maximum is `<= 0` becomes all zeros, and `best_channel` is then `null`).
Because log10 power is negative whenever the power is below 1 µV²,
`bands_norm` **can be negative** — it is a share of the strongest channel, not
a 0–1 value. Clamp in the player if you need a unipolar control.

## SSE

Both stream routes emit `data: <json>\n\n` per event and a `: keepalive`
comment every 15 s.

Live EEG (`/live/{pseudonym}/eeg`):

```json
{"t": "hello", "pseudonym": "russet-grebe-53", "fs": 128.0, "channels": ["AF7", "AF8"], "decimate": 2}
{"t": "eeg", "pseudonym": "russet-grebe-53", "ts": 1793414821927, "seq": 42,
 "fs": 128.0, "channels": ["AF7", "AF8"], "unit": "uV",
 "x": [[128 floats], [128 floats]]}
```

`x` follows the order of `channels`; `decimate` keeps every n-th sample and
`fs` is the reported (decimated) rate. A sample with no value is `null`.

Live and replayed features (`/live/{pseudonym}/features`,
`/captures/{id}/features`):

```json
{"t": "features", "pseudonym": "russet-grebe-53", "ts": 1793414821927,
 "bands": {"rel": {"delta": [4 floats or null], "theta": [], "alpha": [], "beta": [], "gamma": []},
           "abs": {"delta": [], "theta": [], "alpha": [], "beta": [], "gamma": []}},
 "contact": {"TP9": 1, "AF7": 2, "AF8": null, "TP10": 1},
 "arousal": {"index": 0.61, "label": "alert", "confidence": 0.8, "quality": 0.72, "reason": ""},
 "hr": {"ok": true, "bpm": 68.0, "rmssd_ms": 41.0, "sdnn_ms": 55.0, "beats": 11, "source": "polar"},
 "eeg_hz": 256.0}
```

`contact` is the headband's hsi code per channel (1 good … 4 poor, `null` = no
data). `null` band values mean that channel was not in contact. Replays pace
themselves from the recorded receive times (`speed=50` finishes a short capture
promptly; a gap never stalls longer than 5 s), and `start=<n>` skips the first n
frames of the stream.

## OSC (→ Ableton)

With `--osc HOST:PORT` every merged state update sends these datagrams (all
float32 args, one message each):

| Address | Args |
|---|---|
| `/eeg/bands` | 5 — delta…gamma, mean over channels in contact, relative power |
| `/eeg/bands/abs` | 5 — same reduction, absolute power |
| `/eeg/contact` | 4 — TP9, AF7, AF8, TP10 mapped hsi 1→1.0, 2→0.5, 3→0.25, 4→0.0 |
| `/eeg/alpha` | 1 — the alpha element of `/eeg/bands` (single-CC convenience) |
| `/eeg/arousal` | 1 — activation index, `0.0` when there is no claim |
| `/eeg/hr` | 1 — bpm while beats are detected, else `0.0` |
| `/eeg/rms` | 4 — RMS µV of the last raw frame, per channel |

Wiring, end to end:

1. `python3 api/server.py --osc 127.0.0.1:5000`
2. `python3 osc_cc_bridge.py` from `Projects/20260805_BallToSound` — it listens
   on UDP 5000 (`DEFAULT_UDP_PORT`) and maps one `(OSC address, vector index)`
   rule to one MIDI `(channel, CC)`, sending on `IAC Driver Bus 1`
   (`DEFAULT_MIDI_PORT`). Add rules in its UI, e.g. `/eeg/alpha` index 0 → CC 1,
   `/eeg/bands` index 1 (theta) → CC 2.
3. In Live: Preferences → Link/Tempo/MIDI → enable **Track** and **Remote** on
   the IAC port, then map the incoming CC to any parameter.

`/eeg/bands` is one message carrying five floats, so several bands can drive
several CCs from a single rule set; `--osc-sharer` picks which sharer feeds it
(default: the first one streaming).

## Captures

The relay keeps raw streams (`/record` lists `<id>.jsonl`, 38063 messages at
the time of writing) but exposes **no download route** — `/record/<file>`,
`/kept/<file>`, `/files/<file>`, `/download/<file>` and
`/record/file/<file>` all 404. Raw history therefore has to be captured while
it is live, which is what this service does: one JSONL per pseudonym,
`{"recv_ts": <epoch seconds>, "frame": <upstream frame verbatim>}`, rotated at
64 MiB, in `api/data/captures/` (gitignored). Frames without a pseudonym
(`snapshot`, `aggregate`) are recorded under `_relay`.

```json
{"id": "russet-grebe-53__20261031T032403", "file": "russet-grebe-53__20261031T032403.jsonl",
 "bytes": 16045801, "started_at": "2026-10-31T03:24:03+00:00",
 "frames": 38063, "eeg_frames": 36000, "sharers": ["russet-grebe-53"]}
```

A raw-tier sharer is roughly 16 MB/hour; `api/data/` is gitignored so captures
never enter the repository.

## Layout

| File | Job |
|---|---|
| `server.py` | aiohttp app, routes, CLI, wiring |
| `catalogue.py` | `data/index.json` + `data/sessions/` reader |
| `relay.py` | upstream WebSocket client, per-sharer state, fan-out, projections |
| `capture.py` | JSONL writer/list/read |
| `osc.py` | hand-rolled OSC encoding + UDP sender (`python-osc` not required) |
| `test_pipeline.py` | end-to-end proof over a local fake relay |
