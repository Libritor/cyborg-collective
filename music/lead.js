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
  // A sus chord has no third to decide with, and the major pentatonic's third
  // sits a semitone above the sus4's fourth -- an avoid note on the one bar the
  // strip is meant to fit. So a sus takes a pentatonic with no third at all:
  // 1 2 4 5 b7, which contains both chord members and nothing that rubs them.
  sus: Object.freeze([0, 2, 5, 7, 10]),
});

export const MAX_VOICES = 6;

/**
 * The patch with no headband: the C dial stands in for the head. Its position is
 * read as beta (brightness), its complement as alpha (the odd/even morph), and
 * steadiness with it, so dragging the one dial visibly sweeps the wave from
 * hollow-and-dark to full-and-bright. It is the same mapping as patchFrom, fed a
 * stand-in head -- a choice, like the rest of the patch, but a stated one.
 */
export function patchFromSlider(C) {
  const value = Math.min(1, Math.max(0, Number.isFinite(C) ? C : 0.45));
  return patchFrom({
    alphaShare: 1 - value,
    betaShare: value,
    steadiness: value,
    arousal: value,
    motion: 0.15,
  });
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const mtof = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** Which pentatonic family a chord quality takes: "major", "minor" or "sus". */
export function pentatonicFamily(quality) {
  const q = String(quality || "min");
  if (q === "sus4" || q === "sus2") return "sus";
  if (q === "minmaj7") return "minor";     // its third is minor
  return q.startsWith("maj") ? "major" : "minor";
}

/** The same question as a flag, for callers that only need the major reading. */
export function isMajorQuality(quality) {
  return pentatonicFamily(quality) === "major";
}

/**
 * The chord's pentatonic, as ten midi notes rising through the keyboard's range.
 * The first note is the chord's own root, so the key strip always starts on the
 * chord you are hearing rather than on a fixed tonic.
 */
export function pentatonicNotes(chord, range = LEAD_RANGE) {
  const [lo, hi] = range;
  const root = num(chord && chord.root) ?? 57;
  const family = pentatonicFamily(chord && chord.quality);
  const intervals = PENTATONIC[family];
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
    family,
    major: family === "major",
    name: `${noteName(base)} ${family === "sus" ? "sus" : family} pentatonic`,
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

/**
 * A waveform, drawn from the patch's own harmonics: the sum of the sine terms the
 * wavetable is built from, normalised by the worst-case sum so the trace can
 * never leave its box. This is the shape the oscillators are playing, not an
 * illustration of one.
 */
export function waveformPath(amplitudes, { width = 132, height = 52, points = 96 } = {}) {
  const amps = amplitudes || [];
  let worst = 0;
  for (let n = 1; n < amps.length; n += 1) worst += Math.abs(amps[n]);
  const norm = worst > 0 ? 1 / worst : 1;
  const mid = height / 2;
  const swing = height / 2 - 2;
  const parts = [];
  for (let i = 0; i <= points; i += 1) {
    const t = i / points;
    let sum = 0;
    for (let n = 1; n < amps.length; n += 1) sum += amps[n] * Math.sin(2 * Math.PI * n * t);
    const x = (t * width).toFixed(2);
    const y = (mid - sum * norm * swing).toFixed(2);
    parts.push(`${i === 0 ? "M" : "L"} ${x} ${y}`);
  }
  return parts.join(" ");
}

/**
 * The scale as a ladder: ten notes, x by position, y by pitch. The shape is the
 * pentatonic itself -- two small steps and a wide one -- so a glance shows whether
 * the strip is a minor pentatonic or the sus scale with no third.
 */
export function scaleLadder(notes, { width = 132, height = 52 } = {}) {
  const list = Array.isArray(notes) ? notes : [];
  if (!list.length) return { d: "", dots: [] };
  const lo = Math.min(...list);
  const hi = Math.max(...list);
  const span = Math.max(1, hi - lo);
  const dots = list.map((midi, i) => ({
    x: (4 + (i * (width - 8)) / Math.max(1, list.length - 1)),
    y: (height - 5 - ((midi - lo) / span) * (height - 10)),
  }));
  const d = dots.map((dot, i) => `${i === 0 ? "M" : "L"} ${dot.x.toFixed(1)} ${dot.y.toFixed(1)}`).join(" ");
  return { d, dots };
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
 * `level` (0.92) and the ceiling (0.95) are why the lead is mixed *after* the band's compressor
 * (the page connects `out` to the fader, and pulls the band's duck down while a
 * key is held). Mixed into the voice sum instead, the compressor held the total
 * and the lead could not be heard: measured, five voices at level 1.5 moved the
 * master RMS 1.1 dB while driving the sum to 1.32. 0.92 puts one note above the
 * band's own RMS once the duck has stepped the band back. Measured with the
 * limiter in front of it: one key peaks at 0.71 and six at 0.79, with no sample
 * touching the ceiling at any polyphony -- the curve is a backstop, not a voice.
 */
export const LEAD_CEILING = 0.95;
/**
 * How far above the ceiling a signal may sit before the shaper's own [-1, 1] input
 * domain clamps it. A WaveShaper curve covers ±1 and *hard-clamps* anything past
 * it -- the same trap the band's saturator had -- and six voices sum to about ±6,
 * so a curve drawn for a single voice was clamping every chord into a square wave.
 * The signal is scaled into the domain and back out again, which puts the real
 * soft ceiling at ±HEADROOM.
 */
export const LEAD_HEADROOM = 8;

/**
 * A soft ceiling for the lead's own output: y = c·tanh(x/c), unity for small
 * signals and flattening near c, drawn over a domain of ±headroom so nothing can
 * reach the clamp.
 *
 * c is 0.95, not 0.7: measured, a single note's attack already peaks at 0.69, so a
 * 0.7 ceiling was flattening every chord -- 326 of 2048 samples sat on the flat top
 * with six keys down. At 0.95 the curve is transparent for one note and only leans
 * on transients, and 0.95 before the fader is 0.475 after it, which the mix can
 * afford: the ducked band peaks at 0.41.
 */
export function ceilingCurve({ ceiling = LEAD_CEILING, headroom = LEAD_HEADROOM, points = 2048 } = {}) {
  const curve = new Float32Array(points);
  const scale = ceiling / headroom;
  for (let i = 0; i < points; i += 1) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = scale * Math.tanh((x * headroom) / ceiling);
  }
  return curve;
}

export function createLeadPatch(ctx, { level = 0.92, headroom = LEAD_HEADROOM } = {}) {
  //   voices -> voiceBus(level, 1/sqrt n) -> limiter -> domain scale -> soft ceiling
  //          -> domain scale back -> out
  const out = ctx.createGain();          // the page connects to this
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.8;
  filter.frequency.value = 2600;
  const voiceBus = ctx.createGain();     // level, and polyphony compensation

  // A chord is not six times a note, and these voices are *partly coherent* -- a
  // pentatonic shares harmonics, so its notes add in phase at the low partials.
  // Measured: 1/sqrt(n) let three keys peak 2.2 dB above one; 1/n^0.65 still let
  // six reach the ceiling; 1/n made a chord 6 dB quieter than a single note, which
  // is worse than either. So the bus compensates for loudness only, and a fast
  // limiter -- not louder arithmetic -- catches what coherence adds.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -4;          // about 0.63: under the ceiling, over a note
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;          // fast enough for a key's own attack
  limiter.release.value = 0.12;

  const into = ctx.createGain();         // scales the signal into the curve's domain
  into.gain.value = 1 / headroom;
  const ceiling = ctx.createWaveShaper();
  ceiling.curve = ceilingCurve({ headroom });
  ceiling.oversample = "2x";
  const outOf = ctx.createGain();        // ...and the domain's scale back out
  outOf.gain.value = headroom;

  filter.connect(voiceBus);
  voiceBus.connect(limiter);
  limiter.connect(into);
  into.connect(ceiling);
  ceiling.connect(outOf);
  outOf.connect(out);

  let patch = { ...DEFAULT_PATCH };
  let wave = null;
  let voices = [];

  const POLYPHONY_EXPONENT = 0.5;
  const setBus = (immediate = false) => {
    const gain = level / Math.max(1, voices.length) ** POLYPHONY_EXPONENT;
    const now = ctx.currentTime;
    voiceBus.gain.cancelScheduledValues(now);
    if (immediate) voiceBus.gain.setValueAtTime(gain, now);
    else voiceBus.gain.setTargetAtTime(gain, now, 0.02);
  };
  setBus(true);

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
    setBus();
  };

  const start = (midi, at = ctx.currentTime) => {
    const t = Math.max(at, ctx.currentTime);
    // the count goes up before the oscillators start: otherwise a chord's attack
    // is played at the previous, louder gain, which is exactly the transient that
    // was poking the ceiling
    const slot = { midi, env: null, oscs: [], started: t, release: null };
    voices = voices.concat(slot);
    setBus(true);
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
    slot.env = env;
    slot.oscs = oscs;
    slot.release = () => stop(slot, ctx.currentTime);
    // steal the oldest rather than refuse a key: ten keys, six voices
    while (voices.length > MAX_VOICES) stop(voices[0], ctx.currentTime);
    return slot;
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
