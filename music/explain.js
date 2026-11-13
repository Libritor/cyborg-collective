// The words the panel prints: signal -> rule -> decision, one row per step.
//
// Pure and DOM-free, so node can assert the strings a page shows. The wording
// lives here and only here: ui.js renders these rows and invents none of them,
// and every threshold below is imported from the module that acts on it, so a
// caption cannot drift from the rule it claims to describe.
//
// The explanations are *generated* from those tables -- GRAMMAR, CRUELTY_ROLLS,
// TIMBRE_RAMPS, TERM_SCALE, WEIGHT_DEFAULTS, VOTE_WEIGHT -- rather than
// transcribed beside them, so a number in a sentence is a number the code reads.

import { NOTE_NAMES } from "./families.js";
import {
  DEVICE_GATES, GRAMMAR, CRUELTY_REFERENCE, CRUELTY_ROLLS, TIMBRE_RAMPS,
  LEAD_HIGH, REGISTER, VOTE_WEIGHT, timbreAt,
} from "./generator.js";
import { WEIGHT_DEFAULTS, TERM_SCALE, TAU } from "./conditioner.js";

/** The rack's display order and accents. `cliche` is the ASCII key the data uses. */
export const DEVICE_LABELS = [
  ["sus", "sus"],
  ["cliche", "cliché"],
  ["drone", "drone"],
  ["mixture", "mixture"],
  ["climb", "climb"],
  ["bII", "bII"],
];

// --------------------------------------------------------------- number words
const n2 = (v) => Number(v).toFixed(2);
const pct = (v) => `${Math.round(v * 100)}%`;

export const noteName = (midi) => `${NOTE_NAMES[(((midi % 12) + 12) % 12)]}${Math.floor(midi / 12) - 1}`;

const displayOf = (key) => {
  const found = DEVICE_LABELS.find(([name]) => name === key);
  return found ? found[1] : key;
};

/** The ladder in one clause, built from DEVICE_GATES: which device opens at what. */
function gateSentence() {
  const names = Object.keys(DEVICE_GATES);
  const always = names.filter((name) => !(DEVICE_GATES[name] > 0));
  const tiers = [...new Set(names.map((name) => DEVICE_GATES[name]).filter((gate) => gate > 0))]
    .sort((a, b) => a - b)
    .map((gate) => `${names.filter((name) => DEVICE_GATES[name] === gate).map(displayOf).join(", ")} from C ${n2(gate)}`);
  return `${always.map(displayOf).join(", ")} is open at any C; ${tiers.join("; ")}.`;
}

/** A timbre field as the arithmetic it is: floor + rise·ramp + linear·C. */
function timbreFormula(name) {
  const r = TIMBRE_RAMPS[name];
  const terms = [];
  if (r.floor) terms.push(`${r.floor}`);          // a "0 +" prefix is noise, not maths
  terms.push(`${r.rise} · ramp((C − ${n2(r.from)}) / ${n2(r.span)})`);
  if (r.linear) terms.push(`${r.linear} · C`);
  return terms.join(" + ");
}

const bassAt = (C) => `${Math.round(timbreAt(C).bassCutoff)} Hz`;

/** What each control does to the bar, in the generator's own terms. */
export const LADDER_RULES = Object.freeze({
  C: `opens devices · hats 8ths → 16ths above ${n2(GRAMMAR.hats16Above)} · sets the timbre`,
  alphaShare: `open hat on the and of 4 · p = ${n2(GRAMMAR.openHatBase)} + α`,
  arousal: `ghost kick before 1 · p = max(0, arousal − ${n2(GRAMMAR.ghostKickAbove)})`,
  motion: `bar-4 fill: toms above ${n2(GRAMMAR.fillTomsAbove)}, else snares`,
  asymmetry: `lead register: at or above ${n2(GRAMMAR.leadHighAbove)} the lead plays high`,
});

/**
 * Every parameter the page prints, with the sentence that explains it and the
 * arithmetic that sentence is about.
 *
 * The panel above and the "what the numbers mean" section below the stage are
 * both generated from this list, so an explanation cannot describe a rule the
 * instrument no longer has: the words live next to the data, and `nodes.js`
 * reads the same table for the graph notes. `label` is the mark the panel
 * stencils (C, α, bpm, cruelty) and `short` says what turning it DOES
 * ("opens the ladder", "sets the tempo") -- a dial labelled only with its mark
 * leaves the reader asking what it modulates. `does` is the one-sentence rule,
 * `how` is the formula and the mechanism, line by line, so a reader who wants
 * the arithmetic finds it without reading the source. `kind` groups a row for
 * the chip; `range` is what the control or the field can hold; `source` says
 * where the number comes from.
 */
export const PARAMETERS = Object.freeze([
  {
    id: "C",
    short: "opens the ladder",
    label: "C",
    kind: "signal",
    range: "0 – 1",
    source: "the weighted sum of the three terms",
    does: "Concentration: the number the grammar reads as pressure. It opens the device ladder, sets the hats, then every timbre below.",
    how: [
      `C = ${n2(WEIGHT_DEFAULTS.engagement)}·engagement + ${n2(WEIGHT_DEFAULTS.activation)}·activation + ${n2(WEIGHT_DEFAULTS.steadiness)}·steadiness, the three weights normalised, so only their ratio matters.`,
      `engagement = (β share − ${n2(TERM_SCALE.betaFloor)}) / ${n2(TERM_SCALE.betaSpan)}: beta as a share of α+θ+β, clamped to 0…1.`,
      "activation = arousal, the relay's activation index.",
      `steadiness = 1 − sd(α share over ${TERM_SCALE.steadinessWindowS} s) / ${n2(TERM_SCALE.alphaSpan)}: how little alpha wandered, and 0.5 when there are fewer than three samples to judge.`,
      gateSentence(),
      `Hats go from 8ths to 16ths above C ${n2(GRAMMAR.hats16Above)}. That same line is what locks the band after ${GRAMMAR.lockBars} bars, and what a release measures its drop against.`,
      `C also sets the sound: bass body = ${timbreFormula("bassCutoff")}, which is ${bassAt(0.3)} at C 0.30, ${bassAt(0.6)} at 0.60 and ${bassAt(0.9)} at 0.90.`,
      `saturation = ${timbreFormula("saturation")}, which is 0 below C ${n2(TIMBRE_RAMPS.saturation.from)} and full at 1.0; the pad's reverb send opens from ${n2(TIMBRE_RAMPS.padSend.from)}, the lead's delay feedback from ${n2(TIMBRE_RAMPS.leadDelayFb.from)}.`,
    ],
  },
  {
    id: "alphaShare",
    short: "opens the hat",
    label: "α",
    kind: "signal",
    range: "0 – 1",
    source: "the headband view (conditioner.js's view)",
    does: "Relative alpha as a share of α+θ+β. The higher it is, the likelier an open hat on the and of 4: p = 0.30 + α, so it can fire at α 0.",
    how: [
      "α share = α / (α + θ + β), with each band the mean relative power over the electrodes that are in contact.",
      `open hat: p = ${n2(GRAMMAR.openHatBase)} + α on step 14, drawn once a bar — ${pct(GRAMMAR.openHatBase)} at α 0, ${pct(GRAMMAR.openHatBase + 0.5)} at α 0.5.`,
      "It reaches C indirectly: a wandering α lowers steadiness, and steadiness is the third term of the sum.",
    ],
  },
  {
    id: "arousal",
    short: "adds a ghost kick",
    label: "arousal",
    kind: "signal",
    range: "0 – 1",
    source: "the headband view (conditioner.js's view)",
    does: "The headband's gated activation. Above 0.60 it adds a ghost kick before the downbeat.",
    how: [
      `arousal = the relay's activation index, 0…1, smoothed over ${TAU.arousal} s: a mood, not a twitch. A band that reports "no_claim" is skipped rather than read as calm.`,
      `ghost kick: p = max(0, arousal − ${n2(GRAMMAR.ghostKickAbove)}) on step 15 — 0 at ${n2(GRAMMAR.ghostKickAbove)}, ${n2(0.8 - GRAMMAR.ghostKickAbove)} at 0.80, ${n2(1 - GRAMMAR.ghostKickAbove)} at 1.00.`,
      `It is also the activation term of C, at weight ${n2(WEIGHT_DEFAULTS.activation)}.`,
    ],
  },
  {
    id: "motion",
    short: "picks the fill",
    label: "motion",
    kind: "signal",
    range: "0 – 1",
    source: "the headband view (conditioner.js's view)",
    does: "Head movement from the IMU. Above 0.05 the bar-4 fill is toms; below it, snares.",
    how: [
      `motion = | ‖accel‖ − 1 g |, smoothed over ${TAU.motion} s: how far the head is from still.`,
      `On bar 4 of every 4-bar phrase the fill is four toms above ${n2(GRAMMAR.fillTomsAbove)}, four snares below. It is the only binary in the grammar.`,
      "It does not enter C: movement changes what the drums do, not how hard the band plays.",
    ],
  },
  {
    id: "asymmetry",
    short: "sets the lead range",
    label: "asymmetry",
    kind: "signal",
    range: "−1 – 1",
    source: "the headband view (conditioner.js's view)",
    does: "Frontal asymmetry, right minus left. At or above 0 the lead is kept in the top of its range; below it, the whole octave.",
    how: [
      "asymmetry = (relα AF8 − relα AF7) / (|relα AF8| + |relα AF7|), clamped to ±1: right frontal minus left, scaled by their size so a louder head is not a different head.",
      `At or above ${n2(GRAMMAR.leadHighAbove)} the lead's window is ${noteName(LEAD_HIGH[0])}..${noteName(LEAD_HIGH[1])}; below it, the wider ${noteName(REGISTER.lead[0])}..${noteName(REGISTER.lead[1])}.`,
      "It does not enter C.",
    ],
  },
  {
    id: "bpm",
    short: "sets the tempo",
    label: "bpm",
    kind: "transport",
    range: "90 – 160",
    source: "the transport",
    does: "Tempo. Like cruelty, it belongs to the transport: the Muse has no say in it.",
    how: [
      "Not modulated by the Muse. nextBar takes the tempo from the transport, so a heart rate of 71 does not make a 71 bpm bar.",
      "The scheduler polls the tempo once per bar, at the downbeat: a bar keeps one grid for its sixteen steps and never drifts mid-bar.",
      `The headband's own pulse and rmssd (HR frame, smoothed over ${TAU.hr} s) are measured and printed in the heads strip, but they set nothing.`,
      "90–160, 132 by default; an idle catalogue row can seed its own tempo.",
    ],
  },
  {
    id: "cruelty",
    short: "how jarring it gets",
    label: "cruelty",
    kind: "transport",
    range: "0 – 0.6",
    source: "the transport",
    does: "How far the band reaches for the jarring device: mode mixture and the phrygian bII, scaled against the published band.",
    how: [
      `k = cruelty / ${n2(CRUELTY_REFERENCE)}, capped at 4. At ${n2(CRUELTY_REFERENCE)} k is exactly 1 and the bars are bit-identical to the published band: the default is a reference point, not a taste.`,
      `mode mixture: p = min(${n2(CRUELTY_ROLLS.mixture.cap)}, ${n2(CRUELTY_ROLLS.mixture.base)}·k) on a IV or iv step — 0 at cruelty 0, ${pct(CRUELTY_ROLLS.mixture.base)} at ${n2(CRUELTY_REFERENCE)}, and capped at ${pct(CRUELTY_ROLLS.mixture.cap)} from cruelty ${n2((CRUELTY_ROLLS.mixture.cap / CRUELTY_ROLLS.mixture.base) * CRUELTY_REFERENCE)}.`,
      `bII, the phrygian Neapolitan, minor families only: p = min(${n2(CRUELTY_ROLLS.bII.cap)}, ${n2(CRUELTY_ROLLS.bII.base)}·k) — 0 at cruelty 0, ${pct(CRUELTY_ROLLS.bII.base)} at ${n2(CRUELTY_REFERENCE)}, ${pct(Math.min(CRUELTY_ROLLS.bII.cap, CRUELTY_ROLLS.bII.base * 4))} at 0.60.`,
      "Both rolls are drawn before the comparison and drawn the same number of times whatever the thresholds are, so raising cruelty can only turn more of the same rolls into hits: it never takes away a device that fired at a lower setting, on the same seed and the same C.",
    ],
  },
  {
    id: "weights",
    short: "what counts toward C",
    label: "weights",
    kind: "weight",
    range: "0 – 1 each",
    source: "the three sliders",
    does: "What engagement, activation and steadiness count for. Normalised, so only the ratio matters.",
    how: [
      `Default ${n2(WEIGHT_DEFAULTS.engagement)} / ${n2(WEIGHT_DEFAULTS.activation)} / ${n2(WEIGHT_DEFAULTS.steadiness)}, normalised: 0.8 / 0.6 / 0.6 weighs exactly as 0.4 / 0.3 / 0.3.`,
      "A slider writes the triple and the sum is re-drawn from the last bar's terms in the same frame; the band follows at its next bar, because C is read once per bar and held for it.",
      "Kept in localStorage (margoth.concWeights). With no headband the three terms are solved back from the C slider, so re-weighting still moves the band on the solo page.",
    ],
  },
  {
    id: "bands",
    short: "the raw powers",
    label: "bands",
    kind: "raw",
    range: "—",
    source: "the relay frame",
    does: "δ θ γ are mean relative power per electrode; α and β are shares of α+θ+β.",
    how: [
      "Each band is the mean of that band's relative power over the electrodes in contact, so a head with two good electrodes is still one head.",
      `Smoothed per band over ${TAU.bands} s, so a single noisy frame never moves a bar.`,
      "They are what the three terms are made of: engagement from β, steadiness from how much α wanders.",
    ],
  },
  {
    id: "hsi",
    short: "electrode contact",
    label: "hsi",
    kind: "raw",
    range: "1 – 4",
    source: "the relay frame",
    does: "Electrode contact quality, per electrode. An electrode only counts when its code is 1 or 2.",
    how: [
      `1 good, 2 ok, 3 poor, 4 none, for each of ${"TP9, AF7, AF8, TP10"}.`,
      "An electrode counts only when its code is 1 or 2; if none do, the head is out of contact and its values are held rather than taken as zero.",
      `Out of contact a head still weighs ${VOTE_WEIGHT.silent} against a contact head's ${VOTE_WEIGHT.contact}: present in the cast, not able to outvote a seated one. Only a head that leaves stops voting.`,
    ],
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
    does: "A sus4 chord on step 8 that resolves back on step 12, one bar in four, never on the last 8th, and never where its 4th would sit a semitone from the pedal.",
  },
  {
    id: "cliche",
    gate: DEVICE_GATES.cliche,
    does: "One voice steps down from the root to the flat 7th inside the held root, and the pad yields an octave.",
  },
  {
    id: "drone",
    gate: DEVICE_GATES.drone,
    does: "A tonic pedal in the tenor register, held clear of the bass. It rests in any bar whose chord has a note a semitone from it.",
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
