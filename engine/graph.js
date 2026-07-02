/* ---------------------------------------------------------------------
   Audio graph: master chain, reverb/echo, per-voice buses, mixes.
   Extracted verbatim; module-level audio state now lives on `A`.
--------------------------------------------------------------------- */
import { A, readParams } from "./state.js";
import { mulberry32 } from "./rng.js";

export function buildGraph(context) {
  A.ctx = context;
  A.agen = mulberry32(((A.audioSeed >>> 0) ^ 0x6d2b79f5) >>> 0);   // deterministic noise/impulse

  const master = A.ctx.createGain();
  const tideFilter = A.ctx.createBiquadFilter();
  tideFilter.type = 'lowpass';
  tideFilter.frequency.value = 18000;
  tideFilter.Q.value = 0.4;
  const comp = A.ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 22;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.24;
  // hard safety limiter: clamps anything that slips past the compressor
  const limiter = A.ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.1;
  const analyser = A.ctx.createAnalyser();
  analyser.fftSize = 1024;

  master.connect(tideFilter);
  tideFilter.connect(comp);
  if (A.fast) { comp.connect(analyser); }             // Fast: skip the safety limiter
  else { comp.connect(limiter); limiter.connect(analyser); }
  analyser.connect(A.ctx.destination);

  // reverb
  const convolver = A.ctx.createConvolver();
  convolver.buffer = makeImpulse(A.reverbSeconds, 2.6);
  const reverbOut = A.ctx.createGain();
  reverbOut.gain.value = 1;
  convolver.connect(reverbOut);
  reverbOut.connect(master);

  // echo (dotted eighth) for lead & arp
  const echoIn = A.ctx.createGain();
  const delay = A.ctx.createDelay(2.0);
  delay.delayTime.value = 0.42;
  const fb = A.ctx.createGain();
  fb.gain.value = 0.34;
  const echoTone = A.ctx.createBiquadFilter();
  echoTone.type = 'lowpass';
  echoTone.frequency.value = 4200;
  const echoWet = A.ctx.createGain();
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
    const g = A.ctx.createGain();
    g.connect(master);
    const send = A.ctx.createGain();
    send.gain.value = 0;
    g.connect(send);
    send.connect(convolver);
    buses[name] = g;
    sends[name] = send;
  }

  // shared noise buffer (seeded -> identical across render segments)
  A.noiseBuf = A.ctx.createBuffer(1, A.ctx.sampleRate * 2, A.ctx.sampleRate);
  const d = A.noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = A.agen() * 2 - 1;

  A.nodes = { master, tideFilter, comp, analyser, convolver, reverbOut, echoIn, delay, fb, echoWet, buses, sends, sendAmt };
  applyMixes();
  applySpace();
}

function makeImpulse(seconds, decay) {
  const rate = A.ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const chs = A.reverbMono ? 1 : 2;
  const buf = A.ctx.createBuffer(chs, len, rate);
  for (let ch = 0; ch < chs; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (A.agen() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}


function applyMixes() {
  if (!A.nodes) return;
  const P = readParams();
  const scale = { lead: 1, counter: 1, pad: 1, arp: 1, bass: 1, perc: 1 };
  for (const name of Object.keys(A.nodes.buses)) {
    A.nodes.buses[name].gain.value = Math.pow(P.mix[name === 'pad' ? 'pad' : name] ?? 0, 1.4) * scale[name];
    A.nodes.sends[name].gain.value = P.reverb * A.nodes.sendAmt[name] * 1.6;
  }
}

function applySpace() {
  if (!A.nodes) return;
  const P = readParams();
  A.nodes.echoWet.gain.value = P.echo * 0.85;
  A.nodes.fb.gain.value = 0.18 + P.echo * 0.32;
  A.nodes.master.gain.value = Math.pow(P.master, 1.6);
}


