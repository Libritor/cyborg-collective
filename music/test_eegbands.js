// Proof that the waves are the recording: the stored minute decodes to the
// numbers the recording's CSV prints, and the five bands are that trace and
// nothing else, each band holding what belongs to it, in microvolts, unshifted.
// Run: node music/test_eegbands.js -> "PASS <n> assertions", exit 0.

import { readFileSync, existsSync } from "node:fs";

import { BANDS } from "./hearing.js";
import { MAINS_HZ, ORDER, bandpass, notch, gainAt, sectionsFor, decodeCounts, zeroPhase, splitBands, createLiveBands } from "./eegbands.js";

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
const FS = 256;
const sine = (hz, uv, seconds, phase = 0) => Float64Array.from({ length: Math.round(seconds * FS) }, (_, n) => uv * Math.sin((2 * Math.PI * hz * n) / FS + phase));
const peak = (x, from = 0, to = x.length) => { let m = 0; for (let i = from; i < to; i += 1) m = Math.max(m, Math.abs(x[i])); return m; };
const middle = (x) => peak(x, Math.round(x.length * 0.25), Math.round(x.length * 0.75));

console.log("the filters");
{
  const alpha = BANDS.find((b) => b.key === "alpha");
  const s = bandpass(alpha.lo, alpha.hi, FS);
  check(ORDER === 4 && s.length === ORDER && s.every((q) => [q.b0, q.b1, q.b2, q.a1, q.a2].every(Number.isFinite)),
    "a band-pass is fourth order: four biquads with finite coefficients");
  check(s.every((q) => Math.abs(q.a2) < 1 && Math.abs(q.a1) < 1 + q.a2), "both are stable");
  const centre = Math.sqrt(alpha.lo * alpha.hi);
  check(Math.abs(gainAt(s, centre, FS) - 1) < 0.02, "unit gain at the middle of the band");
  check(Math.abs(gainAt(s, alpha.lo, FS) - Math.SQRT1_2) < 0.02 && Math.abs(gainAt(s, alpha.hi, FS) - Math.SQRT1_2) < 0.02,
    "3 dB down at each edge, as a Butterworth is");
  check(gainAt(s, 0.01, FS) < 1e-4 && gainAt(s, 40, FS) < 0.1 && gainAt(s, 2, FS) < 0.1, "nothing at DC, little an octave and more outside");
  check(BANDS.every((b) => Math.abs(gainAt(bandpass(b.lo, b.hi, FS), Math.sqrt(b.lo * b.hi), FS) - 1) < 0.02), "every band's filter passes its own middle whole");
  const n60 = notch(60, FS);
  check(gainAt([n60], 60, FS) < 1e-6 && Math.abs(gainAt([n60], 40, FS) - 1) < 0.05, "a notch removes its own frequency and leaves the rest");
  const gamma = sectionsFor(BANDS.find((b) => b.key === "gamma"), FS);
  check(gamma.length === ORDER + MAINS_HZ.length && MAINS_HZ.every((hz) => gainAt(gamma, hz, FS) < 1e-6), "gamma loses the mains hum at 50 and 60 Hz");
  check(BANDS.filter((b) => b.key !== "gamma").every((b) => sectionsFor(b, FS).length === ORDER), "the other bands are the band-pass alone");
}

console.log("a stored trace, split");
{
  // 10 Hz at 20 uV riding on an electrode offset of 720 uV, with 60 Hz hum
  const n = FS * 20;
  const trace = Float64Array.from({ length: n }, (_, i) => 720 + 20 * Math.sin((2 * Math.PI * 10 * i) / FS) + 5 * Math.sin((2 * Math.PI * 60 * i) / FS));
  const bands = splitBands(trace, FS);
  check(BANDS.every((b) => bands[b.key] instanceof Float32Array && bands[b.key].length === n), "five bands, each as long as the trace");
  const centreGain = gainAt(bandpass(7.5, 13, FS), 10, FS) ** 2;
  check(Math.abs(middle(bands.alpha) - 20 * centreGain) < 0.3, "the 10 Hz wave comes out in alpha, in microvolts (forwards and backwards = the gain twice)");
  check(middle(bands.alpha) > 18, "and close to its full 20 uV");
  check(["delta", "theta", "beta", "gamma"].every((k) => middle(bands[k]) < 0.6), "it is not in the other four");
  const settled = (x) => peak(x, 2 * FS, x.length - 2 * FS);
  check(settled(bands.delta) < 0.5 && settled(bands.gamma) < 0.5,
    "the 720 uV offset is not a wave and the 60 Hz hum is not gamma, from two seconds in to two seconds from the end");
  // no shift in time: the alpha band's peaks sit where the trace's own 10 Hz peaks sit
  let worst = 0;
  for (let i = FS * 5; i < FS * 15; i += 1) worst = Math.max(worst, Math.abs(bands.alpha[i] - 20 * centreGain * Math.sin((2 * Math.PI * 10 * i) / FS)));
  check(worst < 0.3, "the band is not shifted in time: it lies on the wave it came from, sample for sample");
  const twice = splitBands(trace, FS);
  check(BANDS.every((b) => bands[b.key].every((v, i) => v === twice[b.key][i])), "the same trace gives the same bands, every time");
  const each = [2, 6, 10, 20, 38];
  check(BANDS.every((b, i) => {
    const got = splitBands(sine(each[i], 10, 20), FS);
    return BANDS.every((other) => (other.key === b.key ? middle(got[other.key]) > 9.5 : middle(got[other.key]) < 0.3));
  }), "a 10 uV wave in each band's range comes out whole in that band and under 0.3 uV in the other four");
  const flat = zeroPhase(bandpass(1, 4, FS), new Float64Array(FS * 4).fill(3), FS);
  check(peak(flat) < 1e-6, "a flat line stays flat");
}

console.log("a live trace, split as it arrives");
{
  const live = createLiveBands(FS, 4);
  check(live.state.received === 0 && live.read("alpha", 0) === undefined, "nothing has arrived: nothing to read");
  const wave = Array.from(sine(10, 20, 8), (v) => v + 800);
  for (let i = 0; i < wave.length; i += 16) live.push(wave.slice(i, i + 16));          // sixteen samples a frame, as the phone sends them
  check(live.state.received === wave.length, "every sample pushed is counted");
  const tail = Array.from({ length: FS }, (_, k) => live.read("alpha", wave.length - FS + k));
  check(Math.abs(Math.max(...tail.map(Math.abs)) - 20) < 1, "the 10 Hz wave comes through alpha at its 20 uV");
  check(Math.max(...Array.from({ length: FS }, (_, k) => Math.abs(live.read("gamma", wave.length - FS + k)))) < 0.5, "and nothing of it in gamma");
  const level = createLiveBands(FS, 4);
  level.push(new Array(FS * 2).fill(800));
  check(BANDS.every((b) => Array.from({ length: FS * 2 }, (_, k) => Math.abs(level.read(b.key, k))).every((v) => v < 1e-9)),
    "an electrode's standing level is not a wave: a stream that starts at 800 uV and stays there is flat in every band");
  check(live.read("alpha", wave.length) === undefined && live.read("alpha", -1) === undefined, "a sample that has not arrived cannot be read");
  check(live.read("alpha", 0) === undefined && live.read("alpha", wave.length - FS * 4) !== undefined, "samples older than it keeps are let go");
  check(live.read("nope", wave.length - 1) === undefined, "an unknown band has nothing");
  const gaps = createLiveBands(FS, 4);
  gaps.push([800, NaN, null, 801, undefined, 802]);
  check(gaps.state.received === 3, "a missing sample is skipped, not turned into a zero");
}

console.log("the stored minutes published here");
{
  const dir = new URL("./eeg/", import.meta.url);
  const index = JSON.parse(readFileSync(new URL("index.json", dir), "utf8"));
  check(Array.isArray(index.sessions) && index.sessions.length >= 1, `${index.sessions.length} session(s) listed`);
  for (const entry of index.sessions) {
    const file = new URL(entry.file, dir);
    const bytes = existsSync(file) ? readFileSync(file) : null;
    check(bytes && bytes.byteLength === entry.samples * 2 && entry.samples - 2 * entry.lead === entry.seconds * entry.fs && entry.lead >= 2 * entry.fs,
      `${entry.stamp}: ${entry.seconds} s at ${entry.fs} Hz with ${entry.lead / entry.fs} s at each end for the filters, two bytes a sample`);
    if (!bytes) continue;
    const uv = decodeCounts(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), entry.uv_per_count);
    check(uv.length === entry.samples && uv.every((v) => v > 0 && v < 1450), `${entry.stamp}: every sample is a count of the 14-bit converter, off the rails`);
    check(Math.abs(entry.uv_per_count - 1450 / 16383) < 1e-12 && uv.every((v) => Math.abs(v / entry.uv_per_count - Math.round(v / entry.uv_per_count)) < 1e-6),
      `${entry.stamp}: microvolts = count x 1450/16383, as the recording's CSV prints them`);
    check(["TP9", "AF7", "AF8", "TP10"].includes(entry.electrode) && entry.first_sample >= 0, `${entry.stamp}: says which electrode and where in the recording it starts`);
    const bands = splitBands(uv, entry.fs);
    const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    check(BANDS.every((b) => rms(bands[b.key]) > 0.3 && rms(bands[b.key]) < 40), `${entry.stamp}: all five bands carry signal at EEG size (${BANDS.map((b) => rms(bands[b.key]).toFixed(1)).join(", ")} uV rms)`);
  }
}

console.log("purity");
{
  const source = readFileSync(new URL("./eegbands.js", import.meta.url), "utf8");
  check(!/from "node:|require\(/.test(source) && !/document\.|window\./.test(source), "eegbands.js is pure ESM: no node built-ins, no DOM");
  check(!/Math\.random\s*\(/.test(source) && !/(Date|performance)\.now\s*\(/.test(source), "eegbands.js reads no clock and no PRNG");
}

const report = failures.length
  ? `\nFAIL ${failures.length} of ${assertions} assertions\n  - ${failures.join("\n  - ")}`
  : `\nPASS ${assertions} assertions`;
console.log(report);
process.exit(failures.length ? 1 : 0);
