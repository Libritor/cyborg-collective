// The lead: a pentatonic keyboard that follows the chord, and a wavetable patch
// the chosen muse morphes.
//
// Two halves, deliberately separable. `pentatonicNotes` and `harmonicAmplitudes`
// are pure arithmetic, so node can assert that the key strip really is the chord's
// scale and that the wavetable really is the shape the numbers describe. The voice
// itself needs Web Audio and is only ever built in a page.
//
// The mapping from a head's signals to the patch is a *design choice*, not a rule
// of the grammar: alpha hollows the wave (odd harmonics), beta opens the filter,
// steadiness widens the detune, movement wobbles the morph, activation drives the
// filter. It is written down here so the choice is visible, and it is applied once
// per bar, like everything else the band does.

import { noteName } from "./explain.js";

/** Two octaves of a five-note scale: ten keys, which is one row of a computer. */
export const KEYS = Object.freeze([
  ["a", 0], ["s", 1], ["d", 2], ["f", 3], ["g", 4],
  ["h", 5], ["j", 6], ["k", 7], ["l", 8], [";", 9],
]);

/** The keyboard's register. The top is set by the widest case: a ten-note minor
 *  pentatonic from the highest possible root (base 68) reaches 90, so the window
 *  never clips the strip down to eight keys. */
export const LEAD_RANGE = Object.freeze([57, 92]);   // A3 .. G#6

export const PENTATONIC = Object.freeze({
  minor: Object.freeze([0, 3, 5, 7, 10]),
  major: Object.freeze([0, 2, 4, 7, 9]),
});

export const MAX_VOICES = 6;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const mtof = (midi) => 440 * 2 ** ((midi - 69) / 12);

/**
 * Which pentatonic a chord takes. The rule is the quality's own name: anything
 * starting `maj` is major, minor-major included in the minor family because its
 * third is minor, and a sus chord has no third to decide with so it takes the
 * major pentatonic (the brighter reading of an ambiguous chord).
 */
export function isMajorQuality(quality) {
  const q = String(quality || "min");
  if (q === "sus4" || q === "sus2") return true;
  if (q === "minmaj7") return false;
  return q.startsWith("maj");
}

/**
 * The chord's pentatonic, as ten midi notes rising through the keyboard's range.
 * The first note is the chord's own root, so the key strip always starts on the
 * chord you are hearing rather than on a fixed tonic.
 */
export function pentatonicNotes(chord, range = LEAD_RANGE) {
  const [lo, hi] = range;
  const root = num(chord && chord.root) ?? 57;
  const major = isMajorQuality(chord && chord.quality);
  const intervals = major ? PENTATONIC.major : PENTATONIC.minor;
  const rootPc = ((root % 12) + 12) % 12;
  // the lowest root at or above the bottom of the range
  const base = lo + (((rootPc - lo) % 12) + 12) % 12;
  const notes = [];
  for (let octave = 0; octave < 3 && notes.length < KEYS.length; octave += 1) {
    for (const interval of intervals) {
      if (notes.length >= KEYS.length) break;
      const midi = base + octave * 12 + interval;
      // a ten-note pentatonic from the highest root stays inside the window by
      // construction, so this is a guard, not a rule the strip depends on
      if (midi > hi) break;
      notes.push(midi);
    }
  }
  return {
    notes,
    major,
    name: `${noteName(base)} ${major ? "major" : "minor"} pentatonic`,
  };
}

/**
 * The wavetable's harmonic amplitudes, from the patch's two spectral controls.
 *
 * `brightness` sets the tilt: a bright patch falls away as 1/n^0.9, a dark one as
 * 1/n^2.5. `morph` sets an odd/even bias -- at morph 1 the odd harmonics double
 * and the even ones nearly vanish, which is the hollow, clarinet-like shape; at 0
 * the wave is the plain saw-ish stack of every harmonic. createPeriodicWave
 * normalises, so morphing never changes the loudness, only the colour.
 */
export function harmonicAmplitudes(patch = {}, count = 16) {
  const brightness = clamp01(num(patch.brightness) ?? 0.6);
  const morph = clamp01(num(patch.morph) ?? 0.4);
  const tilt = 0.9 + 1.6 * (1 - brightness);
  const odd = morph * 0.9;
  const out = new Float32Array(count + 1);   // index 0 is DC of a sine wave: 0
  for (let n = 1; n <= count; n += 1) {
    const bias = n % 2 ? odd : -odd;
    out[n] = (1 / n ** tilt) * (1 + bias);
  }
  return out;
}

export const DEFAULT_PATCH = Object.freeze({
  morph: 0.4, brightness: 0.6, drive: 0.4, detune: 6, jitter: 0,
});

/**
 * The patch a head's signals describe. Every line is a choice made here, not a
 * rule the grammar imposes: alpha hollows, beta brightens, steadiness widens the
 * two-oscillator detune, movement adds a slow wobble to the morph, activation
 * pushes the drive. Missing signals fall back to a normal patch rather than to
 * zero, so a head that has not reported yet does not silence the lead.
 */
export function patchFrom(source = {}) {
  const alpha = num(source.alphaShare);
  const beta = num(source.betaShare);
  const motion = num(source.motion);
  const arousal = num(source.arousal);
  const steadiness = num(source.steadiness);
  return {
    morph: clamp01((alpha ?? 0.35) * 1.4),
    brightness: clamp01(0.2 + (beta ?? 0.4) * 1.4),
    drive: clamp01(arousal ?? 0.4),
    detune: 2 + 10 * clamp01(steadiness ?? 0.5),
    jitter: clamp01((motion ?? 0.2) * 2),
  };
}

/**
 * A small wavetable voice. One shared lowpass and one shared output, two detuned
 * oscillators and a short envelope per note: enough to be an instrument, cheap
 * enough to be born in a page. The patch is rebuilt on the oscillators when the
 * muse moves, including under sounding notes, so a held chord keeps up.
 *
 * `level` (1.1) and the ceiling (0.7) are why the lead is mixed *after* the band's compressor
 * (the page connects `out` to the fader, and pulls the band's duck down while a
 * key is held). Mixed into the voice sum instead, the compressor held the total
 * and the lead could not be heard: measured, five voices at level 1.5 moved the
 * master RMS 1.1 dB while driving the sum to 1.32. 1.1 puts one note above the
 * band's own RMS once the duck has stepped the band back, and the ceiling keeps
 * ten fingers inside the mix's headroom: measured, five voices peak at -1.3 dBFS
 * with eleven of headroom left.
 */
export const LEAD_CEILING = 0.7;

/**
 * A soft ceiling for the lead's own output: y = c·tanh(x/c), which is unity for
 * small signals and flattens near c. Below it a single note is untouched; above
 * it, five keys held at once lean on the curve instead of pushing the voice sum
 * past the waveshaper's [-1, 1] domain (measured at 1.32 without it).
 */
export function ceilingCurve(ceiling = LEAD_CEILING, points = 1024) {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i += 1) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = ceiling * Math.tanh(x / ceiling);
  }
  return curve;
}

export function createLeadPatch(ctx, { level = 1.1 } = {}) {
  const out = ctx.createGain();          // the page connects to this
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.8;
  filter.frequency.value = 2600;
  const voiceBus = ctx.createGain();     // the whole patch's level, pre-ceiling
  voiceBus.gain.value = level;
  const limiter = ctx.createWaveShaper();
  limiter.curve = ceilingCurve();
  limiter.oversample = "2x";
  filter.connect(voiceBus);
  voiceBus.connect(limiter);
  limiter.connect(out);

  let patch = { ...DEFAULT_PATCH };
  let wave = null;
  let voices = [];

  const build = () => {
    const imag = harmonicAmplitudes(patch);
    const real = new Float32Array(imag.length);
    wave = ctx.createPeriodicWave(real, imag);
    const cutoff = 300 + 7000 * clamp01(patch.brightness);
    filter.frequency.cancelScheduledValues(ctx.currentTime);
    filter.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.25);
    filter.Q.setTargetAtTime(0.6 + 3.5 * clamp01(patch.drive), ctx.currentTime, 0.25);
    for (const voice of voices) for (const osc of voice.oscs) osc.setPeriodicWave(wave);
  };

  const stop = (voice, at) => {
    const t = Math.max(at, ctx.currentTime);
    voice.env.gain.cancelScheduledValues(t);
    voice.env.gain.setValueAtTime(voice.env.gain.value, t);
    voice.env.gain.linearRampToValueAtTime(0, t + 0.18);
    for (const osc of voice.oscs) {
      try { osc.stop(t + 0.22); } catch { /* already stopped */ }
    }
    voices = voices.filter((v) => v !== voice);
  };

  const start = (midi, at = ctx.currentTime) => {
    const t = Math.max(at, ctx.currentTime);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.012);
    env.gain.linearRampToValueAtTime(0.72, t + 0.16);
    env.connect(filter);
    const oscs = [-patch.detune, patch.detune].map((cents) => {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.setValueAtTime(mtof(midi), t);
      osc.detune.setValueAtTime(cents, t);
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      osc.connect(gain);
      gain.connect(env);
      osc.start(t);
      return osc;
    });
    const voice = { midi, env, oscs, started: t, release: () => stop(voice, ctx.currentTime) };
    voices = voices.concat(voice);
    // steal the oldest rather than refuse a key: ten keys, six voices
    while (voices.length > MAX_VOICES) stop(voices[0], ctx.currentTime);
    return voice;
  };

  build();

  return {
    out,
    /** The patch in force, for the page to print. */
    get patch() { return { ...patch }; },
    setPatch(next = {}) {
      const merged = { ...patch, ...next };
      const changed = Object.keys(merged).some((key) => merged[key] !== patch[key]);
      patch = merged;
      if (changed) build();
      return { ...patch };
    },
    /** A note that sounds for `seconds` and stops itself. */
    play(midi, seconds = 0.5) {
      const voice = start(midi);
      const timer = setTimeout(() => voice.release(), seconds * 1000);
      return { stop: () => { clearTimeout(timer); voice.release(); } };
    },
    /** A note held until released, for a finger on a key. */
    hold(midi) { return start(midi); },
    release(midi) {
      for (const voice of voices.filter((v) => v.midi === midi)) stop(voice, ctx.currentTime);
    },
    get voices() { return voices.length; },
    close() {
      for (const voice of [...voices]) stop(voice, ctx.currentTime);
      out.disconnect();
    },
  };
}
