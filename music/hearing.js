// What the home page says when the band starts, and the five bands the waves show.
//
// Pure and DOM-free, like explain.js: node asserts the words, player.js prints
// them. The wording says what the engine does and no more: a live head steers the
// band as it goes; with nobody sharing, a piece is generated from one session's
// summary (idle.js), which is never a replay.

/** The five bands, slow to fast, in the colours the cards draw their band bars in. */
export const BANDS = Object.freeze([
  Object.freeze({ key: "delta", color: "#f44336", wavelength: 150 }),
  Object.freeze({ key: "theta", color: "#ff9800", wavelength: 74 }),
  Object.freeze({ key: "alpha", color: "#4caf50", wavelength: 44 }),
  Object.freeze({ key: "beta", color: "#2196f3", wavelength: 22 }),
  Object.freeze({ key: "gamma", color: "#9c27b0", wavelength: 12 }),
]);

const finite = (v) => typeof v === "number" && Number.isFinite(v);

function normalise(raw) {
  const total = BANDS.reduce((sum, band) => sum + (raw[band.key] || 0), 0);
  if (!(total > 0)) return null;
  const out = {};
  for (const band of BANDS) out[band.key] = (raw[band.key] || 0) / total;
  return out;
}

/**
 * Each band's share of the power in a record summary. `bands_median` holds the
 * log10 band power per electrode; an electrode that measured nothing is stored
 * as exactly 0 and is left out. Null when the summary has no band powers.
 */
export function sharesFromMedians(medians) {
  if (!medians || typeof medians !== "object") return null;
  const raw = {};
  for (const band of BANDS) {
    const map = medians[band.key];
    if (!map || typeof map !== "object") continue;
    const powers = Object.values(map).filter((v) => finite(v) && v !== 0).map((v) => 10 ** v);
    if (powers.length) raw[band.key] = powers.reduce((a, b) => a + b, 0) / powers.length;
  }
  return normalise(raw);
}

/**
 * Each band's share for the heads playing live, averaged over them. A view
 * carries delta, theta and gamma as shares of the whole, and alpha and beta as
 * shares of alpha + theta + beta, so those two are scaled back through theta.
 */
export function sharesFromViews(views) {
  const sum = {};
  let heads = 0;
  for (const view of Array.isArray(views) ? views : []) {
    if (!view || view.gone) continue;
    const one = {};
    for (const key of ["delta", "theta", "gamma"]) if (finite(view[key]) && view[key] > 0) one[key] = view[key];
    const a = finite(view.alphaShare) ? view.alphaShare : null;
    const b = finite(view.betaShare) ? view.betaShare : null;
    if (a !== null || b !== null) {
      const rest = 1 - (a || 0) - (b || 0);                 // theta's share of the three
      const three = one.theta && rest > 1e-6 ? one.theta / rest : 1;
      if (a !== null) one.alpha = a * three;
      if (b !== null) one.beta = b * three;
    }
    const shares = normalise(one);
    if (!shares) continue;
    heads += 1;
    for (const band of BANDS) sum[band.key] = (sum[band.key] || 0) + shares[band.key];
  }
  return heads ? normalise(sum) : null;
}

/**
 * How tall a band's ripple stands, in pixels: taller the more of the power the
 * band holds, never taller than its own wavelength can carry without folding.
 * With no shares known every band stands at the same middling height.
 */
export function rippleHeight(shares, key) {
  const band = BANDS.find((b) => b.key === key);
  if (!band) return 0;
  let rel = 0.5;
  if (shares) {
    const top = Math.max(...BANDS.map((b) => shares[b.key] || 0));
    rel = top > 0 ? (shares[key] || 0) / top : 0.5;
  }
  return Math.min(0.34 * band.wavelength, 2.5 + 8.5 * Math.sqrt(rel));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2025-10-18T16:23:46" -> "18 Oct 2025"; anything else -> "". */
export function dayOf(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(stamp ?? ""));
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : "";
}

/**
 * The note shown when the music starts. `live` is how many heads are playing,
 * `piece` the record row the day's piece is generated from (or null), `rings`
 * whether the waves are being drawn (they are not when the visitor asked the
 * system for less motion).
 */
export function hearingNote({ live = 0, piece = null, rings = true } = {}) {
  let what;
  if (live > 0) {
    what = `Music made from brain waves as they happen: the band is following ${live} ${live === 1 ? "person" : "people"} `
      + "sharing their headband right now. Nothing here is a recording.";
  } else if (piece) {
    const day = dayOf(piece.date);
    const minutes = finite(piece.minutes) ? `${Math.round(piece.minutes * 10) / 10} min` : "";
    const which = [day, minutes].filter(Boolean).join(", ");
    what = "Music made from brain-wave measurements, not a recording. Nobody is sharing live right now, so today's piece is "
      + `generated from the summary of one session in the record${which ? ` (${which})` : ""}.`;
  } else {
    what = "Nobody is sharing live right now, so the band holds a resting pattern until someone opens their headband to the music.";
  }
  return {
    title: "What you are hearing",
    what,
    how: "A higher concentration score opens up the harmony and speeds the hi-hats, more alpha opens the hi-hat, and head "
      + "movement changes the drum fills.",
    // the page prints the five band names, each with its colour, between the two halves
    rings: rings
      ? ["The rings leaving 6ense are the five brain-wave bands, slow to fast:",
        "A ripple stands taller the more of the power its band holds."]
      : null,
    more: { text: "The desk shows every rule", href: "music/listen.html?relay=1" },
  };
}
