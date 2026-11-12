// Proof for the home page's note, the five bands, and the stand-in waves drawn
// when only band powers are known.
// Run: node music/test_hearing.js -> "PASS <n> assertions", exit 0.

import { readFileSync } from "node:fs";

import { BANDS, SITES, sharesFromMedians, sharesFromViews, rippleHeight, powerWaves, dayOf, hearingNote, panelCaption } from "./hearing.js";
import { BANDS as CONDITIONER_BANDS } from "./conditioner.js";

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
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const total = (shares) => BANDS.reduce((sum, band) => sum + shares[band.key], 0);

console.log("the five bands");
{
  check(JSON.stringify(BANDS.map((b) => b.key)) === JSON.stringify(CONDITIONER_BANDS),
    "the same five bands, in the same order, as the conditioner reads");
  check(BANDS.every((b) => b.lo > 0 && b.hi > b.lo) && BANDS.every((b, i) => i === 0 || (b.lo >= BANDS[i - 1].lo && b.lo <= BANDS[i - 1].hi)),
    "each band has its edges in Hz, and the bands run on from one another, slow to fast");
  check(BANDS[0].lo === 1 && BANDS[BANDS.length - 1].hi === 44, "together they cover 1 to 44 Hz");
  check(BANDS.every((b) => /^#[0-9a-f]{6}$/.test(b.color)) && new Set(BANDS.map((b) => b.color)).size === BANDS.length,
    "every band has its own colour");
  check(["TP9", "AF7", "AF8", "TP10"].every((ch) => typeof SITES[ch] === "string" && SITES[ch].length > 5), "every electrode has a place in words");
}

console.log("shares from a record summary");
{
  // log10 band power per electrode; TP9 measured nothing and is stored as exactly 0
  const medians = {
    delta: { TP9: 0, AF7: 1, AF8: 1 },
    theta: { TP9: 0, AF7: 0, AF8: 1 },
    alpha: { TP9: 0, AF7: 1, AF8: 1 },
    beta: { TP9: 0, AF7: -1, AF8: -1 },
    gamma: { TP9: 0, AF7: -1, AF8: -1 },
  };
  const shares = sharesFromMedians(medians);
  check(near(total(shares), 1), "the five shares sum to one");
  check(near(shares.delta, 10 / 30.2) && near(shares.theta, 10 / 30.2) && near(shares.beta, 0.1 / 30.2),
    "a share is the band's mean power (10^median) over the electrodes that measured, out of the five");
  check(shares.delta === shares.alpha && shares.delta > shares.beta, "equal medians give equal shares; a weaker band gets less");
  check(sharesFromMedians(null) === null && sharesFromMedians({}) === null && sharesFromMedians({ alpha: {} }) === null,
    "no band powers -> null, never a made-up spectrum");
  check(sharesFromMedians({ alpha: { AF7: 0.5 } }).alpha === 1, "a summary with one band gives that band everything it has");
}

console.log("shares from the heads playing live");
{
  // the conditioner's view: delta, theta, gamma as shares of the whole; alpha and beta as shares of alpha+theta+beta
  const head = { delta: 0.2, theta: 0.1, gamma: 0.05, alphaShare: 0.45 / 0.75, betaShare: 0.2 / 0.75 };
  const shares = sharesFromViews([head]);
  check(near(total(shares), 1), "the five shares sum to one");
  check(near(shares.alpha, 0.45, 1e-9) && near(shares.beta, 0.2, 1e-9) && near(shares.delta, 0.2, 1e-9),
    "alpha and beta are scaled back through theta to shares of the whole");
  const two = sharesFromViews([head, { delta: 0.6, theta: 0.1, gamma: 0.1, alphaShare: 0.25, betaShare: 0.25 }]);
  check(near(total(two), 1) && two.delta > shares.delta && two.alpha < shares.alpha, "two heads are averaged");
  check(sharesFromViews([]) === null && sharesFromViews([{ gone: true, delta: 1 }]) === null && sharesFromViews([{}]) === null,
    "nobody, a head that left, or a head with no bands -> null");
}

console.log("the stand-in waves, when only band powers are known");
{
  const shares = { delta: 0.5, theta: 0.2, alpha: 0.2, beta: 0.09, gamma: 0.01 };
  check(rippleHeight(shares, "delta") > rippleHeight(shares, "theta") && rippleHeight(shares, "theta") > rippleHeight(shares, "beta"),
    "more of the power, a taller wave");
  check(BANDS.every((b) => rippleHeight(shares, b.key) > 0 && rippleHeight(shares, b.key) <= 11), "a band with little power still shows, and none stands taller than 11 px");
  check(rippleHeight(null, "alpha") > 0 && rippleHeight(null, "nope") === 0, "unknown shares stand at a middling height; an unknown band at none");

  const fs = 256;
  const waves = powerWaves(shares, fs, 0.5);
  check(waves.kind === "powers" && waves.fs === fs && waves.length === undefined, "it calls itself band powers, and has no end");
  const peak = (key) => Math.max(...Array.from({ length: fs * 2 }, (_, n) => Math.abs(waves.read(key, n))));
  check(BANDS.every((b) => near(peak(b.key), rippleHeight(shares, b.key) / 0.5, 0.05)),
    "each band swings as far as its share says, in the microvolts the page will scale back to pixels");
  const crossings = (key) => {
    let count = 0;
    for (let n = 1; n < fs * 4; n += 1) if (waves.read(key, n - 1) < 0 && waves.read(key, n) >= 0) count += 1;
    return count / 4;
  };
  check(BANDS.every((b) => crossings(b.key) >= b.lo - 0.5 && crossings(b.key) <= b.hi + 0.5), "each band is a steady wave at a rate inside its own range");
  check(waves.read("nope", 3) === undefined, "an unknown band has no wave");
}

console.log("the note");
{
  check(dayOf("2025-10-18T16:23:46") === "18 Oct 2025" && dayOf("2026-01-05") === "5 Jan 2026" && dayOf("drive__x") === "" && dayOf(null) === "",
    "a record date is printed as a day; anything else as nothing");
  const piece = { stamp: "s", date: "2025-10-18T16:23:46", minutes: 5.5 };
  const stored = { kind: "record", electrode: "TP10", seconds: 60 };
  const record = hearingNote({ live: 0, piece, waves: stored });
  check(record.title === "What you are hearing", "it has a title");
  check(/not a recording/.test(record.what) && /generated from the summary of one session in the record \(18 Oct 2025, 5\.5 min\)/.test(record.what),
    "nobody live: it says the piece is generated from one session's summary, and which");
  check(!/replay/i.test(record.what) && !/following/.test(record.what), "and claims neither a replay nor a live head");
  const one = hearingNote({ live: 1, piece: { date: "2025-10-18" } });
  const three = hearingNote({ live: 3 });
  check(/following 1 person sharing/.test(one.what) && /following 3 people sharing/.test(three.what) && !/the record/.test(one.what),
    "live heads: it says how many people the band is following, and does not mention the record");
  const nothing = hearingNote({ live: 0, piece: null });
  check(/resting pattern/.test(nothing.what), "no head and no piece: it says the band is holding a resting pattern");
  check(/hi-hat/.test(record.how) && /harmony/.test(record.how) && /drum fills/.test(record.how), "it says what the signal steers");
  check(record.more.href === "music/listen.html?relay=1", "it links to the desk, where every rule is shown");

  check(Array.isArray(record.waves) && record.waves.length === 2 && /in the panel/.test(record.waves[0]), "it explains the waves in two halves around the band names");
  check(/in microvolts against seconds/.test(record.waves[1]) && /in microvolts against seconds/.test(hearingNote({ live: 1, waves: { kind: "live", electrode: "TP9" } }).waves[1]),
    "where the dots are samples it says what the two axes are");
  check(/that session's own EEG: one minute from the electrode behind the right ear, split into its five bands/.test(record.waves[0])
    && /Every dot is one stored sample/.test(record.waves[1]),
    "a stored minute: it says the waves are the session's own EEG, how much of it, which electrode, and that a dot is a sample");
  check(/45 seconds from the electrode on the left forehead/.test(hearingNote({ piece, waves: { kind: "record", electrode: "AF7", seconds: 45 } }).waves[0]),
    "a stretch that is not a minute is given in seconds");
  const raw = hearingNote({ live: 1, waves: { kind: "live", electrode: "TP9" } });
  check(/one sharer's raw trace as it arrives, from the electrode behind the left ear/.test(raw.waves[0]) && !/stored/.test(raw.waves.join(" ")),
    "a live raw trace: it says so, and does not call the samples stored");
  const powersLive = hearingNote({ live: 2, waves: { kind: "powers" } });
  const powersRecord = hearingNote({ live: 0, piece, waves: { kind: "powers" } });
  check(/how strong each of the five bands is for the people sharing/.test(powersLive.waves[0]) && /in that summary/.test(powersRecord.waves[0])
    && [powersLive, powersRecord].every((n) => /band powers, not from a raw trace/.test(n.waves[1]) && !/sample/.test(n.waves.join(" "))),
    "band powers only: it says the waves are not a raw trace, and never speaks of samples");
  check([record, raw, powersLive].every((n) => /Steve Mann's SWIM \(Sequential Wave Imprinting Machine\)/.test(n.waves[1])), "it names the SWIM the drawing follows");
  check(hearingNote({ live: 0, piece: null, waves: null }).waves === null, "with the waves off it says nothing about them");
  const words = [record.what, record.how, ...record.waves].join(" ").split(/\s+/).length;
  check(words <= 120, `it stays short (${words} words)`);
}

console.log("the line over the panel");
{
  const piece = { stamp: "s", date: "2025-12-13T17:09:44", minutes: 14.3 };
  const stored = { kind: "record", electrode: "TP10" };
  const silent = panelCaption({ shown: stored, piece, playing: false });
  const playing = panelCaption({ shown: stored, piece, playing: true });
  check(/^brain waves · session of 13 Dec 2025 · electrode TP10, behind the right ear/.test(silent) && playing === "brain waves · session of 13 Dec 2025 · electrode TP10, behind the right ear",
    "a stored minute: whose session, which electrode and where it sits");
  check(/♪ listen sets the wand going$/.test(silent) && !/listen/.test(playing), "silent, it says how to set the wand going; playing, it does not");
  const waiting = panelCaption({ shown: stored, piece, playing: false, silent: true });
  check(/no sound yet$/.test(waiting) && !/listen/.test(waiting) && /session of 13 Dec 2025/.test(waiting),
    "the wand sweeping before the browser lets the page sound: it says there is no sound yet, and does not send the visitor to the button");
  check(/held still, as your system asks for less motion$/.test(panelCaption({ shown: stored, piece, playing: true, still: true })), "held still for a visitor who asked for less motion, it says so");
  check(panelCaption({ shown: { kind: "live", electrode: "AF7" }, live: 1, playing: true }) === "brain waves, live · electrode AF7, on the left forehead", "a live raw trace: live, and which electrode");
  check(panelCaption({ shown: { kind: "powers" }, live: 2, playing: true }) === "band powers of the people sharing live · no raw trace to draw"
    && panelCaption({ shown: { kind: "powers" }, piece, playing: true }) === "band powers of the day's session · no raw trace to draw",
    "band powers only: it does not call them brain waves, and says there is no raw trace");
  check(panelCaption({ playing: true }) === "brain waves" && /listen/.test(panelCaption({})), "nothing to show: just the name, and how to start");
}

console.log("purity");
{
  const source = readFileSync(new URL("./hearing.js", import.meta.url), "utf8");
  check(!/from "node:|require\(/.test(source) && !/document\.|window\./.test(source), "hearing.js is pure ESM: no node built-ins, no DOM");
  check(!/Math\.random\s*\(/.test(source) && !/(Date|performance)\.now\s*\(/.test(source), "hearing.js reads no clock and no PRNG");
}

const report = failures.length
  ? `\nFAIL ${failures.length} of ${assertions} assertions\n  - ${failures.join("\n  - ")}`
  : `\nPASS ${assertions} assertions`;
console.log(report);
process.exit(failures.length ? 1 : 0);
