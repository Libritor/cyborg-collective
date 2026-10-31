// The words the panel prints: signal -> rule -> decision, one row per step.
//
// Pure and DOM-free, so node can assert the strings a page shows. The wording
// lives here and only here: ui.js renders these rows and invents none of them,
// and every threshold below is imported from the module that acts on it, so a
// caption cannot drift from the rule it claims to describe.

import { NOTE_NAMES } from "./families.js";
import {
  DEVICE_GATES, LEAD_HIGH, REGISTER,
} from "./generator.js";

/** The rack's display order and accents. `cliche` is the ASCII key the data uses. */
export const DEVICE_LABELS = [
  ["sus", "sus"],
  ["cliche", "cliché"],
  ["drone", "drone"],
  ["mixture", "mixture"],
  ["climb", "climb"],
  ["bII", "bII"],
];

/** What each control does to the bar, in the generator's own terms. */
export const LADDER_RULES = Object.freeze({
  C: "opens devices · hats 8ths → 16ths above 0.60 · sets the timbre",
  alphaShare: "open hat on the and of 4 · p = 0.30 + α",
  arousal: "ghost kick before 1 · p = max(0, arousal − 0.60)",
  motion: "bar-4 fill: toms above 0.05, else snares",
  asymmetry: "lead register: at or above 0 the lead plays high",
});

/**
 * Every parameter the page prints, once, with the sentence that explains it.
 *
 * The panel above and the "what the numbers mean" section below the stage are
 * both generated from this list, so an explanation cannot describe a rule the
 * instrument no longer has: the words live next to the data, and `nodes.js`
 * reads the same table for the graph notes. `kind` groups a row for the chip
 * (`signal`, `transport`, `weight`, `raw`); `range` is what the control or the
 * field can actually hold; `source` says where the number comes from.
 */
export const PARAMETERS = Object.freeze([
  {
    id: "C",
    label: "C",
    kind: "signal",
    range: "0 – 1",
    source: "the weighted sum of the three terms",
    does: "Sets the whole ladder: how many of the six devices are open, 8th or 16th hats, and every timbre below.",
  },
  {
    id: "alphaShare",
    label: "α",
    kind: "signal",
    range: "0 – 1",
    source: "the headband view (conditioner.js's view)",
    does: "Relative alpha as a share of α+θ+β. After 0.30 it opens a hat on the and of 4.",
  },
  {
    id: "arousal",
    label: "arousal",
    kind: "signal",
    range: "0 – 1",
    source: "the headband view (conditioner.js's view)",
    does: "The headband's gated activation. Above 0.60 it adds a ghost kick before the downbeat.",
  },
  {
    id: "motion",
    label: "motion",
    kind: "signal",
    range: "0 – 1",
    source: "the headband view (conditioner.js's view)",
    does: "Head movement from the IMU. Above 0.05 the bar-4 fill is toms; below it, snares.",
  },
  {
    id: "asymmetry",
    label: "asymmetry",
    kind: "signal",
    range: "−1 – 1",
    source: "the headband view (conditioner.js's view)",
    does: "AF8 minus AF7 relative alpha. At or above 0 the lead plays high; below it, down an octave.",
  },
  {
    id: "bpm",
    label: "bpm",
    kind: "transport",
    range: "90 – 160",
    source: "the transport",
    does: "Tempo. The scheduler keeps one grid per bar and changes it only at a downbeat.",
  },
  {
    id: "cruelty",
    label: "cruelty",
    kind: "transport",
    range: "0 – 0.6",
    source: "the transport",
    does: "How far the band reaches for the jarring device: mode mixture and bII fire at 0.25×k and 0.12×k, where k = cruelty / 0.15. At 0.15 it is the published band.",
  },
  {
    id: "weights",
    label: "weights",
    kind: "weight",
    range: "0 – 1 each",
    source: "the three sliders",
    does: "What engagement, activation and steadiness count for. Normalised, so only the ratio matters.",
  },
  {
    id: "bands",
    label: "bands",
    kind: "raw",
    range: "—",
    source: "the relay frame",
    does: "δ θ γ are mean relative power per electrode; α and β are shares of α+θ+β.",
  },
  {
    id: "hsi",
    label: "hsi",
    kind: "raw",
    range: "1 – 4",
    source: "the relay frame",
    does: "Electrode contact: 1 good, 2 ok, 3 poor, 4 none. Under 3 of 4 in contact the sharer has no vote.",
  },
]);

/** The parameter entry for an id, or null: one lookup, so no page re-invents it. */
export function parameterFor(id) {
  return PARAMETERS.find((entry) => entry.id === id) || null;
}

/**
 * The six devices, in rack order, with the gate that opens them and the rule
 * they play. `gate` is read from the generator's table rather than restated, so
 * a threshold moved in the grammar moves the page with it.
 */
export const DEVICE_DOCS = Object.freeze([
  {
    id: "sus",
    gate: DEVICE_GATES.sus,
    does: "A sus4 chord on step 8 that resolves back on step 12, one bar in four, never on the last 8th.",
  },
  {
    id: "cliche",
    gate: DEVICE_GATES.cliche,
    does: "The 7th descends a semitone inside the held root, and the pad yields an octave.",
  },
  {
    id: "drone",
    gate: DEVICE_GATES.drone,
    does: "A tonic pedal in the tenor register, held clear of the bass.",
  },
  {
    id: "mixture",
    gate: DEVICE_GATES.mixture,
    does: "The subdominant swaps major for minor.",
  },
  {
    id: "climb",
    gate: DEVICE_GATES.climb,
    does: "The bar is a bII or bIII of the phrygian path: the climb.",
  },
  {
    id: "bII",
    gate: DEVICE_GATES.bII,
    does: "The phrygian Neapolitan: the flattest second the mode has.",
  },
]);

const DASH = "—";
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fx = (v, digits = 2) => (v == null ? DASH : v.toFixed(digits));
const signed = (d, digits = 2) => `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(digits)}`;
const counts = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export const noteName = (midi) => `${NOTE_NAMES[(((midi % 12) + 12) % 12)]}${Math.floor(midi / 12) - 1}`;

const displayOf = (key) => {
  const found = DEVICE_LABELS.find(([name]) => name === key);
  return found ? found[1] : key;
};

const hasHit = (bar, hit, step) => Array.isArray(bar.drums)
  && bar.drums.some((h) => h && h.hit === hit && h.step === step);

/**
 * The five rows the panel prints above the chain: for each control, its value,
 * the rule it feeds, and what that rule did in this bar. `flag` marks a
 * probabilistic outcome that actually fired (true) or did not (false); rules
 * with no roll of their own carry null.
 */
export function ladderRows(controls = {}, bar = {}) {
  const mix = controls || {};
  const at = bar || {};

  const C = num(mix.C);
  const open = Object.keys(DEVICE_GATES).filter((key) => (C == null ? 0 : C) >= DEVICE_GATES[key]);
  const hats = (C == null ? 0 : C) > 0.6 ? "16th hats" : "8th hats";

  const alphaShare = num(mix.alphaShare);
  const alphaRoll = clamp01(alphaShare == null ? 0 : alphaShare);
  const openHat = hasHit(at, "hatO", 14);

  const arousal = num(mix.arousal);
  const arousalRoll = clamp01(arousal == null ? 0 : arousal);
  const ghostKick = hasHit(at, "kick", 15);

  const motion = num(mix.motion);
  const index = num(at.index) ?? 0;
  const left = ((3 - (index % 4)) + 4) % 4;
  const fillHits = Array.isArray(at.drums) ? at.drums : [];
  const toms = fillHits.some((h) => h && (h.hit === "tomL" || h.hit === "tomH"));

  const asymmetry = num(mix.asymmetry);
  const high = (asymmetry == null ? 0 : asymmetry) >= 0;
  const [lo, hi] = high ? LEAD_HIGH : REGISTER.lead;
  const leadNotes = Array.isArray(at.lead) ? at.lead.length : 0;

  return [
    {
      signal: "C",
      label: "C",
      value: fx(C),
      rule: LADDER_RULES.C,
      state: `${open.length}/${Object.keys(DEVICE_GATES).length} open: `
        + `${open.map(displayOf).join(", ") || "none"} · ${hats}`,
      flag: null,
    },
    {
      signal: "alphaShare",
      label: "α",
      value: fx(alphaShare),
      rule: LADDER_RULES.alphaShare,
      state: `p ${(0.3 + alphaRoll).toFixed(2)} · ${openHat ? "open hat at step 14" : "none this bar"}`,
      flag: openHat,
    },
    {
      signal: "arousal",
      label: "arousal",
      value: fx(arousal),
      rule: LADDER_RULES.arousal,
      state: `p ${Math.max(0, arousalRoll - 0.6).toFixed(2)} · `
        + `${ghostKick ? "ghost kick at step 15" : "none this bar"}`,
      flag: ghostKick,
    },
    {
      signal: "motion",
      label: "motion",
      value: fx(motion),
      rule: LADDER_RULES.motion,
      // bar 4 of every phrase carries the fill: while it is still ahead, say how
      // far ahead; on the bar itself, say what the grammar actually played
      state: left === 0 ? (toms ? "toms" : "snares") : `fill in ${left} bar${left === 1 ? "" : "s"}`,
      flag: null,
    },
    {
      signal: "asymmetry",
      label: "asym",
      value: asymmetry == null ? DASH : signed(asymmetry),
      rule: LADDER_RULES.asymmetry,
      state: `${noteName(lo)}..${noteName(hi)} · ${leadNotes} notes`,
      flag: null,
    },
  ];
}

/** The five timbre fields the panel prints, labelled once for both pages. */
export const TIMBRE_LABELS = Object.freeze([
  ["bassCutoff", "bass body", 0],
  ["padCutoff", "pad cutoff", 0],
  ["padSend", "pad reverb", 2],
  ["leadDelayFb", "delay feedback", 2],
  ["saturation", "saturation", 2],
]);

const TIMBRE_FORMAT = {
  bassCutoff: (v) => `${Math.round(v)} Hz`,
  padCutoff: (v) => `${Math.round(v)} Hz`,
  padSend: (v) => v.toFixed(2),
  leadDelayFb: (v) => v.toFixed(2),
  saturation: (v) => v.toFixed(2),
};

/**
 * What C changes in the sound rather than in the grammar. The delta is against
 * the previous bar's timbre, which is the only place a glide is visible.
 */
export function timbreRows(timbre, previous = null) {
  const now = timbre || {};
  return TIMBRE_LABELS.map(([key, label]) => {
    const digits = key === "bassCutoff" || key === "padCutoff" ? 0 : 2;
    const value = num(now[key]);
    const before = previous ? num(previous[key]) : null;
    const delta = value == null || before == null ? null : signed(value - before, digits);
    return { key, label, value: value == null ? DASH : TIMBRE_FORMAT[key](value), delta };
  });
}

const ROLE_FOR_VOICE = { drums: "drums", bass: "bass", pad: "harmony", lead: "lead" };

/** One row per voice: what drove it, how many notes it played, and what they were. */
export function voiceRows(bar = {}, options = {}) {
  const { muted = [], roles = {} } = options || {};
  const at = bar || {};
  const drums = Array.isArray(at.drums) ? at.drums : [];
  const bass = Array.isArray(at.bass) ? at.bass : [];
  const lead = Array.isArray(at.lead) ? at.lead : [];
  const voicing = Array.isArray(at.chords) && at.chords[0] && Array.isArray(at.chords[0].voicing)
    ? at.chords[0].voicing
    : [];
  const gone = (name) => Array.isArray(muted) && muted.includes(name);

  const rows = [
    { voice: "drums", drivenBy: "C · arousal · α", count: drums.length, detail: counts(drums.length, "hit") },
    {
      voice: "bass",
      drivenBy: "chord · cliché",
      count: bass.length,
      detail: `${counts(bass.length, "note")}${bass.length ? ` · ${noteName(bass[0].midi)}` : ""}`,
    },
    {
      voice: "drone",
      drivenBy: "drone device",
      count: at.drone == null ? 0 : 1,
      detail: at.drone == null ? "off" : noteName(at.drone),
    },
    {
      voice: "pad",
      drivenBy: "chord voicing",
      count: voicing.length,
      detail: voicing.length ? voicing.map(noteName).join(" ") : DASH,
    },
    {
      voice: "lead",
      drivenBy: "asymmetry",
      count: lead.length,
      detail: `${counts(lead.length, "note")}${gone("lead") ? " · muted" : ""}`,
    },
  ];

  // The relay casts wizards to {drums, bass, harmony, lead}; the band has five
  // voices. Resolving on the voice name alone left the pad's wizard invisible and
  // the harmony role unshown, so the mapping is explicit here.
  return rows.map((row) => ({
    ...row,
    role: roles && roles[ROLE_FOR_VOICE[row.voice]] != null ? roles[ROLE_FOR_VOICE[row.voice]] : null,
  }));
}
