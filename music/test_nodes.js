// The two graphs as data: topology, geometry and liveness, with no browser.
// Run: node music/test_nodes.js -> "PASS <n> assertions", exit 0.

import {
  GRAPH, signalGraph, harmonyGraph, stepEntries, describeRejection, gateText,
} from "./nodes.js";
import {
  DEVICE_GATES, GRAMMAR, CRUELTY_REFERENCE, CRUELTY_ROLLS, LEAD_HIGH, REGISTER,
  VOTE_WEIGHT, FAMILIES, devicesAt, aggregate, createGenerator, nextBar, timbreAt,
} from "./generator.js";
import { WEIGHT_DEFAULTS } from "./conditioner.js";
import {
  PARAMETERS, DEVICE_DOCS, DEVICE_LABELS, ladderRows, parameterFor, noteName,
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
const find = (graph, id) => graph.nodes.find((node) => node.id === id) || null;
const edgeBetween = (graph, from, to) => graph.edges.find((e) => e.from === from && e.to === to) || null;

// The topology the renderer may assume: if a ball moves column or an edge
// disappears, that is a design change, not a refactor.
const SIGNAL_IDS = [
  "engagement", "activation", "steadiness",
  "alphaShare", "arousal", "motion", "asymmetry",
  "C",
  "hats", "gates", "timbre", "openhat", "ghost", "fill", "register",
  "dev:sus", "dev:cliche", "dev:drone", "dev:mixture", "dev:climb", "dev:bII",
  "voice:pad", "voice:drone", "voice:bass", "voice:drums", "voice:lead",
];
const SIGNAL_EDGES = [
  ["engagement", "C"], ["activation", "C"], ["steadiness", "C"],
  ["C", "hats"], ["C", "gates"], ["C", "timbre"],
  ["alphaShare", "openhat"], ["arousal", "ghost"], ["motion", "fill"], ["asymmetry", "register"],
  ["gates", "dev:sus"], ["gates", "dev:cliche"], ["gates", "dev:drone"],
  ["gates", "dev:mixture"], ["gates", "dev:climb"], ["gates", "dev:bII"],
  ["dev:cliche", "voice:pad"], ["dev:drone", "voice:drone"], ["register", "voice:lead"],
];

// ------------------------------------------------------------------ fixtures
const PARTS = { engagement: 0.6, activation: 0.4, steadiness: 0.5, age: 0 };
const WEIGHTS = { engagement: 0.4, activation: 0.3, steadiness: 0.3 };
const HOT_MIX = { C: 0.95, alphaShare: 0.5, arousal: 0.9, motion: 0.3, asymmetry: -0.2 };
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

// A family the generator does not ship, so the layout is measured on seven steps.
// Its open chord is bVI, in the middle, so the release really is a backward
// transition -- a family whose open chord is its last step has no arc to draw.
const SEVEN = {
  id: "seven",
  title: "seven",
  open: { label: "bVI" },
  steps: [
    { label: "i", bars: 2 }, { label: "bIII", bars: 1 }, { label: "bVI", bars: 1, cliche: true },
    { label: "iv", bars: 2 }, { label: "bVII", bars: 1 }, { label: "V", bars: 1 },
    { label: "vi", bars: 2 },
  ],
};

// -------------------------------------------------------------- signal: shape
console.log("signal graph");
const hot = signalGraph(HOT_MIX, HOT_BAR, { parts: PARTS, weights: WEIGHTS });
check(JSON.stringify(ids(hot)) === JSON.stringify(SIGNAL_IDS),
  `the ball ids and their order are the plan's (${hot.nodes.length})`);
const wanted = SIGNAL_EDGES.map(([from, to]) => `${from}|${to}`).sort();
check(JSON.stringify(pairs(hot).slice().sort()) === JSON.stringify(wanted),
  `the ${SIGNAL_EDGES.length} lines are exactly the plan's (${hot.edges.length})`);
check(hot.edges.every((edge) => find(hot, edge.from) && find(hot, edge.to)),
  "every line joins two balls -- no stubs entering from nowhere");
check(hot.nodes.every((node) => node.kind !== "chord" && node.place === "right"),
  "every signal ball puts its text to the right");

const outside = hot.nodes.filter((node) => node.x - node.r < 0 || node.x + node.r > hot.width
  || node.y - node.r < 0 || node.y + node.r > hot.height);
check(outside.length === 0, `no ball leaves the ${hot.width}x${hot.height} viewBox (${outside.length})`);
const wideText = hot.nodes.filter((node) => node.x + node.r + 84 > hot.width);
check(wideText.length === 0, `and no label is pushed off the right edge (${wideText.map((n) => n.id).join(",") || "none"})`);
const byColumn = new Map();
for (const node of hot.nodes) byColumn.set(node.x, [...(byColumn.get(node.x) || []), node]);
const ordered = [...byColumn.values()].every((column) => column
  .every((node, i) => i === 0 || node.y > column[i - 1].y));
check(ordered, "rows within a column run strictly down the page, in the listed order");

// A "right" ball prints a name above its line and a value below it: a 25px type
// block. At a 26px pitch consecutive rows overlapped by 1px -- measured in the
// browser -- so the pitch and the box height are both pinned here.
const ys = [...new Set(hot.nodes.filter((n) => n.x === GRAPH.columns[0]).map((n) => n.y))].sort((a, b) => a - b);
const pitches = ys.slice(1).map((y, i) => y - ys[i]);
check(pitches.every((p) => p >= 30), `stacked balls are pitched apart (${pitches.join(",")})`);
const lowest = Math.max(...hot.nodes.map((n) => n.y + (n.place === "below" ? 25 : GRAPH.textDown)));
check(lowest <= hot.height, `and the box is tall enough for the last row's value (${lowest} <= ${hot.height})`);

// ----------------------------------------------------------- signal: weights
console.log("weights");
const intoC = hot.edges.filter((edge) => edge.to === "C");
check(intoC.length === 3 && intoC.every((edge) => edge.live),
  "the three terms are live and all three feed C");
check(intoC.map((edge) => edge.label).join(",") === "×0.40,×0.30,×0.30",
  `each line into C is labelled with its weight (${intoC.map((e) => e.label).join(",")})`);
check(["engagement", "activation", "steadiness"].every((id) => find(hot, id).value === PARTS[id].toFixed(2)),
  "and each term prints its own value");
check(find(hot, "engagement").note === "×0.40 = 0.24 → C",
  `the term's title does the arithmetic (${find(hot, "engagement").note})`);
const reweighted = signalGraph(HOT_MIX, HOT_BAR, {
  parts: PARTS, weights: { engagement: 0.8, activation: 0.1, steadiness: 0.1 },
});
check(reweighted.edges.filter((e) => e.to === "C").map((e) => e.label).join(",") === "×0.80,×0.10,×0.10",
  "re-weighting re-draws the labels, which is the whole point of drawing them");
const bare = signalGraph({}, {});
check(["engagement", "activation", "steadiness"].every((id) => find(bare, id).value === "—"),
  "with no headband the terms read — rather than inventing numbers");
check(bare.edges.filter((e) => e.to === "C").every((e) => !e.live),
  "and no weight line is drawn live");
check(bare.edges.filter((e) => e.to === "C").map((e) => e.label).join(",")
  === `×${WEIGHT_DEFAULTS.engagement.toFixed(2)},×${WEIGHT_DEFAULTS.activation.toFixed(2)},×${WEIGHT_DEFAULTS.steadiness.toFixed(2)}`,
"the default weights are named even when the terms are missing");

// -------------------------------------------------------- signal: liveness
console.log("signal liveness");
const live = (graph, id) => (find(graph, id) || {}).live;
const ahead = (graph, id) => (find(graph, id) || {}).ahead;
check(["hats", "gates", "openhat", "ghost", "fill", "register"].every((id) => live(hot, id)),
  `a hot bar lights the rules it fired (${["hats", "gates", "openhat", "ghost", "fill", "register"].filter((id) => !live(hot, id)).join(",") || "all"})`);
check(hot.nodes.filter((node) => node.id.startsWith("dev:")).every((node) => node.live),
  "and opens all six devices");
check(live(hot, "voice:drums") && live(hot, "voice:bass") && live(hot, "voice:lead"),
  "the voices that played are lit");
check(find(hot, "dev:cliche") && edgeBetween(hot, "dev:cliche", "voice:pad").live,
  "the cliché's line is live only while its device is open");

const quiet = signalGraph(QUIET_MIX, QUIET_BAR, { parts: PARTS, weights: WEIGHTS });
check(["openhat", "ghost", "fill", "register"].every((id) => !live(quiet, id)),
  "a quiet bar lights none of the probabilistic rules");
check(quiet.nodes.filter((node) => node.id.startsWith("dev:")).filter((n) => n.live)
  .map((node) => node.id.slice(4)).join(",") === devicesAt(0.2).join(","),
  "and only the devices its concentration opens");

let deviceMismatch = 0;
for (let i = 0; i <= 20; i += 1) {
  const C = i / 20;
  const graph = signalGraph({ C }, {});
  const lit = graph.nodes.filter((n) => n.id.startsWith("dev:") && n.live).map((n) => n.id.slice(4));
  if (lit.join(",") !== devicesAt(C).join(",")) deviceMismatch += 1;
}
check(deviceMismatch === 0, `over 21 concentrations the lit devices are devicesAt(C), in order (${deviceMismatch} off)`);
check(hot.nodes.filter((node) => node.id.startsWith("dev:"))
  .every((node) => node.value === gateText(node.id.slice(4))),
"every device ball prints the gate the generator enforces");
check(hot.nodes.filter((node) => node.id.startsWith("dev:"))
  .every((node) => node.note === (DEVICE_DOCS.find((d) => d.id === node.id.slice(4)) || {}).does),
"and carries the rule it plays in its title, from DEVICE_DOCS");

// ------------------------------------------------------ signal: what is ahead
console.log("ahead of time");
const midway = signalGraph({ C: 0.5, alphaShare: 0.5, arousal: 0.3, motion: 0.2, asymmetry: 0.1 },
  { index: 1, drums: [], chords: [], bass: [], lead: [] }, { parts: PARTS, weights: WEIGHTS });
check(ahead(midway, "hats"), "below 0.60 the hats are marked ahead, not live");
check(!live(midway, "hats"), "and they are not drawn as already firing");
check(ahead(midway, "dev:climb"), "the next device to open is marked ahead");
check(find(midway, "gates").note === "next: climb at 0.55",
  `the ladder names the gate that is coming (${find(midway, "gates").note})`);
check(ahead(midway, "fill") && !live(midway, "fill"), "the bar-4 fill is ahead until its bar arrives");
check(ahead(midway, "openhat"), "an open hat more likely than not is marked ahead");
check(!ahead(hot, "hats") && !ahead(hot, "dev:climb"),
  "a bar that already has everything ahead of it marks nothing ahead");
const edgeToHats = edgeBetween(midway, "C", "hats");
check(edgeToHats.ahead && !edgeToHats.live,
  "the line into an ahead rule is drawn ahead too, so the prediction reaches the wire");
check(find(midway, "gates").note !== find(signalGraph({ C: 0.95 }, {}), "gates").note,
  "with every gate passed the ladder says so instead");

// --------------------------------------------------------- signal: values
console.log("signal values");
const mixes = [
  ["no mix, no bar", {}, {}, null],
  ["a vamp", { C: 0.1, mode: "vamp", heads: 0 }, { vamp: true, index: 0 }, null],
  ["a full bar", HOT_MIX, HOT_BAR, { parts: PARTS, weights: WEIGHTS }],
  ["nothing at all", null, null, null],
];
for (const [label, mix, bar, extra] of mixes) {
  const graph = signalGraph(mix, bar, extra || {});
  const values = graph.nodes.map((node) => node.value);
  const bad = values.filter((value) => typeof value !== "string"
    || value.includes("NaN") || value.includes("undefined") || value.includes("null"));
  check(bad.length === 0, `${label}: every value is a printable string (${bad.join(",") || "ok"})`);
  check(graph.nodes.length === SIGNAL_IDS.length, `${label}: still every ball`);
  check(graph.nodes.every((node) => Number.isFinite(node.r) && node.r > 0),
    `${label}: every ball has a radius`);
}

// ------------------------------------------------------------- harmony: walk
console.log("harmony walk");
const labels = SEVEN.steps.map((step) => step.label);
const chain = {
  family: SEVEN.id, title: SEVEN.title, steps: labels,
  position: 4, open: SEVEN.open.label, armed: false, held: 1,
};
const walk = harmonyGraph({ index: 9, chords: [] }, chain, SEVEN);
const steps = walk.nodes.filter((node) => node.id.startsWith("step:"));
check(steps.length === 7, `a seven-step family draws seven steps (${walk.nodes.length} balls)`);
check(steps.every((node, i) => i === 0 || node.x > steps[i - 1].x), "the steps run left to right");
check(steps.every((node) => node.place === "below"),
  "and put their names under the ball, where a packed row has room");
const current = walk.nodes.find((node) => node.state === "current");
check(current && current.id === `step:${chain.position - 1}`,
  `the current step is position - 1 (${current && current.id})`);
check(walk.nodes.filter((node) => node.state === "current").length === 1,
  "and it is the only current step: position is one fact, not a per-node guess");
check(walk.nodes.filter((node) => node.open === true).length === 1,
  "the open chord is marked once");
check(walk.nodes.filter((node) => node.open === true)[0].label === SEVEN.open.label,
  "and it is the family's open chord");
check(walk.nodes.filter((node) => node.ahead).length === 1
  && walk.nodes.filter((node) => node.ahead)[0].id === `step:${chain.position}`,
"exactly the step after the current one is marked ahead");
check(walk.edges.filter((edge) => edge.live && !edge.arc).length === chain.position,
  `the walk travelled so far is lit (${walk.edges.filter((e) => e.live && !e.arc).length} of ${walk.edges.length})`);

const armedWalk = harmonyGraph({ index: 9, chords: [] }, { ...chain, armed: true }, SEVEN);
const armedNode = armedWalk.nodes.find((node) => node.state === "armed");
check(armedNode && armedNode.id === `step:${chain.position - 1}`,
  "armed overrides current on the same step, because a drop is the louder fact");
check(armedWalk.nodes.filter((node) => node.state === "current").length === 0,
  "and leaves no second state behind");

// the release: the one transition that goes backwards
const releaseEdge = walk.edges.find((edge) => edge.arc);
check(Boolean(releaseEdge) && !releaseEdge.live,
  "the release arc exists and is dark until the generator is armed");
check(releaseEdge && releaseEdge.label === "release" && releaseEdge.dashed,
  "it is labelled and dashed, because it is a jump, not a step");
const armedRelease = armedWalk.edges.find((edge) => edge.arc);
check(armedRelease && armedRelease.live, "and it turns on when the drop is armed");
check(armedRelease.from === `step:${steps.length - 1}`,
  "it leaves the last step");
check(armedRelease.to === `step:${labels.indexOf(SEVEN.open.label)}`,
  "and lands on the open chord");

// A family can be standing on its own open chord: the two facts then hold on one
// ball, which is why they are two fields.
const OPEN_LAST = {
  id: "open-last", title: "open-last", open: { label: "IV" },
  steps: [{ label: "i", bars: 2 }, { label: "IV", bars: 2 }],
};
const standing = harmonyGraph({ index: 4, chords: [] },
  { family: OPEN_LAST.id, steps: ["i", "IV"], position: 2, open: "IV", armed: false }, OPEN_LAST);
check(standing.nodes[1].state === "current" && standing.nodes[1].open === true,
  "the step you are on can also be the open chord, and both are drawn");
check(!standing.edges.some((edge) => edge.arc),
  "a family whose open chord is its last step has no arc to draw");

// ------------------------------------------------- harmony: this bar's chords
console.log("harmony events");
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
check(chordNodes.every((node) => node.y > GRAPH.top && node.x - node.r >= 0 && node.x + node.r <= susGraph.width),
  "and the group is nudged inside the canvas rather than off it");
const centred = Math.round((chordNodes[0].x + chordNodes[2].x) / 2);
check(Math.abs(centred - find(susGraph, "step:3").x) <= 1,
  `the group is centred under the current step (${centred} vs ${find(susGraph, "step:3").x})`);
check(susGraph.height === 154, `three rows of content make a taller box (${susGraph.height})`);

const rejectedBar = {
  index: 12,
  chords: [{
    step: 0, label: "Am", quality: "min", voicing: [57, 60, 64], cliche: false,
    rejected: [{ voicing: [57, 64, 69], cost: 0 }, { voicing: [60, 64, 69], cost: 7 }],
  }],
};
const rejectedGraph = harmonyGraph(rejectedBar, chain, SEVEN);
const lost = rejectedGraph.edges.filter((edge) => edge.to.startsWith("rejected:"));
check(lost.length === 2, `two rejected voicings are two dashed lines (${lost.length})`);
check(lost.every((edge) => edge.dashed === true && edge.live === false),
  "dashed and never live: a lost voicing did not sound");
check(rejectedGraph.nodes.filter((node) => node.id.startsWith("rejected:"))
  .every((node) => node.note.length > 0), "each carries the reason the panel prints");
check(describeRejection({ voicing: [57, 64, 69], cost: 0 }).why === "same cost · span tie-break",
  "a zero-cost loser names the tie-break, not a cost comparison");
check(describeRejection({ voicing: [57, 64, 69], cost: 9 }).why.includes("9 >"),
  "an over-budget loser names the budget it broke");
check(rejectedGraph.height === 190, `the lost row makes the box taller still (${rejectedGraph.height})`);

// ------------------------------------------------------ harmony: no-chain states
const vampGraph = harmonyGraph({ vamp: true, index: 0, chords: [] }, null, null);
check(vampGraph.nodes.length === 1 && vampGraph.nodes[0].id === "vamp",
  "a vamp is one ball, not an empty graph");
check(vampGraph.height === 88, `and the box collapses to one row (${vampGraph.height})`);
check(vampGraph.nodes[0].label === "vamp" && vampGraph.nodes[0].value === "root pedal",
  "the vamp says what it is playing");

const emptyGraph = harmonyGraph({}, null, null);
check(emptyGraph.nodes.length === 1 && emptyGraph.nodes[0].id === "waiting",
  "before the first bar there is one waiting ball");
check(emptyGraph.height === 88, `at one band tall (${emptyGraph.height})`);
check(emptyGraph.nodes[0].label === "waiting for a bar" && emptyGraph.nodes[0].value === "—",
  "and it says plainly that nothing has played yet");

const transition = harmonyGraph({ index: 3, chords: [] }, { steps: [], position: 0 }, null);
check(transition.nodes.length === 1 && transition.nodes[0].label === "no chain",
  "a closed family is not called a vamp");

// Every shipped family must fit its own box: the width is derived from the row
// the steps make, so the longest family is the one that proves it.
const spill = FAMILIES.filter((family) => {
  const graph = harmonyGraph({ index: 1, chords: [] }, {
    family: family.id, steps: family.steps.map((s) => s.label), position: 2, open: family.open.label,
  }, family);
  return graph.nodes.some((node) => node.x - node.r < 0 || node.x + node.r > graph.width);
});
check(spill.length === 0, `every shipped family fits its own viewBox (${spill.map((f) => f.id).join(",") || "all"})`);
const slack = FAMILIES.filter((family) => {
  const graph = harmonyGraph({ index: 1, chords: [] }, {
    family: family.id, steps: family.steps.map((s) => s.label), position: 1, open: family.open.label,
  }, family);
  const row = graph.nodes.filter((node) => node.id.startsWith("step:"));
  const mid = (row[0].x + row[row.length - 1].x) / 2;
  return Math.abs(mid - graph.width / 2) > 0.6;
});
check(slack.length === 0, `the step row is centred in its own box (${slack.map((f) => f.id).join(",") || "all"})`);

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
check(parameterFor("nope") === null, "an unknown id is null, not a guessed entry");

// The explanations carry the arithmetic, and the arithmetic is the code's: these
// assertions fail if a threshold moves in the generator and its sentence does not.
const doc = (id) => [parameterFor(id).does, ...(parameterFor(id).how || [])].join(" ");
check(PARAMETERS.every((entry) => Array.isArray(entry.how) && entry.how.length >= 3),
  "every entry explains its mechanism, not just its name");
check(PARAMETERS.every((entry) => entry.how.every((line) => typeof line === "string"
  && line.length > 8 && line.trim().endsWith("."))),
"and every line is a finished sentence rather than a stub");
const docText = PARAMETERS.map((entry) => doc(entry.id)).join(" ");
check(!/NaN|undefined|\[object/.test(docText), "no interpolated number failed to render");

const gateTiers = [...new Set(Object.values(DEVICE_GATES).filter((gate) => gate > 0))].sort((a, b) => a - b);
check(gateTiers.every((gate) => doc("C").includes(`from C ${gate.toFixed(2)}`)),
  `the ladder sentence names every gate the generator enforces (${gateTiers.join(", ")})`);
check(doc("C").includes("sus is open at any C"),
  "and says plainly that the always-on device is always on");
check(["0.30", "0.60", "0.90"].every((C) => doc("C").includes(`${Math.round(timbreAt(Number(C)).bassCutoff)} Hz`)),
  "the timbre numbers in C's explanation are what timbreAt actually returns");
check(doc("C").includes(GRAMMAR.hats16Above.toFixed(2)) && doc("alphaShare").includes(GRAMMAR.openHatBase.toFixed(2)),
  "the hat thresholds are the grammar's, not a transcription");
check(doc("arousal").includes(GRAMMAR.ghostKickAbove.toFixed(2))
  && doc("motion").includes(GRAMMAR.fillTomsAbove.toFixed(2)),
"the ghost kick and fill thresholds likewise");
check(doc("asymmetry").includes(noteName(LEAD_HIGH[0])) && doc("asymmetry").includes(noteName(REGISTER.lead[0])),
  `the lead windows named are LEAD_HIGH and REGISTER.lead (${noteName(LEAD_HIGH[0])}..${noteName(LEAD_HIGH[1])} / ${noteName(REGISTER.lead[0])}..${noteName(REGISTER.lead[1])})`);
check(doc("cruelty").includes(CRUELTY_REFERENCE.toFixed(2)),
  "cruelty's explanation names the reference its default is measured against");
check(doc("cruelty").includes(CRUELTY_ROLLS.mixture.cap.toFixed(2))
  && doc("cruelty").includes(CRUELTY_ROLLS.bII.cap.toFixed(2)),
"and the caps that stop the rolls becoming certainties");
check(doc("hsi").includes(String(VOTE_WEIGHT.silent)) && doc("hsi").includes(String(VOTE_WEIGHT.contact)),
  "contact's explanation uses the vote weights the aggregator applies");
check(doc("weights").includes(WEIGHT_DEFAULTS.engagement.toFixed(2)),
  "the weights' explanation prints the defaults it documents");

// bpm's claim is that the Muse does not touch it: assert the aggregator has no
// tempo to give, so the sentence cannot become a lie.
const soloView = {
  pseudonym: "p", name: "n", label: "", C: 0.6, alphaShare: 0.4, betaShare: 0.5, asymmetry: 0.1,
  arousal: 0.7, motion: 0.2, inContact: true, age: 0, gone: false, steadiness: 0.6, hsi: {}, rel: {},
  bpm: 148, rmssd: 40,
};
const aggregated = aggregate([soloView], 1);
check(aggregated.bpm === undefined && aggregated.cruelty === undefined,
  "the Muse cannot set the tempo or the cruelty: aggregate() returns neither");
check(parameterFor("bpm").how[0].startsWith("Not modulated by the Muse"),
  "and bpm's first line says so, instead of implying otherwise");
// Two `does` strings overreached in earlier drafts -- "the one control the Muse
// does not move" (cruelty is manual too) and "above 0.30 it opens a hat" (the
// roll is 0.30 + alpha, which fires at alpha 0). Both are caught here.
check(!/one control|the only/i.test(doc("bpm")) && /cruelty/i.test(doc("bpm")),
  "bpm does not claim to be the only manual control");
check(!/\bafter\s+0?\.?30|\babove\s+0?\.?30/i.test(parameterFor("alphaShare").does),
  "alphaShare does not claim a threshold: it is a probability, and it fires at α 0");
check(/p = 0\.30 \+ α/.test(doc("alphaShare")),
  "and it prints the probability it actually rolls against");

// Raising cruelty only ever adds devices. Measured, because the claim is in the
// panel: the same rolls are compared against a higher threshold.
let removed = 0;
let fired = 0;
for (let seed = 1; seed <= 12; seed += 1) {
  const low = createGenerator({ seed, tonicMidi: 57, cruelty: 0.3 });
  const high = createGenerator({ seed, tonicMidi: 57, cruelty: 0.6 });
  for (let i = 0; i < 20; i += 1) {
    const controls = { C: 0.6, alphaShare: 0.3, arousal: 0.5, motion: 0.2 };
    const a = nextBar(low, controls);
    const b = nextBar(high, controls);
    const jarring = (bar) => ((bar.chords[0] && bar.chords[0].devices) || [])
      .filter((name) => name === "mixture" || name === "bII");
    for (const name of jarring(a)) {
      fired += 1;
      if (!jarring(b).includes(name)) removed += 1;
    }
  }
}
check(fired > 10 && removed === 0,
  `cruelty only ever adds: ${fired} low-cruelty firings, ${removed} taken away by raising it`);

console.log("device table");
check(DEVICE_DOCS.length === 6, `six devices are documented (${DEVICE_DOCS.length})`);
check(JSON.stringify(DEVICE_DOCS.map((entry) => entry.id))
  === JSON.stringify(DEVICE_LABELS.map(([name]) => name)),
"in rack order, keyed like DEVICE_LABELS");
check(DEVICE_DOCS.every((entry) => entry.gate === DEVICE_GATES[entry.id]),
  "each gate is the generator's, not a restatement of it");
check(DEVICE_DOCS.every((entry) => typeof entry.does === "string" && entry.does.length > 20),
  "and each has the rule it plays");

const longest = FAMILIES.reduce((best, family) => (family.steps.length > best.steps.length ? family : best), FAMILIES[0]);
const entries = stepEntries(longest, longest.steps.map((step) => step.label));
check(entries.length === longest.steps.length
  && entries.every((entry, i) => entry.label === longest.steps[i].label),
  "stepEntries recovers the shipped family's own bar counts");
const realWalk = harmonyGraph({ index: 1, chords: [] }, {
  family: longest.id, steps: longest.steps.map((s) => s.label), position: 2, open: longest.open.label,
}, longest);
check(realWalk.nodes.filter((node) => node.id.startsWith("step:"))
  .every((node, i) => node.value === `${entries[i].bars} bar${entries[i].bars === 1 ? "" : "s"}`),
"and the graph prints those counts, not one bar per node");

// -------------------------------------------------------------------- report
console.log("");
if (failures.length) {
  console.log(`${failures.length} FAILED of ${assertions} assertions`);
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
console.log(`PASS ${assertions} assertions`);
