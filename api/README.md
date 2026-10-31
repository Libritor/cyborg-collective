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

## See it working without a sharer

The real relay usually has nobody streaming (`/stats` → `people: 0`), so there is
nothing to watch. `api/simulate.py` is a stand-in relay that speaks the same
WebSocket protocol — it is a separate process, nothing fake lives inside the
service:

```bash
python3 api/simulate.py --people 2                      # ws://127.0.0.1:8790/live
python3 api/server.py --relay ws://127.0.0.1:8790/live --osc 127.0.0.1:5000
```

Everything downstream is the real code path: live state, SSE fan-out, JSONL
capture and OSC all run exactly as they do against the Collective. The
synthetic signal is not noise — band powers drift on slow oscillators, the EEG
holds a 10 Hz alpha + 6 Hz theta mixture, heart rate breathes, and contact
quality wanders — so the numbers you see move the way a real sharer's would.

```bash
curl -s localhost:8787/api/v1/live/sharers
curl -N 'localhost:8787/api/v1/live/demo-01/eeg?decimate=8'
curl -N localhost:8787/api/v1/live/demo-01/features
curl -s localhost:8787/api/v1/captures          # one file per sharer, growing
```

To watch the OSC side without a listener stealing the port from Ableton:

```bash
python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('127.0.0.1', 5000))
while True: print(s.recvfrom(65535)[0][:24])"
```

## Endpoints

Everything lives under `/api/v1`, answers `application/json` with
`Access-Control-Allow-Origin: *`, and reports errors as `{"error": "..."}` —
an unknown path is a `404`, a wrong method is a `405`, an unhandled failure is
a `500`, all JSON. `404` marks an unknown stamp/tag/capture/pseudonym, `503`
means the relay is off, and `400` is a bad query parameter (including
impossible dates such as `2025-13-99`). `HEAD` is refused (`405`) on the four
stream routes: a stream has no meaningful body to probe.

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
data). `null` band values mean that channel was not in contact. `eeg_hz` is the
measured sample rate **per channel** (a 256 Hz band shows ~256, not 4 × 256).
Replays pace themselves from the recorded receive times (`speed=50` finishes a
short capture promptly; a gap never stalls longer than 5 s), and `start=<n>`
skips the first n frames of the stream.

When the sharer leaves (the relay sends `leave`), both live streams emit one
final `{"t": "bye", "pseudonym": ..., "reason": "left"}` and close, so a player
never sits on keepalives for someone who is gone. `/live/sharers` reports the
same fact as `stale_s` — seconds since that sharer's last frame — because
`age_s` is merely how long they have been sharing.

A `features` event is emitted once per incoming state frame — `bands`,
`quality`, `arousal`, `hr` — so a running stream produces several per upstream
tick, each carrying the current merged state. Clients that want one update per
tick should coalesce on `ts` (or just act on the latest).

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
several CCs from a single rule set. Exactly one sharer feeds OSC: `--osc-sharer
any` (the default) follows the lexicographically first pseudonym currently
known, and `--osc-sharer <pseudonym>` pins one; frames from anyone else emit
nothing, so two people streaming never fight over the same CC.

## Bounds

- **upstream frames**: at most 8 MiB each. A larger message is refused by the
  socket (which then reconnects) instead of being buffered — real `eeg` frames
  are about 10 KB.
- **state**: 2048 sharers at most; a relay that churns pseudonyms evicts the
  least recently heard (`snapshot` also prunes the roster).
- **streams**: a `/features` subscriber only receives `bands`/`quality`/
  `arousal`/`hr` frames and an `/eeg` subscriber only `eeg`, so a torrent of
  raw frames can neither waste memory nor evict the state a player needs.
- **replay**: paced from the recorded receive times and yields to the event
  loop every frame, so one full-speed replay cannot starve live SSE or the
  relay fan-out.

## Captures

The relay keeps raw streams (`/record` lists `<id>.jsonl`, 38063 messages at
the time of writing) but exposes **no download route** — `/record/<file>`,
`/kept/<file>`, `/files/<file>`, `/download/<file>` and
`/record/file/<file>` all 404. Raw history therefore has to be captured while
it is live, which is what this service does: one JSONL per pseudonym,
`{"recv_ts": <epoch seconds>, "frame": <upstream frame verbatim>}`, rotated at
64 MiB, in `api/data/captures/` (gitignored). Bounds that matter for a
long-running service:

- **handles**: at most 32 capture files are held open; the least-recently
  written is closed first (never deleted), and its path is remembered, so a
  sharer whose handle was evicted **resumes the same file**. A capture is only
  ever split by `rotate_bytes`, never by bookkeeping.
- **naming**: a pseudonym outside `[A-Za-z0-9._-]` is sanitised and keeps a
  short digest, so `a b` and `a_b` stay distinct files. Frames without a
  pseudonym (`snapshot`, `aggregate`) go to the `_relay` bucket, which lands as
  `relay-<digest>__<stamp>.jsonl`.
- **validity**: a frame carrying `inf`/`nan` (a relay may send `1e999`) is
  rejected instead of written, because `Infinity` would poison the archive for
  every JSON reader.

```json
{"id": "russet-grebe-53__20261031T032403", "file": "russet-grebe-53__20261031T032403.jsonl",
 "bytes": 16045801, "started_at": "2026-10-31T03:24:03+00:00",
 "frames": 38063, "eeg_frames": 36000, "sharers": ["russet-grebe-53"]}
```

A raw-tier sharer is roughly 16 MB/hour; `api/data/` is gitignored so captures
never enter the repository. Counting a capture's frames means reading every
line, so a summary is counted **incrementally**: the next scan resumes at the
byte where the last one stopped, a half-written tail line waits for the next
pass, and a truncated file is recounted from zero. Counts are therefore always
exact and a poll costs only what was appended. The scan runs off the event loop
(`asyncio.to_thread`) and `/captures/{id}` never touches the other captures.

**Who is "live"?** A `snapshot` from the relay is treated as its full roster, so
anyone absent from it is dropped — that is what clears a sharer who left while
the service was disconnected. While the socket is down, the last known state is
kept and `relay` reports `disconnected` (and `age_s` keeps growing), rather than
pretending the roster is current.

## Layout

| File | Job |
|---|---|
| `server.py` | aiohttp app, routes, CLI, wiring |
| `catalogue.py` | `data/index.json` + `data/sessions/` reader |
| `relay.py` | upstream WebSocket client, per-sharer state, fan-out, projections |
| `capture.py` | JSONL writer/list/read |
| `osc.py` | hand-rolled OSC encoding + UDP sender (`python-osc` not required) |
| `simulate.py` | stand-in relay: synthetic sharers over the real protocol, for demos |
| `test_pipeline.py` | end-to-end proof over a local fake relay |
