/* ---------------------------------------------------------------------
   Offline render: compose -> segmented parallel render -> AudioBuffer,
   plus single-voice audition. Extracted verbatim; state lives on `A`.
--------------------------------------------------------------------- */
import { A } from "./state.js";
import { composeSong } from "./composer.js";
import { buildGraph } from "./graph.js";
import { playLead, playCounter, playPad, playBass, playArp, playPerc } from "./voices.js";
import { midiToFreq, noteRnd } from "./rng.js";

const RENDER_SR = 44100;      // 44.1k renders ~8% fewer samples than 48k
const REVERB_TAIL = 4.2;      // seconds appended so note/reverb tails ring out
const REVERB_IR = 3.2;        // convolver impulse length (see makeImpulse)
const SEG_MIN = 30;           // songs shorter than this render in one shot

// params.percKit === 'tabla' swaps the drum kit at the I/O boundary — the
// composer still writes kick/snare/hat patterns; they land on tabla strokes.
const TABLA_KIT = { tabla: { kick: 'tablaGe', snare: 'tablaNa', hat: 'tablaTin', hatOpen: 'tablaTin', shaker: 'tablaTin' } };


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
  A.audioSeed = seed;
  A.reverbSeconds = seg.reverbSeconds || 3.2;
  A.reverbMono = !!seg.reverbMono;
  A.fast = !!seg.fast;
  buildGraph(off);

  // master: fade in only on the segment containing absolute t=0
  const target = Math.pow(P.master, 1.6);
  A.nodes.master.gain.cancelScheduledValues(0);
  if (start <= 1e-6) {
    A.nodes.master.gain.setValueAtTime(0, 0);
    A.nodes.master.gain.linearRampToValueAtTime(target, 0.3);
  } else {
    A.nodes.master.gain.setValueAtTime(target, 0);
  }

  // seed tide/echo to the value active at `start`, then replay automation
  let init = null;
  for (const au of automation) { if (au.t <= start) init = au; else break; }
  if (init) {
    A.nodes.tideFilter.frequency.setValueAtTime(init.tideCutoff, 0);
    A.nodes.delay.delayTime.setValueAtTime(init.delayTime, 0);
  }
  for (const au of automation) {
    if (au.t > start && au.t < b) {
      const lt = au.t - start;
      A.nodes.tideFilter.frequency.setTargetAtTime(au.tideCutoff, lt, 1.2);
      A.nodes.delay.delayTime.setTargetAtTime(au.delayTime, lt, 0.4);
    }
  }

  // schedule every note whose onset is within [start, b). Snap the onset to the
  // sample grid (integer sample - startSamp) so a note lands on the exact same
  // absolute sample in every segment and in the single-shot render -> the
  // stitched result is bit-identical, not just perceptually close.
  for (const e of scheduled) {
    if (e.t < start || e.t >= b) continue;
    const lt = (Math.round(e.t * sr) - startSamp) / sr;
    if (e.voice === 'perc') { playPerc(lt, TABLA_KIT[P.percKit] ? (TABLA_KIT[P.percKit][e.type] || e.type) : e.type, e.vel * Math.pow(P.mix.perc, 0.5)); continue; }
    const freq = midiToFreq(e.midi);
    if (e.voice === 'lead') playLead(lt, freq, e.durSec, e.vel, P, noteRnd(seed, e.t, e.midi));
    else if (e.voice === 'counter') playCounter(lt, freq, e.durSec, e.vel);
    else if (e.voice === 'pad') playPad(lt, freq, e.durSec, e.vel, P, e.energy);
    else if (e.voice === 'bass') playBass(lt, freq, e.durSec, e.vel);
    else if (e.voice === 'arp') playArp(lt, freq, e.durSec, e.vel);
  }

  const buf = await off.startRendering();
  A.ctx = null; A.nodes = null; A.noiseBuf = null;

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
   A.nodes aren't freed mid-render (onended/scrap fire only afterwards), so every
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
  // per-song room size (params.reverbSec) — Fast mode scales it down
  const roomSec = params && params.reverbSec != null ? params.reverbSec : null;
  const revSec = opts.reverbSeconds != null ? opts.reverbSeconds
    : roomSec != null ? (fast ? Math.min(1.8, Math.max(0.9, roomSec * 0.45)) : roomSec)
    : (fast ? 1.4 : REVERB_IR);
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
    if (type === 'tabla') {
      // teental theka (16 beats): Dha Dhin Dhin Dha | Dha Dhin Dhin Dha | Dha Tin Tin Ta | Ta Dhin Dhin Dha
      const step = 0.3;
      const theka = ['dha','dhin','dhin','dha','dha','dhin','dhin','dha','dha','tin','tin','ta','ta','dhin','dhin','dha'];
      const bols = { dha: ['tablaGe','tablaNa'], dhin: ['tablaGe','tablaTin'], tin: ['tablaTin'], ta: ['tablaNa'] };
      theka.forEach((bol, i) => {
        const vel = (i % 4 === 0) ? 0.95 : 0.66;
        for (const st of bols[bol]) events.push({ t: i * step, type: st, vel });
      });
    } else {
      const grid = {
        kick: { n: 4, step: 0.45 }, snare: { n: 4, step: 0.5 }, hat: { n: 8, step: 0.24 },
        hatOpen: { n: 4, step: 0.42 }, shaker: { n: 8, step: 0.22 },
      }[type] || { n: 4, step: 0.4 };
      for (let i = 0; i < grid.n; i++) events.push({ t: i * grid.step, type, vel: i % 2 === 0 ? 0.95 : 0.68 });
    }
  } else if (spec.voice === 'arp') {
    const cyc = [60, 64, 67, 72, 76, 72, 67, 64];
    cyc.concat(cyc).forEach((m, i) => events.push({ t: i * 0.15, midi: m, dur: 0.2, vel: 0.72 }));
  } else {
    // Every melodic voice plays the SAME reference melody, so the timbres are
    // directly comparable; tanpura keeps its plucked drone cycle. (The shared
    // line still ends on a long held note, which shows meend / whistle vibrato.)
    const ph = (spec.voice === 'pad' && spec.timbre === 'tanpura')
      ? { vel: 0.9, energy: 0.7, notes: [[50,0,2.6],[55,0.62,2.6],[55,1.24,2.6],[43,1.86,2.8],[50,2.6,2.6],[55,3.22,2.6],[55,3.84,2.6],[43,4.46,2.8]] }
      : {
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

  const prevParams = A.params;
  A.params = P; A.audioSeed = seed; A.reverbSeconds = revSec; A.reverbMono = false; A.fast = false;
  buildGraph(off);
  A.nodes.master.gain.setValueAtTime(Math.pow(P.master, 1.6), 0);

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
  A.ctx = null; A.nodes = null; A.noiseBuf = null;
  A.params = prevParams;
  return buf;
}

