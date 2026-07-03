/* ---------------------------------------------------------------------
   Instruments (voices). Each play* schedules one note on the shared
   graph. Extracted verbatim; audio state lives on `A`.
--------------------------------------------------------------------- */
import { A } from "./state.js";
import { clamp } from "./rng.js";

function noiseSource(t, dur) {
  const src = A.ctx.createBufferSource();
  src.buffer = A.noiseBuf;
  src.loop = true;
  src.start(t);
  src.stop(t + dur);
  return src;
}

function scrap(src, parts) {
  src.onended = () => { for (const n of parts) { try { n.disconnect(); } catch (e) {} } };
}

/* ----- instruments ----- */
export function playLead(t, freq, dur, vel, P, rnd) {
  const bus = A.nodes.buses.lead;
  const detune = ((rnd == null ? Math.random() : rnd) * 2 - 1) * P.humanity * 7;
  const timbre = P.leadTimbre;
  if (timbre === 'glass') {
    const car = A.ctx.createOscillator();
    car.frequency.value = freq;
    car.detune.value = detune;
    const mod = A.ctx.createOscillator();
    mod.frequency.value = freq * 3.003;
    const mg = A.ctx.createGain();
    mg.gain.setValueAtTime(freq * (1.4 + vel * 1.6), t);
    mg.gain.exponentialRampToValueAtTime(freq * 0.04, t + Math.max(0.25, dur * 0.85));
    mod.connect(mg);
    mg.connect(car.frequency);
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.17 * vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.5);
    car.connect(g);
    g.connect(bus);
    g.connect(A.nodes.echoIn);
    car.start(t); mod.start(t);
    car.stop(t + dur + 0.6); mod.stop(t + dur + 0.6);
    scrap(car, [g, mg, mod]);
  } else if (timbre === 'reed') {
    const osc = A.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const vib = A.ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibG = A.ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(5, t + Math.min(0.4, dur * 0.5));
    vib.connect(vibG); vibG.connect(osc.detune);
    const lp = A.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(700 + vel * 2600, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(500, 400 + vel * 1200), t + dur);
    lp.Q.value = 1.5;
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.15 * vel, t + 0.025);
    g.gain.setValueAtTime(0.15 * vel, t + Math.max(0.03, dur - 0.05));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.08);
    osc.connect(lp); lp.connect(g); g.connect(bus); g.connect(A.nodes.echoIn);
    osc.start(t); vib.start(t);
    osc.stop(t + dur + 0.15); vib.stop(t + dur + 0.15);
    scrap(osc, [g, lp, vib, vibG]);
  } else if (timbre === 'breath') {
    const o1 = A.ctx.createOscillator();
    o1.frequency.value = freq;
    o1.detune.value = detune;
    const o2 = A.ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = freq * 1.004;
    const o2g = A.ctx.createGain(); o2g.gain.value = 0.4;
    const vib = A.ctx.createOscillator(); vib.frequency.value = 4.8;
    const vibG = A.ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(7, t + Math.min(0.5, dur * 0.6));
    vib.connect(vibG); vibG.connect(o1.detune); vibG.connect(o2.detune);
    const breath = noiseSource(t, dur + 0.2);
    const bp = A.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq * 2; bp.Q.value = 4;
    const bg = A.ctx.createGain(); bg.gain.value = 0.05 * vel;
    breath.connect(bp); bp.connect(bg);
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16 * vel, t + 0.05);
    g.gain.setValueAtTime(0.16 * vel, t + Math.max(0.06, dur - 0.06));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.12);
    o1.connect(g); o2.connect(o2g); o2g.connect(g); bg.connect(g);
    g.connect(bus); g.connect(A.nodes.echoIn);
    o1.start(t); o2.start(t); vib.start(t);
    o1.stop(t + dur + 0.2); o2.stop(t + dur + 0.2); vib.stop(t + dur + 0.2);
    scrap(o1, [g, o2, o2g, vib, vibG, bp, bg]);
  } else if (timbre === 'keys') { // FM electric piano
    const car = A.ctx.createOscillator();
    car.frequency.value = freq;
    car.detune.value = detune;
    const mod = A.ctx.createOscillator();
    mod.frequency.value = freq;
    const mg = A.ctx.createGain();
    mg.gain.setValueAtTime(freq * (0.5 + vel * 1.1), t);
    mg.gain.exponentialRampToValueAtTime(freq * 0.03, t + Math.max(0.3, dur));
    mod.connect(mg);
    mg.connect(car.frequency);
    const tine = A.ctx.createOscillator();
    tine.frequency.value = freq * 6.93;
    const tg = A.ctx.createGain();
    tg.gain.setValueAtTime(0.05 * vel, t);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    tine.connect(tg);
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.19 * vel, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.7);
    car.connect(g); tg.connect(g);
    g.connect(bus); g.connect(A.nodes.echoIn);
    car.start(t); mod.start(t); tine.start(t);
    car.stop(t + dur + 0.8); mod.stop(t + dur + 0.8); tine.stop(t + 0.12);
    scrap(car, [g, mg, mod, tg]);
  } else if (timbre === 'brass') {
    const o1 = A.ctx.createOscillator();
    o1.type = 'sawtooth'; o1.frequency.value = freq; o1.detune.value = detune - 5;
    const o2 = A.ctx.createOscillator();
    o2.type = 'sawtooth'; o2.frequency.value = freq; o2.detune.value = detune + 5;
    const vib = A.ctx.createOscillator(); vib.frequency.value = 4.6;
    const vibG = A.ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(5, t + Math.min(0.45, dur * 0.6));
    vib.connect(vibG); vibG.connect(o1.detune); vibG.connect(o2.detune);
    const lp = A.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(280 + vel * 250, t);
    lp.frequency.linearRampToValueAtTime(900 + vel * 2900, t + 0.09);
    lp.frequency.exponentialRampToValueAtTime(600 + vel * 1600, t + Math.max(0.12, dur));
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13 * vel, t + 0.045);
    g.gain.setValueAtTime(0.13 * vel, t + Math.max(0.05, dur - 0.05));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
    o1.connect(lp); o2.connect(lp); lp.connect(g);
    g.connect(bus); g.connect(A.nodes.echoIn);
    o1.start(t); o2.start(t); vib.start(t);
    o1.stop(t + dur + 0.15); o2.stop(t + dur + 0.15); vib.stop(t + dur + 0.15);
    scrap(o1, [g, lp, o2, vib, vibG]);
  } else if (timbre === 'organ') { // additive drawbars
    const partials = [[1, 0.5], [2, 0.32], [3, 0.18], [4, 0.1]];
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13 * vel, t + 0.012);
    g.gain.setValueAtTime(0.13 * vel, t + Math.max(0.02, dur - 0.04));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.06);
    const vib = A.ctx.createOscillator(); vib.frequency.value = 6;
    const vibG = A.ctx.createGain(); vibG.gain.value = 4;
    vib.connect(vibG);
    const parts = [];
    for (const [ratio, amp] of partials) {
      const o = A.ctx.createOscillator();
      o.frequency.value = freq * ratio;
      o.detune.value = detune;
      vibG.connect(o.detune);
      const og = A.ctx.createGain(); og.gain.value = amp;
      o.connect(og); og.connect(g);
      o.start(t); o.stop(t + dur + 0.1);
      parts.push(o, og);
    }
    vib.start(t); vib.stop(t + dur + 0.1);
    g.connect(bus); g.connect(A.nodes.echoIn);
    scrap(parts[0], [g, vib, vibG, ...parts.slice(1)]);
  } else if (timbre === 'bansuri') { // bamboo flute: near-pure tone + breath chiff + late vibrato + meend
    const scoop = freq * 0.945;                        // start ~1 semitone flat and slide up (meend)
    const glide = Math.min(0.13, dur * 0.3);
    const o1 = A.ctx.createOscillator();
    o1.type = 'sine'; o1.detune.value = detune;
    o1.frequency.setValueAtTime(scoop, t);
    o1.frequency.exponentialRampToValueAtTime(freq, t + glide);
    const o2 = A.ctx.createOscillator();               // weak 2nd harmonic for body
    o2.type = 'sine';
    o2.frequency.setValueAtTime(scoop * 2, t);
    o2.frequency.exponentialRampToValueAtTime(freq * 2, t + glide);
    const o2g = A.ctx.createGain(); o2g.gain.value = 0.14;
    const vib = A.ctx.createOscillator(); vib.frequency.value = 5.4;
    const vibG = A.ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(6, t + Math.min(0.6, dur * 0.55));
    vib.connect(vibG); vibG.connect(o1.detune); vibG.connect(o2.detune);
    const breath = noiseSource(t, dur + 0.15);          // airy chiff, strongest at the attack
    const bp = A.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq * 2.2; bp.Q.value = 3.5;
    const bg = A.ctx.createGain();
    bg.gain.setValueAtTime(0.11 * vel, t);
    bg.gain.exponentialRampToValueAtTime(0.03 * vel + 0.0001, t + 0.14);
    breath.connect(bp); bp.connect(bg);
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.17 * vel, t + 0.06);
    g.gain.setValueAtTime(0.17 * vel, t + Math.max(0.07, dur - 0.08));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.14);
    o1.connect(g); o2.connect(o2g); o2g.connect(g); bg.connect(g);
    g.connect(bus); g.connect(A.nodes.echoIn);
    o1.start(t); o2.start(t); vib.start(t);
    o1.stop(t + dur + 0.2); o2.stop(t + dur + 0.2); vib.stop(t + dur + 0.2);
    scrap(o1, [g, o2, o2g, vib, vibG, bp, bg]);
  } else if (timbre === 'whistle') { // human whistle: near-pure tone, faint air, wide vibrato, gentle portamento
    const scoop = freq * 0.96;
    const glide = Math.min(0.09, dur * 0.25);
    const o = A.ctx.createOscillator();
    o.type = 'sine'; o.detune.value = detune;
    o.frequency.setValueAtTime(scoop, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + glide);
    const o2 = A.ctx.createOscillator();                 // a whisper of 2nd harmonic for shape
    o2.type = 'sine';
    o2.frequency.setValueAtTime(scoop * 2, t);
    o2.frequency.exponentialRampToValueAtTime(freq * 2, t + glide);
    const o2g = A.ctx.createGain(); o2g.gain.value = 0.06;
    const vib = A.ctx.createOscillator(); vib.frequency.value = 5.8;
    const vibG = A.ctx.createGain();
    // vibrato only blooms on a *held* tone: short notes stay pure, so each is
    // articulated like an individually-whistled note; a sustained pitch wobbles.
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.setValueAtTime(0, t + 0.34);
    vibG.gain.linearRampToValueAtTime(9, t + Math.min(1.1, 0.34 + dur * 0.5));
    vib.connect(vibG); vibG.connect(o.detune); vibG.connect(o2.detune);
    const air = noiseSource(t, dur + 0.06);              // faint breath around the pitch
    const bp = A.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq * 1.5; bp.Q.value = 8;
    const ag = A.ctx.createGain(); ag.gain.value = 0.02 * vel;
    air.connect(bp); bp.connect(ag);
    const g = A.ctx.createGain();                        // quick stop: each tone ends cleanly, doesn't carry into the next
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.2 * vel, t + 0.03);
    g.gain.setValueAtTime(0.2 * vel, t + Math.max(0.04, dur - 0.02));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.04);
    o.connect(g); o2.connect(o2g); o2g.connect(g); ag.connect(g);
    g.connect(bus);                                      // no echo send -> notes don't ring/repeat into each other
    o.start(t); o2.start(t); vib.start(t);
    o.stop(t + dur + 0.07); o2.stop(t + dur + 0.07); vib.stop(t + dur + 0.07);
    scrap(o, [g, o2, o2g, vib, vibG, bp, ag]);
  } else if (timbre === 'santoor') { // hammered dulcimer: bright, metallic, struck strings + beating
    const partials = [[1, 0.5, 0], [2, 0.3, 4], [3.01, 0.16, -5], [4.2, 0.1, 6]];   // inharmonic, detuned pairs
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.32 * vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.9);       // long metallic ring
    const lp = A.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(clamp(freq * 12, 3000, 12000), t);
    lp.frequency.exponentialRampToValueAtTime(clamp(freq * 4, 1200, 6000), t + Math.max(0.2, dur));  // bright -> mellow
    const parts = [];
    for (const [ratio, amp, det] of partials) {
      const o = A.ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = freq * ratio; o.detune.value = detune + det;
      const og = A.ctx.createGain(); og.gain.value = amp;
      o.connect(og); og.connect(lp);
      o.start(t); o.stop(t + dur + 1.0);
      parts.push(o, og);
    }
    lp.connect(g); g.connect(bus); g.connect(A.nodes.echoIn);
    scrap(parts[0], [g, lp, ...parts.slice(1)]);
  } else if (timbre === 'sarangi') { // bowed, deeply vocal; big meend + expressive vibrato + a vowel formant
    const scoop = freq * 0.91;                          // sarangi glides a lot -> a large meend
    const glide = Math.min(0.22, dur * 0.4);
    const o1 = A.ctx.createOscillator();
    o1.type = 'sawtooth'; o1.detune.value = detune;
    o1.frequency.setValueAtTime(scoop, t);
    o1.frequency.exponentialRampToValueAtTime(freq, t + glide);
    const o2 = A.ctx.createOscillator();               // sympathetic-string shimmer
    o2.type = 'sawtooth'; o2.detune.value = detune + 6;
    o2.frequency.setValueAtTime(scoop, t);
    o2.frequency.exponentialRampToValueAtTime(freq, t + glide);
    const o2g = A.ctx.createGain(); o2g.gain.value = 0.4;
    const vib = A.ctx.createOscillator(); vib.frequency.value = 5.6;
    const vibG = A.ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(11, t + Math.min(0.5, dur * 0.5));
    vib.connect(vibG); vibG.connect(o1.detune); vibG.connect(o2.detune);
    const f1 = A.ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 900; f1.Q.value = 4;   // vowel
    const lp = A.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.8;
    const g = A.ctx.createGain();                       // bowed swell
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16 * vel, t + Math.min(0.12, dur * 0.25));
    g.gain.setValueAtTime(0.16 * vel, t + Math.max(0.14, dur - 0.08));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.14);
    o1.connect(lp); o2.connect(o2g); o2g.connect(lp);
    lp.connect(g); lp.connect(f1); f1.connect(g);      // dry + vocal formant
    g.connect(bus); g.connect(A.nodes.echoIn);
    o1.start(t); o2.start(t); vib.start(t);
    o1.stop(t + dur + 0.2); o2.stop(t + dur + 0.2); vib.stop(t + dur + 0.2);
    scrap(o1, [g, o2, o2g, vib, vibG, f1, lp]);
  } else if (timbre === 'shehnai') { // double-reed: bright, nasal, penetrating; reedy vibrato + a little meend
    const scoop = freq * 0.965;
    const glide = Math.min(0.08, dur * 0.22);
    const osc = A.ctx.createOscillator();
    osc.type = 'sawtooth'; osc.detune.value = detune;
    osc.frequency.setValueAtTime(scoop, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + glide);
    const vib = A.ctx.createOscillator(); vib.frequency.value = 5.6;
    const vibG = A.ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(7, t + Math.min(0.4, dur * 0.5));
    vib.connect(vibG); vibG.connect(osc.detune);
    const bpN = A.ctx.createBiquadFilter();            // nasal formant
    bpN.type = 'bandpass'; bpN.frequency.value = clamp(freq * 3, 800, 4000); bpN.Q.value = 3.5;
    const bpNg = A.ctx.createGain(); bpNg.gain.value = 0.9;
    const lp = A.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(1200 + vel * 3000, t);
    lp.frequency.exponentialRampToValueAtTime(900 + vel * 1600, t + dur);
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12 * vel, t + 0.03);
    g.gain.setValueAtTime(0.12 * vel, t + Math.max(0.04, dur - 0.05));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
    osc.connect(lp); lp.connect(g); lp.connect(bpN); bpN.connect(bpNg); bpNg.connect(g);   // dry + nasal formant
    g.connect(bus); g.connect(A.nodes.echoIn);
    osc.start(t); vib.start(t);
    osc.stop(t + dur + 0.15); vib.stop(t + dur + 0.15);
    scrap(osc, [g, lp, vib, vibG, bpN, bpNg]);
  } else if (timbre === 'harmonium') { // reed organ: sustained stacked reeds with a gentle bellows shimmer
    const partials = [[1, 0.5], [2, 0.28], [3, 0.16], [4, 0.09]];
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18 * vel, t + 0.04);
    g.gain.setValueAtTime(0.18 * vel, t + Math.max(0.06, dur - 0.05));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.12);
    const lp = A.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000; lp.Q.value = 0.7;
    const trem = A.ctx.createOscillator(); trem.frequency.value = 5.2;   // reed/bellows shimmer
    const tremG = A.ctx.createGain(); tremG.gain.value = 6;
    trem.connect(tremG);
    const parts = [];
    for (const [ratio, amp] of partials) {
      const o = A.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq * ratio; o.detune.value = detune;
      tremG.connect(o.detune);
      const og = A.ctx.createGain(); og.gain.value = amp;
      o.connect(og); og.connect(lp);
      o.start(t); o.stop(t + dur + 0.15);
      parts.push(o, og);
    }
    trem.start(t); trem.stop(t + dur + 0.15);
    lp.connect(g); g.connect(bus); g.connect(A.nodes.echoIn);
    scrap(parts[0], [g, lp, trem, tremG, ...parts.slice(1)]);
  } else { // pure sine
    const o = A.ctx.createOscillator();
    o.frequency.value = freq; o.detune.value = detune;
    const vib = A.ctx.createOscillator(); vib.frequency.value = 5;
    const vibG = A.ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(6, t + Math.min(0.45, dur * 0.6));
    vib.connect(vibG); vibG.connect(o.detune);
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18 * vel, t + 0.03);
    g.gain.setValueAtTime(0.18 * vel, t + Math.max(0.04, dur - 0.07));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
    o.connect(g); g.connect(bus); g.connect(A.nodes.echoIn);
    o.start(t); vib.start(t);
    o.stop(t + dur + 0.15); vib.stop(t + dur + 0.15);
    scrap(o, [g, vib, vibG]);
  }
}

export function playCounter(t, freq, dur, vel) {
  const osc = A.ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  const lp = A.ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = 0.8;
  const g = A.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.15 * vel, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.04 * vel + 0.0001, t + Math.max(0.1, dur * 0.7));
  g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
  osc.connect(lp); lp.connect(g); g.connect(A.nodes.buses.counter);
  osc.start(t); osc.stop(t + dur + 0.15);
  const extra = [];
  if (!A.fast) {   // Fast: drop the octave shimmer partial
    const o2 = A.ctx.createOscillator();
    o2.frequency.value = freq * 2.001;
    const o2g = A.ctx.createGain(); o2g.gain.value = 0.18;
    o2.connect(o2g); o2g.connect(lp);
    o2.start(t); o2.stop(t + dur + 0.15);
    extra.push(o2, o2g);
  }
  scrap(osc, [g, lp, ...extra]);
}

export function playPad(t, freq, dur, vel, P, energy) {
  const bus = A.nodes.buses.pad;
  const timbre = P.padTimbre;
  const levels = { warm: 0.052, halo: 0.052, choir: 0.06, strings: 0.042, hollow: 0.055, tanpura: 0.05 };
  const level = (levels[timbre] || 0.05) * vel;
  const g = A.ctx.createGain();
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
  const extras = [];      // non-source A.nodes to disconnect

  const lp = A.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.7;

  if (timbre === 'warm') {
    lp.frequency.value = 450 + energy * 2200;
    for (const det of (A.fast ? [-7, 7] : [-8, 0, 8])) {   // Fast: 2 saws instead of 3
      const o = A.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(lp);
      oscs.push(o);
    }
    lp.connect(g); extras.push(lp);
  } else if (timbre === 'halo') {
    lp.frequency.value = 1400 + energy * 3600;
    const o1 = A.ctx.createOscillator();
    o1.type = 'triangle'; o1.frequency.value = freq;
    const o2 = A.ctx.createOscillator();
    o2.frequency.value = freq * 2;
    const o2g = A.ctx.createGain(); o2g.gain.value = 0.3;
    o1.connect(lp); o2.connect(o2g); o2g.connect(lp);
    lp.connect(g);
    oscs.push(o1, o2);
    extras.push(lp, o2g);
    if (!A.fast) {   // shimmer LFO (subtle) dropped in Fast mode
      const shim = A.ctx.createOscillator(); shim.frequency.value = 0.31;
      const shimG = A.ctx.createGain(); shimG.gain.value = 7;
      shim.connect(shimG); shimG.connect(o1.detune); shimG.connect(o2.detune);
      oscs.push(shim); extras.push(shimG);
    }
  } else if (timbre === 'choir') {
    const mix = A.ctx.createGain(); mix.gain.value = 1;
    for (const det of [-9, 9]) {
      const o = A.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(mix);
      oscs.push(o);
    }
    // two vowel formants plus a darker body
    const f1 = A.ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.frequency.value = 640; f1.Q.value = 5;
    const f1g = A.ctx.createGain(); f1g.gain.value = 0.9;
    const f2 = A.ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.frequency.value = 1100; f2.Q.value = 6;
    const f2g = A.ctx.createGain(); f2g.gain.value = 0.55;
    lp.frequency.value = 750;
    const lpg = A.ctx.createGain(); lpg.gain.value = 0.5;
    mix.connect(f1); f1.connect(f1g); f1g.connect(g);
    mix.connect(f2); f2.connect(f2g); f2g.connect(g);
    mix.connect(lp); lp.connect(lpg); lpg.connect(g);
    extras.push(mix, f1, f1g, f2, f2g, lp, lpg);
  } else if (timbre === 'strings') {
    lp.frequency.value = 750 + energy * 2700;
    for (const det of (A.fast ? [-8, 6] : [-12, -4, 5, 11])) {   // Fast: 2 saws instead of 4
      const o = A.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(lp);
      oscs.push(o);
    }
    lp.connect(g);
    extras.push(lp);
    if (!A.fast) {   // bowing LFO dropped in Fast mode
      const bow = A.ctx.createOscillator(); bow.frequency.value = 0.4;
      const bowG = A.ctx.createGain(); bowG.gain.value = 180;
      bow.connect(bowG); bowG.connect(lp.frequency);
      oscs.push(bow); extras.push(bowG);
    }
  } else if (timbre === 'tanpura') { // plucked drone strings + jivari buzz (overrides the pad envelope)
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level * 4.2, t + 0.008);         // pluck attack
    g.gain.exponentialRampToValueAtTime(level * 0.9, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 1.2);     // long ring
    lp.frequency.value = 2600;
    for (const [ratio, amp, det] of [[1, 0.5, 0], [2, 0.26, 0], [2.997, 0.18, 5], [4, 0.1, 0]]) {
      const o = A.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq * ratio; o.detune.value = det;
      const og = A.ctx.createGain(); og.gain.value = amp;
      o.connect(og); og.connect(lp);
      oscs.push(o); extras.push(og);
    }
    const buzz = A.ctx.createOscillator(); buzz.type = 'triangle'; buzz.frequency.value = freq * 5;
    const buzzG = A.ctx.createGain(); buzzG.gain.value = 0.05 * vel;
    const trem = A.ctx.createOscillator(); trem.frequency.value = 22;
    const tremG = A.ctx.createGain(); tremG.gain.value = 0.045 * vel;
    trem.connect(tremG); tremG.connect(buzzG.gain);
    buzz.connect(buzzG); buzzG.connect(lp);
    lp.connect(g);
    oscs.push(buzz, trem); extras.push(lp, buzzG, tremG);
  } else { // hollow
    lp.frequency.value = 520 + energy * 1500;
    const o1 = A.ctx.createOscillator();
    o1.type = 'square'; o1.frequency.value = freq;
    const o1g = A.ctx.createGain(); o1g.gain.value = 0.55;
    const o2 = A.ctx.createOscillator();
    o2.type = 'triangle'; o2.frequency.value = freq;
    o1.connect(o1g); o1g.connect(lp); o2.connect(lp);
    lp.connect(g);
    oscs.push(o1, o2);
    extras.push(lp, o1g);
  }

  for (const o of oscs) { o.start(t); o.stop(stopAt); }
  scrap(oscs[0], [g, ...extras, ...oscs.slice(1)]);
}

export function playBass(t, freq, dur, vel) {
  const sub = A.ctx.createOscillator();
  sub.frequency.value = freq;
  const saw = A.ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = freq;
  const sawG = A.ctx.createGain(); sawG.gain.value = 0.3;
  const lp = A.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(180 + vel * 480, t);
  lp.frequency.exponentialRampToValueAtTime(140, t + Math.max(0.1, dur));
  const g = A.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.34 * vel, t + 0.012);
  g.gain.setValueAtTime(0.34 * vel, t + Math.max(0.02, dur - 0.06));
  g.gain.linearRampToValueAtTime(0, t + dur + 0.08);
  sub.connect(lp); saw.connect(sawG); sawG.connect(lp); lp.connect(g);
  g.connect(A.nodes.buses.bass);
  sub.start(t); saw.start(t);
  sub.stop(t + dur + 0.12); saw.stop(t + dur + 0.12);
  scrap(sub, [g, lp, saw, sawG]);
}

export function playArp(t, freq, dur, vel) {
  const osc = A.ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = freq;
  const lp = A.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1600 + vel * 3800;
  lp.Q.value = 2;
  const g = A.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.085 * vel, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.08, dur * 0.9));
  osc.connect(lp); lp.connect(g);
  g.connect(A.nodes.buses.arp);
  g.connect(A.nodes.echoIn);
  osc.start(t); osc.stop(t + dur + 0.1);
  scrap(osc, [g, lp]);
}

export function playPerc(t, type, vel) {
  const bus = A.nodes.buses.perc;
  if (type === 'kick') {
    const o = A.ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(43, t + 0.09);
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0.55 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    o.connect(g); g.connect(bus);
    o.start(t); o.stop(t + 0.3);
    scrap(o, [g]);
    const click = noiseSource(t, 0.012);
    const hp = A.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1200;
    const cg = A.ctx.createGain();
    cg.gain.setValueAtTime(0.12 * vel, t);
    cg.gain.linearRampToValueAtTime(0, t + 0.012);
    click.connect(hp); hp.connect(cg); cg.connect(bus);
    scrap(click, [hp, cg]);
  } else if (type === 'snare') {
    const n = noiseSource(t, 0.16);
    const bp = A.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.9;
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0.3 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    n.connect(bp); bp.connect(g); g.connect(bus);
    const tone = A.ctx.createOscillator();
    tone.type = 'triangle'; tone.frequency.value = 195;
    const tg = A.ctx.createGain();
    tg.gain.setValueAtTime(0.14 * vel, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    tone.connect(tg); tg.connect(bus);
    tone.start(t); tone.stop(t + 0.09);
    scrap(n, [bp, g]); scrap(tone, [tg]);
  } else if (type === 'hat' || type === 'hatOpen') {
    const dur = type === 'hat' ? 0.045 : 0.4;
    const n = noiseSource(t, dur + 0.02);
    const hp = A.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 8200;
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0.16 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(hp); hp.connect(g); g.connect(bus);
    scrap(n, [hp, g]);
  } else if (type === 'shaker') {
    const n = noiseSource(t, 0.09);
    const bp = A.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 5800; bp.Q.value = 2.4;
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.12 * vel, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    n.connect(bp); bp.connect(g); g.connect(bus);
    scrap(n, [bp, g]);
  } else if (type === 'tablaGe') { // bayan (low): resonant tone with a downward "gham" slide
    const o = A.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(72, t + 0.18);
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0.5 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    o.connect(g); g.connect(bus);
    o.start(t); o.stop(t + 0.45);
    scrap(o, [g]);
  } else if (type === 'tablaNa' || type === 'tablaTin') { // dayan (high): tuned ringing stroke
    const open = type === 'tablaTin';
    const base = 300;                                   // dayan tuned near Sa
    const o1 = A.ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = base;
    const o2 = A.ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = base * 2.76; // inharmonic drum partial
    const o2g = A.ctx.createGain(); o2g.gain.value = 0.35;
    const dec = open ? 0.5 : 0.13;                      // tin rings open; na is damped
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0.34 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dec);
    o1.connect(g); o2.connect(o2g); o2g.connect(g);
    const click = noiseSource(t, 0.01);                 // sharp finger attack
    const hp = A.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2600;
    const cg = A.ctx.createGain();
    cg.gain.setValueAtTime(0.16 * vel, t);
    cg.gain.linearRampToValueAtTime(0, t + 0.012);
    click.connect(hp); hp.connect(cg); cg.connect(g);
    g.connect(bus);
    o1.start(t); o2.start(t);
    o1.stop(t + dec + 0.05); o2.stop(t + dec + 0.05);
    scrap(o1, [g, o2, o2g]); scrap(click, [hp, cg]);
  }
}

