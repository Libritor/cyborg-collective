// Proof for the home page's note and the band shares its waves are drawn from.
// Run: node music/test_hearing.js -> "PASS <n> assertions", exit 0.

import { readFileSync } from "node:fs";

import { BANDS, sharesFromMedians, sharesFromViews, rippleHeight, dayOf, hearingNote } from "./hearing.js";
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
  const lambdas = BANDS.map((b) => b.wavelength);
  check(lambdas.every((v, i) => i === 0 || v < lambdas[i - 1]), "slower bands ripple longer: wavelengths fall from delta to gamma");
  check(BANDS.every((b) => /^#[0-9a-f]{6}$/.test(b.color)) && new Set(BANDS.map((b) => b.color)).size === BANDS.length,
    "every band has its own colour");
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

console.log("how tall a ripple stands");
{
  const shares = { delta: 0.5, theta: 0.2, alpha: 0.2, beta: 0.09, gamma: 0.01 };
  check(rippleHeight(shares, "delta") > rippleHeight(shares, "theta") && rippleHeight(shares, "theta") > rippleHeight(shares, "beta"),
    "more of the power, a taller ripple");
  check(BANDS.every((b) => rippleHeight({ ...shares, [b.key]: 1 }, b.key) <= 0.34 * b.wavelength + 1e-9),
    "never taller than the band's own wavelength can carry");
  check(BANDS.every((b) => rippleHeight(shares, b.key) > 0), "a band with little power still shows");
  check(rippleHeight(null, "alpha") > 0 && rippleHeight(null, "nope") === 0, "unknown shares stand at a middling height; an unknown band at none");
}

console.log("the note");
{
  check(dayOf("2025-10-18T16:23:46") === "18 Oct 2025" && dayOf("2026-01-05") === "5 Jan 2026" && dayOf("drive__x") === "" && dayOf(null) === "",
    "a record date is printed as a day; anything else as nothing");
  const record = hearingNote({ live: 0, piece: { stamp: "s", date: "2025-10-18T16:23:46", minutes: 5.5 } });
  check(record.title === "What you are hearing", "it has a title");
  check(/not a recording/.test(record.what) && /generated from the summary of one session in the record \(18 Oct 2025, 5\.5 min\)/.test(record.what),
    "nobody live: it says the piece is generated from one session's summary, and which");
  check(!/replay/i.test(record.what.replace("not a replay", "")) && !/following/.test(record.what), "and claims neither a replay nor a live head");
  const one = hearingNote({ live: 1, piece: { date: "2025-10-18" } });
  const three = hearingNote({ live: 3 });
  check(/following 1 person sharing/.test(one.what) && /following 3 people sharing/.test(three.what) && !/the record/.test(one.what),
    "live heads: it says how many people the band is following, and does not mention the record");
  const nothing = hearingNote({ live: 0, piece: null });
  check(/resting pattern/.test(nothing.what), "no head and no piece: it says the band is holding a resting pattern");
  check(Array.isArray(record.rings) && record.rings.length === 2 && /6ense/.test(record.rings[0]), "it explains the rings in two halves around the band names");
  check(hearingNote({ live: 0, piece: null, rings: false }).rings === null, "with the waves off it says nothing about rings");
  check(/hi-hat/.test(record.how) && /harmony/.test(record.how) && /drum fills/.test(record.how), "it says what the signal steers");
  check(record.more.href === "music/listen.html?relay=1", "it links to the desk, where every rule is shown");
  const words = [record.what, record.how, ...(record.rings || [])].join(" ").split(/\s+/).length;
  check(words <= 95, `it stays short (${words} words)`);
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
