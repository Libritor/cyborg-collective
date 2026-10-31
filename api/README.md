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
python3 api/server.py --sse-keepalive 5 --stale-after 2       # heartbeats and staleness
```

`python3 api/test_pipeline.py` proves the whole path (fake relay → hub →
capture → SSE replay → OSC datagrams → probe) and prints
`PASS <n> assertions`.

`python3 api/probe_live.py` is the one-command check for a **real headband**:
it reads both live streams for one sharer and prints what actually arrived —
frame rate, channel layout, per-channel dropouts, the validity gates, whether a
capture on disk is still growing, and whether the service ever marked that
sharer stale. It exits non-zero only when no eeg arrived at all:

```bash
python3 api/server.py --osc 127.0.0.1:5000     # then, in another shell:
python3 api/probe_live.py                      # 30 s on the first sharer
python3 api/probe_live.py --seconds 10 --sharer russet-grebe-53
```

Expected against a Muse (2/S):

```
sharer            russet-grebe-53          tier raw   stale_s 0.1
eeg events        37   fs 256.0   rows 4   samples/row 256..256
nulls per channel TP9 0.0%  AF7 0.0%  AF8 0.0%  TP10 0.0%
features events   74   types hello,features
valid            bands True  arousal True  hr True
capture growing   yes
CHECK ok channel layout TP9 AF7 AF8 TP10
CHECK ok rate looks like a Muse (256 Hz)
```

A `warn` line is a finding, not a failure: `warn dropouts on TP10 (34.0%)` means
that electrode was open, and `warn bands gated: no channel in contact` means the
headband was not on a head — which is exactly the distinction `valid` exists to
make.

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
holds a 10 Hz alpha + 6 Hz theta mixture, heart rate breathes, contact quality
wanders (TP10 reaches hsi 4, so `/eeg/contact` really does show a `0.0`), each
sharer's gyro and accel move on their own phases, and the four fNIRS ratios
breathe — so the numbers you see move the way a real sharer's would, and two
sharers never look like the same person.

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

## Running alongside the page

The site and this service are two independent consumers of the same relay, which
is the point of it: the page keeps working while Ableton gets the data.

- The api is **read-only** upstream — it opens the relay WebSocket and never
  sends, so it cannot disturb a sharer, a viewer or the page.
- It costs the relay one viewer slot (`/stats` shows `viewers` grow, `people`
  unchanged) and binds its own local port (`--port`, default 8787), so it runs
  next to whatever serves the page.
- The page prefers a **same-origin** relay (`fetch("stats")`) and falls back to
  `wss://cyborg-collective-relay.onrender.com/live`. Both sides must point at
  the same one: if you serve the page from a local server that also serves the
  relay, give this service `--relay ws://127.0.0.1:<that-port>/live`; otherwise
  the default already matches the fallback.
- `/api/v1/*` answers `Access-Control-Allow-Origin: *`, so a page can also read
  this service directly from JavaScript if it wants the derived features.

```bash
python3 api/server.py --osc 127.0.0.1:5000     # alongside the site, real relay
```

Then `python3 api/probe_live.py` says whether the headband on the other end is
actually streaming — a sharer that is merely *connected* sends `device` frames
and nothing else, which is what that report is for.

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
 "artifact_free_frac": {"TP9": 0.65, "AF7": 0.943, "AF8": 0.937, "TP10": 0.678},
 "hsi_frac": {"TP9": {"1": 0.888, "2": 0.108, "4": 0.004}, "AF7": {"1": 0.999}},
 "gyro_rms": 6.730249688805007,
 "pulse": {"channel": "850nm_LEFT_OUTER", "bpm_mean": 58.25, "bpm_sd": 7.12,
           "windows": 181, "valid": 180},
 "battery": [52.0, 52.0],
 "bands": {"delta": {"TP9": 0.0, "AF7": 0.904, "AF8": 0.699, "TP10": 0.838}, "…": {}},
 "preview_url": "data/previews/20251203_132222__00_55_DA_B9_01_11.svg"}
```

`bands` are `bands_median` from the index (log10 µV²), `clean_frac` is
`clean_epoch_frac`, `fs_hz` is `fs_est`. A missing number is `null`; a device
without a preview file gets `preview_url: null`.

The sensing block is whatever the recording actually captured, never invented:

| Key | Meaning |
|---|---|
| `artifact_free_frac` | per channel, share of epochs with no artefact (`null` where the device has none) |
| `hsi_frac` | per channel, `{hsi code: share of the session}` — only channels the device reports appear, so read it with `.get(channel, {})` |
| `gyro_rms` | RMS of the accelerometer/gyro trace; `null` when the device sent no motion packets |
| `pulse` | `{channel, bpm_mean, bpm_sd, windows, valid}` from the PPG summary, or `null` when the device has no pulse data. `windows`/`valid` are **counts**, not booleans |
| `battery` | the recorded battery series (`null` when the device recorded none) |

### `/patch`

The catalogue's only music-facing projection, strictly derived from stored
numbers:

```json
{"stamp": "20251203_132222", "tag": "00_55_DA_B9_01_11",
 "duration_s": 84.921, "fs_hz": 258.03,
 "pulse": {"bpm": 78.75, "valid": true},
 "motion_rms": 20.9148472521439,
 "contact": {"TP9": 0.0, "AF7": 0.476, "AF8": 0.643, "TP10": 0.048},
 "bands_log10": {"delta": {"TP9": 0.0, "AF7": 0.904, "AF8": 0.699, "TP10": 0.838}, "…": {}},
 "bands_norm": {"delta": {"TP9": 0.0, "AF7": 1.0, "AF8": 0.773, "TP10": 0.927}, "…": {}},
 "best_channel": {"delta": "AF7", "theta": "AF7", "alpha": "AF7", "beta": "TP10", "gamma": "TP10"}}
```

`pulse.bpm` is the recorded `bpm_mean` and `pulse.valid` is
`(valid windows) > 0`, so a session whose PPG never locked reports
`{"bpm": null, "valid": false}` rather than a number a player would trust.
`motion_rms` is `gyro_rms` (`null` when the recording has no motion).

`bands_norm` divides each channel by that band's strongest channel (a band
whose maximum is `<= 0` becomes all zeros, and `best_channel` is then `null`).
Because log10 power is negative whenever the power is below 1 µV²,
`bands_norm` **can be negative** — it is a share of the strongest channel, not
a 0–1 value. Clamp in the player if you need a unipolar control.

## SSE

Both stream routes emit `data: <json>\n\n` per event and a `: keepalive`
comment every `--sse-keepalive` seconds of silence (default 15).

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
 "valid": {"bands": true, "arousal": true, "hr": true},
 "imu": {"gyro": [x, y, z], "accel": [x, y, z]},
 "optics": {"sites": {"left_outer": {"ratio": 1.05, "r730": 6.1, "r850": 7.6},
                      "left_inner": null, "right_inner": null, "right_outer": null},
            "ppg": {"850nm_LEFT_OUTER": 68.0}, "ts": 1793414821927},
 "eeg_hz": 256.0, "stale_s": 0.04}
```

`contact` is the headband's hsi code per channel (1 good … 4 poor, `null` = no
data). `null` band values mean that channel was not in contact. `eeg_hz` is the
measured sample rate **per channel** (a 256 Hz band shows ~256, not 4 × 256).
Replays pace themselves from the recorded receive times (`speed=50` finishes a
short capture promptly; a gap never stalls longer than 5 s), and `start=<n>`
skips the first n frames of the stream.

`valid` is the gate that makes a zero readable. `0.0` on a control can mean
"calm" or "no electrode", so each block says whether it is currently
trustworthy:

| Flag | True when |
|---|---|
| `valid.bands` | at least one channel reports hsi 1 or 2 **and** the band block has a real number |
| `valid.arousal` | the index is a number and the label is not `no_claim` |
| `valid.hr` | the detector says `ok` and a bpm is present |

Gating is **emit-only**: the service never mutes a value, it reports the flag,
and the mute happens where the mapping lives (Live). `stale_s` is seconds since
that sharer's last frame (`null` on a replay, which has no notion of now).

`imu` carries three gyro and three accel axes (a Muse S gen 2); `null` when that
frame type never arrived. `optics` carries the four fNIRS sites app.js maps —
`left_outer`, `left_inner`, `right_inner`, `right_outer` — each `{ratio, r730,
r850}`, or `null` where the site reported nothing, plus whatever `ppg` channels
the device sent. **A Muse 2/S sends no optics and no aux electrodes**: expect
`sites` all `null` and `/optics/valid` at `0.0` there. Anything a device invents
outside those four site names is dropped rather than invented into the payload.

When the sharer leaves (the relay sends `leave`), both live streams emit one
final `{"t": "bye", "pseudonym": ..., "reason": "left"}` and close, so a player
never sits on keepalives for someone who is gone. A sharer that goes *silent*
without leaving is reported instead of looking alive: every keepalive period
(`--sse-keepalive`, default 15 s) with no frame checks `stale_s` against
`--stale-after` (default 5 s) and emits

```json
{"t": "stale", "pseudonym": "russet-grebe-53", "stale_s": 12.4}
```

once per keepalive period until frames resume. `/live/sharers` reports the same
fact as `stale_s` — seconds since that sharer's last frame — because `age_s` is
merely how long they have been sharing.

A `features` event is emitted once per incoming feature frame — `bands`,
`quality`, `arousal`, `hr`, `imu`, `optics` — so a running stream produces
several per upstream tick, each carrying the current merged state. Clients that
want one update per tick should coalesce on `ts` (or just act on the latest). A
replay emits once per frame the capture holds for those types.

## OSC (→ Ableton)

With `--osc HOST:PORT` every feature update sends eighteen datagrams (all
float32 args, one message each — a missing value is `0.0`, never a gap):

| Address | Args |
|---|---|
| `/eeg/bands` | 5 — delta…gamma, mean over channels in contact, relative power |
| `/eeg/bands/abs` | 5 — same reduction, absolute power |
| `/eeg/contact` | 4 — TP9, AF7, AF8, TP10 mapped hsi 1→1.0, 2→0.5, 3→0.25, 4→0.0 |
| `/eeg/alpha` | 1 — the alpha element of `/eeg/bands` (single-CC convenience) |
| `/eeg/arousal` | 1 — activation index, `0.0` when there is no claim |
| `/eeg/hr` | 1 — bpm while beats are detected, else `0.0` |
| `/eeg/rms` | 4 — RMS µV of the last raw frame, per channel |
| `/eeg/bands/valid` | 1 — `1.0` when the band values can be trusted, else `0.0` |
| `/eeg/arousal/valid` | 1 — same gate for the arousal index |
| `/eeg/hr/valid` | 1 — same gate for bpm |
| `/eeg/aux` | 2 — AUX_L, AUX_R through the same hsi→contact table (`0.0, 0.0` on a Muse 2, which has no aux electrodes) |
| `/imu/gyro` | 3 — gyro x, y, z (deg/s) |
| `/imu/accel` | 3 — accel x, y, z (g) |
| `/imu/motion` | 1 — how far `|accel|` is from 1 g: `0.0` still, grows when moved |
| `/optics/ratio` | 4 — fNIRS ratio per site, in the fixed order left_outer, left_inner, right_inner, right_outer |
| `/optics/r730` | 4 — 730 nm reflectance per site, same order |
| `/optics/r850` | 4 — 850 nm reflectance per site, same order |
| `/optics/valid` | 1 — `1.0` when any site reported a ratio, else `0.0` |

The three `/…/valid` messages are the **only** gate mechanism this side of the
bridge, and they exist so a Live-side mapping can mute: a CC driven by
`/eeg/bands` index 0 can be multiplied by `/eeg/bands/valid`, so a detached
electrode stops moving a parameter instead of driving it to zero. Nothing in
`osc_cc_bridge.py` changes — it already keys rules on one address per message,
which is also why one message per address is kept rather than batching.

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

Volume is a consequence of the extra triggers: six frame types (`bands`,
`quality`, `arousal`, `hr`, `imu`, `optics`) each emit all eighteen messages, so
a sharer at 8 frames/s costs ~48 emits/s — tens of KB/s, one `struct.pack` per
float. That is deliberate: MIDI stays quiet because `MappingRule` drops an
unchanged 7-bit value, so extra datagrams cost nothing musically. If the local
socket buffer ever drops one it shows up as `osc.dropped`, not as an error.

## Bounds

- **upstream frames**: at most 8 MiB each. A larger message is refused by the
  socket (which then reconnects) instead of being buffered — real `eeg` frames
  are about 10 KB.
- **state**: 2048 sharers at most; a relay that churns pseudonyms evicts the
  least recently heard (`snapshot` also prunes the roster).
- **streams**: a `/features` subscriber only receives `bands`/`quality`/
  `arousal`/`hr`/`imu`/`optics` frames and an `/eeg` subscriber only `eeg`, so a
  torrent of raw frames can neither waste memory nor evict the state a player
  needs. Each subscriber queue holds 64 frames and drops the oldest.
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

Silence is not disappearance, so staleness is measured rather than assumed:
`stale_s` is seconds since that sharer's last frame, and both live streams emit
`{"t": "stale", "stale_s": n}` once a sharer has been quiet past
`--stale-after`. A sharer who is merely quiet stays listed — dropping them would
throw away the last state a player might still want — but nothing downstream can
mistake them for someone transmitting.

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
| `probe_live.py` | one-command diagnostic for a real headband (rate, layout, dropouts, gates) |
