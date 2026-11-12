// The band on the home page: one button, the same engine as listen.html.
//
// Browsers refuse to start audio without a gesture, so the kit is prerendered at
// load and the first tap anywhere on the page starts the music (unless the
// visitor switched it off before, which is remembered). While people who opened
// their headband to the music are sharing, the band follows them; when nobody is,
// it plays a piece generated from one session of the record, chosen for the day,
// and says so. Nothing here is a recording.
//
// While it plays, brain waves leave the 6ense mark, drawn the way a SWIM draws a
// wave (swim.js), and a short note says what is being heard (hearing.js). The
// waves are the samples themselves wherever there are samples to draw: a stored
// minute of the session the day's piece is made from (music/eeg/), or the raw
// trace of a live sharer who opened their headband to the music and sends one.
// Where there are only band powers, the waves show those, and the note says so.

import { renderKit } from "./kit.js";
import { createGenerator, nextBar, aggregate } from "./generator.js";
import { createLoop } from "./loop.js";
import { createRelay, DEFAULT_RELAY } from "./relay.js";
import { createIdle } from "./idle.js";
// The ?v= on these three (and inside swim.js and eegbands.js) goes up whenever one of them changes what it exports:
// the host lets a browser keep a module for ten minutes, and a new player handed an old hearing.js does not load.
import { createSwim } from "./swim.js?v=2";
import { decodeCounts, splitBands, createLiveBands } from "./eegbands.js?v=2";
import { BANDS, hearingNote, powerWaves, sharesFromMedians, sharesFromViews } from "./hearing.js?v=2";

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

/** The sessions a stored minute of EEG is published for (music/eeg/index.json): stamp -> entry. */
async function storedMinutes() {
  try {
    const r = await fetch("music/eeg/index.json", { cache: "no-store" });
    if (!r.ok) return new Map();
    const index = await r.json();
    return new Map((index.sessions || []).filter((e) => e && e.stamp && e.file).map((e) => [e.stamp, e]));
  } catch {
    return new Map();
  }
}

/**
 * Today's row of the record: at least five minutes long, with a device summary
 * to seed from. When stored minutes are published, the day's piece is one of
 * those sessions, so that what is drawn and what is played come from the same
 * recording.
 */
async function pieceOfTheDay() {
  try {
    const [r, minutes] = await Promise.all([fetch("data/index.json", { cache: "no-store" }), storedMinutes()]);
    if (!r.ok) return null;
    const index = await r.json();
    let rows = (index.sessions || []).filter((row) => row && row.stamp && (row.minutes || 0) >= 5 && Array.isArray(row.devices) && row.devices.length);
    const drawn = rows.filter((row) => minutes.has(row.stamp));
    if (drawn.length) rows = drawn;
    if (!rows.length) return null;
    const day = new Date().toISOString().slice(0, 10);
    const rank = (row) => hash(`${day}|${row.stamp}`);
    rows.sort((a, b) => rank(a) - rank(b));
    const row = rows[0];
    const summary = row.devices.find((d) => d && d.bands_median) || row.devices[0];
    return { stamp: row.stamp, date: row.date, minutes: row.minutes, summary, eeg: minutes.get(row.stamp) || null };
  } catch {
    return null;
  }
}

/** The stored minute of a session, split into its five bands, as a source for the waves; null when it cannot be had. */
async function storedSource(entry) {
  try {
    const r = await fetch(`music/eeg/${entry.file}`);
    if (!r.ok) return null;
    const buffer = await r.arrayBuffer();
    const lead = Number.isInteger(entry.lead) && entry.lead >= 0 ? entry.lead : 0;
    const length = entry.samples - 2 * lead;
    if (!(entry.fs > 0) || !(entry.uv_per_count > 0) || buffer.byteLength !== entry.samples * 2 || !(length > 0)) return null;
    // the bands are filtered over the whole file; the `lead` samples at each end are where the filters settle, and are not drawn
    const bands = splitBands(decodeCounts(buffer, entry.uv_per_count), entry.fs);
    return {
      kind: "record", fs: entry.fs, length, electrode: entry.electrode, seconds: Math.round(length / entry.fs),
      read: (key, n) => (bands[key] && n >= 0 && n < length ? bands[key][lead + n] : undefined),
    };
  } catch {
    return null;
  }
}

const RAW_FRESH_MS = 2500;       // a live head's raw trace is drawn while its frames keep coming

export async function mountPlayer({ button, status, mark = null, note = null, relayUrl = DEFAULT_RELAY, allow = [] } = {}) {
  const ctx = new AudioContext();
  const say = (text) => { if (status) status.textContent = text; };
  const state = { playing: false, mode: "idle", heads: 0, piece: null, bars: 0, waves: null, shares: null };
  window.__player = state;

  let kit;
  try { kit = await renderKit(ctx.sampleRate); }
  catch (err) { say("the band could not load: " + err.message); return null; }

  // who is sharing, and who opened their headband to the music
  const rawHeads = new Map();      // pseudonym -> the raw trace of a head that sends one, split as it arrives
  function onRaw(pseudonym, frame) {
    if (!Array.isArray(frame.x)) return;
    const fs = frame.fs > 0 ? frame.fs : 256;
    let head = rawHeads.get(pseudonym);
    if (!head || head.fs !== fs) {
      head = { fs, at: 0, channel: -1, bands: createLiveBands(fs) };
      const { bands } = head;
      head.source = { kind: "live", fs, electrode: null, read: bands.read, received: () => bands.state.received };
      rawHeads.set(pseudonym, head);
    }
    if (head.channel < 0) {
      // one electrode per head: the best seated one when the first raw frame arrives
      const names = Array.isArray(frame.ch) && frame.ch.length === frame.x.length ? frame.ch : ["TP9", "AF7", "AF8", "TP10"];
      const view = liveViews().find((v) => v.pseudonym === pseudonym);
      const seat = (name) => (view && view.hsi && Number.isInteger(view.hsi[name]) ? view.hsi[name] : 2.5);
      const order = ["TP9", "TP10", "AF7", "AF8"].filter((name) => names.includes(name));
      order.sort((a, b) => seat(a) - seat(b));
      head.channel = order.length ? names.indexOf(order[0]) : 0;
      head.source.electrode = names[head.channel] || null;
    }
    const samples = frame.x[head.channel];
    if (!Array.isArray(samples)) return;
    head.bands.push(samples);
    head.at = performance.now();
  }

  const relay = createRelay({
    url: relayUrl, allow,
    onSharers: () => describe(),
    onLeave: (pseudonym) => { rawHeads.delete(pseudonym); describe(); },
    onStale: () => describe(),
    onRaw,
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

  // the waves are drawn from whatever the band is playing from: a live head's raw trace if one is coming in,
  // the stored minute of the day's session if nobody is live, and band powers where there is no trace to draw
  const pieceShares = piece ? sharesFromMedians(piece.summary && piece.summary.bands_median) : null;
  const recordSource = piece && piece.eeg ? await storedSource(piece.eeg) : null;
  let waves = null;
  let powers = null;               // the stand-in for when there are only band powers, remade when they change
  function powerSource(shares) {
    const key = JSON.stringify(shares);
    if (!powers || powers.key !== key) {
      powers = powerWaves(shares, 256, waves ? waves.state.pxPerUv : 1);
      powers.key = key;
    }
    return powers;
  }
  function waveSource() {
    const views = liveViews();
    if (views.length) {
      const fresh = performance.now() - RAW_FRESH_MS;
      const head = views.map((v) => rawHeads.get(v.pseudonym)).find((h) => h && h.at >= fresh);
      state.shares = sharesFromViews(views);
      return head ? head.source : powerSource(state.shares);
    }
    state.shares = pieceShares;
    return recordSource || powerSource(pieceShares);
  }
  /** What the note says the waves are: null when they are not drawn at all. */
  function waveInfo() {
    if (!waves || waves.state.reduced) return null;
    const source = waveSource();
    return { kind: source.kind, electrode: source.electrode || null, seconds: source.seconds || null };
  }
  function onBar(event) {
    describe();
    if (!waves) return;
    const source = waveSource();
    state.waves = waves.state.reduced ? null : { kind: source.kind, electrode: source.electrode || null };
    waves.setSource(source);
    waves.bar(event.time, event.tempo);
  }

  const loop = createLoop({ ctx, kit, pullBar, bpm: idle ? idle.bpm : 132, muted: ["lead"], onBar });
  waves = createSwim({ audio: ctx, tap: loop.voices.master, mark });
  window.__waves = waves;

  // the note that says what is being heard: shown when the music starts, gone when it stops
  let noteClosed = false;
  let noteKey = null;
  function showNote() {
    if (!note || noteClosed) return;
    const live = liveViews().length;
    const drawn = waveInfo();
    const key = `${live}|${state.piece}|${drawn ? `${drawn.kind}:${drawn.electrode}` : "none"}`;
    if (key !== noteKey) {
      noteKey = key;
      const words = hearingNote({ live, piece: live ? null : (idle ? piece : null), waves: drawn });
      const el = (tag, text, cls) => {
        const node = document.createElement(tag);
        if (text) node.textContent = text;
        if (cls) node.className = cls;
        return node;
      };
      const close = el("button", "×", "x");
      close.type = "button";
      close.title = "Close this note";
      close.setAttribute("aria-label", "Close this note");
      close.addEventListener("click", (event) => { event.stopPropagation(); noteClosed = true; note.hidden = true; });
      const first = el("p");
      first.append(el("b", `${words.title}. `), words.what);
      const parts = [close, first, el("p", words.how)];
      if (words.waves) {
        const legend = el("p", `${words.waves[0]} `);
        BANDS.forEach((band, i) => {
          const chip = el("span", "", "band-chip");
          const dot = el("i");
          dot.style.background = band.color;
          chip.append(dot, band.key);
          legend.append(chip, i < BANDS.length - 1 ? " " : "");
        });
        legend.append(`. ${words.waves[1]}`);
        parts.push(legend);
      }
      const last = el("p", "♪ stops it · ", "foot");
      const link = el("a", words.more.text);
      link.href = words.more.href;
      last.append(link);
      parts.push(last);
      note.replaceChildren(...parts);
    }
    if (note.hidden) {
      // under the menu when the menu is in sight; otherwise pinned to the corner of the window, so a visitor
      // far down the page still learns why there is music and how to stop it
      const nav = document.querySelector("nav");
      const box = nav ? nav.getBoundingClientRect() : null;
      note.classList.toggle("floating", !box || box.bottom < 0 || box.top > window.innerHeight);
    }
    note.hidden = false;
  }

  function describe() {
    if (!state.playing) {
      say(remembered() === "off" ? "off · tap ♪ to listen" : "tap anywhere to listen");
      return;
    }
    const views = liveViews();
    if (views.length) say(`playing ${views.length} ${views.length === 1 ? "person" : "people"} sharing live · ♪ stops it`);
    else if (idle) say(`nobody is sharing: a piece generated from the record, session ${state.piece} · ♪ stops it`);
    else say("playing · ♪ stops it");
    showNote();                                   // the note follows who is playing (a head joins, the last one leaves)
  }

  async function start() {
    if (state.playing) return;
    try { await loop.play(); } catch (err) { say("could not start audio: " + err.message); return; }
    state.playing = true;
    button.setAttribute("aria-pressed", "true");
    button.textContent = "♪ stop";
    remember("on");
    waves.start();
    describe();
  }

  function stop(byVisitor = true) {
    if (!state.playing) return;
    loop.stop();
    state.playing = false;
    button.setAttribute("aria-pressed", "false");
    button.textContent = "♪ listen";
    if (byVisitor) remember("off");
    waves.stop();
    if (note) note.hidden = true;
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
  return { start, stop, loop, relay, ctx, waves };
}
