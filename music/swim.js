// The brain-wave panel beside the title: a chart with its axes, drawn the way a
// SWIM draws a wave.
//
// Steve Mann's SWIM (Sequential Wave Imprinting Machine) is a stick of lights
// swept through space: at each instant the light at the wave's height flashes,
// and the flashes stay where they were made, so the wave is seen sitting still
// in the place it belongs to. Here the stick sweeps across the panel from left
// to right over five lanes, one per band, the fastest at the top (gamma, beta,
// alpha, theta, delta, in the colours the cards use for their band bars), so
// frequency rises up the panel as it does up a spectrum. Every dot it leaves is one
// sample of that band. Across is time, in seconds since the wand left; up is
// microvolts from the lane's own zero line, the same scale in all five lanes
// (each lane is +-HALF_RANGE_UV tall; a larger swing sits at the lane's edge).
// The dots stay put; the next sweep lays the next stretch of the trace over
// them, wiping the old one as it goes.
//
// What the samples are is the source's business, not this file's:
//   "record"  a stored minute of the session the day's piece is made from
//             (music/eeg/, split by eegbands.js): the recording itself;
//   "live"    a sharer's raw trace as it arrives;
//   "powers"  no raw trace to draw, only band powers (hearing.js powerWaves).
// A source is { kind, fs, read(band, n) -> microvolts | undefined } with
// `length` when it is a finite stretch (it starts over between sweeps, never
// inside one), `startS` when sample 0 has a time in a recording, and
// `received()` when it is still arriving.
//
// A sweep starts on a downbeat and lasts a whole number of bars. While the band
// is silent the panel shows the first stretch of the stored minute, still. For a
// visitor who asked their system for less motion it stays that way.
//
// A browser may refuse to let a page sound before the visitor has touched it.
// Until then the wand can sweep the stored minute in silence (`preview`), timed
// on a wall clock at the band's tempo; when the sound arrives, `start` moves the
// sweeps onto the audio clock and the next one wipes what the silent wand drew.

import { BANDS } from "./hearing.js?v=3";

export const HALF_RANGE_UV = 25;   // each lane shows this many microvolts either side of its zero line
const TICK_UV = 20;                // where each lane's two ticks sit
const SWEEP_PX_S = 150;            // roughly how fast the wand travels
const LATE_S = 0.4;                // a downbeat this far in the past starts no sweep (a tab that was hidden)
const LIVE_DELAY_S = 0.4;          // how far behind the newest live sample a sweep starts, to ride out the gaps between frames
const WIPE_GAP = 34;               // px of clear panel ahead of the wand
const FADE_MS = 1600;              // how long the picture takes to go when the band stops
const LED_PITCH = 4;               // px between the lights of the wand
const STILL = 0.62;                // how bright the still picture is, against a sweep in progress
const DEFAULT_BAR_S = (4 * 60) / 132;
// the panel is dark in both themes, as a SWIM's long exposure is
const INK = { label: "#aeb7c4", dim: "#7d8794", line: "rgba(255,255,255,0.16)", grid: "rgba(255,255,255,0.07)", led: "rgba(255,255,255,0.26)" };
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function createSwim({ audio, tap = null, mark = null, panel = null } = {}) {
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const state = { running: false, preview: false, reduced, source: null, sweeps: 0, dots: 0, level: 0, inked: false, still: false, pxPerUv: 1 };
  if (!panel || typeof document === "undefined") {
    return { state, start() {}, stop() {}, bar() {}, setSource() {}, setStill() {}, preview: () => false, probe: () => null };
  }

  const canvas = document.createElement("canvas");
  canvas.id = "waves";
  canvas.setAttribute("aria-hidden", "true");
  panel.append(canvas);
  const g = canvas.getContext("2d");
  // three sheets under the wand: the axes, the sweep being made, and the sweep before it
  const sheet = () => { const c = document.createElement("canvas"); return { c, g: c.getContext("2d") }; };
  const axes = sheet();
  let cur = sheet();
  let old = sheet();

  // the level of what is actually sounding, read off the master fader
  let analyser = null;
  let samples = null;
  if (tap && audio && typeof audio.createAnalyser === "function") {
    analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    tap.connect(analyser);
    samples = new Float32Array(analyser.fftSize);
  }

  // ---------------------------------------------------------------- the chart
  let W = 0, H = 0, dpr = 1, x0 = 0, plotW = 1, top = 0, bottom = 0, laneH = 1, amp = 1, pxPerUv = 1, core = 1, halo = 3;
  let bases = BANDS.map(() => 0);
  let narrow = false;
  let shape = "";

  /** How long one sweep lasts: a whole number of bars, as near as the panel's width allows to the wand's usual pace. */
  const sweepSeconds = (barS) => Math.max(1, Math.round(clamp(plotW / SWEEP_PX_S, 1.5, 6) / barS)) * barS;
  const xOf = (n, need) => x0 + (n / need) * plotW;
  const yOf = (i, uv) => bases[i] - clamp(uv * pxPerUv, -amp, amp);

  function layout() {
    const box = canvas.getBoundingClientRect();
    const next = { W: Math.round(box.width), H: Math.round(box.height), dpr: Math.min(2, window.devicePixelRatio || 1) };
    if (!(next.W > 40 && next.H > 40)) return;
    // a phone fires resize whenever its address bar slides away: the panel has not changed, so nothing is redrawn
    if (JSON.stringify(next) === shape) return;
    shape = JSON.stringify(next);
    ({ W, H, dpr } = next);
    for (const c of [canvas, axes.c, cur.c, old.c]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    narrow = W < 460;
    x0 = narrow ? 70 : 100;
    plotW = Math.max(40, W - x0 - 14);
    top = 20;
    bottom = 34;
    laneH = (H - top - bottom) / BANDS.length;
    bases = BANDS.map((_, i) => top + laneH * (BANDS.length - 1 - i + 0.5));   // gamma's lane at the top, delta's at the bottom
    amp = laneH / 2 - 1;
    pxPerUv = amp / HALF_RANGE_UV;
    state.pxPerUv = pxPerUv;
    core = narrow ? 0.9 : 1.05;          // px, the radius of a dot
    halo = narrow ? 2.8 : 3.4;           // px, the radius of its glow
    drawAxes();
    if (state.still) drawStill();
    else redraw();                       // the sheets were cleared: lay the sweep in progress down again where it now belongs
  }

  /** After the panel changed size: the dots of the sweep in progress, laid down again on the new axes. */
  function redraw() {
    if (!sweep) return;
    const glow = glowFor(sweep.need);
    for (let i = 0; i < BANDS.length; i += 1) {
      const spots = [];
      for (let n = 0; n <= sweep.painted[i]; n += 1) {
        const uv = sweep.src.read(BANDS[i].key, sweep.s0 + n);
        if (uv === undefined) continue;
        const y = yOf(i, uv);
        spots.push([xOf(n, sweep.need), y]);
        sweep.last[i] = y;
      }
      if (spots.length) leave(cur.g, i, spots, glow);
    }
  }

  /** The axes: band names and microvolt ticks up the left, seconds along the bottom. */
  let axisSpan = { dur: 2 * DEFAULT_BAR_S, from: null };       // what the time axis shows: how long a sweep is, and where in a recording it starts
  function drawAxes() {
    const a = axes.g;
    a.setTransform(dpr, 0, 0, dpr, 0, 0);
    a.clearRect(0, 0, W, H);
    a.lineWidth = 1;
    const floor = H - bottom;

    // time: a faint line up the panel at every second, a tick and a number under it
    const step = axisSpan.dur > 7 ? 2 : 1;
    a.font = `10px ${FONT}`;
    a.textBaseline = "alphabetic";
    for (let s = 0; s <= axisSpan.dur + 1e-6; s += step) {
      const x = Math.round(x0 + (s / axisSpan.dur) * plotW) + 0.5;
      a.strokeStyle = INK.grid;
      a.beginPath(); a.moveTo(x, top); a.lineTo(x, floor); a.stroke();
      a.strokeStyle = INK.line;
      a.beginPath(); a.moveTo(x, floor); a.lineTo(x, floor + 4); a.stroke();
      a.fillStyle = INK.dim;
      a.textAlign = "center";
      a.fillText(String(s), x, floor + 15);
    }
    a.strokeStyle = INK.line;
    a.beginPath(); a.moveTo(x0 + 0.5, top); a.lineTo(x0 + 0.5, floor + 0.5); a.lineTo(x0 + plotW, floor + 0.5); a.stroke();
    a.fillStyle = INK.label;
    a.textAlign = "right";
    a.fillText("Time (s)", x0 + plotW, H - 6);
    if (axisSpan.from !== null) {
      a.fillStyle = INK.dim;
      a.textAlign = "left";
      a.fillText(narrow ? `from ${clock(axisSpan.from)}` : `0 s is ${clock(axisSpan.from)} into the recording`, x0, H - 6);
    }

    // microvolts: every lane has its own zero line and a tick at +-TICK_UV
    a.fillStyle = INK.label;
    a.textAlign = "right";
    a.fillText("µV", x0 - 8, 12);
    BANDS.forEach((band, i) => {
      const y = Math.round(bases[i]) + 0.5;
      a.strokeStyle = INK.grid;
      a.setLineDash([2, 4]);
      a.beginPath(); a.moveTo(x0, y); a.lineTo(x0 + plotW, y); a.stroke();
      a.setLineDash([]);
      a.strokeStyle = INK.line;
      a.fillStyle = INK.dim;
      a.font = `9px ${FONT}`;
      a.textAlign = "right";
      a.textBaseline = "middle";
      for (const uv of [TICK_UV, -TICK_UV]) {
        const ty = Math.round(bases[i] - uv * pxPerUv) + 0.5;
        a.beginPath(); a.moveTo(x0 - 4, ty); a.lineTo(x0, ty); a.stroke();
        a.fillText(uv > 0 ? `+${uv}` : `−${-uv}`, x0 - 7, ty);
      }
      a.textAlign = "left";
      a.fillStyle = band.color;
      a.font = `600 ${narrow ? 11 : 12}px ${FONT}`;
      a.fillText(band.key, narrow ? 8 : 12, narrow ? bases[i] : bases[i] - 6);
      if (!narrow) {
        a.fillStyle = INK.dim;
        a.font = `9px ${FONT}`;
        a.fillText(`${band.lo}–${band.hi} Hz`, 12, bases[i] + 7);
      }
      a.textBaseline = "alphabetic";
      a.font = `10px ${FONT}`;
    });
    a.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Leave dots on a sheet: `spots` are [x, y] in panel pixels, for band i. */
  function leave(sg, i, spots, glow) {
    sg.fillStyle = BANDS[i].color;
    for (const [alpha, radius] of [[glow, halo], [0.95, core]]) {   // the glow, then the light itself
      sg.globalAlpha = alpha;
      sg.beginPath();
      for (const [x, y] of spots) { sg.moveTo((x + radius) * dpr, y * dpr); sg.arc(x * dpr, y * dpr, radius * dpr, 0, 2 * Math.PI); }
      sg.fill();
    }
    sg.globalAlpha = 1;
  }
  // the glows of neighbouring dots pile up, so each one is as faint as the dots are close
  const glowFor = (need) => clamp(0.11 * (plotW / need), 0.012, 0.12);

  // ---------------------------------------------------------------- still
  let stillSource = null;     // what the panel shows while the band is silent
  function drawStill() {
    for (const s of [cur, old]) s.g.clearRect(0, 0, s.c.width, s.c.height);
    const src = stillSource;
    const dur = sweepSeconds(DEFAULT_BAR_S);                    // as long a stretch as one sweep will lay down
    if (!src || !Number.isFinite(src.length)) {
      axisSpan = { dur, from: null };
      drawAxes();
      state.still = false;
      compose(0);
      return;
    }
    const need = Math.min(src.length, Math.round(dur * src.fs));
    axisSpan = { dur: need / src.fs, from: Number.isFinite(src.startS) ? src.startS : null };
    drawAxes();
    BANDS.forEach((band, i) => {
      const spots = [];
      for (let n = 0; n < need; n += 1) {
        const uv = src.read(band.key, n);
        if (uv !== undefined) spots.push([xOf(n, need), yOf(i, uv)]);
      }
      leave(cur.g, i, spots, glowFor(need));
    });
    state.still = true;
    compose(0);
  }

  // ---------------------------------------------------------------- sweeps
  let source = null;         // what the next sweep reads
  let sweep = null;          // the sweep being made
  const downbeats = [];      // { time, bar } still to come, on the audio clock
  let raf = 0;
  let stoppedAt = null;      // rAF time the band stopped at, while the picture fades
  let nowS = () => audio.currentTime;   // the clock sweeps are timed on: the audio clock, or a wall clock while the wand previews in silence
  let previewing = null;     // { bar, next }: downbeats made up at the band's tempo while there is no sound to follow

  /** The still picture becomes the sweep before the first: the wand draws over it and wipes it as it goes. */
  function stillBecomesOld() {
    [cur, old] = [old, cur];
    cur.g.clearRect(0, 0, cur.c.width, cur.c.height);
    sweep = null;
    state.still = false;
    state.inked = true;
  }

  function clearDots() {
    for (const s of [cur, old]) s.g.clearRect(0, 0, s.c.width, s.c.height);
    sweep = null;
    state.inked = false;
    state.still = false;
    state.source = null;
  }

  function beginSweep(t0, barS) {
    const dur = sweepSeconds(barS);
    const src = source;
    [cur, old] = [old, cur];
    cur.g.clearRect(0, 0, cur.c.width, cur.c.height);
    sweep = null;
    state.source = src ? src.kind : null;
    if (!src) return;
    const need = Math.round(dur * src.fs);
    let s0;
    if (typeof src.received === "function") {
      s0 = Math.max(0, src.received() - Math.round(LIVE_DELAY_S * src.fs));
    } else {
      s0 = src.cursor || 0;
      if (Number.isFinite(src.length) && s0 + need > src.length) s0 = 0;     // a stored stretch starts over between sweeps
      src.cursor = s0 + need;
    }
    sweep = { t0, dur, src, s0, need, painted: BANDS.map(() => -1), last: BANDS.map(() => 0), lost: false };
    axisSpan = { dur, from: Number.isFinite(src.startS) ? src.startS + s0 / src.fs : null };
    drawAxes();
    state.sweeps += 1;
    state.inked = true;
  }

  /** Leave the dots for every sample whose moment has come. */
  function paint(now) {
    if (!sweep || sweep.lost || !state.running) return;
    const { src } = sweep;
    const upto = Math.min(sweep.need - 1, Math.floor((now - sweep.t0) * src.fs));
    const glow = glowFor(sweep.need);
    for (let i = 0; i < BANDS.length; i += 1) {
      const key = BANDS[i].key;
      const spots = [];
      let n = sweep.painted[i] + 1;
      for (; n <= upto; n += 1) {
        const uv = src.read(key, sweep.s0 + n);
        if (uv === undefined) break;                       // a live sample that has not arrived yet
        const y = yOf(i, uv);
        spots.push([xOf(n, sweep.need), y]);
        sweep.last[i] = y;
      }
      sweep.painted[i] = n - 1;
      if (!spots.length) continue;
      state.dots += spots.length;
      leave(cur.g, i, spots, glow);
    }
  }

  function readLevel() {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    const target = clamp(Math.sqrt(sum / samples.length) * 3.2, 0, 1);
    state.level += (target - state.level) * (target > state.level ? 0.5 : 0.1);   // fast up, slow down
  }

  /** The wand: one stick of faint lights the height of the chart; in each lane the light at the wave's height is lit, brighter with the sound. */
  function drawWand(x) {
    g.fillStyle = INK.led;
    g.beginPath();
    for (let y = top + 2; y <= H - bottom - 2; y += LED_PITCH) {
      g.moveTo((x + 0.9) * dpr, y * dpr);
      g.arc(x * dpr, y * dpr, 0.9 * dpr, 0, 2 * Math.PI);
    }
    g.fill();
    for (let i = 0; i < BANDS.length; i += 1) {
      if (sweep.painted[i] < 0) continue;
      g.fillStyle = BANDS[i].color;
      for (const [alpha, radius] of [[0.16 + 0.34 * state.level, 5 + 5 * state.level], [1, 2.3]]) {
        g.globalAlpha = alpha;
        g.beginPath();
        g.arc(x * dpr, sweep.last[i] * dpr, radius * dpr, 0, 2 * Math.PI);
        g.fill();
      }
    }
    g.globalAlpha = 1;
  }

  /** Put the sheets together: axes, the sweep before, the sweep being made, the wand. */
  function compose(now, fade = 1) {
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.globalAlpha = 1;
    g.drawImage(axes.c, 0, 0);
    if (state.still) {
      g.globalAlpha = STILL;
      g.drawImage(cur.c, 0, 0);
      g.globalAlpha = 1;
      return;
    }
    if (!state.inked) return;
    const along = sweep ? clamp((now - sweep.t0) / sweep.dur, 0, 1) : 1;
    const x = x0 + along * plotW;
    if (sweep && state.running) {
      // the new sweep wipes the one before it, a little ahead of the wand
      const edge = (x + WIPE_GAP) * dpr;
      const wipe = old.g.createLinearGradient(edge - 24 * dpr, 0, edge, 0);
      wipe.addColorStop(0, "rgba(0,0,0,1)");
      wipe.addColorStop(1, "rgba(0,0,0,0)");
      old.g.globalCompositeOperation = "destination-out";
      old.g.fillStyle = wipe;
      old.g.fillRect(0, 0, edge, old.c.height);
      old.g.globalCompositeOperation = "source-over";
    }
    const settle = sweep ? 0.5 + 0.5 * Math.exp(-(now - sweep.t0) / 0.4) : 0.5;   // the sweep before dims as the new one starts
    g.globalAlpha = fade * settle;
    g.drawImage(old.c, 0, 0);
    g.globalAlpha = fade;
    g.drawImage(cur.c, 0, 0);
    g.globalAlpha = 1;
    if (sweep && state.running && along < 1) drawWand(x);
  }

  function frame(t) {
    raf = 0;
    const now = nowS();
    if (previewing) {
      while (previewing.next <= now + 0.05) { downbeats.push({ time: previewing.next, bar: previewing.bar }); previewing.next += previewing.bar; }
    }
    while (downbeats.length && downbeats[0].time <= now) {
      const beat = downbeats.shift();
      if (!state.running || now - beat.time > LATE_S) continue;
      if (!sweep || beat.time >= sweep.t0 + sweep.dur - 0.02) beginSweep(beat.time, beat.bar);
    }
    readLevel();
    paint(now);

    let fade = 1;
    if (stoppedAt !== null) {
      fade = 1 - (t - stoppedAt) / FADE_MS;
      if (fade <= 0) {
        // the band is silent again: back to the still picture
        stoppedAt = null;
        clearDots();
        drawStill();
        return;
      }
    }
    compose(now, fade);
    if (state.running || (state.inked && stoppedAt !== null)) raf = requestAnimationFrame(frame);
  }

  function wake() {
    if (!raf && !reduced) raf = requestAnimationFrame(frame);
  }

  window.addEventListener("resize", () => { layout(); wake(); });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => layout()).observe(panel);
  layout();

  return {
    state,

    /** The band started: the wand leaves the left edge on the next downbeat. */
    start() {
      const wasPreview = state.preview;
      if (wasPreview) {
        // the sound has arrived: from here the sweeps follow the audio clock, and the next one wipes what the silent wand drew
        nowS = () => audio.currentTime;
        previewing = null;
        state.preview = false;
        downbeats.length = 0;
        sweep = null;
      }
      state.running = true;
      stoppedAt = null;
      if (mark) mark.classList.add("sounding");
      panel.classList.add("sounding");
      layout();
      if (reduced) return;               // the still picture stays
      if (state.still) stillBecomesOld();
      else if (!wasPreview) clearDots();
      compose(0);
      wake();
    },

    /**
     * No sound yet, because the browser wants the visitor to touch the page first: the wand sweeps `source` (a
     * stored stretch) in silence, at the band's tempo. False when it does not (less motion asked for, already
     * running, nothing to draw).
     */
    preview({ source: stored = null, tempo = 132 } = {}) {
      if (reduced || state.running || !stored) return false;
      const t0 = performance.now() / 1000;
      nowS = () => performance.now() / 1000 - t0;
      previewing = { bar: (4 * 60) / (tempo > 0 ? tempo : 132), next: 0.1 };
      source = stored;
      state.running = true;
      state.preview = true;
      stoppedAt = null;
      layout();
      if (state.still) stillBecomesOld(); else clearDots();
      compose(0);
      wake();
      return true;
    },

    /** The band stopped: no more dots; the sweep fades and the still picture comes back. */
    stop() {
      state.running = false;
      state.preview = false;
      previewing = null;
      nowS = () => audio.currentTime;
      downbeats.length = 0;
      if (mark) mark.classList.remove("sounding");
      panel.classList.remove("sounding");
      if (reduced) return;
      if (state.inked) { stoppedAt = performance.now(); wake(); } else { clearDots(); drawStill(); }
    },

    /** A bar is about to sound at `time` on the audio clock: a sweep may start on its downbeat. */
    bar(time, tempo = 132) {
      if (!state.running || reduced) return;
      downbeats.push({ time, bar: (4 * 60) / (tempo > 0 ? tempo : 132) });
      wake();
    },

    /** What the next sweep is drawn from (see the top of this file), or null for nothing. */
    setSource(next) {
      source = next || null;
    },

    /** What the panel shows, still, while the band is silent: the first stretch of a stored source, or nothing but the axes. */
    setStill(next) {
      stillSource = next || null;
      if (!state.running || reduced) { layout(); drawStill(); }
    },

    /**
     * Where the dots are, for a test that wants to hold the picture against the samples: dot n of band i stands at
     * x = x0 + n / need * plotW, y = bases[i] - clamp(uv * pxPerUv, -amp, amp), and reads sample first + n.
     * `still` is true while the panel shows the still picture (first = 0, every dot of `need` laid down).
     */
    probe() {
      const stillNeed = stillSource && Number.isFinite(stillSource.length) ? Math.min(stillSource.length, Math.round(axisSpan.dur * stillSource.fs)) : 0;
      return {
        x0, plotW, bases: [...bases], amp, pxPerUv, dpr, W, H, still: state.still,
        sweep: state.still
          ? { kind: stillSource.kind, first: 0, need: stillNeed, painted: BANDS.map(() => stillNeed - 1), last: BANDS.map(() => 0) }
          : (sweep && !sweep.lost
            ? { kind: sweep.src.kind, first: sweep.s0, need: sweep.need, painted: [...sweep.painted], last: [...sweep.last] }
            : null),
      };
    },
  };
}
