// MarGoth's chain: conditioned controls -> one bar of music.
//
// The generator is pure and deterministic: same seed + same controls produce the
// same bar, always. It owns harmony (families, devices, voice leading), the bass
// figure and the drum grammar; the audio engine only plays what it says. Pressure
// raises *device density and timbre*, never chord frequency -- goth holds a chord
// and puts the movement inside it.

import {
  FAMILIES, EXIT_CADENCE, QUALITY, chordLabel, baseOffset, familyById,
} from "./families.js";
import { C_FLOOR, DECAY_S } from "./conditioner.js";

export const STEPS_PER_BAR = 16;
export const REGISTER = {
  bass: [33, 44],        // A1..G#2 -- a single octave, because a bass figure
                         // needs root and fifth to be in the same register
  drone: [45, 57],       // A2..A3 -- tenor, above the bass, never doubled
  pad: [60, 76],         // C4..E5
  padYielding: [48, 64], // an octave down while a device owns the top voice
  lead: [69, 81],        // A4..A5
};
export const DRONE_INTERVAL = 0;  // the tonic, as an open string: the pedal goth
                                  // guitar actually rings, and the note a band
                                  // pedals under every chord
// The rule the drone must obey: it never shares the bass's register, so nothing
// is muddy and nothing cancels. A fifth pedal was tried first and it collided
// with the bass's own fifth (E2 under an A minor bar); the tonic, an octave and
// a half up, is both the right sound and the safe one.
export const DRONE_MIN_GAP = 12;  // semitones between the drone and the bass top
export const VOICE_BUDGET = 5;    // semitones of movement a change may cost

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable seed from a session stamp, so the record can be replayed as itself. */
export function seedFromText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(text).length; i += 1) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createGenerator({ seed = 1, tonicMidi = 57, bpm = 132, cruelty = 0.15,
  pinFamily = null } = {}) {
  return {
    seed, tonicMidi, bpm, cruelty,
    pinFamily,          // tests pin a family; production never sets it
    rng: mulberry32(seed),
    bar: 0,
    family: null,
    alt: false,
    pos: 0,
    barsLeft: 0,
    current: null,
    previous: null,
    exit: [],
    armed: false,
    peak: null,
    locked: 0,
    cHistory: [],
    familyCounts: {},
    phrases: 0,
  };
}

// ------------------------------------------------------------------ registers
/**
 * Fold a pitch into a window that is at most one octave wide.
 * Strict on the top edge: allowing `hi + 11` made an [33,45] "bass" window
 * actually reach 56, so roots landed at A2..G3, the fifth of i came out at E3,
 * and iv's root folded straight onto the drone's pitch. A single octave is the
 * only thing that keeps root and fifth in the same register.
 */
function fold(midi, [lo, hi]) {
  let m = midi;
  while (m < lo) m += 12;
  while (m > hi) m -= 12;
  return m;
}

function voicings(root, quality, [lo, hi]) {
  const intervals = QUALITY[quality] || QUALITY.min;
  const pcs = intervals.map((i) => ((root + i) % 12 + 12) % 12);
  const out = [];
  for (let inv = 0; inv < pcs.length; inv += 1) {
    const ordered = pcs.slice(inv).concat(pcs.slice(0, inv));
    let note = lo + ((ordered[0] - lo % 12) + 12) % 12;
    const chord = [];
    for (let i = 0; i < ordered.length; i += 1) {
      if (i > 0) {
        let candidate = note + 1;
        while (((candidate % 12) + 12) % 12 !== ordered[i]) candidate += 1;
        note = candidate;
      }
      chord.push(note);
    }
    if (chord[chord.length - 1] <= hi) out.push(chord);
  }
  return out;
}

/**
 * How far the pad's voices move, measured on *shape*, not on absolute pitch.
 * Absolute MIDI made every deliberate register shift (the cliché dropping the
 * pad an octave so it stops fighting the lead) look like a 46-semitone jump, so
 * the budget rejected the signature device and the chord never changed at all.
 * A register move is orchestration; voice leading is which voice goes where.
 */
export function movementCost(prev, next) {
  if (!prev || !prev.length || !next || !next.length) return 0;
  const shape = (chord) => chord.map((m) => m - Math.min(...chord));
  const a = shape(prev);
  const b = shape(next);
  const pairs = Math.min(a.length, b.length);
  let total = Math.abs(a.length - b.length) * 2;   // an added voice costs
  for (let i = 0; i < pairs; i += 1) total += Math.abs(a[i] - b[i]);
  return total;
}

function chooseVoicing(previous, root, quality, range) {
  const candidates = voicings(root, quality, range)
    .map((chord) => ({ chord, cost: movementCost(previous, chord) }))
    .sort((a, b) => a.cost - b.cost
      || (a.chord[a.chord.length - 1] - a.chord[0]) - (b.chord[b.chord.length - 1] - b.chord[0]));
  if (!candidates.length) return { voicing: null, cost: 0, rejected: [] };
  const best = candidates[0];
  return {
    voicing: best.chord,
    cost: best.cost,
    rejected: candidates.slice(1).map((c) => ({ voicing: c.chord, cost: c.cost })),
  };
}

// --------------------------------------------------------------------- chords
function buildChord(gen, step, base, cliche) {
  const root = gen.tonicMidi + baseOffset(base) + step.deg;
  const range = cliche ? REGISTER.padYielding : REGISTER.pad;
  const picked = chooseVoicing(gen.previous, root, step.q, range);
  return {
    root,
    quality: step.q,
    label: chordLabel(root, step.q),
    degree: step.label,
    cliche: !!cliche,
    voicing: picked.voicing,
    movement: picked.cost,
    rejected: picked.rejected,
  };
}

/** Devices available at a concentration, exactly the table in the plan. */
export function devicesAt(C) {
  const open = [];
  open.push("sus");
  if (C >= 0.3) open.push("cliche", "drone");
  if (C >= 0.3) open.push("mixture");
  if (C >= 0.55) open.push("climb");
  if (C >= 0.75) open.push("bII");
  return open;
}

function pickFamily(gen, C) {
  if (gen.pinFamily) return familyById(gen.pinFamily);
  const weighted = FAMILIES.map((family) => {
    let weight = 1 + 0.5 * (gen.familyCounts[family.id] || 0);   // gravity
    if (family.mode === "major") weight *= 0.25;                 // the lift is rare
    if (C > 0.75 && family.id === "silence") weight *= 1.6;       // section rotation
    if (C > 0.55 && family.id === "spellbound") weight *= 1.5;    // the climb
    return { family, weight };
  });
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = gen.rng() * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll <= 0) return entry.family;
  }
  return weighted[0].family;
}

function stepsOf(gen) {
  if (!gen.family) return [];
  return gen.alt && gen.family.alt ? gen.family.alt : gen.family.steps;
}

function resolveSteps(gen, C) {
  if (!gen.family) {
    gen.family = pickFamily(gen, C);
    gen.familyCounts[gen.family.id] = (gen.familyCounts[gen.family.id] || 0) + 1;
    gen.alt = false;
    gen.pos = 0;
    gen.barsLeft = 0;
    gen.current = null;
    gen.phrases += 1;
  }
  if (gen.alt === false && gen.family.alt && C >= 0.75) gen.alt = true;   // chorus
  if (gen.alt === true && C < 0.45) gen.alt = false;                       // back to verse
  return stepsOf(gen);
}

function finishFamily(gen) {
  if (gen.family.mode === "major" || gen.family.needsExit) {
    // the lift never drops back to the minor on a downbeat: iv -> bVII -> i
    gen.exit = EXIT_CADENCE.map((entry) => ({ ...entry }));
  }
  gen.family = null;
  gen.current = null;
  gen.pos = 0;
  gen.barsLeft = 0;
}

function advanceChord(gen, C, devices) {
  if (gen.exit.length) {
    const entry = gen.exit.shift();
    gen.current = buildChord(gen, entry.step, entry.base, false);
    gen.barsLeft = entry.step.bars;
    return "exit cadence";
  }
  if (gen.armed && gen.family) {
    gen.armed = false;
    gen.current = buildChord(gen, gen.family.open, gen.family.mode, false);
    gen.barsLeft = gen.family.open.bars;
    const familyId = gen.family.id;
    gen.family = null;
    gen.pos = 0;
    gen.lastRelease = true;
    return `open release from ${familyId}`;
  }
  const steps = resolveSteps(gen, C);
  if (gen.pos >= steps.length) {
    finishFamily(gen);
    return advanceChord(gen, C, devices);
  }
  const step = steps[gen.pos];
  const cliche = !!step.cliche && devices.includes("cliche");
  const candidate = buildChord(gen, step, gen.family.mode, cliche && C >= 0.3);
  let reason = `${gen.family.title}: ${step.label}`;
  if (cliche && C >= 0.3) reason += " (cliché owns the top voice; pad yields an octave)";
  // a change that cannot be voice-led is not played: the chord is held instead.
  // At a phrase boundary a lift is allowed -- that is where a band changes key.
  const atBoundary = gen.pos === 0;
  if (gen.previous && candidate.movement > VOICE_BUDGET && !atBoundary) {
    gen.barsLeft = 1;
    return `${reason} — held: movement ${candidate.movement} > ${VOICE_BUDGET}`;
  }
  gen.current = candidate;
  gen.barsLeft = step.bars;
  gen.previous = candidate.voicing;
  return reason;
}

// ---------------------------------------------------------------------- drums
function drumBar(gen, C, controls, barIndex) {
  const hits = [];
  for (let beat = 0; beat < 4; beat += 1) hits.push({ step: beat * 4, hit: "kick", vel: 1 });
  hits.push({ step: 4, hit: "snare", vel: 0.9 }, { step: 12, hit: "snare", vel: 0.9 });
  const sixteenths = C > 0.6;
  for (let s = 0; s < STEPS_PER_BAR; s += sixteenths ? 1 : 2) {
    if (s === 4 || s === 12) continue;
    hits.push({ step: s, hit: "hatC", vel: sixteenths ? 0.32 : 0.38 });
  }
  if (gen.rng() < 0.3 + clamp01(controls.alphaShare || 0)) {
    hits.push({ step: 14, hit: "hatO", vel: 0.5 });
  }
  if (gen.rng() < Math.max(0, (controls.arousal || 0) - 0.6)) {
    hits.push({ step: 15, hit: "kick", vel: 0.6 });
  }
  if (gen.locked >= 4) hits.push({ step: 11, hit: "snare", vel: 0.35 });  // the band locks
  if (barIndex % 4 === 3) {
    const toms = (controls.motion || 0) > 0.05;
    for (let i = 0; i < 4; i += 1) {
      hits.push({ step: 12 + i, hit: toms ? (i % 2 ? "tomH" : "tomL") : "snare", vel: 0.5 + i * 0.12 });
    }
  }
  return hits.sort((a, b) => a.step - b.step);
}

// ----------------------------------------------------------------------- bass
// Eighth-note drive: root and fifth only. An octave leap cannot exist in a
// one-octave window (it folds back onto the root), and the sub-octave thickness
// is the drone's job, not the bass's.
function bassBar(chord, cliche) {
  const root = fold(chord.root, REGISTER.bass);
  let fifth = fold(chord.root + 7, REGISTER.bass);
  if (fifth === root) fifth = fold(chord.root - 5, REGISTER.bass);
  const pattern = cliche
    ? [root, root, root, root, root, root, root, null]
    : [root, fifth, root, fifth, root, fifth, root, null];
  const notes = [];
  pattern.forEach((midi, i) => {
    if (midi !== null) notes.push({ step: i * 2, midi, dur: 2, vel: i === 0 ? 0.95 : 0.8 });
  });
  return notes;
}

/** The pedal: the tonic, a register clear of the bass, never muddy. */
function droneBar(gen, devices) {
  if (!devices.includes("drone")) return null;
  let drone = fold(gen.tonicMidi + DRONE_INTERVAL, REGISTER.drone);
  while (drone - REGISTER.bass[1] < DRONE_MIN_GAP) drone += 12;
  if (drone > REGISTER.drone[1] + 12) return null;   // cannot get clear of the bass
  return drone;
}

// ----------------------------------------------------------------------- lead
function autoLeadBar(gen, chord, controls) {
  if (!chord || !chord.voicing) return [];
  const chordTones = chord.voicing.map((m) => ((m % 12) + 12) % 12);
  const high = (controls.asymmetry || 0) >= 0;
  const range = high ? [76, 81] : REGISTER.lead;
  const notes = [];
  let last = null;
  for (const step of [0, 4, 8, 12]) {
    let midi = fold(chord.root + (chordTones.includes((chord.root + 7) % 12) ? 7 : 0), range);
    while (last !== null && midi === last) midi += 12;
    midi = fold(midi, range);
    notes.push({ step, midi, dur: 2, vel: 0.7 });
    last = midi;
  }
  return notes;
}

// --------------------------------------------------------------------- timbre
export function timbreAt(C) {
  return {
    bassCutoff: 400 + 500 * clamp01((C - 0.55) / 0.45) + 100 * C,
    padCutoff: 1200 + 1800 * clamp01((C - 0.3) / 0.7),
    padSend: 0.25 + 0.5 * clamp01((C - 0.6) / 0.4) + 0.25 * C,
    leadDelayFb: 0.32 + 0.05 * clamp01((C - 0.75) / 0.25),
    saturation: 2 * clamp01((C - 0.65) / 0.35),
  };
}

// --------------------------------------------------------------------- release
function updateRelease(gen, C) {
  if (C > 0.6) gen.locked += 1;
  else gen.locked = 0;
  if (gen.locked >= 4) gen.peak = Math.max(gen.peak ?? 0, C);
  if (gen.peak !== null && gen.peak > 0.6 && C <= gen.peak - 0.2) {
    gen.armed = true;    // letting go is what opens the sky
    gen.peak = null;
  }
}

// ------------------------------------------------------------------- one bar
export function nextBar(gen, controls = {}) {
  const C = clamp01(controls.C ?? 0.3);
  const barIndex = gen.bar;
  gen.cHistory.push(C);
  if (gen.cHistory.length > 16) gen.cHistory.shift();

  const bar = {
    index: barIndex,
    tempo: gen.bpm,
    family: gen.family ? gen.family.id : null,
    vamp: false,
    chords: [],
    bass: [],
    drums: [],
    lead: [],
    drone: null,
    timbre: timbreAt(C),
    ui: { C, devices: devicesAt(C), chain: null, reason: "" },
  };

  if (controls.mode === "vamp") {
    bar.vamp = true;
    const root = fold(gen.tonicMidi, REGISTER.bass);
    bar.drone = null;                       // a vamp is drums and bass, nothing else
    bar.chords = [];
    bar.bass = [root, root, root, root, root, root, root, null]
      .map((midi, i) => (midi === null ? null : { step: i * 2, midi, dur: 2, vel: 0.7 }))
      .filter(Boolean);
    bar.drums = drumBar(gen, 0.2, controls, barIndex);
    bar.ui.reason = "solo wizard is gone: hypnotic root vamp, no harmony";
    gen.bar += 1;
    return bar;
  }

  updateRelease(gen, C);
  const devices = bar.ui.devices;

  if (!gen.current || gen.barsLeft <= 0) {
    if (gen.current && !gen.exit.length) gen.pos += 1;
    bar.ui.reason = advanceChord(gen, C, devices);
  } else {
    bar.ui.reason = `holding ${gen.current.label}`;
  }

  const chord = gen.current;
  if (chord) {
    bar.family = gen.family ? gen.family.id : (chord.degree ? bar.family : null);
    bar.chords.push({
      step: 0,
      label: chord.label,
      degree: chord.degree,
      root: chord.root,
      quality: chord.quality,
      voicing: chord.voicing,
      cliche: chord.cliche,
      devices: chord.cliche ? ["cliche"] : [],
      rejected: chord.rejected,
    });
    // a sus tension, resolved two beats later: never on the last 8th of the bar
    if (devices.includes("sus") && !chord.cliche && gen.rng() < 0.25) {
      const sus = buildChord(gen, { deg: chord.root - gen.tonicMidi, q: "sus4", label: chord.degree }, "minor", false);
      bar.chords.push({
        step: 8, label: sus.label, degree: chord.degree, root: chord.root,
        quality: "sus4", voicing: sus.voicing, cliche: false,
        devices: ["sus"], rejected: [],
      });
      bar.chords.push({
        step: 12, label: chord.label, degree: chord.degree, root: chord.root,
        quality: chord.quality, voicing: chord.voicing, cliche: false,
        devices: ["sus"], rejected: [],
      });
    }
    bar.bass = bassBar(chord, chord.cliche);
    bar.drone = droneBar(gen, devices);
    bar.lead = autoLeadBar(gen, chord, controls);
  }

  bar.drums = drumBar(gen, C, controls, barIndex);

  bar.ui.release = !!gen.lastRelease;
  gen.lastRelease = false;
  bar.ui.chain = {
    family: bar.family,
    title: gen.family ? gen.family.title : "transition",
    steps: (gen.family ? stepsOf(gen) : []).map((s) => s.label),
    position: gen.pos,
    open: gen.family ? gen.family.open.label : null,
    armed: gen.armed,
    held: gen.barsLeft,
  };
  if (!bar.ui.reason) bar.ui.reason = `holding ${chord ? chord.label : "—"}`;

  gen.barsLeft -= 1;
  gen.bar += 1;
  return bar;
}

/**
 * Aggregate several wizards into the controls one bar needs.
 * Contact quality is the vote weight; a silent wizard has no vote. With one
 * wizard this is just that wizard, which is a normal band, not a special case.
 */
export function aggregate(sharers, now) {
  const live = sharers.filter((s) => s && !s.gone);
  if (!live.length) return { C: 0.1, mode: "vamp", heads: 0 };
  const weighted = live.map((s) => ({
    s,
    w: s.inContact ? 1 : 0.2,
  }));
  const mix = (key) => {
    // the wrapper is {s, w}: reading e[key] here silently found nothing and
    // every aggregate fell through to the constant default
    const picks = weighted.filter((e) => typeof e.s[key] === "number");
    if (!picks.length) return undefined;
    const wsum = picks.reduce((sum, e) => sum + e.w, 0) || 1;
    return picks.reduce((sum, e) => sum + e.s[key] * e.w, 0) / wsum;
  };
  const C = mix("C") ?? 0.3;
  // The vamp is what the bleed *reaches*, not how long the socket has been quiet:
  // a calm person at C 0.2 is still a live band, a solo wizard who left is not.
  const soloGone = live.length === 1
    && live[0].age > DECAY_S
    && C <= C_FLOOR + 0.05;
  return {
    C,
    alphaShare: mix("alphaShare"),
    asymmetry: mix("asymmetry"),
    arousal: mix("arousal"),
    motion: mix("motion"),
    heads: live.length,
    mode: soloGone ? "vamp" : "live",
  };
}

export { FAMILIES, familyById };
