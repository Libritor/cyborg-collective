// Brain waves leaving the 6ense mark while the band plays, drawn the way a SWIM
// draws a wave.
//
// Steve Mann's SWIM (Sequential Wave Imprinting Machine) is a stick of lights
// swept through space: at each instant the light at the wave's height flashes,
// and the flashes stay where they were made, so the wave is seen sitting still
// in the place it belongs to. Here the stick sweeps out from the word "6ense",
// along five rays, one per band (delta, theta, alpha, beta, gamma, in the
// colours the cards use for their band bars). Every dot it leaves is one sample
// of that band, at that sample's height in microvolts, one scale for all five.
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
// inside one) and `received()` when it is still arriving.
//
// The sweep starts on a downbeat and lasts a whole number of bars. The canvas
// sits behind the page (z-index -1) and takes no pointer events. It draws only
// while there is something to draw, and not at all for a visitor who asked their
// system for less motion.

import { BANDS } from "./hearing.js?v=2";

export const PX_PER_UV = 0.9;   // on a wide page; scaled down with the window
const MAX_AMP = 22;             // px a dot may stand from its ray, on a wide page; a larger swing sits at this limit
const SWEEP_PX_S = 260;         // roughly how fast the wand travels
const FIRST_D = 4;              // px from the end of the mark to the first dot
const OVER_TEXT = 0.5;          // how much of their strength the waves keep where they pass behind the paragraph the mark is in
const BELOW_NAV = 70;           // px of canvas under the menu, faded out by the stylesheet
const MAX_FAN = (9 * Math.PI) / 180;
const LATE_S = 0.4;             // a downbeat this far in the past starts no sweep (a tab that was hidden)
const LIVE_DELAY_S = 0.4;       // how far behind the newest live sample a sweep starts, to ride out the gaps between frames
const WIPE_GAP = 44;            // px of clear page ahead of the wand
const FADE_MS = 1600;           // how long the picture takes to go when the band stops
const LEDS = 6;                 // lights on each side of the middle of the wand

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function createSwim({ audio, tap = null, mark = null } = {}) {
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const state = { running: false, reduced, source: null, sweeps: 0, dots: 0, level: 0, inked: false, pxPerUv: PX_PER_UV };
  if (!mark || typeof document === "undefined") {
    return { state, start() {}, stop() {}, bar() {}, setSource() {}, probe: () => null };
  }

  const canvas = document.createElement("canvas");
  canvas.id = "waves";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const g = canvas.getContext("2d");
  // two sheets the dots are left on: the sweep being made, and the one before it
  const sheet = () => { const c = document.createElement("canvas"); return { c, g: c.getContext("2d") }; };
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

  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, reach = 1, amp = MAX_AMP, pxPerUv = PX_PER_UV;
  let textRight = 0, core = 1, halo = 3.4;
  let rays = BANDS.map(() => ({ ux: 1, uy: 0 }));
  let shape = "";
  function layout() {
    const nav = document.querySelector("nav");
    const navBottom = nav ? nav.getBoundingClientRect().bottom + window.scrollY : 260;
    const m = mark.getBoundingClientRect();
    const para = mark.closest("p");
    const next = {
      W: document.documentElement.clientWidth, H: Math.round(navBottom + BELOW_NAV), dpr: Math.min(2, window.devicePixelRatio || 1),
      // the waves leave the end of the word, so the word itself stays readable
      cx: Math.round(m.right + window.scrollX), cy: Math.round(m.top + window.scrollY + m.height / 2),
      textRight: Math.round(para ? para.getBoundingClientRect().right + window.scrollX : 0),
    };
    // a phone fires resize whenever its address bar slides away: nothing the waves depend on has moved, so nothing is redrawn
    if (JSON.stringify(next) === shape) return;
    shape = JSON.stringify(next);
    ({ W, H, dpr, cx, cy, textRight } = next);
    canvas.style.height = `${H}px`;
    for (const c of [canvas, cur.c, old.c]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const scale = clamp(W / 1000, 0.6, 1);
    amp = MAX_AMP * scale;
    pxPerUv = PX_PER_UV * scale;
    core = 0.75 + 0.3 * scale;           // px, the radius of a dot
    halo = 2.4 + scale;                  // px, the radius of its glow
    state.pxPerUv = pxPerUv;
    reach = Math.max(60, W - cx + 12);
    // the five rays fan out to the right, as wide as the header allows
    const up = clamp(Math.atan((cy - amp - 6) / reach), 0, MAX_FAN);
    const down = clamp(Math.atan((H - BELOW_NAV * 0.5 - amp - cy) / reach), 0, MAX_FAN);
    rays = BANDS.map((_, i) => {
      const a = -up + ((up + down) * i) / (BANDS.length - 1);
      return { ux: Math.cos(a), uy: Math.sin(a) };
    });
    if (sweep) sweep.lost = true;        // the sheets were cleared: what was laid down is gone until the next sweep
  }

  /** Where a dot goes: `d` px along band i's ray, `y` px above it. */
  const place = (i, d, y) => [cx + d * rays[i].ux + y * rays[i].uy, cy + d * rays[i].uy - y * rays[i].ux];

  let source = null;         // what the next sweep reads
  let sweep = null;          // the sweep being made
  const downbeats = [];      // { time, bar } still to come, on the audio clock
  let raf = 0;
  let stoppedAt = null;      // rAF time the band stopped at, while the picture fades

  function clearAll() {
    for (const s of [cur, old]) s.g.clearRect(0, 0, s.c.width, s.c.height);
    g.clearRect(0, 0, canvas.width, canvas.height);
    sweep = null;
    state.inked = false;
    state.source = null;
  }

  function beginSweep(t0, barS) {
    const seconds = clamp(reach / SWEEP_PX_S, 3, 5);
    const dur = Math.max(1, Math.round(seconds / barS)) * barS;
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
    state.sweeps += 1;
    state.inked = true;
  }

  /** Leave the dots for every sample whose moment has come. */
  function paint(now) {
    if (!sweep || sweep.lost || !state.running) return;
    const { src } = sweep;
    const upto = Math.min(sweep.need - 1, Math.floor((now - sweep.t0) * src.fs));
    const night = dark && dark.matches;
    const sg = cur.g;
    // the glows of neighbouring dots pile up, so each one is as faint as the dots are close
    const glow = clamp((night ? 0.11 : 0.085) * (reach / sweep.need), 0.012, 0.12);
    for (let i = 0; i < BANDS.length; i += 1) {
      const key = BANDS[i].key;
      const spots = [];
      let n = sweep.painted[i] + 1;
      for (; n <= upto; n += 1) {
        const uv = src.read(key, sweep.s0 + n);
        if (uv === undefined) break;                       // a live sample that has not arrived yet
        const y = clamp(uv * pxPerUv, -amp, amp);
        spots.push(place(i, FIRST_D + (n / sweep.need) * reach, y));
        sweep.last[i] = y;
      }
      sweep.painted[i] = n - 1;
      if (!spots.length) continue;
      state.dots += spots.length;
      sg.fillStyle = BANDS[i].color;
      for (const [alpha, radius] of [[glow, halo], [night ? 0.95 : 0.85, core]]) {   // the glow, then the light itself
        sg.globalAlpha = alpha;
        sg.beginPath();
        for (const [x, y] of spots) { sg.moveTo((x + radius) * dpr, y * dpr); sg.arc(x * dpr, y * dpr, radius * dpr, 0, 2 * Math.PI); }
        sg.fill();
      }
    }
    sg.globalAlpha = 1;
  }

  function readLevel() {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    const target = clamp(Math.sqrt(sum / samples.length) * 3.2, 0, 1);
    state.level += (target - state.level) * (target > state.level ? 0.5 : 0.1);   // fast up, slow down
  }

  /** The wand: on each ray a stick of faint lights, the one at the wave's height lit, brighter with the sound. */
  function drawWand(d) {
    const night = dark && dark.matches;
    const pitch = amp / LEDS;
    for (let i = 0; i < BANDS.length; i += 1) {
      g.fillStyle = BANDS[i].color;
      g.globalAlpha = night ? 0.3 : 0.22;
      g.beginPath();
      for (let k = -LEDS; k <= LEDS; k += 1) {
        const [x, y] = place(i, d, k * pitch);
        g.moveTo((x + 0.9) * dpr, y * dpr);
        g.arc(x * dpr, y * dpr, 0.9 * dpr, 0, 2 * Math.PI);
      }
      g.fill();
      if (sweep.painted[i] < 0) continue;
      const [x, y] = place(i, d, sweep.last[i]);
      for (const [alpha, radius] of [[0.14 + 0.3 * state.level, 5 + 5 * state.level], [1, 2.3]]) {
        g.globalAlpha = alpha;
        g.beginPath();
        g.arc(x * dpr, y * dpr, radius * dpr, 0, 2 * Math.PI);
        g.fill();
      }
    }
  }

  function frame(t) {
    raf = 0;
    const now = audio.currentTime;
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
      if (fade <= 0) { clearAll(); stoppedAt = null; return; }
    }
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (state.inked) {
      const along = sweep ? clamp((now - sweep.t0) / sweep.dur, 0, 1) : 1;
      const d = FIRST_D + along * reach;
      if (sweep && state.running) {
        // the new sweep wipes the one before it, a little ahead of the wand
        const r = (d + WIPE_GAP) * dpr;
        const wipe = old.g.createRadialGradient(cx * dpr, cy * dpr, Math.max(0, r - 30 * dpr), cx * dpr, cy * dpr, r);
        wipe.addColorStop(0, "rgba(0,0,0,1)");
        wipe.addColorStop(1, "rgba(0,0,0,0)");
        old.g.globalCompositeOperation = "destination-out";
        old.g.fillStyle = wipe;
        old.g.beginPath();
        old.g.arc(cx * dpr, cy * dpr, r, 0, 2 * Math.PI);
        old.g.fill();
        old.g.globalCompositeOperation = "source-over";
      }
      const settle = sweep ? 0.5 + 0.5 * Math.exp(-(now - sweep.t0) / 0.4) : 0.5;   // the sweep before dims as the new one starts
      g.globalAlpha = fade * settle;
      g.drawImage(old.c, 0, 0);
      g.globalAlpha = fade;
      g.drawImage(cur.c, 0, 0);
      if (textRight > cx) {
        // the waves pass behind the paragraph the mark is in: there they are held back, so the words stay easy to read
        const veil = g.createLinearGradient((textRight - 40) * dpr, 0, (textRight + 140) * dpr, 0);
        veil.addColorStop(0, `rgba(0,0,0,${OVER_TEXT})`);
        veil.addColorStop(1, "rgba(0,0,0,1)");
        g.globalAlpha = 1;
        g.globalCompositeOperation = "destination-in";
        g.fillStyle = veil;
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.globalCompositeOperation = "source-over";
      }
      if (sweep && state.running && along < 1) drawWand(d);
      g.globalAlpha = 1;
    }
    if (state.running || state.inked) raf = requestAnimationFrame(frame);
  }

  function wake() {
    if (!raf && !reduced) raf = requestAnimationFrame(frame);
  }

  window.addEventListener("resize", () => { layout(); wake(); });
  if (typeof ResizeObserver === "function") {
    const header = document.querySelector("header.top");
    if (header) new ResizeObserver(() => layout()).observe(header);
  }

  return {
    state,

    /** The band started: the wand leaves the mark on the next downbeat. */
    start() {
      state.running = true;
      stoppedAt = null;
      mark.classList.add("sounding");
      layout();
      clearAll();
      wake();
    },

    /** The band stopped: no more dots; what is on the page fades. */
    stop() {
      state.running = false;
      downbeats.length = 0;
      mark.classList.remove("sounding");
      if (state.inked && !reduced) { stoppedAt = performance.now(); wake(); }
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

    /**
     * Where the dots of the sweep being made are, for a test that wants to hold the picture against the
     * samples: dot n of band i stands at place(i, FIRST_D + n / need * reach, clamp(uv * pxPerUv, -amp, amp)),
     * and reads sample first + n of the source.
     */
    probe() {
      return {
        cx, cy, dpr, reach, amp, pxPerUv, firstD: FIRST_D, rays: rays.map((r) => ({ ...r })),
        sweep: sweep && !sweep.lost
          ? { kind: sweep.src.kind, first: sweep.s0, need: sweep.need, painted: [...sweep.painted], last: [...sweep.last] }
          : null,
      };
    },
  };
}
