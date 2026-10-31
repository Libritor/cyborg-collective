// The browser half of the proof: OfflineAudioContext renders the kit and the
// voices, and the measurements are asserted here because they cannot be taken in
// node.
//
// Open music/test_audio.html?section=kit or ?section=voices, served over http
// (ES modules do not load from file://). Results land on window.__result and in
// the document title, so a headless browser can poll instead of screenshotting.
//
// No user gesture is needed anywhere: an OfflineAudioContext renders without one.

import { KIT, KIT_NAMES, renderKit, fillNoise } from "./kit.js";
import { createVoices } from "./voices.js";
import { sixteenth } from "./scheduler.js";
import { createGenerator, nextBar } from "./generator.js";

window.__result = null;      // null means "not finished"; ok is a boolean

const results = { ok: false, section: null, assertions: 0, failures: [], notes: [] };
const log = document.getElementById("log");
const statusEl = document.getElementById("status");

function check(condition, label) {
  results.assertions += 1;
  if (!condition) results.failures.push(label);
  const li = document.createElement("li");
  li.textContent = `${condition ? "ok  " : "FAIL"} ${label}`;
  li.className = condition ? "ok" : "fail";
  log.appendChild(li);
  return condition;
}

function note(text) {
  results.notes.push(text);
  const li = document.createElement("li");
  li.textContent = `     ${text}`;
  log.appendChild(li);
}

// ------------------------------------------------------------------ measurement

const SAMPLE_RATE = 48000;
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const dbText = (x) => `${Number.isFinite(x) ? x.toFixed(2) : "-inf"} dBFS`;

function peakOf(channel) {
  let peak = 0;
  for (let i = 0; i < channel.length; i += 1) {
    const v = channel[i] < 0 ? -channel[i] : channel[i];
    if (v > peak) peak = v;
  }
  return peak;
}

function rmsOf(channel, from = 0, to = channel.length) {
  let sum = 0;
  let count = 0;
  for (let i = from; i < to; i += 1) {
    sum += channel[i] * channel[i];
    count += 1;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

/** FNV-1a over the raw float bytes: the determinism gate needs exact identity. */
function hashOf(buffer, channel = 0) {
  const data = buffer.getChannelData(channel);
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The engine's own two-render reproducibility, measured the cheapest way: one
 * fixed buffer through one bare AudioBufferSourceNode, rendered twice. Whatever
 * this returns is the floor no amount of care in kit.js can beat.
 */
async function measureEngineFloor(sampleRate = SAMPLE_RATE) {
  const frames = 9600;
  const render = async () => {
    const ctx = new OfflineAudioContext(1, frames, sampleRate);
    const buffer = ctx.createBuffer(1, frames, sampleRate);
    fillNoise(buffer.getChannelData(0), 0x1234);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
    const rendered = await ctx.startRendering();
    return rendered.getChannelData(0);
  };
  const a = await render();
  const b = await render();
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) worst = d;
  }
  return worst;
}

/** RBJ cookbook lowpass, 2-pole, applied in JS so the comparison is exact. */
function lowpassed(channel, cutoff, sampleRate = SAMPLE_RATE) {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const b0 = (1 - cos) / 2;
  const b1 = 1 - cos;
  const b2 = (1 - cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const out = new Float32Array(channel.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < channel.length; i += 1) {
    const x0 = channel[i];
    const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
}

// ------------------------------------------------------------------ section: kit

async function runKit() {
  const { buffers, ir } = await renderKit(SAMPLE_RATE);

  check(KIT_NAMES.every((name) => buffers[name] instanceof AudioBuffer) && ir instanceof AudioBuffer,
    `six hit buffers and an impulse are present (${KIT_NAMES.filter((n) => buffers[n]).length} hits)`);

  let peakFaithful = true;
  let lengthFaithful = true;
  for (const name of KIT_NAMES) {
    const hit = KIT[name];
    const buffer = buffers[name];
    const expected = Math.ceil((hit.lengthMs / 1000) * SAMPLE_RATE);
    if (buffer.numberOfChannels !== 1 || buffer.length !== expected) lengthFaithful = false;
    const peak = peakOf(buffer.getChannelData(0));
    if (Math.abs(peak - hit.peak) > 1e-3 || !(peak > 0.05)) {
      peakFaithful = false;
      note(`${name}: peak ${peak.toFixed(5)}, wanted ${hit.peak}`);
    }
  }
  check(lengthFaithful,
    "every hit is mono and exactly ceil(lengthMs / 1000 * sampleRate) frames long");
  check(peakFaithful, "every hit's rendered peak is its declared peak and above 0.05");

  // Determinism. Byte identity is not something this engine offers: a bare
  // AudioBufferSourceNode playing one fixed buffer renders twice with a 1-ulp
  // difference (measured here, as the floor). So the gate is split where the
  // responsibility actually is. The seeds must be byte-exact -- they are what
  // makes the kit deterministic, and Math.random() returning to fillNoise would
  // fail this loudly. The render must agree to -120 dBFS, which a reseeded
  // render would miss by orders of magnitude.
  const engineFloor = await measureEngineFloor();
  check(engineFloor <= 1e-6,
    `a bare buffer source renders twice within ${engineFloor.toExponential(2)} per sample (nothing above this floor can be byte-stable)`);

  const noiseBytes = (seed) => {
    const data = fillNoise(new Float32Array(4096), seed);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  };
  const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const seedA = noiseBytes(0x4d11);
  const seedB = noiseBytes(0x4d11);
  const seedC = noiseBytes(0x4d12);
  check(sameBytes(seedA, seedB), "fillNoise is byte-identical for the same seed");
  check(!sameBytes(seedA, seedC), "fillNoise differs for a different seed");

  const second = await renderKit(SAMPLE_RATE);
  let worst = 0;
  let worstName = null;
  for (const name of KIT_NAMES) {
    const a = buffers[name].getChannelData(0);
    const b = second.buffers[name].getChannelData(0);
    for (let i = 0; i < a.length; i += 1) {
      const d = Math.abs(a[i] - b[i]);
      if (d > worst) { worst = d; worstName = name; }
    }
  }
  check(worst <= 1e-6,
    `two renderKit() calls agree to ${worst.toExponential(2)} per sample (worst: ${worstName}, ${dbText(db(worst))} full scale)`);
  note(`hashes ${KIT_NAMES.map((name) => `${name}=${hashOf(buffers[name])}`).join(" ")}`);

  // The gate on the snare, measured where it should bite.
  const snare = buffers.snare;
  const gateSamples = Math.round(((KIT.snare.gate.holdMs + KIT.snare.gate.releaseMs) / 1000) * SAMPLE_RATE);
  const data = snare.getChannelData(0);
  const before = rmsOf(data, 0, gateSamples);
  const after = rmsOf(data, gateSamples, data.length);
  check(after <= 1e-3 * before,
    `the snare gate really cuts: ${dbText(db(after) - db(before))} after ${KIT.snare.gate.holdMs}ms against ${dbText(db(before))} before`);

  // The impulse.
  const left = ir.getChannelData(0);
  const right = ir.getChannelData(1);
  const predelay = Math.round(0.020 * SAMPLE_RATE);
  check(ir.numberOfChannels === 2, "the impulse is stereo");
  check(ir.length === Math.ceil(2.6 * SAMPLE_RATE),
    `the impulse is ${(ir.length / SAMPLE_RATE).toFixed(3)}s long`);
  check(left.slice(0, predelay).every((v) => v === 0) && right.slice(0, predelay).every((v) => v === 0),
    `the first ${(predelay / SAMPLE_RATE * 1000).toFixed(0)}ms of the impulse is absolute silence`);
  check(left[left.length - 1] === 0 && right[right.length - 1] === 0,
    "the impulse ends on an absolute zero, not a -60 dB tail");
  check(Math.abs(peakOf(left) - 1) < 1e-6 && Math.abs(peakOf(right) - 1) < 1e-6,
    `both impulse channels peak at 1.0 (${peakOf(left).toFixed(6)}, ${peakOf(right).toFixed(6)})`);
  check(hashOf(ir, 0) !== hashOf(ir, 1),
    `the two impulse channels are decorrelated (left ${hashOf(ir, 0)}, right ${hashOf(ir, 1)})`);
}

// --------------------------------------------------------------- section: voices

/** One event list from the real generator, and the four stem renders that share it. */
function arrange(bars, { seed = 3, tonicMidi = 57, bpm = 132, controls }) {
  const gen = createGenerator({ seed, tonicMidi, bpm });
  const events = [];
  const timbres = [];
  const barLength = (60 / bpm) * 4;
  for (let i = 0; i < bars; i += 1) {
    const bar = nextBar(gen, controls);
    const start = i * barLength;
    const s = sixteenth(bar.tempo ?? bpm);
    timbres.push({ at: start, value: bar.timbre });
    for (const hit of bar.drums) {
      events.push({ kind: "drum", hit: hit.hit, vel: hit.vel, time: start + hit.step * s });
    }
    for (const note of bar.bass) {
      events.push({ kind: "bass", midi: note.midi, vel: note.vel, dur: note.dur * s,
        time: start + note.step * s });
    }
    for (const note of bar.lead) {
      events.push({ kind: "lead", midi: note.midi, vel: note.vel, dur: note.dur * s,
        time: start + note.step * s });
    }
    if (bar.chords.length) {
      const chord = bar.chords[0];
      events.push({ kind: "pad", voicing: chord.voicing, time: start, dur: barLength - 0.03 });
    }
  }
  events.sort((a, b) => a.time - b.time);
  return { events, timbres, barLength, duration: bars * barLength };
}

async function renderStem(kit, arrangement, kinds, seconds, { tap = "master" } = {}) {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const voices = createVoices(ctx, kit, { bpm: 132 });
  for (const { at, value } of arrangement.timbres) voices.setTimbre(value, at);
  for (const event of arrangement.events) {
    if (!kinds.includes(event.kind)) continue;
    if (event.kind === "drum") voices.play.drum(event.hit, event.time, event.vel);
    if (event.kind === "bass") voices.play.bass(event.midi, event.time, event.dur, event.vel);
    if (event.kind === "pad") voices.play.pad(event.voicing, event.time, event.dur);
    if (event.kind === "lead") voices.play.lead(event.midi, event.time, event.dur, event.vel);
  }
  if (tap === "sum") {
    // Cut the sum from the saturator and listen to it directly: this is the
    // signal the WaveShaper's curve actually receives.
    voices.buses.sum.disconnect();
    voices.buses.sum.connect(ctx.destination);
  }
  return ctx.startRendering();
}

async function runVoices() {
  const { buffers, ir } = await renderKit(SAMPLE_RATE);
  const kit = { buffers, ir };
  const BARS = 4;
  const arrangement = arrange(BARS, { controls: { C: 0.6, alphaShare: 0.3, arousal: 0.6, motion: 0.1 } });
  const seconds = arrangement.duration + 2.6;    // the reverb tail has to fit

  const counts = ["drum", "bass", "pad", "lead"].map((k) => [k, arrangement.events.filter((e) => e.kind === k).length]);
  check(counts.every(([, n]) => n > 0),
    `the generator gave every voice something to play (${counts.map(([k, n]) => `${k} ${n}`).join(", ")})`);

  const stems = {};
  for (const [kind, kinds] of [["drums", ["drum"]], ["bass", ["bass"]], ["pad", ["pad"]], ["lead", ["lead"]]]) {
    stems[kind] = await renderStem(kit, arrangement, kinds, seconds);
  }

  const levels = {};
  for (const [kind, rendered] of Object.entries(stems)) {
    const data = rendered.getChannelData(0);
    levels[kind] = { rms: db(rmsOf(data)), peak: db(peakOf(data)) };
  }
  for (const [kind, level] of Object.entries(levels)) {
    check(level.rms > -40, `${kind} stem RMS ${dbText(level.rms)} > -40 dBFS`);
    check(level.peak <= -0.9, `${kind} stem master peak ${dbText(level.peak)} <= -0.9 dBFS`);
  }

  // The stems are measured alone so a broken voice cannot hide behind the others;
  // the full mix is measured together because that is what actually has to stay
  // under the ceiling. Four voices that each fit can still sum past it.
  const mix = await renderStem(kit, arrangement, ["drum", "bass", "pad", "lead"], seconds);
  const mixData = mix.getChannelData(0);
  const mixPeak = db(peakOf(mixData));
  const mixRms = db(rmsOf(mixData));
  check(mixPeak <= -0.9, `the full mix peaks at ${dbText(mixPeak)} <= -0.9 dBFS (${dbText(mixRms)} RMS)`);

  // The master peak above would pass just as happily on a clipped mix, so the
  // signal actually entering the WaveShaper is measured here: its curve only
  // covers [-1, 1], and anything past that is a hard clip wearing a saturator's
  // name. The voice sum measured 5.2 peak before this was gain staged.
  const sum = await renderStem(kit, arrangement, ["drum", "bass", "pad", "lead"], seconds, { tap: "sum" });
  const sumPeak = peakOf(sum.getChannelData(0));
  check(sumPeak <= 1.0,
    `the voice sum peaks at ${sumPeak.toFixed(3)}, inside the shaper's [-1, 1] domain (no clamp)`);
  check(sumPeak >= 0.4,
    `the voice sum peaks above 0.4, so the saturator is actually being driven (${sumPeak.toFixed(3)})`);

  // The bass owns the sub; the pad does not. If a pad ever sat down there the
  // two would fight and neither would read as weight.
  const bassLow = db(rmsOf(lowpassed(stems.bass.getChannelData(0), 120)));
  const padLow = db(rmsOf(lowpassed(stems.pad.getChannelData(0), 120)));
  check(bassLow - padLow >= 6,
    `below 120Hz the bass is ${(bassLow - padLow).toFixed(1)} dB above the pad (needs 6)`);
  note(`120Hz lowpass: bass ${dbText(bassLow)}, pad ${dbText(padLow)}`);
  note(`levels ${Object.entries(levels).map(([k, v]) => `${k} rms ${v.rms.toFixed(1)} peak ${v.peak.toFixed(1)}`).join(" | ")}`);
}

// ------------------------------------------------------------------------ main

async function main() {
  const section = new URLSearchParams(location.search).get("section") || "kit";
  results.section = section;
  if (section === "kit") await runKit();
  else if (section === "voices") await runVoices();
  else throw new Error(`unknown section: ${section}`);

  results.ok = results.failures.length === 0;
  const summary = `${results.ok ? "PASS" : "FAIL"} ${results.assertions} assertions`;
  statusEl.textContent = results.ok ? summary : `${summary} — ${results.failures.length} failed`;
  statusEl.className = results.ok ? "ok" : "fail";
  document.title = summary;
  window.__result = results;
}

main().catch((err) => {
  results.ok = false;
  results.failures.push(`threw: ${err && err.message ? err.message : String(err)}`);
  statusEl.textContent = `FAIL — ${err && err.stack ? err.stack : err}`;
  statusEl.className = "fail";
  document.title = "FAIL threw";
  window.__result = results;
  throw err;
});
