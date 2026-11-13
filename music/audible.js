// Sound that a phone lets its owner hear.
//
// On an iPhone or iPad, what a page plays through the Web Audio API counts as "ambient" sound, like a game's: the
// ring/silent switch on the side of the phone silences it. The page runs, the audio context reports "running", the
// wand sweeps, the status line says the band is playing, and nothing is heard. Music a person started counts as
// "playback", which the switch leaves alone. There are two ways for a page to say that its sound is playback, and
// both are used here, because neither can be checked from a desk (only an iPhone has the switch):
//
//   1. navigator.audioSession.type = "playback", where the browser has it (Safari 16.4 and later);
//   2. a silent sound in an <audio> element, looping for as long as the band plays: while a media element is
//      playing, the page's Web Audio is carried along with it as playback. This is the older way, and the only one
//      on an older iOS. The silence is made at the audio context's own sample rate, because iOS distorts Web Audio
//      when a media element at another rate starts beside it.
//
// Both only work inside a tap or a key press, so open() is called from the page's gesture handlers, each time.
//
// What it costs, on those devices only: playback pauses music that another app was playing, where ambient sound
// would have mixed with it (a video's sound does the same). On any other device open() does nothing at all.

/** An iPhone, an iPod touch, or an iPad (which calls itself a Macintosh but has a touch screen). */
export function isAppleTouch(nav = globalThis.navigator) {
  if (!nav) return false;
  const ua = String(nav.userAgent || "");
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
}

/** The bytes of a WAV file of silence: one channel, 8 bits, at the given rate. */
export function silentWav(sampleRate, seconds = 0.5) {
  const rate = Math.max(8000, Math.round(sampleRate) || 44100);
  const n = Math.max(1, Math.round(rate * seconds));
  const bytes = new Uint8Array(44 + n);
  const view = new DataView(bytes.buffer);
  const text = (at, word) => { for (let i = 0; i < word.length; i += 1) bytes[at + i] = word.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, 36 + n, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // plain samples (PCM)
  view.setUint16(22, 1, true);            // one channel
  view.setUint32(24, rate, true);         // samples a second
  view.setUint32(28, rate, true);         // bytes a second: one channel of one byte
  view.setUint16(32, 1, true);            // bytes per sample frame
  view.setUint16(34, 8, true);            // bits per sample
  text(36, "data"); view.setUint32(40, n, true);
  bytes.fill(128, 44);                    // 8-bit samples are unsigned: 128 is the middle, which is silence
  return bytes;
}

/** Those bytes as an address an <audio> element can play without asking any server. */
export function wavDataUri(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return "data:audio/wav;base64," + btoa(binary);
}

/**
 * open(): call inside a tap or key press, before the context is resumed; safe to call on every one.
 * rest(): the band has stopped, or the page is hidden: the silent loop stops with it.
 * state.session is what the browser's audio session was set to (null where there is none); state.loop is
 * "none" (not an Apple touch device, nothing was made), "asked", "playing", "refused" (this touch did not count
 * as a gesture: the next one asks again) or "resting".
 */
export function createAudible({ ctx, nav = globalThis.navigator, doc = globalThis.document } = {}) {
  const state = { apple: isAppleTouch(nav), session: null, loop: "none" };
  let silence = null;

  function open() {
    try {
      if (nav && nav.audioSession) {
        if (nav.audioSession.type !== "playback") nav.audioSession.type = "playback";
        state.session = nav.audioSession.type;
      }
    } catch { /* a browser that has the object but not this setting: the loop below is its way */ }
    if (!state.apple || !doc) return state;
    try {
      if (!silence) {
        silence = doc.createElement("audio");
        silence.setAttribute("x-webkit-airplay", "deny");       // nothing to send to another room
        silence.preload = "auto";
        silence.loop = true;
        silence.src = wavDataUri(silentWav(ctx ? ctx.sampleRate : 44100));
      }
      if (state.loop !== "playing" || silence.paused) {
        state.loop = "asked";
        const asked = silence.play();
        if (asked && asked.then) {
          asked.then(() => { if (!silence.paused) state.loop = "playing"; },
                     () => { if (silence.paused && state.loop === "asked") state.loop = "refused"; });
        }
      }
    } catch {
      state.loop = "refused";
    }
    return state;
  }

  function rest() {
    if (!silence) return;
    try { silence.pause(); } catch { /* nothing was playing */ }
    state.loop = "resting";
  }

  /** True where a touch could still make the band audible: the loop is wanted and is not playing. */
  const wants = () => state.apple && state.loop !== "playing";

  return { open, rest, wants, state };
}
