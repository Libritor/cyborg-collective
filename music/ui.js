// The chain as the instrument: what the generator decided, and why.
//
// One bar arrives about every 1.8 s, so every node is built once and mutated in
// place -- rebuilding the tree each bar would throw away the CSS animation state
// and allocate for nothing. Generator strings are data, never markup: they reach
// the page through textContent, so a label like `i(maj7)` cannot become HTML.
//
// The UI decides nothing. Everything shown is either a field of the bar payload
// or a restatement of the family data it names; where a number is derived (a
// rejected voicing's reason, the cliché's descending 7th) the derivation is the
// generator's own rule, not a guess. The two graphs are `nodes.js`'s: this file
// paints what it is handed and computes no topology of its own.

import { NOTE_NAMES, QUALITY, familyById } from "./families.js";
import { concentrationFromParts, CHANNELS } from "./conditioner.js";
import {
  DEVICE_LABELS, DEVICE_DOCS, PARAMETERS, TIMBRE_LABELS, noteName, parameterFor,
} from "./explain.js";
import {
  signalGraph, harmonyGraph, stepEntries, describeRejection,
} from "./nodes.js";

const QUALITY_WORD = {
  min: "minor",
  maj: "major",
  dim: "diminished",
  min7: "minor 7",
  maj7: "major 7",
  minmaj7: "minor-major 7",
  sus4: "suspended 4",
  sus2: "suspended 2",
};

const MAX_REJECTED = 3;
const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;
// The fixed row sets of the lower blocks. The rows are built once and reused, so
// these are the keys the panel owns; a payload that names a different key is
// dropped rather than appended, and a missing one renders "—".
const CONC_TERMS = ["engagement", "activation", "steadiness"];
const LADDER_KEYS = ["C", "alphaShare", "arousal", "motion", "asymmetry"];
const SOUND_LABELS = TIMBRE_LABELS;   // key + label, from the module that formats them
const VOICE_KEYS = ["drums", "bass", "drone", "pad", "lead"];
const RAW_BANDS = [
  ["delta", "δ rel"], ["theta", "θ rel"], ["alpha", "α share"],
  ["beta", "β share"], ["gamma", "γ rel"],
];
const RAW_SLOTS = 8;             // heads drawn at once; more arrive next frame
const WEIGHT_STEP = 0.05;        // the sliders' step, so a write can be skipped
const EDGE_STUB = 26;            // how far left of a voice an input from the other graph reaches
const SVG = "http://www.w3.org/2000/svg";
const DASH = "—";

const CSS = `
.mgu {
  --mgu-fg: var(--ink, #cfcfd6);
  --mgu-bright: var(--ink, #f0eef0);
  --mgu-dim: var(--dim, #6f6f7d);
  --mgu-faint: var(--faint, #5f5c6a);
  --mgu-line: var(--line, #2b2b34);
  --mgu-rule: var(--rule, #1d1d26);
  --mgu-panel: var(--surface, #121216);
  --mgu-panel-2: var(--surface-2, #17171d);
  --mgu-accent: var(--accent, #e0b366);
  --mgu-cold: var(--cold, #86a7b6);
  --mgu-warm: var(--warm, #e07373);
  --mgu-good: var(--good, #8fbfa6);
  --mgu-serif: var(--serif, "Iowan Old Style", Palatino, ui-serif, serif);
  font: 12px/1.5 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-variant-numeric: tabular-nums;
  color: var(--mgu-fg);
  background: var(--mgu-panel);
  border: 1px solid var(--mgu-line);
  border-radius: 10px;
  padding: 18px 20px;
  display: grid;
  gap: 18px;
  text-align: left;
  box-shadow: inset 0 1px 0 var(--mgu-rule);
}
/* The UA rule for [hidden] is a bare tag selector, so any class rule that sets
   a display beats it: a hidden .mgu-head-row (the empty head slots) and the
   in-place sound/voice cells kept laying out. One rule, above every one of them. */
.mgu [hidden] { display: none; }

/* ------------------------------------------------------------------- header */
.mgu-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.mgu-clock { color: var(--mgu-dim); letter-spacing: .04em; }
.mgu-chain-title { font: 15px/1.25 var(--mgu-serif); color: var(--mgu-bright); }
.mgu-chain-meta { color: var(--mgu-dim); margin-left: auto; }
.mgu-grab {
  font: inherit; color: var(--mgu-fg); background: var(--mgu-panel-2);
  border: 1px solid var(--mgu-line); border-radius: 4px;
  padding: 2px 9px; cursor: pointer;
}
.mgu-grab:hover { border-color: var(--mgu-accent); color: var(--mgu-bright); }
.mgu-grab:focus-visible { outline: 2px solid var(--mgu-accent); outline-offset: 2px; }

/* ------------------------------------------------------------------- blocks */
.mgu-block { display: grid; gap: 8px; align-content: start; min-width: 0; }
.mgu-label {
  font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
  color: var(--mgu-faint); padding-bottom: 6px;
  border-bottom: 1px solid var(--mgu-rule);
}
.mgu-caption { color: var(--mgu-dim); overflow-wrap: anywhere; }
.mgu-reason {
  margin: 0; font: italic 14px/1.5 var(--mgu-serif);
  color: var(--mgu-dim); overflow-wrap: anywhere;
}

/* ------------------------------------------------------------------- graphs */
.mgu-graph { margin: 0; overflow-x: auto; }
.mgu-graph-svg { display: block; width: 100%; min-width: 520px; height: auto; }
.mgu-node-rect { fill: var(--mgu-panel-2); stroke: var(--mgu-line); stroke-width: 1; }
.mgu-node-pip { fill: var(--mgu-line); }
.mgu-node-label {
  font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 11px;
  fill: var(--mgu-fg);
}
.mgu-node-value {
  font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 11px;
  fill: var(--mgu-bright); font-variant-numeric: tabular-nums;
}
.mgu-node[data-live="true"] .mgu-node-pip { fill: var(--mgu-accent); }
.mgu-node[data-state="current"] .mgu-node-rect { stroke: var(--mgu-accent); stroke-width: 1.5; }
/* The open chord is dashed whether or not the chain is standing on it, so a
   family whose open chord is the current step keeps both readings. */
.mgu-node[data-open="true"] .mgu-node-rect {
  stroke: var(--mgu-accent); stroke-width: 1.5; stroke-dasharray: 5 3;
  animation: mgu-dash 1.2s linear infinite;
}
.mgu-node[data-state="armed"] .mgu-node-rect {
  stroke: var(--mgu-warm); stroke-width: 1.5; stroke-dasharray: none; animation: none;
}
.mgu-edge {
  fill: none; stroke: var(--mgu-line); stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.mgu-edge[data-live="true"] { stroke: var(--mgu-cold); stroke-width: 1.5; }
.mgu-edge[data-dashed="true"] { stroke-dasharray: 4 3; }
.mgu-edge-label {
  font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 10px;
  fill: var(--mgu-cold);
}

/* --------------------------------------------------------- the chain sidecar */
.mgu-harmony-grid {
  display: grid; gap: 18px; align-items: start;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
}
.mgu-harmony-side { display: grid; gap: 6px; align-content: start; min-width: 0; }
.mgu-chord { font: 400 30px/1.1 var(--mgu-serif); color: var(--mgu-bright); }
.mgu-meta { color: var(--mgu-dim); }
.mgu-cliche { color: var(--mgu-accent); }
.mgu-lookahead { color: var(--mgu-dim); }
.mgu-rejected { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; align-content: start; }
.mgu-reject { color: var(--mgu-dim); }
.mgu-reject-notes { color: var(--mgu-faint); }
.mgu-reject-why { color: var(--mgu-dim); }

/* -------------------------------------------------------------- ladder + conc */
.mgu-row2 {
  display: grid; gap: 18px; align-items: start;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
}
.mgu-rows { display: grid; gap: 4px; }
.mgu-row {
  display: grid; gap: 8px; align-items: baseline;
  grid-template-columns: 5.2rem 3.4rem minmax(0, 1fr);
}
.mgu-row-signal { color: var(--mgu-bright); }
.mgu-row-value { color: var(--mgu-bright); text-align: right; }
.mgu-row-state { color: var(--mgu-fg); }
.mgu-row[data-fired="true"] .mgu-row-state { color: var(--mgu-accent); }
.mgu-conc-row {
  display: grid; gap: 2px 8px; align-items: center;
  grid-template-columns: 4.6rem minmax(0, 1fr) 3.8rem;
}
.mgu-conc-term { color: var(--mgu-dim); }
.mgu-conc-bar {
  grid-column: 1 / -1; height: 6px; background: var(--mgu-panel-2);
  border: 1px solid var(--mgu-line); border-radius: 3px; overflow: hidden;
}
.mgu-conc-bar > i { display: block; height: 100%; width: 0%; background: var(--mgu-good); }
.mgu-conc-weight { color: var(--mgu-dim); text-align: right; }
.mgu-conc-sum { color: var(--mgu-bright); }
.mgu-conc input[type="range"] {
  width: 100%; min-width: 0; margin: 0; accent-color: var(--mgu-accent);
}
.mgu-conc input[type="range"]:disabled { opacity: .4; }

/* ---------------------------------------------------------------- sound/voices */
.mgu-row3 {
  display: grid; gap: 24px; align-items: start;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.mgu-row3 > .mgu-block + .mgu-block { border-left: 1px solid var(--mgu-rule); padding-left: 24px; }
.mgu-sound-row {
  display: grid; gap: 6px; align-items: baseline;
  grid-template-columns: 6.5rem minmax(0, 1fr) 3.4rem;
}
.mgu-sound-label { color: var(--mgu-dim); }
.mgu-sound-value { color: var(--mgu-bright); text-align: right; }
.mgu-sound-delta { color: var(--mgu-dim); text-align: right; }
.mgu-voice-row {
  display: grid; gap: 6px; align-items: baseline;
  grid-template-columns: 3.6rem minmax(0, 1fr) minmax(0, 1fr) 4.2rem;
}
.mgu-voice-name { color: var(--mgu-bright); }
.mgu-voice-driven { color: var(--mgu-dim); }
.mgu-voice-detail { color: var(--mgu-fg); }
.mgu-voice-role { color: var(--mgu-accent); text-align: right; }

/* --------------------------------------------------------------------- ring */
.mgu-ring-wrap { position: relative; width: 88px; height: 88px; display: grid; place-items: center; }
.mgu-ring-svg { width: 88px; height: 88px; display: block; }
.mgu-ring-track { fill: none; stroke: var(--mgu-line); stroke-width: 5; }
.mgu-ring-arc {
  fill: none; stroke: var(--mgu-accent); stroke-width: 5; stroke-linecap: round;
  transition: stroke-dasharray .22s linear, stroke .2s linear;
}
.mgu-ring-value {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 15px; color: var(--mgu-bright);
}
.mgu-ring[data-armed="true"] .mgu-ring-arc { stroke: var(--mgu-warm); }
.mgu-ring[data-open="true"] .mgu-ring-arc { stroke: var(--mgu-good); }
.mgu-ring-state { color: var(--mgu-dim); }
.mgu-ring[data-armed="true"] .mgu-ring-state { color: var(--mgu-warm); }
.mgu-ring[data-open="true"] .mgu-ring-state { color: var(--mgu-good); }

/* ---------------------------------------------------------------------- raw */
.mgu-raw-rows { display: grid; gap: 3px; overflow-x: auto; }
.mgu-head-row {
  display: grid; gap: 6px; align-items: baseline; min-width: 42rem;
  grid-template-columns:
    minmax(4.5rem, 1fr) 2.8rem 3rem 3.4rem
    repeat(5, 3.2rem) minmax(10rem, auto);
}
.mgu-head-row > span { white-space: nowrap; }
.mgu-raw-head {
  color: var(--mgu-faint); font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
}
.mgu-num { text-align: right; }
.mgu-raw-note { color: var(--mgu-dim); }

@keyframes mgu-dash { to { stroke-dashoffset: -16; } }

@media (max-width: 900px) {
  .mgu-row3 { grid-template-columns: minmax(0, 1fr); }
  .mgu-row3 > .mgu-block + .mgu-block { border-left: 0; padding-left: 0; }
  .mgu-row2 { grid-template-columns: minmax(0, 1fr); }
  .mgu-harmony-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .mgu-node[data-open="true"] .mgu-node-rect { animation: none; }
  .mgu-ring-arc { transition: none; }
}
`;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/** Write only on change: a redundant textContent write invalidates layout. */
const setText = (node, text) => {
  const next = text == null ? "" : String(text);
  if (node.textContent !== next) node.textContent = next;
};

const fixed = (v, digits = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : DASH);
const signed = (v) => (typeof v === "number" && Number.isFinite(v)
  ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`
  : DASH);

/** The cliché's moving voice: the 7th descends a semitone inside the held root. */
function clicheLine(chord) {
  const intervals = QUALITY[chord.quality] || [];
  const pc = ((chord.root % 12) + 12) % 12;
  if (intervals.includes(11)) return `7th ${NOTE_NAMES[(pc + 11) % 12]} → ${NOTE_NAMES[(pc + 10) % 12]}`;
  if (intervals.includes(10)) return `7th ${NOTE_NAMES[(pc + 10) % 12]} held`;
  return "cliché";
}

function ensureStyle(doc) {
  if (!doc || !doc.head) return;
  // The style holder gets its OWN attribute: tagging it `data-mg-ui` put the
  // marker on two elements, and since <head> precedes <body>, a probe using
  // querySelector('[data-mg-ui]') silently measured the stylesheet -- reporting a
  // 0x0, display:none "chain view" whose textContent was the CSS. One marker, one
  // meaning.
  if (doc.head.querySelector("style[data-mg-ui-style]")) return;
  const style = doc.createElement("style");
  style.setAttribute("data-mg-ui-style", "");
  style.textContent = CSS;
  doc.head.appendChild(style);
}

// -------------------------------------------------------------------- drawings
/**
 * A graph host: one <svg> kept for the life of the panel, its children rebuilt
 * only when the node-key string changes and mutated in place otherwise.
 */
function makeGraph(name) {
  const svg = svgEl("svg", {
    class: "mgu-graph-svg", role: "img", preserveAspectRatio: "xMidYMin meet",
  });
  svg.setAttribute("data-graph", name);
  return { svg, key: null, nodes: new Map(), edges: new Map() };
}

const midY = (node) => node.y + node.h / 2;
const baseline = (node) => node.y + node.h / 2 + 4;

function edgePath(from, to) {
  const x1 = from.x + from.w;
  const y1 = midY(from);
  const x2 = to.x;
  const y2 = midY(to);
  return `M ${x1} ${y1} C ${x1 + 12} ${y1}, ${x2 - 12} ${y2}, ${x2} ${y2}`;
}

/**
 * Paint a graph. `summary` is the one sentence a screen reader gets instead of
 * the drawing; it is assembled from the nodes, so it cannot describe a bar the
 * graph is not showing.
 */
function drawGraph(host, graph, summary) {
  const svg = host.svg;
  svg.setAttribute("viewBox", `0 0 ${graph.width} ${graph.height}`);
  svg.setAttribute("aria-label", summary);

  const key = `${graph.nodes.map((n) => `${n.id}|${n.kind}|${n.label}|${n.note}|${n.x},${n.y},${n.w},${n.h}`).join(";")}`
    + `#${graph.edges.map((e) => `${e.from}>${e.to}`).join(",")}`;

  if (key !== host.key) {
    svg.textContent = "";
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));

    const edgeLayer = svgEl("g", { class: "mgu-edges" });
    host.edges = new Map();
    for (const edge of graph.edges) {
      const to = byId.get(edge.to);
      if (!to) continue;
      const from = byId.get(edge.from);
      const path = svgEl("path", { class: "mgu-edge" });
      let labelNode = null;
      if (from) {
        path.setAttribute("d", edgePath(from, to));
      } else {
        // A source in the other graph has no node here: it enters as a short
        // stub at the target's own row, so the line reads as "this came from
        // the harmony" instead of being drawn across the whole canvas.
        const y = midY(to);
        const x = Math.max(0, to.x - EDGE_STUB);
        path.setAttribute("d", `M ${x} ${y} L ${to.x} ${y}`);
      }
      edgeLayer.appendChild(path);
      if (edge.label) {
        labelNode = svgEl("text", { class: "mgu-edge-label" });
        if (from) {
          labelNode.setAttribute("x", String(Math.round((from.x + from.w + to.x) / 2)));
          labelNode.setAttribute("y", String(Math.round((midY(from) + midY(to)) / 2 - 6)));
        } else {
          labelNode.setAttribute("x", String(Math.max(0, to.x - EDGE_STUB)));
          labelNode.setAttribute("y", String(to.y - 2));
        }
        labelNode.textContent = edge.label;
        edgeLayer.appendChild(labelNode);
      }
      host.edges.set(`${edge.from}>${edge.to}`, { path });
    }
    svg.appendChild(edgeLayer);

    const nodeLayer = svgEl("g", { class: "mgu-nodes" });
    host.nodes = new Map();
    for (const node of graph.nodes) {
      const group = svgEl("g", { class: "mgu-node" });
      group.setAttribute("data-node", node.id);
      group.setAttribute("data-kind", node.kind);
      group.setAttribute("data-live", "false");
      group.setAttribute("data-open", "false");
      const rect = svgEl("rect", {
        class: "mgu-node-rect",
        x: node.x, y: node.y, width: node.w, height: node.h, rx: 3,
      });
      const pip = svgEl("rect", {
        class: "mgu-node-pip",
        x: node.x + 1, y: node.y + 6, width: 2, height: node.h - 12,
      });
      const label = svgEl("text", {
        class: "mgu-node-label", x: node.x + 10, y: baseline(node),
      });
      const value = svgEl("text", {
        class: "mgu-node-value", x: node.x + node.w - 8, y: baseline(node),
      });
      value.setAttribute("text-anchor", "end");
      // the sentence a node cannot fit in 190px: the rule or gate it restates
      const title = svgEl("title");
      group.append(title, rect, pip, label, value);
      nodeLayer.appendChild(group);
      host.nodes.set(node.id, { group, label, value, title });
    }
    svg.appendChild(nodeLayer);
    host.key = key;
  }

  // 22 edges and 23 nodes a bar: mutate, never re-create.
  for (const edge of graph.edges) {
    const slot = host.edges.get(`${edge.from}>${edge.to}`);
    if (!slot) continue;
    slot.path.setAttribute("data-live", String(!!edge.live));
    slot.path.setAttribute("data-dashed", String(!!edge.dashed));
  }
  for (const node of graph.nodes) {
    const slot = host.nodes.get(node.id);
    if (!slot) continue;
    slot.group.setAttribute("data-live", String(!!node.live));
    slot.group.setAttribute("data-state", node.state || "");
    slot.group.setAttribute("data-open", String(!!node.open));
    setText(slot.label, node.label);
    setText(slot.value, node.value);
    setText(slot.title, [node.label, node.value, node.note].filter(Boolean).join(" · "));
  }
}

/** The live path, in words, for the graph's aria-label. */
function signalSummary(graph) {
  const find = (id) => graph.nodes.find((node) => node.id === id) || null;
  const C = find("C");
  const gates = find("gates");
  const firing = graph.nodes.filter((node) => node.kind === "rule" && node.live).map((n) => n.label);
  const playing = graph.nodes.filter((node) => node.kind === "voice" && node.live).map((n) => n.label);
  return [
    C && C.value !== DASH ? `C ${C.value}, ${gates ? gates.note : ""}` : "no signal yet",
    `rules firing: ${firing.join(", ") || "none"}`,
    `voices playing: ${playing.join(", ") || "none"}`,
  ].filter(Boolean).join("; ");
}

function harmonySummary(graph, chain) {
  const current = graph.nodes.find((node) => node.state === "current" || node.state === "armed") || null;
  const chords = graph.nodes.filter((node) => node.id.startsWith("chord:")).map((node) => node.label);
  const bits = [];
  if (current) {
    const steps = graph.nodes.filter((node) => node.id.startsWith("step:"));
    const index = steps.indexOf(current);
    bits.push(`step ${index + 1} of ${steps.length}: ${current.label}`);
    if (current.state === "armed") bits.push("armed to open");
  } else if (graph.nodes.length === 1) {
    bits.push(`${graph.nodes[0].label}, ${graph.nodes[0].value}`);
  }
  if (chords.length) bits.push(`this bar: ${chords.join(", ")}`);
  if (chain && chain.open) bits.push(`open ${chain.open}`);
  return bits.join("; ") || "the chain";
}

// ------------------------------------------------------------ the documents
/**
 * The parameter section: every number the panel prints, with the rule it feeds.
 * The panel and this section are generated from the same table in explain.js, so
 * an explanation cannot describe a rule the instrument no longer has.
 */
export function mountParameters({ root } = {}) {
  if (!root) return;
  const list = el("div", "mg-params-list");
  for (const entry of PARAMETERS) {
    const details = el("details", "mg-param");
    details.setAttribute("data-param", entry.id);
    const summary = el("summary");
    // the chip sits apart visually by the flex gap; the space keeps it apart when
    // the summary is read out or copied as text
    summary.append(
      el("span", "mg-param-label", entry.label),
      " ",
      el("span", "mg-chip", `${entry.kind} · ${entry.range}`),
    );
    details.append(
      summary,
      el("div", "mg-param-body", entry.does),
      el("p", "mg-src", `from ${entry.source}`),
    );
    list.appendChild(details);
  }

  const devices = el("details", "mg-param mg-param-devices");
  devices.setAttribute("data-param", "devices");
  const devicesSummary = el("summary");
  devicesSummary.append(
    el("span", "mg-param-label", "devices"),
    " ",
    el("span", "mg-chip", "six gates"),
  );
  const devicesBody = el("div", "mg-param-body");
  mountDevices({ root: devicesBody });
  devices.append(devicesSummary, devicesBody);
  list.appendChild(devices);

  root.appendChild(list);
}

/** The six devices, each with the gate that opens it and the rule it plays. */
export function mountDevices({ root } = {}) {
  if (!root) return;
  for (const doc of DEVICE_DOCS) {
    const found = DEVICE_LABELS.find(([name]) => name === doc.id);
    const details = el("details", "mg-param mg-param-device");
    details.setAttribute("data-device-doc", doc.id);
    const summary = el("summary");
    summary.append(
      el("span", "mg-param-label", found ? found[1] : doc.id),
      " ",
      el("span", "mg-chip", doc.gate > 0 ? `gate ≥${doc.gate.toFixed(2)}` : "always on"),
    );
    details.append(summary, el("div", "mg-param-body", doc.does));
    root.appendChild(details);
  }
}

// ------------------------------------------------------------------- the panel
export function createUI({ root = document.body, onGrab = null, onWeights = null } = {}) {
  const doc = (root && root.ownerDocument) || document;
  ensureStyle(doc);

  const section = el("section", "mgu");
  section.setAttribute("data-mg-ui", "");
  section.setAttribute("role", "group");
  section.setAttribute("aria-label", "MarGoth chain view");

  // ---------------------------------------------------------------- transport
  const head = el("div", "mgu-head");
  const clock = el("span", "mgu-clock", "bar —");
  const chainTitle = el("span", "mgu-chain-title", DASH);
  const chainMeta = el("span", "mgu-chain-meta");
  head.append(clock, chainTitle, chainMeta);
  if (typeof onGrab === "function") {
    const grabButton = el("button", "mgu-grab", "grab");
    grabButton.type = "button";
    grabButton.setAttribute("data-mg-grab", "");
    grabButton.setAttribute("aria-keyshortcuts", "Space");
    grabButton.addEventListener("click", () => onGrab());
    head.appendChild(grabButton);
  }
  section.appendChild(head);

  // ------------------------------------------------------- 1. the harmonic chain
  const harmonyBox = el("section", "mgu-block mgu-harmony");
  harmonyBox.setAttribute("data-block", "harmony");
  const harmonyFigure = el("figure", "mgu-graph");
  const harmonyHost = makeGraph("harmony");
  harmonyFigure.appendChild(harmonyHost.svg);

  const harmonySide = el("div", "mgu-harmony-side");
  const chartChord = el("div", "mgu-chord", DASH);
  const chartMeta = el("div", "mgu-meta");
  const chartCliche = el("div", "mgu-cliche");
  chartCliche.hidden = true;
  const chartNext = el("div", "mgu-lookahead");
  const rejectedList = el("ul", "mgu-rejected");
  const rejectSlots = [];
  for (let i = 0; i < MAX_REJECTED; i += 1) {
    const li = el("li", "mgu-reject");
    const notes = el("span", "mgu-reject-notes");
    const why = el("span", "mgu-reject-why");
    // A real text node, not a CSS gap: the row has to read correctly when it is
    // copied or spoken ("C4 F4 A4 cost 3 ...", never "C4F4A4cost 3").
    li.append(notes, " ", why);
    li.hidden = true;
    rejectedList.appendChild(li);
    rejectSlots.push({ li, notes, why });
  }
  harmonySide.append(chartChord, chartMeta, chartCliche, chartNext, rejectedList);

  const harmonyGrid = el("div", "mgu-harmony-grid");
  harmonyGrid.append(harmonyFigure, harmonySide);
  harmonyBox.append(el("div", "mgu-label", "the chain"), harmonyGrid);
  section.appendChild(harmonyBox);

  // -------------------------------------------------------- 2. the signal chain
  const signalsBox = el("section", "mgu-block mgu-signals");
  signalsBox.setAttribute("data-block", "signals");
  const signalsCaption = el("div", "mgu-caption", "band: —");
  const signalFigure = el("figure", "mgu-graph");
  const signalHost = makeGraph("signal");
  signalFigure.appendChild(signalHost.svg);
  signalsBox.append(el("div", "mgu-label", "the signals"), signalFigure, signalsCaption);
  section.appendChild(signalsBox);

  // --------------------------------------------------------- 3. ladder and conc
  const row2 = el("div", "mgu-row2");

  const ladderBox = el("section", "mgu-block mgu-ladder");
  ladderBox.setAttribute("data-block", "ladder");
  const ladderList = el("div", "mgu-rows");
  const signalRows = new Map();
  for (const key of LADDER_KEYS) {
    const row = el("div", "mgu-row");
    row.setAttribute("data-signal", key);
    row.dataset.fired = "false";
    const entry = parameterFor(key);
    // the rule, one hover away instead of a fourth column that pushed the row
    // out of the panel: the sentence itself lives in explain.js
    if (entry) row.title = entry.does;
    const label = el("span", "mgu-row-signal", entry ? entry.label : key);
    const value = el("span", "mgu-row-value", DASH);
    const state = el("span", "mgu-row-state", DASH);
    row.append(label, value, state);
    ladderList.appendChild(row);
    signalRows.set(key, { row, label, value, state });
  }
  ladderBox.append(el("div", "mgu-label", "the ladder"), ladderList);
  row2.appendChild(ladderBox);

  const concBox = el("section", "mgu-block mgu-conc");
  concBox.setAttribute("data-block", "conc");
  const concRows = new Map();
  for (const key of CONC_TERMS) {
    const row = el("div", "mgu-conc-row");
    const term = el("span", "mgu-conc-term", key);
    const barWrap = el("div", "mgu-conc-bar");
    const barFill = el("i");
    barWrap.appendChild(barFill);
    const weight = el("span", "mgu-conc-weight", DASH);
    const slider = doc.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = String(WEIGHT_STEP);
    slider.value = "0";
    slider.disabled = typeof onWeights !== "function";
    slider.setAttribute("data-weight", key);
    slider.setAttribute("aria-label", `${key} weight`);
    slider.addEventListener("input", () => emitWeights());
    row.append(term, barWrap, weight, slider);
    concBox.appendChild(row);
    concRows.set(key, { row, barFill, weight, slider });
  }
  const concSum = el("div", "mgu-conc-sum", "C —");
  concBox.append(el("div", "mgu-label", "concentration"), concSum);
  row2.appendChild(concBox);
  section.appendChild(row2);

  // -------------------------------------------------- 4. sound, voices, lock-in
  const row3 = el("div", "mgu-row3");

  const soundBox = el("section", "mgu-block mgu-sound");
  soundBox.setAttribute("data-block", "sound");
  const soundList = el("div", "mgu-rows");
  const soundRows = new Map();
  for (const [key, label] of SOUND_LABELS) {
    const row = el("div", "mgu-sound-row");
    row.setAttribute("data-sound", key);
    const labelEl = el("span", "mgu-sound-label", label);
    const value = el("span", "mgu-sound-value", DASH);
    const delta = el("span", "mgu-sound-delta", "");
    delta.hidden = true;
    row.append(labelEl, value, delta);
    soundList.appendChild(row);
    soundRows.set(key, { row, label: labelEl, value, delta });
  }
  soundBox.append(el("div", "mgu-label", "what C sounds like"), soundList);
  row3.appendChild(soundBox);

  const voicesBox = el("section", "mgu-block mgu-voices");
  voicesBox.setAttribute("data-block", "voices");
  const voiceList = el("div", "mgu-rows");
  const voiceRowsUi = new Map();
  for (const key of VOICE_KEYS) {
    const row = el("div", "mgu-voice-row");
    row.setAttribute("data-voice", key);
    const name = el("span", "mgu-voice-name", key);
    const driven = el("span", "mgu-voice-driven", "");
    const detail = el("span", "mgu-voice-detail", DASH);
    const role = el("span", "mgu-voice-role", "");
    role.hidden = true;
    row.append(name, driven, detail, role);
    voiceList.appendChild(row);
    voiceRowsUi.set(key, { row, name, driven, detail, role });
  }
  voicesBox.append(el("div", "mgu-label", "voices"), voiceList);
  row3.appendChild(voicesBox);

  const ringBox = el("section", "mgu-block mgu-ring");
  ringBox.setAttribute("data-block", "ring");
  ringBox.dataset.armed = "false";
  ringBox.dataset.open = "false";
  const ringWrap = el("div", "mgu-ring-wrap");
  ringWrap.setAttribute("role", "img");
  const ringSvg = svgEl("svg", { class: "mgu-ring-svg", viewBox: "0 0 60 60", "aria-hidden": "true" });
  const ringTrack = svgEl("circle", { class: "mgu-ring-track", cx: 30, cy: 30, r: RING_R });
  const ringArc = svgEl("circle", {
    class: "mgu-ring-arc", cx: 30, cy: 30, r: RING_R, transform: "rotate(-90 30 30)",
  });
  ringArc.setAttribute("stroke-dasharray", `0 ${RING_C.toFixed(2)}`);
  ringSvg.append(ringTrack, ringArc);
  const ringValue = el("span", "mgu-ring-value", "0.00");
  ringWrap.append(ringSvg, ringValue);
  const ringState = el("div", "mgu-ring-state");
  ringBox.append(el("div", "mgu-label", "lock-in"), ringWrap, ringState);
  row3.appendChild(ringBox);
  section.appendChild(row3);

  // ------------------------------------------------------- 5. the raw head strip
  const rawBox = el("section", "mgu-block mgu-raw");
  rawBox.setAttribute("data-block", "raw");
  const rawRows = el("div", "mgu-raw-rows");
  const rawHead = el("div", "mgu-head-row mgu-raw-head");
  for (const text of ["head", "C", "hr", "rmssd", ...RAW_BANDS.map(([, shown]) => shown), "hsi"]) {
    rawHead.appendChild(el("span", text === "head" || text === "hsi" ? "" : "mgu-num", text));
  }
  rawRows.appendChild(rawHead);
  const headSlots = [];
  for (let i = 0; i < RAW_SLOTS; i += 1) {
    const row = el("div", "mgu-head-row");
    const who = el("span", "mgu-head-name", DASH);
    const c = el("span", "mgu-num", DASH);
    const hr = el("span", "mgu-num", DASH);
    const rmssd = el("span", "mgu-num", DASH);
    const bands = RAW_BANDS.map(() => el("span", "mgu-num", DASH));
    const hsi = el("span", "", DASH);
    row.append(who, c, hr, rmssd, ...bands, hsi);
    row.hidden = true;
    rawRows.appendChild(row);
    headSlots.push({ row, who, c, hr, rmssd, bands, hsi });
  }
  const rawNote = el("div", "mgu-raw-note", "no headband: the sliders are the wizard");
  rawBox.append(el("div", "mgu-label", "heads"), rawNote, rawRows);
  section.appendChild(rawBox);

  // ------------------------------------------------------ 6. why this bar exists
  const reasonEl = el("p", "mgu-reason", "");
  section.appendChild(reasonEl);

  root.appendChild(section);

  let destroyed = false;
  let entriesNow = [];
  let lastWeights = null;
  let lastData = null;

  // ------------------------------------------------------------------- chain
  function renderChain(chain) {
    const labels = chain && Array.isArray(chain.steps) ? chain.steps : [];
    const family = chain && chain.family ? familyById(chain.family) : null;
    entriesNow = stepEntries(family, labels);

    const position = chain && Number.isFinite(chain.position) ? chain.position : 0;
    const total = labels.length;
    const open = chain && chain.open ? chain.open : null;

    setText(chainTitle, chain && chain.title ? chain.title : "transition");
    const meta = total ? `${Math.max(0, Math.min(position, total))}/${total}` : DASH;
    const held = chain && Number.isFinite(chain.held) ? chain.held : null;
    setText(chainMeta, [
      meta,
      held != null && total ? `${held} bar${held === 1 ? "" : "s"} left` : "",
      open ? `open ${open}` : "",
    ].filter(Boolean).join(" · "));
  }

  function renderRejected(chord) {
    const rejected = chord && Array.isArray(chord.rejected) ? chord.rejected : [];
    rejectSlots.forEach((slot, i) => {
      const entry = rejected[i];
      if (entry === undefined) {
        slot.li.hidden = true;
        setText(slot.notes, "");
        setText(slot.why, "");
        return;
      }
      const described = describeRejection(entry);
      slot.li.hidden = false;
      setText(slot.notes, described.notes);
      setText(slot.why, described.why);
    });
  }

  // ------------------------------------------------------------------- chart
  function renderChart(data, chain, chord) {
    const labels = chain && Array.isArray(chain.steps) ? chain.steps : [];
    const position = chain && Number.isFinite(chain.position) ? chain.position : 0;

    if (data.vamp) {
      setText(chartChord, "vamp");
      setText(chartMeta, "root only · no harmony");
    } else if (chord) {
      setText(chartChord, chord.label);
      setText(chartMeta, [
        QUALITY_WORD[chord.quality] || chord.quality,
        `degree ${chord.degree}`,
        chord.cliche ? "cliché" : "",
      ].filter(Boolean).join(" · "));
    } else {
      setText(chartChord, DASH);
      setText(chartMeta, "no chord");
    }

    if (!data.vamp && chord && chord.cliche) {
      chartCliche.hidden = false;
      setText(chartCliche, clicheLine(chord));
    } else {
      chartCliche.hidden = true;
      setText(chartCliche, "");
    }

    const parts = [];
    const inBar = Array.isArray(data.chords) && data.chords.length > 1 ? data.chords[1] : null;
    if (inBar) parts.push(`then ${inBar.label} at step ${inBar.step}`);
    if (position < labels.length) {
      const next = entriesNow[position];
      const bars = next ? next.bars : 1;
      parts.push(`next ${labels[position]}${next && next.cliche ? " (cliché)" : ""}`
        + ` · ${bars} bar${bars === 1 ? "" : "s"}`);
    }
    setText(chartNext, parts.join(" · "));
  }

  // -------------------------------------------------------------------- ring
  function renderRing(ui, chain) {
    const C = Number.isFinite(ui.C) ? Math.min(1, Math.max(0, ui.C)) : 0;
    ringArc.setAttribute("stroke-dasharray", `${(RING_C * C).toFixed(2)} ${RING_C.toFixed(2)}`);
    setText(ringValue, C.toFixed(2));
    const armed = !!(chain && chain.armed);
    const open = !!ui.release;
    ringBox.dataset.armed = String(armed);
    ringBox.dataset.open = String(open);
    ringWrap.setAttribute("aria-label",
      `lock-in ${C.toFixed(2)}${armed ? ", armed" : ""}${open ? ", open chord" : ""}`);
    setText(ringState, open ? "open chord: the lock let go"
      : armed ? "armed: the drop opens the chord"
        : C >= 0.55 ? "locked in" : "holding");
  }

  // ----------------------------------------------------------------- signals
  /** The three sliders as a weights change: raw values, so the caller can judge. */
  function emitWeights() {
    if (typeof onWeights !== "function") return;
    const next = {};
    for (const key of CONC_TERMS) next[key] = Number(concRows.get(key).slider.value);
    onWeights(next);
  }

  /** One key per row, however the payload names it (signal / key / voice). */
  function byKeyOf(rows) {
    const out = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row) continue;
      const key = row.signal ?? row.key ?? row.voice;
      if (key != null) out.set(key, row);
    }
    return out;
  }

  function renderLadder(rows) {
    const byKey = byKeyOf(rows);
    for (const key of LADDER_KEYS) {
      const slot = signalRows.get(key);
      const row = byKey.get(key);
      slot.row.dataset.fired = String(!!row && row.flag === true);
      setText(slot.label, row && row.label != null ? row.label : key);
      setText(slot.value, row && row.value != null ? row.value : DASH);
      setText(slot.state, row && row.state != null ? row.state : DASH);
    }
  }

  function renderSound(rows) {
    const byKey = byKeyOf(rows);
    for (const [key, label] of SOUND_LABELS) {
      const slot = soundRows.get(key);
      const row = byKey.get(key);
      setText(slot.label, row && row.label != null ? row.label : label);
      setText(slot.value, row && row.value != null ? row.value : DASH);
      const delta = row && row.delta != null && row.delta !== "" ? row.delta : null;
      slot.delta.hidden = delta === null;
      setText(slot.delta, delta === null ? "" : delta);
    }
  }

  function renderVoices(rows) {
    const byKey = byKeyOf(rows);
    for (const key of VOICE_KEYS) {
      const slot = voiceRowsUi.get(key);
      const row = byKey.get(key);
      setText(slot.name, key);
      setText(slot.driven, row && row.drivenBy != null ? row.drivenBy : "");
      setText(slot.detail, row && row.detail != null ? row.detail : DASH);
      const role = row && row.role != null ? String(row.role) : null;
      slot.role.hidden = role === null;
      setText(slot.role, role === null ? "" : role);
    }
  }

  function renderHeads(heads) {
    const list = Array.isArray(heads) ? heads : [];
    rawNote.hidden = list.length > 0;
    setText(rawNote, list.length ? "" : "no headband: the sliders are the wizard");
    headSlots.forEach((slot, i) => {
      const head = list[i];
      slot.row.hidden = !head;
      if (!head) {
        setText(slot.who, DASH);
        setText(slot.c, DASH);
        setText(slot.hr, DASH);
        setText(slot.rmssd, DASH);
        slot.bands.forEach((cell) => setText(cell, DASH));
        setText(slot.hsi, DASH);
        return;
      }
      setText(slot.who, head.name || head.pseudonym || DASH);
      setText(slot.c, fixed(head.C));
      setText(slot.hr, head.bpm == null ? DASH : String(Math.round(head.bpm)));
      setText(slot.rmssd, head.rmssd == null ? DASH : String(Math.round(head.rmssd)));
      RAW_BANDS.forEach(([key], index) => {
        // alpha and beta are shares of their own power; delta/theta/gamma are the
        // mean relative power the conditioner already averages
        const value = key === "alpha" ? head.alphaShare : key === "beta" ? head.betaShare : head[key];
        setText(slot.bands[index], fixed(value));
      });
      setText(slot.hsi, Object.keys(head.hsi || {}).length
        ? CHANNELS.map((ch) => `${ch} ${head.hsi[ch] ?? DASH}`).join(" · ")
        : DASH);
    });
  }

  function renderConcentration(parts, mix) {
    const w = lastWeights;
    for (const key of CONC_TERMS) {
      const slot = concRows.get(key);
      const term = parts && typeof parts[key] === "number" ? parts[key] : null;
      const weight = w && typeof w[key] === "number" ? w[key] : null;
      slot.barFill.style.width = `${term == null ? 0 : Math.round(term * 100)}%`;
      setText(slot.weight, weight == null ? DASH
        : term == null ? `×${weight.toFixed(2)}` : `×${weight.toFixed(2)} = ${(term * weight).toFixed(2)}`);
      if (weight == null || doc.activeElement === slot.slider) continue;
      // A normalised weight (0.4545) is not on the slider's 0.05 grid, so compare
      // where the thumb would actually sit: otherwise every bar rewrites a value
      // the user is in the middle of dragging.
      const snapped = Math.round(weight / WEIGHT_STEP) * WEIGHT_STEP;
      if (Math.abs(Number(slot.slider.value) - snapped) > 1e-9) slot.slider.value = String(weight);
    }
    const weighted = parts ? concentrationFromParts(parts, w || undefined) : null;
    const barC = mix && typeof mix.C === "number" ? mix.C : null;
    setText(concSum, weighted == null
      ? `C ${barC == null ? DASH : barC.toFixed(2)}`
      : `C ${weighted.toFixed(2)}`);
  }

  function renderCaption(mix) {
    if (!mix) {
      setText(signalsCaption, "band: —");
      return;
    }
    setText(signalsCaption, `band: ${[
      `C ${fixed(mix.C)}`,
      `α ${fixed(mix.alphaShare)}`,
      `arousal ${fixed(mix.arousal)}`,
      `motion ${fixed(mix.motion)}`,
      `asym ${signed(mix.asymmetry)}`,
    ].join(" · ")}`);
  }

  /** Both graphs, from the bar that is on screen and the mix that made it. */
  function renderGraphs(mix) {
    const data = lastData || {};
    const chain = (data.ui && data.ui.chain) || null;
    const family = chain && chain.family ? familyById(chain.family) : null;
    const harmony = harmonyGraph(data, chain, family);
    drawGraph(harmonyHost, harmony, harmonySummary(harmony, chain));
    const signal = signalGraph(mix, data);
    drawGraph(signalHost, signal, signalSummary(signal));
  }

  /**
   * Everything the panel says about the inputs. `mix` is the controls the bar was
   * generated from, `parts` its concentration terms (null with no headband),
   * `weights` the effective weights, and the three lists are explain.js's rows.
   */
  function renderSignals({
    mix = null, ladder = [], sound = [], voices = [], heads = null, weights = null, parts = null,
  } = {}) {
    if (destroyed) return;
    if (weights) lastWeights = weights;
    renderCaption(mix);
    renderGraphs(mix);
    renderLadder(ladder);
    renderSound(sound);
    renderVoices(voices);
    renderHeads(heads);
    renderConcentration(parts, mix);
  }

  // --------------------------------------------------------------------- api
  function updateBar({ data, bar, tempo } = {}) {
    if (destroyed || !data) return;
    const index = Number.isFinite(bar) ? bar : (Number.isFinite(data.index) ? data.index : null);
    const bpm = Number.isFinite(tempo) ? tempo : (Number.isFinite(data.tempo) ? data.tempo : null);
    setText(clock, `bar ${index == null ? DASH : index}${bpm == null ? "" : ` · ${Math.round(bpm)} bpm`}`);

    lastData = data;
    const ui = data.ui || {};
    const chain = ui.chain || null;
    const chord = Array.isArray(data.chords) && data.chords.length ? data.chords[0] : null;

    renderChain(chain);
    renderRejected(chord);
    renderChart(data, chain, chord);
    renderRing(ui, chain);
    setText(reasonEl, ui.reason || "");
  }

  function setPlaying(playing) {
    if (destroyed) return;
    const on = !!playing;
    section.dataset.playing = String(on);
    section.classList.toggle("is-playing", on);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (typeof section.getAnimations === "function") {
      for (const animation of section.getAnimations({ subtree: true })) animation.cancel();
    }
    section.remove();
    entriesNow = [];
    lastData = null;
    harmonyHost.key = null;
    signalHost.key = null;
  }

  return { bar: updateBar, signals: renderSignals, setPlaying, destroy };
}
