// The two chains, on the home page: how the bar that is sounding was made.
//
// The desk (listen.html) draws the band's two chains in full; this is the same
// pair, from the same data (nodes.js builds both graphs from the tables the
// generator itself reads), made to fit under the brain-wave panel:
//
//   the chord chain   the walk through a progression: the step being played, the
//                     step after it, the release back to the open chord, and
//                     under the step this bar's chord events;
//   the signal chain  what the headband sends -> the concentration C -> the
//                     rules and devices C opens -> the voices that sound.
//
// Nothing here decides anything. chainGraphs() and chainWords() are pure (node
// asserts them in test_chains.js); createChains() only paints what they return.
// What is left out of the desk's drawing, and why:
//   - the voicings that lost (the desk keeps them; here they would double the
//     height of the walk for a detail few visitors read);
//   - the three terms that make C when there is no headband to split it into
//     (the desk has a slider standing in for them; this page has none);
//   - air: the signal chain's five columns stand closer, so the drawing fits a
//     column of the page at the size it is drawn.

import { GRAPH, harmonyGraph, signalGraph } from "./nodes.js";
import { familyById } from "./families.js";

const SVG = "http://www.w3.org/2000/svg";
const SQUEEZE = 0.72;        // how much closer the signal chain's columns stand than on the desk
const PAD = 16;              // px left of the first column
const LABEL_ROOM = 104;      // px right of the last column, for its labels
const GAP = 3;               // clearance between a line and the ball it meets
const ARC_PEAK = 8;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const fixed = (v) => (finite(v) ? v.toFixed(2) : "—");
const signed = (v) => (finite(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}` : "—");

/** Drop the nodes `gone` says to drop, and every line that touched one. */
function without(graph, gone) {
  const nodes = graph.nodes.filter((node) => !gone(node));
  const ids = new Set(nodes.map((node) => node.id));
  return { ...graph, nodes, edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) };
}

/**
 * Both graphs for one bar. `data` is the bar the generator returned, `mix` the
 * controls it was generated from, `parts` the three terms of C for a live head
 * (null when there is no headband to split it into), `weights` the weights in
 * force.
 */
export function chainGraphs({ data = null, mix = null, parts = null, weights = null } = {}) {
  const bar = data || {};
  const chain = bar.ui && bar.ui.chain ? bar.ui.chain : null;
  const family = chain && chain.family ? familyById(chain.family) : null;

  let harmony = without(harmonyGraph(bar, chain, family), (node) => node.id.startsWith("rejected:"));
  const floor = harmony.nodes.reduce((max, node) => Math.max(max, node.y + node.r + (node.place === "below" ? 27 : 14)), 0);
  harmony = { ...harmony, height: Math.round(floor + 6) };

  let signal = signalGraph(mix || {}, bar, { parts, weights });
  if (!parts) signal = without(signal, (node) => node.kind === "term");
  const first = GRAPH.columns[0];
  const nodes = signal.nodes.map((node) => ({ ...node, x: Math.round(PAD + (node.x - first) * SQUEEZE) }));
  const right = nodes.reduce((max, node) => Math.max(max, node.x), 0);
  signal = { ...signal, nodes, width: right + LABEL_ROOM };

  return { harmony, signal };
}

/** The lines of text beside the drawings: where the walk is, why this bar is what it is, and the numbers that made it. */
export function chainWords({ data = null, mix = null, bar = null, tempo = null } = {}) {
  const at = data || {};
  const ui = at.ui || {};
  const chain = ui.chain || null;
  const steps = chain && Array.isArray(chain.steps) ? chain.steps : [];
  let walk;
  if (at.vamp) walk = "resting: a root pedal, no chords";
  else if (!steps.length) walk = chain && chain.title ? chain.title : "between progressions";
  else {
    const position = finite(chain.position) ? chain.position : 0;
    const now = Math.min(Math.max(position, 1), steps.length);
    walk = `${chain.title} · step ${now} of ${steps.length}: ${steps[now - 1]}${chain.armed ? " · armed to open" : ""}`;
  }
  const index = finite(bar) ? bar : (finite(at.index) ? at.index : null);
  const bpm = finite(tempo) ? tempo : (finite(at.tempo) ? at.tempo : null);
  const m = mix || {};
  return {
    clock: `bar ${index === null ? "—" : index + 1}${bpm === null ? "" : ` · ${Math.round(bpm)} bpm`}`,
    walk,
    reason: typeof ui.reason === "string" ? ui.reason : "",
    band: `C ${fixed(m.C)} · α ${fixed(m.alphaShare)} · arousal ${fixed(m.arousal)} · motion ${fixed(m.motion)} · asym ${signed(m.asymmetry)}`,
  };
}

// ---------------------------------------------------------------- painting
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

function edgeLine(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x1: from.x + (dx / len) * (from.r + GAP), y1: from.y + (dy / len) * (from.r + GAP),
    x2: to.x - (dx / len) * (to.r + GAP), y2: to.y - (dy / len) * (to.r + GAP),
  };
}

function arcPath(from, to) {
  const y1 = from.y - from.r - GAP;
  const y2 = to.y - to.r - GAP;
  const peak = Math.max(ARC_PEAK, Math.min(y1, y2) - 26);
  return {
    d: `M ${from.x} ${y1} C ${from.x} ${peak}, ${to.x} ${peak}, ${to.x} ${y2}`,
    labelX: Math.round((from.x + to.x) / 2), labelY: Math.round(peak + 2),
    head: `M ${to.x - 4} ${y2 - 6} L ${to.x + 4} ${y2 - 6} L ${to.x} ${y2} z`,
  };
}

/** One graph into one <svg>: balls, lines, and the two lines of text each ball carries. */
function paint(svg, graph, summary) {
  svg.setAttribute("viewBox", `0 0 ${graph.width} ${graph.height}`);
  svg.setAttribute("aria-label", summary);
  svg.style.maxWidth = `${graph.width}px`;
  svg.style.minWidth = `${Math.round(Math.min(graph.width, 560))}px`;
  svg.textContent = "";
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = svgEl("g");
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const state = { "data-live": !!edge.live, "data-dashed": !!edge.dashed, "data-ahead": !!edge.ahead };
    const shape = edge.arc ? arcPath(from, to) : null;
    const line = shape ? null : edgeLine(from, to);
    edges.append(svgEl("path", { class: "ch-edge", d: shape ? shape.d : `M ${line.x1} ${line.y1} L ${line.x2} ${line.y2}`, ...state }));
    if (shape) edges.append(svgEl("path", { class: "ch-edge-head", d: shape.head, ...state }));
    if (edge.label) {
      const label = svgEl("text", {
        class: "ch-edge-label",
        x: shape ? shape.labelX : Math.round(line.x1 + (line.x2 - line.x1) * 0.6),
        y: shape ? shape.labelY : Math.round(line.y1 + (line.y2 - line.y1) * 0.6 + 12),
      });
      if (shape) label.setAttribute("text-anchor", "middle");
      label.textContent = edge.label;
      edges.append(label);
    }
  }
  const nodes = svgEl("g");
  const inset = graph.labelGap || 15;
  for (const node of graph.nodes) {
    const group = svgEl("g", {
      class: "ch-node", "data-node": node.id, "data-kind": node.kind, "data-live": !!node.live,
      "data-state": node.state || "", "data-open": !!node.open, "data-ahead": !!node.ahead,
    });
    const below = node.place === "below";
    const title = svgEl("title");
    title.textContent = [node.label, node.value === "—" ? "" : node.value, node.note].filter(Boolean).join(" · ");
    const label = svgEl("text", { class: "ch-label", x: below ? node.x : node.x + inset, y: below ? node.y + node.r + 14 : node.y - 3 });
    const value = svgEl("text", { class: "ch-value", x: below ? node.x : node.x + inset, y: below ? node.y + node.r + 25 : node.y + 11 });
    if (below) { label.setAttribute("text-anchor", "middle"); value.setAttribute("text-anchor", "middle"); }
    label.textContent = node.label;
    value.textContent = node.value === "—" ? "" : node.value;
    group.append(title, svgEl("circle", { class: "ch-ball", cx: node.x, cy: node.y, r: node.r }), label, value);
    nodes.append(group);
  }
  svg.append(edges, nodes);
}

/**
 * The chains panel. `root` is the <figure> it fills. `show(bar)` paints one bar:
 * { data, mix, parts, weights, bar, tempo, source } with `source` a few words on
 * where the numbers come from ("1 person sharing live", "the session's summary").
 */
export function createChains({ root } = {}) {
  const state = { bar: null, walk: "", current: null, steps: [], C: null, shown: false };
  if (!root || typeof document === "undefined") return { state, show() {}, clear() {} };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  const caption = el("figcaption");
  const clock = el("span", "ch-clock");
  caption.append(el("b", "", "6ense™"), " the chains · how this bar of music was made", clock);
  const how = el("p", "ch-how");
  how.append("Brain signals set the concentration C. C opens the devices, and the chords walk their chain one step at a time. ",
    el("i", "ch-gold", "Gold"), " is sounding, ", el("i", "ch-cold", "blue"), " is in force, ", el("i", "ch-warm", "dashed red"), " comes next.");

  const section = (name, hint) => {
    const head = el("h4", "", name);
    const where = el("span", "", hint);
    head.append(where);
    const svg = svgEl("svg", { class: "ch-svg", role: "img", preserveAspectRatio: "xMinYMin meet", "data-graph": name });
    const scroll = el("div", "ch-scroll");
    scroll.append(svg);
    const line = el("p", "ch-line");
    return { head, where, svg, scroll, line };
  };
  const chord = section("the chord chain", "");
  const signal = section("the signal chain", "");
  root.append(caption, how, chord.head, chord.scroll, chord.line, signal.head, signal.scroll, signal.line);

  return {
    state,

    show({ data, mix = null, parts = null, weights = null, bar = null, tempo = null, source = "" } = {}) {
      if (!data) return;
      const graphs = chainGraphs({ data, mix, parts, weights });
      const words = chainWords({ data, mix, bar, tempo });
      clock.textContent = words.clock;
      chord.where.textContent = words.walk;
      chord.line.textContent = words.reason ? `why this bar: ${words.reason}` : "";
      signal.where.textContent = source ? `from ${source}` : "";
      signal.line.textContent = `the numbers: ${words.band}`;
      paint(chord.svg, graphs.harmony, `the chord chain: ${words.walk}`);
      paint(signal.svg, graphs.signal, `the signal chain: ${words.band}`);
      const current = graphs.harmony.nodes.find((node) => node.state === "current" || node.state === "armed") || null;
      // on a narrow screen the walk is wider than its box: keep the step being played in sight
      if (current && chord.scroll.scrollWidth > chord.scroll.clientWidth + 1) {
        const scale = chord.svg.getBoundingClientRect().width / graphs.harmony.width;
        chord.scroll.scrollLeft = Math.max(0, current.x * scale - chord.scroll.clientWidth / 2);
      }
      Object.assign(state, {
        bar: words.clock, walk: words.walk, current: current ? current.label : null,
        steps: graphs.harmony.nodes.filter((node) => node.id.startsWith("step:")).map((node) => node.label),
        C: mix && finite(mix.C) ? mix.C : null, shown: true,
      });
    },

    clear() {
      state.shown = false;
    },
  };
}
