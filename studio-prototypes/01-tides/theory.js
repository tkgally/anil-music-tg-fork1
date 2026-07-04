/* ---------------------------------------------------------------------
   01 · Tides — theory.js
   Pure, deterministic helpers: seeded RNG, modes, just-intonation
   ratios, the chord palette, and voice-leading (nearest-tone matching,
   adapted from Daysong's voiceChord). No audio state in this file.
--------------------------------------------------------------------- */
'use strict';

/* ----- seeded RNG (shared idiom) ----- */
function mulberry32(seed){let a=seed>>>0;return function(){a|=0;a=(a+0x6D2B79F5)|0;
let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;
return((t^(t>>>14))>>>0)/4294967296;};}
class RNG{constructor(s){this.f=mulberry32(s);}next(){return this.f();}
range(a,b){return a+(b-a)*this.f();}int(a,b){return Math.floor(this.range(a,b+1));}
pick(a){return a[Math.floor(this.f()*a.length)];}chance(p){return this.f()<p;}
weighted(pairs){let t=0;for(const p of pairs)t+=p[1];let r=this.f()*t;
for(const p of pairs){r-=p[1];if(r<=0)return p[0];}return pairs[pairs.length-1][0];}}
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const lerp=(a,b,t)=>a+(b-a)*t;

/* ----- scales ----- */
const MODES = {
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  aeolian:    [0, 2, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
};
const NOTE_NAMES = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];

/* Just-intonation ratios over the pedal, one per semitone offset.
   Small-integer ratios so stacked drones beat slowly and consonantly. */
const JI = [1, 16/15, 9/8, 6/5, 5/4, 4/3, 45/32, 3/2, 8/5, 5/3, 16/9, 15/8];

/* offset (semitones over pedal, may exceed 12) -> frequency ratio */
function ratioFor(off, useJI) {
  const oct = Math.floor(off / 12), pc = ((off % 12) + 12) % 12;
  const r = useJI ? JI[pc] : Math.pow(2, pc / 12);
  return r * Math.pow(2, oct);
}

/* ----- chord palette ---------------------------------------------------
   Chords are lists of semitone offsets over the pedal root. The pedal
   itself never moves; chords are colors over it, not functional moves.
   Built per mode: triads on degrees i, bIII, IV, v, bVII (+7ths by the
   "seventh color" amount), sus2/sus4 on the root, one quartal stack. */
function triadOn(scale, deg) {
  const offs = [];
  for (let k = 0; k < 3; k++) {
    const idx = deg + 2 * k;
    offs.push(scale[idx % 7] + 12 * Math.floor(idx / 7));
  }
  return offs;
}

function seventhOf(scale, deg) {
  const idx = deg + 6;
  return scale[idx % 7] + 12 * Math.floor(idx / 7);
}

function buildPalette(modeName, opts) {
  const scale = MODES[modeName];
  const out = [];
  for (const deg of [0, 2, 3, 4, 6]) {           // i, bIII, IV, v, bVII flavors
    out.push({ deg, offs: triadOn(scale, deg), kind: 'triad',
               seventhOff: seventhOf(scale, deg) });
  }
  if (opts.sus) {
    out.push({ deg: 0, offs: [0, 2, 7],  kind: 'sus2' });
    out.push({ deg: 0, offs: [0, 5, 7],  kind: 'sus4' });
    out.push({ deg: 3, offs: [5, 7, 12], kind: 'sus2' });   // IVsus2 color
  }
  if (opts.quartal) {
    out.push({ deg: 0, offs: [0, 5, 10, 15], kind: 'quartal' });
  }
  return out;
}

/* label like "Am7", "Asus2", "A4ths" — root is the chord degree's note */
function chordLabel(chord, rootPc) {
  const pc = ((rootPc + chord.offs[0]) % 12 + 12) % 12;
  let q = '';
  if (chord.kind === 'sus2') q = 'sus2';
  else if (chord.kind === 'sus4') q = 'sus4';
  else if (chord.kind === 'quartal') q = ' 4ths';
  else {
    const third = chord.offs[1] - chord.offs[0];
    q = third === 3 ? 'm' : '';
    if (chord.withSeventh) q += 7;
  }
  return NOTE_NAMES[pc] + q;
}

/* common tones between two chords, counted as pitch classes over pedal */
function commonTones(a, b) {
  const pcsA = new Set(a.offs.map(o => ((o % 12) + 12) % 12));
  let n = 0;
  for (const o of b.offs) if (pcsA.has(((o % 12) + 12) % 12)) n++;
  return n;
}

/* Seeded random walk over the palette, weighted toward gentle motion
   (common tones >= 2) and away from immediate repetition. */
function pickNextChord(rng, palette, cur, seventhAmt) {
  const pairs = palette.map(ch => {
    let w = 1;
    if (cur) {
      const ct = commonTones(cur, ch);
      w *= ct >= 2 ? 3 : (ct === 1 ? 1.2 : 0.45);
      if (ch.deg === cur.deg && ch.kind === cur.kind) w *= 0.25;  // avoid repeats
    }
    if (ch.deg === 0) w *= 1.35;                                  // home leans
    return [ch, w];
  });
  const base = rng.weighted(pairs);
  const chord = { deg: base.deg, offs: base.offs.slice(), kind: base.kind };
  if (base.kind === 'triad' && base.seventhOff != null && rng.chance(seventhAmt)) {
    chord.offs.push(base.seventhOff);
    chord.withSeventh = true;
  }
  return chord;
}

/* ----- voicing ---------------------------------------------------------
   Turn a chord into N target frequencies across lo..hi (pedal-anchored,
   root doubled at the bottom). Ladder of geometric slots; each slot takes
   the chord tone (any octave) nearest to it, making sure every chord
   pitch class appears at least once. */
function voiceTargets(chord, pedalHz, nVoices, useJI, lo, hi) {
  // all candidate frequencies for each distinct offset pc
  const pcs = [];
  const seen = new Set();
  for (const o of chord.offs) {
    const pc = ((o % 12) + 12) % 12;
    if (!seen.has(pc)) { seen.add(pc); pcs.push(pc); }
  }
  const candsFor = pc => {
    const base = pedalHz * ratioFor(pc, useJI);
    const list = [];
    for (let oct = -2; oct <= 3; oct++) {
      const f = base * Math.pow(2, oct);
      if (f >= lo * 0.96 && f <= hi * 1.04) list.push(f);
    }
    return list;
  };

  const targets = [pedalHz];                       // voice 0: the pedal itself
  const used = pcs.map(() => 0);
  for (let i = 1; i < nVoices; i++) {
    const slot = lo * Math.pow(hi / lo, i / Math.max(1, nVoices - 1));
    // prefer a pc not yet used; among its octaves pick nearest to the slot
    let bestF = null, bestD = Infinity, bestPc = -1;
    const unused = used.some(u => u === 0);
    for (let p = 0; p < pcs.length; p++) {
      if (unused && used[p] > 0) continue;
      for (const f of candsFor(pcs[p])) {
        const d = Math.abs(Math.log(f / slot));
        if (d < bestD) { bestD = d; bestF = f; bestPc = p; }
      }
    }
    if (bestF == null) bestF = pedalHz * 2;        // safety: octave of pedal
    else used[bestPc]++;
    targets.push(bestF);
  }
  return targets.sort((a, b) => a - b);
}

/* Minimal-movement assignment: match current voice freqs to targets,
   greedily taking the globally closest (log-distance) pair each round. */
function assignVoices(currentFreqs, targets) {
  const n = currentFreqs.length;
  const takenV = new Array(n).fill(false);
  const takenT = new Array(n).fill(false);
  const out = new Array(n).fill(0);
  for (let round = 0; round < n; round++) {
    let bv = -1, bt = -1, bd = Infinity;
    for (let v = 0; v < n; v++) {
      if (takenV[v]) continue;
      for (let t = 0; t < n; t++) {
        if (takenT[t]) continue;
        const d = Math.abs(Math.log(targets[t] / currentFreqs[v]));
        if (d < bd) { bd = d; bv = v; bt = t; }
      }
    }
    takenV[bv] = true; takenT[bt] = true;
    out[bv] = targets[bt];
  }
  return out;
}

/* Pentatonic subset of the mode for glints: degrees 1 2 3 5 6 */
function glintOffsets(modeName) {
  const s = MODES[modeName];
  return [s[0], s[1], s[2], s[4], s[5]];
}
