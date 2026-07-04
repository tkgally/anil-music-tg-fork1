/* ---------------------------------------------------------------------
   01 · Tides — audio.js

   Concept: a fixed pedal drone with 5 detuned-saw voices holding a
   chord voiced in just intonation over it. Three incommensurate LFOs
   (audio-rate oscillators driving AudioParams, so they survive hidden
   tabs) breathe the filter, level and stereo tilt. Harmony moves as
   weather: every "drift" one voice at a time glides to the next chord.

   Parameter model: main.js owns the state object and calls
   Tides.applyParams(P) on every change; smooth params land via
   setTargetAtTime, structural ones (root/mode/reverb size) wait for
   the next drift. Scheduling: lookahead setInterval(500 ms) over
   ctx.currentTime with a 6 s horizon (12 s when hidden).
--------------------------------------------------------------------- */
'use strict';

const Tides = {
  ctx: null, playing: false, everPlayed: false,
  P: null, prevP: null,
  nodes: {}, voices: [],
  palette: null, chord: null, chordName: '—', chordMode: 'dorian',
  labelQueue: [],                                 // {t, name, mode} — status commits when audible
  pedalHz: 110, rootPc: 9, modeName: 'dorian',
  pendingKey: null, reverbDirty: false, reverbSwapAt: null,
  rngC: null, rngG: null, rngV: null,            // chord / glint / voice streams
  retargets: [],                                  // {t, idx, freq}
  driftTimes: [], nextDriftTime: 0, nextGlintTime: 0,
  glintMarks: [],                                 // {t, f, dur} for the viz
  lfo: {},                                        // A/B/C phase trackers for viz
  elapsedBase: 0, resumeMark: 0,
  timer: null,
};

/* ----- small helpers ----- */
Tides.pedalFor = function (pc) {
  // pedal sits E2..D#3 so the sub (an octave down) stays 41..78 Hz
  const midi = 40 + ((pc - 4 + 12) % 12);
  return 440 * Math.pow(2, (midi - 69) / 12);
};
Tides.driftInterval = function () {
  return 120 * Math.pow(0.125, this.P.drift / 100);          // 120 s .. 15 s
};
Tides.glintInterval = function () {
  const g = this.P.glints / 100;
  const mean = lerp(30, 12, g);
  const u = this.rngG.next();
  return clamp(-Math.log(1 - u * 0.95) * mean, mean * 0.45, mean * 2.4);
};
Tides.periodScale = function () {
  return 2.2 * Math.pow(0.5 / 2.2, this.P.tide / 100);       // x2.2 .. x0.5
};

function makeImpulse(ctx, rng, seconds, decay) {
  const rate = ctx.sampleRate, len = Math.floor(rate * seconds), fade = Math.floor(rate * 0.02);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch); let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const k = Math.exp(-2 * Math.PI * (10000 * Math.pow(0.1, t)) / rate);  // 10k -> 1k across tail
      lp = k * lp + (1 - k) * (rng.next() * 2 - 1);
      d[i] = lp * Math.pow(1 - t, decay) * (i < fade ? i / fade : 1) * 3;
    }
  }
  return buf;
}

function scrap(src, parts) {
  src.onended = () => { for (const n of parts) { try { n.disconnect(); } catch (e) {} } };
}

/* =====================================================================
   Graph
===================================================================== */
Tides.build = function () {
  const P = this.P;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  this.ctx = ctx;
  const N = this.nodes;

  this.rootPc = P.root; this.modeName = P.mode;
  this.pedalHz = this.pedalFor(P.root);
  this.seedStreams(P.seed);

  /* master chain: volume -> quiet-listening tilt -> glue -> limiter -> analyser -> out */
  N.master = ctx.createGain();
  N.master.gain.value = 0;
  /* equal-loudness tilt: shelf gains rise as the volume slider falls
     (Fletcher–Munson — quiet listening loses bass and treble) */
  N.tiltLow = ctx.createBiquadFilter();
  N.tiltLow.type = 'lowshelf'; N.tiltLow.frequency.value = 150; N.tiltLow.gain.value = 0;
  N.tiltHigh = ctx.createBiquadFilter();
  N.tiltHigh.type = 'highshelf'; N.tiltHigh.frequency.value = 8000; N.tiltHigh.gain.value = 0;
  N.comp = ctx.createDynamicsCompressor();
  N.comp.threshold.value = -18; N.comp.knee.value = 24; N.comp.ratio.value = 2.5;
  N.comp.attack.value = 0.01; N.comp.release.value = 0.25;
  N.limiter = ctx.createDynamicsCompressor();
  N.limiter.threshold.value = -4; N.limiter.knee.value = 0; N.limiter.ratio.value = 16;
  N.limiter.attack.value = 0.001; N.limiter.release.value = 0.1;
  N.analyser = ctx.createAnalyser();
  N.analyser.fftSize = 2048;
  N.master.connect(N.tiltLow); N.tiltLow.connect(N.tiltHigh);
  N.tiltHigh.connect(N.comp); N.comp.connect(N.limiter);
  N.limiter.connect(N.analyser); N.analyser.connect(ctx.destination);

  /* shared noise (one seeded 2 s loop, Daysong idiom) */
  const nrng = new RNG((P.seed ^ 0x9e3779b9) >>> 0);
  N.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = N.noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = nrng.next() * 2 - 1;

  /* reverb */
  N.convolver = ctx.createConvolver();
  N.convolver.buffer = makeImpulse(ctx, new RNG((P.seed ^ 0x51ed27) >>> 0), P.rsize, 3);
  N.reverbRet = ctx.createGain(); N.reverbRet.gain.value = 1;
  N.convolver.connect(N.reverbRet); N.reverbRet.connect(N.master);

  /* the three wave LFOs (audio-rate so they keep breathing when hidden) */
  const t0 = ctx.currentTime + 0.05;
  for (const [key, period] of [['A', P.lfoa], ['B', P.lfob], ['C', P.lfoc]]) {
    const osc = ctx.createOscillator();
    osc.frequency.value = 1 / (period * this.periodScale());
    osc.start(t0);
    N['lfo' + key] = osc;
    this.lfo[key] = { t0, f: osc.frequency.value, phase: 0 };
  }

  /* bed bus: voices -> global lowpass (LFO-A) -> level -> swell (LFO-B)
     -> stereo tilt (LFO-C) -> master */
  N.bedFilter = ctx.createBiquadFilter();
  N.bedFilter.type = 'lowpass'; N.bedFilter.Q.value = 0.7;
  N.bedLevel = ctx.createGain();
  N.bedSwell = ctx.createGain(); N.bedSwell.gain.value = 1;
  N.bedPan = ctx.createStereoPanner();
  N.bedFilter.connect(N.bedLevel); N.bedLevel.connect(N.bedSwell);
  N.bedSwell.connect(N.bedPan); N.bedPan.connect(N.master);
  N.bedSend = ctx.createGain(); N.bedLevel.connect(N.bedSend); N.bedSend.connect(N.convolver);
  N.lfoAG = ctx.createGain(); N.lfoA.connect(N.lfoAG); N.lfoAG.connect(N.bedFilter.frequency);
  N.lfoBG = ctx.createGain(); N.lfoB.connect(N.lfoBG); N.lfoBG.connect(N.bedSwell.gain);
  N.lfoCG = ctx.createGain(); N.lfoC.connect(N.lfoCG); N.lfoCG.connect(N.bedPan.pan);

  /* sub: sine an octave below the pedal + a whisper of the fifth */
  N.subOsc = ctx.createOscillator(); N.subOsc.frequency.value = this.pedalHz / 2;
  N.subFifth = ctx.createOscillator(); N.subFifth.frequency.value = this.pedalHz / 2 * 1.5;
  N.subFifthG = ctx.createGain(); N.subFifthG.gain.value = 0.2;
  N.subGain = ctx.createGain();
  N.subOsc.connect(N.subGain); N.subFifth.connect(N.subFifthG); N.subFifthG.connect(N.subGain);
  N.subGain.connect(N.master);
  N.subModG = ctx.createGain(); N.lfoC.connect(N.subModG); N.subModG.connect(N.subGain.gain);
  N.subOsc.start(t0); N.subFifth.start(t0);

  /* foam: shared noise -> highpass -> bandpass/lowpass -> gain (LFO-A) */
  N.foamSrc = ctx.createBufferSource();
  N.foamSrc.buffer = N.noiseBuf; N.foamSrc.loop = true;
  N.foamHP = ctx.createBiquadFilter(); N.foamHP.type = 'highpass';
  N.foamBP = ctx.createBiquadFilter();
  N.foamGain = ctx.createGain();
  N.foamSrc.connect(N.foamHP); N.foamHP.connect(N.foamBP); N.foamBP.connect(N.foamGain);
  N.foamGain.connect(N.master);
  N.foamSend = ctx.createGain(); N.foamGain.connect(N.foamSend); N.foamSend.connect(N.convolver);
  N.foamModG = ctx.createGain(); N.lfoA.connect(N.foamModG); N.foamModG.connect(N.foamGain.gain);
  N.foamSrc.start(t0);

  /* glints bus */
  N.glintBus = ctx.createGain();
  N.glintBus.connect(N.master);
  N.glintSend = ctx.createGain(); N.glintBus.connect(N.glintSend); N.glintSend.connect(N.convolver);

  /* harmony + voices */
  this.palette = buildPalette(this.modeName, { sus: P.sus, quartal: P.quartal });
  this.chord = this.palette[0];                               // open on i
  this.chordName = chordLabel(this.chord, this.rootPc);
  this.chordMode = this.modeName;
  const targets = voiceTargets(this.chord, this.pedalHz, P.voices, P.ji,
                               this.pedalHz, this.pedalHz * 4.1);
  this.voices = [];
  for (let i = 0; i < P.voices; i++) this.voices.push(this.makeVoice(i, targets[i]));

  this.applyParams(P, true);
};

/* one drone voice: two detuned saws (each walked by a very slow LFO,
   opposite directions -> evolving beat patterns) -> lowpass -> gain -> pan */
Tides.makeVoice = function (i, freq) {
  const ctx = this.ctx, N = this.nodes, P = this.P;
  const t0 = ctx.currentTime + 0.03;
  const v = { freq, detRatio: this.rngV.range(0.7, 1.5) };
  v.osc1 = ctx.createOscillator(); v.osc1.type = 'sawtooth'; v.osc1.frequency.value = freq;
  v.osc2 = ctx.createOscillator(); v.osc2.type = 'sawtooth'; v.osc2.frequency.value = freq;
  const cents = P.detune * v.detRatio;
  v.osc1.detune.value = cents; v.osc2.detune.value = -cents;
  v.walk = ctx.createOscillator();
  v.walk.frequency.value = this.rngV.range(0.02, 0.08);
  v.wgP = ctx.createGain(); v.wgP.gain.value = 3;             // ±3 cents, per spec
  v.wgN = ctx.createGain(); v.wgN.gain.value = -3;
  v.walk.connect(v.wgP); v.wgP.connect(v.osc1.detune);
  v.walk.connect(v.wgN); v.wgN.connect(v.osc2.detune);
  v.filter = ctx.createBiquadFilter();
  v.filter.type = 'lowpass'; v.filter.Q.value = 0.7;
  v.filter.frequency.value = clamp(freq * 2.6, 350, lerp(700, 2200, P.depth / 100)); // lower voices darker; Depth opens the ceiling
  v.gain = ctx.createGain(); v.gain.gain.value = 0;
  v.pan = ctx.createStereoPanner();
  v.spread = (i === 0) ? 0 : (i % 2 ? 1 : -1) * (0.12 + 0.07 * i);  // pedal centered
  v.osc1.connect(v.filter); v.osc2.connect(v.filter);
  v.filter.connect(v.gain); v.gain.connect(v.pan); v.pan.connect(N.bedFilter);
  v.osc1.start(t0); v.osc2.start(t0); v.walk.start(t0);
  return v;
};

Tides.seedStreams = function (seed) {
  this.rngC = new RNG((seed ^ 0x2545f491) >>> 0);
  this.rngG = new RNG((seed ^ 0x8f1bbcdc) >>> 0);
  this.rngV = new RNG((seed ^ 0x3c6ef372) >>> 0);
};

/* =====================================================================
   Live parameter application (everything smoothed; no restarts)
===================================================================== */
Tides.applyParams = function (P, force) {
  this.P = P;
  if (!this.ctx) return;
  const prev = this.prevP || {};
  const ctx = this.ctx, N = this.nodes, now = ctx.currentTime;
  const set = (param, val, tau) => param.setTargetAtTime(val, now, tau || 0.15);

  /* volume + quiet-listening tilt (0 dB at/above the default 70 %) */
  const vol = Math.pow(P.volume / 100, 1.6) * 0.92;
  if (this.playing || this.everPlayed) set(N.master.gain, vol, 0.08);
  const shelfDb = clamp(6 * (0.7 - P.volume / 100), 0, 5);
  set(N.tiltLow.gain, shelfDb, 0.08);
  set(N.tiltHigh.gain, shelfDb, 0.08);

  const sw = P.swell / 100;
  const depthCenter = 400 * Math.pow(2600 / 400, P.depth / 100);

  /* bed: depth center + LFO-A octaves */
  set(N.bedFilter.frequency, depthCenter, 0.2);
  const octA = 1.0 * sw;
  const ampA = Math.min(0.72 * depthCenter,
    depthCenter * (Math.pow(2, octA) - Math.pow(2, -octA)) / 2);
  set(N.lfoAG.gain, ampA, 0.2);

  /* bed swell ±dB via LFO-B */
  const dB = 4 * sw;
  set(N.lfoBG.gain, (Math.pow(10, dB / 20) - Math.pow(10, -dB / 20)) / 2, 0.2);

  /* stereo tilt via LFO-C, scaled by width */
  const width = P.width / 100;
  set(N.lfoCG.gain, 0.26 * sw * width, 0.2);

  /* LFO rates (Tide macro + advanced periods) */
  const scale = this.periodScale();
  for (const [key, period] of [['A', P.lfoa], ['B', P.lfob], ['C', P.lfoc]]) {
    const f = 1 / (period * scale);
    const L = this.lfo[key];
    if (Math.abs(f - L.f) > 1e-6) {
      set(N['lfo' + key].frequency, f, 0.3);
      L.phase += L.f * (now - L.t0); L.t0 = now; L.f = f;     // keep viz phase in step
    }
  }

  /* mixer + trims (tuned against the verify harness) */
  const lv = x => Math.pow(x / 100, 1.6);
  const bedBase = lv(P.mixbed) * (P.mutebed ? 0 : 1) * 1.0;
  set(N.bedLevel.gain, bedBase, 0.12);
  const subBase = lv(P.mixsub) * (P.mutesub ? 0 : 1) * 0.16;
  set(N.subGain.gain, subBase, 0.12);
  set(N.subModG.gain, subBase * 0.34 * sw, 0.2);

  /* foam (plus the voice-masking reshape) */
  const tx = P.texture / 100;
  const foamBase = Math.pow(tx, 1.35) * 0.16 * lv(P.mixfoam) * (P.mutefoam ? 0 : 1)
                 * (P.voicemask ? 1.5 : 1);
  set(N.foamGain.gain, foamBase, 0.2);
  set(N.foamModG.gain, foamBase * (P.voicemask ? 0.25 : 0.55), 0.2);
  if (P.voicemask) {
    set(N.foamHP.frequency, 250, 0.15);
    if (N.foamBP.type !== 'lowpass') N.foamBP.type = 'lowpass';
    set(N.foamBP.frequency, 4000, 0.15);
    N.foamBP.Q.setTargetAtTime(0.5, now, 0.15);
  } else {
    set(N.foamHP.frequency, Math.max(120, P.foamhz * 0.4), 0.15);
    if (N.foamBP.type !== 'bandpass') N.foamBP.type = 'bandpass';
    set(N.foamBP.frequency, P.foamhz, 0.15);
    N.foamBP.Q.setTargetAtTime(0.9, now, 0.15);
  }

  /* glints level */
  const gl = P.glints / 100;
  set(N.glintBus.gain, lv(P.mixglints) * (P.muteglints ? 0 : 1) * (gl > 0 ? 1 : 0), 0.12);

  /* reverb sends */
  const rmix = P.rmix / 50;                                   // 50 = nominal
  set(N.bedSend.gain, 0.25 * rmix, 0.2);
  set(N.foamSend.gain, 0.3 * rmix, 0.2);
  set(N.glintSend.gain, 0.6 * rmix, 0.2);

  /* per-voice detune spread + width (outermost voice caps at ±0.6·width —
     headphone imaging) + Depth lifting each voice's cutoff ceiling so the
     macro's top half keeps opening the bed */
  const vceil = lerp(700, 2200, P.depth / 100);
  const maxSpread = 0.12 + 0.07 * Math.max(1, this.voices.length - 1);
  for (let i = 0; i < this.voices.length; i++) {
    const v = this.voices[i];
    const cents = P.detune * v.detRatio;
    set(v.osc1.detune, cents, 0.3); set(v.osc2.detune, -cents, 0.3);
    set(v.pan.pan, clamp(v.spread / maxSpread * 0.6 * width, -0.6, 0.6), 0.2);
    set(v.filter.frequency, clamp(v.freq * 2.6, 350, vceil), 0.3);
  }

  /* ----- structural changes ----- */
  if (!force) {
    if (P.seed !== prev.seed) {
      this.seedStreams(P.seed);
      for (const v of this.voices) {                          // new beat character
        v.detRatio = this.rngV.range(0.7, 1.5);
        set(v.walk.frequency, this.rngV.range(0.02, 0.08), 0.5);
      }
      // pull the next drift close so the new stream is heard soon
      this.nextDriftTime = Math.min(this.nextDriftTime, now + 4);
    }
    if (P.root !== this.rootPc || P.mode !== this.modeName) {
      this.pendingKey = { rootPc: P.root, modeName: P.mode }; // at next drift
    } else if (this.pendingKey) {
      this.pendingKey = null;                                 // user changed back
    }
    if (P.sus !== prev.sus || P.quartal !== prev.quartal) {
      this.palette = buildPalette(this.modeName, { sus: P.sus, quartal: P.quartal });
    }
    if (P.rsize !== prev.rsize) this.reverbDirty = true;
    if (P.ji !== prev.ji) this.retuneNow(0.8);                // audible A/B
    if (P.voices !== prev.voices && prev.voices != null) this.setVoiceCount(P.voices);
  }

  /* bed per-voice level (normalized by count) */
  const perVoice = 0.26 / Math.max(3, this.voices.length);
  for (const v of this.voices) {
    if (!v.dying) set(v.gain.gain, perVoice, 0.4);
  }

  this.prevP = Object.assign({}, P);
};

/* re-voice the current chord (used by the JI toggle & voice-count change) */
Tides.retuneNow = function (spacing) {
  const now = this.ctx.currentTime;
  const targets = voiceTargets(this.chord, this.pedalHz, this.voices.length,
                               this.P.ji, this.pedalHz, this.pedalHz * 4.1);
  const assigned = assignVoices(this.voices.map(v => v.freq), targets);
  this.retargets = this.retargets.filter(r => r.dispatched);
  for (let i = 0; i < this.voices.length; i++) {
    this.queueRetarget(now + 0.1 + i * spacing, i, assigned[i]);
  }
};

Tides.setVoiceCount = function (n) {
  const now = this.ctx.currentTime;
  while (this.voices.length > n) {                            // fade out & free
    const v = this.voices.pop();
    v.dying = true;
    v.gain.gain.setTargetAtTime(0.0001, now, 0.5);
    const stopAt = now + 2.5;
    v.osc1.stop(stopAt); v.osc2.stop(stopAt); v.walk.stop(stopAt);
    scrap(v.osc1, [v.osc2, v.walk, v.wgP, v.wgN, v.filter, v.gain, v.pan]);
  }
  while (this.voices.length < n) {                            // fade in
    const targets = voiceTargets(this.chord, this.pedalHz, n, this.P.ji,
                                 this.pedalHz, this.pedalHz * 4.1);
    const v = this.makeVoice(this.voices.length, targets[Math.min(this.voices.length, targets.length - 1)]);
    this.voices.push(v);
  }
  this.retuneNow(1.5);
};

/* =====================================================================
   Scheduler: drifts (harmony weather) + glints, 6 s / 12 s lookahead
===================================================================== */
Tides.tick = function () {
  if (!this.playing || !this.ctx) return;
  const now = this.ctx.currentTime;
  const horizon = document.hidden ? 12 : 6;

  /* commit status labels only once their drift is actually audible */
  let due = null;
  this.labelQueue = this.labelQueue.filter(q => {
    if (q.t <= now) { if (!due || q.t >= due.t) due = q; return false; }
    return true;
  });
  if (due) { this.chordName = due.name; this.chordMode = due.mode; }

  /* pending reverb swap (tick-driven — setTimeout can stall for minutes
     in a hidden tab and leave the return ducked) */
  if (this.reverbSwapAt != null && now >= this.reverbSwapAt) {
    this.reverbSwapAt = null;
    this.nodes.convolver.buffer = makeImpulse(this.ctx, new RNG((this.P.seed ^ 0x51ed27) >>> 0),
                                              this.P.rsize, 3);
    this.nodes.reverbRet.gain.setTargetAtTime(1, now + 0.05, 0.4);
  }

  /* late wake: never burst-catch-up, just move on */
  if (this.nextDriftTime < now - 0.25) this.nextDriftTime = now + 2;
  if (this.nextGlintTime < now - 0.25) this.nextGlintTime = now + this.glintInterval();

  while (this.nextDriftTime < now + horizon) {
    this.doDrift(this.nextDriftTime);
    this.nextDriftTime += this.driftInterval();
  }

  if (this.P.glints > 0 && !this.P.muteglints) {
    while (this.nextGlintTime < now + horizon) {
      this.playGlint(this.nextGlintTime);
      this.nextGlintTime += this.glintInterval();
    }
  } else {
    this.nextGlintTime = Math.max(this.nextGlintTime, now + 1);
  }

  /* dispatch voice glides that entered the horizon */
  for (const r of this.retargets) {
    if (!r.dispatched && r.t < now + horizon) {
      const v = this.voices[r.idx];
      if (v && !v.dying) {
        const tau = this.P.glide;
        v.osc1.frequency.setTargetAtTime(r.freq, Math.max(now, r.t), tau);
        v.osc2.frequency.setTargetAtTime(r.freq, Math.max(now, r.t), tau);
        v.filter.frequency.setTargetAtTime(
          clamp(r.freq * 2.6, 350, lerp(700, 2200, this.P.depth / 100)),
          Math.max(now, r.t), tau * 1.2);
        v.freq = r.freq;
      }
      r.dispatched = true;
    }
  }
  this.retargets = this.retargets.filter(r => !r.dispatched || r.t > now - 30);
  this.driftTimes = this.driftTimes.filter(t => t > now - 1);
  this.glintMarks = this.glintMarks.filter(m => m.t + m.dur > now - 1);
};

Tides.queueRetarget = function (t, idx, freq) {
  this.retargets.push({ t, idx, freq, dispatched: false });
};

Tides.doDrift = function (td) {
  const P = this.P;

  if (this.pendingKey) {                                      // root/mode arrive here
    this.rootPc = this.pendingKey.rootPc;
    this.modeName = this.pendingKey.modeName;
    this.pendingKey = null;
    this.palette = buildPalette(this.modeName, { sus: P.sus, quartal: P.quartal });
    const newPedal = this.pedalFor(this.rootPc);
    if (newPedal !== this.pedalHz) {
      this.pedalHz = newPedal;
      const N = this.nodes, tau = Math.max(2, P.glide);
      N.subOsc.frequency.setTargetAtTime(newPedal / 2, td, tau);
      N.subFifth.frequency.setTargetAtTime(newPedal / 2 * 1.5, td, tau);
    }
  }
  if (this.reverbDirty) { this.reverbDirty = false; this.swapReverb(td); }

  this.chord = pickNextChord(this.rngC, this.palette, this.chord, P.seventh / 100);
  this.labelQueue.push({ t: td, name: chordLabel(this.chord, this.rootPc), mode: this.modeName });
  const n = this.voices.length;
  const targets = voiceTargets(this.chord, this.pedalHz, n, P.ji,
                               this.pedalHz, this.pedalHz * 4.1);
  const assigned = assignVoices(this.voices.map(v => v.freq), targets);

  /* one voice moves at the drift; the rest follow one by one (seeded order).
     Spacing shrinks at fast Drift so every voice reaches its chord tone
     before the next drift drops the queue. */
  const spacing = Math.min(7, this.driftInterval() / (n + 1));
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = this.rngC.int(0, i);
    const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }
  this.retargets = this.retargets.filter(r => r.dispatched);  // drop stale glides
  let t = td;
  for (const idx of order) {
    this.queueRetarget(t, idx, assigned[idx]);
    t += spacing * this.rngC.range(0.85, 1.2);
  }
  this.driftTimes.push(td);
};

Tides.swapReverb = function (td) {
  /* dip the return now; tick() performs the swap + restore once td+0.4 has
     passed (a one-shot setTimeout can be delayed minutes in a hidden tab) */
  this.nodes.reverbRet.gain.setTargetAtTime(0.0001, td, 0.08);
  this.reverbSwapAt = td + 0.4;
};

/* one glint: a bloom, not a pluck — sine + 2.76x partial, 1.2 s attack */
Tides.playGlint = function (t) {
  const ctx = this.ctx, P = this.P, rng = this.rngG;
  const offs = glintOffsets(this.modeName);
  const off = rng.pick(offs);
  const base = this.pedalHz * ratioFor(off, P.ji);
  const center = lerp(180, 470, P.depth / 100);               // Depth biases register
  let f = base, bd = Infinity;
  for (let oct = -1; oct <= 3; oct++) {
    const c = base * Math.pow(2, oct);
    if (c < 146 || c > 588) continue;                          // D3..D5 hard cap
    const d = Math.abs(Math.log(c / center)) + rng.range(0, 0.35);
    if (d < bd) { bd = d; f = c; }
  }
  const lvl = 0.16 * Math.pow(P.glints / 100, 0.7);
  const atk = 1.2, rel = rng.range(4, 6);

  const o1 = ctx.createOscillator(); o1.frequency.value = f;
  const o2 = ctx.createOscillator(); o2.frequency.value = f * 2.76;
  const o2g = ctx.createGain(); o2g.gain.value = 0.15;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(lvl, t + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, t + atk + rel);
  g.gain.linearRampToValueAtTime(0, t + atk + rel + 0.05);
  o1.connect(g); o2.connect(o2g); o2g.connect(g);
  g.connect(this.nodes.glintBus);
  o1.start(t); o2.start(t);
  o1.stop(t + atk + rel + 0.1); o2.stop(t + atk + rel + 0.1);
  scrap(o1, [g, o2, o2g]);
  this.glintMarks.push({ t, f, dur: atk + rel });
};

/* =====================================================================
   Transport
===================================================================== */
Tides.play = function () {
  if (!this.ctx) this.build();
  const ctx = this.ctx;
  if (ctx.state === 'suspended') ctx.resume();
  if (this.playing) return;
  this.playing = true;
  const now = ctx.currentTime;
  this.resumeMark = now;
  const first = !this.everPlayed;
  if (first) {
    this.everPlayed = true;
    this.nextDriftTime = now + this.driftInterval();
    this.nextGlintTime = now + 6 + this.glintInterval() * 0.5;
    window.__studio = { ctx, tap: this.nodes.analyser, version: '01-tides',
                        play: () => Tides.play(), pause: () => Tides.pause() };
  }
  /* gentle rise-from-silence on every (re)start */
  const target = Math.pow(this.P.volume / 100, 1.6) * 0.92;  // trim aims ~-22 dBFS RMS at 70 %
  this.nodes.master.gain.cancelScheduledValues(now);
  this.nodes.master.gain.setValueAtTime(Math.min(this.nodes.master.gain.value, target * 0.3), now);
  this.nodes.master.gain.setTargetAtTime(target, now, first ? 1.0 : 0.5);
  if (!this.timer) this.timer = setInterval(() => this.tick(), 500);
  this.tick();
};

Tides.pause = function () {
  if (!this.playing || !this.ctx) return;
  this.playing = false;
  const ctx = this.ctx, now = ctx.currentTime;
  this.elapsedBase += now - this.resumeMark;
  this.nodes.master.gain.cancelScheduledValues(now);
  this.nodes.master.gain.setTargetAtTime(0.0001, now, 0.06);
  setTimeout(() => { if (!this.playing) ctx.suspend(); }, 280);
};

Tides.elapsed = function () {
  if (!this.ctx) return 0;
  return this.elapsedBase + (this.playing ? this.ctx.currentTime - this.resumeMark : 0);
};

/* current LFO values, tracked analytically for the viz/status */
Tides.lfoValue = function (key) {
  if (!this.ctx || !this.lfo[key]) return 0;
  const L = this.lfo[key];
  return Math.sin(2 * Math.PI * (L.phase + L.f * (this.ctx.currentTime - L.t0)));
};

Tides.nextDriftIn = function () {
  if (!this.ctx || !this.everPlayed) return null;
  const now = this.ctx.currentTime;
  let best = Infinity;
  for (const t of this.driftTimes) if (t > now && t < best) best = t;
  for (const r of this.retargets) if (!r.dispatched && r.t > now && r.t < best) best = r.t;
  if (this.nextDriftTime > now) best = Math.min(best, this.nextDriftTime);
  return isFinite(best) ? best - now : null;
};
