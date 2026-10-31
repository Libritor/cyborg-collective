// Who drives what. Pure selection, so the page cannot quietly pick for you and
// node can assert the rule it does follow.
//
// Two seats, both filled from the relay's cast:
//
//   band   the parameters the backing track is generated from. "auto" is every
//          head in contact (the band votes, weighted by contact); a named head is
//          that head alone; "page" is the sliders, which is what a solo visitor
//          has anyway.
//   patch  the lead's wavetable. Same three options, and here "page" means the
//          patch follows the C slider's own terms.
//
// A named seat that leaves falls back to auto and says so: a seat that silently
// keeps voting for an absent head would be a lie about who is playing.

export const AUTO = "auto";
export const PAGE = "page";
export const SEATS = Object.freeze(["band", "patch"]);

/** The chips a seat offers, in reading order: auto, each head, this page. */
export function seatOptions(rows = []) {
  const options = [{
    id: AUTO,
    label: "auto",
    note: "every head in contact",
    kind: "auto",
  }];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.pseudonym) continue;
    options.push({
      id: row.pseudonym,
      label: row.name || row.pseudonym,
      note: row.admitted ? (row.stale ? "stale" : "in contact") : (row.label || "no vote"),
      kind: row.admitted ? "head" : "refused",
      stale: !!row.stale,
    });
  }
  options.push({ id: PAGE, label: "this page", note: "the sliders", kind: "page" });
  return options;
}

/**
 * The views a seat reads. Returns [] for "page" (the caller uses the sliders) and
 * for a head that is no longer in the cast -- the caller then falls back, and
 * `resolvedSeat` is what it should say it fell back to.
 */
export function viewsForSeat(views = [], choice = AUTO) {
  const list = (Array.isArray(views) ? views : []).filter((v) => v && !v.gone);
  if (choice === PAGE) return [];
  if (!choice || choice === AUTO) return list;
  const one = list.find((v) => v.pseudonym === choice);
  return one ? [one] : [];
}

/**
 * The seat actually in force: the choice if it can be honoured, otherwise auto.
 * The page prints this, so "ana is driving" is never shown for a head that left.
 */
export function resolvedSeat(views = [], choice = AUTO) {
  if (choice === PAGE) return PAGE;
  if (!choice || choice === AUTO) return AUTO;
  const present = (Array.isArray(views) ? views : []).some((v) => v && !v.gone && v.pseudonym === choice);
  return present ? choice : AUTO;
}

/** `"auto"` / `"page"` / a pseudonym, as the sentence a seat shows. */
export function seatSentence(seat, options = []) {
  if (seat === PAGE) return "the sliders";
  const found = options.find((option) => option.id === seat);
  if (seat === AUTO) return "every head in contact";
  return found ? found.label : "nobody connected";
}
