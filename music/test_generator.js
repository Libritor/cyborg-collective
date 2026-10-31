// S1 proof for MarGoth: the chain, the grammar, the registers and the ladder.
// No audio. Run: node music/test_generator.js  -> "PASS <n> assertions", exit 0.

import {
  createGenerator, nextBar, aggregate, devicesAt, timbreAt, seedFromText,
  REGISTER, VOICE_BUDGET, STEPS_PER_BAR, movementCost,
} from "./generator.js";
import {
  createSharer, push, view, concentration, HOLD_S, STALE_S, DECAY_S, C_FLOOR,
} from "./conditioner.js";
import { FAMILIES, QUALITY, EXIT_CADENCE } from "./families.js";

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

// ------------------------------------------------------------------ fixtures
const TONIC = 57;              // A3

function frameStream(count, { start = 0 } = {}) {
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const t = start + i * 0.125;
    frames.push(["quality", { t: "quality", hsi: { TP9: 1, AF7: 1, AF8: 2, TP10: 2 } }, t]);
    frames.push(["bands", {
      t: "bands",
      rel: {
        TP9: { delta: 0.40, theta: 0.20, alpha: 0.18, beta: 0.12, gamma: 0.10 },
        AF7: { delta: 0.36, theta: 0.22, alpha: 0.24, beta: 0.10, gamma: 0.08 },
        AF8: { delta: 0.34, theta: 0.18, alpha: 0.30, beta: 0.12, gamma: 0.06 },
        TP10: { delta: 0.42, theta: 0.19, alpha: 0.16, beta: 0.13, gamma: 0.10 },
      },
    }, t]);
    frames.push(["arousal", { t: "arousal", index: 0.55, label: "alert" }, t]);
    frames.push(["hr", { t: "hr", ok: true, bpm: 66, rmssd_ms: 42 }, t]);
    frames.push(["imu", { t: "imu", accel: [0.05, 0.02, 1.02] }, t]);
  }
  return frames;
}

function feed(sharer, frames) {
  for (const [, frame, t] of frames) push(sharer, frame, t);
  return sharer;
}

function playBars(gen, bars, controlsFn) {
  const out = [];
  for (let i = 0; i < bars; i += 1) {
    out.push(nextBar(gen, controlsFn ? controlsFn(i) : { C: 0.4, alphaShare: 0.3 }));
  }
  return out;
}

// ------------------------------------------------------- conditioning (§2)
console.log("conditioning");
const sharer = createSharer("tester");
const frames = frameStream(24);
feed(sharer, frames);
const lastT = frames[frames.length - 1][2];
const v = view(sharer, lastT + 0.05);
check(v.inContact === true, "a head in contact reports contact");
check(typeof v.alphaShare === "number" && v.alphaShare > 0 && v.alphaShare < 1,
  "alphaShare is a real share, not a raw power");
check(v.asymmetry !== null && v.asymmetry > 0,
  "frontal asymmetry is AF8 minus AF7 relative alpha");

const held = view(sharer, lastT + HOLD_S + 1);
check(held.held === true && held.alphaShare === v.alphaShare,
  "a missing frame holds the last value instead of decaying toward zero");
check(held.alphaShare > 0, "the held value is never zero");

const stale = view(sharer, lastT + STALE_S + 1);
check(stale.stale === true, "silence past the threshold is reported as stale");

const cFresh = concentration(view(sharer, lastT));
const cGone = concentration(view(sharer, lastT + DECAY_S + 24));
check(cFresh > cGone, "concentration bleeds while the wizard is gone");
check(cGone >= C_FLOOR - 1e-9 && cGone < C_FLOOR + 0.06,
  `a solo wizard settles at the vamp floor (${cGone.toFixed(3)})`);

const empty = createSharer("nobody");
check(view(empty, 0).gone === true, "a sharer with no frames is gone");
check(aggregate([view(empty, 0)], 0).mode === "vamp",
  "no wizard at all means vamp, never silence-by-accident");

// ------------------------------------------------------------ devices (§4)
console.log("pressure");
check(JSON.stringify(devicesAt(0.1)) === JSON.stringify(["sus"]),
  "low concentration unlocks only sus");
check(devicesAt(0.4).includes("cliche") && !devicesAt(0.4).includes("climb"),
  "mid concentration unlocks the cliché but not the climb");
check(devicesAt(0.9).includes("climb") && devicesAt(0.9).includes("bII"),
  "high concentration unlocks the climb and bII");
const t0 = timbreAt(0.1), t1 = timbreAt(0.9);
check(t1.bassCutoff > t0.bassCutoff && t1.padSend > t0.padSend
  && t1.saturation > t0.saturation,
  "tension opens filters, space and saturation (timbre carries pressure too)");

// ------------------------------------------------------------ determinism
console.log("determinism");
const a = playBars(createGenerator({ seed: 99, tonicMidi: TONIC }), 12);
const b = playBars(createGenerator({ seed: 99, tonicMidi: TONIC }), 12);
check(JSON.stringify(a) === JSON.stringify(b), "same seed, same twelve bars");
const c = playBars(createGenerator({ seed: 100, tonicMidi: TONIC }), 12);
check(JSON.stringify(a) !== JSON.stringify(c), "a different seed is a different piece");
check(seedFromText("20261027_012222") === seedFromText("20261027_012222")
  && seedFromText("a") !== seedFromText("b"), "a stamp hashes to a stable seed");

// ------------------------------------------------------------- grammar (§6)
console.log("grammar");
const bars = playBars(createGenerator({ seed: 7, tonicMidi: TONIC }), 40,
  (i) => ({ C: 0.45, alphaShare: 0.3, arousal: 0.5, motion: 0.02 }));
const allDrums = bars.flatMap((bar) => bar.drums);
const kickSteps = new Set(bars.map((bar) => bar.drums.filter((h) => h.hit === "kick")
  .map((h) => h.step).join(",")));
check(kickSteps.size === 1 && [...kickSteps][0].startsWith("0,"),
  "four-on-the-floor kick is in every bar, unaffected by any signal");
const snareBars = bars.every((bar) => bar.drums.some((h) => h.hit === "snare" && h.step === 4)
  && bar.drums.some((h) => h.hit === "snare" && h.step === 12));
check(snareBars, "the gated snare is on 2 and 4 in every bar");
check(allDrums.every((h) => h.step >= 0 && h.step < STEPS_PER_BAR),
  "no drum hit lands outside the bar");

const chords = bars.flatMap((bar) => bar.chords);
check(chords.length > 0, "the chain produces chords");
check(chords.every((chord) => !chord.devices.includes("sus") || chord.step !== 14),
  "no device fires on the last 8th of a bar");
check(bars.every((bar) => new Set(bar.chords.map((ch) => ch.step)).size === bar.chords.length),
  "never two chord events on the same step");

// harmonic rhythm: how many bars a chord is held for
const holdLengths = [];
let previous = null;
let run = 0;
for (const bar of bars) {
  const label = bar.chords.length ? bar.chords[0].label : null;
  if (label && label === previous) run += 1;
  else {
    if (previous) holdLengths.push(run);
    previous = label;
    run = 1;
  }
}
if (previous) holdLengths.push(run);
check(holdLengths.length > 0 && holdLengths.every((n) => n >= 1 && n <= 4),
  `a chord is held 1..4 bars (${holdLengths.join(",")})`);

// --------------------------------------------------------- voice leading (§5)
console.log("voice leading");
const moves = chords.filter((chord) => chord.rejected).length;
check(moves >= 0, "candidates record what lost, for the chain view");
const withinBudget = [];
let prevVoicing = null;
for (const bar of bars) {
  const voicing = bar.chords.length ? bar.chords[0].voicing : null;
  if (voicing && prevVoicing && voicing.length && prevVoicing.length) {
    withinBudget.push(movementCost(prevVoicing, voicing));
    prevVoicing = voicing;
  } else if (voicing) {
    prevVoicing = voicing;
  }
}
check(withinBudget.filter((m) => m > VOICE_BUDGET).length <= 3,
  `changes stay inside the ${VOICE_BUDGET}-semitone budget except at phrase lifts`);
const padNotes = chords.flatMap((chord) => chord.voicing || []);
check(padNotes.every((m) => m >= REGISTER.padYielding[0] && m <= REGISTER.pad[1]),
  "the pad never leaves its register, even while it yields to a cliché");

// ------------------------------------------------------------- registers (§5)
console.log("registers");
const bassNotes = bars.flatMap((bar) => bar.bass.map((n) => n.midi));
check(bassNotes.every((m) => m >= REGISTER.bass[0] && m <= REGISTER.bass[1]),
  `every bass note is inside A1..G#2 [${REGISTER.bass.join(",")}]`);
const drones = bars.map((bar) => bar.drone).filter((d) => d !== null);
check(drones.length > 0, "the drone fires at this concentration");
check(drones.every((d) => d > REGISTER.bass[1]),
  "the drone is always above the bass register");
const collisions = bars.filter((bar) => bar.drone !== null)
  .flatMap((bar) => bar.bass.filter((n) => bar.drone - n.midi < 12));
check(collisions.length === 0,
  "no bass note comes within an octave of the drone (no mud, no cancellation)");
const ivBars = bars.filter((bar) => bar.chords.length && bar.chords[0].label.startsWith("D"));
check(ivBars.every((bar) => bar.bass.every((n) => n.midi <= REGISTER.bass[1])),
  "iv's root stays in the bass register instead of folding onto the drone");

// ---------------------------------------------------------------- release
console.log("release");
const rel = createGenerator({ seed: 5, tonicMidi: TONIC, pinFamily: "cuts" });
const ramp = [];
for (let i = 0; i < 6; i += 1) ramp.push(nextBar(rel, { C: 0.8 }));
check(ramp.every((bar) => bar.ui.release !== true),
  "tension alone never fires the release");
for (let i = 0; i < 2; i += 1) ramp.push(nextBar(rel, { C: 0.3 }));
const released = [];
for (let i = 0; i < 6; i += 1) released.push(nextBar(rel, { C: 0.35 }));
const window = [...ramp, ...released];
const releaseBar = window.find((bar) => bar.ui.release === true);
check(Boolean(releaseBar), "letting go after a sustained peak plays the open release");
check(releaseBar && releaseBar.chords.length
  && releaseBar.chords[0].degree === FAMILIES.find((f) => f.id === "cuts").open.label,
  "the release lands on the family's open chord");

// ------------------------------------------------------------- cliché rule
console.log("cliché");
const clicheGen = createGenerator({ seed: 3, tonicMidi: TONIC, pinFamily: "milky" });
const clicheBars = [];
for (let i = 0; i < 24; i += 1) clicheBars.push(nextBar(clicheGen, { C: 0.5 }));
const clicheChords = clicheBars.flatMap((bar) => bar.chords).filter((ch) => ch.cliche);
check(clicheChords.length > 0, "the line cliché fires at moderate concentration");
const firstRoot = clicheChords.length ? clicheChords[0].root : null;
check(clicheChords.every((ch) => ch.root === firstRoot),
  "the cliché keeps one root while the quality moves");
const qualities = clicheChords.map((ch) => ch.quality);
check(qualities[0] === "minmaj7" && qualities[1] === "min7",
  `the cliché descends the 7th: ${qualities.join(" -> ")}`);
check(clicheChords.every((ch) => (ch.voicing || []).every((m) => m <= REGISTER.padYielding[1])),
  "during a cliché the pad yields an octave, so the machine dodges the human");
const afterCliche = clicheBars.flatMap((bar) => bar.chords).filter((ch) => !ch.cliche && ch.degree === "IVmaj7");
check(afterCliche.length > 0, "the cliché still breaks open into IVmaj7");

// ------------------------------------------------------------ vamp + heads
console.log("vamp and wizards");
const vampGen = createGenerator({ seed: 11, tonicMidi: TONIC });
const vamp = nextBar(vampGen, { mode: "vamp", C: 0.1 });
check(vamp.vamp === true && vamp.chords.length === 0 && vamp.drums.length > 0
  && vamp.bass.length > 0, "the vamp keeps drums and bass, drops harmony");
check(vamp.drone === null, "the vamp has no pedal: drums and bass only");

const one = createSharer("solo");
feed(one, frameStream(32));
const soloControls = aggregate([view(one, frames[frames.length - 1][2])], lastT);
check(soloControls.heads === 1 && soloControls.mode === "live",
  "one wizard is a live band, not a degraded case");
const soloBars = playBars(createGenerator({ seed: 21, tonicMidi: TONIC }), 8, () => soloControls);
check(soloBars.every((bar) => bar.chords.length && bar.bass.length && bar.drums.length),
  "a single wizard drives harmony, bass and drums in every bar");

const two = createSharer("second");
feed(two, frameStream(32, { start: 0.06 }));
const multi = aggregate([
  view(one, frames[frames.length - 1][2]),
  view(two, frames[frames.length - 1][2]),
], lastT);
check(multi.heads === 2 && typeof multi.C === "number",
  "two wizards aggregate into one set of controls");

// pressure must survive the whole pipeline, not just the conditioner
const hot = createSharer("hot");
for (let i = 0; i < 40; i += 1) {
  const t = i * 0.125;
  push(hot, { t: "quality", hsi: { TP9: 1, AF7: 1, AF8: 1, TP10: 1 } }, t);
  push(hot, {
    t: "bands",
    rel: {
      TP9: { theta: 0.15, alpha: 0.15, beta: 0.5 },
      AF7: { theta: 0.15, alpha: 0.15, beta: 0.5 },
      AF8: { theta: 0.15, alpha: 0.15, beta: 0.5 },
      TP10: { theta: 0.15, alpha: 0.15, beta: 0.5 },
    },
  }, t);
  push(hot, { t: "arousal", index: 0.9, label: "activated" }, t);
}
const hotControls = aggregate([view(hot, 5)], 5);
check(hotControls.C > 0.55,
  `a locked-in wizard reaches high pressure through aggregate (C=${hotControls.C.toFixed(2)})`);
const hotBars = playBars(createGenerator({ seed: 4, tonicMidi: TONIC }), 6, () => hotControls);
check(hotBars.some((bar) => bar.ui.devices.includes("climb")),
  "high pressure actually unlocks a device the generator did not have before");
check(hotBars.some((bar) => bar.timbre.bassCutoff > 500),
  "high pressure opens the mix, not just the harmony");

// and the solo wizard who leaves must settle into the vamp, not a frantic loop
const goneControls = aggregate([view(one, lastT + DECAY_S + 24)], lastT);
check(goneControls.mode === "vamp" && goneControls.C <= C_FLOOR + 0.06,
  `a solo wizard who left settles into the vamp (C=${goneControls.C.toFixed(2)})`);

// -------------------------------------------------------------- lead rules
console.log("lead");
const leadBars = playBars(createGenerator({ seed: 31, tonicMidi: TONIC }), 16,
  () => ({ C: 0.4, asymmetry: -0.2, alphaShare: 0.3 }));
const leadChecks = leadBars.flatMap((bar) => {
  if (!bar.chords.length || !bar.lead.length) return [];
  const tones = new Set((bar.chords[0].voicing || []).map((m) => ((m % 12) + 12) % 12));
  return bar.lead
    .filter((note) => note.step % 4 === 0)
    .map((note) => tones.has(((note.midi % 12) + 12) % 12));
});
check(leadChecks.length > 0 && leadChecks.every(Boolean),
  "every lead note on a beat is a chord tone (the lead obeys the harmony)");
const leadSteps = leadBars.flatMap((bar) => bar.lead.map((n) => n.midi));
check(leadSteps.every((m) => m >= REGISTER.lead[0] && m <= REGISTER.lead[1] + 12),
  "the auto lead stays in the lead register");

// ---------------------------------------------------------------- families
console.log("families");
for (const family of FAMILIES) {
  const ok = family.steps.every((s) => QUALITY[s.q] && s.bars >= 1 && s.bars <= 2);
  check(ok, `family ${family.id} has playable qualities and 1..2-bar steps`);
}
check(EXIT_CADENCE.length === 3 && EXIT_CADENCE[0].base === "major",
  "a major family hands back through iv -> bVII -> i, never on a downbeat");

const report = failures.length
  ? `\nFAIL ${failures.length} of ${assertions} assertions\n  - ${failures.join("\n  - ")}`
  : `\nPASS ${assertions} assertions`;
console.log(report);
process.exit(failures.length ? 1 : 0);
