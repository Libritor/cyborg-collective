// Proof for audible.js: which devices it acts on, the silence it makes, and what open() and rest() do to a
// browser's audio session and to the silent loop, on stand-ins for a phone (no phone is on this desk: what an
// iPhone's own switch then does cannot be shown here, only that the page asks for what the switch respects).
// Run: node music/test_audible.js -> "PASS <n> assertions", exit 0.

import { readFileSync } from "node:fs";

import { isAppleTouch, silentWav, wavDataUri, createAudible } from "./audible.js";

let assertions = 0;
const failures = [];
function check(condition, label) {
  assertions += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const MAC = IPAD;
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

console.log("which devices");
{
  check(isAppleTouch({ userAgent: IPHONE, maxTouchPoints: 5 }), "an iPhone in Safari");
  check(isAppleTouch({ userAgent: IPHONE_CHROME, maxTouchPoints: 5 }), "an iPhone in Chrome (the same engine underneath, the same switch)");
  check(isAppleTouch({ userAgent: IPAD, maxTouchPoints: 5 }), "an iPad, which calls itself a Macintosh but has a touch screen");
  check(!isAppleTouch({ userAgent: MAC, maxTouchPoints: 0 }), "not a Mac: it has no silent switch");
  check(!isAppleTouch({ userAgent: ANDROID, maxTouchPoints: 5 }), "not an Android phone: its media volume is its own");
  check(!isAppleTouch({ userAgent: WINDOWS, maxTouchPoints: 10 }), "not a Windows laptop with a touch screen");
  check(!isAppleTouch(undefined) && !isAppleTouch({}), "nothing to go on: not one");
}

console.log("the silence");
{
  const wav = silentWav(48000, 0.5);
  const view = new DataView(wav.buffer);
  const word = (at) => String.fromCharCode(...wav.subarray(at, at + 4));
  check(word(0) === "RIFF" && word(8) === "WAVE" && word(12) === "fmt " && word(36) === "data", "a WAV file: RIFF, WAVE, fmt, data");
  check(view.getUint32(4, true) === wav.length - 8 && view.getUint32(40, true) === wav.length - 44, "its two lengths agree with its size");
  check(view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 && view.getUint16(34, true) === 8, "plain samples, one channel, 8 bits");
  check(view.getUint32(24, true) === 48000 && view.getUint32(28, true) === 48000 && view.getUint16(32, true) === 1, "at the rate it was asked for, one byte a sample");
  check(wav.length - 44 === 24000, "half a second of it");
  check(wav.subarray(44).every((b) => b === 128), "every sample is the middle value: silence");
  check(new DataView(silentWav(44100).buffer).getUint32(24, true) === 44100, "made at whatever rate the audio context runs at");
  const uri = wavDataUri(wav);
  const back = Uint8Array.from(atob(uri.split(",")[1]), (c) => c.charCodeAt(0));
  check(uri.startsWith("data:audio/wav;base64,") && back.length === wav.length && back.every((b, i) => b === wav[i]), "as an address, it carries the same bytes");
}

/** A stand-in for the page's document: one <audio> element that plays only inside a gesture. */
function fakeDocument() {
  const doc = { made: [], gesture: false };
  doc.createElement = (tag) => {
    const el = { tag, paused: true, loop: false, src: "", attrs: {}, plays: 0, pauses: 0,
      setAttribute(k, v) { el.attrs[k] = v; },
      play() {
        el.plays += 1;
        if (!doc.gesture) return Promise.reject(new Error("NotAllowedError"));
        el.paused = false;
        return Promise.resolve();
      },
      pause() { el.pauses += 1; el.paused = true; } };
    doc.made.push(el);
    return el;
  };
  return doc;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

console.log("on an iPhone");
{
  const nav = { userAgent: IPHONE, maxTouchPoints: 5, audioSession: { type: "auto" } };
  const doc = fakeDocument();
  const audible = createAudible({ ctx: { sampleRate: 48000 }, nav, doc });
  check(doc.made.length === 0 && nav.audioSession.type === "auto", "nothing is made or changed until the page is touched");
  check(audible.wants(), "it wants a touch");

  audible.open();                                   // the finger going down: not yet a gesture on an iPhone
  await settle();
  check(nav.audioSession.type === "playback" && audible.state.session === "playback", "the audio session is set to playback");
  check(doc.made.length === 1 && doc.made[0].tag === "audio" && doc.made[0].loop === true, "one <audio> element, looping");
  const el = doc.made[0];
  const bytes = Uint8Array.from(atob(el.src.split(",")[1]), (c) => c.charCodeAt(0));
  check(new DataView(bytes.buffer).getUint32(24, true) === 48000, "its silence is at the audio context's own rate");
  check(audible.state.loop === "refused" && el.paused && audible.wants(), "a touch that does not count leaves it refused, and still wanted");

  doc.gesture = true;                               // the finger lifting: the gesture
  audible.open();
  await settle();
  check(audible.state.loop === "playing" && !el.paused && !audible.wants(), "the touch that counts starts the loop");
  check(doc.made.length === 1, "the same element is used again, not a second one");
  const plays = el.plays;
  audible.open();
  await settle();
  check(el.plays === plays && audible.state.loop === "playing", "another touch while it plays asks for nothing more");

  audible.rest();
  check(el.paused && audible.state.loop === "resting" && audible.wants(), "the band stops: the loop stops with it");
  audible.open();
  await settle();
  check(!el.paused && audible.state.loop === "playing", "the band starts again: so does the loop");
}

console.log("on an older iPhone, with no audio session to set");
{
  const nav = { userAgent: IPHONE, maxTouchPoints: 5 };
  const doc = fakeDocument();
  doc.gesture = true;
  const audible = createAudible({ ctx: { sampleRate: 44100 }, nav, doc });
  audible.open();
  await settle();
  check(audible.state.session === null && audible.state.loop === "playing", "the silent loop alone carries it");
}

console.log("where the audio session refuses the setting");
{
  const session = {};
  Object.defineProperty(session, "type", { get: () => "auto", set: () => { throw new Error("not supported"); } });
  const doc = fakeDocument();
  doc.gesture = true;
  const audible = createAudible({ ctx: { sampleRate: 48000 }, nav: { userAgent: IPHONE, maxTouchPoints: 5, audioSession: session }, doc });
  let threw = false;
  try { audible.open(); } catch { threw = true; }
  await settle();
  check(!threw && audible.state.loop === "playing", "open() does not throw, and the loop still starts");
}

console.log("on everything else");
{
  for (const [name, ua, touch] of [["an Android phone", ANDROID, 5], ["a Windows laptop", WINDOWS, 0], ["a Mac", MAC, 0]]) {
    const doc = fakeDocument();
    doc.gesture = true;
    const audible = createAudible({ ctx: { sampleRate: 48000 }, nav: { userAgent: ua, maxTouchPoints: touch }, doc });
    audible.open();
    audible.rest();
    await settle();
    check(doc.made.length === 0 && audible.state.loop === "none" && audible.state.session === null && !audible.wants(), `${name}: nothing is made, nothing is changed`);
  }
}

console.log("where it is used");
{
  const player = readFileSync(new URL("./player.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const desk = readFileSync(new URL("./listen.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  check(/audible\.open\(\);\s*\n\s*ctx\.resume\(\)/.test(player), "the home page's band opens it inside the gesture, before it resumes the context");
  check((player.match(/audible\.open\(\)/g) || []).length >= 3 && /audible\.rest\(\)/.test(player), "on the button, on a touch anywhere, on a touch after the phone took the sound; and it rests when the band stops");
  check(/"touchend"/.test(player) && /"click"/.test(player), "the touches that count on a phone are listened for: the finger lifting, and a click");
  const toggle = desk.slice(desk.indexOf("async function toggle()"));
  check(toggle.indexOf("audible.open()") > 0 && toggle.indexOf("audible.open()") < toggle.indexOf("await "), "the desk opens it in the press itself, before anything is awaited");
}

const report = failures.length
  ? `\nFAIL ${failures.length} of ${assertions} assertions\n  - ${failures.join("\n  - ")}`
  : `\nPASS ${assertions} assertions`;
console.log(report);
process.exit(failures.length ? 1 : 0);
