// Proof for the bar -> events seam. No audio.
// Run: node music/test_arrange.js -> "PASS <n> assertions", exit 0.

import { arrangeBar, arrangeBars, KINDS } from "./arrange.js";
import { sixteenth } from "./scheduler.js";
import { createGenerator, nextBar, devicesAt } from "./generator.js";

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

const controls = { C: 0.9, alphaShare: 0.4, arousal: 0.8, motion: 0.5 };

/** A long run, so the rare devices (sus, bar-four fills) are in it. */
function run(count, { seed = 1, startTime = 0 } = {}) {
  const gen = createGenerator({ seed, tonicMidi: 57 });
  const bars = [];
  for (let i = 0; i < count; i += 1) bars.push(nextBar(gen, controls));
  return arrangeBars(bars, { bpm: 132, startTime });
}

console.log("arrange");
const { events, timbres, duration } = run(80);
check(timbres.length === 80, `${timbres.length} timbre changes, one per bar`);
check(events.length > 0 && events.every((e) => KINDS.includes(e.kind)),
  `only known kinds are emitted (${[...new Set(events.map((e) => e.kind))].join(",")})`);
check(events.every((e, i) => i === 0 || e.time >= events[i - 1].time), "events come out sorted by time");

// Every kind the band is supposed to have must appear, or a voice is silent.
const counts = {};
for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
check(counts.drum > 0 && counts.bass > 0 && counts.pad > 0 && counts.lead > 0 && counts.drone > 0,
  `all five kinds play (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")})`);
check(counts.drone > 0 && devicesAt(0.9).includes("drone"),
  "the drone is voiced whenever the device is open (it used to be emitted and never played)");

// The pad must follow the chord sheet, including a mid-bar sus resolution.
const susBars = [];
{
  const gen = createGenerator({ seed: 1, tonicMidi: 57 });
  for (let i = 0; i < 80; i += 1) {
    const bar = nextBar(gen, controls);
    if (bar.chords.length > 1) susBars.push({ bar, at: i * sixteenth(bar.tempo ?? 132) * 16 });
  }
}
check(susBars.length > 0, `${susBars.length} bars carry more than one chord (the sus device)`);
const badSegments = [];
for (const { bar, at } of susBars) {
  const segments = arrangeBar(bar, at).filter((e) => e.kind === "pad");
  if (segments.length !== bar.chords.length) {
    badSegments.push(`bar ${bar.index}: ${segments.length} segments for ${bar.chords.length} chords`);
    continue;
  }
  segments.forEach((segment, i) => {
    if (segment.voicing !== bar.chords[i].voicing) badSegments.push(`bar ${bar.index}: voicing ${i}`);
  });
}
check(badSegments.length === 0,
  `every chord in a bar becomes its own pad segment (${badSegments.slice(0, 3).join("; ") || "none"} mismatched)`);

// Segments must not overlap, and no envelope may run past its bar.
const s132 = sixteenth(132);
let overlapping = 0;
for (const { bar, at } of susBars) {
  const segments = arrangeBar(bar, at).filter((e) => e.kind === "pad");
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].time < segments[i - 1].time + segments[i - 1].dur) overlapping += 1;
  }
}
check(overlapping === 0, "pad segments never overlap on the same pitch");
check(susBars.every(({ bar, at }) => arrangeBar(bar, at)
  .filter((e) => e.kind === "pad" || e.kind === "drone")
  .every((e) => e.time + e.dur <= at + s132 * 16 + 1e-9)),
  "no pad or drone envelope outlives its bar");

// Silence must be honest: muting a kind removes exactly that kind.
const muted = arrangeBars([nextBar(createGenerator({ seed: 1 }), controls)], { muted: ["lead"] });
check(muted.events.every((e) => e.kind !== "lead"), "a muted lead emits nothing (the plan plays it muted)");

// The bar's events sit on the 16th grid and inside the bar.
let offGrid = 0;
let outOfBar = 0;
{
  const gen = createGenerator({ seed: 1, tonicMidi: 57 });
  let at = 0;
  for (let i = 0; i < 40; i += 1) {
    const bar = nextBar(gen, controls);
    const s = sixteenth(bar.tempo ?? 132);
    for (const e of arrangeBar(bar, at)) {
      const steps = (e.time - at) / s;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) offGrid += 1;
      if (e.time < at - 1e-9 || e.time >= at + s * 16) outOfBar += 1;
    }
    at += s * 16;
  }
}
check(offGrid === 0 && outOfBar === 0,
  `every event lands on a 16th inside its bar (${offGrid} off-grid, ${outOfBar} outside)`);

// chooseVoicing() can return a null voicing when nothing fits the register
// window (generator.js:139, a case generator.js itself guards for the lead). The
// pad must skip that chord rather than throw: inside the live loop a throw costs
// the rest of the bar, not just the chord.
const hollowBar = {
  index: 0, tempo: 132, family: null, vamp: false,
  chords: [{ step: 0, label: "X", quality: "min", voicing: null, devices: [], rejected: [] }],
  bass: [{ step: 0, midi: 33, dur: 2, vel: 0.8 }],
  drums: [{ step: 0, hit: "kick", vel: 1 }],
  lead: [], drone: null, timbre: { bassCutoff: 500 },
  ui: { C: 0.5, devices: [], chain: null, reason: "" },
};
let hollowError = null;
let hollowEvents = [];
try {
  hollowEvents = arrangeBar(hollowBar, 0);
} catch (err) {
  hollowError = err;
}
check(hollowError === null, `a chord with no voicing does not throw (${hollowError ? hollowError.message : "none"})`);
check(hollowEvents.every((e) => e.kind !== "pad"), "a chord with no voicing emits no pad event");
check(hollowEvents.some((e) => e.kind === "drum") && hollowEvents.some((e) => e.kind === "bass"),
  "the rest of that bar still plays");

check(Math.abs(duration - 80 * s132 * 16) < 1e-9, `the run is ${duration.toFixed(3)}s of bars`);

const report = failures.length
  ? `\nFAIL ${failures.length} of ${assertions} assertions\n  - ${failures.join("\n  - ")}`
  : `\nPASS ${assertions} assertions`;
console.log(report);
process.exit(failures.length ? 1 : 0);
