// One generator bar -> the timed events the audio engine plays.
//
// This is the seam between a bar (harmony, grammar, timbre) and a voice call, so
// it exists once: the loop and the browser gates both read bars through it.
//
// Two things it must not simplify away:
//   * the pad emits a segment per chord entry, not one per bar. The `sus` device
//     writes three chords into one bar (0, 8, 12), and playing only the first
//     means the suspension never resolves -- an advertised device that cannot be
//     heard, which is exactly the defect S1 went looking for.
//   * the drone is a voice. `devicesAt(C)` opens it at C >= 0.3, so it is on in
//     most bars; a bar whose drone nothing plays is a silent member of the band.

import { sixteenth } from "./scheduler.js";

export const KINDS = Object.freeze(["drum", "bass", "pad", "drone", "lead"]);

// Order matters only for events that share a time: the harmonic bed is placed
// before the figures that sit on top of it.
const ORDER = { pad: 0, drone: 0, bass: 1, lead: 2, drum: 3 };

// A pad segment stops just short of the next one so two envelopes never overlap
// on the same pitch: an exponential release with a hard zero needs a gap.
const SEGMENT_GAP_S = 0.01;
const MIN_SEGMENT_S = 0.05;

/**
 * @param bar      a bar from nextBar()
 * @param barTime  the downbeat, in seconds on the audio clock
 * @param muted    kinds to leave out (the plan plays with the auto-lead muted)
 */
export function arrangeBar(bar, barTime, { muted = [] } = {}) {
  const s = sixteenth(bar.tempo ?? 132);
  const events = [];
  const push = (event) => {
    if (muted.includes(event.kind)) return;
    events.push(event);
  };

  // Harmony first: one pad segment per chord entry, ending where the next starts.
  bar.chords.forEach((chord, index) => {
    const nextStep = index + 1 < bar.chords.length ? bar.chords[index + 1].step : 16;
    const dur = (nextStep - chord.step) * s - SEGMENT_GAP_S;
    if (dur < MIN_SEGMENT_S) return;
    push({
      kind: "pad", time: barTime + chord.step * s, dur,
      voicing: chord.voicing, step: chord.step,
      label: chord.label, quality: chord.quality, devices: chord.devices,
    });
  });

  // The pedal: one note for the whole bar, in its own register (see REGISTER.drone).
  if (typeof bar.drone === "number") {
    push({ kind: "drone", time: barTime, dur: s * 16 - SEGMENT_GAP_S, midi: bar.drone, step: 0 });
  }

  for (const note of bar.bass) {
    push({
      kind: "bass", time: barTime + note.step * s, dur: note.dur * s,
      midi: note.midi, vel: note.vel, step: note.step,
    });
  }

  for (const note of bar.lead) {
    push({
      kind: "lead", time: barTime + note.step * s, dur: note.dur * s,
      midi: note.midi, vel: note.vel, step: note.step,
    });
  }

  for (const hit of bar.drums) {
    push({ kind: "drum", time: barTime + hit.step * s, hit: hit.hit, vel: hit.vel, step: hit.step });
  }

  events.sort((a, b) => a.time - b.time || ORDER[a.kind] - ORDER[b.kind] || a.step - b.step);
  return events;
}

/**
 * A run of bars, plus the timbre changes that belong to their downbeats.
 * Stable-sorted by time, so a caller can hand the array straight to a player.
 */
export function arrangeBars(bars, { bpm = 132, muted = [], startTime = 0 } = {}) {
  const events = [];
  const timbres = [];
  let at = startTime;
  for (const bar of bars) {
    const s = sixteenth(bar.tempo ?? bpm);
    events.push(...arrangeBar(bar, at, { muted }));
    timbres.push({ at, value: bar.timbre });
    at += s * 16;
  }
  events.sort((a, b) => a.time - b.time || ORDER[a.kind] - ORDER[b.kind] || a.step - b.step);
  return { events, timbres, duration: at - startTime };
}

/** Play one event through a voices object. The only place that mapping lives. */
export function playEvent(voices, event) {
  if (event.kind === "drum") voices.play.drum(event.hit, event.time, event.vel);
  else if (event.kind === "bass") voices.play.bass(event.midi, event.time, event.dur, event.vel);
  else if (event.kind === "pad") voices.play.pad(event.voicing, event.time, event.dur);
  else if (event.kind === "drone") voices.play.drone(event.midi, event.time, event.dur);
  else if (event.kind === "lead") voices.play.lead(event.midi, event.time, event.dur, event.vel);
  else throw new Error(`unknown event kind: ${event.kind}`);
}
