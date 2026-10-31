// The two chains, as data: the graphs the panel draws, with no DOM in sight.
//
// The renderer decides colour and nothing else. Topology, node ids, rows,
// coordinates and liveness all live here, so a test can assert that the drawing
// is the thing the generator actually did: `live` is computed from the same
// tables the grammar reads (`DEVICE_GATES`, `LADDER_RULES`, `LEAD_HIGH`,
// `REGISTER`), never from a second copy of a threshold.
//
// A node is
//   { id, x, y, w, h, kind, label, value, note, live, state, open }
// and an edge is { from, to, label, live, dashed }. `state` is where the chain
// is (null, "current" or "armed"); `open` marks the family's open chord, which
// is a different fact -- a family can be playing it. `note` is metadata (the
// rule a row restates, the gate a device opens at); it is never drawn inside a
// node, because an 84px chip cannot hold a sentence -- it reaches the page
// through the panel's text rows and each node's <title>.

import { DEVICE_LABELS, LADDER_RULES, noteName } from "./explain.js";
import {
  DEVICE_GATES, devicesAt, LEAD_HIGH, REGISTER, VOICE_BUDGET,
} from "./generator.js";

export const GRAPH = Object.freeze({
  width: 820, height: 320, nodeW: 190, nodeH: 32, colGap: 20, rowH: 40, top: 8,
  columns: [0, 210, 420, 630],
});

const DASH = "—";
const MAX_REJECTED = 3;
// The harmonic chain sizes itself from its own content instead of borrowing the
// signal graph's 820px: it lives in a narrower column, and a viewBox wider than
// the column shrinks 11px labels below the 10px floor. Steps get the base split,
// the box is then exactly as wide as the row they make, so the drawing renders
// near 1:1 and the longest family still fits inside its own viewBox.
const HARMONY_BASE = 560;
const HARMONY_ROW = Object.freeze({ y: 8, h: 34, gap: 16, minW: 56, maxW: 130 });
const CHORD_ROW = Object.freeze({ y: 52, h: 28, w: 84, gap: 8 });
const REJECTED_ROW = Object.freeze({ y: 88, h: 26, w: 84, gap: 8 });

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

// --------------------------------------------------------------------- layout
function signalNode(column, row, fields) {
  return {
    x: GRAPH.columns[column],
    y: GRAPH.top + row * GRAPH.rowH,
    w: GRAPH.nodeW,
    h: GRAPH.nodeH,
    kind: "signal",
    label: "",
    value: DASH,
    note: "",
    live: false,
    state: null,
    open: false,
    ...fields,
  };
}

/**
 * The signal chain: five controls, six rules, six devices and five voices, with
 * this bar's live path through them.
 *
 * The harmonic side is `harmonyGraph`, so the two edges that feed the bass and
 * the pad are emitted with `from: "chord"` -- a source with no node here. The
 * renderer draws those as a line entering from the left, labelled `chord`, which
 * is the whole point: the chords come from the other graph.
 */
export function signalGraph(mix = {}, bar = {}) {
  const m = mix || {};
  const at = bar || {};

  const C = num(m.C);
  const open = C == null ? [] : devicesAt(C);
  const unlocked = new Set(open);
  const alphaShare = num(m.alphaShare);
  const arousal = num(m.arousal);
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

  const nodes = [
    // col 0: the controls. A source is always drawn live: it has a value whether
    // or not this bar's rules fired off it.
    signalNode(0, 0, {
      id: "C", label: "C", value: fx(C), live: true,
      note: `${open.length}/6 devices`,
    }),
    signalNode(0, 1, {
      id: "alphaShare", label: "α", value: fx(alphaShare), live: true,
      note: LADDER_RULES.alphaShare,
    }),
    signalNode(0, 2, {
      id: "arousal", label: "arousal", value: fx(arousal), live: true,
      note: LADDER_RULES.arousal,
    }),
    signalNode(0, 3, {
      id: "motion", label: "motion", value: fx(num(m.motion)), live: true,
      note: LADDER_RULES.motion,
    }),
    signalNode(0, 4, {
      id: "asymmetry", label: "asym", value: signed(asymmetry), live: true,
      note: LADDER_RULES.asymmetry,
    }),

    // col 1: the rules those controls feed
    signalNode(1, 0, {
      id: "gates", kind: "rule", label: "device ladder", live: open.length > 1,
      note: `${open.length}/6 open`,
    }),
    signalNode(1, 1, {
      id: "hats", kind: "rule", label: "hat division", value: hats16 ? "16ths" : "8ths",
      note: "C > 0.60", live: hats16,
    }),
    signalNode(1, 2, {
      id: "openhat", kind: "rule", label: "open hat", live: openHat,
      value: `p ${(0.3 + clamp01(alphaShare == null ? 0 : alphaShare)).toFixed(2)}`,
      note: "step 14",
    }),
    signalNode(1, 3, {
      id: "ghost", kind: "rule", label: "ghost kick", live: ghostKick,
      value: `p ${Math.max(0, (arousal == null ? 0 : arousal) - 0.6).toFixed(2)}`,
      note: "step 15",
    }),
    signalNode(1, 4, {
      id: "fill", kind: "rule", label: "bar-4 fill", live: left === 0,
      value: left !== 0 ? `in ${left} bar${left === 1 ? "" : "s"}` : (fillToms ? "toms" : "snares"),
      note: `bar ${(index % 4) + 1} of 4`,
    }),
    signalNode(1, 5, {
      id: "register", kind: "rule", label: "lead register",
      value: `${noteName(lo)}..${noteName(hi)}`,
      note: counts(lead.length, "note"), live: lead.length > 0,
    }),

    // col 2: the timbre and the six devices, each with the gate that opens it
    signalNode(2, 0, {
      id: "timbre", kind: "timbre", label: "timbre", live: true,
      value: cutoff == null ? DASH : `${Math.round(cutoff)} Hz`,
      note: "from C",
    }),
    ...DEVICE_LABELS.map(([name, shown], i) => signalNode(2, i + 1, {
      id: `dev:${name}`,
      kind: "device",
      label: shown,
      note: gateText(name),
      live: unlocked.has(name),
    })),

    // col 3: the voices that play it
    signalNode(3, 0, {
      id: "voice:drums", kind: "voice", label: "drums", live: true,
      value: counts(drums.length, "hit"), note: "C · arousal · α",
    }),
    signalNode(3, 1, {
      id: "voice:bass", kind: "voice", label: "bass", live: bass.length > 0,
      value: counts(bass.length, "note"), note: "chord · cliché",
    }),
    signalNode(3, 2, {
      id: "voice:drone", kind: "voice", label: "drone", live: at.drone != null,
      value: at.drone == null ? "off" : noteName(at.drone), note: "drone device",
    }),
    signalNode(3, 3, {
      id: "voice:pad", kind: "voice", label: "pad", live: voicing.length > 0,
      value: counts(voicing.length, "note"), note: "chord voicing",
    }),
    signalNode(3, 4, {
      id: "voice:lead", kind: "voice", label: "lead", live: lead.length > 0,
      value: counts(lead.length, "note"),
      note: lead.length ? "asymmetry" : "muted",
    }),
  ];

  const live = new Map(nodes.map((n) => [n.id, n.live]));
  const edge = (from, to, isLive, label = "") => ({
    from, to, label, live: !!isLive, dashed: false,
  });

  const edges = [
    // a control reaches its rule
    edge("C", "gates", open.length > 0),
    edge("C", "hats", hats16),
    edge("C", "timbre", true),
    edge("alphaShare", "openhat", openHat),
    edge("arousal", "ghost", ghostKick),
    edge("motion", "fill", left === 0),
    edge("asymmetry", "register", lead.length > 0),
    // the ladder opens the devices
    ...DEVICE_LABELS.map(([name]) => edge("gates", `dev:${name}`, unlocked.has(name))),
    // the rules drive the voices
    edge("hats", "voice:drums", live.get("voice:drums")),
    edge("openhat", "voice:drums", live.get("voice:drums")),
    edge("ghost", "voice:drums", live.get("voice:drums")),
    edge("fill", "voice:drums", live.get("voice:drums")),
    // the chords arrive from the other graph: no node here, so the renderer
    // draws these as a line entering from the left
    edge("chord", "voice:bass", bass.length > 0, "chord"),
    edge("chord", "voice:pad", voicing.length > 0, "chord"),
    // a device that owns a voice
    edge("dev:cliche", "voice:pad", !!(first && first.cliche === true)),
    edge("dev:drone", "voice:drone", at.drone != null),
    edge("register", "voice:lead", lead.length > 0),
  ];

  return { width: GRAPH.width, height: GRAPH.height, nodes, edges };
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
 * The harmonic chain: the family's steps left to right, this bar's chord events
 * under the step it is playing, and the voicings that lost under those.
 *
 * The box is as tall as its content: the row constants above are the band
 * positions, and the height is measured from them, so a chip can never be
 * clipped by a rounded-up constant.
 */
export function harmonyGraph(bar = {}, chain = null, family = null) {
  const at = bar || {};
  const labels = chain && Array.isArray(chain.steps) ? chain.steps : [];

  if (!bar || !Object.keys(at).length) {
    const waiting = {
      id: "waiting", x: 0, y: HARMONY_ROW.y, w: 260, h: HARMONY_ROW.h,
      kind: "chord", label: "waiting for a bar", value: DASH, note: "no bar yet",
      live: false, state: null, open: false,
    };
    return { width: HARMONY_BASE, height: harmonyHeight([waiting]), nodes: [waiting], edges: [] };
  }

  if (at.vamp || !labels.length) {
    // No harmonic path to draw. A vamp has none by design; a transition has none
    // because the family just closed, and saying "vamp" there would be a lie.
    const vamp = {
      id: "vamp", x: 0, y: HARMONY_ROW.y, w: 260, h: HARMONY_ROW.h,
      kind: "chord", state: null, live: false, open: false,
      label: at.vamp ? "vamp" : "no chain",
      value: at.vamp ? "root pedal" : "transition",
      note: at.vamp ? "no harmony" : "the family closed",
    };
    return { width: HARMONY_BASE, height: harmonyHeight([vamp]), nodes: [vamp], edges: [] };
  }

  const entries = stepEntries(family, labels);
  const n = entries.length;
  const w = Math.min(HARMONY_ROW.maxW, Math.max(HARMONY_ROW.minW,
    Math.round((HARMONY_BASE - (n - 1) * HARMONY_ROW.gap) / n)));
  const width = n * w + (n - 1) * HARMONY_ROW.gap;
  const position = chain && Number.isFinite(chain.position) ? chain.position : 0;
  const currentIndex = Math.min(Math.max(position - 1, 0), n - 1);
  const open = chain && chain.open ? chain.open : null;
  const armed = !!(chain && chain.armed);

  const nodes = entries.map((entry, i) => ({
    id: `step:${i}`,
    x: i * (w + HARMONY_ROW.gap),
    y: HARMONY_ROW.y,
    w,
    h: HARMONY_ROW.h,
    kind: "rule",
    label: entry.label,
    value: `${entry.bars} bar${entry.bars === 1 ? "" : "s"}`,
    note: entry.cliche ? "cliché" : "",
    live: i <= currentIndex && position > 0,
    // Where the chain is, and which step is the open chord, are two facts: a
    // family whose open chord is the step being played has both, so they get
    // separate fields instead of competing for one. `armed` is the loudest
    // thing that can be true of the current step, so it takes the state.
    state: armed && i === currentIndex ? "armed"
      : i === currentIndex && position > 0 ? "current"
        : null,
    open: open != null && entry.label === open,
  }));

  const edges = [];
  for (let i = 0; i < n - 1; i += 1) {
    edges.push({ from: `step:${i}`, to: `step:${i + 1}`, label: "", live: i < position, dashed: false });
  }

  const chords = Array.isArray(at.chords) ? at.chords : [];
  const current = nodes[currentIndex];
  // The chord events are this bar's, not the path's, so they hang under the step
  // being played. The group is nudged left rather than allowed off the canvas.
  const rowWidth = chords.length ? chords.length * CHORD_ROW.w + (chords.length - 1) * CHORD_ROW.gap : 0;
  const chordX = Math.max(0, Math.min(current.x, width - rowWidth));

  chords.forEach((chord, i) => {
    const id = `chord:${chord.step}`;
    nodes.push({
      id,
      x: chordX + i * (CHORD_ROW.w + CHORD_ROW.gap),
      y: CHORD_ROW.y,
      w: CHORD_ROW.w,
      h: CHORD_ROW.h,
      kind: "chord",
      label: chord.label,
      value: `step ${chord.step}`,
      note: chord.quality,
      live: true,
      state: null,
      open: false,
    });
    edges.push({
      from: `step:${currentIndex}`, to: id, label: "", live: true, dashed: false,
    });
  });

  const rejected = chords.length && Array.isArray(chords[0].rejected) ? chords[0].rejected : [];
  if (rejected.length) {
    rejected.slice(0, MAX_REJECTED).forEach((entry, i) => {
      const described = describeRejection(entry);
      const id = `rejected:${i}`;
      nodes.push({
        id,
        x: chordX + i * (REJECTED_ROW.w + REJECTED_ROW.gap),
        y: REJECTED_ROW.y,
        w: REJECTED_ROW.w,
        h: REJECTED_ROW.h,
        kind: "chord",
        label: described.notes,
        value: "lost",
        note: described.why,
        live: false,
        state: null,
        open: false,
      });
      edges.push({
        from: `chord:${chords[0].step}`, to: id, label: "", live: false, dashed: true,
      });
    });
  }

  return { width, height: harmonyHeight(nodes), nodes, edges };
}

/** Bottom of the lowest chip, plus one gutter. Never shorter than one band. */
function harmonyHeight(nodes) {
  const bottom = nodes.reduce((max, node) => Math.max(max, node.y + node.h), 0);
  return Math.max(HARMONY_ROW.y + HARMONY_ROW.h + 10, bottom + 8);
}
