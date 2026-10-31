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
import {
  createGenerator, nextBar, aggregate, VOTE_WEIGHT,
} from "./generator.js";
import { createVoices } from "./voices.js";
import { createLoop } from "./loop.js";
import { playEvent } from "./arrange.js";
import { createUI, mountParameters } from "./ui.js";
import { KEYS, LEAD_RANGE, createLeadPatch, patchFrom, pentatonicNotes } from "./lead.js";
import {
  AUTO, PAGE, seatOptions, viewsForSeat, resolvedSeat, seatSentence, seatStatus,
} from "./drivers.js";
import { createRelay, DEFAULT_RELAY } from "./relay.js";
import { createIdle, encodeWav } from "./idle.js";
import { ladderRows, timbreRows, voiceRows, parameterFor, noteName } from "./explain.js";
import {
  concentrationParts, concentrationFromParts, partsFromConcentration,
  getConcentrationWeights, setConcentrationWeights, WEIGHT_DEFAULTS,
} from "./conditioner.js";

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// What the harness reads: a page that claims to play must prove it.
window.__audio = {
  mode: "live", playing: false, bars: 0, rms: -Infinity, peak: -Infinity,
  errors: [], lastBar: null, cast: [], roles: {}, relayState: null, wav: null,
};

const state = { C: 0.45, bpm: 132, cruelty: 0.15 };

// The concentration weights the page starts with: the listener's last choice, or
// the conditioner's defaults. localStorage can be unavailable (private mode,
// file://), and a panel that cannot remember is still a panel.
const WEIGHTS_KEY = "margoth.concWeights";

function storedWeights() {
  try {
    const raw = localStorage.getItem(WEIGHTS_KEY);
    if (!raw) return null;
    const values = JSON.parse(raw);
    if (!Array.isArray(values) || values.length !== 3) return null;
    if (!values.every((v) => Number.isFinite(v) && v >= 0)) return null;
    return { engagement: values[0], activation: values[1], steadiness: values[2] };
  } catch {
    return null;
  }
}

function persistWeights(next) {
  try {
    localStorage.setItem(WEIGHTS_KEY, JSON.stringify([next.engagement, next.activation, next.steadiness]));
  } catch {
    // no storage: the weights still hold in memory for this page
  }
}

setConcentrationWeights(storedWeights() || WEIGHT_DEFAULTS);

const ctx = new AudioContext();
const ui = createUI({ root: el("mount"), onGrab: () => grab(), onWeights: (next) => applyWeights(next) });

let kit = null;
let loop = null;
let analyser = null;
let levelData = null;
let idle = null;
let relay = null;
let gen = null;
let castKey = "";        // the panel's own key: refused heads never reach onSharers
let castAt = 0;
let lead = null;         // the pentatonic patch, built with the audio context
let lastBarFull = null;  // the whole bar, for the chord the keys play over
let keysNow = [];        // the ten midi notes the key strip is holding
const heldKeys = new Map();   // keycap -> sounding voice
// Two seats, filled from the cast. "auto" is everyone in contact, `page` is the
// sliders, and a pseudonym is that head alone.
const seats = { band: AUTO, patch: AUTO };
// What each seat's choice is called, so a head that leaves can still be named:
// once it has gone, the roster no longer carries its display name.
const seatNames = { band: "", patch: "" };

const idleStamp = params.get("idle");
const relayUrl = params.get("relay");

/**
 * The solo wizard on this page: pressure is its arousal, and nothing else votes.
 * There is no headband, so its three concentration terms are the ones a single
 * number stands in for (partsFromConcentration) -- which is also why the weight
 * sliders have something to re-weight here. At the default weights this is
 * exactly the C slider, to the last bit.
 */
function soloControls(parts = partsFromConcentration(state.C)) {
  return {
    C: concentrationFromParts(parts),
    alphaShare: 0.35,
    arousal: state.C,
    motion: 0.35,
    asymmetry: 0.2,
  };
}

/**
 * What the bar generator is told before each bar. In relay mode the sharers vote;
 * with nobody admitted that is the vamp, which is the generator's own answer to an
 * empty room rather than a fallback invented here.
 */
function currentControls() {
  if (!relay) return soloControls(lastParts || partsFromConcentration(state.C));
  const at = Date.now() / 1000;
  const views = relay.sharers(at);
  const seat = resolvedSeat(views, seats.band);
  if (seat === PAGE) return soloControls(lastParts || partsFromConcentration(state.C));
  const chosen = viewsForSeat(views, seat);
  // nobody left in the seat the page claims to follow: the generator's own answer
  // to an empty room is the vamp, and inventing a head would be a lie
  return aggregate(chosen, at);
}

/**
 * What the lead patch is shaped by. A named head gives its own beta and
 * steadiness; "auto" is the consensus the band votes, which carries the four
 * ladder signals and no per-head beta; "this page" is the sliders' own terms.
 */
function patchSource() {
  const at = Date.now() / 1000;
  if (!relay) return soloControls();
  const views = relay.sharers(at);
  const seat = resolvedSeat(views, seats.patch);
  if (seat === PAGE) return soloControls();
  if (seat === AUTO) return aggregate(views, at);
  return viewsForSeat(views, seat)[0] || soloControls();
}

/** Push the chosen muse's signals into the wavetable, once a bar. */
function applyPatch() {
  if (!lead) return;
  const patch = lead.setPatch(patchFrom(patchSource()));
  window.__audio.patch = patch;
}

/**
 * The controls the current bar was actually generated from. `onBar` hands this
 * to the panel, so the signals it prints are the ones that made the bar and not
 * a fresh reading taken a bar later.
 */
let lastControls = null;
let lastTimbre = null;
let lastParts = null;
let lastSignals = null;

function pullBar(index) {
  if (idle) {
    const bar = idle.pullBar(index % idle.bars);
    // the idle piece walks its own controls, and its own controls are what the
    // ladder must print: the C slider is not that wizard
    lastControls = idle.controls(index % idle.bars);
    lastParts = partsFromConcentration(lastControls.C);   // no headband, same rule
    return bar;
  }
  if (relay) {
    lastParts = null;             // onBar reads the terms off the same views it prints
  } else {
    lastParts = partsFromConcentration(state.C);
  }
  lastControls = currentControls();
  return nextBar(gen, lastControls);
}

function grab() {
  if (!gen) return;
  // Two more bars of this chord: the generator advances only when barsLeft runs
  // out, so extending it is the hold. Drums and bass carry on regardless.
  gen.barsLeft = Math.max(gen.barsLeft, 2);
  say("held: this chord runs two more bars");
}

// One status line, and it is the page's: the panel no longer keeps a second.
function say(text) { el("status").textContent = text; }

/**
 * The transport's three dials, glossed from the table the panel prints. A rack
 * label is a name and a scale; "C" alone is a name and nothing else, so each
 * control gets the plain word and the range it can hold, plus the rule as a
 * tooltip -- all of it read from explain.js, so a label cannot outlive its rule.
 */
const DIALS = [["c", "C"], ["bpm", "bpm"], ["cruelty", "cruelty"]];
function explainDials() {
  for (const [controlId, paramId] of DIALS) {
    const input = el(controlId);
    const entry = parameterFor(paramId);
    if (!input || !entry) continue;
    const wrap = input.closest(".mg-ctl");
    const hint = wrap && wrap.querySelector(".mg-ctl-hint");
    if (hint) hint.textContent = `${entry.short} · ${entry.range}`;
    input.title = entry.does;
    // the label element already reads "C concentration 0.45", which is the
    // output's value rather than the control's name: say what it is instead
    input.setAttribute("aria-label", `${entry.label} ${entry.short}, ${entry.range}`);
  }
}

/** One raw head row for the panel's strip: what the conditioner actually sees. */
function headRowOf(view) {
  return {
    pseudonym: view.pseudonym,
    name: view.name,
    C: view.C,
    alphaShare: view.alphaShare,
    betaShare: view.betaShare,
    theta: view.theta,
    delta: view.delta,
    gamma: view.gamma,
    arousal: view.arousal,
    bpm: view.bpm,
    rmssd: view.rmssd,
    hsi: view.hsi,
    inContact: view.inContact,
    vote: view.inContact ? VOTE_WEIGHT.contact : VOTE_WEIGHT.silent,
  };
}

function onBar(event) {
  window.__audio.bars += 1;
  const bar = event.data;
  lastBarFull = bar;
  window.__audio.lastBar = {
    index: bar.index, tempo: event.tempo, family: bar.family, vamp: bar.vamp,
    chord: bar.chords[0] ? bar.chords[0].label : null,
    devices: bar.chords[0] ? bar.chords[0].devices : [],
    reason: bar.ui.reason, C: bar.ui.C, armed: !!(bar.ui.chain && bar.ui.chain.armed),
  };
  const mix = lastControls || soloControls();
  const at = Date.now() / 1000;
  // one call, not two: every sharers() read appends an alpha sample to the
  // conditioner, so the strip and the sum must come from the same reading
  const views = relay ? relay.sharers(at) : [];
  const heads = views.map(headRowOf);
  if (relay) lastParts = views.length ? concentrationParts(views[0]) : null;
  const weights = getConcentrationWeights();

  lastSignals = {
    mix,
    ladder: ladderRows(mix, bar),
    sound: timbreRows(bar.timbre, lastTimbre),
    voices: voiceRows(bar, { muted: ["lead"], roles: relay ? relay.roles(at) : {} }),
    heads,
    weights,
    parts: lastParts,
  };
  lastTimbre = bar.timbre;
  window.__audio.heads = heads;
  window.__audio.parts = lastParts;
  window.__audio.weights = weights;

  ui.bar(event);
  ui.signals(lastSignals);
  renderKeys();
  applyPatch();
  if (relay) renderDrivers();
}

/**
 * A weights change: the conditioner re-weights at once, the panel redraws the
 * sum from the last bar's terms in the same frame, and the band follows at its
 * next bar (C is read once per bar, which is what keeps a bar internally coherent).
 */
function applyWeights(next) {
  const effective = setConcentrationWeights(next);
  persistWeights(next);
  window.__audio.weights = effective;
  if (lastSignals) ui.signals({ ...lastSignals, weights: effective });
  return effective;
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
  // One level display, and it is the transport's: the panel's meter is gone.
  el("meterbar").style.width = `${Math.min(100, Math.max(0, (window.__audio.rms + 60) / 60 * 100))}%`;
  el("meter-text").textContent = window.__audio.rms === -Infinity
    ? "—"
    : `${window.__audio.rms.toFixed(1)} / ${window.__audio.peak.toFixed(1)} dBFS`;
  if (relay && performance.now() - castAt > 400) {
    castAt = performance.now();
    renderDrivers();
    if (seats.band !== AUTO || seats.patch !== AUTO) applyPatch();
  }
  requestAnimationFrame(meter);
}

// --------------------------------------------------------------- who drives
/**
 * The two seats and the key strip, under the transport. The chips are the
 * roster: a head that is not opened to the music still appears, marked, because
 * "you are refused" is information the sharer needs; but only admitted heads can
 * be handed a seat.
 */
function renderDrivers() {
  const rows = relay ? relay.all() : [];
  const roles = relay ? relay.roles() : {};
  for (const [role, pseudonym] of Object.entries(roles)) {
    if (!pseudonym) continue;
    const row = rows.find((r) => r.pseudonym === pseudonym);
    if (row) row.role = role;
  }
  window.__audio.cast = rows.map((r) => ({
    pseudonym: r.pseudonym, name: r.name, label: r.label,
    admitted: r.admitted, playable: r.playable, stale: r.stale, age: r.age,
    role: r.role ?? null,
  }));
  window.__audio.roles = roles;

  const options = seatOptions(rows);
  const key = seatKeyOf(rows);
  if (key === castKey) return;
  castKey = key;

  const SEAT_WORDS = {
    band: { verb: "driving the band", alone: "the sliders drive the band" },
    patch: { verb: "shaping the lead", alone: "the sliders shape the lead" },
  };
  for (const seat of ["band", "patch"]) {
    const host = el(`seat-${seat}`);
    if (!host) continue;
    const inForce = resolvedSeat(relay ? relay.sharers(Date.now() / 1000) : [], seats[seat]);
    // A seat whose chosen head has gone keeps the choice but cannot honour it.
    // The page's status line is no place to say so -- the relay's own state
    // overwrites that every few seconds -- so the seat says it, and stays said.
    const lost = seats[seat] !== AUTO && seats[seat] !== PAGE
      && inForce !== seats[seat] ? seats[seat] : null;
    const lostName = seatNames[seat] || lost;
    const lostNote = lost
      ? { textContent: `${lostName} has gone. ${seatSentence(inForce, options)} is ${SEAT_WORDS[seat].verb}.` }
      : null;
    host.replaceChildren(...options.map((option) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "mg-choice";
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", String(inForce === option.id));
      chip.dataset.kind = option.kind;
      chip.dataset.choice = option.id;
      chip.dataset.stale = String(option.stale === true);
      chip.disabled = option.kind === "refused";
      chip.title = option.note;
      chip.append(document.createTextNode(option.label));
      chip.addEventListener("click", () => chooseSeat(seat, option.id));
      return chip;
    }));
    // With nobody connected there is nothing to choose between, so the chips go
    // and one sentence says what is driving instead. A row offering "Everyone"
    // and "These sliders" when they are the same thing is not a choice.
    const heads = rows.filter((r) => r.admitted && !r.stale).length;
    const refused = rows.filter((r) => !r.admitted).length;
    host.hidden = heads === 0;
    const stateLine = el(`seat-${seat}-state`);
    if (stateLine) {
      stateLine.textContent = lostNote
        ? lostNote.textContent
        : seatStatus(inForce, options, { heads, refused, ...SEAT_WORDS[seat] });
      stateLine.dataset.lost = String(!!lostNote);
    }
  }
}

/** A stable key for the seat chips, so the poll does not rebuild them per frame. */
function seatKeyOf(rows) {
  return [
    rows.map((r) => `${r.pseudonym}:${r.admitted}:${r.stale}:${r.role ?? ""}`).join("|"),
    seats.band, seats.patch,
  ].join("#");
}

/** Hand a seat to a chip. The choice is memory-only: a page reload is a new room. */
function chooseSeat(seat, choice) {
  if (seats[seat] === choice) return;
  const chosen = seatOptions(relay ? relay.all() : []).find((option) => option.id === choice);
  seatNames[seat] = chosen ? chosen.label : "";
  seats[seat] = choice;
  castKey = "";                       // force the chips to redraw
  renderDrivers();
  const views = relay ? relay.sharers(Date.now() / 1000) : [];
  const options = seatOptions(relay ? relay.all() : []);
  const inForce = resolvedSeat(views, choice);
  const words = seat === "band" ? "driving the band" : "shaping the lead";
  if (inForce !== choice) {
    say(`${choice} has gone. ${seatSentence(inForce, options)} is ${words}`);
  } else {
    say(`${seatSentence(inForce, options)} ${inForce === PAGE ? "are" : "is"} ${words}`);
  }
  applyPatch();
}

/**
 * The key strip: ten midi notes from the chord in the bar, labelled so a hand can
 * find them. It is rebuilt when the chord changes, not on every frame.
 */
function renderKeys() {
  const host = el("keys");
  if (!host) return;
  const chord = lastBarFull && Array.isArray(lastBarFull.chords) && lastBarFull.chords[0]
    ? lastBarFull.chords[0]
    : null;
  const scale = pentatonicNotes(chord, LEAD_RANGE);
  keysNow = scale.notes;
  const note = el("keys-note");
  if (note) {
    note.textContent = chord
      ? `${scale.name} · ${chord.label} in the bar`
      : `${scale.name} · no chord yet`;
  }
  host.replaceChildren(...KEYS.map(([letter], index) => {
    const key = document.createElement("button");
    key.type = "button";
    key.className = "mg-key";
    key.dataset.key = letter;
    key.dataset.index = String(index);
    key.dataset.down = "false";
    const cap = document.createElement("b");
    cap.textContent = letter;
    const pitch = document.createElement("span");
    pitch.textContent = keysNow[index] == null ? "—" : noteName(keysNow[index]);
    key.append(cap, pitch);
    // a click sounds it briefly; holding a pointer is the keyboard's job
    key.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const voice = strike(index);
      if (!voice) return;
      setTimeout(() => releaseVoice(voice, index), 320);
    });
    return key;
  }));
  // the strip is rebuilt when the chord moves, which happens while keys are held:
  // put the lights back on whatever is still sounding
  for (const held of heldKeys.values()) paintKey(held.index, true);
}

function paintKey(index, down) {
  const host = el("keys");
  const key = host && host.querySelector(`[data-index="${index}"]`);
  if (key) key.dataset.down = String(down);
}

/** The band steps back while a soloist plays: -5.2 dB, 40 ms in, 250 ms out. */
const DUCK = 0.55;
function duckBand(on) {
  const duck = loop && loop.voices.buses.duck;
  if (!duck || !ctx) return;
  const t = ctx.currentTime;
  duck.gain.cancelScheduledValues(t);
  duck.gain.setValueAtTime(duck.gain.value, t);
  duck.gain.linearRampToValueAtTime(on ? DUCK : 1, t + (on ? 0.04 : 0.25));
}

/** Sound one key of the strip. */
function strike(index) {
  if (!lead || !ctx || ctx.state !== "running") return null;
  const midi = keysNow[index];
  if (midi == null) return null;
  const first = lead.voices === 0;
  const voice = lead.hold(midi);
  paintKey(index, true);
  if (first) duckBand(true);
  window.__audio.keys = {
    last: midi,
    total: (window.__audio.keys ? window.__audio.keys.total : 0) + 1,
    voices: lead.voices,
  };
  return voice;
}

/**
 * Release the voice that was actually struck, not the note the strip holds *now*.
 * The chord moves while a key is down -- the strip is rebuilt every bar -- and
 * re-deriving the midi from the new strip released nothing, leaving notes
 * sounding until the voice allocator stole them: measured, five keys released and
 * three voices still playing.
 */
function releaseVoice(voice, index) {
  if (voice) voice.release();
  if (index != null) paintKey(index, false);
  if (lead && lead.voices === 0) duckBand(false);
}

/** Release by keycap index, for the pointer and the page's own handle. */
function lift(index) {
  for (const [key, held] of heldKeys) {
    if (held.index === index) {
      heldKeys.delete(key);
      releaseVoice(held.voice, held.index);
      return;
    }
  }
}

/** The scene the keyboard plays over: the chord in the current bar, if any. */
function currentChord() {
  return lastBarFull && Array.isArray(lastBarFull.chords) ? lastBarFull.chords[0] || null : null;
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
  // The words before the sound: this needs no audio context, so the section is
  // complete even if the kit never renders.
  mountParameters({ root: el("params") });
  explainDials();

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
    document.title = `Mar(G)off — ${idleStamp}`;
    say(`idle piece for ${idleStamp} · generated, not replayed`);
  } else {
    gen = createGenerator({ seed: 5, tonicMidi: 57, bpm: state.bpm, cruelty: state.cruelty });
  }

  if (relayUrl) {
    window.__audio.mode = "relay";
    relay = createRelay({
      url: relayUrl === "1" ? DEFAULT_RELAY : relayUrl,
      allow: (params.get("allow") || "").split(",").map((s) => s.trim()).filter(Boolean),
      onSharers: () => renderDrivers(),
      onLeave: (pseudonym, why) => { renderDrivers(); applyPatch(); say(`${pseudonym} left: ${why}`); },
      onStale: (pseudonym) => { renderDrivers(); applyPatch(); say(`${pseudonym} went quiet: the band hands over`); },
      onStatus: ({ state: relayState, url }) => {
        window.__audio.relayState = relayState;
        say(`relay ${relayState} · ${url}`);
      },
    });
    renderDrivers();
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

  // The lead is mixed after the band's compressor, not into the voice sum: the
  // compressor holds the total near its ceiling, so a soloist mixed upstream is
  // compressed back to nothing (measured: 1.1 dB of RMS for a five-voice lead,
  // with the sum driven to 1.32). The band's duck does the work instead -- see
  // duckBand() below.
  lead = createLeadPatch(ctx);
  lead.out.connect(loop.voices.master);
  renderKeys();
  renderDrivers();
  applyPatch();
  requestAnimationFrame(meter);

  // the panel knows the weights before it knows a bar, so the sliders read the
  // remembered triple from the first frame rather than from the first downbeat
  ui.signals({ weights: getConcentrationWeights() });

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

// A mouse click leaves focus on the control it was on, and Space then belongs to
// that control rather than to the chord. Keyboard activation reports detail 0 and
// keeps focus, which is what a keyboard user needs.
el("play").addEventListener("click", (event) => {
  if (event.detail > 0) event.currentTarget.blur();
  toggle();
});
el("export").addEventListener("click", (event) => {
  if (event.detail > 0) event.currentTarget.blur();
  exportWav();
});

// Same for the sliders: a drag leaves the range focused, and the space that
// follows would adjust it instead of grabbing. The value is already committed.
el("transport").addEventListener("pointerup", () => {
  const active = document.activeElement;
  if (active && active.tagName === "INPUT" && active.type === "range") active.blur();
});

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

// Space grabs a chord. It must not fire while a control is being driven by the
// keyboard, so the guard is by element rather than by `target === body`: a body
// guard works exactly once, until the first click moves focus into the page.
const TYPED = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);
function isTypingTarget(node) {
  if (!node || typeof node !== "object") return false;
  if (node.isContentEditable) return true;
  if (TYPED.has(node.tagName)) return true;
  return node.tagName === "A" && node.hasAttribute("href");
}

document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || isTypingTarget(event.target)) return;
  event.preventDefault();
  grab();
});

// The pentatonic keyboard: ten caps, one row of a computer. Same guard as Space,
// so a control with focus keeps its own keys, and no key repeats a note that is
// already sounding under the same finger.
const keyOf = (event) => String(event.key || "").toLowerCase();

document.addEventListener("keydown", (event) => {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTypingTarget(event.target)) return;
  const key = keyOf(event);
  const index = KEYS.findIndex(([cap]) => cap === key);
  if (index < 0 || heldKeys.has(key)) return;
  const voice = strike(index);
  if (!voice) return;
  event.preventDefault();
  heldKeys.set(key, { index, voice });
});

document.addEventListener("keyup", (event) => {
  const key = keyOf(event);
  const held = heldKeys.get(key);
  if (!held) return;
  heldKeys.delete(key);
  releaseVoice(held.voice, held.index);
});

// A window that loses focus never sends the keyup, which would leave a note
// sounding until it is stolen. Let go of everything.
window.addEventListener("blur", () => {
  for (const held of heldKeys.values()) releaseVoice(held.voice, held.index);
  heldKeys.clear();
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
  state, seats, chooseSeat, get idle() { return idle; }, get relay() { return relay; },
  get loop() { return loop; }, grab, exportWav, ui,
  get lead() { return lead; },
  get patch() { return lead ? lead.patch : null; },
  get keys() { return keysNow.slice(); },
  get chord() { return currentChord(); },
  get pentatonic() { return pentatonicNotes(currentChord(), LEAD_RANGE).name; },
  strike, lift, releaseAll: () => { for (const held of heldKeys.values()) releaseVoice(held.voice, held.index); heldKeys.clear(); },
  get weights() { return getConcentrationWeights(); },
  setWeights: (next) => applyWeights(next),
  sweep: () => relay && relay.sweep(),
};

boot();
