// The page that plays the band, in three modes:
//
//   (default)  live   -- a solo wizard on this page drives the four voices; the
//                        C slider is that wizard.
//   ?relay=URL        -- the band follows the sharers the relay admits.
//   ?idle=STAMP       -- a catalogue row seeds a deterministic piece, and the page
//                        says plainly that it is generated from the summary.
//
// Rendering needs no user gesture. Only resume() does, so the context is created
// and the kit prerendered at load: prerendering after the click would put a 1-3 s
// silence under the first press.

import { renderKit } from "./kit.js";
import { createGenerator, nextBar, aggregate } from "./generator.js";
import { createVoices } from "./voices.js";
import { createLoop } from "./loop.js";
import { playEvent } from "./arrange.js";
import { createUI } from "./ui.js";
import { createRelay, DEFAULT_RELAY } from "./relay.js";
import { createIdle, encodeWav } from "./idle.js";

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// What the harness reads: a page that claims to play must prove it.
window.__audio = {
  mode: "live", playing: false, bars: 0, rms: -Infinity, peak: -Infinity,
  errors: [], lastBar: null, cast: [], roles: {}, relayState: null, wav: null,
};

const state = { C: 0.45, bpm: 132, cruelty: 0.15 };

const ctx = new AudioContext();
const ui = createUI({ root: el("mount"), onGrab: () => grab() });

let kit = null;
let loop = null;
let analyser = null;
let levelData = null;
let idle = null;
let relay = null;
let gen = null;
let castKey = "";        // the panel's own key: refused heads never reach onSharers
let castAt = 0;

const idleStamp = params.get("idle");
const relayUrl = params.get("relay");

/** The solo wizard on this page: pressure is its arousal, and nothing else votes. */
function soloControls() {
  return { C: state.C, alphaShare: 0.35, arousal: state.C, motion: 0.35, asymmetry: 0.2 };
}

/**
 * What the bar generator is told before each bar. In relay mode the sharers vote;
 * with nobody admitted that is the vamp, which is the generator's own answer to an
 * empty room rather than a fallback invented here.
 */
function currentControls() {
  if (!relay) return soloControls();
  const at = Date.now() / 1000;
  return aggregate(relay.sharers(at), at);
}

function pullBar(index) {
  if (idle) return idle.pullBar(index % idle.bars);
  return nextBar(gen, currentControls());
}

function grab() {
  if (!gen) return;
  // Two more bars of this chord: the generator advances only when barsLeft runs
  // out, so extending it is the hold. Drums and bass carry on regardless.
  gen.barsLeft = Math.max(gen.barsLeft, 2);
  say("held: this chord runs two more bars");
}

function say(text) { ui.status(text); el("status").textContent = text; }

function onBar(event) {
  window.__audio.bars += 1;
  const bar = event.data;
  window.__audio.lastBar = {
    index: bar.index, tempo: event.tempo, family: bar.family, vamp: bar.vamp,
    chord: bar.chords[0] ? bar.chords[0].label : null,
    devices: bar.chords[0] ? bar.chords[0].devices : [],
    reason: bar.ui.reason, C: bar.ui.C, armed: !!(bar.ui.chain && bar.ui.chain.armed),
  };
  ui.bar(event);
  if (relay) renderCast();
}

function onEvent() {
  // Nothing to draw per note: the chain view is a bar-resolution instrument, and
  // redrawing per drum hit would be 20 layout passes a bar for no information.
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
  ui.setLevel(window.__audio.rms, window.__audio.peak);
  el("meterbar").style.width = `${Math.min(100, Math.max(0, (window.__audio.rms + 60) / 60 * 100))}%`;
  if (relay && performance.now() - castAt > 400) {
    castAt = performance.now();
    renderCast();
  }
  requestAnimationFrame(meter);
}

// ------------------------------------------------------------------- the cast

function renderCast() {
  const host = el("cast");
  const rows = relay.all();
  const roles = relay.roles();
  const byPseudonym = new Map();
  for (const [role, pseudonym] of Object.entries(roles)) {
    if (!pseudonym) continue;
    if (!byPseudonym.has(pseudonym)) byPseudonym.set(pseudonym, []);
    byPseudonym.get(pseudonym).push(role);
  }

  window.__audio.cast = rows.map((r) => ({
    pseudonym: r.pseudonym, name: r.name, label: r.label,
    admitted: r.admitted, playable: r.playable, stale: r.stale, age: r.age,
    roles: byPseudonym.get(r.pseudonym) ?? [],
  }));
  window.__audio.roles = roles;

  // onSharers only fires when the *admitted* cast changes, so a head that is
  // refused never reaches it. That is the one head the panel must show -- it is
  // how "not opened to the music" becomes visible -- so the panel keeps its own
  // key and the caller polls it.
  const key = rows.map((r) => `${r.pseudonym}:${r.admitted}:${r.stale}:${(byPseudonym.get(r.pseudonym) ?? []).join("+")}`).join("|");
  if (key === castKey) return;
  castKey = key;

  host.hidden = rows.length === 0;
  host.replaceChildren(...rows.map((r) => {
    const row = document.createElement("div");
    row.className = "wizard";
    row.dataset.stale = String(r.stale === true);
    row.dataset.pseudonym = r.pseudonym;

    const who = document.createElement("span");
    who.className = "who";
    who.textContent = r.name || r.pseudonym;
    row.appendChild(who);

    for (const role of byPseudonym.get(r.pseudonym) ?? []) {
      const tag = document.createElement("span");
      tag.className = "role";
      tag.textContent = role;
      row.appendChild(tag);
    }
    if (!r.admitted) {
      const refused = document.createElement("span");
      refused.className = "refused";
      refused.textContent = r.label;
      row.appendChild(refused);
    }
    if (r.stale) {
      const stale = document.createElement("span");
      stale.className = "refused";
      stale.textContent = "stale";
      row.appendChild(stale);
    }
    return row;
  }));
}

// ------------------------------------------------------------------ wav export

/**
 * Render the idle score to a WAV. The score is what is deterministic: two renders
 * of the same events are not bit-identical in this engine (measured ~4e-9 on one
 * fixed buffer, more on a full mix), so the hash a caller can rely on is the
 * score's, and the bytes are reported, not promised.
 */
async function exportWav() {
  if (!idle) return null;
  const seconds = idle.score.duration + 2.6;
  const offline = new OfflineAudioContext(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const voices = createVoices(offline, kit, { bpm: idle.bpm });
  for (const { at, value } of idle.score.timbres) voices.setTimbre(value, at);
  for (const event of idle.score.events) playEvent(voices, event);
  const rendered = await offline.startRendering();
  const bytes = encodeWav([rendered.getChannelData(0)], ctx.sampleRate);
  const summary = { bytes: bytes.length, frames: rendered.length, scoreHash: idle.hash(), stamp: idleStamp };
  window.__audio.wav = summary;

  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `margoth-${params.get("idle") || "idle"}.wav`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  say(`exported ${summary.frames} frames · score ${summary.scoreHash}`);
  return summary;
}

// ----------------------------------------------------------------------- boot

async function boot() {
  try {
    kit = await renderKit(ctx.sampleRate);
  } catch (err) {
    say(`prerender failed: ${err.message}`);
    window.__audio.errors.push(String(err));
    throw err;
  }

  if (idleStamp) {
    window.__audio.mode = "idle";
    idle = createIdle({ stamp: idleStamp, summary: await catalogRow(idleStamp), bars: 8, bpm: state.bpm });
    state.bpm = idle.bpm;
    el("bpm").value = String(idle.bpm);
    el("bpm-out").textContent = String(idle.bpm);
    const label = el("label");
    label.hidden = false;
    label.textContent = idle.label;      // the honesty sentence, shown verbatim
    el("export").hidden = false;
    document.title = `MarGoth — ${idleStamp}`;
    say(`idle piece for ${idleStamp} · generated, not replayed`);
  } else {
    gen = createGenerator({ seed: 5, tonicMidi: 57, bpm: state.bpm, cruelty: state.cruelty });
  }

  if (relayUrl) {
    window.__audio.mode = "relay";
    relay = createRelay({
      url: relayUrl === "1" ? DEFAULT_RELAY : relayUrl,
      allow: (params.get("allow") || "").split(",").map((s) => s.trim()).filter(Boolean),
      onSharers: () => renderCast(),
      onLeave: (pseudonym, why) => { renderCast(); say(`${pseudonym} left: ${why}`); },
      onStale: (pseudonym) => { renderCast(); say(`${pseudonym} went quiet: the band hands over`); },
      onStatus: ({ state: relayState, url }) => {
        window.__audio.relayState = relayState;
        say(`relay ${relayState} · ${url}`);
      },
    });
    renderCast();
  }

  loop = createLoop({
    ctx, kit,
    pullBar,
    bpm: state.bpm,
    muted: ["lead"],      // the plan settles this: external rig first, auto-lead muted
    onBar,
    onEvent,
    onError: (err) => { window.__audio.errors.push(String(err)); say(`voice error: ${err.message}`); },
  });

  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  levelData = new Float32Array(analyser.fftSize);
  loop.voices.master.connect(analyser);
  requestAnimationFrame(meter);

  say(`kit ready at ${ctx.sampleRate} Hz · ${ctx.state}. press ▶`);
}

/** The catalogue row for a stamp, if this page is served next to the record. */
async function catalogRow(stamp) {
  try {
    const response = await fetch("../data/index.json", { cache: "no-store" });
    if (!response.ok) return {};
    const index = await response.json();
    const rows = Array.isArray(index) ? index : (index.sessions || index.rows || []);
    return rows.find((row) => row && (row.stamp === stamp || row.id === stamp)) || {};
  } catch {
    return {};      // no record beside the page is not an error: it just seeds less
  }
}

// ------------------------------------------------------------------ transport

async function toggle() {
  const button = el("play");
  if (loop.playing) {
    loop.stop();
    button.textContent = "▶ listen";
    button.setAttribute("aria-pressed", "false");
    window.__audio.playing = false;
    ui.setPlaying(false);
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
  ui.setPlaying(true);
  say(`playing · ${ctx.sampleRate} Hz · lead muted`);
}

el("play").addEventListener("click", toggle);
el("export").addEventListener("click", () => { exportWav(); });

el("c").addEventListener("input", (event) => {
  state.C = Number(event.target.value);
  el("c-out").textContent = state.C.toFixed(2);
});
el("bpm").addEventListener("input", (event) => {
  state.bpm = Number(event.target.value);
  if (gen) gen.bpm = state.bpm;   // the scheduler polls tempo at the next downbeat
  el("bpm-out").textContent = String(state.bpm);
});
el("cruelty").addEventListener("input", (event) => {
  state.cruelty = Number(event.target.value);
  if (gen) gen.cruelty = state.cruelty;
  el("cruelty-out").textContent = state.cruelty.toFixed(2);
});

document.addEventListener("keydown", (event) => {
  if (event.code === "Space" && event.target === document.body) {
    event.preventDefault();
    grab();
  }
});

// A hidden tab throttles timers to ~1 Hz, which starves a 120 ms lookahead. The
// loop suspends the context and reanchors the grid; this only reports it.
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

// The page's own handle on the pieces, for the browser gates.
window.__margoth = {
  state, get idle() { return idle; }, get relay() { return relay; },
  get loop() { return loop; }, grab, exportWav,
  sweep: () => relay && relay.sweep(),
};

boot();
