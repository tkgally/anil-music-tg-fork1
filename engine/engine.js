/* =====================================================================
   FABLE - autonomous generative synthesizer
   Pure Web Audio. No samples, no libraries.

   ES-module port of the original synth.js. All music/composition/audio
   logic below is unchanged. The song is now rendered OFFLINE (no live
   tuning): renderSong(params) composes every bar and renders the whole
   piece into an AudioBuffer + a piano-roll JSON; encodeSong() turns the
   buffer into an opus/mp3/webm Blob; drawViz() paints one visualization
   frame from the JSON against the current playback time.
   ===================================================================== */

import { mulberry32, noteRnd, clamp, midiToFreq } from "./rng.js";


import { composeSong } from "./composer.js";

/* ---------------------------------------------------------------------
   Audio engine
--------------------------------------------------------------------- */
let ctx = null;
let nodes = null;        // buses & master chain
let noiseBuf = null;
let _audioSeed = 1;      // seeds the noise buffer + reverb impulse (deterministic)
let _agen = Math.random; // seeded generator, set per buildGraph
let _reverbSeconds = 3.2; // convolver IR length (Fast mode shortens it)
let _reverbMono = false;  // Fast mode uses a mono IR (cheaper convolution)
let _fast = false;        // Fast mode: thinner instruments (fewer oscillators)

function buildGraph(context) {
  ctx = context;
  _agen = mulberry32(((_audioSeed >>> 0) ^ 0x6d2b79f5) >>> 0);   // deterministic noise/impulse

  const master = ctx.createGain();
  const tideFilter = ctx.createBiquadFilter();
  tideFilter.type = 'lowpass';
  tideFilter.frequency.value = 18000;
  tideFilter.Q.value = 0.4;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 22;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.24;
  // hard safety limiter: clamps anything that slips past the compressor
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.1;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;

  master.connect(tideFilter);
  tideFilter.connect(comp);
  if (_fast) { comp.connect(analyser); }             // Fast: skip the safety limiter
  else { comp.connect(limiter); limiter.connect(analyser); }
  analyser.connect(ctx.destination);

  // reverb
  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(_reverbSeconds, 2.6);
  const reverbOut = ctx.createGain();
  reverbOut.gain.value = 1;
  convolver.connect(reverbOut);
  reverbOut.connect(master);

  // echo (dotted eighth) for lead & arp
  const echoIn = ctx.createGain();
  const delay = ctx.createDelay(2.0);
  delay.delayTime.value = 0.42;
  const fb = ctx.createGain();
  fb.gain.value = 0.34;
  const echoTone = ctx.createBiquadFilter();
  echoTone.type = 'lowpass';
  echoTone.frequency.value = 4200;
  const echoWet = ctx.createGain();
  echoWet.gain.value = 0.3;
  echoIn.connect(delay);
  delay.connect(echoTone);
  echoTone.connect(fb);
  fb.connect(delay);
  echoTone.connect(echoWet);
  echoWet.connect(master);
  echoWet.connect(convolver);

  // voice buses with individual reverb sends
  const buses = {};
  const sendAmt = { lead: 0.4, counter: 0.38, pad: 0.6, arp: 0.34, bass: 0.07, perc: 0.18 };
  const sends = {};
  for (const name of ['lead', 'counter', 'pad', 'arp', 'bass', 'perc']) {
    const g = ctx.createGain();
    g.connect(master);
    const send = ctx.createGain();
    send.gain.value = 0;
    g.connect(send);
    send.connect(convolver);
    buses[name] = g;
    sends[name] = send;
  }

  // shared noise buffer (seeded -> identical across render segments)
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = _agen() * 2 - 1;

  nodes = { master, tideFilter, comp, analyser, convolver, reverbOut, echoIn, delay, fb, echoWet, buses, sends, sendAmt };
  applyMixes();
  applySpace();
}

function makeImpulse(seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const chs = _reverbMono ? 1 : 2;
  const buf = ctx.createBuffer(chs, len, rate);
  for (let ch = 0; ch < chs; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (_agen() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function noiseSource(t, dur) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  src.start(t);
  src.stop(t + dur);
  return src;
}

function scrap(src, parts) {
  src.onended = () => { for (const n of parts) { try { n.disconnect(); } catch (e) {} } };
}

/* ----- instruments ----- */
function playLead(t, freq, dur, vel, P, rnd) {
  const bus = nodes.buses.lead;
  const detune = ((rnd == null ? Math.random() : rnd) * 2 - 1) * P.humanity * 7;
  const timbre = P.leadTimbre;
  if (timbre === 'glass') {
    const car = ctx.createOscillator();
    car.frequency.value = freq;
    car.detune.value = detune;
    const mod = ctx.createOscillator();
    mod.frequency.value = freq * 3.003;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(freq * (1.4 + vel * 1.6), t);
    mg.gain.exponentialRampToValueAtTime(freq * 0.04, t + Math.max(0.25, dur * 0.85));
    mod.connect(mg);
    mg.connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.17 * vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.5);
    car.connect(g);
    g.connect(bus);
    g.connect(nodes.echoIn);
    car.start(t); mod.start(t);
    car.stop(t + dur + 0.6); mod.stop(t + dur + 0.6);
    scrap(car, [g, mg, mod]);
  } else if (timbre === 'reed') {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibG = ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(5, t + Math.min(0.4, dur * 0.5));
    vib.connect(vibG); vibG.connect(osc.detune);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(700 + vel * 2600, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(500, 400 + vel * 1200), t + dur);
    lp.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.15 * vel, t + 0.025);
    g.gain.setValueAtTime(0.15 * vel, t + Math.max(0.03, dur - 0.05));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.08);
    osc.connect(lp); lp.connect(g); g.connect(bus); g.connect(nodes.echoIn);
    osc.start(t); vib.start(t);
    osc.stop(t + dur + 0.15); vib.stop(t + dur + 0.15);
    scrap(osc, [g, lp, vib, vibG]);
  } else if (timbre === 'breath') {
    const o1 = ctx.createOscillator();
    o1.frequency.value = freq;
    o1.detune.value = detune;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = freq * 1.004;
    const o2g = ctx.createGain(); o2g.gain.value = 0.4;
    const vib = ctx.createOscillator(); vib.frequency.value = 4.8;
    const vibG = ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(7, t + Math.min(0.5, dur * 0.6));
    vib.connect(vibG); vibG.connect(o1.detune); vibG.connect(o2.detune);
    const breath = noiseSource(t, dur + 0.2);
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
    g.connect(bus); g.connect(nodes.echoIn);
    o1.start(t); o2.start(t); vib.start(t);
    o1.stop(t + dur + 0.2); o2.stop(t + dur + 0.2); vib.stop(t + dur + 0.2);
    scrap(o1, [g, o2, o2g, vib, vibG, bp, bg]);
  } else if (timbre === 'pluck') { // Karplus-Strong
    const burst = noiseSource(t, Math.min(0.05, 2 / freq + 0.005));
    const dl = ctx.createDelay(0.1);
    dl.delayTime.value = 1 / freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(freq * 9, 1200, 9500);
    lp.Q.value = -6;   // dB: no resonance peak - keeps the feedback loop gain < 1 (stable)
    const fbg = ctx.createGain();
    fbg.gain.value = clamp(0.975 - freq / 18000, 0.88, 0.975);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.34 * vel, t);
    g.gain.setValueAtTime(0.34 * vel, t + Math.max(0.05, dur));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.3);
    burst.connect(dl);
    dl.connect(lp); lp.connect(fbg); fbg.connect(dl);
    lp.connect(g); g.connect(bus); g.connect(nodes.echoIn);
    const ms = (t - ctx.currentTime + dur + 0.9) * 1000;
    setTimeout(() => { for (const n of [dl, lp, fbg, g]) { try { n.disconnect(); } catch (e) {} } }, Math.max(50, ms));
  } else if (timbre === 'keys') { // FM electric piano
    const car = ctx.createOscillator();
    car.frequency.value = freq;
    car.detune.value = detune;
    const mod = ctx.createOscillator();
    mod.frequency.value = freq;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(freq * (0.5 + vel * 1.1), t);
    mg.gain.exponentialRampToValueAtTime(freq * 0.03, t + Math.max(0.3, dur));
    mod.connect(mg);
    mg.connect(car.frequency);
    const tine = ctx.createOscillator();
    tine.frequency.value = freq * 6.93;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.05 * vel, t);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    tine.connect(tg);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.19 * vel, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.7);
    car.connect(g); tg.connect(g);
    g.connect(bus); g.connect(nodes.echoIn);
    car.start(t); mod.start(t); tine.start(t);
    car.stop(t + dur + 0.8); mod.stop(t + dur + 0.8); tine.stop(t + 0.12);
    scrap(car, [g, mg, mod, tg]);
  } else if (timbre === 'brass') {
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth'; o1.frequency.value = freq; o1.detune.value = detune - 5;
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth'; o2.frequency.value = freq; o2.detune.value = detune + 5;
    const vib = ctx.createOscillator(); vib.frequency.value = 4.6;
    const vibG = ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(5, t + Math.min(0.45, dur * 0.6));
    vib.connect(vibG); vibG.connect(o1.detune); vibG.connect(o2.detune);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(280 + vel * 250, t);
    lp.frequency.linearRampToValueAtTime(900 + vel * 2900, t + 0.09);
    lp.frequency.exponentialRampToValueAtTime(600 + vel * 1600, t + Math.max(0.12, dur));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13 * vel, t + 0.045);
    g.gain.setValueAtTime(0.13 * vel, t + Math.max(0.05, dur - 0.05));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
    o1.connect(lp); o2.connect(lp); lp.connect(g);
    g.connect(bus); g.connect(nodes.echoIn);
    o1.start(t); o2.start(t); vib.start(t);
    o1.stop(t + dur + 0.15); o2.stop(t + dur + 0.15); vib.stop(t + dur + 0.15);
    scrap(o1, [g, lp, o2, vib, vibG]);
  } else if (timbre === 'organ') { // additive drawbars
    const partials = [[1, 0.5], [2, 0.32], [3, 0.18], [4, 0.1]];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13 * vel, t + 0.012);
    g.gain.setValueAtTime(0.13 * vel, t + Math.max(0.02, dur - 0.04));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.06);
    const vib = ctx.createOscillator(); vib.frequency.value = 6;
    const vibG = ctx.createGain(); vibG.gain.value = 4;
    vib.connect(vibG);
    const parts = [];
    for (const [ratio, amp] of partials) {
      const o = ctx.createOscillator();
      o.frequency.value = freq * ratio;
      o.detune.value = detune;
      vibG.connect(o.detune);
      const og = ctx.createGain(); og.gain.value = amp;
      o.connect(og); og.connect(g);
      o.start(t); o.stop(t + dur + 0.1);
      parts.push(o, og);
    }
    vib.start(t); vib.stop(t + dur + 0.1);
    g.connect(bus); g.connect(nodes.echoIn);
    scrap(parts[0], [g, vib, vibG, ...parts.slice(1)]);
  } else { // pure sine
    const o = ctx.createOscillator();
    o.frequency.value = freq; o.detune.value = detune;
    const vib = ctx.createOscillator(); vib.frequency.value = 5;
    const vibG = ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(6, t + Math.min(0.45, dur * 0.6));
    vib.connect(vibG); vibG.connect(o.detune);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18 * vel, t + 0.03);
    g.gain.setValueAtTime(0.18 * vel, t + Math.max(0.04, dur - 0.07));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
    o.connect(g); g.connect(bus); g.connect(nodes.echoIn);
    o.start(t); vib.start(t);
    o.stop(t + dur + 0.15); vib.stop(t + dur + 0.15);
    scrap(o, [g, vib, vibG]);
  }
}

function playCounter(t, freq, dur, vel) {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.15 * vel, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.04 * vel + 0.0001, t + Math.max(0.1, dur * 0.7));
  g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
  osc.connect(lp); lp.connect(g); g.connect(nodes.buses.counter);
  osc.start(t); osc.stop(t + dur + 0.15);
  const extra = [];
  if (!_fast) {   // Fast: drop the octave shimmer partial
    const o2 = ctx.createOscillator();
    o2.frequency.value = freq * 2.001;
    const o2g = ctx.createGain(); o2g.gain.value = 0.18;
    o2.connect(o2g); o2g.connect(lp);
    o2.start(t); o2.stop(t + dur + 0.15);
    extra.push(o2, o2g);
  }
  scrap(osc, [g, lp, ...extra]);
}

function playPad(t, freq, dur, vel, P, energy) {
  const bus = nodes.buses.pad;
  const timbre = P.padTimbre;
  const levels = { warm: 0.052, halo: 0.052, choir: 0.06, strings: 0.042, hollow: 0.055 };
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
  const oscs = [];        // sources (started/stopped below)
  const extras = [];      // non-source nodes to disconnect

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.7;

  if (timbre === 'warm') {
    lp.frequency.value = 450 + energy * 2200;
    for (const det of (_fast ? [-7, 7] : [-8, 0, 8])) {   // Fast: 2 saws instead of 3
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(lp);
      oscs.push(o);
    }
    lp.connect(g); extras.push(lp);
  } else if (timbre === 'halo') {
    lp.frequency.value = 1400 + energy * 3600;
    const o1 = ctx.createOscillator();
    o1.type = 'triangle'; o1.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.frequency.value = freq * 2;
    const o2g = ctx.createGain(); o2g.gain.value = 0.3;
    o1.connect(lp); o2.connect(o2g); o2g.connect(lp);
    lp.connect(g);
    oscs.push(o1, o2);
    extras.push(lp, o2g);
    if (!_fast) {   // shimmer LFO (subtle) dropped in Fast mode
      const shim = ctx.createOscillator(); shim.frequency.value = 0.31;
      const shimG = ctx.createGain(); shimG.gain.value = 7;
      shim.connect(shimG); shimG.connect(o1.detune); shimG.connect(o2.detune);
      oscs.push(shim); extras.push(shimG);
    }
  } else if (timbre === 'choir') {
    const mix = ctx.createGain(); mix.gain.value = 1;
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(mix);
      oscs.push(o);
    }
    // two vowel formants plus a darker body
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.frequency.value = 640; f1.Q.value = 5;
    const f1g = ctx.createGain(); f1g.gain.value = 0.9;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.frequency.value = 1100; f2.Q.value = 6;
    const f2g = ctx.createGain(); f2g.gain.value = 0.55;
    lp.frequency.value = 750;
    const lpg = ctx.createGain(); lpg.gain.value = 0.5;
    mix.connect(f1); f1.connect(f1g); f1g.connect(g);
    mix.connect(f2); f2.connect(f2g); f2g.connect(g);
    mix.connect(lp); lp.connect(lpg); lpg.connect(g);
    extras.push(mix, f1, f1g, f2, f2g, lp, lpg);
  } else if (timbre === 'strings') {
    lp.frequency.value = 750 + energy * 2700;
    for (const det of (_fast ? [-8, 6] : [-12, -4, 5, 11])) {   // Fast: 2 saws instead of 4
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(lp);
      oscs.push(o);
    }
    lp.connect(g);
    extras.push(lp);
    if (!_fast) {   // bowing LFO dropped in Fast mode
      const bow = ctx.createOscillator(); bow.frequency.value = 0.4;
      const bowG = ctx.createGain(); bowG.gain.value = 180;
      bow.connect(bowG); bowG.connect(lp.frequency);
      oscs.push(bow); extras.push(bowG);
    }
  } else { // hollow
    lp.frequency.value = 520 + energy * 1500;
    const o1 = ctx.createOscillator();
    o1.type = 'square'; o1.frequency.value = freq;
    const o1g = ctx.createGain(); o1g.gain.value = 0.55;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle'; o2.frequency.value = freq;
    o1.connect(o1g); o1g.connect(lp); o2.connect(lp);
    lp.connect(g);
    oscs.push(o1, o2);
    extras.push(lp, o1g);
  }

  for (const o of oscs) { o.start(t); o.stop(stopAt); }
  scrap(oscs[0], [g, ...extras, ...oscs.slice(1)]);
}

function playBass(t, freq, dur, vel) {
  const sub = ctx.createOscillator();
  sub.frequency.value = freq;
  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = freq;
  const sawG = ctx.createGain(); sawG.gain.value = 0.3;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(180 + vel * 480, t);
  lp.frequency.exponentialRampToValueAtTime(140, t + Math.max(0.1, dur));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.34 * vel, t + 0.012);
  g.gain.setValueAtTime(0.34 * vel, t + Math.max(0.02, dur - 0.06));
  g.gain.linearRampToValueAtTime(0, t + dur + 0.08);
  sub.connect(lp); saw.connect(sawG); sawG.connect(lp); lp.connect(g);
  g.connect(nodes.buses.bass);
  sub.start(t); saw.start(t);
  sub.stop(t + dur + 0.12); saw.stop(t + dur + 0.12);
  scrap(sub, [g, lp, saw, sawG]);
}

function playArp(t, freq, dur, vel) {
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = freq;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1600 + vel * 3800;
  lp.Q.value = 2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.085 * vel, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.08, dur * 0.9));
  osc.connect(lp); lp.connect(g);
  g.connect(nodes.buses.arp);
  g.connect(nodes.echoIn);
  osc.start(t); osc.stop(t + dur + 0.1);
  scrap(osc, [g, lp]);
}

function playPerc(t, type, vel) {
  const bus = nodes.buses.perc;
  if (type === 'kick') {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(43, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    o.connect(g); g.connect(bus);
    o.start(t); o.stop(t + 0.3);
    scrap(o, [g]);
    const click = noiseSource(t, 0.012);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1200;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.12 * vel, t);
    cg.gain.linearRampToValueAtTime(0, t + 0.012);
    click.connect(hp); hp.connect(cg); cg.connect(bus);
    scrap(click, [hp, cg]);
  } else if (type === 'snare') {
    const n = noiseSource(t, 0.16);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    n.connect(bp); bp.connect(g); g.connect(bus);
    const tone = ctx.createOscillator();
    tone.type = 'triangle'; tone.frequency.value = 195;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.14 * vel, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    tone.connect(tg); tg.connect(bus);
    tone.start(t); tone.stop(t + 0.09);
    scrap(n, [bp, g]); scrap(tone, [tg]);
  } else if (type === 'hat' || type === 'hatOpen') {
    const dur = type === 'hat' ? 0.045 : 0.4;
    const n = noiseSource(t, dur + 0.02);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 8200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(hp); hp.connect(g); g.connect(bus);
    scrap(n, [hp, g]);
  } else if (type === 'shaker') {
    const n = noiseSource(t, 0.09);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 5800; bp.Q.value = 2.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.12 * vel, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    n.connect(bp); bp.connect(g); g.connect(bus);
    scrap(n, [bp, g]);
  }
}

/* ---------------------------------------------------------------------
   Parameters (pushed in from React) & callbacks (pushed out to React)
--------------------------------------------------------------------- */

// Frozen params for the current render. renderSong() sets this before it
// builds the offline graph; the instrument + mix code reads it. There is NO
// live tuning any more — the whole song is pre-rendered, so parameters only
// matter at render time.
let _params = {
  tempo: 96, key: 'random', mode: 'auto', meter: '4/4', lengthSec: 180, arc: 'arch',
  complexity: 0.55, variety: 0.40, gravity: 0.60, wanderlust: 0.30, shadow: 0.25,
  humanity: 0.50, fractality: 0.60, hocket: 0.20, sparkle: 0.30, tide: 0.35, swing: 0,
  mix: { lead: 0.80, counter: 0.55, pad: 0.65, arp: 0.50, bass: 0.75, perc: 0.60 },
  leadTimbre: 'glass', padTimbre: 'warm',
  reverb: 0.45, echo: 0.30, master: 0.80, seed: 1207,
};

function readParams() { return _params; }

function applyMixes() {
  if (!nodes) return;
  const P = readParams();
  const scale = { lead: 1, counter: 1, pad: 1, arp: 1, bass: 1, perc: 1 };
  for (const name of Object.keys(nodes.buses)) {
    nodes.buses[name].gain.value = Math.pow(P.mix[name === 'pad' ? 'pad' : name] ?? 0, 1.4) * scale[name];
    nodes.sends[name].gain.value = P.reverb * nodes.sendAmt[name] * 1.6;
  }
}

function applySpace() {
  if (!nodes) return;
  const P = readParams();
  nodes.echoWet.gain.value = P.echo * 0.85;
  nodes.fb.gain.value = 0.18 + P.echo * 0.32;
  nodes.master.gain.value = Math.pow(P.master, 1.6);
}


/* ---------------------------------------------------------------------
   Offline render — compose the WHOLE piece, then render it (faster than
   realtime) into an AudioBuffer, capturing the piano-roll JSON as we go.

   For speed the render is SEGMENTED across Web Workers (each with its own
   OfflineAudioContext) and stitched. Each segment renders with a pre-roll so
   reverb / echo / filter tails crossing the boundary are correct; with the
   seeded audio RNG the seams are sample-exact. Falls back to a single
   main-thread render when workers / worker-OfflineAudioContext are absent.
--------------------------------------------------------------------- */
const RENDER_SR = 44100;      // 44.1k renders ~8% fewer samples than 48k
const REVERB_TAIL = 4.2;      // seconds appended so note/reverb tails ring out
const REVERB_IR = 3.2;        // convolver impulse length (see makeImpulse)
const SEG_MIN = 30;           // songs shorter than this render in one shot

export { composeSong };  // defined in composer.js

// Render one window [a, b) (+ tail on the final segment) into raw PCM.
// Returns { channels:[Float32Array,Float32Array], length, sampleRate }.
export async function renderSegment(params, seg, composed) {
  const P = params;
  const seed = Number(P.seed) || 1;
  const sr = seg.sampleRate || RENDER_SR;
  const a = seg.a, b = seg.b, tail = seg.tail || 0;
  // work in integer samples so segments tile exactly when stitched
  const aSamp = Math.round(a * sr), bSamp = Math.round(b * sr), tailSamp = Math.round(tail * sr);
  const prerollSamp = Math.round((seg.preroll || 0) * sr);
  const startSamp = Math.max(0, aSamp - prerollSamp);
  const start = startSamp / sr;                         // context-local 0 (sample-aligned)
  const keepFromSamp = aSamp - startSamp;               // samples discarded from the front
  const keepLen = (bSamp - aSamp) + tailSamp;

  const { scheduled, automation } = composed || composeSong(P);

  const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const off = new OfflineCtx(2, Math.max(1, keepFromSamp + keepLen), sr);
  _audioSeed = seed;
  _reverbSeconds = seg.reverbSeconds || 3.2;
  _reverbMono = !!seg.reverbMono;
  _fast = !!seg.fast;
  buildGraph(off);

  // master: fade in only on the segment containing absolute t=0
  const target = Math.pow(P.master, 1.6);
  nodes.master.gain.cancelScheduledValues(0);
  if (start <= 1e-6) {
    nodes.master.gain.setValueAtTime(0, 0);
    nodes.master.gain.linearRampToValueAtTime(target, 0.3);
  } else {
    nodes.master.gain.setValueAtTime(target, 0);
  }

  // seed tide/echo to the value active at `start`, then replay automation
  let init = null;
  for (const au of automation) { if (au.t <= start) init = au; else break; }
  if (init) {
    nodes.tideFilter.frequency.setValueAtTime(init.tideCutoff, 0);
    nodes.delay.delayTime.setValueAtTime(init.delayTime, 0);
  }
  for (const au of automation) {
    if (au.t > start && au.t < b) {
      const lt = au.t - start;
      nodes.tideFilter.frequency.setTargetAtTime(au.tideCutoff, lt, 1.2);
      nodes.delay.delayTime.setTargetAtTime(au.delayTime, lt, 0.4);
    }
  }

  // schedule every note whose onset is within [start, b). Snap the onset to the
  // sample grid (integer sample - startSamp) so a note lands on the exact same
  // absolute sample in every segment and in the single-shot render -> the
  // stitched result is bit-identical, not just perceptually close.
  for (const e of scheduled) {
    if (e.t < start || e.t >= b) continue;
    const lt = (Math.round(e.t * sr) - startSamp) / sr;
    if (e.voice === 'perc') { playPerc(lt, e.type, e.vel * Math.pow(P.mix.perc, 0.5)); continue; }
    const freq = midiToFreq(e.midi);
    if (e.voice === 'lead') playLead(lt, freq, e.durSec, e.vel, P, noteRnd(seed, e.t, e.midi));
    else if (e.voice === 'counter') playCounter(lt, freq, e.durSec, e.vel);
    else if (e.voice === 'pad') playPad(lt, freq, e.durSec, e.vel, P, e.energy);
    else if (e.voice === 'bass') playBass(lt, freq, e.durSec, e.vel);
    else if (e.voice === 'arp') playArp(lt, freq, e.durSec, e.vel);
  }

  const buf = await off.startRendering();
  ctx = null; nodes = null; noiseBuf = null;

  const channels = [];
  for (let c = 0; c < 2; c++) {
    const out = new Float32Array(keepLen);
    out.set(buf.getChannelData(c).subarray(keepFromSamp, keepFromSamp + keepLen));
    channels.push(out);
  }
  return { channels, length: keepLen, sampleRate: sr };
}

function makeAudioBuffer(numCh, length, sr) {
  if (typeof AudioBuffer === 'function') {
    try { return new AudioBuffer({ numberOfChannels: numCh, length, sampleRate: sr }); } catch (_) {}
  }
  const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  return new OfflineCtx(numCh, length, sr).createBuffer(numCh, length, sr);
}

/* Segmented render. A single long offline render is ~O(duration^2): finished
   nodes aren't freed mid-render (onended/scrap fire only afterwards), so every
   node ever scheduled is processed for the whole render. Rendering short
   segments makes it ~linear; a pre-roll re-triggers notes that started before
   each seam so reverb/echo/filter tails are correct there (seeded audio RNG ->
   seam-exact). Batches of segments render concurrently for extra multi-core
   parallelism. All on the main thread — OfflineAudioContext isn't available in
   Workers. */
export async function renderSong(params, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const fast = !!opts.fast;
  const sr = opts.sampleRate || (fast ? 24000 : RENDER_SR);
  const revSec = opts.reverbSeconds != null ? opts.reverbSeconds : (fast ? 1.4 : REVERB_IR);
  const revMono = opts.reverbMono != null ? opts.reverbMono : fast;
  const tailSec = revSec + 1.0;
  onProgress({ phase: 'composing', progress: 0 });

  const composed = composeSong(params);
  const { notes, displayCues, songEnd, seed, scheduled } = composed;
  const songEndSamp = Math.round(songEnd * sr);
  const totalLen = songEndSamp + Math.round(tailSec * sr);

  // pre-roll must cover the reverb IR + the longest note's tail
  let maxDur = 0;
  for (const e of scheduled) if (e.voice !== 'perc' && e.durSec > maxDur) maxDur = e.durSec;
  const preroll = opts.preroll != null ? opts.preroll : Math.min(14, Math.max(6, maxDur + revSec + 1.8));

  // segment length ~= preroll minimises total quadratic cost; short songs = 1 seg
  const single = opts.parallel === false || songEnd < SEG_MIN;
  const segLen = single ? songEnd : (opts.segLen != null ? opts.segLen : Math.max(6, Math.min(songEnd, preroll)));
  const K = Math.max(1, Math.ceil(songEnd / segLen));

  // integer-sample boundaries so stitched segments tile exactly (no drift)
  const bound = [];
  for (let i = 0; i <= K; i++) bound.push(Math.round(i * songEndSamp / K));
  const segs = [], segOff = [];
  for (let i = 0; i < K; i++) {
    segs.push({
      a: bound[i] / sr,
      b: bound[i + 1] / sr,
      preroll: i === 0 ? 0 : preroll,
      tail: (i === K - 1) ? tailSec : 0,
      sampleRate: sr,
      reverbSeconds: revSec, reverbMono: revMono, fast,
    });
    segOff.push(bound[i]);
  }

  const channels = [new Float32Array(totalLen), new Float32Array(totalLen)];
  onProgress({ phase: 'rendering', progress: 0, done: 0, total: K });

  // concurrent batches (each renderSegment builds its graph synchronously
  // before its first await, so the module globals never interleave)
  const batch = opts.batch != null ? opts.batch : Math.max(1, Math.min(K, navigator.hardwareConcurrency || 2));
  let done = 0;
  for (let i = 0; i < K; i += batch) {
    await Promise.all(segs.slice(i, i + batch).map((s, jj) => {
      const idx = i + jj;
      return renderSegment(params, s, composed).then((r) => {
        const at = segOff[idx], n = Math.min(r.length, totalLen - at);
        if (n > 0) {
          channels[0].set(r.channels[0].subarray(0, n), at);
          channels[1].set(r.channels[1].subarray(0, n), at);
        }
        done++; onProgress({ phase: 'rendering', progress: done / K, done, total: K });
      });
    }));
  }

  const audioBuffer = makeAudioBuffer(2, totalLen, sr);
  audioBuffer.getChannelData(0).set(channels[0]);
  audioBuffer.getChannelData(1).set(channels[1]);

  onProgress({ phase: 'rendering', progress: 1 });
  return { audioBuffer, notes, displayCues, duration: songEnd, seed, params, sampleRate: sr, segments: K, fast };
}

/* ---------------------------------------------------------------------
   Audition a single voice in isolation (for the /roster page). Renders a short
   characteristic phrase through the real voice + master chain — exactly the
   same synthesis a full render uses — and returns a playable AudioBuffer.
     spec.voice  : 'lead' | 'counter' | 'pad' | 'bass' | 'arp' | 'perc'
     spec.timbre : lead/pad timbre name, or the perc type
                   (kick / snare / hat / hatOpen / shaker)
--------------------------------------------------------------------- */
export async function auditionVoice(spec, opts = {}) {
  const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineCtx) throw new Error('OfflineAudioContext unavailable');
  const sr = opts.sampleRate || RENDER_SR;
  const seed = opts.seed || 7;
  const revSec = opts.reverbSeconds != null ? opts.reverbSeconds : 2.4;

  // demo params: full mixes so the chosen bus is audible, a little space
  const P = {
    humanity: 0.32,
    leadTimbre: spec.timbre || 'glass',
    padTimbre: spec.timbre || 'warm',
    mix: { lead: 0.85, counter: 0.85, pad: 0.8, arp: 0.82, bass: 0.85, perc: 0.85 },
    reverb: 0.4, echo: 0.3, master: 0.85, seed,
  };

  // a short, characteristic phrase per voice
  const events = [];
  if (spec.voice === 'perc') {
    const type = spec.timbre || 'kick';
    const grid = {
      kick: { n: 4, step: 0.45 }, snare: { n: 4, step: 0.5 }, hat: { n: 8, step: 0.24 },
      hatOpen: { n: 4, step: 0.42 }, shaker: { n: 8, step: 0.22 },
    }[type] || { n: 4, step: 0.4 };
    for (let i = 0; i < grid.n; i++) events.push({ t: i * grid.step, type, vel: i % 2 === 0 ? 0.95 : 0.68 });
  } else if (spec.voice === 'arp') {
    const cyc = [60, 64, 67, 72, 76, 72, 67, 64];
    cyc.concat(cyc).forEach((m, i) => events.push({ t: i * 0.15, midi: m, dur: 0.2, vel: 0.72 }));
  } else {
    const ph = {
      lead:    { vel: 0.82, notes: [[67, 0, 0.45], [71, 0.4, 0.45], [74, 0.8, 0.45], [79, 1.2, 0.4], [76, 1.6, 0.4], [72, 2.0, 1.6]] },
      counter: { vel: 0.80, notes: [[62, 0, 0.42], [65, 0.36, 0.42], [69, 0.72, 0.42], [67, 1.08, 0.42], [64, 1.44, 1.1]] },
      pad:     { vel: 0.90, energy: 0.7, notes: [[55, 0, 3.0], [62, 0.05, 3.0], [67, 0.1, 3.0], [71, 0.15, 3.0]] },
      bass:    { vel: 0.85, notes: [[40, 0, 0.4], [40, 0.45, 0.4], [45, 0.9, 0.4], [43, 1.35, 0.4], [40, 1.8, 0.7]] },
    }[spec.voice];
    if (!ph) throw new Error('unknown voice ' + spec.voice);
    for (const [midi, t, dur] of ph.notes) events.push({ t, midi, dur, vel: ph.vel, energy: ph.energy });
  }

  let maxEnd = 0;
  for (const e of events) maxEnd = Math.max(maxEnd, (e.t || 0) + (e.dur || 0.3));
  const len = Math.max(1, Math.ceil((maxEnd + revSec + 0.4) * sr));
  const off = new OfflineCtx(2, len, sr);

  const prevParams = _params;
  _params = P; _audioSeed = seed; _reverbSeconds = revSec; _reverbMono = false; _fast = false;
  buildGraph(off);
  nodes.master.gain.setValueAtTime(Math.pow(P.master, 1.6), 0);

  for (const e of events) {
    if (spec.voice === 'perc') { playPerc(e.t, e.type, e.vel); continue; }
    const freq = midiToFreq(e.midi);
    if (spec.voice === 'lead') playLead(e.t, freq, e.dur, e.vel, P, noteRnd(seed, e.t, e.midi));
    else if (spec.voice === 'counter') playCounter(e.t, freq, e.dur, e.vel);
    else if (spec.voice === 'pad') playPad(e.t, freq, e.dur, e.vel, P, e.energy != null ? e.energy : 0.6);
    else if (spec.voice === 'bass') playBass(e.t, freq, e.dur, e.vel);
    else if (spec.voice === 'arp') playArp(e.t, freq, e.dur, e.vel);
  }

  const buf = await off.startRendering();
  ctx = null; nodes = null; noiseBuf = null;
  _params = prevParams;
  return buf;
}

export { bufferToWav, encodeSong } from "./encoders.js";

export { fitCanvas, drawViz, cueAt } from "./viz.js";
