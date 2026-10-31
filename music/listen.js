// The fixture page that plays: the whole band, live, from the generator.
//
// Rendering does not need a user gesture -- only AudioContext.resume() does -- so
// the context is created and the kit prerendered at load, and ▶ does nothing but
// resume. Prerendering after the click would put a 1-3 s silence under the first
// press, which is the wrong way round.

import { renderKit } from "./kit.js";
import { createGenerator, nextBar } from "./generator.js";
import { createLoop } from "./loop.js";

const el = (id) => document.getElementById(id);
const statusEl = el("status");

// What the harness reads: a page that claims to play must prove it.
window.__audio = { playing: false, bars: 0, rms: -Infinity, peak: -Infinity, errors: [], lastBar: null };

const state = { C: 0.45, bpm: 132, cruelty: 0.15 };

const ctx = new AudioContext();
let kit = null;
let loop = null;
let analyser = null;
let levelData = null;

const gen = createGenerator({ seed: 5, tonicMidi: 57, bpm: state.bpm, cruelty: state.cruelty });

/** Controls shaped for nextBar: one wizard on the page, pressure is its arousal. */
function controls() {
  return {
    C: state.C,
    alphaShare: 0.35,
    arousal: state.C,
    motion: 0.35,
    asymmetry: 0.2,
  };
}

const DEVICE_NAMES = ["sus", "cliche", "drone", "mixture", "climb", "bII"];

function renderDevices(devices, fired) {
  const host = el("devices");
  if (host.dataset.built !== "1") {
    host.innerHTML = DEVICE_NAMES.map((name) => `<span class="lamp" data-device="${name}">${name}</span>`).join("");
    host.dataset.built = "1";
  }
  for (const lamp of host.children) {
    const name = lamp.dataset.device;
    lamp.dataset.on = String(devices.includes(name));
    lamp.dataset.fired = String(fired.includes(name));
  }
}

function onBar({ data: bar, tempo }) {
  window.__audio.bars += 1;
  window.__audio.lastBar = {
    index: bar.index,
    tempo,
    family: bar.family,
    vamp: bar.vamp,
    chord: bar.chords[0] ? bar.chords[0].label : null,
    devices: bar.chords[0] ? bar.chords[0].devices : [],
    reason: bar.ui.reason,
    C: bar.ui.C,
  };

  el("bar").textContent = String(bar.index);
  el("tempo").textContent = `${Math.round(tempo)} bpm`;
  el("family").textContent = bar.family ?? (bar.vamp ? "vamp" : "transition");
  el("reason").textContent = bar.ui.reason ?? "";

  const chord = bar.chords[0];
  const chain = bar.ui.chain;
  const next = chain && chain.steps && chain.steps.length
    ? chain.steps[(chain.position ?? 0) % chain.steps.length]
    : null;
  el("chart").innerHTML = bar.vamp
    ? "vamp · root only"
    : `${chord ? chord.label : "—"}${
      chord && chord.cliche ? " <span class=\"k\">cliché</span>" : ""
    }${next ? ` <span class="next">→ ${next}</span>` : ""}`;

  renderDevices(bar.ui.devices ?? [], chord && chord.devices ? chord.devices : []);
}

function meter() {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(levelData);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < levelData.length; i += 1) {
    const v = levelData[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / levelData.length);
  window.__audio.rms = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  window.__audio.peak = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  el("meterbar").style.width = `${Math.min(100, Math.max(0, (window.__audio.rms + 60) / 60 * 100))}%`;
  requestAnimationFrame(meter);
}

function say(text) { statusEl.textContent = text; }

async function boot() {
  try {
    kit = await renderKit(ctx.sampleRate);
  } catch (err) {
    say(`prerender failed: ${err.message}`);
    window.__audio.errors.push(String(err));
    throw err;
  }

  loop = createLoop({
    ctx,
    kit,
    pullBar: () => nextBar(gen, controls()),
    bpm: state.bpm,
    muted: ["lead"],      // the plan settles this: external rig first, auto-lead muted
    onBar,
    onError: (err) => { window.__audio.errors.push(String(err)); say(`voice error: ${err.message}`); },
  });

  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  levelData = new Float32Array(analyser.fftSize);
  loop.voices.master.connect(analyser);
  requestAnimationFrame(meter);

  say(`kit ready at ${ctx.sampleRate} Hz · ${ctx.state}. press ▶`);
}

async function toggle() {
  const button = el("play");
  if (loop.playing) {
    loop.stop();
    button.textContent = "▶ listen";
    button.setAttribute("aria-pressed", "false");
    window.__audio.playing = false;
    say("stopped");
    return;
  }
  try {
    await loop.play();
  } catch (err) {
    say(`could not start audio: ${err.message}`);
    window.__audio.errors.push(String(err));
    return;
  }
  button.textContent = "■ stop";
  button.setAttribute("aria-pressed", "true");
  window.__audio.playing = true;
  say(`playing · ${ctx.sampleRate} Hz · lead muted`);
}

el("play").addEventListener("click", toggle);

el("grab").addEventListener("click", () => {
  // Two more bars of this chord: the generator advances only when barsLeft runs
  // out, so extending it is the hold. Drums and bass carry on regardless.
  gen.barsLeft = Math.max(gen.barsLeft, 2);
  say("held: this chord runs two more bars");
});

el("c").addEventListener("input", (event) => {
  state.C = Number(event.target.value);
  el("c-out").textContent = state.C.toFixed(2);
});
el("bpm").addEventListener("input", (event) => {
  state.bpm = Number(event.target.value);
  gen.bpm = state.bpm;          // the scheduler polls it at the next downbeat
  el("bpm-out").textContent = String(state.bpm);
});
el("cruelty").addEventListener("input", (event) => {
  state.cruelty = Number(event.target.value);
  gen.cruelty = state.cruelty;
  el("cruelty-out").textContent = state.cruelty.toFixed(2);
});

document.addEventListener("keydown", (event) => {
  if (event.code === "Space" && event.target === document.body) {
    event.preventDefault();
    el("grab").click();
  }
});

// A hidden tab throttles timers to ~1 Hz, which starves a 120 ms lookahead, and
// a suspended context keeps running what was already scheduled. Both are handled
// in the loop; this only reports them.
document.addEventListener("visibilitychange", () => {
  if (!loop) return;
  if (document.hidden) {
    loop.suspend();
    say(loop.playing ? "hidden: audio suspended" : "hidden");
  } else {
    loop.resume();
    say(loop.playing ? "visible: audio resumed" : "visible");
  }
});

boot();
