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
import { VOICE_BUDGET } from "./generator.js";

// Exactly the plan's six. `cliche` is printed with its accent; the data key is
// the ASCII one the generator emits.
const DEVICES = [
  ["sus", "sus"],
  ["cliche", "cliché"],
  ["drone", "drone"],
  ["mixture", "mixture"],
  ["climb", "climb"],
  ["bII", "bII"],
];

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
@keyframes mgu-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(224,179,102,.5); }
  50% { box-shadow: 0 0 0 4px rgba(224,179,102,0); }
}
@media (max-width: 720px) { .mgu-body { grid-template-columns: minmax(0, 1fr); } }
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

const noteName = (midi) => `${NOTE_NAMES[(((midi % 12) + 12) % 12)]}${Math.floor(midi / 12) - 1}`;

const pct = (db) => Math.max(0, Math.min(100, ((db - FLOOR_DB) / -FLOOR_DB) * 100));

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
  if (doc.head.querySelector("style[data-mg-ui]")) return;
  const style = doc.createElement("style");
  style.setAttribute("data-mg-ui", "");
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

export function createUI({ root = document.body, onGrab = null } = {}) {
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
    lamp.append(el("span", "mgu-lamp-dot"), el("span", "mgu-lamp-name", shown));
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
  root.appendChild(section);

  let destroyed = false;
  let pathKey = null;
  let nodes = [];
  let entriesNow = [];

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

  return { bar: updateBar, setPlaying, setLevel, status, destroy };
}
