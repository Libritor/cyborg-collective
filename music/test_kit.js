// S2 proof for MarGoth: the kit is data, it validates, and it covers the grammar.
// No audio and no browser. Run: node music/test_kit.js -> "PASS <n> assertions".

import { readFileSync } from "node:fs";
import { KIT, KIT_NAMES, validateKit } from "./kit.js";
import { createGenerator, nextBar } from "./generator.js";

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

const ALL_LAYERS = KIT_NAMES.flatMap((name) => KIT[name].layers.map((layer, index) => ({ name, index, layer })));
const seededLayers = ALL_LAYERS.filter((e) => e.layer.type === "noise" || e.layer.type === "cluster");

// ------------------------------------------------------------------- validity
console.log("kit");
const problems = validateKit();
check(problems.length === 0, `validateKit() is empty (got: ${problems.join("; ") || "none"})`);
check(JSON.stringify([...KIT_NAMES].sort()) === JSON.stringify(["hatC", "hatO", "kick", "snare", "tomH", "tomL"]),
  `KIT_NAMES is exactly the six hits the grammar plays (got ${KIT_NAMES.join(",")})`);

for (const name of KIT_NAMES) {
  check(KIT[name].lengthMs <= 600, `${name} lengthMs ${KIT[name].lengthMs} <= 600`);
}

// ------------------------------------------------------------ deterministic noise
const seeds = seededLayers.map((e) => e.layer.seed);
check(seededLayers.length === 6, `${seededLayers.length} seeded layers (one per noise/cluster layer)`);
check(seededLayers.every((e) => Number.isInteger(e.layer.seed) && e.layer.seed >= 0),
  "every noise/cluster layer has an integer seed >= 0");
check(new Set(seeds).size === seeds.length,
  `all six seeds are pairwise distinct (${seeds.map((s) => `0x${s.toString(16)}`).join(", ")})`);

// ------------------------------------------------------------------- the snare
const snareGate = KIT.snare.gate;
check(snareGate !== null
  && snareGate.holdMs === 150
  && snareGate.releaseMs === 1
  && snareGate.releaseCurve === "linear",
  "snare gate is {holdMs: 150, releaseMs: 1, releaseCurve: linear}");
check(KIT.snare.layers.every((layer) => layer.releaseMs >= 100),
  "every snare layer decays for at least 100ms (the gate does the cutting, not the envelope)");

// ------------------------------------------------------------------- the hats
for (const name of ["hatC", "hatO"]) {
  const clusters = KIT[name].layers.filter((layer) => layer.type === "cluster");
  const cluster = clusters[0];
  check(clusters.length === 1
    && cluster.ratios.length === 6
    && cluster.filter === "highpass"
    && cluster.filterHz >= 6000,
    `${name} is one 6-partial cluster, highpassed at ${cluster ? cluster.filterHz : "?"}Hz or above`);
  check(!KIT[name].layers.some((layer) => layer.type === "noise"),
    `${name} has no noise layer (the metal is the cluster)`);
}

// -------------------------------------------------------------------- the kick
const kickTones = KIT.kick.layers.filter((layer) => layer.type === "tone");
const kickNoise = KIT.kick.layers.filter((layer) => layer.type === "noise");
check(kickTones.length === 1 && kickTones[0].wave === "sine"
  && kickTones[0].hzFrom === 120 && kickTones[0].hzTo === 44,
  "kick is one sine falling 120 -> 44 Hz");
check(kickNoise.length === 1
  && kickNoise[0].attackMs + kickNoise[0].holdMs + kickNoise[0].releaseMs <= 16,
  "the kick's click layer is 16ms or shorter (a click, not a snare)");

// -------------------------------------------------------------------- the toms
const tomL = KIT.tomL.layers.find((layer) => layer.type === "tone");
const tomH = KIT.tomH.layers.find((layer) => layer.type === "tone");
check(tomH.hzFrom === 2 * tomL.hzFrom && tomH.hzTo === 2 * tomL.hzTo,
  `tomH is tomL an octave up (${tomL.hzFrom}->${tomH.hzFrom}, ${tomL.hzTo}->${tomH.hzTo} Hz)`);

// ------------------------------------------------------------------ no assets
const source = readFileSync(new URL("./kit.js", import.meta.url), "utf8");
// The extension patterns end on a word boundary: `layer.wave` is a property
// named wave, not a .wav file, and a scan that cannot tell them apart is a scan
// nobody keeps.
const banned = [/https?:/, /\.wav\b/i, /\.mp3\b/i, /\.ogg\b/i, /src\s*:/];
const hits = banned.filter((re) => re.test(source)).map((re) => String(re));
check(hits.length === 0, `kit.js loads nothing and references no asset (matched: ${hits.join(", ") || "none"})`);

// ------------------------------------------------------------------- coverage
const gen = createGenerator({ seed: 1, tonicMidi: 57 });
const controls = { C: 0.9, alphaShare: 0.4, arousal: 0.8, motion: 0.2 };
const used = new Set();
const unknown = new Set();
for (let bar = 0; bar < 200; bar += 1) {
  for (const hit of nextBar(gen, controls).drums) {
    used.add(hit.hit);
    if (!KIT_NAMES.includes(hit.hit)) unknown.add(hit.hit);
  }
}
check(unknown.size === 0,
  `200 generated bars emit only kit hits (unknown: ${[...unknown].join(",") || "none"})`);
const missing = KIT_NAMES.filter((name) => !used.has(name));
check(missing.length === 0,
  `every kit hit is played by the grammar (missing: ${missing.join(",") || "none"})`);

const report = failures.length
  ? `\nFAIL ${failures.length} of ${assertions} assertions\n  - ${failures.join("\n  - ")}`
  : `\nPASS ${assertions} assertions`;
console.log(report);
process.exit(failures.length ? 1 : 0);
