// Brain waves leaving the 6ense mark while the band plays.
//
// One ring per beat, one band per ring (delta, theta, alpha, beta, gamma, in the
// colours the cards use for their band bars). A ring is a circle with that
// band's ripple wrapped around it: slower bands ripple long, faster bands short,
// and a ripple stands taller the more of the power its band holds in whatever
// the band is playing from (the heads sharing live, or the record session the
// day's piece is generated from). Everything swells with the level of the sound.
// It is a picture of the bands, not a plot of anyone's samples.
//
// The canvas sits behind the page (z-index -1) and takes no pointer events. It
// draws only while there is something to draw, and not at all for a visitor who
// asked their system for less motion.

import { BANDS, rippleHeight } from "./hearing.js";

const SPEED = 170;          // px a ring travels per second
const FIRST_R = 8;          // px, the radius a ring is born with
const BELOW_NAV = 70;       // px of canvas under the menu, faded out by the stylesheet
const LATE_S = 0.4;         // a beat this far in the past is not drawn (a tab that was hidden)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function createWaves({ audio, tap = null, mark = null } = {}) {
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const state = { running: false, reduced, rings: 0, emitted: 0, level: 0, shares: null };
  if (!mark || typeof document === "undefined") {
    return { state, start() {}, stop() {}, bar() {}, setShares() {} };
  }

  const canvas = document.createElement("canvas");
  canvas.id = "waves";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const g = canvas.getContext("2d");

  // the level of what is actually sounding, read off the master fader
  let analyser = null;
  let samples = null;
  if (tap && audio && typeof audio.createAnalyser === "function") {
    analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    tap.connect(analyser);
    samples = new Float32Array(analyser.fftSize);
  }

  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, rMax = 1;
  function layout() {
    const nav = document.querySelector("nav");
    const navBottom = nav ? nav.getBoundingClientRect().bottom + window.scrollY : 260;
    W = document.documentElement.clientWidth;
    H = Math.round(navBottom + BELOW_NAV);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.height = `${H}px`;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const m = mark.getBoundingClientRect();
    cx = m.left + window.scrollX + m.width / 2;
    cy = m.top + window.scrollY + m.height / 2;
    rMax = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
  }

  const rings = [];
  const beats = [];          // audio-clock times of the beats still to come
  let raf = 0;

  function emit(at) {
    const band = BANDS[state.emitted % BANDS.length];
    state.emitted += 1;
    rings.push({ born: at, band, height: rippleHeight(state.shares, band.key), phase: Math.random() * Math.PI * 2 });
  }

  function readLevel() {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    const target = clamp(Math.sqrt(sum / samples.length) * 3.2, 0, 1);
    state.level += (target - state.level) * (target > state.level ? 0.5 : 0.1);   // fast up, slow down
  }

  /** One ring: the two arcs of it that cross the canvas, right of the mark and left of it. */
  function drawRing(ring, t) {
    const age = (t - ring.born) / 1000;
    const r = FIRST_R + SPEED * age;
    if (r > rMax) return false;
    const fade = Math.pow(1 - r / rMax, 1.35) * Math.min(1, age / 0.2);
    const height = ring.height * Math.min(1, r / 70) * (0.7 + 0.9 * state.level);
    const lambda = ring.band.wavelength;
    const lo = Math.asin(clamp((0 - height - cy) / r, -1, 1));
    const hi = Math.asin(clamp((H + height - cy) / r, -1, 1));
    const step = Math.max(1.5, lambda / 9) / r;                 // radians between points
    g.globalAlpha = (dark && dark.matches ? 0.8 : 0.55) * fade;   // the same colours read dimmer on a dark page
    g.strokeStyle = ring.band.color;
    g.beginPath();
    for (const side of [1, -1]) {
      let pen = false;
      for (let a = lo; a <= hi + step; a += step) {
        const angle = Math.min(a, hi);
        const around = side === 1 ? angle : Math.PI - angle;    // the angle all the way round, for one unbroken ripple
        const rr = r + height * Math.sin((2 * Math.PI * r * around) / lambda + ring.phase);
        const x = cx + side * rr * Math.cos(angle);
        const y = cy + rr * Math.sin(angle);
        if (x < -20 || x > W + 20) { pen = false; continue; }
        if (pen) g.lineTo(x * dpr, y * dpr); else g.moveTo(x * dpr, y * dpr);
        pen = true;
      }
    }
    g.stroke();
    return true;
  }

  function frame(t) {
    raf = 0;
    const now = audio.currentTime;
    while (beats.length && beats[0] <= now) {
      const at = beats.shift();
      if (state.running && now - at < LATE_S) emit(t);
    }
    readLevel();
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.lineWidth = 1.6 * dpr;
    g.lineJoin = "round";
    for (let i = rings.length - 1; i >= 0; i -= 1) {
      if (!drawRing(rings[i], t)) rings.splice(i, 1);
    }
    g.globalAlpha = 1;
    state.rings = rings.length;
    if (state.running || rings.length) raf = requestAnimationFrame(frame);
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

    /** The band started: rings leave the mark from the next beat on. */
    start() {
      state.running = true;
      mark.classList.add("sounding");
      layout();
      wake();
    },

    /** The band stopped: no new rings; the ones on their way finish and fade. */
    stop() {
      state.running = false;
      beats.length = 0;
      mark.classList.remove("sounding");
    },

    /** A bar is about to sound at `time` on the audio clock: a ring for each of its beats. */
    bar(time, tempo = 132) {
      if (!state.running || reduced) return;
      const beat = 60 / (tempo > 0 ? tempo : 132);
      for (let k = 0; k < 4; k += 1) beats.push(time + k * beat);
      wake();
    },

    /** Each band's share of the power in what is being played, or null when unknown. */
    setShares(shares) {
      state.shares = shares || null;
    },
  };
}
