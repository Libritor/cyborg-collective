// S3 proof for MarGoth: the lookahead scheduler's arithmetic, with no audio and
// no timer. Run: node music/test_scheduler.js -> "PASS <n> assertions", exit 0.

import { createScheduler, pump, sixteenth, LOOKAHEAD_S, TICK_MS } from "./scheduler.js";
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

/**
 * Drive the scheduler the way a step-5 loop will: a timer that is routinely
 * late by a few milliseconds, never a timer that is on time.
 *
 * It runs one bar past the request and then drops that bar. A bar event is
 * emitted only after the previous bar's sixteenth step, so the extra pull is
 * what proves the last requested bar played all sixteen of its steps instead of
 * being cut off the moment its downbeat appeared.
 */
function drive(pullBar, bars, { tempo = 132, startTime = 0.06 } = {}) {
  const state = createScheduler({ tempo, startTime });
  const events = [];
  let seenBars = 0;
  for (let tick = 0; seenBars < bars + 1; tick += 1) {
    if (tick > 200000) throw new Error("scheduler never produced the requested bars");
    const now = startTime + (tick * TICK_MS) / 1000;
    const pumped = pump(state, now, { pullBar });
    for (const event of pumped.events) {
      seenBars += event.kind === "bar" ? 1 : 0;
      if (event.bar < bars) events.push({ ...event, now });
    }
  }
  return events;
}

const BARS = 60;
const controls = { C: 0.7, alphaShare: 0.35, arousal: 0.7, motion: 0.3 };

// ----------------------------------------------------------- the real generator
console.log("scheduler");
const gen = createGenerator({ seed: 1, tonicMidi: 57 });
const pulled = [];
const events = drive((index) => {
  const bar = nextBar(gen, controls);
  pulled.push(bar);
  return bar;
}, BARS);

const barEvents = events.filter((e) => e.kind === "bar");
const drumEvents = events.filter((e) => e.kind !== "bar");

check(events.every((e) => e.time >= e.now),
  "no event is ever scheduled in the past (every time >= the now that asked for it)");
check(events.every((e, i) => i === 0 || e.time >= events[i - 1].time),
  `all ${events.length} event times are non-decreasing (a bar event shares the downbeat with its own hits)`);
check(barEvents.length > 0 && barEvents.every((e, i) => i === 0 || e.time > barEvents[i - 1].time),
  "bar downbeats are strictly increasing");
check(drumEvents.every((e, i) => i === 0 || e.time >= drumEvents[i - 1].time),
  "drum event times are non-decreasing");
// A drum machine stacks hits on one 16th on purpose (kick under every hat, the
// fill doubling the backbeat). Two hits may share an instant, but only if they
// share the step that put them there -- a shared instant across two steps would
// mean the grid collapsed.
const stackedBad = [];
let stackedCount = 0;
for (let i = 1; i < drumEvents.length; i += 1) {
  if (drumEvents[i].time !== drumEvents[i - 1].time) continue;
  stackedCount += 1;
  if (drumEvents[i].bar !== drumEvents[i - 1].bar || drumEvents[i].step !== drumEvents[i - 1].step) {
    stackedBad.push(`bar ${drumEvents[i].bar} step ${drumEvents[i].step} vs ${drumEvents[i - 1].step}`);
  }
}
check(stackedCount > 0 && stackedBad.length === 0,
  `${stackedCount} stacked hits, all from one 16th (clashes: ${stackedBad.slice(0, 3).join(", ") || "none"})`);

check(barEvents.length === BARS, `${BARS} bar events for ${BARS} pulled bars (got ${barEvents.length})`);
check(barEvents.every((e, i) => e.bar === i), "bar events are numbered in pull order");
check(drumEvents.length === pulled.slice(0, BARS).reduce((n, bar) => n + bar.drums.length, 0),
  `every generated drum hit is emitted (${drumEvents.length} of ${pulled.slice(0, BARS).reduce((n, bar) => n + bar.drums.length, 0)})`);
check(drumEvents.every((e) => e.step >= 0 && e.step < 16),
  "every drum event lands on a 16th inside the bar");

// The grid inside a bar: the event time is the bar's downbeat plus step 16ths.
// Both sides of the comparison come from the same downbeat, so the tolerance is
// float noise and not accumulated drift.
const barTime = new Map(barEvents.map((e) => [e.bar, e.time]));
const barTempo = new Map(barEvents.map((e) => [e.bar, e.tempo]));
let worstStep = 0;
for (const e of drumEvents) {
  const expected = barTime.get(e.bar) + e.step * sixteenth(barTempo.get(e.bar));
  worstStep = Math.max(worstStep, Math.abs(e.time - expected));
}
check(worstStep <= 1e-12,
  `every hit sits exactly on its 16th (worst error ${worstStep.toExponential(2)} s)`);

// Tempo: one grid per bar, and the grid is the tempo polled at that bar's
// downbeat. Adjacent steps inside a bar must be sixteenth(tempo) apart.
let worstSpacing = 0;
for (let bar = 0; bar < BARS; bar += 1) {
  const steps = drumEvents.filter((e) => e.bar === bar);
  const s = sixteenth(barTempo.get(bar));
  for (let i = 1; i < steps.length; i += 1) {
    const gapSteps = steps[i].step - steps[i - 1].step;
    worstSpacing = Math.max(worstSpacing, Math.abs((steps[i].time - steps[i - 1].time) - gapSteps * s));
  }
}
check(worstSpacing <= 1e-12,
  `16th spacing is 60/tempo/4 inside every bar (worst error ${worstSpacing.toExponential(2)} s)`);

// ------------------------------------------------------- a tempo change is safe
// A fake bar that fills all sixteen steps and alternates tempo. If the grid
// were re-derived mid-measure, the steps after the change would drift and this
// is where it would show.
const fake = (index) => ({
  tempo: index % 2 ? 90 : 132,
  drums: Array.from({ length: 16 }, (_, step) => ({ step, hit: "kick", vel: 1 })),
});
const fakeEvents = drive(fake, 8, { tempo: 132 });
const fakeBars = fakeEvents.filter((e) => e.kind === "bar");
const fakeDrums = fakeEvents.filter((e) => e.kind !== "bar");

check(fakeBars.length === 8 && fakeBars.every((e, i) => e.tempo === (i % 2 ? 90 : 132)),
  "a bar's own tempo is what the bar event reports (scheduler polls at the downbeat)");
check(fakeDrums.length === 8 * 16, `all ${8 * 16} hits of the alternating-tempo bars are emitted`);

let worstFake = 0;
for (let bar = 0; bar < 8; bar += 1) {
  const steps = fakeDrums.filter((e) => e.bar === bar);
  const tempo = bar % 2 ? 90 : 132;
  const s = sixteenth(tempo);
  check(steps.length === 16, `bar ${bar} at ${tempo} BPM emits its 16 steps`);
  check(steps.every((e, i) => e.step === i), `bar ${bar} steps are in order 0..15`);
  for (let i = 1; i < steps.length; i += 1) {
    worstFake = Math.max(worstFake, Math.abs((steps[i].time - steps[i - 1].time) - s));
  }
}
check(worstFake <= 1e-12,
  `the grid does not warp across a tempo change (worst error ${worstFake.toExponential(2)} s)`);
const fast = fakeDrums.filter((e) => e.bar === 0);
const slow = fakeDrums.filter((e) => e.bar === 1);
check((slow[1].time - slow[0].time) > (fast[1].time - fast[0].time) * 1.4,
  "90 BPM steps are measurably longer than 132 BPM steps (the tempo was actually used)");

check(LOOKAHEAD_S > TICK_MS / 1000,
  `the lookahead (${LOOKAHEAD_S}s) is wider than a tick (${TICK_MS}ms)`);

const report = failures.length
  ? `\nFAIL ${failures.length} of ${assertions} assertions\n  - ${failures.join("\n  - ")}`
  : `\nPASS ${assertions} assertions`;
console.log(report);
process.exit(failures.length ? 1 : 0);
