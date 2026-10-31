// Proof for the loop: the whole schedule, driven in node with no browser and no
// audio. Run: node music/test_loop.js -> "PASS <n> assertions", exit 0.

import { createEngine, LIVE_LEAD_S } from "./loop.js";
import { createGenerator, nextBar } from "./generator.js";
import { sixteenth, TICK_MS } from "./scheduler.js";

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

const controls = { C: 0.5, alphaShare: 0.3, arousal: 0.5, motion: 0.3 };

/** A generator plus a tick loop, exactly as the live timer would drive it. */
function drive({ bars = 60, muted = [], bpm = 132, seed = 4 } = {}) {
  const gen = createGenerator({ seed, tonicMidi: 57, bpm });
  const pulled = [];
  const engine = createEngine({
    pullBar: () => { const bar = nextBar(gen, controls); pulled.push(bar); return bar; },
    bpm,
    muted,
    startTime: LIVE_LEAD_S,
  });

  const scheduled = [];
  let seenBars = 0;
  for (let tick = 0; seenBars < bars; tick += 1) {
    if (tick > 200000) throw new Error("the loop never produced the requested bars");
    const now = LIVE_LEAD_S + (tick * TICK_MS) / 1000;
    for (const event of engine.tick(now)) {
      scheduled.push({ ...event, now });
      if (event.kind === "bar") seenBars += 1;
    }
  }
  return { scheduled, pulled, engine };
}

console.log("loop");
const { scheduled, pulled } = drive();
const barEvents = scheduled.filter((e) => e.kind === "bar");
const played = scheduled.filter((e) => e.kind !== "bar");

check(barEvents.length === 60, `60 bars are announced (got ${barEvents.length})`);
check(scheduled.every((e) => e.time >= e.now),
  "nothing is ever scheduled in the past (every time >= the now that asked for it)");
check(scheduled.every((e, i) => i === 0 || e.time >= scheduled[i - 1].time),
  "the schedule is in time order");

// The drums must appear exactly once per hit. pump() also emits per-sixteenth
// drums; if those leaked in, every hit would be doubled.
const expectedDrums = pulled.reduce((n, bar) => n + bar.drums.length, 0);
const gotDrums = played.filter((e) => e.kind === "drum").length;
check(gotDrums === expectedDrums,
  `every drum hit is played exactly once (${gotDrums} of ${expectedDrums}, no pump duplicates)`);

// Each kind is arranged, and the counts follow the bars that were pulled.
for (const kind of ["bass", "pad", "drone", "lead"]) {
  const expected = kind === "pad"
    ? pulled.reduce((n, bar) => n + bar.chords.filter((_, i) => {
      const nextStep = i + 1 < bar.chords.length ? bar.chords[i + 1].step : 16;
      return (nextStep - bar.chords[i].step) * 0.1 > 0.05;
    }).length, 0)
    : kind === "drone"
      ? pulled.filter((bar) => typeof bar.drone === "number").length
      : pulled.reduce((n, bar) => n + bar[kind].length, 0);
  const got = played.filter((e) => e.kind === kind).length;
  check(got === expected, `every ${kind} is played (${got} of ${expected})`);
}

// Grid: each event is a whole number of 16ths from its bar's downbeat.
const barTime = new Map(barEvents.map((e) => [e.bar, e]));
let offGrid = 0;
let wrongTempo = 0;
for (const event of played) {
  const head = barTime.get(event.bar);
  const s = sixteenth(head.tempo);
  const steps = (event.time - head.time) / s;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) offGrid += 1;
  if (Math.abs(head.tempo - (pulled[event.bar].tempo ?? 132)) > 1e-9) wrongTempo += 1;
}
check(offGrid === 0 && wrongTempo === 0,
  `every event sits on its bar's 16th grid (${offGrid} off-grid, ${wrongTempo} wrong tempo)`);

// A tempo change is taken at the downbeat, never mid-bar.
{
  const gen = createGenerator({ seed: 7, tonicMidi: 57, bpm: 132 });
  const engine = createEngine({
    pullBar: () => {
      gen.bpm = gen.bar === 4 ? 90 : gen.bpm;     // changes once, between bars
      return nextBar(gen, controls);
    },
    startTime: LIVE_LEAD_S,
  });
  const out = [];
  for (let tick = 0; tick < 900; tick += 1) out.push(...engine.tick(LIVE_LEAD_S + (tick * TICK_MS) / 1000));
  const heads = out.filter((e) => e.kind === "bar");
  const tempi = [...new Set(heads.map((e) => e.tempo))];
  check(tempi.includes(90) && tempi.includes(132),
    `a tempo change reaches the grid (tempi ${tempi.join(",")})`);
  const slow = heads.filter((e) => e.tempo === 90);
  const fast = heads.filter((e) => e.tempo === 132);
  check(slow.length > 0 && fast.length > 0
    && slow.every((e, i) => i === 0 || Math.abs((e.time - slow[i - 1].time) - sixteenth(90) * 16) < 1e-9),
  "90 BPM bars are 16 sixteenths of 90 BPM long (the grid did not warp mid-bar)");
}

// Muting is honest.
const quiet = drive({ bars: 8, muted: ["lead"] });
check(quiet.scheduled.every((e) => e.kind !== "lead"), "a muted lead schedules nothing");

// Reanchoring. Without it a starved scheduler pours the whole gap in at once,
// which is the reason the method exists; with it, the gap is skipped.
{
  const starved = createEngine({
    pullBar: () => nextBar(createGenerator({ seed: 1 }), controls),
    startTime: LIVE_LEAD_S,
  });
  starved.tick(LIVE_LEAD_S);
  const burst = starved.tick(20).filter((e) => e.kind !== "bar" && e.time < 19);
  check(burst.length > 0,
    `without a reanchor a 20s gap schedules ${burst.length} events in the past (the bug)`);

  const caught = createEngine({
    pullBar: () => nextBar(createGenerator({ seed: 1 }), controls),
    startTime: LIVE_LEAD_S,
  });
  caught.tick(LIVE_LEAD_S);
  const steps = caught.reanchor(20);
  const after = caught.tick(20);
  check(steps > 0, `the reanchor skipped ${steps} sixteenths`);
  check(after.every((e) => e.time >= 20),
    "after a reanchor nothing is scheduled in the past");
  const lateGrid = after.filter((e) => e.kind !== "bar");
  check(lateGrid.every((e) => {
    const head = after.find((b) => b.kind === "bar" && b.bar === e.bar);
    const steps2 = (e.time - head.time) / sixteenth(head.tempo);
    return Math.abs(steps2 - Math.round(steps2)) < 1e-9;
  }), "the grid phase survives the reanchor");
  check(caught.reanchor(20.05) <= 1, "a reanchor that is not needed does almost nothing");
}

const report = failures.length
  ? `\nFAIL ${failures.length} of ${assertions} assertions\n  - ${failures.join("\n  - ")}`
  : `\nPASS ${assertions} assertions`;
console.log(report);
process.exit(failures.length ? 1 : 0);
