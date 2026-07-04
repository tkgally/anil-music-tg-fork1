/* ---------------------------------------------------------------------
   03 · Pulse — theory.js
   Pure, deterministic material: seeded RNG, scales, chord cycles,
   roman-numeral labels, and the 16-step pattern model (generation +
   one-cell mutations). No audio state here — engine.js consumes these.
--------------------------------------------------------------------- */
'use strict';

/* ----- seeded RNG (Daysong idiom) ----- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class RNG {
  constructor(s) { this.f = mulberry32(s); }
  next() { return this.f(); }
  range(a, b) { return a + (b - a) * this.f(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(a) { return a[Math.floor(this.f() * a.length)]; }
  chance(p) { return this.f() < p; }
  weighted(pairs) {
    let t = 0; for (const p of pairs) t += p[1];
    let r = this.f() * t;
    for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
    return pairs[pairs.length - 1][0];
  }
}
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);

/* ----- scales & chords ----- */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MODES = {
  aeolian:    [0, 2, 3, 5, 7, 8, 10],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  ionian:     [0, 2, 4, 5, 7, 9, 11],
};
const MAJOR_OFFS = [0, 2, 4, 5, 7, 9, 11];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/* chord cycles as scale degrees (0-based); re-colored by whichever mode is set */
const CHORD_SETS = {
  dusk:   { label: 'Dusk',   degs: [0, 5, 2, 6] },   // i – bVI – bIII – bVII (aeolian)
  lift:   { label: 'Lift',   degs: [0, 4, 5, 3] },   // I – V – vi – IV (ionian)
  circle: { label: 'Circle', degs: [0, 3, 6, 0] },   // i – IV – bVII – i (dorian)
};

function chordFromDegree(modeName, deg) {
  const scale = MODES[modeName] || MODES.aeolian;
  const off = k => scale[(deg + k) % 7] + 12 * Math.floor((deg + k) / 7);
  const rootOff = off(0);
  const third = (off(2) - rootOff + 24) % 24;
  const fifth = (off(4) - rootOff + 24) % 24;
  const minor = third % 12 === 3, dim = minor && fifth % 12 === 6;
  let roman = ROMAN[deg % 7];
  if (minor) roman = roman.toLowerCase();
  if ((((rootOff) % 12) + 12) % 12 < MAJOR_OFFS[deg % 7]) roman = 'b' + roman;
  if (dim) roman += '°';
  return { deg, rootOff, fifthOff: fifth % 12, minor, roman };
}

function scaleMidisFor(rootPc, modeName) {
  const scale = MODES[modeName] || MODES.aeolian;
  const out = [];
  for (let m = 24; m <= 96; m++) {
    const pc = ((m - rootPc) % 12 + 12) % 12;
    if (scale.includes(pc)) out.push(m);
  }
  return out;
}
function nearestIdx(midis, target) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < midis.length; i++) {
    const d = Math.abs(midis[i] - target);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/* Euclid (Bresenham) onsets: k pulses over n steps, always includes step 0 */
function euclid(k, n) {
  const out = [];
  for (let i = 0; i < k; i++) out.push(Math.floor(i * n / k));
  return out;
}

/* =====================================================================
   The pattern: 16 slots, each null or { deg, dur }
   deg = scale-degree offset from the register-window center
   dur = sustain in steps (1..4)
===================================================================== */

/* one bounded random-walk step with gravity toward the center */
function walkDeg(rng, deg, degSpan) {
  const pairs = [];
  for (let st = -2; st <= 2; st++) {
    const nd = deg + st;
    if (Math.abs(nd) > degSpan) continue;
    let w = [1, 2.2, 1.4, 2.2, 1][st + 2];             // prefer steps to repeats/leaps
    w *= 1 / (1 + Math.abs(nd) * 0.28);                // gravity to center
    pairs.push([nd, w]);
  }
  return pairs.length ? rng.weighted(pairs) : 0;
}

/* legato-ish durations: gap to the next filled slot (wrapping), max 4 */
function fixDurs(pat) {
  const steps = [];
  for (let i = 0; i < 16; i++) if (pat[i]) steps.push(i);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], nxt = steps[(i + 1) % steps.length];
    pat[s].dur = clamp(((nxt - s + 15) % 16) + 1, 1, 4);
  }
}
function countNotes(pat) {
  let n = 0; for (let i = 0; i < 16; i++) if (pat[i]) n++;
  return n;
}

function makePattern(rng, target, degSpan) {
  const pat = new Array(16).fill(null);
  const set = new Set(euclid(clamp(target, 4, 14), 16));
  for (const s of [...set]) {                          // jitter off the euclid skeleton
    if (s === 0) continue;
    if (rng.chance(0.35)) {
      const ns = (s + (rng.chance(0.5) ? 1 : -1) + 16) % 16;
      if (ns !== 0 && !set.has(ns)) { set.delete(s); set.add(ns); }
    }
  }
  const steps = [...set].sort((a, b) => a - b);
  let deg = rng.int(-2, 1);
  for (const s of steps) {
    pat[s] = { deg, dur: 1 };
    deg = walkDeg(rng, deg, degSpan);
  }
  fixDurs(pat);
  return pat;
}

/* Apply exactly ONE mutation. Preserves the step-0 anchor (never emptied).
   opt = { target, degSpan, weights: {pitch, toggle, swap, nudge} }
   Returns { type, slot, slot2 } for the viz flash. */
function mutatePattern(rng, pat, opt) {
  const filled = [], empty = [];
  for (let i = 0; i < 16; i++) (pat[i] ? filled : empty).push(i);
  const n = filled.length;
  const lo = clamp(opt.target - 2, 4, 12), hi = clamp(opt.target + 2, 5, 14);
  const w = opt.weights;
  const offTarget = n < lo || n > hi;
  let pairs = [
    ['pitch', w.pitch],
    ['toggle', w.toggle * (offTarget ? 3 : 1)],
    ['swap', n >= 2 ? w.swap : 0],
    ['nudge', w.nudge],
  ];
  if (pairs.every(p => p[1] <= 0)) pairs = [['pitch', 1]];
  const type = rng.weighted(pairs);

  if (type === 'pitch') {
    const slot = rng.pick(filled);
    const c = pat[slot];
    let delta = rng.pick([-2, -1, -1, 1, 1, 2]);
    let nd = clamp(c.deg + delta, -opt.degSpan, opt.degSpan);
    if (nd === c.deg) nd = clamp(c.deg - delta, -opt.degSpan, opt.degSpan);
    c.deg = nd;
    return { type, slot };
  }
  if (type === 'toggle') {
    const add = n <= lo ? true : (n >= hi ? false : rng.chance(0.5));
    if (add && empty.length) {
      const slot = rng.pick(empty);
      // pitch it near the previous sounding neighbor for a smooth contour
      let ref = 0;
      for (let k = 1; k < 16; k++) {
        const p = pat[(slot - k + 16) % 16];
        if (p) { ref = p.deg; break; }
      }
      pat[slot] = { deg: clamp(ref + rng.int(-1, 1), -opt.degSpan, opt.degSpan), dur: 1 };
      fixDurs(pat);
      return { type, slot };
    }
    const removable = filled.filter(s => s !== 0);
    if (!removable.length) return null;
    const slot = rng.pick(removable);
    pat[slot] = null;
    fixDurs(pat);
    return { type, slot };
  }
  if (type === 'swap') {
    const a = rng.pick(filled);
    let b = rng.pick(filled);
    if (a === b) b = filled[(filled.indexOf(a) + 1) % filled.length];
    const tmp = pat[a].deg; pat[a].deg = pat[b].deg; pat[b].deg = tmp;
    return { type, slot: a, slot2: b };
  }
  // nudge: stretch or shorten one sustain
  const slot = rng.pick(filled);
  const c = pat[slot];
  const d = rng.chance(0.5) ? 1 : -1;
  c.dur = clamp(c.dur + (c.dur + d < 1 || c.dur + d > 4 ? -d : d), 1, 4);
  return { type, slot };
}
