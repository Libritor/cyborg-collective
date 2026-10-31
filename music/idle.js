// Idle mode: one catalogue row seeds one piece.
//
// The record holds *summaries*, never a time series (data/index.json and
// data/sessions/*.json carry bands_median, clean_epoch_frac,
// artifact_free_frac, hsi, pulse, gyro_rms, battery, duration_s -- and nothing
// sample-indexed). So there is nothing here to replay. This module generates a
// piece *from* a summary and says so in `label`, which is the string the page
// shows; a replay claim would be false.
//
// Determinism is defined on the score, not on audio. Chromium's offline render
// of one fixed buffer already differs by ~4e-9 between two runs (measured while
// building the kit), and a full mix drifts more, so "the same stamp renders
// identical bytes twice" cannot be a gate in this engine. The same stamp yields
// the identical arranged event list and the identical hash(); that is the
// strongest claim the engine can keep, and it is the one asserted in
// test_idle.js.

import { mulberry32, seedFromText, createGenerator, nextBar } from "./generator.js";
import { arrangeBars } from "./arrange.js";

// Concentration walks this far per bar at most. A goth set does not lurch; an
// LFO on a filter is what a bigger step would sound like.
export const C_STEP_MAX = 0.05;

// Every axis is pulled back toward where the summary put it, so a long idle run
// stays recognisably this session instead of wandering off to the rails.
const PULL = 0.04;

// A pulse rate is not a tempo (the shipped mean is 48.75), so it is folded by
// octaves until it lands in a window a goth band would actually play.
const TEMPO_WINDOW = [96, 160];

const WALK = [
  ["C", C_STEP_MAX, 0, 1],
  ["arousal", 0.04, 0, 1],
  ["motion", 0.04, 0, 1],
  ["alphaShare", 0.03, 0, 1],
  ["asymmetry", 0.05, -1, 1],
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** A catalogue row carries one summary per device; the first is the evidence. */
function summaryOf(summary) {
  if (!summary || typeof summary !== "object") return {};
  const devices = summary.devices;
  return Array.isArray(devices) && devices.length ? devices[0] : summary;
}

/**
 * Mean over the channels the summary actually reports. An absent channel never
 * measured anything and is skipped; a channel present with 0.0 genuinely had no
 * clean epochs, so it counts -- a half-covered head is half-covered evidence.
 */
function meanOf(map) {
  if (!map || typeof map !== "object") return null;
  const values = Object.values(map).filter(finite);
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * The alpha band's share of alpha+theta+beta power -- the same ratio the
 * conditioner computes for a live sharer, so an idle piece and a live one speak
 * the same language about the same kind of evidence.
 */
function alphaShareOf(bands) {
  if (!bands || typeof bands !== "object") return 0.3;
  let alpha = 0;
  let total = 0;
  for (const name of ["alpha", "theta", "beta"]) {
    const map = bands[name];
    if (!map || typeof map !== "object") continue;
    const sum = Object.values(map)
      .filter(finite)
      .reduce((a, b) => a + Math.max(0, b), 0);
    if (name === "alpha") alpha = sum;
    total += sum;
  }
  return total > 0 ? clamp(alpha / total, 0, 1) : 0.3;
}

/** Frontal alpha asymmetry, (right - left) / (|right| + |left|), as conditioner does. */
function asymmetryOf(bands) {
  const alpha = bands && typeof bands === "object" ? bands.alpha : null;
  const left = alpha && finite(alpha.AF7) ? alpha.AF7 : 0;
  const right = alpha && finite(alpha.AF8) ? alpha.AF8 : 0;
  const sum = Math.abs(left) + Math.abs(right);
  return sum > 0 ? clamp((right - left) / sum, -1, 1) : 0;
}

function foldTempo(mean) {
  let t = mean;
  while (t < TEMPO_WINDOW[0]) t *= 2;
  while (t > TEMPO_WINDOW[1]) t /= 2;
  return Math.round(t);
}

/**
 * What the summary can honestly bias. Anything absent leaves the band at its
 * resting value -- an unmeasured session is a normal band, not a broken one.
 */
function readSummary(summary) {
  const s = summaryOf(summary);
  const clean = meanOf(s.clean_epoch_frac);
  const pulse = s.pulse && typeof s.pulse === "object" ? s.pulse : null;
  const pulseBpm = pulse && finite(pulse.bpm_mean) && pulse.bpm_mean > 0
    ? foldTempo(pulse.bpm_mean)
    : null;
  const gyro = finite(s.gyro_rms) ? Math.max(0, s.gyro_rms) : 0;
  return {
    bpm: pulseBpm,
    // A clean recording is trustworthy evidence of the concentration it shows,
    // so the piece opens where the session actually sat, not at a default 0.3.
    startC: clamp(0.3 + 0.45 * (clean ?? 0), 0.1, 0.9),
    arousal: clamp(gyro / 120, 0, 1),
    motion: clamp(gyro / 200, 0, 1),
    alphaShare: alphaShareOf(s.bands_median),
    asymmetry: asymmetryOf(s.bands_median),
  };
}

function wander(rng, value, target, step, lo, hi) {
  return clamp(value + (rng() * 2 - 1) * step + (target - value) * PULL, lo, hi);
}

/** FNV-1a over the score text. Stable across runs and platforms. */
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * A catalogue row -> a playable piece.
 *
 * `controls(i)` and `pullBar(i)` are pure from the outside: the same index
 * always answers the same way. The walk extends lazily and the bars are cached
 * as they are generated, so both stay deterministic however long an idle set
 * runs and however the caller orders its requests.
 */
export function createIdle({ stamp, summary = {}, bars = 8, bpm = 132 } = {}) {
  const key = String(stamp ?? "untitled");
  const seed = seedFromText(key);
  const facts = readSummary(summary);
  const count = Math.max(1, Math.floor(bars));
  const tempo = facts.bpm ?? bpm;

  // Bar 0 sits exactly where the summary put the session; the walk moves from
  // there, and keeps walking for as long as an idle set runs. Prefixes are drawn
  // in order, so any access order yields the same values. Nothing below reads a
  // clock or an unseeded PRNG.
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const entry = {
    C: facts.startC,
    arousal: facts.arousal,
    motion: facts.motion,
    alphaShare: facts.alphaShare,
    asymmetry: facts.asymmetry,
  };
  const walk = [{ ...entry }];
  const current = { ...entry };

  function ensure(upto) {
    while (walk.length <= upto) {
      for (const [axis, step, lo, hi] of WALK) {
        current[axis] = wander(rng, current[axis], entry[axis], step, lo, hi);
      }
      walk.push({ ...current });
    }
  }

  // A pure lookup: the same index always answers the same way, however far the
  // page has played.
  function controls(i) {
    const at = Math.max(0, Math.floor(i));
    ensure(at);
    const w = walk[at];
    return {
      C: w.C,
      alphaShare: w.alphaShare,
      arousal: w.arousal,
      motion: w.motion,
      asymmetry: w.asymmetry,
    };
  }

  const gen = createGenerator({ seed, bpm: tempo });
  const pulled = [];
  function pullBar(i) {
    const index = Math.max(0, Math.floor(i));
    while (pulled.length <= index) {
      pulled.push(nextBar(gen, controls(pulled.length)));
    }
    return pulled[index];
  }

  const barsOfScore = [];
  for (let i = 0; i < count; i += 1) barsOfScore.push(pullBar(i));
  const arranged = arrangeBars(barsOfScore, { bpm: tempo });
  const score = {
    bars: barsOfScore,
    events: arranged.events,
    timbres: arranged.timbres,
    duration: arranged.duration,
  };

  const digest = hashText(JSON.stringify(score));

  const label = `Generated from the summary of ${key}, not a replay of it: `
    + `${count} bars at ${tempo} BPM, opening at concentration ${walk[0].C.toFixed(2)}.`;

  return {
    seed,
    bpm: tempo,
    label,
    score,
    controls,
    pullBar,
    hash: () => digest,
    bars: count,
  };
}

/**
 * Interleaved 16-bit PCM in a RIFF/WAVE container.
 *
 * Pure: returns bytes, so the browser wraps them in a Blob and node writes them
 * with fs.writeFileSync. `channels` is one Float32Array (or plain array of
 * samples in [-1, 1]) per channel, all the same length.
 */
export function encodeWav(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new TypeError("encodeWav: channels must be a non-empty array");
  }
  if (!finite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("encodeWav: sampleRate must be a positive number");
  }
  const count = channels.length;
  const frames = channels[0].length;
  for (const channel of channels) {
    if (!channel || channel.length !== frames) {
      throw new RangeError("encodeWav: every channel must have the same length");
    }
  }

  const dataBytes = frames * count * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);   // everything after this field
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);              // PCM fmt chunk size
  view.setUint16(20, 1, true);               // format 1 = PCM
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true);   // byte rate
  view.setUint16(32, count * 2, true);       // block align
  view.setUint16(34, 16, true);              // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  let at = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < count; channel += 1) {
      const sample = clamp(channels[channel][frame] ?? 0, -1, 1);
      // Asymmetric on purpose: -1 maps to -32768, +1 to +32767, so the full
      // range is used without wrapping.
      view.setInt16(at, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
      at += 2;
    }
  }
  return bytes;
}
