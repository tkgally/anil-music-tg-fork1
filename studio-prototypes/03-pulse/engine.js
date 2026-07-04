/* ---------------------------------------------------------------------
   03 · Pulse — engine.js

   Concept: a soft clockwork. One 16-step pattern (8th notes, 2 bars)
   played by warm FM keys and their echo-canon an octave down; bass and
   a quiet saw-haze follow a 4-chord cycle. Every "evolve" interval the
   pattern rewrites exactly ONE cell — the piece drifts, never jumps.

   Parameter model: main.js owns the state object and calls
   Pulse.applyParams(P) on every change. Mixer/filter/level params land
   immediately via setTargetAtTime; structural ones (tempo, root/mode,
   register, chord set/rate, seed) are read fresh at the next loop
   boundary. Scheduling: lookahead setInterval(500 ms) over
   ctx.currentTime, horizon 6 s visible / 12 s hidden; a late wake
   skips ahead in phase (no catch-up bursts) and re-swells the haze.
--------------------------------------------------------------------- */
'use strict';

const Pulse = {
  ctx: null, playing: false, everPlayed: false,
  P: null, nodes: {},
  stepDur: (60 / 78) / 2, stepIdx: 0, loopIdx: 0, nextStepTime: 0,
  pattern: null, age: 0,
  chord: null, chordPos: -1, chordSetKey: '', hazeEnd: 0, hazeAudioEnd: 0,
  rngPat: null, rngMut: null, rngTick: null, rngNote: null,
  scaleMidis: null, centerIdx: 0,
  scRoot: null, scMode: null, scCenter: null, scSpan: null,
  pendingReseed: false, pendingNudge: false, curSeed: null,
  vizEvents: [], flashes: [], noteMarks: [], deferred: [],
  elapsedBase: 0, resumeMark: 0, timer: null,
};

/* ----- shared helpers ----- */
function scrap(src, parts) {
  src.onended = () => { for (const n of parts) { try { n.disconnect(); } catch (e) {} } };
}

/* impulse: decayed seeded noise with a lowpass swept down the tail (air
   absorption) and a short fade-in to soften the direct spike */
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

Pulse.noiseSource = function (t, dur) {
  const src = this.ctx.createBufferSource();
  src.buffer = this.nodes.noiseBuf;
  src.loop = true;
  src.start(t);
  src.stop(t + dur);
  return src;
};

Pulse.seedStreams = function (seed) {
  this.curSeed = seed;
  this.rngPat = new RNG(seed >>> 0);
  this.rngMut = new RNG((seed ^ 0x9e3779b9) >>> 0);
  this.rngTick = new RNG((seed ^ 0x51ed270b) >>> 0);
  this.rngNote = new RNG((seed ^ 0x2545f491) >>> 0);
};

Pulse.degSpan = function () { return Math.max(3, Math.round(this.P.regspan * 7 / 12)); };
Pulse.densityTarget = function () {
  return clamp(Math.round(7 + 4 * this.P.energy / 100 + (this.P.density - 9)), 4, 12);
};
Pulse.mutOpts = function () {
  const P = this.P;
  return {
    target: this.densityTarget(), degSpan: this.degSpan(),
    weights: { pitch: P.wpitch, toggle: P.wtoggle, swap: P.wrhythm / 2, nudge: P.wrhythm / 2 },
  };
};
Pulse.evolveLoops = function () {
  return { off: 0, gentle: 3, steady: 2, restless: 1 }[this.P.evolve] || 0;
};

/* structural scale/register mapping, refreshed at loop boundaries */
Pulse.rebuildScale = function () {
  const P = this.P;
  if (P.root === this.scRoot && P.mode === this.scMode &&
      P.regcenter === this.scCenter && P.regspan === this.scSpan) return;
  this.scaleMidis = scaleMidisFor(P.root, P.mode);
  this.centerIdx = nearestIdx(this.scaleMidis, P.regcenter);
  this.scRoot = P.root; this.scMode = P.mode;
  this.scCenter = P.regcenter; this.scSpan = P.regspan;
};

/* degree offset -> MIDI inside the register window (hard cap 50..72) */
Pulse.slotMidi = function (deg) {
  const P = this.P;
  const lo = Math.max(50, P.regcenter - P.regspan);
  const hi = Math.min(72, P.regcenter + P.regspan);
  let m = this.scaleMidis[clamp(this.centerIdx + deg, 0, this.scaleMidis.length - 1)];
  while (m > hi) m -= 12;
  while (m < lo) m += 12;
  if (m > hi) {                       // window narrower than an octave: snap in-scale
    let best = null, bd = 1e9;
    for (const x of this.scaleMidis) {
      if (x < lo || x > hi) continue;
      const d = Math.abs(x - m);
      if (d < bd) { bd = d; best = x; }
    }
    m = best != null ? best : clamp(m, lo, hi);
  }
  return m;
};

/* =====================================================================
   Graph
===================================================================== */
Pulse.build = function () {
  const P = this.P;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  this.ctx = ctx;
  const N = this.nodes;
  this.seedStreams(P.seed);

  /* master chain: volume -> quiet-listening tilt -> Brightness lowpass
     -> glue -> limiter -> analyser -> out */
  N.master = ctx.createGain();
  N.master.gain.value = 0;
  N.shelfLo = ctx.createBiquadFilter();
  N.shelfLo.type = 'lowshelf'; N.shelfLo.frequency.value = 150; N.shelfLo.gain.value = 0;
  N.shelfHi = ctx.createBiquadFilter();
  N.shelfHi.type = 'highshelf'; N.shelfHi.frequency.value = 8000; N.shelfHi.gain.value = 0;
  N.bright = ctx.createBiquadFilter();
  N.bright.type = 'lowpass'; N.bright.Q.value = 0.5; N.bright.frequency.value = 2600;
  N.comp = ctx.createDynamicsCompressor();
  N.comp.threshold.value = -18; N.comp.knee.value = 24; N.comp.ratio.value = 2.5;
  N.comp.attack.value = 0.01; N.comp.release.value = 0.25;
  N.limiter = ctx.createDynamicsCompressor();
  N.limiter.threshold.value = -4; N.limiter.knee.value = 0; N.limiter.ratio.value = 16;
  N.limiter.attack.value = 0.001; N.limiter.release.value = 0.1;
  N.analyser = ctx.createAnalyser();
  N.analyser.fftSize = 2048;
  N.master.connect(N.shelfLo); N.shelfLo.connect(N.shelfHi); N.shelfHi.connect(N.bright);
  N.bright.connect(N.comp); N.comp.connect(N.limiter);
  N.limiter.connect(N.analyser); N.analyser.connect(ctx.destination);

  /* shared noise (one seeded 2 s loop, Daysong idiom) */
  const nrng = new RNG((P.seed ^ 0x6d2b79f5) >>> 0);
  N.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = N.noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = nrng.next() * 2 - 1;

  /* reverb: one generated stereo impulse, per-bus sends */
  N.convolver = ctx.createConvolver();
  N.convolver.buffer = makeImpulse(ctx, new RNG((P.seed ^ 0x51ed27) >>> 0), 2.8, 3);
  N.reverbRet = ctx.createGain(); N.reverbRet.gain.value = 1;
  N.convolver.connect(N.reverbRet); N.reverbRet.connect(N.master);

  /* voice buses: gain (mix) [-> filter] -> pan -> master, plus a reverb send */
  const mkBus = (lpHz, pan) => {
    const g = ctx.createGain();
    let tail = g;
    let lp = null;
    if (lpHz) {
      lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = lpHz; lp.Q.value = 0.5;
      g.connect(lp); tail = lp;
    }
    const p = ctx.createStereoPanner(); p.pan.value = pan || 0;
    tail.connect(p); p.connect(N.master);
    const send = ctx.createGain(); send.gain.value = 0;
    g.connect(send); send.connect(N.convolver);
    return { g, lp, p, send };
  };
  N.keys = mkBus(1900, 0.3);
  N.canon = mkBus(1400, -0.3);
  N.bass = mkBus(null, 0);
  N.haze = mkBus(520, 0);
  N.tick = mkBus(null, 0.12);

  /* tape wobble (±4 cents, 0.25 Hz) shared by keys + canon notes */
  N.wobble = ctx.createOscillator(); N.wobble.frequency.value = 0.25;
  N.wobGain = ctx.createGain(); N.wobGain.gain.value = 4;
  N.wobble.connect(N.wobGain);
  N.wobble.start();

  /* very slow opposite pan drift on keys/canon (< 0.1 Hz, headphone-safe) */
  N.drift = ctx.createOscillator(); N.drift.frequency.value = 0.021;
  N.driftK = ctx.createGain(); N.driftK.gain.value = 0.07;
  N.driftC = ctx.createGain(); N.driftC.gain.value = -0.07;
  N.drift.connect(N.driftK); N.driftK.connect(N.keys.p.pan);
  N.drift.connect(N.driftC); N.driftC.connect(N.canon.p.pan);
  N.drift.start();

  this.rebuildScale();
  this.pattern = makePattern(this.rngPat, this.densityTarget(), this.degSpan());
  this.age = 0;

  this.applyParams(P, true);
};

/* =====================================================================
   Live parameter application (smoothed; no restarts)
===================================================================== */
Pulse.applyParams = function (P, force) {
  this.P = P;
  if (!this.ctx) return;
  const ctx = this.ctx, N = this.nodes, now = ctx.currentTime;
  const set = (param, val, tau) => param.setTargetAtTime(val, now, tau || 0.15);
  const lv = x => Math.pow(x / 100, 1.6);
  const e = P.energy / 100;

  /* volume + quiet-listening tilt (Fletcher–Munson compensation) */
  const v = P.volume / 100;
  if (this.playing || this.everPlayed) set(N.master.gain, this.masterTarget(), 0.08);
  const shelfDb = clamp(6 * (0.7 - v), 0, 5);
  set(N.shelfLo.gain, shelfDb, 0.2);
  set(N.shelfHi.gain, shelfDb, 0.2);

  /* Brightness: master lowpass 1500..5200 + keys/canon filter tilt */
  const b = P.brightness / 100;
  set(N.bright.frequency, 1500 * Math.pow(5200 / 1500, b), 0.1);
  const keysLP = 1150 * Math.pow(3, b);
  set(N.keys.lp.frequency, keysLP, 0.1);
  set(N.canon.lp.frequency, keysLP * 0.74, 0.1);

  /* mixer (canon + tick rise with Energy; trims tuned against the harness) */
  set(N.keys.g.gain, lv(P.mixkeys) * 1.6, 0.12);
  const canonOn = P.canonint !== 'off' ? 1 : 0;
  set(N.canon.g.gain, (P.canonlvl / 100) * (0.7 + 0.5 * e) * 2.3 * canonOn, 0.12);
  set(N.bass.g.gain, lv(P.mixbass) * 0.45, 0.12);
  set(N.haze.g.gain, lv(P.mixhaze) * 1.05, 0.12);
  set(N.tick.g.gain, lv(P.mixtick) * Math.pow(P.pulse / 100, 1.2) * (0.5 + 0.5 * e) * 1.6, 0.12);

  /* reverb sends (keys .35 · tick .15 · haze .5 per spec, scaled by mix) */
  const rmix = P.reverb / 50;                       // 50 = nominal
  set(N.keys.send.gain, 0.35 * rmix, 0.2);
  set(N.canon.send.gain, 0.35 * rmix, 0.2);
  set(N.haze.send.gain, 0.5 * rmix, 0.2);
  set(N.tick.send.gain, 0.15 * rmix, 0.2);
  set(N.bass.send.gain, 0.05 * rmix, 0.2);

  /* seed change -> new initial pattern at the next loop boundary
     (main.js mutates one shared state object, so track the seed here) */
  if (!force && this.seenSeed != null && P.seed !== this.seenSeed) this.pendingReseed = true;
  this.seenSeed = P.seed;
};

/* master gain target: volume taper + trim + preset level-matching.
   The dB terms compensate the loudness that Energy / Pulse / Tempo add,
   so presets land within ±1.5 dB of each other (tuned with the harness). */
Pulse.masterTarget = function () {
  const P = this.P;
  const matchDb = -(P.energy - 40) * 0.025 - (P.pulse - 30) * 0.004 - (P.tempo - 78) * 0.020;
  return Math.pow(P.volume / 100, 1.6) * 1.0 * Math.pow(10, matchDb / 20);
};

/* =====================================================================
   Scheduler: one 16-step loop, lookahead 6 s (12 s hidden)
===================================================================== */
Pulse.tick = function () {
  if (!this.playing || !this.ctx) return;
  const now = this.ctx.currentTime;
  const horizon = document.hidden ? 12 : 6;
  let late = false;

  /* late wake: skip ahead in phase — never a burst of catch-up notes */
  while (this.nextStepTime < now - 0.06) {
    this.scheduleStep(this.nextStepTime, true);
    this.nextStepTime += this.stepDur;
    late = true;
  }
  if (late && this.hazeAudioEnd < now + 0.5) {
    // the bed's segment was skipped while asleep: re-swell it with a fade-in
    this.scheduleHazeSegment(now + 0.05, Math.max(1, this.hazeEnd - now), true);
  }
  while (this.nextStepTime < now + horizon) {
    this.scheduleStep(this.nextStepTime, false);
    this.nextStepTime += this.stepDur;
  }
  this.flushDeferred(now);

  /* prune viz queues */
  this.flashes = this.flashes.filter(f => f.t + 1.4 > now);
  this.noteMarks = this.noteMarks.filter(m => m.t + m.dur + 0.4 > now);
};

/* Node budget: step events (and every RNG draw) happen a full horizon
   ahead, but the WebAudio subgraphs are only instantiated once they are
   within ~2.8 s of sounding — visible tabs tick reliably at 0.5 s, so
   that is ample margin, and it keeps the live node count modest. Hidden
   tabs instantiate the whole 12 s horizon (timers get throttled). */
Pulse.defer = function (t, fn) { this.deferred.push({ t, fn }); };
Pulse.flushDeferred = function (now) {
  const win = document.hidden ? 12.5 : 2.8;
  while (this.deferred.length && this.deferred[0].t < now + win) {
    const d = this.deferred.shift();
    if (d.t > now - 0.06) d.fn();       // long-stalled leftovers are skipped, never burst
  }
};

Pulse.scheduleStep = function (t, late) {
  const P = this.P;
  if (this.pendingNudge && !late) { this.pendingNudge = false; this.applyNudge(t); }
  if (this.stepIdx === 0) this.loopBoundary(t, late);
  const s = this.stepIdx;
  const swung = t + (s % 2 === 1 ? P.swing / 100 * this.stepDur : 0);

  /* KEYS — the pattern */
  const slot = this.pattern[s];
  const vJit = this.rngNote.range(-0.04, 0.04);       // draw even when skipping (determinism)
  const kDet = this.rngNote.range(-2.5, 2.5);
  if (slot && !late) {
    const e = P.energy / 100;
    const acc = s === 0 ? 0.06 : (s === 8 ? 0.04 : 0);
    const vel = clamp(0.30 + 0.20 * e + acc + vJit, 0.1, 0.55);
    const midi = this.slotMidi(slot.deg);
    const dur = slot.dur * this.stepDur;
    this.defer(swung, () => this.epNote(swung, midiToFreq(midi), dur, vel, this.nodes.keys.g, vel >= 0.4, kDet));
    this.noteMarks.push({ t: swung, step: s, dur: Math.min(dur, 1.2), midi });
  }

  /* CANON — the same pattern, offset steps later, transposed down */
  if (P.canonint !== 'off') {
    const cslot = this.pattern[(s - P.canonoff + 32) % 16];
    const cJit = this.rngNote.range(-0.03, 0.03);
    const cDet = this.rngNote.range(-2.5, 2.5);
    if (cslot && !late && P.canonlvl > 0) {           // silent bus: keep the draws, skip the nodes
      const e = P.energy / 100;
      const vel = clamp(0.28 + 0.17 * e + cJit, 0.1, 0.5);
      const midi = this.slotMidi(cslot.deg) + (P.canonint === 'fifth' ? -7 : -12);
      const cdur = cslot.dur * this.stepDur;
      this.defer(swung, () => this.epNote(swung, midiToFreq(midi), cdur, vel, this.nodes.canon.g, false, cDet));
    }
  }

  /* TICK — offbeat "shh", 15% seeded skips, velocity droop across the loop */
  if (s % 2 === 1) {
    const skip = this.rngTick.chance(0.15);
    const jit = this.rngTick.range(0.85, 1.1);
    if (!skip && !late && P.pulse > 0) {
      const droop = 1 - 0.4 * (s / 16);
      const sv = clamp((0.55 + 0.25 * P.energy / 100) * droop * jit, 0, 1);
      this.defer(swung, () => this.playShh(swung, sv));
    }
  }

  /* BASS — chord root, steps 0 and 8, sustained 8 steps */
  if ((s === 0 || s === 8) && !late) {
    const bdur = 8 * this.stepDur, rootOff = this.chord.rootOff;
    this.defer(t, () => this.playBass(t, bdur, rootOff));
  }

  /* thump on step 0 only */
  if (s === 0 && !late && P.pulse > 0) this.defer(t, () => this.playThump(t));

  this.stepIdx = (this.stepIdx + 1) % 16;
};

/* everything structural lands here, at the top of a loop */
Pulse.loopBoundary = function (t, late) {
  const P = this.P;
  this.stepDur = (60 / P.tempo) / 2;                  // tempo: next-loop semantics
  this.rebuildScale();

  if (this.pendingReseed) {                           // seed reroll -> fresh pattern
    this.pendingReseed = false;
    this.seedStreams(P.seed);
    this.pattern = makePattern(this.rngPat, this.densityTarget(), this.degSpan());
    this.age = 0;
  }

  /* chord cycle: advance every chordrate loops; re-swell haze each segment */
  const setDef = CHORD_SETS[P.chordset] || CHORD_SETS.dusk;
  const rate = clamp(Math.round(P.chordrate), 1, 4);
  const pos = Math.floor(this.loopIdx / rate) % 4;
  const segStart = this.loopIdx % rate === 0;
  if (pos !== this.chordPos || this.chordSetKey !== P.chordset || segStart) {
    this.chordPos = pos; this.chordSetKey = P.chordset;
    this.chord = chordFromDegree(P.mode, setDef.degs[pos]);
    const segLoops = rate - (this.loopIdx % rate);
    const segDur = segLoops * 16 * this.stepDur;
    if (!late) this.scheduleHazeSegment(t, segDur, false);
    else this.hazeEnd = t + segDur;      // audio skipped; tick() re-swells after catch-up
  }

  /* EVOLUTION — exactly one cell rewrites itself */
  const evLoops = this.evolveLoops();
  let nextMutT = Infinity;
  if (evLoops > 0 && !P.freeze) {
    if (this.loopIdx > 0 && this.loopIdx % evLoops === 0) {
      const m = mutatePattern(this.rngMut, this.pattern, this.mutOpts());
      if (m) { this.age++; this.flashes.push({ t, slot: m.slot, slot2: m.slot2 }); }
    }
    nextMutT = t + (evLoops - (this.loopIdx % evLoops)) * 16 * this.stepDur;
  }

  /* snapshot for the ring + status (consumed at its audible time) */
  this.vizEvents.push({
    t,
    pattern: this.pattern.map(c => c && { deg: c.deg, dur: c.dur }),
    roman: this.chord.roman,
    rootName: NOTE_NAMES[(P.root + this.chord.rootOff) % 12],
    loop: this.loopIdx, age: this.age,
    nextMutT, stepDur: this.stepDur, loopStart: t,
    evolveOff: evLoops === 0, frozen: !!P.freeze,
    canonoff: P.canonoff, degSpan: this.degSpan(),
  });

  this.loopIdx++;
};

/* Freeze-proof manual mutation ("Nudge now"): queued so it lands at the
   next *unscheduled* step — audio already in the lookahead keeps the old
   pattern, and the ring flash arrives with the first mutated note (the
   same audible-time vizEvents path scheduled evolution uses). */
Pulse.nudgeNow = function () {
  if (this.pattern) this.pendingNudge = true;
};

Pulse.applyNudge = function (t) {
  const m = mutatePattern(this.rngMut, this.pattern, this.mutOpts());
  if (!m) return;
  this.age++;
  this.flashes.push({ t, slot: m.slot, slot2: m.slot2 });
  // t is past every queued event (they were scheduled before this step),
  // so a plain push keeps vizEvents ordered for pumpViz.
  this.vizEvents.push({ t, pattern: this.pattern.map(c => c && { deg: c.deg, dur: c.dur }), age: this.age });
};

/* =====================================================================
   Voices
===================================================================== */

/* FM electric piano (Daysong `keys`, tamed: mod index x0.6, tine 0.03,
   8 ms attack, tape wobble on the carrier). `det` is drawn by the caller
   (scheduleStep) so the stream stays deterministic across late wakes;
   callers skip `tine` on soft notes — inaudible sparkle, saved nodes. */
Pulse.epNote = function (t, f, dur, vel, bus, tine, det) {
  const ctx = this.ctx, N = this.nodes;
  const car = ctx.createOscillator();
  car.frequency.value = f;
  car.detune.value = det || 0;
  const mod = ctx.createOscillator();
  mod.frequency.value = f;
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(f * (0.5 + vel * 1.1) * 0.6, t);
  mg.gain.exponentialRampToValueAtTime(f * 0.02, t + Math.max(0.3, dur));
  mod.connect(mg); mg.connect(car.frequency);
  N.wobGain.connect(car.detune);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.3 * vel, t + 0.008);
  g.gain.exponentialRampToValueAtTime(1e-4, t + dur + 0.5);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.55);
  car.connect(g); g.connect(bus);
  const parts = [g, mg, mod];
  if (tine) {
    const tn = ctx.createOscillator();
    tn.frequency.value = f * 6.93;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.03 * vel, t);
    tg.gain.exponentialRampToValueAtTime(1e-4, t + 0.09);
    tg.gain.linearRampToValueAtTime(0, t + 0.1);
    tn.connect(tg); tg.connect(g);
    tn.start(t); tn.stop(t + 0.12);
    parts.push(tn, tg);
  }
  car.start(t); mod.start(t);
  car.stop(t + dur + 0.6); mod.stop(t + dur + 0.6);
  car.onended = () => {
    try { N.wobGain.disconnect(car.detune); } catch (e) {}
    for (const n of parts) { try { n.disconnect(); } catch (e) {} }
  };
};

/* BASS: sine + 0.25 saw -> lowpass 180 (chord root, MIDI 33..44).
   rootOff is captured at schedule time — the chord may already have
   advanced (lookahead) by the time the deferred subgraph is built. */
Pulse.playBass = function (t, dur, rootOff) {
  const ctx = this.ctx, P = this.P;
  const pcAbs = (P.root + rootOff) % 12;
  const midi = 33 + ((pcAbs - 33) % 12 + 12) % 12;
  const f = midiToFreq(midi);
  const vel = 0.5 + 0.15 * P.energy / 100;
  const sub = ctx.createOscillator(); sub.frequency.value = f;
  const saw = ctx.createOscillator(); saw.type = 'sawtooth'; saw.frequency.value = f;
  const sawG = ctx.createGain(); sawG.gain.value = 0.25;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 180; lp.Q.value = 0.6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.4 * vel, t + 0.06);
  g.gain.setValueAtTime(0.4 * vel, t + Math.max(0.08, dur - 0.2));
  g.gain.linearRampToValueAtTime(0, t + dur + 0.25);
  sub.connect(lp); saw.connect(sawG); sawG.connect(lp); lp.connect(g);
  g.connect(this.nodes.bass.g);
  sub.start(t); saw.start(t);
  sub.stop(t + dur + 0.3); saw.stop(t + dur + 0.3);
  scrap(sub, [g, lp, saw, sawG]);
};

/* HAZE: 2 detuned saws per pitch (chord root + fifth), lowpass 520 on the
   bus; 3 s attack, sustains the whole chord segment, long release */
Pulse.scheduleHazeSegment = function (t, durSec, late) {
  const ctx = this.ctx, P = this.P;
  const pcAbs = (P.root + this.chord.rootOff) % 12;
  const rootM = 45 + ((pcAbs - 45) % 12 + 12) % 12;
  const atk = late ? 1 : 3;
  this.hazeEnd = t + durSec;
  this.hazeAudioEnd = t + durSec + 4;
  for (const [m, lvl] of [[rootM, 0.05], [rootM + this.chord.fifthOff, 0.036]]) {
    const f = midiToFreq(m);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(lvl, t + atk);
    g.gain.setValueAtTime(lvl, t + durSec);
    g.gain.linearRampToValueAtTime(0, t + durSec + 4);
    g.connect(this.nodes.haze.g);
    const oscs = [];
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(g);
      o.start(t); o.stop(t + durSec + 4.2);
      oscs.push(o);
    }
    scrap(oscs[0], [g, oscs[1]]);
  }
};

/* TICK "shh": shared noise -> bandpass 3.5 kHz Q2, soft envelope.
   Centered just above the default master Brightness lowpass (~2.6 kHz)
   and hot enough to survive it — audible air, never a hi-hat. */
Pulse.playShh = function (t, vel) {
  const ctx = this.ctx;
  const n = this.noiseSource(t, 0.16);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 3500; bp.Q.value = 2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.4 * vel, t + 0.02);
  g.gain.exponentialRampToValueAtTime(1e-4, t + 0.12);
  g.gain.linearRampToValueAtTime(0, t + 0.14);
  n.connect(bp); bp.connect(g); g.connect(this.nodes.tick.g);
  scrap(n, [bp, g]);
};

/* soft thump on step 0: sine 110 -> 48 Hz, 0.18 s */
Pulse.playThump = function (t) {
  const ctx = this.ctx;
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(110, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.14);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.7, t + 0.008);
  g.gain.exponentialRampToValueAtTime(1e-4, t + 0.18);
  g.gain.linearRampToValueAtTime(0, t + 0.2);
  o.connect(g); g.connect(this.nodes.tick.g);
  o.start(t); o.stop(t + 0.22);
  scrap(o, [g]);
};

/* =====================================================================
   Transport
===================================================================== */
Pulse.play = function () {
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
    this.nextStepTime = now + 0.2;
    this.stepIdx = 0; this.loopIdx = 0; this.chordPos = -1;
    window.__studio = {
      ctx, tap: this.nodes.analyser, version: '03-pulse',
      play: () => Pulse.play(), pause: () => Pulse.pause(),
    };
  }
  /* gentle rise-from-silence on every (re)start */
  const target = this.masterTarget();
  this.nodes.master.gain.cancelScheduledValues(now);
  this.nodes.master.gain.setValueAtTime(Math.min(this.nodes.master.gain.value, target * 0.3), now);
  this.nodes.master.gain.setTargetAtTime(target, now, first ? 1.0 : 0.5);
  if (!this.timer) this.timer = setInterval(() => this.tick(), 500);
  this.tick();
};

Pulse.pause = function () {
  if (!this.playing || !this.ctx) return;
  this.playing = false;
  const ctx = this.ctx, now = ctx.currentTime;
  this.elapsedBase += now - this.resumeMark;
  this.nodes.master.gain.cancelScheduledValues(now);
  this.nodes.master.gain.setTargetAtTime(0.0001, now, 0.06);
  setTimeout(() => { if (!this.playing) ctx.suspend(); }, 280);
};

Pulse.elapsed = function () {
  if (!this.ctx) return 0;
  return this.elapsedBase + (this.playing ? this.ctx.currentTime - this.resumeMark : 0);
};
