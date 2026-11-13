// What the record's piece sounds as for one session: the chord chain bar by bar, the concentration it walks at,
// and the bars where two notes that sound together sit a semitone apart.
//   node music/probe_piece.mjs <stamp> [bars]
import fs from "node:fs";
import { createIdle } from "./idle.js";
import { NOTE_NAMES } from "./families.js";
import { STEPS_PER_BAR } from "./generator.js";

const [stamp, barsArg = "96"] = process.argv.slice(2);
const index = JSON.parse(fs.readFileSync(new URL("../data/index.json", import.meta.url), "utf8"));
const row = index.sessions.find((s) => s.stamp === stamp);
if (!row) { console.error("not in the record:", stamp); process.exit(2); }
const summary = row.devices.find((d) => d && d.bands_median) || row.devices[0];
const idle = createIdle({ stamp, summary, bars: 16, bpm: 132 });
const name = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const chain = [];
let sourBars = 0, cMin = 1, cMax = 0;
const families = {};
for (let i = 0; i < Number(barsArg); i += 1) {
  const bar = idle.pullBar(i);
  const C = bar.ui.C; cMin = Math.min(cMin, C); cMax = Math.max(cMax, C);
  const chords = bar.chords || [];
  const notes = [];
  chords.forEach((ch, k) => { const to = k + 1 < chords.length ? chords[k + 1].step : STEPS_PER_BAR; for (const m of ch.voicing || []) notes.push({ v: "pad", m, a: ch.step || 0, b: to }); });
  for (const n of bar.bass || []) notes.push({ v: "bass", m: n.midi, a: n.step, b: n.step + n.dur });
  for (const n of bar.lead || []) notes.push({ v: "lead", m: n.midi, a: n.step, b: n.step + 4 });
  if (bar.drone != null) notes.push({ v: "drone", m: typeof bar.drone === "number" ? bar.drone : bar.drone.midi, a: 0, b: STEPS_PER_BAR });
  const sour = new Set();
  for (let x = 0; x < notes.length; x += 1) for (let y = x + 1; y < notes.length; y += 1) {
    const p = notes[x], q = notes[y];
    if ((p.v === "lead" && q.v === "lead") || p.a >= q.b || q.a >= p.b) continue;
    const d = Math.abs(p.m - q.m) % 12;       // upper note above the lower, octaves folded: 1 = minor 2nd or 9th
    if (d === 1) sour.add(`${p.v} ${name(p.m)}/${q.v} ${name(q.m)}`);
  }
  const deg = (chords[0] || {}).degree || "?";
  families[bar.family || "transition"] = (families[bar.family || "transition"] || 0) + 1;
  if (sour.size) { sourBars += 1; chain.push(`  bar ${i + 1} C ${C.toFixed(2)} ${bar.family || "transition"} ${deg}: ${[...sour].slice(0, 3).join("; ")}`); }
}
console.log(`${stamp}: tempo ${idle.tempo ?? "?"}, C from ${cMin.toFixed(2)} to ${cMax.toFixed(2)}, families ${JSON.stringify(families)}`);
console.log(`${sourBars} of ${barsArg} bars put a semitone between notes that sound together`);
console.log(chain.slice(0, 14).join("\n"));
