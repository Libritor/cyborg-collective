// What a chord family actually sounds as: every bar's pad, bass, drone and lead notes, and the sour intervals
// among notes that sound at the same time (a semitone, or a semitone stretched over octaves: a minor 9th). Some of these are meant (the phrygian bII against the pedal, the 7th of a major-7th chord); the
// list is for hearing with the eyes what a change to families.js will do before it is played.
//   node music/probe_family.mjs <family id> [C] [bars]
import { createGenerator, nextBar, STEPS_PER_BAR } from "./generator.js";
import { NOTE_NAMES } from "./families.js";

const [family = "milky", cArg = "0.62", barsArg = "12"] = process.argv.slice(2);
const C = Number(cArg);
const name = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const gen = createGenerator({ seed: 5, tonicMidi: 57, pinFamily: family });
let sourBars = 0;
for (let i = 0; i < Number(barsArg); i += 1) {
  const bar = nextBar(gen, { C, alphaShare: 0.34, arousal: 0.14, motion: 0.09, asymmetry: -0.44 });
  const chords = bar.chords || [];
  const notes = [];                                    // { voice, midi, from, to } in sixteenths of the bar
  chords.forEach((ch, k) => {
    const to = k + 1 < chords.length ? chords[k + 1].step : STEPS_PER_BAR;
    for (const midi of ch.voicing || []) notes.push({ voice: "pad", midi, from: ch.step || 0, to });
  });
  for (const n of bar.bass || []) notes.push({ voice: "bass", midi: n.midi, from: n.step, to: n.step + n.dur });
  for (const n of bar.lead || []) notes.push({ voice: "lead", midi: n.midi, from: n.step, to: n.step + 4 });   // a lead note rings for its beat
  if (bar.drone != null) notes.push({ voice: "drone", midi: typeof bar.drone === "number" ? bar.drone : bar.drone.midi, from: 0, to: STEPS_PER_BAR });
  const sour = new Set();
  for (let a = 0; a < notes.length; a += 1) {
    for (let b = a + 1; b < notes.length; b += 1) {
      const x = notes[a], y = notes[b];
      if (x.voice === "lead" && y.voice === "lead") continue;                 // one lead note follows another
      if (x.from >= y.to || y.from >= x.to) continue;                          // they do not sound together
      const d = Math.abs(x.midi - y.midi) % 12;                               // upper note above the lower, octaves folded
      if (d === 1) sour.add(`${x.voice} ${name(x.midi)} / ${y.voice} ${name(y.midi)}`);
    }
  }
  if (sour.size) sourBars += 1;
  const first = chords[0] || {};
  const uniq = (voice) => [...new Set(notes.filter((n) => n.voice === voice).map((n) => n.midi))].map(name).join(" ");
  console.log(`bar ${String(i + 1).padStart(2)}  ${(first.degree || "?").padEnd(8)} ${chords.map((ch) => ch.label).filter((l, k, all) => l !== all[k - 1]).join(">").padEnd(12)}`
    + ` pad ${uniq("pad").padEnd(17)} bass ${uniq("bass").padEnd(7)} drone ${uniq("drone").padEnd(3)} lead ${uniq("lead").padEnd(15)}`
    + (sour.size ? ` SOUR: ${[...sour].join("; ")}` : ""));
}
console.log(`${family}: ${sourBars} of ${barsArg} bars put a semitone between notes that sound together`);
