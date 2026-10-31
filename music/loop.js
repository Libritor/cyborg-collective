// The caller the scheduler deliberately does not contain: a timer, the audio
// clock, and the mapping from events to voices.
//
// Two layers, because only the second one needs a browser:
//   createEngine() -- pure. It owns the scheduler state and turns each bar the
//                     clock announces into timed events. Node can drive it and
//                     assert on the whole schedule.
//   createLoop()   -- the glue. AudioContext, one timer, visibility handling,
//                     a master fade. It presses play on an engine; it makes no
//                     musical decisions.
//
// pump() stops being the source of drum events here. It still owns the clock and
// the bar boundaries, but a bar is arranged whole (arrange.js) once its downbeat
// is known, which is the only way the pad can play a `sus` resolution mid-bar.
// Playing pump's per-sixteenth drums as well would double every hit.

import { createScheduler, pump, sixteenth, TICK_MS } from "./scheduler.js";
import { createVoices } from "./voices.js";
import { arrangeBar, playEvent } from "./arrange.js";

// Enough lead for a 25ms timer to be late and still not schedule in the past.
export const LIVE_LEAD_S = 0.06;
const FADE_S = 0.08;

export function createEngine({ pullBar, bpm = 132, muted = [], startTime = 0 }) {
  const state = createScheduler({ tempo: bpm, startTime });

  return {
    state,

    /** Every event to schedule now: whole bars, plus the bar payload for the UI. */
    tick(now) {
      const pulled = new Map();
      const { events } = pump(state, now, {
        pullBar: (index) => {
          const bar = pullBar(index);
          pulled.set(index, bar);
          return bar;
        },
      });

      const out = [];
      for (const event of events) {
        if (event.kind !== "bar") continue;
        const bar = pulled.get(event.bar);
        if (!bar) continue;
        out.push({ kind: "bar", bar: event.bar, time: event.time, tempo: event.tempo, data: bar });
        for (const arranged of arrangeBar(bar, event.time, { muted })) {
          out.push({ ...arranged, bar: event.bar });
        }
      }
      return out;
    },

    /**
     * Catch the grid up after the clock was not being polled (a hidden tab, a
     * suspended context). Without this the scheduler wakes to a nextNoteTime far
     * in the past and pours a burst of events into a single instant.
     *
     * The grid phase is preserved by skipping whole sixteenths, so a bar boundary
     * still lands on a downbeat; the bars that went by in the meantime are simply
     * not played.
     */
    reanchor(now, lead = LIVE_LEAD_S) {
      const s = sixteenth(state.tempo);
      if (!(state.nextNoteTime < now + lead)) return 0;
      const steps = Math.ceil((now + lead - state.nextNoteTime) / s);
      state.nextNoteTime += steps * s;
      state.current16th = (state.current16th + steps) % 16;
      return steps;
    },
  };
}

/**
 * The live loop. `kit` is the result of renderKit() at this context's sample
 * rate -- prerendering does not need a user gesture, only resume() does, so the
 * page renders at load and only the context stays suspended until `play()`.
 */
export function createLoop({
  ctx, kit, pullBar, bpm = 132, muted = [], onBar = null, onEvent = null, onError = null,
}) {
  const voices = createVoices(ctx, kit, { bpm });
  const level = voices.master.gain.value;

  let engine = null;
  let timer = null;
  let playing = false;
  let current = level;

  function tick() {
    if (!engine) return;
    const now = ctx.currentTime;
    for (const event of engine.tick(now)) {
      if (event.kind === "bar") {
        voices.setTimbre(event.data.timbre, event.time);
        if (onBar) onBar(event);
        continue;
      }
      try {
        playEvent(voices, event);
      } catch (err) {
        if (onError) onError(err);
        else throw err;
      }
      if (onEvent) onEvent(event);
    }
  }

  function fade(to, seconds = FADE_S) {
    const now = ctx.currentTime;
    const gain = voices.master.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(current, now);
    gain.linearRampToValueAtTime(to, now + seconds);
    current = to;
  }

  function stopTimer() {
    clearInterval(timer);
    timer = null;
  }

  return {
    voices,
    get playing() { return playing; },
    get state() { return engine ? engine.state : null; },

    /** Must be called from a user gesture the first time: only resume() needs one. */
    async play() {
      if (playing) return;
      await ctx.resume();
      // A fresh scheduler every start: nextNoteTime on the live clock, and a
      // downbeat that is actually ahead of us.
      engine = createEngine({
        pullBar, bpm, muted, startTime: ctx.currentTime + LIVE_LEAD_S,
      });
      playing = true;
      fade(level, 0.05);
      stopTimer();
      timer = setInterval(tick, TICK_MS);
      tick();
    },

    stop() {
      playing = false;
      stopTimer();
      fade(0);
    },

    /** A hidden tab throttles timers to about 1 Hz; the context goes quiet with it. */
    async suspend() {
      stopTimer();
      if (ctx.state === "running") await ctx.suspend();
    },

    async resume() {
      if (!playing) return;
      await ctx.resume();
      // The context's clock did not stop while suspended in every browser, so a
      // reanchor is not optional here.
      if (engine) engine.reanchor(ctx.currentTime);
      stopTimer();
      timer = setInterval(tick, TICK_MS);
      tick();
    },
  };
}
