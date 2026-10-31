// The two chains, as data: the graphs the panel draws, with no DOM in sight.
//
// The renderer decides colour and nothing else. Topology, ids, rows, positions
// and liveness all live here, so a test can assert that the drawing is the thing
// the generator actually did: `live` is computed from the same tables the
// grammar reads (`DEVICE_GATES`, `LADDER_RULES`, `LEAD_HIGH`, `REGISTER`), never
// from a second copy of a threshold.
//
// A node is a BALL:
//   { id, x, y, r, place, kind, label, value, note, live, state, open, ahead }
// `x`/`y` are the centre. `place` is where the text sits relative to the ball
// ("right" for the signal chain, "below" for the harmonic one, where the balls
// are packed shoulder to shoulder). `state` is where the chain is (null,
// "current", "armed"); `open` marks the family's open chord, which is a
// different fact -- a family can be playing it; `ahead` is the prediction: the
// thing this bar is about to do, so the page can light it before it happens.
// `note` is metadata (the rule a row restates, the gate a device opens at); it
// is never drawn inside the graph -- it reaches the page through the panel's
// text rows and each ball's <title>.
//
// An edge is a LINE:
//   { from, to, label, live, dashed, ahead, arc }
// Straight between two ball centres (the renderer trims it to the rims), because
// curves between four columns are what made the first version read as spaghetti.
// `arc` is the one backward transition -- a family's release -- drawn above the
// row, and `label` is where the weights print.

import {
  DEVICE_DOCS, DEVICE_LABELS, LADDER_RULES, noteName, parameterFor,
} from "./explain.js";
import {
  DEVICE_GATES, devicesAt, LEAD_HIGH, REGISTER, VOICE_BUDGET,
} from "./generator.js";
import { WEIGHT_DEFAULTS } from "./conditioner.js";

export const GRAPH = Object.freeze({
  width: 820,
  ballR: 9,
  hubR: 11,          // C is the hub the three terms meet at
  labelGap: 15,      // text starts this far right of a "right" ball's centre...
  rowH: 32,          // ...and rows are pitched to hold two lines of text: a name
                     // above the ball's line and a value below it, 28px of type
                     // block, so 32 gives every stacked pair real air
  textDown: 14,      // a value's baseline sits this far under the ball's centre
  top: 16,
  columns: [26, 176, 326, 476, 626],
});

// The harmonic row: balls shoulder to shoulder, labels under them, this bar's
// chord events as smaller balls below the step being played, the voicings that
// lost below those. The band positions are constants so the box can be measured
// from the content instead of guessed.
const HARMONY = Object.freeze({
  base: 560,
  gap: 20,
  minW: 56,
  maxW: 132,
  step: { y: 42, r: 13, label: 14, value: 11 },
  chord: { y: 112, r: 9, label: 13, value: 12 },
  lost: { y: 162, r: 7, label: 13 },
});

const DASH = "—";
const MAX_REJECTED = 3;
const STEP_HEIGHT = 88;
const CHORD_HEIGHT = 154;
const LOST_HEIGHT = 190;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fx = (v, digits = 2) => (v == null ? DASH : v.toFixed(digits));
const signed = (v) => (v == null ? DASH : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`);
const counts = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

const hasHit = (bar, hit, step) => Array.isArray(bar.drums)
  && bar.drums.some((h) => h && h.hit === hit && h.step === step);

/** The device's gate, in the same words the rack has always printed. */
export function gateText(name) {
  const gate = DEVICE_GATES[name];
  return Number.isFinite(gate) && gate > 0 ? `≥${gate.toFixed(2)}` : "always";
}

/** The rule sentence for a device, so a ball can be hovered for the whole story. */
const deviceNote = (name) => {
  const doc = DEVICE_DOCS.find((entry) => entry.id === name);
  return doc ? doc.does : gateText(name);
};

// --------------------------------------------------------------------- layout
function ball(column, row, fields) {
  return {
    x: GRAPH.columns[column],
    y: GRAPH.top + row * GRAPH.rowH,
    r: GRAPH.ballR,
    place: "right",
    kind: "signal",
    label: "",
    value: DASH,
    note: "",
    live: false,
    state: null,
    open: false,
    ahead: false,
    ...fields,
  };
}

function edge(from, to, fields = {}) {
  return {
    from, to, label: "", live: false, dashed: false, ahead: false, arc: false, ...fields,
  };
}

/**
 * The signal chain: the three weighted terms that make C, the four signals the
 * Muse sends, and the rules, devices and voices they decide.
 *
 * The rows are chosen so that no line has to cross a column it does not belong
 * to: each Muse signal sits at the same height as the rule it drives (α -> the
 * open hat, arousal -> the ghost kick, motion -> the fill, asymmetry -> the lead
 * register), the three terms meet C at C's own row, and C fans out to the three
 * rules it sets. What is left is one clean left-to-right flow.
 *
 * `parts` and `weights` are the concentration split and the normalised weights
 * in force; with them the weights print on the edges into C, so re-weighting a
 * slider visibly re-draws the sum.
 */
export function signalGraph(mix = {}, bar = {}, { parts = null, weights = null } = {}) {
  const m = mix || {};
  const at = bar || {};
  const w = weights || WEIGHT_DEFAULTS;
  const p = parts || {};

  const C = num(m.C);
  const open = C == null ? [] : devicesAt(C);
  const unlocked = new Set(open);
  const alphaShare = num(m.alphaShare);
  const arousal = num(m.arousal);
  const motion = num(m.motion);
  const asymmetry = num(m.asymmetry);

  const drums = Array.isArray(at.drums) ? at.drums : [];
  const bass = Array.isArray(at.bass) ? at.bass : [];
  const lead = Array.isArray(at.lead) ? at.lead : [];
  const first = Array.isArray(at.chords) && at.chords[0] ? at.chords[0] : null;
  const voicing = first && Array.isArray(first.voicing) ? first.voicing : [];

  const index = num(at.index) ?? 0;
  const left = ((3 - (index % 4)) + 4) % 4;      // bars until the bar-4 fill
  const hats16 = (C == null ? 0 : C) > 0.6;
  const openHat = hasHit(at, "hatO", 14);
  const ghostKick = hasHit(at, "kick", 15);
  const fillToms = drums.some((h) => h && (h.hit === "tomL" || h.hit === "tomH"));
  const high = (asymmetry == null ? 0 : asymmetry) >= 0;
  const [lo, hi] = high ? LEAD_HIGH : REGISTER.lead;
  const cutoff = num(at.timbre && at.timbre.bassCutoff);

  // the two probabilistic rules print their odds and are marked ahead of time
  // when the odds favour them: p > 0.5 is "more often than not this bar"
  const openHatP = 0.3 + clamp01(alphaShare == null ? 0 : alphaShare);
  const ghostP = Math.max(0, (arousal == null ? 0 : arousal) - 0.6);

  // the gate C has not reached yet: the one honest prediction on the C side
  const nextGate = Object.keys(DEVICE_GATES)
    .filter((name) => DEVICE_GATES[name] > (C == null ? 0 : C))
    .sort((a, b) => DEVICE_GATES[a] - DEVICE_GATES[b])[0] || null;

  const term = (id) => num(p[id]);
  const weightOf = (id) => num(w[id]);

  const nodes = [
    // col 0: the three weighted terms (top) and the Muse signals (bottom)
    ...["engagement", "activation", "steadiness"].map((id, row) => {
      const value = term(id);
      const weight = weightOf(id);
      return ball(0, row, {
        id,
        kind: "term",
        label: id,
        value: fx(value),
        live: value != null,
        note: weight != null && value != null
          ? `×${weight.toFixed(2)} = ${(value * weight).toFixed(2)} → C`
          : "no headband: the C slider stands in",
      });
    }),
    ball(0, 4, {
      id: "alphaShare", label: "α", value: fx(alphaShare), live: true,
      note: LADDER_RULES.alphaShare,
    }),
    ball(0, 5, {
      id: "arousal", label: "arousal", value: fx(arousal), live: true,
      note: LADDER_RULES.arousal,
    }),
    ball(0, 6, {
      id: "motion", label: "motion", value: fx(motion), live: true,
      note: LADDER_RULES.motion,
    }),
    ball(0, 7, {
      id: "asymmetry", label: "asym", value: signed(asymmetry), live: true,
      note: LADDER_RULES.asymmetry,
    }),

    // col 1: the hub
    ball(1, 1, {
      id: "C",
      kind: "hub",
      label: "C",
      r: GRAPH.hubR,
      value: fx(C),
      live: C != null,
      note: parameterFor("C").source,
    }),

    // col 2: what C sets, then the four rules the Muse signals drive
    ball(2, 0, {
      id: "hats", kind: "rule", label: "hats", value: hats16 ? "16ths" : "8ths",
      note: "C > 0.60", live: hats16, ahead: !hats16 && C != null,
    }),
    ball(2, 1, {
      id: "gates", kind: "rule", label: "ladder", live: open.length > 1,
      value: `${open.length}/6`,
      note: nextGate
        ? `next: ${nextGate} at ${DEVICE_GATES[nextGate].toFixed(2)}`
        : "every device is open",
    }),
    ball(2, 2, {
      id: "timbre", kind: "timbre", label: "timbre", live: true,
      value: cutoff == null ? DASH : `${Math.round(cutoff)} Hz`, note: "from C",
    }),
    ball(2, 4, {
      id: "openhat", kind: "rule", label: "open hat",
      value: `p ${openHatP.toFixed(2)}`, note: "step 14",
      live: openHat, ahead: !openHat && openHatP >= 0.5,
    }),
    ball(2, 5, {
      id: "ghost", kind: "rule", label: "ghost kick",
      value: `p ${ghostP.toFixed(2)}`, note: "step 15",
      live: ghostKick, ahead: !ghostKick && ghostP >= 0.5,
    }),
    ball(2, 6, {
      id: "fill", kind: "rule", label: "fill",
      value: left !== 0 ? `in ${left} bar${left === 1 ? "" : "s"}` : (fillToms ? "toms" : "snares"),
      note: `bar ${(index % 4) + 1} of 4`, live: left === 0, ahead: left !== 0,
    }),
    ball(2, 7, {
      id: "register", kind: "rule", label: "register", live: lead.length > 0,
      value: `${noteName(lo)}..${noteName(hi)}`, note: counts(lead.length, "note"),
    }),

    // col 3: the devices the ladder opens, each with the gate it opens at
    ...DEVICE_LABELS.map(([name, shown], row) => ball(3, row, {
      id: `dev:${name}`,
      kind: "device",
      label: shown,
      value: gateText(name),
      note: deviceNote(name),
      live: unlocked.has(name),
      ahead: nextGate === name,
    })),

    // col 4: the voices, each level with the thing that decides it
    ball(4, 1, {
      id: "voice:pad", kind: "voice", label: "pad", live: voicing.length > 0,
      value: counts(voicing.length, "note"), note: "chord voicing",
    }),
    ball(4, 2, {
      id: "voice:drone", kind: "voice", label: "drone", live: at.drone != null,
      value: at.drone == null ? "off" : noteName(at.drone), note: "drone device",
    }),
    ball(4, 3, {
      id: "voice:bass", kind: "voice", label: "bass", live: bass.length > 0,
      value: counts(bass.length, "note"), note: "chord · cliché",
    }),
    ball(4, 4, {
      id: "voice:drums", kind: "voice", label: "drums", live: true,
      value: counts(drums.length, "hit"), note: "C · arousal · α",
    }),
    ball(4, 7, {
      id: "voice:lead", kind: "voice", label: "lead", live: lead.length > 0,
      value: counts(lead.length, "note"), note: lead.length ? "asymmetry" : "muted",
    }),
  ];

  const at_node = (id) => nodes.find((node) => node.id === id) || null;
  const liveOf = (id) => {
    const node = at_node(id);
    return node ? node.live : false;
  };
  const aheadOf = (id) => {
    const node = at_node(id);
    return !!node && node.ahead;
  };

  // An edge into a node that is about to fire is drawn as "ahead" too: that is
  // the whole point of the prediction -- the line lights before the bar does.
  const into = (from, to, fields = {}) => edge(from, to, {
    live: liveOf(to),
    ahead: aheadOf(to) && !liveOf(to),
    ...fields,
  });

  const edges = [
    // the three terms, weighted, into the hub
    ...["engagement", "activation", "steadiness"].map((id) => {
      const weight = weightOf(id);
      const value = term(id);
      return edge(id, "C", {
        label: weight == null ? "" : `×${weight.toFixed(2)}`,
        live: value != null && weight != null,
      });
    }),
    // C sets the density, the ladder and the sound
    into("C", "hats"),
    into("C", "gates"),
    into("C", "timbre"),
    // each Muse signal drives its own rule
    into("alphaShare", "openhat"),
    into("arousal", "ghost"),
    into("motion", "fill"),
    into("asymmetry", "register"),
    // the ladder opens the devices
    ...DEVICE_LABELS.map(([name]) => into("gates", `dev:${name}`)),
    // a device that owns a voice
    into("dev:cliche", "voice:pad"),
    into("dev:drone", "voice:drone"),
    into("register", "voice:lead"),
  ];

  const bottom = nodes.reduce((max, node) => Math.max(max,
    node.y + node.r + (node.place === "below" ? 25 : GRAPH.textDown)), 0);
  return {
    width: GRAPH.width, height: Math.round(bottom + 8), nodes, edges, labelGap: GRAPH.labelGap,
  };
}

// -------------------------------------------------------------------- harmony
/**
 * The family's steps carry the bars each holds; the chain payload carries labels
 * only. The list is recovered by matching labels: `alt` is the chorus rotation
 * of the same family, and a family rebuilt from a bare label list falls back to
 * one bar per step rather than inventing a rhythm.
 */
export function stepEntries(family, labels) {
  if (!family) return labels.map((label) => ({ label, bars: 1, cliche: false }));
  const lists = [family.steps, family.alt].filter(Boolean);
  const match = lists.find((list) => list.length === labels.length
    && list.every((stepItem, i) => stepItem.label === labels[i]));
  if (match) return match.map((stepItem) => ({
    label: stepItem.label, bars: stepItem.bars, cliche: !!stepItem.cliche,
  }));
  return labels.map((label) => ({ label, bars: 1, cliche: false }));
}

/**
 * Why a candidate lost, from what the bar actually carries.
 *
 * `nextBar` copies a chord *without* its `movement` field, so the winner's cost
 * is not available to a view and comparing a rejected cost against it would
 * invent a number ("cost 3 > 0" when the winner most likely cost 3 as well).
 * What the data does support: a candidate over the budget lost to a cheaper
 * voicing; a zero-cost candidate tied the winner (costs are non-negative, so the
 * winner cost 0 too) and lost the span tie-break; anything in between only
 * establishes that the winner moved no further.
 */
export function describeRejection(entry) {
  if (typeof entry === "string") return { notes: entry, why: "" };
  if (Array.isArray(entry)) return { notes: entry.map(noteName).join(" "), why: "" };
  if (!entry || typeof entry !== "object") return { notes: "", why: "" };
  const notes = Array.isArray(entry.voicing) ? entry.voicing.map(noteName).join(" ") : String(entry.label ?? "");
  if (entry.reason) return { notes, why: String(entry.reason) };
  if (typeof entry.cost !== "number") return { notes, why: "" };
  if (entry.cost > VOICE_BUDGET) return { notes, why: `voice-leading ${entry.cost} > ${VOICE_BUDGET}` };
  if (entry.cost === 0) return { notes, why: "same cost · span tie-break" };
  return { notes, why: `cost ${entry.cost} · winner moved no further` };
}

/**
 * The harmonic chain as a walk: the family's steps in a row, one transition per
 * neighbouring pair, and the one backward transition a family has -- the release,
 * arcing from the last step to the open chord. The step being played is gold, the
 * step after it is already lit as "ahead", and the release arc turns warm the
 * moment the generator is armed to take it.
 *
 * This bar's chord events are smaller balls under the step being played, with the
 * voicings that lost under those: the path is the family's, the events are the
 * bar's, and mixing them is what made the old view unreadable.
 */
export function harmonyGraph(bar = {}, chain = null, family = null) {
  const at = bar || {};
  const labels = chain && Array.isArray(chain.steps) ? chain.steps : [];

  if (!bar || !Object.keys(at).length) {
    const waiting = {
      id: "waiting", x: 40, y: HARMONY.step.y, r: GRAPH.hubR, place: "right",
      kind: "chord", label: "waiting for a bar", value: DASH, note: "no bar yet",
      live: false, state: null, open: false, ahead: false,
    };
    return {
      width: HARMONY.base, height: STEP_HEIGHT, nodes: [waiting], edges: [], labelGap: GRAPH.labelGap,
    };
  }

  if (at.vamp || !labels.length) {
    // No harmonic path to draw. A vamp has none by design; a transition has none
    // because the family just closed, and saying "vamp" there would be a lie.
    const vamp = {
      id: "vamp", x: 40, y: HARMONY.step.y, r: GRAPH.hubR, place: "right",
      kind: "chord", state: null, live: false, open: false, ahead: false,
      label: at.vamp ? "vamp" : "no chain",
      value: at.vamp ? "root pedal" : "transition",
      note: at.vamp ? "no harmony" : "the family closed",
    };
    return {
      width: HARMONY.base, height: STEP_HEIGHT, nodes: [vamp], edges: [], labelGap: GRAPH.labelGap,
    };
  }

  const entries = stepEntries(family, labels);
  const n = entries.length;
  const w = Math.min(HARMONY.maxW, Math.max(HARMONY.minW,
    Math.round((HARMONY.base - (n - 1) * HARMONY.gap) / n)));
  const width = n * w + (n - 1) * HARMONY.gap;
  const position = chain && Number.isFinite(chain.position) ? chain.position : 0;
  const currentIndex = Math.min(Math.max(position - 1, 0), n - 1);
  const open = chain && chain.open ? chain.open : null;
  const armed = !!(chain && chain.armed);
  const openIndex = open == null ? -1 : entries.findIndex((entry) => entry.label === open);

  const nodes = entries.map((entry, i) => ({
    id: `step:${i}`,
    x: Math.round(w / 2 + i * (w + HARMONY.gap)),
    y: HARMONY.step.y,
    r: HARMONY.step.r,
    place: "below",
    kind: "rule",
    label: entry.label,
    value: `${entry.bars} bar${entry.bars === 1 ? "" : "s"}`,
    note: entry.cliche ? "cliché" : "",
    live: i <= currentIndex && position > 0,
    // where the walk is, where it goes next, and what the open chord is: three
    // separate facts, so a step can be current and the open chord at once
    state: armed && i === currentIndex ? "armed"
      : i === currentIndex && position > 0 ? "current"
        : null,
    open: i === openIndex,
    ahead: i === position && position < n,
  }));

  const edges = [];
  for (let i = 0; i < n - 1; i += 1) {
    edges.push(edge(`step:${i}`, `step:${i + 1}`, {
      live: i < position,
      ahead: i === position - 1 && position < n,
    }));
  }
  // the release: the one transition that jumps backwards, so it arcs above the row
  if (openIndex >= 0 && openIndex !== n - 1) {
    edges.push(edge(`step:${n - 1}`, `step:${openIndex}`, {
      label: "release", live: armed, dashed: true, arc: true,
    }));
  }

  const chords = Array.isArray(at.chords) ? at.chords : [];
  const currentX = nodes[currentIndex].x;
  // The chord events are this bar's, not the walk's, and they hang under the step
  // being played: the group is centred there, then nudged inside the canvas. The
  // slot is wider than the balls because the labels under them are note names.
  const slot = HARMONY.chord.r * 2 + 38;
  const span = chords.length ? (chords.length - 1) * slot : 0;
  const chordX = Math.max(HARMONY.chord.r,
    Math.min(currentX - span / 2, width - HARMONY.chord.r - span));

  chords.forEach((chord, i) => {
    const id = `chord:${chord.step}`;
    nodes.push({
      id,
      x: Math.round(chordX + i * slot),
      y: HARMONY.chord.y,
      r: HARMONY.chord.r,
      place: "below",
      kind: "chord",
      label: chord.label,
      value: `step ${chord.step}`,
      note: chord.quality,
      live: true,
      state: null,
      open: false,
      ahead: false,
    });
    edges.push(edge(`step:${currentIndex}`, id, { live: true }));
  });

  const rejected = chords.length && Array.isArray(chords[0].rejected) ? chords[0].rejected : [];
  if (rejected.length) {
    rejected.slice(0, MAX_REJECTED).forEach((entry, i) => {
      const described = describeRejection(entry);
      nodes.push({
        id: `rejected:${i}`,
        x: Math.round(chordX + i * slot),
        y: HARMONY.lost.y,
        r: HARMONY.lost.r,
        place: "below",
        kind: "chord",
        label: described.notes,
        value: DASH,
        note: described.why,
        live: false,
        state: null,
        open: false,
        ahead: false,
      });
      edges.push(edge(`chord:${chords[0].step}`, `rejected:${i}`, { dashed: true }));
    });
  }

  const height = rejected.length ? LOST_HEIGHT : chords.length ? CHORD_HEIGHT : STEP_HEIGHT;
  return { width, height, nodes, edges, labelGap: GRAPH.labelGap };
}
