// Proof for idle mode: a catalogue row seeds a deterministic piece.
// Run: node music/test_idle.js -> "PASS <n> assertions", exit 0.
//
// Determinism here is on the *score* -- the arranged event list and its hash --
// not on audio bytes. Two offline renders of one fixed buffer already differ by
// ~4e-9 in this engine, so a byte-identity gate would fail for a reason that has
// nothing to do with this module.

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIdle, encodeWav, C_STEP_MAX } from "./idle.js";
import { createGenerator, nextBar, devicesAt, seedFromText } from "./generator.js";
import { arrangeBars, KINDS } from "./arrange.js";
import { sixteenth } from "./scheduler.js";

let assertions = 0;
const failures = [];
function check(condition, label) {
  assertions += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A real session summary, copied field for field from
// data/sessions/20251208_204533__Muse1.json (hsi L18, artifact_free_frac L33,
// clean_epoch_frac L45, bands_median L51, pulse L83-89, gyro_rms L90,
// battery L91, duration_s L16). Values are the file's own.
const MUSE = {
  stamp: "20251208_204533",
  duration_s: 121.485,
  hsi: { TP9: { 4: 1.0 }, AF7: { 4: 1.0 }, AF8: { 4: 1.0 }, TP10: { 4: 1.0 } },
  artifact_free_frac: { TP9: 1.0, AF7: 1.0, AF8: 0.0, TP10: 0.0 },
  clean_epoch_frac: { TP9: 0.03225806451612903, AF7: 0.8387096774193549, AF8: 0.8387096774193549, TP10: 0.0 },
  bands_median: {
    delta: { TP9: 1.304724, AF7: 0.561611, AF8: 0.348636, TP10: 0.0 },
    theta: { TP9: 1.225079, AF7: 0.595582, AF8: 0.089222, TP10: 0.0 },
    alpha: { TP9: 1.292298, AF7: 0.608703, AF8: 0.301891, TP10: 0.0 },
    beta: { TP9: 1.686531, AF7: 0.877593, AF8: 1.049007, TP10: 0.0 },
    gamma: { TP9: 1.548242, AF7: 0.691931, AF8: 0.83666, TP10: 0.0 },
  },
  pulse: { channel: "850nm_LEFT_OUTER", bpm_mean: 48.75, bpm_sd: 3.75, windows: 2, valid: 2 },
  gyro_rms: 36.75959771140815,
  battery: [78.0, 78.0],
};
// The same session with the signal cleaned out of it: no contact, no bands.
const DIRTY = {
  stamp: "20251208_204533",
  clean_epoch_frac: { TP9: 0, AF7: 0, AF8: 0, TP10: 0 },
  bands_median: null,
  pulse: null,
  gyro_rms: 0,
};

console.log("idle");

// ------------------------------------------------------------------ identity
const a = createIdle({ stamp: MUSE.stamp, summary: MUSE });
const b = createIdle({ stamp: MUSE.stamp, summary: MUSE });
const c = createIdle({ stamp: "20251203_140738", summary: MUSE });

check(a.seed === seedFromText(MUSE.stamp), "the seed is seedFromText(stamp)");
check(a.seed === b.seed, "the same stamp gives the same seed");
check(c.seed !== a.seed, "a different stamp gives a different seed");
check(eq(a.score, b.score), "the same stamp gives an identical score (deep equal)");
check(a.hash() === b.hash(), `the same stamp hashes identically (${a.hash()})`);
check(a.hash() !== c.hash(), `a different stamp hashes differently (${a.hash()} vs ${c.hash()})`);
check(/^[0-9a-f]{8}$/.test(a.hash()), "the hash is 8 lowercase hex digits");

// A catalogue row wraps one summary per device; the row and its device must
// seed the same piece, or the page would get two different songs for one row.
const row = { stamp: MUSE.stamp, devices: [MUSE] };
check(eq(createIdle({ stamp: MUSE.stamp, summary: row }).score, a.score),
  "a catalogue row seeds the same piece as its own device summary");

// ------------------------------------------------------------- the C walk
const walkOf = (idle) => Array.from({ length: idle.bars }, (_, i) => idle.controls(i).C);
const walkA = walkOf(a);
const walkB = walkOf(b);
const walkC = walkOf(c);
check(walkA.every((v) => v >= 0 && v <= 1), `every C is in [0, 1] (${walkA.map((v) => v.toFixed(3)).join(" ")})`);
check(eq(walkA, walkB), "the same stamp walks C identically");
check(!eq(walkA, walkC), "a different stamp walks C differently");
const steps = walkA.slice(1).map((v, i) => Math.abs(v - walkA[i]));
const biggest = steps.length ? Math.max(...steps) : 0;
check(biggest <= 0.1, `no C step exceeds a sane bound (largest ${biggest.toFixed(4)}, cap ${(C_STEP_MAX + 0.04).toFixed(2)})`);
check(biggest > 0.005, `C actually moves (largest step ${biggest.toFixed(4)})`);
check(walkA[0] > 0.4 && walkA[0] < 0.6, `a clean session opens near its own concentration (${walkA[0].toFixed(3)})`);

// The summary is load-bearing, not decorative.
const clean = createIdle({ stamp: MUSE.stamp, summary: MUSE });
const dirty = createIdle({ stamp: MUSE.stamp, summary: DIRTY });
check(clean.controls(0).C > dirty.controls(0).C + 0.15,
  `high clean_epoch_frac opens higher than none (${clean.controls(0).C.toFixed(3)} vs ${dirty.controls(0).C.toFixed(3)})`);
check(a.bpm === 98, `pulse.bpm_mean 48.75 folds by octaves into the tempo (${a.bpm})`);
check(a.bpm >= 96 && a.bpm <= 160, "the folded tempo is in a playable window");
const noPulse = createIdle({ stamp: "x", summary: {}, bpm: 132 });
check(noPulse.bpm === 132, "without a pulse the caller's bpm stands");
const empty = createIdle({});
check(empty.bars === 8 && empty.controls(0).C >= 0 && empty.controls(0).C <= 1,
  "no summary at all still yields a bounded piece");

// controls(i) is a pure lookup, and the walk keeps going past the scored bars.
check(eq(a.controls(3), a.controls(3)), "controls(i) is idempotent");
check(eq(a.controls(a.bars + 40), b.controls(a.bars + 40)),
  "controls(i) keeps walking past the score, identically for the same stamp");
{
  const long = Array.from({ length: 200 }, (_, i) => a.controls(i).C);
  const longSteps = long.slice(1).map((v, i) => Math.abs(v - long[i]));
  check(long.every((v) => v >= 0 && v <= 1), "200 bars of walk stay inside [0, 1]");
  check(Math.max(...longSteps) <= 0.1,
    `no step in 200 bars exceeds the bound (largest ${Math.max(...longSteps).toFixed(4)})`);
  check(new Set(long.map((v) => v.toFixed(3))).size > 20, "the walk does not settle into a constant");
}

// ------------------------------------------------------------------- the label
const label = a.label;
check(label.toLowerCase().includes("not a replay"), "the label says it is not a replay");
check(label.toLowerCase().includes("generated from the summary"), "the label names what it is generated from");
check(label.includes(MUSE.stamp), "the label names the session");
check(label.startsWith("Generated from the summary of"), "the label reads as a statement, not a caveat");

// ------------------------------------------------------- the generator answers
check(a.score.bars.length === a.bars, `the score holds bars bars (${a.score.bars.length})`);
check(a.score.timbres.length === a.bars, "one timbre change per bar");
check(a.score.events.length > 0, `the score has events (${a.score.events.length})`);
check(a.score.events.every((e) => KINDS.includes(e.kind)), "every event is a kind the voices can play");
check(a.score.events.every((e, i) => i === 0 || e.time >= a.score.events[i - 1].time), "events are in time order");
check(Math.abs(a.score.duration - a.bars * 16 * sixteenth(a.bpm)) < 1e-9,
  `the score lasts bars x 16 sixteenths (${a.score.duration.toFixed(3)} s)`);

const signature = (bar) => JSON.stringify([bar.chords.map((x) => x.label), bar.bass, bar.drums, bar.lead]);
const shapes = new Set(a.score.bars.map(signature));
check(shapes.size >= 4, `the piece is not one static bar (${shapes.size} distinct shapes in ${a.bars})`);
const cutoffs = new Set(a.score.bars.map((bar) => bar.timbre.padCutoff.toFixed(3)));
check(cutoffs.size >= 3, `the moving C moves the timbre (${cutoffs.size} distinct pad cutoffs)`);

// The controls must reach the band. Device bands are thresholded, so this is
// measured over a horizon long enough that the walk crosses them with margin:
// inside the scored 8 bars it grazes the climb threshold (0.55) by 1e-4, which
// would flip on any retune of the step size.
{
  const wide = Array.from({ length: 120 }, (_, i) => a.controls(i).C);
  const low = Math.min(...wide);
  const high = Math.max(...wide);
  check(low < 0.28 && high > 0.62,
    `the walk reaches both ends of the device range with margin (${low.toFixed(3)} .. ${high.toFixed(3)})`);
  const sets = new Set(wide.map((c) => devicesAt(c).join(",")));
  check(sets.size >= 3, `the walk opens and closes devices over 120 bars (${sets.size} sets)`);

  const frozen = a.controls(0);
  const gen = createGenerator({ seed: a.seed, bpm: a.bpm });
  const bars = [];
  for (let i = 0; i < a.bars; i += 1) bars.push(nextBar(gen, frozen));
  const frozenSets = new Set(bars.map((bar) => bar.ui.devices.join(",")));
  const frozenC = new Set(bars.map((bar) => bar.ui.C.toFixed(6)));
  check(frozenSets.size === 1 && frozenC.size === 1,
    "frozen controls hold one device set and one C, so the walk is what moves");

  // A decisive summary -> band link, not a threshold graze: MUSE reports
  // gyro_rms 36.76 (motion 0.184) and the bar-four fill uses toms above 0.05
  // (generator.js:321), so removing the gyro turns that fill back into snares.
  const still = createIdle({ stamp: MUSE.stamp, summary: { ...MUSE, gyro_rms: 0 } });
  check(still.controls(0).motion === 0 && a.controls(0).motion > 0.15,
    `gyro_rms sets the motion control (${a.controls(0).motion.toFixed(3)} vs ${still.controls(0).motion})`);
  check(!eq(still.score.events, a.score.events),
    "the same stamp without gyro_rms produces different drums");

  check(eq(arrangeBars(a.score.bars, { bpm: a.bpm }).events, a.score.events),
    "the score is arrangeBars over the same bars the loop pulls");
}

// ------------------------------------------------------------------ pullBar
check(a.pullBar(0) === a.score.bars[0], "pullBar(0) is the score's first bar, not a copy");
check(eq(a.pullBar(3), a.pullBar(3)), "pullBar(i) is idempotent");
{
  const far = createIdle({ stamp: MUSE.stamp, summary: MUSE });
  check(a.pullBar(a.bars + 5) !== undefined, "pullBar keeps answering past the scored bars");
  check(eq(a.pullBar(a.bars + 5), far.pullBar(a.bars + 5)),
    "past the score, the stream is still deterministic");
}

// ------------------------------------------------------------------ encodeWav
const frames = 100;
const mono = new Float32Array(frames);
for (let i = 0; i < frames; i += 1) mono[i] = Math.sin((i / frames) * Math.PI * 2);
const wav = encodeWav([mono], 48000);
const header = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
const ascii = (at, n) => String.fromCharCode(...wav.subarray(at, at + n));

check(wav instanceof Uint8Array, "encodeWav returns a Uint8Array");
check(ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE", "RIFF/WAVE magic is in place");
check(header.getUint32(4, true) === wav.length - 8, "the RIFF size counts everything after itself");
check(ascii(12, 4) === "fmt " && header.getUint32(16, true) === 16, "fmt chunk declares 16 bytes");
check(header.getUint16(20, true) === 1 && header.getUint16(34, true) === 16, "format 1, 16 bits per sample");
check(header.getUint16(22, true) === 1, "mono declares one channel");
check(header.getUint32(24, true) === 48000, "the sample rate is written verbatim");
check(header.getUint32(28, true) === 48000 * 2 && header.getUint16(32, true) === 2,
  "mono byte rate and block align agree with the sample rate");
check(ascii(36, 4) === "data" && header.getUint32(40, true) === 2 * frames, "the data chunk counts 2 bytes per frame");
check(wav.length === 44 + 2 * frames, `mono is 44 + 2*frames bytes (${wav.length})`);

const stereo = encodeWav([mono, mono], 44100);
const stereoHeader = new DataView(stereo.buffer, stereo.byteOffset, stereo.byteLength);
check(stereo.length === 44 + 4 * frames && stereoHeader.getUint16(22, true) === 2
  && stereoHeader.getUint16(32, true) === 4 && stereoHeader.getUint32(28, true) === 44100 * 4,
  `stereo interleaves to 44 + 4*frames bytes (${stereo.length})`);

// Sample round trip, including both rails.
{
  const probe = Float32Array.from([0, 0.5, -0.5, 1, -1]);
  const bytes = encodeWav([probe], 8000);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = [0, 1, 2, 3, 4].map((i) => view.getInt16(44 + i * 2, true));
  check(read[0] === 0 && Math.abs(read[1] - 16384) <= 1 && Math.abs(read[2] + 16384) <= 1
    && read[3] === 32767 && read[4] === -32768,
    `samples land on their int16 values (${read.join(",")})`);
}
check((() => { try { encodeWav([], 48000); return false; } catch { return true; } })(),
  "an empty channel list is refused");
check((() => { try { encodeWav([mono, mono.subarray(1)], 48000); return false; } catch { return true; } })(),
  "unequal channel lengths are refused");

// Node usability: the bytes are a file.
{
  const path = join(tmpdir(), `idle-wav-${process.pid}.wav`);
  writeFileSync(path, wav);
  const onDisk = readFileSync(path);
  unlinkSync(path);
  const view = new DataView(onDisk.buffer, onDisk.byteOffset, onDisk.byteLength);
  check(onDisk.length === wav.length && view.getUint32(40, true) === 2 * frames,
    "the bytes write to disk and read back as a WAV");
}

// ------------------------------------------------------------------- source
{
  const source = readFileSync(new URL("./idle.js", import.meta.url), "utf8");
  check(!/Math\.random\s*\(/.test(source) && !/(Date|performance)\.now\s*\(/.test(source),
    "idle.js never calls a clock or an unseeded PRNG");
  check(!/from "node:|require\(/.test(source) && !/https?:/.test(source),
    "idle.js is pure ESM with no node built-ins and no network");
}

const report = failures.length
  ? `\nFAIL ${failures.length} of ${assertions} assertions\n  - ${failures.join("\n  - ")}`
  : `\nPASS ${assertions} assertions`;
console.log(report);
process.exit(failures.length ? 1 : 0);
