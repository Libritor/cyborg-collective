// The five chord families of MarGoth, as data.
//
// Each family is a path through chord *states*; a state is a degree of the
// tonic plus a quality. `base` says which tonic the degrees are measured from:
//   base "minor" -> the session tonic (default A minor)
//   base "major" -> the relative major (tonic + 3 semitones)
// Families are used as numeral sequences. The tracks they come from are
// harmonic references only: no lyrics, no audio, no arrangement, and the UI
// never names them.

export const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export const QUALITY = {
  min: [0, 3, 7],
  maj: [0, 4, 7],
  dim: [0, 3, 6],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  minmaj7: [0, 3, 7, 11],
  sus4: [0, 5, 7],
  sus2: [0, 2, 7],
};

export const QUALITY_SUFFIX = {
  min: "m", maj: "", dim: "°", min7: "m7", maj7: "maj7", minmaj7: "m(maj7)",
  sus4: "sus4", sus2: "sus2",
};

// A step: deg = semitones above the family's base, bars = default harmonic
// rhythm, label = what the chart prints.
const step = (deg, q, bars, label, extra = {}) => ({ deg, q, bars, label, ...extra });

export const FAMILIES = [
  {
    id: "milky",
    mode: "minor",
    title: "line cliché",
    // i - i(maj7) - i7 : one note descends inside a held root, then it breaks open
    steps: [
      step(0, "min", 2, "i"),
      step(0, "minmaj7", 1, "i(maj7)", { cliche: true }),
      step(0, "min7", 1, "i7", { cliche: true }),
      step(5, "maj7", 2, "IVmaj7"),
      step(10, "maj", 2, "bVII"),
    ],
    open: step(5, "maj7", 2, "IVmaj7"),
    devices: ["cliche", "drone"],
  },
  {
    id: "spellbound",
    mode: "minor",
    title: "phrygian climb",
    steps: [
      step(0, "min", 2, "i"),
      step(1, "maj", 1, "bII"),
      step(3, "maj", 1, "bIII"),
      step(5, "min", 2, "iv"),
    ],
    open: step(3, "maj", 2, "bIII"),
    devices: ["climb", "sus", "drone"],
  },
  {
    id: "silence",
    mode: "minor",
    title: "verse / chorus rotation",
    steps: [
      step(0, "min", 2, "i"),
      step(3, "maj", 2, "bIII"),
      step(8, "maj", 2, "bVI"),
      step(5, "min", 2, "iv"),
    ],
    // the chorus leans on the major chords: same tonic, different rotation
    alt: [
      step(0, "min", 2, "i"),
      step(8, "maj", 2, "bVI"),
      step(3, "maj", 2, "bIII"),
      step(10, "maj", 2, "bVII"),
    ],
    open: step(8, "maj", 2, "bVI"),
    devices: ["sus", "mixture", "drone"],
  },
  {
    id: "cuts",
    mode: "minor",
    title: "major IV lift",
    steps: [
      step(0, "min", 2, "i"),
      step(3, "maj", 2, "bIII"),
      step(10, "maj", 2, "bVII"),
      step(5, "maj", 2, "IV"),
    ],
    open: step(5, "maj", 2, "IV"),
    devices: ["sus", "drone"],
  },
  {
    id: "starman",
    mode: "major",
    title: "maj7 suspension",
    // major 7ths that never resolve, a whole-step climb, then IV -> iv mixture
    steps: [
      step(5, "maj7", 2, "IVmaj7"),
      step(0, "maj7", 2, "Imaj7"),
      step(8, "maj", 1, "bVI"),
      step(10, "maj", 1, "bVII"),
      step(0, "maj", 1, "I"),
      step(2, "maj", 1, "II"),
      step(0, "maj", 2, "I"),
      step(9, "min", 1, "vi"),
      step(5, "maj", 1, "IV"),
      step(5, "min", 2, "iv"),
    ],
    open: step(0, "maj7", 2, "Imaj7"),
    devices: ["sus"],
    // a family in the major has to hand back to the minor through a cadence:
    // its own iv becomes the pivot, bVII -> i crawls home (see EXIT_CADENCE)
    needsExit: true,
  },
];

// iv (of the major) -> bVII -> i (of the minor). Chromatic bass F -> G -> A,
// shared tones between every pair, so returning from the "Starman" lift never
// sounds like a mistake.
export const EXIT_CADENCE = [
  { base: "major", step: step(5, "min", 1, "iv") },
  { base: "minor", step: step(10, "maj", 1, "bVII") },
  { base: "minor", step: step(0, "min", 1, "i") },
];

export function familyById(id) {
  return FAMILIES.find((f) => f.id === id) || FAMILIES[0];
}

/** Signed semitone offset of a family's base from the session tonic. */
export function baseOffset(mode) {
  return mode === "major" ? 3 : 0;
}

export function chordLabel(absRoot, quality) {
  const pc = ((absRoot % 12) + 12) % 12;
  return NOTE_NAMES[pc] + (QUALITY_SUFFIX[quality] ?? "");
}
