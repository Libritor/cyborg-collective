// A raw EEG trace split into the five bands the waves are drawn from.
//
// Pure and DOM-free: node asserts it (test_eegbands.js), swim.js draws what it
// returns. Two ways in:
//
//   decodeCounts + splitBands   a stored minute (music/eeg/<stamp>.bin, the
//                               headband's own ADC counts) filtered forwards
//                               and backwards, so no band is shifted in time;
//   createLiveBands             samples as they arrive from a live sharer,
//                               filtered forwards only, since the future has
//                               not happened yet.
//
// Each band is a fourth-order Butterworth band-pass between the band's edges
// (hearing.js BANDS; the Muse's own definitions). Gamma also loses the mains
// hum at 50 and 60 Hz. Nothing else is done to the signal: no smoothing, no
// gain, no normalising. What comes out is in microvolts.

import { BANDS } from "./hearing.js?v=3";

export const MAINS_HZ = Object.freeze([50, 60]);
export const ORDER = 4;

// ---------------------------------------------------------------- design
const cx = (re, im = 0) => ({ re, im });
const add = (a, b) => cx(a.re + b.re, a.im + b.im);
const sub = (a, b) => cx(a.re - b.re, a.im - b.im);
const mul = (a, b) => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a, b) => {
  const d = b.re * b.re + b.im * b.im;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
const sqrt = (a) => {
  const r = Math.hypot(a.re, a.im);
  const re = Math.sqrt((r + a.re) / 2);
  const im = Math.sqrt(Math.max(0, (r - a.re) / 2));
  return cx(re, a.im < 0 ? -im : im);
};

/** |H| of a cascade of biquads at `hz`. */
export function gainAt(sections, hz, fs) {
  const w = (2 * Math.PI * hz) / fs;
  const z1 = cx(Math.cos(w), -Math.sin(w));          // z^-1
  const z2 = mul(z1, z1);
  let h = cx(1);
  for (const s of sections) {
    const num = add(add(cx(s.b0), mul(cx(s.b1), z1)), mul(cx(s.b2), z2));
    const den = add(add(cx(1), mul(cx(s.a1), z1)), mul(cx(s.a2), z2));
    h = mul(h, div(num, den));
  }
  return Math.hypot(h.re, h.im);
}

/**
 * Butterworth band-pass of even `order` (as many biquads) between `lo` and
 * `hi` Hz: the analogue prototype's poles moved to the band, then the bilinear
 * transform with the edges pre-warped, with unit gain at the band's centre.
 */
export function bandpass(lo, hi, fs, order = ORDER) {
  const k = 2 * fs;
  const w1 = k * Math.tan((Math.PI * lo) / fs);
  const w2 = k * Math.tan((Math.PI * hi) / fs);
  const w0sq = w1 * w2;
  const bw = w2 - w1;
  const sections = [];
  // the prototype's poles in the upper half plane; their mirrors give the conjugate halves of each biquad
  for (let i = 0; i < order / 2; i += 1) {
    const angle = (Math.PI * (2 * i + order + 1)) / (2 * order);
    const half = mul(cx(bw / 2), cx(Math.cos(angle), Math.sin(angle)));
    const root = sqrt(sub(mul(half, half), cx(w0sq)));
    for (const s of [add(half, root), sub(half, root)]) {
      const z = div(add(cx(k), s), sub(cx(k), s));      // one pole of a conjugate pair
      sections.push({ b0: 1, b1: 0, b2: -1, a1: -2 * z.re, a2: z.re * z.re + z.im * z.im });
    }
  }
  const centre = (fs / Math.PI) * Math.atan(Math.sqrt(w0sq) / k);
  const each = gainAt(sections, centre, fs) ** (1 / sections.length);   // spread the gain, so no biquad runs hot
  for (const section of sections) { section.b0 /= each; section.b2 /= each; }
  return sections;
}

/** A notch at `hz` (unit gain everywhere else). */
export function notch(hz, fs, q = 8) {
  const w = (2 * Math.PI * hz) / fs;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: 1 / a0, b1: (-2 * Math.cos(w)) / a0, b2: 1 / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 };
}

/** The biquads one band goes through. */
export function sectionsFor(band, fs) {
  const sections = bandpass(band.lo, band.hi, fs);
  if (band.key === "gamma") for (const hz of MAINS_HZ) if (hz < fs / 2) sections.push(notch(hz, fs));
  return sections;
}

// ---------------------------------------------------------------- stored
/** music/eeg/<stamp>.bin -> microvolts, digit for digit what the recording's CSV prints. */
export function decodeCounts(buffer, uvPerCount) {
  const view = new DataView(buffer);
  const n = Math.floor(view.byteLength / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = view.getUint16(i * 2, true) * uvPerCount;
  return out;
}

function runSection(s, x) {
  const y = new Float64Array(x.length);
  // start at rest on the first sample's level, as if the trace had always stood there
  const level = x.length ? x[0] : 0;
  const rest = (level * (s.b0 + s.b1 + s.b2)) / (1 + s.a1 + s.a2);
  let x1 = level, x2 = level, y1 = rest, y2 = rest;
  for (let i = 0; i < x.length; i += 1) {
    const v = s.b0 * x[i] + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/** Forwards then backwards through the same biquads: the magnitude twice, the delay not at all. */
export function zeroPhase(sections, x, pad = 0) {
  const n = x.length;
  const p = Math.max(0, Math.min(pad, n - 1));
  // odd reflection at both ends, so the filter does not ring on a step that is not in the data
  let work = new Float64Array(n + 2 * p);
  for (let i = 0; i < p; i += 1) {
    work[i] = 2 * x[0] - x[p - i];
    work[p + n + i] = 2 * x[n - 1] - x[n - 2 - i];
  }
  work.set(x, p);
  for (const s of sections) work = runSection(s, work);
  work.reverse();
  for (const s of sections) work = runSection(s, work);
  work.reverse();
  return work.subarray(p, p + n);
}

/** A stored trace in microvolts -> { delta, theta, alpha, beta, gamma }, each as long as the trace. */
export function splitBands(uv, fs) {
  let mean = 0;
  for (let i = 0; i < uv.length; i += 1) mean += uv[i];
  mean /= uv.length || 1;
  const centred = new Float64Array(uv.length);
  for (let i = 0; i < uv.length; i += 1) centred[i] = uv[i] - mean;   // the electrode's standing offset is not a wave
  const out = {};
  for (const band of BANDS) out[band.key] = Float32Array.from(zeroPhase(sectionsFor(band, fs), centred, Math.round(2 * fs)));
  return out;
}

// ---------------------------------------------------------------- live
/**
 * A live trace, split as it arrives. `push(samples)` takes microvolts;
 * `read(key, n)` gives sample n of a band (counted from the first sample ever
 * pushed), or undefined when it has not arrived yet or is older than `keep`
 * seconds. `received` counts what has come in.
 */
export function createLiveBands(fs, keep = 30) {
  const size = Math.max(1, Math.round(keep * fs));
  const chains = BANDS.map((band) => ({
    key: band.key,
    sections: sectionsFor(band, fs).map((s) => ({ ...s, x1: 0, x2: 0, y1: 0, y2: 0 })),
    ring: new Float32Array(size),
  }));
  const state = { received: 0 };
  let primed = false;

  function push(samples) {
    for (const v of samples) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;      // a gap in the stream is a gap, not a zero
      if (!primed) {
        // start every band at rest on the signal's standing level instead of ringing on it
        for (const chain of chains) { chain.sections[0].x1 = v; chain.sections[0].x2 = v; }
        primed = true;
      }
      for (const chain of chains) {
        let x = v;
        for (const s of chain.sections) {
          const y = s.b0 * x + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2;
          s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
          x = y;
        }
        chain.ring[state.received % size] = x;
      }
      state.received += 1;
    }
    return state.received;
  }

  function read(key, n) {
    if (!(n >= 0) || n >= state.received || n < state.received - size) return undefined;
    const chain = chains.find((c) => c.key === key);
    return chain ? chain.ring[n % size] : undefined;
  }

  return { push, read, state, fs };
}
