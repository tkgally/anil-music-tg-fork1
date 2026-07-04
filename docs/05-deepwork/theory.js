/* ---------------------------------------------------------------------
   05 · Deep Work — music theory + seeded RNG.
   Ported from Daysong's engine/theory.js + engine/rng.js (same
   collaboration owns that code), trimmed to what this prototype uses
   and converted to classic-script globals.
--------------------------------------------------------------------- */
'use strict';

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

const MODES = {
  ionian:     [0, 2, 4, 5, 7, 9, 11],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian:    [0, 2, 3, 5, 7, 8, 10],
};
const MODE_LABELS = {
  ionian: 'major', dorian: 'dorian', lydian: 'lydian',
  mixolydian: 'mixo', aeolian: 'minor',
};

/* Meters on a 16th-note step grid. groups: [start, length] phrases. */
const METERS = {
  '4/4': { steps: 16, groups: [[0, 4], [4, 4], [8, 4], [12, 4]] },
  '3/4': { steps: 12, groups: [[0, 4], [4, 4], [8, 4]] },
};

/* Accent strength per step: 3 = downbeat, 2 = group start, 1 = pulse. */
function strengthArray(meter) {
  const arr = new Array(meter.steps).fill(0);
  for (const [gs, gl] of meter.groups) {
    arr[gs] = Math.max(arr[gs], gs === 0 ? 3 : 2);
    const sub = (gl % 3 === 0) ? 3 : 2;
    for (let s = gs + sub; s < gs + gl; s += sub) arr[s] = Math.max(arr[s], 1);
  }
  return arr;
}

/* Degree-to-degree transition weights (0-indexed scale degrees). */
const DEG_NEXT = {
  0: [[1, 2], [2, 1], [3, 3], [4, 2.5], [5, 2], [6, 0.8], [0, 1]],
  1: [[4, 3.5], [6, 1.5], [0, 1], [2, 0.8], [3, 1], [5, 0.7]],
  2: [[5, 2.5], [3, 2], [1, 1.5], [0, 0.7]],
  3: [[4, 3], [0, 2], [1, 1.2], [6, 1], [2, 0.6], [5, 0.8]],
  4: [[0, 3.5], [5, 2], [3, 1], [4, 0.8], [6, 0.5]],
  5: [[1, 2], [3, 2], [4, 2], [0, 1.5], [2, 1], [5, 0.5]],
  6: [[0, 3], [5, 1.5], [4, 1], [3, 0.8]],
};

/* Recursive rhythmic subdivision of a group of `len` 16th steps. */
function subdivide(rng, len, density, depth) {
  if (len <= 1) return [len];
  const p = density * (depth === 0 ? 0.95 : 0.55) * Math.min(1, len / 4);
  if (!rng.chance(Math.min(0.92, p))) return [len];
  let parts;
  if (len % 2 === 0) {
    if (len >= 6 && rng.chance(0.4)) {
      parts = (len === 6) ? [2, 2, 2] : [len / 2, len / 4, len / 4];
    } else if (len % 4 === 0 && rng.chance(0.2)) {
      parts = rng.chance(0.5) ? [3 * len / 4, len / 4] : [len / 4, 3 * len / 4];
    } else {
      parts = [len / 2, len / 2];
    }
  } else if (len === 3) {
    parts = rng.pick([[2, 1], [1, 2], [1, 1, 1]]);
  } else if (len === 5) {
    parts = rng.pick([[3, 2], [2, 3], [2, 2, 1]]);
  } else {
    parts = [Math.ceil(len / 2), Math.floor(len / 2)];
  }
  const out = [];
  for (const part of parts) out.push(...subdivide(rng, part, density * 0.78, depth + 1));
  return out;
}

/* ----- seeded RNG (mulberry32) — no Math.random anywhere ----- */
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
  constructor(seed) { this.f = mulberry32(seed); }
  next() { return this.f(); }
  range(a, b) { return a + (b - a) * this.f(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.f() * arr.length)]; }
  chance(p) { return this.f() < p; }
  weighted(pairs) {
    let tot = 0;
    for (const p of pairs) tot += p[1];
    if (tot <= 0) return pairs[0][0];
    let r = this.f() * tot;
    for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
    return pairs[pairs.length - 1][0];
  }
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);

/* Piecewise-linear map through three anchors (@0, @50, @100 of p in 0..1)
   — the shape of every row in the Presence mapping table. */
function pw(p, a, b, c) {
  return p < 0.5 ? a + (b - a) * p * 2 : b + (c - b) * (p - 0.5) * 2;
}
