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
// generator's own rule, not a guess.

import { NOTE_NAMES, QUALITY, familyById } from "./families.js";
import { VOICE_BUDGET, DEVICE_GATES } from "./generator.js";
import { concentrationFromParts, CHANNELS } from "./conditioner.js";
import { DEVICE_LABELS, TIMBRE_LABELS, noteName } from "./explain.js";

// The rack's six devices. The display order and accents are explain.js's: the
// signal ladder names the same devices, and two copies of the table drift.
const DEVICES = DEVICE_LABELS;

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
const FLOOR_DB = -48;          // the meter's left edge; a mix that lives below
                               // this is not audible, so spending scale on it
                               // would hide the part that is
const SVG = "http://www.w3.org/2000/svg";

const CSS = `
.mgu {
  --mgu-fg: #cfcfd6; --mgu-bright: #f0eef0; --mgu-dim: #6f6f7d;
  --mgu-line: #2b2b34; --mgu-panel: #121216; --mgu-accent: #e0b366;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--mgu-fg); background: var(--mgu-panel);
  border: 1px solid var(--mgu-line); border-radius: 6px;
  padding: 10px 12px; display: grid; gap: 10px; text-align: left;
}
.mgu-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
/* The UA rule for [hidden] is a bare tag selector, so any class rule that sets
   a display beats it: a hidden .mgu-head-row (the empty head slots) and the
   in-place sound/voice cells kept laying out. One rule, above every one of them. */
.mgu [hidden] { display: none; }
.mgu-clock { color: var(--mgu-dim); letter-spacing: .04em; }
.mgu-status { color: var(--mgu-fg); min-width: 0; overflow-wrap: anywhere; }
.mgu-status:empty { display: none; }
.mgu-grab {
  font: inherit; color: var(--mgu-fg); background: #1a1a22;
  border: 1px solid var(--mgu-line); border-radius: 4px;
  padding: 2px 9px; cursor: pointer; margin-left: auto;
}
.mgu-grab:hover { border-color: var(--mgu-accent); color: var(--mgu-bright); }
.mgu-grab:focus-visible { outline: 2px solid var(--mgu-accent); outline-offset: 2px; }
.mgu-body { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 12px; align-items: start; }
.mgu-side { display: grid; gap: 12px; align-content: start; }
.mgu-block { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--mgu-line); border-radius: 4px; align-content: start; }
.mgu-label {
  font-size: 10px; letter-spacing: .09em; text-transform: uppercase; color: var(--mgu-dim);
}
.mgu-chain-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.mgu-chain-title { color: var(--mgu-bright); }
.mgu-chain-meta { color: var(--mgu-dim); margin-left: auto; }
.mgu-path { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0; padding: 0; align-items: flex-start; }
.mgu-step {
  position: relative; padding: 6px 9px 11px; min-width: 58px; color: var(--mgu-dim);
  border: 1px solid var(--mgu-line); border-radius: 4px; background: #17171d;
}
.mgu-step[data-state="done"] { opacity: .45; }
.mgu-step[data-state="ahead"] { opacity: .6; }
.mgu-step[data-state="current"] { color: var(--mgu-bright); border-color: var(--mgu-accent); }
.mgu-step[data-state="next"] { color: var(--mgu-fg); border-style: dashed; }
.mgu.is-playing .mgu-step[data-state="current"] { animation: mgu-pulse 1.7s ease-in-out infinite; }
.mgu-step.is-open .mgu-step-label { text-decoration: underline dotted; text-underline-offset: 3px; }
.mgu-step-tag { font-size: 9px; letter-spacing: .06em; color: var(--mgu-dim); margin-left: 4px; }
.mgu-step[data-state="current"] .mgu-step-tag { color: var(--mgu-accent); }
.mgu-step-weight {
  position: absolute; left: 9px; right: 9px; bottom: 4px; height: 2px; background: #23232c;
}
.mgu-step-weight > i { display: block; height: 100%; background: currentColor; opacity: .55; }
.mgu-rejected { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; align-content: start; }
.mgu-reject { color: var(--mgu-dim); }
.mgu-reject-notes { color: #55555f; }
.mgu-reject-why { color: #8a8a96; }
.mgu-reason { margin: 0; color: var(--mgu-fg); overflow-wrap: anywhere; }
.mgu-chord { font-size: 26px; line-height: 1.15; color: var(--mgu-bright); }
.mgu-meta { color: var(--mgu-dim); }
.mgu-cliche { color: var(--mgu-accent); }
.mgu-lookahead { color: var(--mgu-dim); }
.mgu-rack { display: flex; flex-wrap: wrap; gap: 5px; }
.mgu-lamp {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px;
  border: 1px solid var(--mgu-line); border-radius: 999px; color: var(--mgu-dim);
}
.mgu-lamp-dot { width: 7px; height: 7px; border-radius: 50%; background: #2a2a33; }
.mgu-lamp.is-lit { color: var(--mgu-fg); border-color: #3c4b52; }
.mgu-lamp.is-lit .mgu-lamp-dot { background: #7d8f86; }
.mgu-lamp.is-firing { color: var(--mgu-bright); border-color: var(--mgu-accent); }
.mgu-lamp.is-firing .mgu-lamp-dot { background: var(--mgu-accent); box-shadow: 0 0 7px rgba(224,179,102,.85); }
.mgu-ring-wrap { position: relative; width: 88px; height: 88px; }
.mgu-ring-svg { width: 88px; height: 88px; display: block; }
.mgu-ring-track { fill: none; stroke: #262630; stroke-width: 5; }
.mgu-ring-arc {
  fill: none; stroke: var(--mgu-accent); stroke-width: 5; stroke-linecap: round;
  transition: stroke-dasharray .22s linear, stroke .2s linear;
}
.mgu-ring-wrap { display: grid; place-items: center; }
.mgu-ring-value {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 15px; color: var(--mgu-bright);
}
.mgu-ring[data-armed="true"] .mgu-ring-arc { stroke: #e07373; }
.mgu-ring[data-open="true"] .mgu-ring-arc { stroke: #8fbfa6; }
.mgu-ring-state { color: var(--mgu-dim); }
.mgu-ring[data-armed="true"] .mgu-ring-state { color: #e07373; }
.mgu-ring[data-open="true"] .mgu-ring-state { color: #8fbfa6; }
.mgu-meter {
  position: relative; height: 9px; background: #1a1a20;
  border: 1px solid var(--mgu-line); border-radius: 3px; overflow: hidden;
}
.mgu-meter-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #3f5d55, #8fbfa6); }
.mgu-meter-peak { position: absolute; top: 0; bottom: 0; width: 2px; left: 0; background: var(--mgu-accent); }
.mgu-level-text { color: var(--mgu-dim); }
.mgu-caption { color: var(--mgu-dim); overflow-wrap: anywhere; }
.mgu-rows { display: grid; gap: 4px; }
.mgu-row {
  display: grid; gap: 8px; align-items: baseline;
  grid-template-columns: 5.2rem 3.2rem minmax(0, 1.15fr) minmax(0, 1fr);
}
.mgu-row-signal { color: var(--mgu-bright); }
.mgu-row-value { color: var(--mgu-bright); text-align: right; }
.mgu-row-rule { color: var(--mgu-dim); }
.mgu-row-state { color: var(--mgu-fg); }
.mgu-row[data-fired="true"] .mgu-row-state { color: var(--mgu-accent); }
.mgu-lower {
  display: grid; gap: 12px; align-items: start;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.mgu-conc-row {
  display: grid; gap: 2px 8px; align-items: center;
  grid-template-columns: 4.6rem minmax(0, 1fr) 3.8rem;
}
.mgu-conc-term { color: var(--mgu-dim); }
.mgu-conc-bar {
  grid-column: 1 / -1; height: 6px; background: #1a1a20; border: 1px solid var(--mgu-line);
  border-radius: 3px; overflow: hidden;
}
.mgu-conc-bar > i { display: block; height: 100%; width: 0%; background: #7d8f86; }
.mgu-conc-weight { color: var(--mgu-dim); text-align: right; }
.mgu-conc-sum { color: var(--mgu-bright); }
.mgu-conc input[type="range"] {
  width: 100%; min-width: 0; margin: 0; accent-color: var(--mgu-accent);
}
.mgu-conc input[type="range"]:disabled { opacity: .4; }
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
.mgu-lamp-gate { color: var(--mgu-dim); font-size: 10px; }
.mgu-lamp.is-lit .mgu-lamp-gate { color: #7d8f86; }
.mgu-lamp.is-firing .mgu-lamp-gate { color: var(--mgu-accent); }
.mgu-raw-rows { display: grid; gap: 3px; overflow-x: auto; }
.mgu-head-row {
  display: grid; gap: 6px; align-items: baseline; min-width: 42rem;
  grid-template-columns:
    minmax(4.5rem, 1fr) 2.8rem 3rem 3.4rem
    repeat(5, 3.2rem) minmax(10rem, auto);
}
.mgu-head-row > span { white-space: nowrap; }
.mgu-raw-head {
  color: var(--mgu-dim); font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
}
.mgu-num { text-align: right; }
.mgu-raw-note { color: var(--mgu-dim); }
.mgu-raw-note[hidden] { display: none; }
@keyframes mgu-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(224,179,102,.5); }
  50% { box-shadow: 0 0 0 4px rgba(224,179,102,0); }
}
@media (max-width: 900px) { .mgu-lower { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 720px) {
  .mgu-body { grid-template-columns: minmax(0, 1fr); }
  .mgu-row { grid-template-columns: 5rem 3rem minmax(0, 1fr); }
  .mgu-row-rule { grid-column: 1 / -1; }
}
@media (prefers-reduced-motion: reduce) {
  .mgu.is-playing .mgu-step[data-state="current"] { animation: none; }
  .mgu-ring-arc { transition: none; }
}
`;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const svgEl = (tag, attrs) => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/** Write only on change: a redundant textContent write invalidates layout. */
const setText = (node, text) => {
  const next = text == null ? "" : String(text);
  if (node.textContent !== next) node.textContent = next;
};

const pct = (db) => Math.max(0, Math.min(100, ((db - FLOOR_DB) / -FLOOR_DB) * 100));

const fixed = (v, digits = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—");
const signed = (v) => (typeof v === "number" && Number.isFinite(v)
  ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`
  : "—");

/**
 * The family's steps carry the weight the chain view draws -- how many bars the
 * node holds. The chain payload carries labels only, so the list it names is
 * recovered by matching labels: `alt` is the chorus rotation of the same family,
 * and a family that has been rebuilt from a bare label list falls back to one
 * bar per node rather than inventing a rhythm.
 */
function stepEntries(family, labels) {
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
function describeRejection(entry) {
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

function flash(node) {
  if (typeof node.animate !== "function") return;
  node.animate(
    [{ transform: "scale(1)" }, { transform: "scale(1.07)" }, { transform: "scale(1)" }],
    { duration: 420, easing: "ease-out" },
  );
}

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
  head.appendChild(clock);

  let grabButton = null;
  if (typeof onGrab === "function") {
    grabButton = el("button", "mgu-grab", "grab");
    grabButton.type = "button";
    grabButton.setAttribute("data-mg-grab", "");
    grabButton.setAttribute("aria-keyshortcuts", "Space");
    grabButton.addEventListener("click", () => onGrab());
    head.appendChild(grabButton);
  }

  const statusEl = el("span", "mgu-status");
  statusEl.setAttribute("aria-live", "polite");
  head.appendChild(statusEl);
  section.appendChild(head);

  // The ladder: signal -> rule -> what it did, per bar. Full width and above the
  // chain, because it is the input the chain below is the output of.
  const signalsBox = el("section", "mgu-block mgu-signals");
  signalsBox.setAttribute("data-block", "signals");
  const signalsCaption = el("div", "mgu-caption", "band: —");
  const signalList = el("div", "mgu-rows");
  const signalRows = new Map();
  for (const key of LADDER_KEYS) {
    const row = el("div", "mgu-row");
    row.setAttribute("data-signal", key);
    row.dataset.fired = "false";
    const label = el("span", "mgu-row-signal", key);
    const value = el("span", "mgu-row-value", "—");
    const rule = el("span", "mgu-row-rule", "");
    const state = el("span", "mgu-row-state", "—");
    row.append(label, value, rule, state);
    signalList.appendChild(row);
    signalRows.set(key, { row, label, value, rule, state });
  }
  signalsBox.append(el("div", "mgu-label", "signals"), signalsCaption, signalList);
  section.appendChild(signalsBox);

  const body = el("div", "mgu-body");

  // 1. chain view -------------------------------------------------------------
  const chainBox = el("section", "mgu-block mgu-chain");
  chainBox.appendChild(el("div", "mgu-label", "chain"));
  const chainHead = el("div", "mgu-chain-head");
  const chainTitle = el("span", "mgu-chain-title", "—");
  const chainMeta = el("span", "mgu-chain-meta");
  chainHead.append(chainTitle, chainMeta);
  const pathEl = el("ol", "mgu-path");
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
  const reasonEl = el("p", "mgu-reason", "");
  chainBox.append(chainHead, pathEl, rejectedList, reasonEl);
  body.appendChild(chainBox);

  // 2, 3, 4, 5 stack on the right --------------------------------------------
  const side = el("div", "mgu-side");

  const chartBox = el("section", "mgu-block mgu-chart");
  chartBox.appendChild(el("div", "mgu-label", "chart"));
  const chartChord = el("div", "mgu-chord", "—");
  const chartMeta = el("div", "mgu-meta");
  const chartCliche = el("div", "mgu-cliche");
  chartCliche.hidden = true;
  const chartNext = el("div", "mgu-lookahead");
  chartBox.append(chartChord, chartMeta, chartCliche, chartNext);
  side.appendChild(chartBox);

  const devicesBox = el("section", "mgu-block mgu-devices");
  devicesBox.appendChild(el("div", "mgu-label", "devices"));
  const rack = el("div", "mgu-rack");
  const lamps = DEVICES.map(([name, shown]) => {
    const lamp = el("span", "mgu-lamp");
    lamp.setAttribute("data-device", name);
    lamp.dataset.on = "false";
    lamp.dataset.fired = "false";
    const gate = DEVICE_GATES[name];
    lamp.append(
      el("span", "mgu-lamp-dot"),
      el("span", "mgu-lamp-name", shown),
      el("span", "mgu-lamp-gate", gate > 0 ? `≥${gate.toFixed(2)}` : "always"),
    );
    rack.appendChild(lamp);
    return { name, lamp };
  });
  devicesBox.appendChild(rack);
  side.appendChild(devicesBox);

  const ringBox = el("section", "mgu-block mgu-ring");
  ringBox.appendChild(el("div", "mgu-label", "lock-in"));
  ringBox.dataset.armed = "false";
  ringBox.dataset.open = "false";
  const ringWrap = el("div", "mgu-ring-wrap");
  ringWrap.setAttribute("role", "img");
  const ringSvg = svgEl("svg", { class: "mgu-ring-svg", viewBox: "0 0 60 60", "aria-hidden": "true" });
  const ringTrack = svgEl("circle", {
    class: "mgu-ring-track", cx: 30, cy: 30, r: RING_R,
  });
  const ringArc = svgEl("circle", {
    class: "mgu-ring-arc", cx: 30, cy: 30, r: RING_R, transform: "rotate(-90 30 30)",
  });
  ringArc.setAttribute("stroke-dasharray", `0 ${RING_C.toFixed(2)}`);
  ringSvg.append(ringTrack, ringArc);
  const ringValue = el("span", "mgu-ring-value", "0.00");
  ringWrap.append(ringSvg, ringValue);
  const ringState = el("div", "mgu-ring-state");
  ringBox.append(ringWrap, ringState);
  side.appendChild(ringBox);

  const levelBox = el("section", "mgu-block mgu-level");
  levelBox.appendChild(el("div", "mgu-label", "level"));
  const meter = el("div", "mgu-meter");
  meter.setAttribute("role", "meter");
  meter.setAttribute("aria-valuemin", String(FLOOR_DB));
  meter.setAttribute("aria-valuemax", "0");
  meter.setAttribute("aria-valuenow", String(FLOOR_DB));
  meter.setAttribute("aria-label", "master level, dBFS");
  const meterFill = el("div", "mgu-meter-fill");
  const meterPeak = el("div", "mgu-meter-peak");
  meter.append(meterFill, meterPeak);
  const levelText = el("div", "mgu-level-text", "level —");
  levelBox.append(meter, levelText);
  side.appendChild(levelBox);

  body.appendChild(side);
  section.appendChild(body);

  // ------------------------------------------------------------- the lower row
  const lower = el("div", "mgu-lower");

  const concBox = el("section", "mgu-block mgu-conc");
  concBox.setAttribute("data-block", "conc");
  concBox.appendChild(el("div", "mgu-label", "concentration"));
  const concRows = new Map();
  for (const key of CONC_TERMS) {
    const row = el("div", "mgu-conc-row");
    const term = el("span", "mgu-conc-term", key);
    const barWrap = el("div", "mgu-conc-bar");
    const barFill = el("i");
    barWrap.appendChild(barFill);
    const weight = el("span", "mgu-conc-weight", "—");
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
  concBox.appendChild(concSum);
  lower.appendChild(concBox);

  const soundBox = el("section", "mgu-block mgu-sound");
  soundBox.setAttribute("data-block", "sound");
  const soundList = el("div", "mgu-rows");
  const soundRows = new Map();
  for (const [key, label] of SOUND_LABELS) {
    const row = el("div", "mgu-sound-row");
    row.setAttribute("data-sound", key);
    const labelEl = el("span", "mgu-sound-label", label);
    const value = el("span", "mgu-sound-value", "—");
    const delta = el("span", "mgu-sound-delta", "");
    delta.hidden = true;
    row.append(labelEl, value, delta);
    soundList.appendChild(row);
    soundRows.set(key, { row, label: labelEl, value, delta });
  }
  soundBox.append(el("div", "mgu-label", "what C sounds like"), soundList);
  lower.appendChild(soundBox);

  const voicesBox = el("section", "mgu-block mgu-voices");
  voicesBox.setAttribute("data-block", "voices");
  const voiceList = el("div", "mgu-rows");
  const voiceRowsUi = new Map();
  for (const key of VOICE_KEYS) {
    const row = el("div", "mgu-voice-row");
    row.setAttribute("data-voice", key);
    const name = el("span", "mgu-voice-name", key);
    const driven = el("span", "mgu-voice-driven", "");
    const detail = el("span", "mgu-voice-detail", "—");
    const role = el("span", "mgu-voice-role", "");
    role.hidden = true;
    row.append(name, driven, detail, role);
    voiceList.appendChild(row);
    voiceRowsUi.set(key, { row, name, driven, detail, role });
  }
  voicesBox.append(el("div", "mgu-label", "voices"), voiceList);
  lower.appendChild(voicesBox);

  section.appendChild(lower);

  // ------------------------------------------------------- the raw head strip
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
    const who = el("span", "mgu-head-name", "—");
    const c = el("span", "mgu-num", "—");
    const hr = el("span", "mgu-num", "—");
    const rmssd = el("span", "mgu-num", "—");
    const bands = RAW_BANDS.map(() => el("span", "mgu-num", "—"));
    const hsi = el("span", "", "—");
    row.append(who, c, hr, rmssd, ...bands, hsi);
    row.hidden = true;
    rawRows.appendChild(row);
    headSlots.push({ row, who, c, hr, rmssd, bands, hsi });
  }
  const rawNote = el("div", "mgu-raw-note", "no headband: the sliders are the wizard");
  rawBox.append(el("div", "mgu-label", "heads"), rawNote, rawRows);
  section.appendChild(rawBox);

  root.appendChild(section);

  let destroyed = false;
  let pathKey = null;
  let nodes = [];
  let entriesNow = [];
  let lastWeights = null;

  // ------------------------------------------------------------------- chain
  function buildPath(entries) {
    pathEl.textContent = "";
    const maxBars = entries.reduce((max, entry) => Math.max(max, entry.bars), 1) || 1;
    nodes = entries.map((entry, i) => {
      const li = el("li", "mgu-step");
      li.setAttribute("data-step", String(i));
      const label = el("span", "mgu-step-label", entry.label);
      const tag = el("span", "mgu-step-tag", entry.cliche ? "cliché" : "");
      const weight = el("span", "mgu-step-weight");
      const fill = el("i");
      fill.style.width = `${Math.round((entry.bars / maxBars) * 100)}%`;
      weight.appendChild(fill);
      li.append(label, tag, weight);
      pathEl.appendChild(li);
      return { li };
    });
  }

  function renderChain(chain) {
    const labels = chain && Array.isArray(chain.steps) ? chain.steps : [];
    const family = chain && chain.family ? familyById(chain.family) : null;
    const entries = stepEntries(family, labels);
    entriesNow = entries;
    const key = `${chain && chain.family ? chain.family : ""}|${labels.join(",")}`
      + `|${entries.map((entry) => `${entry.bars}${entry.cliche ? "c" : ""}`).join(",")}`;
    if (key !== pathKey) {
      buildPath(entries);
      pathKey = key;
    }

    const position = chain && Number.isFinite(chain.position) ? chain.position : 0;
    const total = labels.length;
    const currentIndex = position > 0 ? Math.min(position - 1, Math.max(total - 1, 0)) : -1;
    const nextIndex = position < total ? position : -1;
    const open = chain && chain.open ? chain.open : null;

    setText(chainTitle, chain && chain.title ? chain.title : "transition");
    const meta = total ? `${Math.max(0, Math.min(position, total))}/${total}` : "—";
    const held = chain && Number.isFinite(chain.held) ? chain.held : null;
    setText(chainMeta, [
      meta,
      held != null && total ? `${held} bar${held === 1 ? "" : "s"} left` : "",
      open ? `open ${open}` : "",
    ].filter(Boolean).join(" · "));

    nodes.forEach(({ li }, i) => {
      const state = i === currentIndex ? "current"
        : i < currentIndex ? "done"
          : i === nextIndex ? "next"
            : "ahead";
      li.dataset.state = state;
      li.classList.toggle("is-open", !!open && entries[i].label === open);
    });
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
      setText(chartChord, "—");
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

  // ----------------------------------------------------------------- devices
  function renderDevices(unlocked, fired) {
    for (const { name, lamp } of lamps) {
      const lit = unlocked.includes(name);
      const firing = fired.includes(name);
      lamp.dataset.on = String(lit);
      lamp.dataset.fired = String(firing);
      lamp.classList.toggle("is-lit", lit);
      lamp.classList.toggle("is-firing", firing);
      if (firing) flash(lamp);
    }
  }

  function firedDevices(data) {
    const out = new Set();
    const chords = Array.isArray(data.chords) ? data.chords : [];
    for (const chord of chords) {
      const devices = chord && Array.isArray(chord.devices) ? chord.devices : [];
      for (const device of devices) out.add(device);
    }
    return [...out];
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
    ringWrap.setAttribute("aria-label", `lock-in ${C.toFixed(2)}${armed ? ", armed" : ""}${open ? ", open chord" : ""}`);
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
      setText(slot.value, row && row.value != null ? row.value : "—");
      setText(slot.rule, row && row.rule != null ? row.rule : "");
      setText(slot.state, row && row.state != null ? row.state : "—");
    }
  }

  function renderSound(rows) {
    const byKey = byKeyOf(rows);
    for (const [key, label] of SOUND_LABELS) {
      const slot = soundRows.get(key);
      const row = byKey.get(key);
      setText(slot.label, row && row.label != null ? row.label : label);
      setText(slot.value, row && row.value != null ? row.value : "—");
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
      setText(slot.detail, row && row.detail != null ? row.detail : "—");
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
        setText(slot.who, "—");
        setText(slot.c, "—");
        setText(slot.hr, "—");
        setText(slot.rmssd, "—");
        slot.bands.forEach((cell) => setText(cell, "—"));
        setText(slot.hsi, "—");
        return;
      }
      setText(slot.who, head.name || head.pseudonym || "—");
      setText(slot.c, fixed(head.C));
      setText(slot.hr, head.bpm == null ? "—" : String(Math.round(head.bpm)));
      setText(slot.rmssd, head.rmssd == null ? "—" : String(Math.round(head.rmssd)));
      RAW_BANDS.forEach(([key], index) => {
        // alpha and beta are shares of their own power; delta/theta/gamma are the
        // mean relative power the conditioner already averages
        const value = key === "alpha" ? head.alphaShare : key === "beta" ? head.betaShare : head[key];
        setText(slot.bands[index], fixed(value));
      });
      setText(slot.hsi, Object.keys(head.hsi || {}).length
        ? CHANNELS.map((ch) => `${ch} ${head.hsi[ch] ?? "—"}`).join(" · ")
        : "—");
    });
  }

  function renderConcentration(parts, mix) {
    const w = lastWeights;
    for (const key of CONC_TERMS) {
      const slot = concRows.get(key);
      const term = parts && typeof parts[key] === "number" ? parts[key] : null;
      const weight = w && typeof w[key] === "number" ? w[key] : null;
      slot.barFill.style.width = `${term == null ? 0 : Math.round(term * 100)}%`;
      setText(slot.weight, weight == null ? "—"
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
      ? `C ${barC == null ? "—" : barC.toFixed(2)}`
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
    setText(clock, `bar ${index == null ? "—" : index}${bpm == null ? "" : ` · ${Math.round(bpm)} bpm`}`);

    const ui = data.ui || {};
    const chain = ui.chain || null;
    const chord = Array.isArray(data.chords) && data.chords.length ? data.chords[0] : null;

    renderChain(chain);
    renderRejected(chord);
    renderChart(data, chain, chord);
    renderDevices(Array.isArray(ui.devices) ? ui.devices : [], firedDevices(data));
    renderRing(ui, chain);
    setText(reasonEl, ui.reason || "");
  }

  function setPlaying(playing) {
    if (destroyed) return;
    const on = !!playing;
    section.dataset.playing = String(on);
    section.classList.toggle("is-playing", on);
  }

  function setLevel(rmsDb, peakDb) {
    if (destroyed) return;
    const rms = Number.isFinite(rmsDb) ? rmsDb : null;
    const peak = Number.isFinite(peakDb) ? peakDb : null;
    meterFill.style.width = `${rms == null ? 0 : pct(rms)}%`;
    meterPeak.style.left = `${peak == null ? 0 : pct(peak)}%`;
    setText(levelText, rms == null ? "level —"
      : `${rms.toFixed(1)} dBFS rms · peak ${peak == null ? "—" : peak.toFixed(1)}`);
    meter.setAttribute("aria-valuenow", String(rms == null ? FLOOR_DB : Math.round(rms)));
  }

  function status(text) {
    if (destroyed) return;
    setText(statusEl, text == null ? "" : String(text));
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (typeof section.getAnimations === "function") {
      for (const animation of section.getAnimations({ subtree: true })) animation.cancel();
    }
    section.remove();
    nodes = [];
    entriesNow = [];
    pathKey = null;
  }

  return {
    bar: updateBar, signals: renderSignals, setPlaying, setLevel, status, destroy,
  };
}
