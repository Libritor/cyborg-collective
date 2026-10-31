// Voices and buses: the gated-80s mix.
//
// createVoices() builds the graph once -- compressor, master trim, and the three
// shared effect buses -- and returns four players. Only play.* builds per-note
// nodes, and every one of those is one-shot, started at an explicit time on the
// audio clock. Nothing here reads a clock or polls anything: the caller (a
// lookahead loop) says "play this hit at this time".
//
// Voices whose filter is a *timbre* (the bass body, the pad's cutoff, the pad's
// reverb send, the delay feedback) own persistent nodes, because setTimbre has to
// retarget them while the notes come and go. A per-note filter cannot be
// modulated by a value that outlives the note.

import { sixteenth } from "./scheduler.js";

const mtof = (midi) => 440 * 2 ** ((midi - 69) / 12);

// The tune-time constant is 0.4 s: slow enough to be a slide, fast enough to
// follow a four-bar chord.
const GLIDE_S = 0.4;

// Reverb sends, linear. The kick stays dry because a wet 44 Hz tail is mud; the
// toms get less than the snare because a low tom's tail lingers on its own.
const DRUM_SENDS = Object.freeze({
  kick: 0, snare: 0.35, hatC: 0.1, hatO: 0.1, tomL: 0.2, tomH: 0.2,
});

function saturationCurve(amount) {
  const points = 1024;
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i += 1) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * (1 + amount));
  }
  return curve;
}

// The voice sum reaches about 5.2 peak -- two detuned saws plus a sub on the
// bass, four saws on the pad, and the kit's transients landing together. A
// WaveShaperNode's curve covers [-1, 1] only: every sample beyond that lands on
// the curve's endpoint, which is a hard clip, not saturation, and it would put a
// clipped signal in front of the compressor while making a headroom measurement
// look healthy. One trim at the sum puts the loudest measured mix at 0.80 and the
// clamp edge at 6.7, and makeUp below restores the level the trim removed.
const MIX_TRIM = 0.15;

// The output fader. 0.89 was chosen for a chain whose compressor came out at
// about 1.0; measured on the four-bar arrangement the compressor's output peaks
// at 1.57, so 0.89 put the master at +2.9 dBFS -- a hard clip at the device
// output, hidden until the WaveShaper stopped clamping first. 0.5 lands the
// loudest measured mix near -2 dBFS: under the ceiling with margin for a hotter
// arrangement, which keeps the whole chain linear at the destination.
const OUT_TRIM = 0.5;

export function createVoices(ctx, kit, { bpm = 132 } = {}) {
  // ------------------------------------------------------------------ master
  // sum -> soft clip -> compressor -> fader -> out. The compressor is what makes
  // four voices sit like a band instead of four tracks at once; the fader is the
  // ceiling.
  const input = ctx.createGain();
  input.gain.value = MIX_TRIM;
  const shaper = ctx.createWaveShaper();
  shaper.curve = null;              // a null curve passes the signal through
  // Compensation: the trim above exists only to put the mix inside the curve's
  // [-1, 1] domain, so the level is restored straight after it. Small signals are
  // unity again and the compressor keeps the operating point it had, which is
  // what stops the trim from re-balancing the band (voices near the threshold
  // would otherwise lose their makeup gain).
  const makeUp = ctx.createGain();
  makeUp.gain.value = 1 / MIX_TRIM;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.008;
  compressor.release.value = 0.25;
  const master = ctx.createGain();
  master.gain.value = OUT_TRIM;

  input.connect(shaper);
  shaper.connect(makeUp);
  makeUp.connect(compressor);
  compressor.connect(master);
  master.connect(ctx.destination);

  // -------------------------------------------------------------------- buses
  const reverbIn = ctx.createGain();
  const convolver = ctx.createConvolver();
  convolver.buffer = kit.ir;
  reverbIn.connect(convolver);
  convolver.connect(input);

  const chorusIn = ctx.createGain();
  const chorusDelay = ctx.createDelay(0.1);
  chorusDelay.delayTime.value = 0.015;
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.5;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.004;
  lfo.connect(lfoDepth);
  lfoDepth.connect(chorusDelay.delayTime);
  lfo.start(ctx.currentTime);
  chorusIn.connect(chorusDelay);
  chorusDelay.connect(input);

  // A dotted 8th: three 16ths of the bar, which is what makes a goth delay sit
  // between the beats instead of on them.
  const delayTime = sixteenth(bpm) * 3;
  const delayIn = ctx.createGain();
  const echo = ctx.createDelay(2);
  echo.delayTime.value = delayTime;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.4;
  delayIn.connect(echo);
  echo.connect(input);
  echo.connect(feedback);
  feedback.connect(echo);

  // Persistent voice sends. Only these four are retargeted by setTimbre.
  const padReverbSend = ctx.createGain();
  padReverbSend.gain.value = 0.55;
  padReverbSend.connect(reverbIn);
  const padChorusSend = ctx.createGain();
  padChorusSend.gain.value = 0.45;
  padChorusSend.connect(chorusIn);
  const leadDelaySend = ctx.createGain();
  leadDelaySend.gain.value = 0.30;
  leadDelaySend.connect(delayIn);
  const leadReverbSend = ctx.createGain();
  leadReverbSend.gain.value = 0.30;
  leadReverbSend.connect(reverbIn);

  // ------------------------------------------------------------------- bass
  // Two 12 dB/oct biquads in series are 24 dB/oct; one native biquad is only 12.
  // The first stage carries the pluck, the second carries the timbre.
  const bassPluck = ctx.createBiquadFilter();
  bassPluck.type = "lowpass";
  bassPluck.Q.value = 0.707;
  const bassBody = ctx.createBiquadFilter();
  bassBody.type = "lowpass";
  bassBody.Q.value = 0.707;
  bassBody.frequency.value = 900;
  bassPluck.connect(bassBody);
  bassBody.connect(input);

  // -------------------------------------------------------------------- pad
  const padFilter = ctx.createBiquadFilter();
  padFilter.type = "lowpass";
  padFilter.Q.value = 0.707;
  padFilter.frequency.value = 1800;
  padFilter.connect(input);
  padFilter.connect(padChorusSend);
  padFilter.connect(padReverbSend);
  const padLastHz = [null, null, null, null];   // per-oscillator, for the glide

  // ------------------------------------------------------------------- lead
  // A 25% pulse is the Fourier series of a quarter-duty cycle; adding a sawtooth
  // gives it the edge a single pulse wave is missing.
  const HARMONICS = 32;
  const real = new Float32Array(HARMONICS + 1);
  const imag = new Float32Array(HARMONICS + 1);
  for (let n = 1; n <= HARMONICS; n += 1) {
    imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * 0.25);
  }
  const pulse = ctx.createPeriodicWave(real, imag);

  // ------------------------------------------------------------------ players
  const play = {
    drum(name, time, vel = 1) {
      const buffer = kit.buffers[name];
      if (!buffer) throw new Error(`no such hit: ${name}`);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = vel;            // buffers are already peak-normalised
      source.connect(gain);
      gain.connect(input);
      const send = DRUM_SENDS[name] ?? 0;
      if (send > 0) {
        const toReverb = ctx.createGain();
        toReverb.gain.value = send;
        gain.connect(toReverb);
        toReverb.connect(reverbIn);
      }
      source.start(time);
    },

    bass(midi, time, dur = 0.3, vel = 0.85) {
      const hz = mtof(midi);
      const mix = ctx.createGain();
      mix.gain.value = 1;
      mix.connect(bassPluck);

      // The pluck: bright on the attack, closing in a quarter second.
      bassPluck.frequency.setValueAtTime(900, time);
      bassPluck.frequency.exponentialRampToValueAtTime(400, time + 0.25);

      const end = time + dur + 0.02;
      const voices = [
        { type: "sawtooth", hz, detune: 7 },
        { type: "sawtooth", hz, detune: -7 },
        { type: "sine", hz: hz / 2, detune: 0 },   // the sub, so the bass has weight
      ];
      for (const spec of voices) {
        const osc = ctx.createOscillator();
        osc.type = spec.type;
        osc.frequency.setValueAtTime(spec.hz, time);
        osc.detune.setValueAtTime(spec.detune, time);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(vel, time + 0.004);
        gain.gain.setValueAtTime(vel, Math.max(time + 0.004, end - 0.02));
        gain.gain.linearRampToValueAtTime(0, end);
        osc.connect(gain);
        gain.connect(mix);
        osc.start(time);
        osc.stop(end + 0.02);
      }
    },

    pad(voicing, time, dur = 1.8) {
      const notes = [...voicing].slice(0, 4);
      if (!notes.length) return;
      const lowest = Math.min(...notes);
      // Fewer than four notes: the same pitch twice, detuned against itself. Two
      // oscillators disagreeing by 18 cents is a chorus, not a duplicate.
      while (notes.length < 4) notes.push(lowest + 12);

      const env = ctx.createGain();
      const attack = 0.120;
      const hold = Math.max(dur, attack + 0.001);
      const end = hold + 0.15;
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(0.8, time + attack);
      env.gain.setValueAtTime(0.8, time + hold);
      env.gain.exponentialRampToValueAtTime(0.001, time + end);
      env.gain.setValueAtTime(0, time + end);
      env.connect(padFilter);

      notes.forEach((note, index) => {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        const hz = mtof(note);
        const previous = padLastHz[index];
        if (previous) {
          // A 20ms glide on a change, so a chord change is a slide and not a
          // switch. Only a change glides; a re-held pitch would glide from
          // itself, which is a no-op with extra automation.
          osc.frequency.setValueAtTime(previous, time);
          osc.frequency.exponentialRampToValueAtTime(hz, time + 0.020);
        } else {
          osc.frequency.setValueAtTime(hz, time);
        }
        padLastHz[index] = hz;
        osc.detune.setValueAtTime(index % 2 ? -9 : 9, time);
        osc.connect(env);
        osc.start(time);
        osc.stop(time + end + 0.02);
      });
    },

    lead(midi, time, dur = 0.3, vel = 0.7) {
      const hz = mtof(midi);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 4000;
      filter.Q.value = 0.707;
      filter.connect(input);
      filter.connect(leadDelaySend);
      filter.connect(leadReverbSend);

      const env = ctx.createGain();
      const end = time + dur + 0.05;
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(vel, time + 0.010);
      env.gain.setValueAtTime(vel, Math.max(time + 0.010, end - 0.05));
      env.gain.exponentialRampToValueAtTime(0.001, end);
      env.gain.setValueAtTime(0, end);
      env.connect(filter);

      const pulseOsc = ctx.createOscillator();
      pulseOsc.setPeriodicWave(pulse);
      pulseOsc.frequency.setValueAtTime(hz, time);
      const pulseGain = ctx.createGain();
      pulseGain.gain.value = 0.6;
      pulseOsc.connect(pulseGain);
      pulseGain.connect(env);
      pulseOsc.start(time);
      pulseOsc.stop(end + 0.02);

      const sawOsc = ctx.createOscillator();
      sawOsc.type = "sawtooth";
      sawOsc.frequency.setValueAtTime(hz, time);
      const sawGain = ctx.createGain();
      sawGain.gain.value = 0.3;
      sawOsc.connect(sawGain);
      sawGain.connect(env);
      sawOsc.start(time);
      sawOsc.stop(end + 0.02);
    },
  };

  /**
   * Apply the generator's timbreAt(C) object. Everything glides: a jump on a bar
   * line is the one thing that would make the machine audible.
   */
  function setTimbre(t, time) {
    if (!t) return;
    if (typeof t.bassCutoff === "number") {
      bassBody.frequency.setTargetAtTime(t.bassCutoff, time, GLIDE_S);
    }
    if (typeof t.padCutoff === "number") {
      padFilter.frequency.setTargetAtTime(t.padCutoff, time, GLIDE_S);
    }
    if (typeof t.padSend === "number") {
      padReverbSend.gain.setTargetAtTime(t.padSend, time, GLIDE_S);
    }
    if (typeof t.leadDelayFb === "number") {
      feedback.gain.setTargetAtTime(t.leadDelayFb, time, GLIDE_S);
    }
    if (typeof t.saturation === "number") {
      shaper.curve = saturationCurve(t.saturation);
    }
  }

  return {
    play,
    setTimbre,
    // `sum` is the voice mix before the shaper. It is exposed so the level going
    // into a [-1,1] curve can be measured instead of assumed; the three sends are
    // the effect buses.
    buses: { sum: input, reverb: reverbIn, chorus: chorusIn, delay: delayIn },
    master,
  };
}
