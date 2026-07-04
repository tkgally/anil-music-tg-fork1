/* ---------------------------------------------------------------------
   05 · Deep Work — audio engine.

   CONCEPT   Daysong's studio, retuned to sit behind your work. One
             Presence macro folds the whole mix background <-> foreground;
             a session timer (endless / 25 / 50 min) shapes the hour with
             a ramp-in, a plateau, a wind-down and a closing chime.

   PARAMS    S (raw UI state, owned by main.js) -> derive(S) applies the
             Presence fold (piecewise-linear through @0/@50/@100 anchors)
             to mix.lead/counter/pad, melody ceiling & density, arp,
             perc gate, energy ceiling, master lowpass, echo wet and
             develop ops — except where the user PINNED a param in
             Advanced (S.pinned), in which case the slider value wins.

   SCHEDULE  Live lookahead loop instead of Daysong's offline render —
             that is the point of the experiment: no encode, no download,
             the engine composes the next bar whenever the horizon needs
             it (tick every 500 ms; horizon 6 s visible / 12 s hidden;
             a late wake resumes with a 1 s fade-in, never a burst).
             Pause = ctx.suspend(), so ctx.currentTime is pause-aware
             and all session math stays honest.
--------------------------------------------------------------------- */
'use strict';

const DW = {
  ctx: null, N: {}, B: {}, S: null,
  playing: false, everPlayed: false, started: false,
  timer: null, nextBarT: 0, composer: null,
  seenSeed: null, seenSession: null, pendingReseed: false,
  sessionLen: null, sessionStartT: 0,
  sessionEnding: false, sessionDone: false, sessionEndT: null,
  vizNotes: [], cues: [], arng: null,
  onstate: null,               // main.js hook: transport UI refresh
};

/* =====================================================================
   The Presence fold. Pure: main.js uses it for the mapping table and
   for tracking the unpinned Advanced sliders. Columns are @0/@50/@100.
===================================================================== */
DW.derive = function (S) {
  const p = S.presence / 100;
  const pin = k => S.pinned.indexOf(k) >= 0;
  const D = {};
  D.mixLead    = pin('lead')    ? S.mixlead / 100    : pw(p, 0.12, 0.45, 0.85);
  D.mixCounter = pin('counter') ? S.mixcounter / 100 : pw(p, 0, 0.3, 0.6);
  D.padRel     = pw(p, 1.0, 0.85, 0.7);
  D.mixPad     = pin('pad')     ? S.mixpad / 100     : 0.8 * D.padRel;
  D.mixArp     = p <= 0.6 ? 0 : (p - 0.6) * 1.25;               // 0 -> 0.5 over 60..100
  D.melCeil    = Math.round(pw(p, 62, 69, 79));
  D.melDensity = pw(p, 0.4, 0.8, 1.15);
  D.percGate   = pw(p, 0.62, 0.5, 0.34);
  D.energyCeil = pw(p, 0.4, 0.6, 0.9);
  D.masterLP   = pin('lowpass') ? S.masterlp         : Math.round(pw(p, 2400, 4800, 12000));
  D.echoWet    = pin('echo')    ? S.echo / 100       : pw(p, 0.06, 0.15, 0.3);
  D.ops        = p >= 0.7 ? 2 : (p >= 0.45 ? 1 : 0);
  return D;
};

/* =====================================================================
   Graph
===================================================================== */

/* Impulse response: seeded noise, exponential decay, lowpass swept down
   the tail (air absorption) + short fade-in (shared-spec recipe). */
function makeImpulse(ctx, rng, seconds, decay) {
  const rate = ctx.sampleRate, len = Math.floor(rate * seconds), fade = Math.floor(rate * 0.02);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const k = Math.exp(-2 * Math.PI * (10000 * Math.pow(0.1, t)) / rate);  // 10k -> 1k
      lp = k * lp + (1 - k) * (rng.next() * 2 - 1);
      d[i] = lp * Math.pow(1 - t, decay) * (i < fade ? i / fade : 1) * 3;
    }
  }
  return buf;
}

function scrap(src, parts) {
  src.onended = () => { for (const n of parts) { try { n.disconnect(); } catch (e) {} } };
}

DW.build = function (S) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  this.ctx = ctx;
  const N = this.N;
  this.arng = mulberry32(((S.seed >>> 0) ^ 0x9e3779b9) >>> 0);   // audio-layer stream (detune)

  /* master chain: volume -> quiet-listening tilt -> Presence lowpass
     -> glue -> limiter -> session fade -> analyser -> out */
  N.master = ctx.createGain(); N.master.gain.value = 0;
  N.shelfLo = ctx.createBiquadFilter();
  N.shelfLo.type = 'lowshelf'; N.shelfLo.frequency.value = 150; N.shelfLo.gain.value = 0;
  N.shelfHi = ctx.createBiquadFilter();
  N.shelfHi.type = 'highshelf'; N.shelfHi.frequency.value = 8000; N.shelfHi.gain.value = 0;
  N.lp = ctx.createBiquadFilter();
  N.lp.type = 'lowpass'; N.lp.Q.value = 0.5; N.lp.frequency.value = 3600;
  N.comp = ctx.createDynamicsCompressor();
  N.comp.threshold.value = -18; N.comp.knee.value = 24; N.comp.ratio.value = 2.5;
  N.comp.attack.value = 0.01; N.comp.release.value = 0.25;
  N.limiter = ctx.createDynamicsCompressor();
  N.limiter.threshold.value = -4; N.limiter.knee.value = 0; N.limiter.ratio.value = 16;
  N.limiter.attack.value = 0.001; N.limiter.release.value = 0.1;
  N.session = ctx.createGain(); N.session.gain.value = 1;
  N.analyser = ctx.createAnalyser(); N.analyser.fftSize = 2048;
  N.master.connect(N.shelfLo); N.shelfLo.connect(N.shelfHi); N.shelfHi.connect(N.lp);
  N.lp.connect(N.comp); N.comp.connect(N.limiter); N.limiter.connect(N.session);
  N.session.connect(N.analyser); N.analyser.connect(ctx.destination);

  /* shared noise: ONE seeded 2 s loop (Daysong idiom) */
  const nrng = new RNG((S.seed ^ 0x6d2b79f5) >>> 0);
  N.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = N.noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = nrng.next() * 2 - 1;

  /* reverb: 3 s generated stereo impulse, per-bus sends */
  N.convolver = ctx.createConvolver();
  N.convolver.buffer = makeImpulse(ctx, new RNG((S.seed ^ 0x51ed27) >>> 0), 3.0, 3.0);
  N.reverbRet = ctx.createGain(); N.reverbRet.gain.value = 1;
  N.convolver.connect(N.reverbRet); N.reverbRet.connect(N.master);

  /* echo (dotted eighth) for lead & arp; darker tone than the studio */
  N.echoIn = ctx.createGain();
  N.delay = ctx.createDelay(2.0);
  N.delay.delayTime.value = 0.75 * (60 / S.tempo);
  N.fb = ctx.createGain(); N.fb.gain.value = 0.26;
  N.echoTone = ctx.createBiquadFilter();
  N.echoTone.type = 'lowpass'; N.echoTone.frequency.value = 3000;
  N.echoWet = ctx.createGain(); N.echoWet.gain.value = 0.1;
  N.echoIn.connect(N.delay); N.delay.connect(N.echoTone);
  N.echoTone.connect(N.fb); N.fb.connect(N.delay);
  N.echoTone.connect(N.echoWet); N.echoWet.connect(N.master); N.echoWet.connect(N.convolver);
  N.echoLead = ctx.createGain(); N.echoLead.gain.value = 1;    // halved for 'glass'
  N.echoLead.connect(N.echoIn);

  /* focus pulse: 16 Hz AM on the pad+bass bed. Rate & phase fixed for
     the lifetime of the context — predictable AM entrains, irregular
     AM distracts. Depth ramps over ~30 s in applyParams. */
  N.bed = ctx.createGain(); N.bed.gain.value = 1;
  N.bed.connect(N.master);
  N.pulseOsc = ctx.createOscillator(); N.pulseOsc.frequency.value = 16;
  N.pulseGain = ctx.createGain(); N.pulseGain.gain.value = 0;
  N.pulseOsc.connect(N.pulseGain); N.pulseGain.connect(N.bed.gain);
  N.pulseOsc.start();

  /* voice buses: gain -> [lowpass] -> pan -> master (pad/bass via bed) */
  const mkBus = (lpHz, pan, toBed) => {
    const g = ctx.createGain(); g.gain.value = 0;
    let tail = g, lp = null;
    if (lpHz) {
      lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = lpHz; lp.Q.value = 0.5;
      g.connect(lp); tail = lp;
    }
    const p = ctx.createStereoPanner(); p.pan.value = pan || 0;
    tail.connect(p); p.connect(toBed ? N.bed : N.master);
    const send = ctx.createGain(); send.gain.value = 0;
    g.connect(send); send.connect(N.convolver);
    return { in: g, lp, p, send };
  };
  const B = this.B;
  B.lead = mkBus(null, 0.14, false);
  B.counter = mkBus(1400, -0.18, false);
  B.pad = mkBus(null, 0, true);
  B.bass = mkBus(null, 0, true);
  B.arp = mkBus(null, 0.22, false);
  B.perc = mkBus(null, 0.08, false);

  /* very slow opposite pan drift on lead/counter (< 0.1 Hz, |pan|<=0.32) */
  N.drift = ctx.createOscillator(); N.drift.frequency.value = 0.022;
  N.driftL = ctx.createGain(); N.driftL.gain.value = 0.09;
  N.driftC = ctx.createGain(); N.driftC.gain.value = -0.09;
  N.drift.connect(N.driftL); N.driftL.connect(B.lead.p.pan);
  N.drift.connect(N.driftC); N.driftC.connect(B.counter.p.pan);
  N.drift.start();

  this.applyParams(S);
};

/* =====================================================================
   Live parameter application (smoothed; nothing requires a restart)
===================================================================== */
DW.applyParams = function (S) {
  this.S = S;
  /* seed / session changes tracked even before the graph exists */
  if (this.seenSeed != null && S.seed !== this.seenSeed) this.pendingReseed = true;
  this.seenSeed = S.seed;
  if (this.seenSession != null && S.session !== this.seenSession) this.resetSession();
  this.sessionLen = S.session === 'endless' ? null : Number(S.session) * 60;
  this.seenSession = S.session;
  /* queue key/mode changes right away so the status hint shows even when paused */
  if (this.composer && (this.composer.homeRoot !== S.root || this.composer.homeMode !== S.mode)) {
    this.composer.setHome(S.root, S.mode);
  }
  if (!this.ctx) return;

  const ctx = this.ctx, N = this.N, B = this.B, now = ctx.currentTime;
  const set = (param, val, tau) => param.setTargetAtTime(val, now, tau || 0.15);
  const D = this.derive(S);

  /* volume + quiet-listening tilt (Fletcher–Munson compensation) */
  const v = S.volume / 100;
  if (this.playing) set(N.master.gain, this.masterTarget(), 0.09);
  const shelfDb = clamp(6 * (0.7 - v), 0, 5);
  set(N.shelfLo.gain, shelfDb, 0.2);
  set(N.shelfHi.gain, shelfDb, 0.2);

  /* the fold: master lowpass + echo */
  set(N.lp.frequency, D.masterLP, 0.12);
  set(N.echoWet.gain, D.echoWet, 0.2);
  set(N.fb.gain, 0.2 + D.echoWet * 0.35, 0.2);
  set(N.delay.delayTime, 0.75 * (60 / S.tempo), 0.3);        // brief tape-slew on tempo moves
  set(N.echoLead.gain, S.leadTimbre === 'glass' ? 0.5 : 1, 0.1);

  /* mixer (trims tuned against the harness; pad is the loudest voice,
     but the lead must still read through the bed) */
  set(B.lead.in.gain, Math.pow(D.mixLead, 1.4) * 2.6, 0.12);
  set(B.counter.in.gain, Math.pow(D.mixCounter, 1.4) * 1.6, 0.12);
  set(B.pad.in.gain, Math.pow(D.mixPad, 1.4) * 1.35, 0.12);
  set(B.bass.in.gain, Math.pow(S.mixbass / 100, 1.4) * 1.1, 0.12);
  set(B.perc.in.gain, Math.pow(S.mixperc / 100, 1.4) * 1.5, 0.12);
  set(B.arp.in.gain, Math.pow(D.mixArp, 1.4) * 2.2, 0.12);

  /* reverb sends: Daysong's amounts, pad raised to 0.7 */
  const sendAmt = { lead: 0.4, counter: 0.38, pad: 0.7, arp: 0.34, bass: 0.07, perc: 0.18 };
  const rmix = S.reverb / 100;
  for (const name of Object.keys(sendAmt)) {
    set(B[name].send.gain, rmix * sendAmt[name] * 1.6, 0.2);
  }

  /* focus pulse: depth ramps in/out over ~30 s, rate/phase untouched */
  const depth = S.focuspulse === 'stronger' ? 0.15 : (S.focuspulse === 'gentle' ? 0.08 : 0);
  N.pulseGain.gain.setTargetAtTime(depth / 2, now, 10);
  N.bed.gain.setTargetAtTime(1 - depth / 2, now, 10);
};

/* master gain target: volume taper + trim + preset level-matching.
   The dB terms compensate what Presence/Tempo/Motion add. Loudness grows
   convexly with presence (counter/arp/perc arrive late), so the linear
   term alone left mid presence ("Light lift") ~1 dB quiet — the pw()
   bump lifts the middle. Tuned with the harness at the shared seed:
   the four presets land within ~0.5 dB of each other. */
DW.masterTarget = function () {
  const S = this.S;
  const matchDb = -(S.presence - 25) * 0.04 + pw(S.presence / 100, 0, 0.45, 0)
                - (S.tempo - 84) * 0.006 - (S.motion - 35) * 0.004;
  return Math.pow(S.volume / 100, 1.6) * 1.35 * Math.pow(10, clamp(matchDb, -7, 3) / 20);
};

/* =====================================================================
   Session arc: ramp-in, plateau, wind-down, chime, auto-pause
===================================================================== */
DW.sessionGates = function (t) {
  const g = { melody: true, extras: true, bass: true, mult: 1 };
  if (this.sessionLen == null) return g;
  const el = t - this.sessionStartT;
  const rem = this.sessionLen - el;
  const barSec = (METERS[this.S.meter].steps / 4) * (60 / this.S.tempo);
  if (el < 6 * barSec) { g.melody = false; g.extras = false; }   // thin start: pad+bass
  g.mult = el < 120 ? 0.35 + 0.65 * (el / 120) : 1;              // 2 min ramp-in
  if (rem < 190) g.mult = Math.min(g.mult, 0.25 + 0.75 * clamp((rem - 10) / 180, 0, 1));
  if (rem < 130) g.extras = false;                                // wind-down: thin out
  if (rem < 70) g.melody = false;
  if (rem < 30) g.bass = false;                                   // pad only
  return g;
};

DW.resetSession = function () {
  this.sessionEnding = false;
  this.sessionDone = false;
  this.sessionEndT = null;
  if (!this.ctx || !this.started) return;
  const now = this.ctx.currentTime;
  this.sessionStartT = now;
  const g = this.N.session.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(Math.max(0.001, g.value), now);
  g.linearRampToValueAtTime(1, now + 0.8);
  if (this.playing && this.nextBarT < now) this.nextBarT = now + 0.15;
};

DW.beginSessionEnd = function (t) {
  this.sessionEnding = true;
  this.sessionEndT = t + 10;
  const g = this.N.session.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(1, t);
  g.exponentialRampToValueAtTime(0.001, t + 9.4);
  g.linearRampToValueAtTime(0, t + 9.8);
  this.playChime(t + 0.4);
};

DW.finishSession = function () {
  this.sessionDone = true;
  this.pause();
  if (this.onstate) this.onstate();
};

DW.sessionProgress = function () {
  if (this.sessionLen == null || !this.ctx || !this.started) return null;
  return clamp((this.ctx.currentTime - this.sessionStartT) / this.sessionLen, 0, 1);
};

/* =====================================================================
   Transport
===================================================================== */
DW.play = function () {
  if (!this.ctx) this.build(this.S);
  if (this.ctx.state === 'suspended') this.ctx.resume();
  if (this.playing) return;
  this.playing = true;
  const firstStart = !this.started;
  const now = this.ctx.currentTime;
  if (firstStart) {
    this.started = true;
    this.nextBarT = now + 0.15;
    this.sessionStartT = now + 0.15;
  }
  /* "session complete" -> fresh arc. Deliberate: only the session shape
     (ramp-in / plateau / wind-down) restarts; the composer keeps its bar
     stream, so Play continues the same piece under a new session curve. */
  if (this.sessionDone) {
    this.sessionDone = false;
    this.sessionEnding = false;
    this.sessionEndT = null;
    this.sessionStartT = now + 0.15;
    this.nextBarT = now + 0.15;
    const sg = this.N.session.gain;
    sg.cancelScheduledValues(now);
    sg.setValueAtTime(0.001, now);
    sg.linearRampToValueAtTime(1, now + 1);
  }
  const g = this.N.master.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(0.0001, now);
  g.linearRampToValueAtTime(this.masterTarget(), now + (firstStart ? 1.2 : 0.5));
  if (!this.timer) this.timer = setInterval(() => this.tick(), 500);
  this.everPlayed = true;
  this.tick();
  window.__studio = {
    ctx: this.ctx, tap: this.N.analyser,
    play: () => DW.play(), pause: () => DW.pause(),
    version: '05-deepwork',
  };
  if (this.onstate) this.onstate();
};

DW.pause = function () {
  if (!this.playing) return;
  this.playing = false;
  const ctx = this.ctx, now = ctx.currentTime;
  const g = this.N.master.gain;
  const cur = typeof g.value === 'number' ? g.value : this.masterTarget();
  g.cancelScheduledValues(now);
  g.setValueAtTime(Math.max(0.0001, cur), now);
  g.linearRampToValueAtTime(0.0001, now + 0.12);
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  setTimeout(() => {
    if (!this.playing && this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }, 220);
  if (this.onstate) this.onstate();
};

DW.elapsed = function () {
  return this.ctx ? Math.max(0, this.ctx.currentTime - 0.15) : 0;
};

/* =====================================================================
   Scheduler: lookahead loop, one bar at a time
===================================================================== */
DW.tick = function () {
  if (!this.playing || !this.ctx) return;
  const now = this.ctx.currentTime;
  if (this.sessionEnding) {
    if (this.sessionEndT != null && now >= this.sessionEndT) this.finishSession();
    return;
  }
  const horizon = document.hidden ? 12 : 6;
  if (this.nextBarT < now - 0.05) {
    /* the schedule ran dry (late wake): skip ahead, resume with a fade-in */
    this.nextBarT = now + 0.12;
    const g = this.N.master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0.0001, now);
    g.linearRampToValueAtTime(this.masterTarget(), now + 1);
  }
  let guard = 0;
  while (!this.sessionEnding && this.nextBarT < now + horizon && guard++ < 48) {
    this.scheduleBar();
  }
  /* prune viz + cue history */
  const cutoff = now - 40;
  while (this.vizNotes.length && this.vizNotes[0].t + this.vizNotes[0].dur < cutoff) this.vizNotes.shift();
  while (this.cues.length > 2 && this.cues[1].t < cutoff) this.cues.shift();
};

DW.scheduleBar = function () {
  const S = this.S, t = this.nextBarT;
  if (this.sessionLen != null && (t - this.sessionStartT) >= this.sessionLen - 10) {
    this.beginSessionEnd(t);
    return;
  }
  const D = this.derive(S);
  const gates = this.sessionGates(t);
  if (this.pendingReseed) {
    this.composer = null;
    this.pendingReseed = false;
    this.arng = mulberry32(((S.seed >>> 0) ^ 0x9e3779b9) >>> 0);
  }
  const P = {
    root: S.root, mode: S.mode, meter: S.meter,
    motion: S.motion / 100, complexity: S.complexity / 100, gravity: S.gravity / 100,
    shadow: S.shadow / 100, fractality: S.fractality / 100, hocket: S.hocket / 100,
    humanity: S.humanity / 100, wanderlust: S.wanderlust / 100, swing: S.swing / 100,
    melCeil: D.melCeil, melDensity: D.melDensity, ops: D.ops,
    energyCeil: D.energyCeil, percGate: D.percGate, sessionMult: gates.mult,
    leadOn: D.mixLead > 0.005 && gates.melody,
    counterOn: D.mixCounter > 0.005 && gates.extras,
    arpOn: D.mixArp > 0.005 && gates.extras,
    percOn: S.mixperc > 0 && gates.extras,
    bassOn: S.mixbass > 0 && gates.bass,
    padOn: D.mixPad > 0.005,
  };
  if (!this.composer) this.composer = new DWComposer(S.seed >>> 0, P);
  if (this.composer.homeRoot !== S.root || this.composer.homeMode !== S.mode) {
    this.composer.setHome(S.root, S.mode);
  }
  const bar = this.composer.nextBar(P);
  const sp = (60 / S.tempo) / 4;                       // seconds per 16th step
  for (const e of bar.events) {
    const et = t + e.step * sp;
    if (e.voice === 'perc') {
      this.playPerc(et, e.type, e.vel);
      this.vizNotes.push({ t: et, dur: 0.12, midi: 0, voice: 'perc' });
      continue;
    }
    const dur = (e.dur || 1) * sp;
    const f = midiToFreq(e.midi);
    if (e.voice === 'pad') this.playPad(et, f, dur, e.vel, S.padTimbre, bar.energy);
    else if (e.voice === 'lead') this.playLead(et, f, dur, e.vel, S);
    else if (e.voice === 'counter') this.playCounter(et, f, dur, e.vel);
    else if (e.voice === 'bass') this.playBass(et, f, dur, e.vel);
    else if (e.voice === 'arp') this.playArp(et, f, dur, e.vel);
    this.vizNotes.push({ t: et, dur, midi: e.midi, voice: e.voice });
  }
  this.cues.push({
    t, energy: bar.energy, section: bar.display.section, key: bar.display.key,
    chord: bar.display.chord, barsLeft: bar.display.barsLeft, pivot: bar.display.pivot,
    barDur: bar.steps * sp,
  });
  this.nextBarT = t + bar.steps * sp;
};

DW.pendingHomeLabel = function () {
  const c = this.composer;
  if (!c || !c.pendingHome) return null;
  return NOTE_NAMES[c.pendingHome.root] + ' ' +
    (MODE_LABELS[c.pendingHome.mode] || c.pendingHome.mode);
};

/* =====================================================================
   Voices — Daysong recipes (engine/voices.js), softened for the
   background: breath/glass/keys lead (glass attack 60 ms + half echo,
   keys FM index ×0.7), triangle counter at lowpass 1400, warm/halo/
   strings pad, Daysong bass, shaker/hat at half velocity + soft thump.
===================================================================== */
DW.noiseSource = function (t, dur) {
  const src = this.ctx.createBufferSource();
  src.buffer = this.N.noiseBuf;
  src.loop = true;
  src.start(t);
  src.stop(t + dur);
  return src;
};

DW.playLead = function (t, freq, dur, vel, S) {
  const ctx = this.ctx, bus = this.B.lead.in, echo = this.N.echoLead;
  const detune = (this.arng() * 2 - 1) * (S.humanity / 100) * 7;
  const timbre = S.leadTimbre;
  if (timbre === 'glass') {
    const car = ctx.createOscillator();
    car.frequency.value = freq; car.detune.value = detune;
    const mod = ctx.createOscillator();
    mod.frequency.value = freq * 3.003;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(freq * (1.2 + vel * 1.4), t);
    mg.gain.exponentialRampToValueAtTime(freq * 0.04, t + Math.max(0.25, dur * 0.85));
    mod.connect(mg); mg.connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.15 * vel, t + 0.06);        // stretched attack
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.5);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.56);
    car.connect(g); g.connect(bus); g.connect(echo);
    car.start(t); mod.start(t);
    car.stop(t + dur + 0.6); mod.stop(t + dur + 0.6);
    scrap(car, [g, mg, mod]);
  } else if (timbre === 'keys') {          // FM e-piano, index ×0.7
    const car = ctx.createOscillator();
    car.frequency.value = freq; car.detune.value = detune;
    const mod = ctx.createOscillator();
    mod.frequency.value = freq;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(freq * (0.5 + vel * 1.1) * 0.7, t);
    mg.gain.exponentialRampToValueAtTime(freq * 0.03, t + Math.max(0.3, dur));
    mod.connect(mg); mg.connect(car.frequency);
    const tine = ctx.createOscillator();
    tine.frequency.value = freq * 6.93;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.035 * vel, t);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    tine.connect(tg);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.17 * vel, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.7);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.76);
    car.connect(g); tg.connect(g); g.connect(bus); g.connect(echo);
    car.start(t); mod.start(t); tine.start(t);
    car.stop(t + dur + 0.8); mod.stop(t + dur + 0.8); tine.stop(t + 0.12);
    scrap(car, [g, mg, mod, tg]);
  } else {                                  // 'breath' (default)
    const o1 = ctx.createOscillator();
    o1.frequency.value = freq; o1.detune.value = detune;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle'; o2.frequency.value = freq * 1.004;
    const o2g = ctx.createGain(); o2g.gain.value = 0.4;
    const vib = ctx.createOscillator(); vib.frequency.value = 4.8;
    const vibG = ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(7, t + Math.min(0.5, dur * 0.6));
    vib.connect(vibG); vibG.connect(o1.detune); vibG.connect(o2.detune);
    const breath = this.noiseSource(t, dur + 0.2);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq * 2; bp.Q.value = 4;
    const bg = ctx.createGain(); bg.gain.value = 0.05 * vel;
    breath.connect(bp); bp.connect(bg);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16 * vel, t + 0.05);
    g.gain.setValueAtTime(0.16 * vel, t + Math.max(0.06, dur - 0.06));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.12);
    o1.connect(g); o2.connect(o2g); o2g.connect(g); bg.connect(g);
    g.connect(bus); g.connect(echo);
    o1.start(t); o2.start(t); vib.start(t);
    o1.stop(t + dur + 0.2); o2.stop(t + dur + 0.2); vib.stop(t + dur + 0.2);
    scrap(o1, [g, o2, o2g, vib, vibG, bp, bg]);
  }
};

DW.playCounter = function (t, freq, dur, vel) {
  const ctx = this.ctx;
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.15 * vel, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.04 * vel + 0.0001, t + Math.max(0.1, dur * 0.7));
  g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
  const o2 = ctx.createOscillator();
  o2.frequency.value = freq * 2.001;
  const o2g = ctx.createGain(); o2g.gain.value = 0.14;
  osc.connect(g); o2.connect(o2g); o2g.connect(g);
  g.connect(this.B.counter.in);                      // bus lowpass 1400 does the softening
  osc.start(t); o2.start(t);
  osc.stop(t + dur + 0.15); o2.stop(t + dur + 0.15);
  scrap(osc, [g, o2, o2g]);
};

DW.playPad = function (t, freq, dur, vel, timbre, energy) {
  const ctx = this.ctx, bus = this.B.pad.in;
  const levels = { warm: 0.052, halo: 0.052, strings: 0.042 };
  const level = (levels[timbre] || 0.05) * vel;
  const g = ctx.createGain();
  const atk = (timbre === 'strings')
    ? Math.min(0.7, dur * 0.22 + 0.12)
    : Math.min(1.3, dur * 0.3 + 0.15);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + atk);
  g.gain.setValueAtTime(level, t + Math.max(atk, dur - 0.2));
  g.gain.linearRampToValueAtTime(0, t + dur + 1.4);
  g.connect(bus);
  const stopAt = t + dur + 1.6;
  const oscs = [], extras = [];
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = 0.7;

  if (timbre === 'halo') {
    lp.frequency.value = 1200 + energy * 3000;
    const o1 = ctx.createOscillator();
    o1.type = 'triangle'; o1.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.frequency.value = freq * 2;
    const o2g = ctx.createGain(); o2g.gain.value = 0.3;
    o1.connect(lp); o2.connect(o2g); o2g.connect(lp); lp.connect(g);
    oscs.push(o1, o2); extras.push(lp, o2g);
    const shim = ctx.createOscillator(); shim.frequency.value = 0.31;
    const shimG = ctx.createGain(); shimG.gain.value = 7;
    shim.connect(shimG); shimG.connect(o1.detune); shimG.connect(o2.detune);
    oscs.push(shim); extras.push(shimG);
  } else if (timbre === 'strings') {
    lp.frequency.value = 700 + energy * 2400;
    for (const det of [-12, -4, 5, 11]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(lp);
      oscs.push(o);
    }
    lp.connect(g); extras.push(lp);
    const bow = ctx.createOscillator(); bow.frequency.value = 0.4;
    const bowG = ctx.createGain(); bowG.gain.value = 160;
    bow.connect(bowG); bowG.connect(lp.frequency);
    oscs.push(bow); extras.push(bowG);
  } else {                                   // 'warm' (default)
    lp.frequency.value = 420 + energy * 2600;
    for (const det of [-8, 0, 8]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(lp);
      oscs.push(o);
    }
    lp.connect(g); extras.push(lp);
  }
  for (const o of oscs) { o.start(t); o.stop(stopAt); }
  scrap(oscs[0], [g, ...extras, ...oscs.slice(1)]);
};

DW.playBass = function (t, freq, dur, vel) {
  const ctx = this.ctx;
  const sub = ctx.createOscillator();
  sub.frequency.value = freq;
  const saw = ctx.createOscillator();
  saw.type = 'sawtooth'; saw.frequency.value = freq;
  const sawG = ctx.createGain(); sawG.gain.value = 0.3;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(180 + vel * 420, t);
  lp.frequency.exponentialRampToValueAtTime(140, t + Math.max(0.1, dur));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.34 * vel, t + 0.03);          // softened attack
  g.gain.setValueAtTime(0.34 * vel, t + Math.max(0.04, dur - 0.08));
  g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
  sub.connect(lp); saw.connect(sawG); sawG.connect(lp); lp.connect(g);
  g.connect(this.B.bass.in);
  sub.start(t); saw.start(t);
  sub.stop(t + dur + 0.14); saw.stop(t + dur + 0.14);
  scrap(sub, [g, lp, saw, sawG]);
};

DW.playArp = function (t, freq, dur, vel) {
  const ctx = this.ctx;
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = freq;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1200 + vel * 2600;
  lp.Q.value = 1.6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.11 * vel, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.08, dur * 0.9));
  g.gain.linearRampToValueAtTime(0, t + Math.max(0.1, dur * 0.9) + 0.03);
  osc.connect(lp); lp.connect(g);
  g.connect(this.B.arp.in);
  g.connect(this.N.echoIn);
  osc.start(t); osc.stop(t + dur + 0.15);
  scrap(osc, [g, lp]);
};

DW.playPerc = function (t, type, vel) {
  const ctx = this.ctx, bus = this.B.perc.in;
  if (type === 'shaker') {
    const n = this.noiseSource(t, 0.09);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 5200; bp.Q.value = 2.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.11 * vel, t + 0.02);    // ~half the studio level
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    g.gain.linearRampToValueAtTime(0, t + 0.088);
    n.connect(bp); bp.connect(g); g.connect(bus);
    scrap(n, [bp, g]);
  } else if (type === 'hat') {
    const n = this.noiseSource(t, 0.06);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 8200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13 * vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    g.gain.linearRampToValueAtTime(0, t + 0.05);
    n.connect(hp); hp.connect(g); g.connect(bus);
    scrap(n, [hp, g]);
  } else if (type === 'thump') {                  // rare soft kick
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.4 * vel, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    g.gain.linearRampToValueAtTime(0, t + 0.3);
    o.connect(g); g.connect(bus);
    o.start(t); o.stop(t + 0.32);
    scrap(o, [g]);
  }
};

/* Session-end chime: two sine partials, ~1.5 s bloom, routed after the
   session fade so it rings clear over the receding music. A fixed gentle
   lowpass (~4 kHz) softens it toward the mix's tone at dark settings —
   it still deliberately bypasses the master chain. */
DW.playChime = function (t) {
  const ctx = this.ctx, S = this.S;
  const m = 72 + ((S.root - 0) % 12 + 12) % 12;      // tonic around C5..B5
  const f = midiToFreq(m > 78 ? m - 12 : m);
  const amp = 0.11 * Math.pow(S.volume / 100, 1.6) / Math.pow(0.7, 1.6);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(amp, t + 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 4);
  g.gain.linearRampToValueAtTime(0, t + 4.1);
  const o1 = ctx.createOscillator(); o1.frequency.value = f;
  const o2 = ctx.createOscillator(); o2.frequency.value = f * 2.004;
  const o2g = ctx.createGain(); o2g.gain.value = 0.35;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 4000; lp.Q.value = 0.5;
  o1.connect(g); o2.connect(o2g); o2g.connect(g);
  g.connect(lp); lp.connect(this.N.analyser);
  o1.start(t); o2.start(t);
  o1.stop(t + 4.2); o2.stop(t + 4.2);
  scrap(o1, [g, o2, o2g, lp]);
};

/* refresh the lookahead promptly when the tab becomes visible again */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) DW.tick();
});
