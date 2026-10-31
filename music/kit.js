// The drum kit as data, plus the offline renderer that turns it into buffers.
//
// Nothing here loads a file: every hit is described by layers (tone, noise,
// cluster) and rendered once by an OfflineAudioContext. That matters because
// synthesis on the audio thread is how a browser drum machine drops its clock:
// the buffers are made before playback starts and playback only copies them.
//
// Every noise and cluster layer carries an integer `seed`. The noise is filled
// from a seeded xorshift32, not Math.random, which is what makes two loads
// produce byte-identical buffers. A test can therefore assert determinism
// instead of hoping for it.
//
// This module has no imports on purpose: generator.js owns the grammar, and
// importing it back would make a cycle for one list of names.

export const KIT = {
  kick: {
    lengthMs: 420, peak: 0.95, gate: null,
    layers: [
      { type: "tone", wave: "sine", hzFrom: 120, hzTo: 44, pitchMs: 80,
        attackMs: 1, holdMs: 60, releaseMs: 340, gain: 1.0 },
      { type: "noise", seed: 0x1f3d, filter: "highpass", filterHz: 3000, q: 0.7,
        attackMs: 0.5, holdMs: 1, releaseMs: 14, gain: 0.35 },
    ],
  },
  snare: {
    lengthMs: 205, peak: 0.9, gate: { holdMs: 150, releaseMs: 1, releaseCurve: "linear" },
    layers: [
      { type: "tone", wave: "sine", hzFrom: 180, hzTo: 180, pitchMs: 0,
        attackMs: 1, holdMs: 20, releaseMs: 175, gain: 0.5 },
      { type: "tone", wave: "sine", hzFrom: 330, hzTo: 330, pitchMs: 0,
        attackMs: 1, holdMs: 20, releaseMs: 120, gain: 0.35 },
      { type: "noise", seed: 0x2a71, filter: "bandpass", filterHz: 1800, q: 0.8,
        attackMs: 0.5, holdMs: 20, releaseMs: 180, gain: 0.9 },
    ],
  },
  hatC: {
    lengthMs: 70, peak: 0.55, gate: null,
    layers: [
      { type: "cluster", seed: 0x4d11, hz: 5200,
        ratios: [1, 1.34, 1.89, 2.45, 3.01, 3.55],
        filter: "highpass", filterHz: 6000, q: 0.9,
        attackMs: 0.5, holdMs: 1, releaseMs: 40, gain: 0.6 },
    ],
  },
  hatO: {
    lengthMs: 400, peak: 0.5, gate: null,
    layers: [
      { type: "cluster", seed: 0x4d12, hz: 5200,
        ratios: [1, 1.34, 1.89, 2.45, 3.01, 3.55],
        filter: "highpass", filterHz: 6000, q: 0.9,
        attackMs: 0.5, holdMs: 1, releaseMs: 350, gain: 0.55 },
    ],
  },
  tomL: {
    lengthMs: 520, peak: 0.85, gate: null,
    layers: [
      { type: "tone", wave: "triangle", hzFrom: 100, hzTo: 50, pitchMs: 200,
        attackMs: 1, holdMs: 40, releaseMs: 280, gain: 0.9 },
      { type: "noise", seed: 0x3c55, filter: "bandpass", filterHz: 800, q: 0.7,
        attackMs: 0.5, holdMs: 1, releaseMs: 20, gain: 0.15 },
    ],
  },
  tomH: {
    lengthMs: 520, peak: 0.85, gate: null,
    layers: [
      { type: "tone", wave: "triangle", hzFrom: 200, hzTo: 100, pitchMs: 200,
        attackMs: 1, holdMs: 40, releaseMs: 280, gain: 0.9 },
      { type: "noise", seed: 0x3c56, filter: "bandpass", filterHz: 800, q: 0.7,
        attackMs: 0.5, holdMs: 1, releaseMs: 20, gain: 0.15 },
    ],
  },
};

export const KIT_NAMES = Object.freeze(Object.keys(KIT));

const TYPES = ["tone", "noise", "cluster"];
const WAVES = ["sine", "triangle"];
const FILTERS = ["highpass", "bandpass"];
const MIN_LENGTH_MS = 20;
const MAX_LENGTH_MS = 600;     // bounds prerender cost, not taste

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => isNum(v) && Number.isInteger(v);

/** Length of a layer's noise buffer / envelope span, in milliseconds. */
function layerSpanMs(layer) {
  return layer.attackMs + layer.holdMs + layer.releaseMs;
}

/**
 * Every violation, as `<hit>: <detail>` with 0-based layer indices.
 * Returns [] for a legal kit; never throws, because a thrown error from a data
 * table tells you about one problem and hides the rest.
 */
export function validateKit(kit = KIT) {
  const problems = [];
  for (const name of Object.keys(kit)) {
    const hit = kit[name];
    const bad = (detail) => problems.push(`${name}: ${detail}`);

    if (!isInt(hit.lengthMs) || hit.lengthMs < MIN_LENGTH_MS || hit.lengthMs > MAX_LENGTH_MS) {
      bad(`lengthMs ${hit.lengthMs} must be an integer in [${MIN_LENGTH_MS}, ${MAX_LENGTH_MS}]`);
    }
    if (!isNum(hit.peak) || !(hit.peak > 0) || hit.peak > 1) {
      bad(`peak ${hit.peak} must be in (0, 1]`);
    }

    if (hit.gate !== null) {
      const gate = hit.gate;
      if (!gate || typeof gate !== "object") {
        bad("gate must be null or an object");
      } else {
        if (!isNum(gate.holdMs) || gate.holdMs < 10) bad(`gate holdMs ${gate.holdMs} < 10`);
        if (!isNum(gate.releaseMs) || gate.releaseMs > 2) bad(`gate releaseMs ${gate.releaseMs} > 2`);
        if (gate.releaseCurve !== "linear") bad(`gate releaseCurve ${gate.releaseCurve} is not linear`);
        if (isNum(gate.holdMs) && isNum(gate.releaseMs)
            && gate.holdMs + gate.releaseMs > hit.lengthMs) {
          bad(`gate ends at ${gate.holdMs + gate.releaseMs}ms, past lengthMs ${hit.lengthMs}`);
        }
      }
    }

    if (!Array.isArray(hit.layers) || hit.layers.length === 0) {
      bad("layers must be a non-empty array");
      continue;
    }

    hit.layers.forEach((layer, index) => {
      const at = `layer ${index}`;
      if (!TYPES.includes(layer.type)) bad(`${at} type ${layer.type}`);
      if (!isNum(layer.gain) || !(layer.gain > 0) || layer.gain > 1) {
        bad(`${at} gain ${layer.gain} must be in (0, 1]`);
      }
      if (!isNum(layer.attackMs) || layer.attackMs < 0.5) bad(`${at} attackMs ${layer.attackMs} < 0.5`);
      if (!isNum(layer.holdMs) || layer.holdMs < 0) bad(`${at} holdMs ${layer.holdMs} < 0`);
      if (!isNum(layer.releaseMs) || layer.releaseMs < 5) bad(`${at} releaseMs ${layer.releaseMs} < 5`);
      if (isNum(layer.attackMs) && isNum(layer.holdMs) && isNum(layer.releaseMs)
          && layerSpanMs(layer) > hit.lengthMs) {
        bad(`${at} envelope ${layerSpanMs(layer)}ms overruns lengthMs ${hit.lengthMs}`);
      }

      if (layer.type === "tone") {
        if (!WAVES.includes(layer.wave)) bad(`${at} wave ${layer.wave}`);
        if (!isNum(layer.hzFrom) || layer.hzFrom <= 0) bad(`${at} hzFrom ${layer.hzFrom} <= 0`);
        if (!isNum(layer.hzTo) || layer.hzTo <= 0) bad(`${at} hzTo ${layer.hzTo} <= 0`);
        if (isNum(layer.hzFrom) && isNum(layer.hzTo) && layer.hzFrom < layer.hzTo) {
          bad(`${at} hzFrom ${layer.hzFrom} < hzTo ${layer.hzTo} (a hit only falls)`);
        }
        if (!isNum(layer.pitchMs) || layer.pitchMs < 0) bad(`${at} pitchMs ${layer.pitchMs} < 0`);
        if (isNum(layer.pitchMs) && layer.pitchMs > hit.lengthMs) {
          bad(`${at} pitchMs ${layer.pitchMs} past lengthMs ${hit.lengthMs}`);
        }
      }

      if (layer.type === "noise") {
        if (!isInt(layer.seed) || layer.seed < 0) bad(`${at} seed ${layer.seed} must be an integer >= 0`);
        if (!FILTERS.includes(layer.filter)) bad(`${at} filter ${layer.filter}`);
        if (!isNum(layer.filterHz) || layer.filterHz <= 20 || layer.filterHz >= 20000) {
          bad(`${at} filterHz ${layer.filterHz} must be in (20, 20000)`);
        }
        if (!isNum(layer.q) || layer.q <= 0.1 || layer.q >= 20) bad(`${at} q ${layer.q} must be in (0.1, 20)`);
      }

      if (layer.type === "cluster") {
        if (!isInt(layer.seed) || layer.seed < 0) bad(`${at} seed ${layer.seed} must be an integer >= 0`);
        if (!isNum(layer.hz) || layer.hz <= 20 || layer.hz >= 20000) {
          bad(`${at} hz ${layer.hz} must be in (20, 20000)`);
        }
        if (!Array.isArray(layer.ratios) || layer.ratios.length < 3) {
          bad(`${at} ratios needs at least 3 partials`);
        } else {
          for (const ratio of layer.ratios) {
            if (!isNum(ratio) || ratio <= 0.5 || ratio > 4) bad(`${at} ratio ${ratio} must be in (0.5, 4]`);
          }
          if (isNum(layer.hz)) {
            const top = Math.max(...layer.ratios);
            if (isNum(top) && layer.hz * top > 20000) {
              bad(`${at} top partial ${Math.round(layer.hz * top)}Hz is above 20000Hz`);
            }
          }
        }
        if (!FILTERS.includes(layer.filter)) bad(`${at} filter ${layer.filter}`);
        if (!isNum(layer.filterHz) || layer.filterHz <= 20 || layer.filterHz >= 20000) {
          bad(`${at} filterHz ${layer.filterHz} must be in (20, 20000)`);
        }
        if (isNum(layer.filterHz) && isNum(layer.hz) && layer.filterHz < layer.hz) {
          bad(`${at} filterHz ${layer.filterHz} is below hz ${layer.hz}`);
        }
        if (!isNum(layer.q) || layer.q <= 0.1 || layer.q >= 20) bad(`${at} q ${layer.q} must be in (0.1, 20)`);
      }
    });
  }
  return problems;
}

/** Xorshift32 into `data` in place, uniform in [-1, 1). No Math.random. */
export function fillNoise(data, seed) {
  let x = (seed >>> 0) || 1;
  for (let i = 0; i < data.length; i += 1) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    data[i] = (x / 0x80000000) - 1;
  }
  return data;
}

// --------------------------------------------------------------- layer graphs

function layerEnvelope(ctx, layer) {
  const g = ctx.createGain();
  const attack = layer.attackMs / 1000;
  const hold = (layer.attackMs + layer.holdMs) / 1000;
  const end = layerSpanMs(layer) / 1000;
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(layer.gain, attack);
  g.gain.setValueAtTime(layer.gain, hold);
  // An exponential ramp cannot reach 0, so it aims at -60 dB and a step to 0
  // follows at the same instant: inaudible, and the buffer really does end.
  g.gain.exponentialRampToValueAtTime(0.001, end);
  g.gain.setValueAtTime(0, end);
  return g;
}

function biquad(ctx, layer) {
  const f = ctx.createBiquadFilter();
  f.type = layer.filter;
  f.frequency.value = layer.filterHz;
  f.Q.value = layer.q;
  return f;
}

function buildLayer(ctx, layer, sampleRate, out) {
  const gain = layerEnvelope(ctx, layer);

  if (layer.type === "tone") {
    const osc = ctx.createOscillator();
    osc.type = layer.wave;
    osc.frequency.setValueAtTime(layer.hzFrom, 0);
    if (layer.pitchMs > 0) {
      osc.frequency.exponentialRampToValueAtTime(layer.hzTo, layer.pitchMs / 1000);
    } else {
      osc.frequency.setValueAtTime(layer.hzTo, 0);
    }
    osc.connect(gain);
    osc.start(0);
  } else if (layer.type === "noise") {
    const frames = Math.ceil(layerSpanMs(layer) / 1000 * sampleRate);
    const buffer = ctx.createBuffer(1, frames, sampleRate);
    fillNoise(buffer.getChannelData(0), layer.seed);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = biquad(ctx, layer);
    source.connect(filter);
    filter.connect(gain);
    source.start(0);
  } else {
    // The metallic ring is the cluster itself: square partials at inharmonic
    // ratios, filtered. No noise source, or it stops sounding like 808 metal
    // and starts sounding like tape hiss.
    const filter = biquad(ctx, layer);
    filter.connect(gain);
    const spread = 1 / layer.ratios.length;
    for (const ratio of layer.ratios) {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(layer.hz * ratio, 0);
      const partial = ctx.createGain();
      partial.gain.value = spread;
      osc.connect(partial);
      partial.connect(filter);
      osc.start(0);
    }
  }

  gain.connect(out);
}

// ------------------------------------------------------------------ rendering

async function renderHit(hit, sampleRate) {
  const frames = Math.ceil(hit.lengthMs / 1000 * sampleRate);
  const ctx = new OfflineAudioContext(1, frames, sampleRate);

  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  const sum = ctx.createGain();
  sum.gain.value = 1;

  if (hit.gate) {
    // Between the layer sum and the hit's output, so the *whole* hit is cut.
    // Linear, because an exponential ramp to zero is illegal and a -60 dB tail
    // would defeat the gate entirely.
    const gate = ctx.createGain();
    gate.gain.setValueAtTime(1, 0);
    gate.gain.setValueAtTime(1, hit.gate.holdMs / 1000);
    gate.gain.linearRampToValueAtTime(0, (hit.gate.holdMs + hit.gate.releaseMs) / 1000);
    sum.connect(gate);
    gate.connect(master);
  } else {
    sum.connect(master);
  }

  for (const layer of hit.layers) buildLayer(ctx, layer, sampleRate, sum);

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);

  let peak = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i] < 0 ? -data[i] : data[i];
    if (v > peak) peak = v;
  }
  if (peak > 0) {
    const k = hit.peak / peak;
    for (let i = 0; i < data.length; i += 1) data[i] *= k;
    rendered.copyToChannel(data, 0);
  }
  return rendered;
}

/**
 * Prerender every hit plus the reverb impulse.
 *
 * One OfflineAudioContext per hit: an offline context renders exactly once, so
 * six buffers out of one context would need a slicing pass and its off-by-one
 * risk. Drums are mono because they are centre-panned; only the impulse is
 * stereo.
 *
 * The returned buffers belong to no playback context; any AudioBufferSourceNode
 * in any context will play them.
 */
export async function renderKit(sampleRate = 48000) {
  const problems = validateKit();
  if (problems.length) throw new Error(`invalid kit: ${problems.join("; ")}`);

  const buffers = {};
  for (const name of KIT_NAMES) buffers[name] = await renderHit(KIT[name], sampleRate);
  const ir = await renderImpulse(sampleRate);
  return { buffers, ir };
}

/**
 * A decorrelated stereo impulse: white noise through a 4 kHz lowpass, faded by
 * an exponential decay that reaches absolute zero on the last sample. Each
 * channel's own seed is what stops the reverb collapsing to the centre.
 *
 * The envelope is applied to the rendered tail rather than to the noise before
 * the filter: a biquad has memory, so shaping the input cannot make the head and
 * the tail of the output exactly zero. Shaping the output can, and does.
 */
export async function renderImpulse(sampleRate = 48000) {
  const seconds = 2.6;
  const frames = Math.ceil(seconds * sampleRate);
  const predelay = Math.round(0.020 * sampleRate);
  const last = frames - 1;

  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 4000;
  filter.Q.value = 0.707;
  filter.connect(ctx.destination);

  // A ChannelMerger is the only way to put a mono source on one side.
  const merger = ctx.createChannelMerger(2);
  merger.connect(filter);

  [0x5e21, 0x5e22].forEach((seed, channel) => {
    const buffer = ctx.createBuffer(1, frames, sampleRate);
    fillNoise(buffer.getChannelData(0), seed);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(merger, 0, channel);
    source.start(0);
  });

  const rendered = await ctx.startRendering();

  for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
    const data = rendered.getChannelData(channel);
    let peak = 0;
    for (let i = 0; i < frames; i += 1) {
      if (i < predelay) {
        data[i] = 0;
        continue;
      }
      data[i] *= Math.exp(-4.5 * i / last) * (1 - i / last);
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > peak) peak = v;
    }
    if (peak > 0) {
      const k = 1 / peak;
      for (let i = 0; i < frames; i += 1) data[i] *= k;
    }
    rendered.copyToChannel(data, channel);
  }
  return rendered;
}
