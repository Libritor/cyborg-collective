// S11 proof for MarGoth: the rows the panel prints, and the split of C that
// lets them be re-weighted. No audio, no DOM.
// Run: node music/test_explain.js -> "PASS <n> assertions", exit 0.

import {
  devicesAt, timbreAt, DEVICE_GATES, LEAD_HIGH, VOTE_WEIGHT,
} from "./generator.js";
import {
  createSharer, push, view, concentration, concentrationParts, concentrationFromParts,
  normaliseWeights, getConcentrationWeights, setConcentrationWeights, partsFromConcentration,
  WEIGHT_DEFAULTS, DECAY_S, C_FLOOR,
} from "./conditioner.js";
import {
  DEVICE_LABELS, LADDER_RULES, ladderRows, timbreRows, voiceRows, noteName,
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

const near = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------- the weights
console.log("weights");
const thirds = normaliseWeights({ engagement: 1, activation: 1, steadiness: 1 });
check(near(thirds.engagement, 1 / 3) && near(thirds.activation, 1 / 3)
  && near(thirds.steadiness, 1 / 3),
  "equal raw weights become equal thirds, not three times louder");
const zeroed = normaliseWeights({ engagement: 0, activation: 0, steadiness: 0 });
check(zeroed.engagement === WEIGHT_DEFAULTS.engagement
  && zeroed.activation === WEIGHT_DEFAULTS.activation
  && zeroed.steadiness === WEIGHT_DEFAULTS.steadiness,
  "all-zero weights fall back to the defaults rather than dividing by zero");
const nan = normaliseWeights({ engagement: NaN, activation: null, steadiness: -1 });
check(nan.engagement === WEIGHT_DEFAULTS.engagement
  && nan.activation === WEIGHT_DEFAULTS.activation
  && nan.steadiness === WEIGHT_DEFAULTS.steadiness,
  "a non-finite or negative term falls back on its own");
const summed = normaliseWeights({ engagement: 2, activation: 1, steadiness: 1 });
check(near(summed.engagement + summed.activation + summed.steadiness, 1),
  "normalised weights sum to one");
check(getConcentrationWeights().engagement === 0.4,
  "the weights in force start at the plan's 0.4 / 0.3 / 0.3");

// the single-number stand-in: exact under the defaults, and not degenerate
let worstInverse = 0;
let degenerate = 0;
let inRange = true;
for (let i = 0; i <= 100; i += 1) {
  const C = i / 100;
  const p = partsFromConcentration(C);
  worstInverse = Math.max(worstInverse, Math.abs(concentrationFromParts(p) - C));
  // the endpoints are necessarily flat (0,0,0 and 1,1,1); every C between them
  // must give three different terms or the weights would cancel out
  if (i > 0 && i < 100 && p.engagement === p.activation
    && p.activation === p.steadiness) degenerate += 1;
  if ([p.engagement, p.activation, p.steadiness].some((v) => v < 0 || v > 1)) inRange = false;
}
check(worstInverse < 1e-12,
  `the fabricated terms reproduce C under the defaults (worst ${worstInverse.toExponential(1)})`);
check(degenerate === 0 && inRange,
  "and they are not all equal, so a re-weighting moves C instead of being cancelled out");
check(partsFromConcentration(NaN).engagement === 0, "a non-finite concentration gives zero terms");

// -------------------------------------------------------- C split exactly
console.log("concentration split");
const sharer = createSharer("tester");
for (let i = 0; i < 200; i += 1) {
  const t = i * 0.1;
  push(sharer, { t: "quality", hsi: { TP9: 1, AF7: 1, AF8: 2, TP10: 2 } }, t);
  push(sharer, {
    t: "bands",
    rel: {
      TP9: { delta: 0.40, theta: 0.20, alpha: 0.18, beta: 0.12, gamma: 0.10 },
      AF7: { delta: 0.36, theta: 0.22, alpha: 0.24, beta: 0.10, gamma: 0.08 },
      AF8: { delta: 0.34, theta: 0.18, alpha: 0.30, beta: 0.12, gamma: 0.06 },
      TP10: { delta: 0.42, theta: 0.19, alpha: 0.16, beta: 0.13, gamma: 0.10 },
    },
  }, t);
  push(sharer, { t: "arousal", index: 0.55 + 0.3 * Math.sin(i / 7), label: "alert" }, t);
}
let worst = 0;
let sampled = 0;
for (let i = 0; i < 200; i += 1) {
  const v = view(sharer, i * 0.1);
  const direct = concentration(v);
  const split = concentrationFromParts(concentrationParts(v));
  worst = Math.max(worst, Math.abs(direct - split));
  sampled += 1;
}
check(sampled === 200 && worst < 1e-12,
  `parts + weights reproduce concentration bit for bit (worst ${worst.toExponential(1)} over ${sampled} views)`);

const fresh = view(sharer, 19.9);
const parts = concentrationParts(fresh);
check(parts.engagement >= 0 && parts.engagement <= 1
  && parts.activation >= 0 && parts.activation <= 1,
  "the terms are the clamped quantities C is built from");
const stale = view(sharer, 200);
check(concentrationParts(stale).age === stale.age && stale.age > DECAY_S,
  "the age the decay reads rides on the parts, not lost in the split");
const decayed = concentrationFromParts({ ...parts, age: DECAY_S + 24 });
check(decayed >= C_FLOOR - 1e-9 && decayed < C_FLOOR + 0.06,
  `the decay still bleeds toward the vamp floor (${decayed.toFixed(3)})`);

setConcentrationWeights({ engagement: 1, activation: 0, steadiness: 0 });
const pureEngagement = concentrationFromParts({
  engagement: 0.8, activation: 0.2, steadiness: 0.5, age: 0,
});
check(near(pureEngagement, 0.8), "engagement-only weights make C the engagement term");
setConcentrationWeights({ engagement: 1, activation: 1, steadiness: 1 });
const equalTerms = concentrationFromParts({
  engagement: 0.8, activation: 0.2, steadiness: 0.5, age: 0,
});
check(near(equalTerms, 0.5), "equal weights make C the plain mean of the terms");
setConcentrationWeights(WEIGHT_DEFAULTS);
check(getConcentrationWeights().engagement === 0.4, "the defaults can be restored");

// -------------------------------------------------------------- the ladder
console.log("device gates");
check(JSON.stringify(Object.keys(DEVICE_GATES))
  === JSON.stringify([...devicesAt(0), "cliche", "drone", "mixture", "climb", "bII"]),
  "the gate table's order is the rack's order");
let mismatched = 0;
for (let i = 0; i <= 100; i += 1) {
  const C = i / 100;
  const expected = Object.keys(DEVICE_GATES).filter((key) => C >= DEVICE_GATES[key]);
  if (JSON.stringify(devicesAt(C)) !== JSON.stringify(expected)) mismatched += 1;
}
check(mismatched === 0, "devicesAt is exactly the filter over the printed gates (101 concentrations)");
check(JSON.stringify(devicesAt(0.29)) === JSON.stringify(["sus"])
  && JSON.stringify(devicesAt(0.3)) === JSON.stringify(["sus", "cliche", "drone", "mixture"]),
  "0.30 opens the cliché, the drone and mixture, not the climb");
check(!devicesAt(0.54).includes("climb") && devicesAt(0.55).includes("climb")
  && !devicesAt(0.74).includes("bII") && devicesAt(0.75).includes("bII"),
  "the climb opens at 0.55 and bII at 0.75, on the boundary");
check(LEAD_HIGH[0] < LEAD_HIGH[1] && LEAD_HIGH[0] >= 60 && LEAD_HIGH[1] <= 96,
  `the displayed lead window is a real register (${noteName(LEAD_HIGH[0])}..${noteName(LEAD_HIGH[1])})`);
check(VOTE_WEIGHT.contact > VOTE_WEIGHT.silent && VOTE_WEIGHT.contact === 1,
  "a head the band cannot read keeps a fifth of a vote");

console.log("ladder rows");
const bar = {
  index: 3,
  drums: [{ step: 15, hit: "kick" }, { step: 14, hit: "hatO" }, { step: 12, hit: "tomL" }],
  bass: [{ step: 0, midi: 33 }],
  lead: [],
  drone: null,
  chords: [],
};
const controls = {
  C: 0.88, alphaShare: 0.42, arousal: 0.80, motion: 0.40, asymmetry: 0.12,
};
const rows = ladderRows(controls, bar);
check(rows.length === 5, "the ladder is five rows");
check(JSON.stringify(rows.map((r) => r.signal))
  === JSON.stringify(["C", "alphaShare", "arousal", "motion", "asymmetry"]),
  "the rows are the five controls, in reading order");
check(rows[0].value === "0.88" && rows[0].flag === null, "C's row carries the number and no roll");
check(rows[0].state === "6/6 open: sus, cliché, drone, mixture, climb, bII · 16th hats",
  `C's row names every open device and the hat division ("${rows[0].state}")`);
check(rows[1].state === "p 0.72 · open hat at step 14" && rows[1].flag === true,
  "alphaShare's row predicts the open hat and reports that it fired");
check(rows[2].state === "p 0.20 · ghost kick at step 15" && rows[2].flag === true,
  "arousal's row predicts the ghost kick and reports that it fired");
check(rows[3].state === "toms", "the fill row reads the bar's own drums on the fill bar");
check(rows[3].flag === null, "the fill has no roll of its own, so it carries no flag");
check(rows[4].state.endsWith("· 0 notes"), `the asymmetry row names the window and the count (${rows[4].state})`);
check(rows[4].state.startsWith(`${noteName(LEAD_HIGH[0])}..${noteName(LEAD_HIGH[1])}`),
  "a non-negative asymmetry prints the high window");

const ahead = ladderRows(controls, { ...bar, index: 1 });
check(ahead[3].state === "fill in 2 bars", `two bars before the fill the row counts down (${ahead[3].state})`);
const snareFill = ladderRows({ ...controls, motion: 0.02 }, {
  ...bar, drums: [{ step: 12, hit: "snare" }, { step: 13, hit: "snare" }],
});
check(snareFill[3].state === "snares", "under the motion threshold the fill is snares");

const missing = ladderRows({}, {});
check(missing.every((r) => r.value === "—"), "a null control renders as a dash, never NaN");
check(missing[0].state === "1/6 open: sus · 8th hats", `and the rule half still reads (${missing[0].state})`);
check(missing[1].state === "p 0.30 · none this bar" && missing[1].flag === false,
  "a missing α predicts from the generator's own default, not from nothing");
check(missing[4].value === "—" && missing[4].state.endsWith("· 0 notes"),
  "a missing asymmetry still prints a window: the generator treats null as zero");
check(Object.keys(LADDER_RULES).length === 5, "every row has a rule string");
check(rows.every((r) => typeof r.rule === "string" && r.rule.length > 0),
  "no row renders without the rule that produced it");
check(DEVICE_LABELS.length === 6 && DEVICE_LABELS[1][1] === "cliché",
  "the device labels keep the accent the data key does not have");

// ---------------------------------------------------------------- the sound
console.log("timbre rows");
const hot = timbreAt(0.9);
const warm = timbreAt(0.55);
const sound = timbreRows(hot, warm);
check(sound.length === 5, "five timbre rows");
check(JSON.stringify(sound.map((r) => r.key))
  === JSON.stringify(["bassCutoff", "padCutoff", "padSend", "leadDelayFb", "saturation"]),
  "the sound rows are the timbre's own fields");
check(sound[0].value === `${Math.round(hot.bassCutoff)} Hz`
  && sound[0].delta === `+${Math.abs(hot.bassCutoff - warm.bassCutoff).toFixed(0)}`,
  `the bass body prints Hz and a signed delta (${sound[0].value} ${sound[0].delta})`);
check(sound[2].value === hot.padSend.toFixed(2)
  && sound[2].delta === `+${Math.abs(hot.padSend - warm.padSend).toFixed(2)}`,
  `continuous values keep two decimals (${sound[2].value} ${sound[2].delta})`);
const cooling = timbreRows(warm, hot);
check(cooling[0].delta.startsWith("−"),
  `a fall prints the minus sign, not a negative-hyphen (${cooling[0].delta})`);
check(timbreRows(timbreAt(0.5), null).every((r) => r.delta === null),
  "with no previous bar there is no delta to claim");
check(timbreRows(timbreAt(0.5), {}).every((r) => r.delta === null),
  "a previous timbre missing the field gives no delta either");

// ---------------------------------------------------------------- the voices
console.log("voice rows");
const voices = voiceRows(bar, { muted: ["lead"], roles: { drums: "demo-02" } });
check(voices.length === 5, "five voice rows");
check(voices.every((r) => Number.isInteger(r.count) && r.count >= 0),
  "every row counts notes rather than describing them");
check(voices[0].detail === "3 hits" && voices[0].count === 3, "drums count their hits");
check(voices[1].detail === "1 note · A1", `the bass names its root (${voices[1].detail})`);
check(voices[2].detail === "off" && voices[2].count === 0, "a null drone reads off, not NaN");
check(voices[3].detail === "—" && voices[3].count === 0, "a bar with no chord has no voicing");
check(voices[4].detail === "0 notes · muted", `the muted lead says so (${voices[4].detail})`);
check(voices[0].role === "demo-02", "a role lands on its own voice");
check(voices.filter((r) => r.role !== null).length === 1, "and on no other");
// the relay casts to {drums, bass, harmony, lead}: the pad is the harmony wizard
const castRoles = voiceRows(bar, { muted: [], roles: { drums: "p-1", harmony: "p-2", lead: "p-3" } });
check(castRoles[3].role === "p-2", `the pad takes the harmony role (${castRoles[3].role})`);
check(castRoles[2].role === null, "the drone has no wizard of its own");
check(castRoles.filter((r) => r.role !== null).length === 3, "three cast roles land on three rows");
const voiced = voiceRows({
  ...bar,
  chords: [{ voicing: [57, 60, 64] }],
  drone: 45,
}, { muted: [] });
check(voiced[3].detail === "A3 C4 E4" && voiced[3].count === 3,
  `the pad names its voicing (${voiced[3].detail})`);
check(voiced[2].detail === "A2", "a drone names its note");
check(voiced[4].detail === "0 notes", "an unmuted lead says nothing about muting");
check(noteName(69) === "A4" && noteName(81) === "A5", "note names are the octave-numbered ones");
check(voiceRows(null, null).length === 5, "a missing bar still renders five rows");

// -------------------------------------------------------------------- report
console.log("");
if (failures.length) {
  console.log(`${failures.length} FAILED of ${assertions} assertions`);
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
console.log(`PASS ${assertions} assertions`);
