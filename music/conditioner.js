// Feature conditioning for MarGoth: EMA -> hold on missing -> staleness ladder.
//
// Three rules, one per failure mode, and they are the whole point of this file:
//   * smooth   -- physiology jitters; music should not
//   * hold     -- a dropped packet means "the world did not change", never zero
//   * ladder   -- silence is graded, and a dead sharer eventually stops voting

export const TAU = {
  motion: 0.25,   // fills and dynamics: must feel immediate
  bands: 1.2,     // per band per channel
  alpha: 1.5,     // harmony / lead controls
  arousal: 3.0,   // a mood, not a twitch
  hr: 8.0,        // pulse and HRV are slow by nature
};

export const HOLD_S = 1.5;    // gaps longer than this are reported as held
export const STALE_S = 6.0;   // a role this stale is offered to another head
export const DECAY_S = 10.0;  // a solo wizard's concentration bleeds from here
export const DECAY_TAU = 6.0; // and keeps bleeding slowly, never to zero abruptly
export const C_FLOOR = 0.1;   // what it settles to: a hypnotic root vamp

export const CHANNELS = ["TP9", "AF7", "AF8", "TP10"];
export const BANDS = ["delta", "theta", "alpha", "beta", "gamma"];
const CONTACT = new Set([1, 2]);   // hsi 1 good, 2 ok; 3 poor, 4 none

// What the three concentration terms weigh. Only their ratio matters -- they are
// normalised -- which is what lets a page re-weight them without changing what a
// weight *means*: 0.4/0.3/0.3 and 1/1/1 both sum to one.
export const WEIGHT_DEFAULTS = Object.freeze({ engagement: 0.4, activation: 0.3, steadiness: 0.3 });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Three non-negative finite weights summing to 1; bad terms fall back one by one. */
export function normaliseWeights(weights = {}) {
  const pick = (key) => {
    const value = weights ? weights[key] : undefined;
    return Number.isFinite(value) && value >= 0 ? value : WEIGHT_DEFAULTS[key];
  };
  const terms = {
    engagement: pick("engagement"),
    activation: pick("activation"),
    steadiness: pick("steadiness"),
  };
  const sum = terms.engagement + terms.activation + terms.steadiness;
  if (!Number.isFinite(sum) || sum <= 0) return { ...WEIGHT_DEFAULTS };
  return {
    engagement: terms.engagement / sum,
    activation: terms.activation / sum,
    steadiness: terms.steadiness / sum,
  };
}

let CURRENT_WEIGHTS = normaliseWeights(WEIGHT_DEFAULTS);

/** The weights in force, frozen: a caller cannot re-weight the band by accident. */
export function getConcentrationWeights() {
  return Object.freeze({ ...CURRENT_WEIGHTS });
}

/** Merge a partial over the weights in force, normalise, and report what landed. */
export function setConcentrationWeights(partial) {
  CURRENT_WEIGHTS = normaliseWeights({ ...CURRENT_WEIGHTS, ...(partial || {}) });
  return getConcentrationWeights();
}

function smooth(prev, next, dt, tau) {
  if (prev === undefined || prev === null) return next;
  if (!(dt > 0)) return next;
  return prev + (1 - Math.exp(-dt / tau)) * (next - prev);
}

export function createSharer(pseudonym) {
  return {
    pseudonym,
    at: null,              // last frame of any kind
    hsi: {},               // channel -> contact code
    rel: {},               // channel -> {band: value}
    arousal: null,
    bpm: null,
    rmssd: null,
    motion: null,          // |accel| - 1g, smoothed
    alphaHistory: [],      // [[t, alphaShare]] for the steadiness term
    frames: 0,
  };
}

/** Fold one relay frame into a sharer's conditioned state. */
export function push(sharer, frame, now) {
  const kind = frame && frame.t;
  const dt = sharer.at === null ? null : now - sharer.at;
  switch (kind) {
    case "quality": {
      const hsi = (frame.hsi && typeof frame.hsi === "object") ? frame.hsi : {};
      for (const ch of CHANNELS) {
        const code = hsi[ch];
        sharer.hsi[ch] = Number.isInteger(code) ? code : null;
      }
      break;
    }
    case "bands": {
      const rel = (frame.rel && typeof frame.rel === "object") ? frame.rel : {};
      for (const ch of CHANNELS) {
        const row = rel[ch] && typeof rel[ch] === "object" ? rel[ch] : {};
        const target = sharer.rel[ch] || (sharer.rel[ch] = {});
        for (const band of BANDS) {
          const value = row[band];
          if (typeof value === "number" && Number.isFinite(value)) {
            target[band] = smooth(target[band], value, dt, TAU.bands);
          }
        }
      }
      break;
    }
    case "arousal": {
      if (typeof frame.index === "number" && Number.isFinite(frame.index)
          && frame.label !== "no_claim") {
        sharer.arousal = smooth(sharer.arousal, clamp(frame.index, 0, 1), dt, TAU.arousal);
      }
      break;
    }
    case "hr": {
      if (frame.ok) {
        if (typeof frame.bpm === "number") sharer.bpm = smooth(sharer.bpm, frame.bpm, dt, TAU.hr);
        if (typeof frame.rmssd_ms === "number") {
          sharer.rmssd = smooth(sharer.rmssd, frame.rmssd_ms, dt, TAU.hr);
        }
      }
      break;
    }
    case "imu": {
      const accel = Array.isArray(frame.accel) ? frame.accel : null;
      if (accel && accel.length >= 3 && accel.every((v) => typeof v === "number")) {
        const norm = Math.hypot(accel[0], accel[1], accel[2]);
        sharer.motion = smooth(sharer.motion, Math.abs(norm - 1), dt, TAU.motion);
      }
      break;
    }
    case "leave":
      return clear(sharer);
    default:
      break;
  }
  sharer.at = now;
  sharer.frames += 1;
  return sharer;
}

export function clear(sharer) {
  sharer.at = null;
  sharer.hsi = {};
  sharer.rel = {};
  sharer.arousal = null;
  sharer.bpm = null;
  sharer.rmssd = null;
  sharer.motion = null;
  sharer.alphaHistory = [];
  return sharer;
}

export function contactChannels(sharer) {
  return CHANNELS.filter((ch) => CONTACT.has(sharer.hsi[ch]));
}

function shareOf(sharer, band, channels) {
  const picks = channels
    .map((ch) => (sharer.rel[ch] ? sharer.rel[ch][band] : undefined))
    .filter((v) => typeof v === "number");
  if (!picks.length) return null;
  return picks.reduce((a, b) => a + b, 0) / picks.length;
}

/**
 * The conditioned view a sharer exposes. `held` means "no frame recently, the
 * values are the last ones we had", which is a normal state, not an error.
 */
export function view(sharer, now) {
  const age = sharer.at === null ? Infinity : Math.max(0, now - sharer.at);
  const channels = contactChannels(sharer);
  const inContact = channels.length > 0;

  const rel = { alpha: shareOf(sharer, "alpha", channels) };
  const alpha = rel.alpha;
  const theta = shareOf(sharer, "theta", channels);
  const beta = shareOf(sharer, "beta", channels);
  const delta = shareOf(sharer, "delta", channels);

  let alphaShare = null;
  if (typeof alpha === "number") {
    const denom = (alpha || 0) + (theta || 0) + (beta || 0);
    if (denom > 0) alphaShare = alpha / denom;
  }
  let betaShare = null;
  if (typeof beta === "number") {
    const denom = (alpha || 0) + (theta || 0) + (beta || 0);
    if (denom > 0) betaShare = beta / denom;
  }

  // frontal asymmetry: AF8 minus AF7 relative alpha, normalised to [-1, 1]
  let asymmetry = null;
  if (inContact && sharer.rel.AF7 && sharer.rel.AF8) {
    const right = sharer.rel.AF8.alpha;
    const left = sharer.rel.AF7.alpha;
    if (typeof right === "number" && typeof left === "number") {
      const sum = Math.abs(right) + Math.abs(left);
      if (sum > 0) asymmetry = clamp((right - left) / sum, -1, 1);
    }
  }

  // steadiness: how little the alpha share has wandered over the last 8 s
  if (typeof alphaShare === "number") {
    const history = sharer.alphaHistory;
    history.push([now, alphaShare]);
    while (history.length && now - history[0][0] > 8) history.shift();
  }
  let steadiness = 0.5;
  if (sharer.alphaHistory.length >= 3) {
    const values = sharer.alphaHistory.map(([, v]) => v);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    steadiness = 1 - clamp(Math.sqrt(variance) / 0.12, 0, 1);
  }

  const out = {
    pseudonym: sharer.pseudonym,
    age,
    held: age > HOLD_S,
    stale: age > STALE_S,
    gone: sharer.at === null,
    inContact,
    channels,
    alphaShare,
    betaShare,
    theta,
    delta,
    gamma: shareOf(sharer, "gamma", channels),
    asymmetry,
    steadiness,
    arousal: sharer.arousal,
    motion: sharer.motion,
    bpm: sharer.bpm,
    rmssd: sharer.rmssd,
  };
  // C belongs on the view, not on a second call nobody makes: aggregate() sums
  // per-sharer C, and a view without it collapsed every bar to a constant 0.3,
  // which kept the cliché, the climb and the release permanently locked out.
  out.C = concentration(out);
  return out;
}

/**
 * The three terms a single number stands in for -- what the page uses when there
 * is no headband and the sliders are the wizard. Chosen so the *default* weights
 * reproduce C exactly (measured: |sum - C| <= 1.1e-16 across 0..1) while the
 * three are not equal, so a re-weighting actually moves C. Without that, a page
 * with one slider would have nothing for its weight sliders to weigh.
 */
export function partsFromConcentration(C) {
  const value = Number.isFinite(C) ? clamp(C, 0, 1) : 0;
  const engagement = Math.min(1, 1.5 * value);
  const activation = value;
  // solved from the default weights: 0.4·e + 0.3·a + 0.3·s = C
  const steadiness = clamp((0.7 * value - 0.4 * engagement) / 0.3, 0, 1);
  return { engagement, activation, steadiness, age: 0 };
}

/**
 * The three terms of C, before they are weighted: what the panel shows so the
 * number is not a black box, and what a re-weighting is applied to.
 */
export function concentrationParts(v) {
  const view = v || {};
  const betaShare = view.betaShare === null || view.betaShare === undefined ? null : view.betaShare;
  return {
    engagement: betaShare === null ? 0.3 : clamp((betaShare - 0.15) / 0.35, 0, 1),
    activation: view.arousal === null || view.arousal === undefined ? 0.3 : clamp(view.arousal, 0, 1),
    steadiness: typeof view.steadiness === "number" ? view.steadiness : 0.5,
    age: typeof view.age === "number" ? view.age : Infinity,
  };
}

/**
 * C from its parts and the weights in force. The decay is applied to the
 * weighted sum and is deliberately *not* re-clamped: a stale wizard bleeds
 * toward C_FLOOR rather than snapping to it.
 */
export function concentrationFromParts(parts, weights = getConcentrationWeights()) {
  const w = weights || getConcentrationWeights();
  const p = parts || {};
  const raw = clamp(
    w.engagement * p.engagement + w.activation * p.activation + w.steadiness * p.steadiness,
    0,
    1,
  );
  if (p.age > DECAY_S) {
    const bleed = Math.exp(-(p.age - DECAY_S) / DECAY_TAU);
    return C_FLOOR + (raw - C_FLOOR) * bleed;
  }
  return raw;
}

/**
 * Concentration in [0, 1]: task engagement, activation and steadiness.
 * Decays toward C_FLOOR when the signal has been gone past DECAY_S, so a solo
 * wizard who takes the headband off leaves a hypnotic vamp, not a frantic loop.
 */
export function concentration(v) {
  return concentrationFromParts(concentrationParts(v));
}
