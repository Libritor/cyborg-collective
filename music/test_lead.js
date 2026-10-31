// The lead's arithmetic and the two seats: pentatonic, wavetable, chooser.
// No audio and no DOM. Run: node music/test_lead.js -> "PASS <n> assertions".

import {
  KEYS, LEAD_RANGE, PENTATONIC, MAX_VOICES,
  isMajorQuality, pentatonicFamily, pentatonicNotes, harmonicAmplitudes, patchFrom, DEFAULT_PATCH,
} from "./lead.js";
import {
  AUTO, PAGE, SEATS, seatOptions, viewsForSeat, resolvedSeat, seatSentence,
} from "./drivers.js";
import { QUALITY } from "./families.js";
import { noteName } from "./explain.js";

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

const pcs = (notes) => [...new Set(notes.map((m) => ((m % 12) + 12) % 12))].sort((a, b) => a - b);

// ------------------------------------------------------------------- the keys
console.log("keys");
check(KEYS.length === 10, `ten caps, one row of a computer (${KEYS.length})`);
check(new Set(KEYS.map(([key]) => key)).size === 10, "every cap is a distinct key");
check(KEYS.every(([, degree], i) => degree === i), "and they run up the scale in order");

// ------------------------------------------------------------- the pentatonic
console.log("pentatonic");
// every quality the generator can emit has to take one side or the other
const majorByQuality = Object.keys(QUALITY).filter(isMajorQuality);
check(majorByQuality.join(",") === "maj,maj7",
  `major qualities are exactly the ones with a major third (${majorByQuality.join(",")})`);
check(!isMajorQuality("min") && !isMajorQuality("minmaj7") && !isMajorQuality("dim"),
  "min, minmaj7 and dim all take the minor pentatonic");
check(pentatonicFamily("sus4") === "sus" && pentatonicFamily("sus2") === "sus",
  "a sus chord takes neither: it has no third to decide with");
const sus = pentatonicNotes({ root: 60, quality: "sus4" });
const susPcs = sus.notes.map((m) => (m - 60 + 120) % 12).filter((pc, i, all) => all.indexOf(pc) === i);
check(!susPcs.includes(4) && !susPcs.includes(3),
  `and its pentatonic has no third in it (${susPcs.join(",")})`);
check(susPcs.includes(5) && susPcs.includes(7),
  "while keeping both notes the chord is actually made of (the 4 and the 5)");
check(sus.name === "C4 sus pentatonic", `the strip calls it what it is (${sus.name})`);

const am = pentatonicNotes({ root: 57, quality: "min" });
check(am.notes.length === 10, `a chord always yields ten keys (${am.notes.length})`);
check(am.notes[0] === 57, `the strip starts on the chord's own root (${noteName(am.notes[0])})`);
check(am.notes.every((m, i) => i === 0 || m > am.notes[i - 1]), "the notes rise");
check(am.notes.every((m) => m >= LEAD_RANGE[0] && m <= LEAD_RANGE[1]),
  `and stay inside the keyboard's window (${LEAD_RANGE.join("..")})`);
const shifted = (intervals, root) => intervals.map((i) => ((root + i) % 12)).sort((a, b) => a - b);
check(pcs(am.notes).join(",") === shifted(PENTATONIC.minor, 57).join(","),
  `the pitch classes are the minor pentatonic on A (${pcs(am.notes).join(",")})`);
check(am.name === "A3 minor pentatonic", `and the strip names itself (${am.name})`);

const cMaj = pentatonicNotes({ root: 60, quality: "maj" });
check(pcs(cMaj.notes).join(",") === shifted(PENTATONIC.major, 60).join(","),
  `a major chord takes the major pentatonic on C (${pcs(cMaj.notes).join(",")})`);
check(cMaj.notes[0] === 60 && cMaj.name.startsWith("C4 major"), "rooted on C, called C4 major");
check(pcs(cMaj.notes).length === 5 && pcs(am.notes).length === 5,
  "five pitch classes, ten keys: two octaves of the same scale");

// every root the generator can put in a bar still fills the strip
const roots = [];
for (let midi = 45; midi <= 76; midi += 1) roots.push(midi);
const stunted = roots.filter((root) => pentatonicNotes({ root, quality: "min" }).notes.length !== 10);
check(stunted.length === 0, `every root from C3 to E5 fills ten keys (${stunted.length} short)`);
const outOfWindow = roots.flatMap((root) => pentatonicNotes({ root, quality: "min" }).notes)
  .filter((m) => m < LEAD_RANGE[0] || m > LEAD_RANGE[1]);
check(outOfWindow.length === 0, "and none of them leaves the window");
check(pentatonicNotes(null).notes.length === 10,
  "with no chord at all it falls back to A minor rather than nothing");

// ------------------------------------------------------------- the wavetable
console.log("wavetable");
const amps = harmonicAmplitudes({ morph: 0.4, brightness: 0.6 }, 16);
check(amps.length === 17 && amps[0] === 0, "amplitudes cover 1..16 harmonics and no DC");
check(amps[1] > 0 && amps[2] > 0, "the first two harmonics are present");
const hollow = harmonicAmplitudes({ morph: 1, brightness: 0.6 }, 8);
const plain = harmonicAmplitudes({ morph: 0, brightness: 0.6 }, 8);
check(hollow[3] > hollow[4] * 3,
  `morph 1 favours the odd harmonics (3rd ${hollow[3].toFixed(3)} vs 4th ${hollow[4].toFixed(3)})`);
// the bias is what morph adds: at morph 0 the 4th harmonic keeps its full weight,
// at morph 1 it is all but gone. The 1/n rolloff shapes both, so compare the pair
// across the two morphs rather than against each other.
check(plain[4] > hollow[4] * 5,
  `morph 0 keeps the even harmonics morph 1 removes (4th ${plain[4].toFixed(4)} vs ${hollow[4].toFixed(4)})`);
check(Math.abs(plain[3] - hollow[3]) > plain[3] * 0.3,
  "and the odd ones grow into the space the evens left");
const bright = harmonicAmplitudes({ morph: 0.4, brightness: 1 }, 16);
const dark = harmonicAmplitudes({ morph: 0.4, brightness: 0 }, 16);
check(bright[12] > dark[12] * 5,
  `brightness opens the top of the wave (12th: ${bright[12].toFixed(4)} vs ${dark[12].toFixed(4)})`);
check(amps.every((a) => Number.isFinite(a) && a >= 0), "no amplitude is negative or NaN");
check(harmonicAmplitudes({}, 16)[4] > 0, "a patch with nothing set still has a wave");

// ---------------------------------------------------------------- the patch
console.log("patch");
const fromAlpha = patchFrom({ alphaShare: 0.8, betaShare: 0.9, motion: 0.4, arousal: 0.7, steadiness: 0.9 });
check(fromAlpha.morph > 0.9 && fromAlpha.brightness > 0.9,
  "alpha hollows and beta brightens, both clamped");
check(fromAlpha.detune > 10 && fromAlpha.detune <= 12 && fromAlpha.morph <= 1,
  "steadiness widens the pair, within range");
check(fromAlpha.jitter > 0 && fromAlpha.jitter <= 1, "movement adds a wobble");
const empty = patchFrom({});
check(Object.keys(empty).sort().join(",") === Object.keys(DEFAULT_PATCH).sort().join(","),
  "a head that has not reported still yields a whole patch");
check(empty.morph > 0 && empty.brightness > 0,
  "and it is a normal patch, not silence masquerading as one");
const wild = patchFrom({ alphaShare: 9, betaShare: -3, arousal: 42, steadiness: 99, motion: 7 });
const unit = ["morph", "brightness", "drive", "jitter"];
check(unit.every((key) => Number.isFinite(wild[key]) && wild[key] >= 0 && wild[key] <= 1)
  && Number.isFinite(wild.detune) && wild.detune >= 0 && wild.detune <= 12,
`out-of-range signals clamp into each field's own range (${Object.entries(wild).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")})`);
check(MAX_VOICES === 6, `six voices for ten keys (${MAX_VOICES})`);

// ------------------------------------------------------------------ the seats
console.log("seats");
const rows = [
  { pseudonym: "ana", name: "Ana", admitted: true, stale: false, label: "playable" },
  { pseudonym: "bo", name: "", admitted: false, stale: false, label: "not opened to the music" },
  { pseudonym: "cy", name: "Cy", admitted: true, stale: true, label: "playable" },
];
const options = seatOptions(rows);
check(options[0].id === AUTO, "auto is offered first");
check(options[options.length - 1].id === PAGE, "and this page last");
check(options.filter((o) => o.kind === "head").length === 2, "each admitted head gets a chip");
check(options.find((o) => o.id === "bo").kind === "refused",
  "an unopened head is listed but not choosable: being refused is information");

const views = [
  { pseudonym: "ana", gone: false }, { pseudonym: "cy", gone: false }, { pseudonym: "gone", gone: true },
];
check(viewsForSeat(views, AUTO).length === 2, "auto reads every head that is still here");
check(viewsForSeat(views, "ana").length === 1 && viewsForSeat(views, "ana")[0].pseudonym === "ana",
  "a named seat reads that head alone");
check(viewsForSeat(views, PAGE).length === 0, "this page reads no head at all");
check(viewsForSeat(views, "nobody").length === 0, "an absent name resolves to nothing");
check(resolvedSeat(views, "ana") === "ana", "a seat that is present is honoured");
check(resolvedSeat(views, "nobody") === AUTO, "a seat that has gone falls back to auto");
check(resolvedSeat(views, PAGE) === PAGE, "this page never falls back");
check(resolvedSeat([], "ana") === AUTO, "and with nobody connected, auto is all there is");
check(seatSentence(AUTO, options) === "every head in contact", "auto says what it means");
check(seatSentence(PAGE, options) === "the sliders", "as does this page");
check(seatSentence("ana", options) === "Ana", "and a chosen head its own name");
check(SEATS.join(",") === "band,patch", "there are two seats, and they are named");

// -------------------------------------------------------------------- report
console.log("");
if (failures.length) {
  console.log(`${failures.length} FAILED of ${assertions} assertions`);
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
console.log(`PASS ${assertions} assertions`);
