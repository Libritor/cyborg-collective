// The lookahead scheduler. Pure: it reads no clock, owns no timer, touches no
// WebAudio. The caller (a step-5 loop) supplies `now` and pulls bars; this
// module only decides *what happens when* and hands back events with an
// absolute `time` on the audio hardware clock.
//
// Two clocks, because JavaScript timers are allowed to be late: the timer wakes
// up every TICK_MS and schedules everything that falls inside LOOKAHEAD_S of
// now. The event time therefore comes from the audio clock, never from the
// moment the timer happened to fire, which is the whole point -- a 20ms timer
// wobble must not become a 20ms piece of groove.

export const LOOKAHEAD_S = 0.120;   // safety window; wider than any timer jitter
export const TICK_MS = 25;

const STEPS_PER_BAR = 16;

/** Seconds per 16th at this tempo. */
export function sixteenth(tempo) {
  return 60 / tempo / 4;
}

export function createScheduler({ tempo = 132, startTime = 0 } = {}) {
  return {
    tempo,
    nextNoteTime: startTime,
    current16th: 0,
    barIndex: 0,
    bar: null,
    pending: [],
  };
}

/**
 * Emit every event whose time falls before `now + horizon`.
 *
 * Bar boundaries are emitted as `{kind: "bar"}` events, because a chord change
 * and a tempo poll both belong to the downbeat, and a player that only saw drum
 * hits would have to guess where the bar started.
 *
 * Tempo is polled at the downbeat only, so a bar keeps one grid for its sixteen
 * steps even when the next bar runs at a different tempo. A mid-measure tempo
 * change would warp the bar and is exactly the bug this shape prevents.
 */
export function pump(state, now, { pullBar, horizon = LOOKAHEAD_S }) {
  const events = [];
  for (;;) {
    if (state.nextNoteTime >= now + horizon) break;

    if (state.current16th === 0) {
      state.bar = pullBar(state.barIndex);
      state.barIndex += 1;
      state.tempo = state.bar.tempo ?? state.tempo;
      events.push({
        bar: state.barIndex - 1,
        kind: "bar",
        time: state.nextNoteTime,
        tempo: state.tempo,
      });
      for (const hit of state.bar.drums) {
        state.pending.push({ ...hit, bar: state.barIndex - 1 });
      }
    }

    for (const hit of state.pending) {
      if (hit.step !== state.current16th) continue;
      events.push({
        bar: hit.bar,
        step: hit.step,
        hit: hit.hit,
        vel: hit.vel,
        time: state.nextNoteTime,
      });
    }
    state.pending = state.pending.filter((h) => h.step !== state.current16th);

    state.nextNoteTime += sixteenth(state.tempo);
    state.current16th = (state.current16th + 1) % STEPS_PER_BAR;
  }
  return { state, events };
}
