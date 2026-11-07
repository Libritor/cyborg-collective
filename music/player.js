// The band on the home page: one button, the same engine as listen.html.
//
// Browsers refuse to start audio without a gesture, so the kit is prerendered at
// load and the first tap anywhere on the page starts the music (unless the
// visitor switched it off before, which is remembered). While people who opened
// their headband to the music are sharing, the band follows them; when nobody is,
// it plays a piece generated from one session of the record, chosen for the day,
// and says so. Nothing here is a recording.

import { renderKit } from "./kit.js";
import { createGenerator, nextBar, aggregate } from "./generator.js";
import { createLoop } from "./loop.js";
import { createRelay, DEFAULT_RELAY } from "./relay.js";
import { createIdle } from "./idle.js";

const STORE_KEY = "collective.music";          // "on" | "off"; absent = never chose

function remembered() {
  try { return localStorage.getItem(STORE_KEY); } catch { return null; }
}
function remember(value) {
  try { localStorage.setItem(STORE_KEY, value); } catch { /* private mode: fine */ }
}

/** A stable small hash, so the day's piece is the same for every visitor that day. */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Today's row of the record: at least five minutes long, with a device summary to seed from. */
async function pieceOfTheDay() {
  try {
    const r = await fetch("data/index.json", { cache: "no-store" });
    if (!r.ok) return null;
    const index = await r.json();
    const rows = (index.sessions || []).filter((row) => row && row.stamp && (row.minutes || 0) >= 5 && Array.isArray(row.devices) && row.devices.length);
    if (!rows.length) return null;
    const day = new Date().toISOString().slice(0, 10);
    rows.sort((a, b) => hash(a.stamp + day) - hash(b.stamp + day));
    const row = rows[0];
    const summary = row.devices.find((d) => d && d.bands_median) || row.devices[0];
    return { stamp: row.stamp, date: row.date, minutes: row.minutes, summary };
  } catch {
    return null;
  }
}

export async function mountPlayer({ button, status, relayUrl = DEFAULT_RELAY, allow = [] } = {}) {
  const ctx = new AudioContext();
  const say = (text) => { if (status) status.textContent = text; };
  const state = { playing: false, mode: "idle", heads: 0, piece: null, bars: 0 };
  window.__player = state;

  let kit;
  try { kit = await renderKit(ctx.sampleRate); }
  catch (err) { say("the band could not load: " + err.message); return null; }

  // who is sharing, and who opened their headband to the music
  const relay = createRelay({
    url: relayUrl, allow,
    onSharers: () => describe(),
    onLeave: () => describe(),
    onStale: () => describe(),
  });

  const gen = createGenerator({ seed: 5, tonicMidi: 57, bpm: 132, cruelty: 0.15 });
  let idle = null;
  const piece = await pieceOfTheDay();
  if (piece) {
    idle = createIdle({ stamp: piece.stamp, summary: piece.summary, bars: 16, bpm: 132 });
    state.piece = piece.stamp;
  }

  function liveViews() {
    const at = Date.now() / 1000;
    return relay.sharers(at).filter((v) => v && v.admitted !== false);
  }

  function pullBar(index) {
    state.bars = index;
    const views = liveViews();
    if (views.length) {
      state.mode = "live"; state.heads = views.length;
      return nextBar(gen, aggregate(views, Date.now() / 1000));
    }
    state.heads = 0;
    if (idle) { state.mode = "record"; return idle.pullBar(index % 16); }
    state.mode = "vamp";
    return nextBar(gen, { C: 0.3, alphaShare: 0.35, arousal: 0.3, motion: 0.3, asymmetry: 0.2 });
  }

  const loop = createLoop({ ctx, kit, pullBar, bpm: idle ? idle.bpm : 132, muted: ["lead"], onBar: () => describe() });

  function describe() {
    if (!state.playing) {
      say(remembered() === "off" ? "off · tap ♪ to listen" : "tap anywhere to listen");
      return;
    }
    const views = liveViews();
    if (views.length) say(`playing ${views.length} ${views.length === 1 ? "person" : "people"} sharing live · ♪ stops it`);
    else if (idle) say(`nobody is sharing: a piece generated from the record, session ${state.piece} · ♪ stops it`);
    else say("playing · ♪ stops it");
  }

  async function start() {
    if (state.playing) return;
    try { await loop.play(); } catch (err) { say("could not start audio: " + err.message); return; }
    state.playing = true;
    button.setAttribute("aria-pressed", "true");
    button.textContent = "♪ stop";
    remember("on");
    describe();
  }

  function stop(byVisitor = true) {
    if (!state.playing) return;
    loop.stop();
    state.playing = false;
    button.setAttribute("aria-pressed", "false");
    button.textContent = "♪ listen";
    if (byVisitor) remember("off");
    describe();
  }

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (state.playing) stop(); else start();
  });

  // the first gesture anywhere starts the band, unless the visitor said no before
  if (remembered() !== "off") {
    const first = (event) => {
      if (event.target && event.target.closest && event.target.closest("a, button, input, select, textarea, video")) return;
      document.removeEventListener("pointerdown", first);
      document.removeEventListener("keydown", first);
      start();
    };
    document.addEventListener("pointerdown", first);
    document.addEventListener("keydown", first);
  }

  // a hidden tab throttles timers to about 1 Hz; the loop suspends the context and reanchors
  document.addEventListener("visibilitychange", () => {
    if (!state.playing) return;
    if (document.hidden) loop.suspend(); else loop.resume();
  });

  button.disabled = false;
  describe();
  return { start, stop, loop, relay, ctx };
}
