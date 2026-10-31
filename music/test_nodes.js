// The two graphs as data: topology, geometry and liveness, with no browser.
// Run: node music/test_nodes.js -> "PASS <n> assertions", exit 0.

import {
  GRAPH, signalGraph, harmonyGraph, stepEntries, describeRejection, gateText,
} from "./nodes.js";
import {
  DEVICE_GATES, devicesAt, FAMILIES,
} from "./generator.js";
import {
  PARAMETERS, DEVICE_DOCS, DEVICE_LABELS, ladderRows, parameterFor,
} from "./explain.js";

let assertions = 0;
const failures = [];
function check(condition, label) {
  assertions += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

const ids = (graph) => graph.nodes.map((node) => node.id);
const pairs = (graph) => graph.edges.map((edge) => `${edge.from}|${edge.to}`);
const edgeBetween = (graph, from, to) => graph.edges.find((e) => e.from === from && e.to === to) || null;

// The topology this renderer is allowed to assume, straight from the plan: if a
// column, a row or an edge moves, that is a design change, not a refactor.
const SIGNAL_IDS = [
  "C", "alphaShare", "arousal", "motion", "asymmetry",
  "gates", "hats", "openhat", "ghost", "fill", "register",
  "timbre", "dev:sus", "dev:cliche", "dev:drone", "dev:mixture", "dev:climb", "dev:bII",
  "voice:drums", "voice:bass", "voice:drone", "voice:pad", "voice:lead",
];
const SIGNAL_EDGES = [
  ["C", "gates"], ["C", "hats"], ["C", "timbre"],
  ["alphaShare", "openhat"], ["arousal", "ghost"], ["motion", "fill"], ["asymmetry", "register"],
  ["gates", "dev:sus"], ["gates", "dev:cliche"], ["gates", "dev:drone"],
  ["gates", "dev:mixture"], ["gates", "dev:climb"], ["gates", "dev:bII"],
  ["hats", "voice:drums"], ["openhat", "voice:drums"], ["ghost", "voice:drums"], ["fill", "voice:drums"],
  ["chord", "voice:bass"], ["chord", "voice:pad"],
  ["dev:cliche", "voice:pad"], ["dev:drone", "voice:drone"], ["register", "voice:lead"],
];

// ------------------------------------------------------------------ fixtures
const HOT_MIX = {
  C: 0.95, alphaShare: 0.5, arousal: 0.9, motion: 0.3, asymmetry: -0.2,
};
const HOT_BAR = {
  index: 3,
  drums: [
    { step: 0, hit: "kick" }, { step: 15, hit: "kick" }, { step: 14, hit: "hatO" },
    { step: 12, hit: "snare" }, { step: 13, hit: "tomH" }, { step: 14, hit: "tomL" },
  ],
  bass: [{ step: 0, midi: 33 }, { step: 2, midi: 40 }],
  lead: [{ step: 0, midi: 76 }, { step: 4, midi: 79 }],
  drone: 45,
  timbre: { bassCutoff: 939 },
  chords: [{
    step: 0, label: "Am", quality: "min", voicing: [57, 60, 64], cliche: false,
    rejected: [{ voicing: [60, 64, 69], cost: 7 }],
  }],
};
const QUIET_MIX = { C: 0.2, alphaShare: 0.1, arousal: 0.2, motion: 0.01, asymmetry: 0.1 };
const QUIET_BAR = { index: 0, drums: [{ step: 0, hit: "kick" }], chords: [], bass: [], lead: [] };

// A family the generator does not ship, so the layout is measured on seven steps
// (no shipped family is that long) without the test pretending to be a family.
const SEVEN = {
  id: "seven",
  title: "seven",
  open: { label: "vi" },
  steps: [
    { label: "i", bars: 2 }, { label: "bIII", bars: 1 }, { label: "bVI", bars: 1, cliche: true },
    { label: "iv", bars: 2 }, { label: "bVII", bars: 1 }, { label: "V", bars: 1 },
    { label: "vi", bars: 2 },
  ],
};

// ------------------------------------------------------------- signal: shape
console.log("signal graph");
const hot = signalGraph(HOT_MIX, HOT_BAR);
check(JSON.stringify(ids(hot)) === JSON.stringify(SIGNAL_IDS),
  `the node ids and their order are the plan's (${hot.nodes.length})`);
const wanted = SIGNAL_EDGES.map(([from, to]) => `${from}|${to}`).sort();
const got = pairs(hot).slice().sort();
check(JSON.stringify(got) === JSON.stringify(wanted),
  `the ${SIGNAL_EDGES.length} edges are exactly the plan's (${hot.edges.length})`);

const known = new Set(ids(hot));
const dangling = hot.edges.filter((edge) => !known.has(edge.to) || (!known.has(edge.from) && edge.from !== "chord"));
check(dangling.length === 0, `every edge endpoint is a node (${dangling.length} dangling)`);
const fromChord = hot.edges.filter((edge) => edge.from === "chord");
check(fromChord.length === 2, `exactly two edges enter from the other graph (${fromChord.length})`);
check(fromChord.every((edge) => edge.label === "chord"),
  "and they are labelled, so the renderer can draw the line it comes in on");

const outside = hot.nodes.filter((node) => node.x < 0 || node.x + node.w > GRAPH.width
  || node.y < 0 || node.y + node.h > GRAPH.height);
check(outside.length === 0, `no node leaves the ${GRAPH.width}x${GRAPH.height} viewBox (${outside.length})`);
const byColumn = new Map();
for (const node of hot.nodes) byColumn.set(node.x, [...(byColumn.get(node.x) || []), node]);
const ordered = [...byColumn.values()].every((column) => column
  .every((node, i) => i === 0 || node.y > column[i - 1].y));
check(ordered, "rows within a column run strictly down the page, in the listed order");
check([...new Set(hot.nodes.map((node) => node.kind))].sort().join(",")
  === "device,rule,signal,timbre,voice",
"the node kinds are the vocabulary the renderer styles");

// --------------------------------------------------------- signal: liveness
console.log("signal liveness");
const liveOf = (graph, id) => {
  const node = graph.nodes.find((n) => n.id === id);
  return node ? node.live : null;
};
const fired = ["gates", "hats", "openhat", "ghost", "fill", "register"];
check(fired.every((id) => liveOf(hot, id) === true),
  `a hot bar lights every rule it fired (${fired.filter((id) => liveOf(hot, id) !== true).join(",") || "all"})`);
check(hot.nodes.filter((node) => node.id.startsWith("dev:")).every((node) => node.live),
  "and opens all six devices");
check(["hats", "openhat", "ghost", "fill"].every((id) => edgeBetween(hot, id, "voice:drums").live),
  "the four drum rules light their edges into the drums");
check(edgeBetween(hot, "dev:cliche", "voice:pad").live === false,
  "the cliché's edge is dark while the bar's chord is not one");
const clicheBar = { ...HOT_BAR, chords: [{ ...HOT_BAR.chords[0], cliche: true }] };
check(edgeBetween(signalGraph(HOT_MIX, clicheBar), "dev:cliche", "voice:pad").live === true,
  "and lights on the bar where the cliché owns the top voice");

const quiet = signalGraph(QUIET_MIX, QUIET_BAR);
check(["hats", "openhat", "ghost", "fill", "register"].every((id) => liveOf(quiet, id) === false),
  "a quiet bar lights none of the probabilistic rules");
check(quiet.nodes.filter((node) => node.id.startsWith("dev:")).filter((n) => n.live)
  .map((node) => node.id.slice(4)).join(",") === devicesAt(0.2).join(","),
  "and only the devices its concentration opens");
check(edgeBetween(quiet, "dev:cliche", "voice:pad").live === false,
  "the cliché edge is dark on a bar that is not a cliché");

let deviceMismatch = 0;
for (let i = 0; i <= 20; i += 1) {
  const C = i / 20;
  const graph = signalGraph({ C }, {});
  const lit = graph.nodes.filter((n) => n.id.startsWith("dev:") && n.live).map((n) => n.id.slice(4));
  if (lit.join(",") !== devicesAt(C).join(",")) deviceMismatch += 1;
}
check(deviceMismatch === 0, `over 21 concentrations the lit devices are devicesAt(C), in order (${deviceMismatch} off)`);
check(hot.nodes.filter((node) => node.id.startsWith("dev:"))
  .every((node) => node.note === gateText(node.id.slice(4))),
"every device node prints the gate the generator enforces");

// ----------------------------------------------------------- signal: values
console.log("signal values");
const mixes = [
  ["no mix, no bar", {}, {}],
  ["a vamp", { C: 0.1, mode: "vamp", heads: 0 }, { vamp: true, index: 0 }],
  ["a full bar", HOT_MIX, HOT_BAR],
  ["nothing at all", null, null],
];
for (const [label, mix, bar] of mixes) {
  const graph = signalGraph(mix, bar);
  const values = graph.nodes.map((node) => node.value);
  const bad = values.filter((value) => typeof value !== "string"
    || value.includes("NaN") || value.includes("undefined") || value.includes("null"));
  check(bad.length === 0, `${label}: every value is a printable string (${bad.join(",") || "ok"})`);
  check(graph.nodes.length === SIGNAL_IDS.length, `${label}: still every node`);
}

// ------------------------------------------------------------ harmony: path
console.log("harmony graph");
const labels = SEVEN.steps.map((step) => step.label);
const chain = {
  family: SEVEN.id, title: SEVEN.title, steps: labels,
  position: 4, open: SEVEN.open.label, armed: false, held: 1,
};
const path = harmonyGraph({ index: 9, chords: [] }, chain, SEVEN);
check(path.nodes.filter((node) => node.id.startsWith("step:")).length === 7,
  `a seven-step family draws seven steps (${path.nodes.length} nodes)`);
const steps = path.nodes.filter((node) => node.id.startsWith("step:"));
check(steps.every((node, i) => i === 0 || node.x > steps[i - 1].x), "the steps run left to right");
check(steps[steps.length - 1].x + steps[steps.length - 1].w <= path.width,
  `and the last one ends inside the box (${steps[steps.length - 1].x + steps[steps.length - 1].w} of ${path.width})`);
const current = path.nodes.find((node) => node.state === "current");
check(current && current.id === `step:${chain.position - 1}`,
  `the current step is position - 1 (${current && current.id})`);
check(path.nodes.filter((node) => node.state === "current").length === 1,
  "and it is the only current step: position is one fact, not a per-node guess");
check(path.nodes.filter((node) => node.open === true).length === 1,
  "the open chord is marked once");
check(path.nodes.filter((node) => node.open === true)[0].label === SEVEN.open.label,
  "and it is the family's open chord");
check(path.edges.filter((edge) => edge.live).length === chain.position,
  `the path travelled so far is lit (${path.edges.filter((e) => e.live).length} of ${path.edges.length} edges)`);

const armedPath = harmonyGraph({ index: 9, chords: [] }, { ...chain, armed: true }, SEVEN);
const armedNode = armedPath.nodes.find((node) => node.state === "armed");
check(armedNode && armedNode.id === `step:${chain.position - 1}`,
  "armed overrides current on the same step, because a drop is the louder fact");
check(armedPath.nodes.filter((node) => node.state === "current").length === 0,
  "and leaves no second state behind");

// A family can be standing on its own open chord (open IV on the last step): the
// two facts then hold on one node, which is why they are two fields.
const OPEN_LAST = {
  id: "open-last", title: "open-last", open: { label: "IV" },
  steps: [{ label: "i", bars: 2 }, { label: "IV", bars: 2 }],
};
const standing = harmonyGraph({ index: 4, chords: [] },
  { family: OPEN_LAST.id, steps: ["i", "IV"], position: 2, open: "IV", armed: false }, OPEN_LAST);
check(standing.nodes[1].state === "current" && standing.nodes[1].open === true,
  "the step you are on can also be the open chord, and both are drawn");

// ------------------------------------------------- harmony: this bar's chords
const susBar = {
  index: 12,
  chords: [
    { step: 0, label: "Am", quality: "min", voicing: [57, 60, 64], cliche: false, rejected: [] },
    { step: 8, label: "Asus4", quality: "sus4", voicing: [57, 62, 64], cliche: false, rejected: [] },
    { step: 12, label: "Am", quality: "min", voicing: [57, 60, 64], cliche: false, rejected: [] },
  ],
};
const susGraph = harmonyGraph(susBar, chain, SEVEN);
const chordNodes = susGraph.nodes.filter((node) => node.id.startsWith("chord:"));
check(chordNodes.length === 3, `a sus bar draws its three chord events (${chordNodes.length})`);
check(susGraph.edges.filter((edge) => edge.to.startsWith("chord:")).length === 3,
  "each hanging off the step being played");
check(chordNodes.map((node) => node.label).join(",") === "Am,Asus4,Am",
  "with the labels the chart prints");
check(chordNodes.every((node) => node.x >= 0 && node.x + node.w <= susGraph.width),
  "and the group is nudged inside the box rather than off it");
check(susGraph.nodes.filter((node) => node.y + node.h > susGraph.height).length === 0,
  `nothing is clipped by the box height (${susGraph.height})`);

const rejectedBar = {
  index: 12,
  chords: [{
    step: 0, label: "Am", quality: "min", voicing: [57, 60, 64], cliche: false,
    rejected: [{ voicing: [57, 64, 69], cost: 0 }, { voicing: [60, 64, 69], cost: 7 }],
  }],
};
const rejectedGraph = harmonyGraph(rejectedBar, chain, SEVEN);
const lost = rejectedGraph.edges.filter((edge) => edge.to.startsWith("rejected:"));
check(lost.length === 2, `two rejected voicings are two dashed edges (${lost.length})`);
check(lost.every((edge) => edge.dashed === true && edge.live === false),
  "dashed and never live: a lost voicing did not sound");
const lostNodes = rejectedGraph.nodes.filter((node) => node.id.startsWith("rejected:"));
check(lostNodes.every((node) => node.note === describeRejection({ cost: 0 }).why
  || node.note.length > 0), "each carries the reason the panel prints");
check(describeRejection({ voicing: [57, 64, 69], cost: 0 }).why === "same cost · span tie-break",
  "a zero-cost loser names the tie-break, not a cost comparison");
check(describeRejection({ voicing: [57, 64, 69], cost: 9 }).why.includes("9 >"),
  "an over-budget loser names the budget it broke");

// ------------------------------------------------------ harmony: no-chain states
const vampGraph = harmonyGraph({ vamp: true, index: 0, chords: [] }, null, null);
check(vampGraph.nodes.length === 1 && vampGraph.nodes[0].id === "vamp",
  "a vamp is one node, not an empty graph");
check(vampGraph.height === 52, `and the box collapses to one band (${vampGraph.height})`);
check(vampGraph.nodes[0].label === "vamp" && vampGraph.nodes[0].value === "root pedal",
  "the vamp says what it is playing");

const emptyGraph = harmonyGraph({}, null, null);
check(emptyGraph.nodes.length === 1 && emptyGraph.nodes[0].id === "waiting",
  "before the first bar there is one waiting node");
check(emptyGraph.height === 52, `at one band tall (${emptyGraph.height})`);
check(emptyGraph.nodes[0].label === "waiting for a bar" && emptyGraph.nodes[0].value === "—",
  "and it says plainly that nothing has played yet");

const transition = harmonyGraph({ index: 3, chords: [] }, { steps: [], position: 0 }, null);
check(transition.nodes.length === 1 && transition.nodes[0].label === "no chain",
  "a closed family is not called a vamp");

// ------------------------------------------------------------- the documents
console.log("parameter table");
check(PARAMETERS.length === 10, `ten parameters are documented (${PARAMETERS.length})`);
check(new Set(PARAMETERS.map((entry) => entry.id)).size === PARAMETERS.length,
  "their ids are unique, so a lookup cannot be ambiguous");
check(JSON.stringify(PARAMETERS.map((entry) => entry.id))
  === JSON.stringify(["C", "alphaShare", "arousal", "motion", "asymmetry", "bpm", "cruelty", "weights", "bands", "hsi"]),
"and they are the ten the page prints, in reading order");
check(PARAMETERS.every((entry) => entry.label && entry.does && entry.source && entry.kind && entry.range),
  "every entry has a label, a rule, a source and a range to print");
const rowIds = ladderRows({}, {}).map((row) => row.signal);
check(rowIds.every((id) => parameterFor(id) != null),
  `every ladder row has an explanation (${rowIds.filter((id) => !parameterFor(id)).join(",") || "all"})`);
check(parameterFor("cruelty").does.includes("0.15"),
  "cruelty's explanation names the reference its default is measured against");
check(parameterFor("nope") === null, "an unknown id is null, not a guessed entry");

console.log("device table");
check(DEVICE_DOCS.length === 6, `six devices are documented (${DEVICE_DOCS.length})`);
check(JSON.stringify(DEVICE_DOCS.map((entry) => entry.id))
  === JSON.stringify(DEVICE_LABELS.map(([name]) => name)),
"in rack order, keyed like DEVICE_LABELS");
check(DEVICE_DOCS.every((entry) => entry.gate === DEVICE_GATES[entry.id]),
  "each gate is the generator's, not a restatement of it");
check(DEVICE_DOCS.every((entry) => typeof entry.does === "string" && entry.does.length > 20),
  "and each has the rule it plays");

// The one shipped family that is long enough to stress the step layout.
const longest = FAMILIES.reduce((best, family) => (family.steps.length > best.steps.length ? family : best), FAMILIES[0]);
const realChain = {
  family: longest.id,
  steps: longest.steps.map((step) => step.label),
  position: 2,
  open: longest.open.label,
  armed: false,
};
const realPath = harmonyGraph({ index: 1, chords: [] }, realChain, longest);
const entries = stepEntries(longest, realChain.steps);
check(entries.length === longest.steps.length
  && entries.every((entry, i) => entry.label === longest.steps[i].label),
  "stepEntries recovers the shipped family's own bar counts");
check(realPath.nodes.filter((node) => node.id.startsWith("step:"))
  .every((node, i) => node.value === `${entries[i].bars} bar${entries[i].bars === 1 ? "" : "s"}`),
"and the graph prints those counts, not one bar per node");

// Every shipped family must fit its own box: the harmony viewBox is derived from
// the row the steps make, so the longest family is the one that proves it.
const spill = FAMILIES.filter((family) => {
  const chain = {
    family: family.id,
    steps: family.steps.map((step) => step.label),
    position: 2,
    open: family.open.label,
    armed: false,
  };
  const graph = harmonyGraph({ index: 1, chords: [] }, chain, family);
  return graph.nodes.some((node) => node.x + node.w > graph.width + 0.01 || node.x < 0);
});
check(spill.length === 0, `every shipped family fits its own viewBox (${spill.map((f) => f.id).join(",") || "all"})`);
// The box is the row: the step band fills it edge to edge, so no family leaves
// slack that would shrink the drawing for nothing.
const slack = FAMILIES.filter((family) => {
  const graph = harmonyGraph({ index: 1, chords: [] }, {
    family: family.id, steps: family.steps.map((s) => s.label), position: 1, open: family.open.label,
  }, family);
  const steps = graph.nodes.filter((node) => node.id.startsWith("step:"));
  const right = steps[steps.length - 1].x + steps[steps.length - 1].w;
  return Math.abs(right - graph.width) > 0.01;
});
check(slack.length === 0, `the step band fills the box exactly (${slack.map((f) => f.id).join(",") || "all"})`);

// -------------------------------------------------------------------- report
console.log("");
if (failures.length) {
  console.log(`${failures.length} FAILED of ${assertions} assertions`);
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
console.log(`PASS ${assertions} assertions`);
