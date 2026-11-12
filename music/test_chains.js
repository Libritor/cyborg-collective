// Proof that the home page's chains are the generator's own: the graphs come
// from the bar that was generated and the controls it was generated from, and
// what this page leaves out of the desk's drawing is exactly what it says it does.
// Run: node music/test_chains.js -> "PASS <n> assertions", exit 0.

import { readFileSync } from "node:fs";

import { chainGraphs, chainWords, createChains } from "./chains.js";
import { harmonyGraph, signalGraph } from "./nodes.js";
import { createIdle } from "./idle.js";
import { createGenerator, nextBar, devicesAt, familyById } from "./generator.js";

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
const whole = (graph) => {
  const ids = new Set(graph.nodes.map((node) => node.id));
  return ids.size === graph.nodes.length && graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to));
};

// a piece as the home page plays one: sixteen bars from a record summary
const idle = createIdle({ stamp: "20251213_170944", summary: { clean_epoch_frac: { TP9: 0.6, AF7: 0.7 }, gyro_rms: 12, bands_median: { alpha: { AF7: 1.1, AF8: 0.9 }, theta: { AF7: 0.8 }, beta: { AF7: 0.7 } } }, bars: 16 });
const bars = Array.from({ length: 16 }, (_, i) => ({ data: idle.pullBar(i), mix: idle.controls(i) }));

console.log("the chord chain");
{
  check(bars.every(({ data, mix }) => whole(chainGraphs({ data, mix }).harmony)), "every bar gives a graph whose lines all join balls that are in it");
  const walking = bars.filter(({ data }) => data.ui.chain && data.ui.chain.steps.length && data.ui.chain.position > 0);
  check(walking.length >= 8, `${walking.length} of 16 bars are inside a progression`);
  check(walking.every(({ data, mix }) => {
    const { harmony } = chainGraphs({ data, mix });
    const chain = data.ui.chain;
    const steps = harmony.nodes.filter((node) => node.id.startsWith("step:"));
    const current = harmony.nodes.filter((node) => node.state === "current" || node.state === "armed");
    return steps.map((node) => node.label).join("|") === chain.steps.join("|")
      && current.length === 1 && current[0].label === chain.steps[Math.min(chain.position, chain.steps.length) - 1];
  }), "the steps drawn are the progression's own, and the one lit is the step the generator is on");
  check(walking.every(({ data, mix }) => {
    const { harmony } = chainGraphs({ data, mix });
    const events = harmony.nodes.filter((node) => node.id.startsWith("chord:")).map((node) => node.label);
    return events.join("|") === data.chords.map((chord) => chord.label).join("|");
  }), "under it hang this bar's chord events, as the bar carries them");
  check(bars.every(({ data, mix }) => !chainGraphs({ data, mix }).harmony.nodes.some((node) => node.id.startsWith("rejected:"))),
    "the voicings that lost are left to the desk");
  const some = walking.find(({ data }) => Array.isArray(data.chords[0].rejected) && data.chords[0].rejected.length);
  if (some) {
    const desk = harmonyGraph(some.data, some.data.ui.chain, familyById(some.data.ui.chain.family));
    const here = chainGraphs(some).harmony;
    check(desk.nodes.length > here.nodes.length && here.height < desk.height && here.nodes.every((node) => desk.nodes.some((other) => other.id === node.id && other.x === node.x && other.y === node.y)),
      "everything else is the desk's drawing, ball for ball, in a shorter box");
  } else {
    check(true, "no bar of this piece carried a losing voicing (nothing to leave out)");
  }
  check(bars.every(({ data, mix }) => { const g = chainGraphs({ data, mix }).harmony; return g.nodes.every((n) => n.x >= 0 && n.x <= g.width && n.y + n.r <= g.height); }),
    "every ball is inside the box it is drawn in");
  const vamp = nextBar(createGenerator({ seed: 3 }), { C: 0.1, mode: "vamp" });
  check(chainGraphs({ data: vamp, mix: { C: 0.1 } }).harmony.nodes.map((n) => n.label).join() === "vamp", "a resting pattern has no walk: one ball that says so");
  check(chainGraphs({}).harmony.nodes[0].label === "waiting for a bar", "before any bar: waiting, not a made-up chain");
}

console.log("the signal chain");
{
  const { data, mix } = bars[5];
  const here = chainGraphs({ data, mix }).signal;
  const desk = signalGraph(mix, data, { parts: null, weights: null });
  check(whole(here), "every line joins two balls that are in the graph");
  check(!here.nodes.some((node) => node.kind === "term") && desk.nodes.filter((node) => node.kind === "term").length === 3,
    "with no headband to split C into, the three terms the desk draws are left out");
  check(here.nodes.every((node) => { const other = desk.nodes.find((d) => d.id === node.id); return other && other.label === node.label && other.value === node.value && other.live === node.live && other.ahead === node.ahead && other.y === node.y; }),
    "every ball that is drawn says, and is lit, exactly as on the desk");
  const columns = [...new Set(here.nodes.map((node) => node.x))].sort((a, b) => a - b);
  check(columns.length === 5 && columns.every((x, i) => i === 0 || x - columns[i - 1] >= 140) && here.width <= 740 && here.width < desk.width,
    `the five columns stand closer (${columns.join(", ")}), so the drawing is ${here.width} wide instead of ${desk.width}`);
  check(here.nodes.find((node) => node.id === "C").value === mix.C.toFixed(2), "C is the concentration the bar was generated from");
  const open = devicesAt(mix.C);
  check(here.nodes.filter((node) => node.kind === "device" && node.live).length === open.length, `the devices lit are the ones C ${mix.C.toFixed(2)} opens (${open.join(", ")})`);
  const parts = { engagement: 0.6, activation: 0.4, steadiness: 0.5 };
  const live = chainGraphs({ data, mix, parts, weights: { engagement: 0.4, activation: 0.3, steadiness: 0.3 } }).signal;
  check(live.nodes.filter((node) => node.kind === "term").length === 3 && whole(live) && live.edges.filter((edge) => edge.to === "C" && edge.label).length === 3,
    "with a live head the three terms are drawn, each with its weight on the line into C");
}

console.log("the words beside them");
{
  const walking = bars.find(({ data }) => data.ui.chain && data.ui.chain.steps.length && data.ui.chain.position > 0);
  const chain = walking.data.ui.chain;
  const words = chainWords({ data: walking.data, mix: walking.mix, bar: 4, tempo: 132 });
  check(words.clock === "bar 5 · 132 bpm", "the bar is counted from one, with its tempo");
  check(chainWords({ data: walking.data, mix: walking.mix, bar: 4, tempo: 132, silent: true }).clock === "bar 5 · 132 bpm · no sound yet",
    "while the browser holds the sound back, the bar says there is no sound yet");
  check(words.walk.startsWith(`${chain.title} · step ${Math.min(chain.position, chain.steps.length)} of ${chain.steps.length}: `) && words.walk.includes(chain.steps[Math.min(chain.position, chain.steps.length) - 1]),
    "where the walk is: the progression's name, the step, and its chord");
  check(words.reason === walking.data.ui.reason && words.reason.length > 0, "why this bar is what it is: the generator's own sentence");
  check(words.band === `C ${walking.mix.C.toFixed(2)} · α ${walking.mix.alphaShare.toFixed(2)} · arousal ${walking.mix.arousal.toFixed(2)} · motion ${walking.mix.motion.toFixed(2)} · asym ${walking.mix.asymmetry >= 0 ? "+" : "−"}${Math.abs(walking.mix.asymmetry).toFixed(2)}`,
    "the numbers that made it, as the controls carry them");
  const vamp = nextBar(createGenerator({ seed: 3 }), { C: 0.1, mode: "vamp" });
  check(/resting/.test(chainWords({ data: vamp }).walk) && chainWords({}).band === "C — · α — · arousal — · motion — · asym —", "a resting pattern says so; unknown numbers are dashes, never zeros");
}

console.log("purity");
{
  const source = readFileSync(new URL("./chains.js", import.meta.url), "utf8");
  check(!/from "node:|require\(/.test(source), "chains.js is ESM with no node built-ins");
  check(!/Math\.random\s*\(/.test(source) && !/(Date|performance)\.now\s*\(/.test(source), "it reads no clock and no PRNG");
  const inert = createChains({});
  inert.show({ data: bars[0].data, mix: bars[0].mix });
  check(inert.state.shown === false, "with no page to draw on it does nothing, and does not fail");
}

const report = failures.length
  ? `\nFAIL ${failures.length} of ${assertions} assertions\n  - ${failures.join("\n  - ")}`
  : `\nPASS ${assertions} assertions`;
console.log(report);
process.exit(failures.length ? 1 : 0);
