/* ---------------------------------------------------------------------
   Music theory. Extracted verbatim. Depends only on `clamp` (ARCS).
--------------------------------------------------------------------- */
import { clamp } from "./rng.js";

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export const MODES = {
  ionian:        [0, 2, 4, 5, 7, 9, 11],
  dorian:        [0, 2, 3, 5, 7, 9, 10],
  phrygian:      [0, 1, 3, 5, 7, 8, 10],
  lydian:        [0, 2, 4, 6, 7, 9, 11],
  mixolydian:    [0, 2, 4, 5, 7, 9, 10],
  aeolian:       [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor:  [0, 2, 3, 5, 7, 9, 11],
};
export const MODE_LABELS = {
  ionian: 'major', dorian: 'dorian', phrygian: 'phrygian', lydian: 'lydian',
  mixolydian: 'mixo', aeolian: 'minor', harmonicMinor: 'h.minor', melodicMinor: 'm.minor',
};

/* Meters: everything is on a 16th-note step grid.
   groups: [start, length] phrases for rhythm generation.
   snare: backbeat steps. primary: the heaviest accents.            */
export const METERS = {
  '4/4': { steps: 16, groups: [[0, 4], [4, 4], [8, 4], [12, 4]], snare: [4, 12], primary: [0, 8] },
  '3/4': { steps: 12, groups: [[0, 4], [4, 4], [8, 4]],          snare: [8],     primary: [0] },
  '6/8': { steps: 12, groups: [[0, 6], [6, 6]],                  snare: [6],     primary: [0, 6] },
  '5/4': { steps: 20, groups: [[0, 4], [4, 4], [8, 4], [12, 4], [16, 4]], snare: [12], primary: [0, 12] },
  '7/8': { steps: 14, groups: [[0, 4], [4, 4], [8, 6]],          snare: [8],     primary: [0, 8] },
};

/* Per-meter accent strength per step: 3 = downbeat, 2 = group start,
   1 = inner pulse, 0 = weak.                                         */
export function strengthArray(meter) {
  const arr = new Array(meter.steps).fill(0);
  for (const [gs, gl] of meter.groups) {
    arr[gs] = Math.max(arr[gs], gs === 0 ? 3 : 2);
    const sub = (gl % 3 === 0) ? 3 : 2;
    for (let s = gs + sub; s < gs + gl; s += sub) arr[s] = Math.max(arr[s], 1);
  }
  return arr;
}

/* Euclidean-ish rhythm: k onsets spread over n steps. */
export function euclid(k, n) {
  const out = [];
  for (let i = 0; i < n; i++) if (((i * k) % n) < k) out.push(i);
  return out;
}

/* Degree-to-degree transition weights (0-indexed scale degrees). */
export const DEG_NEXT = {
  0: [[1, 2], [2, 1], [3, 3], [4, 2.5], [5, 2], [6, 0.8], [0, 1]],
  1: [[4, 3.5], [6, 1.5], [0, 1], [2, 0.8], [3, 1], [5, 0.7]],
  2: [[5, 2.5], [3, 2], [1, 1.5], [0, 0.7]],
  3: [[4, 3], [0, 2], [1, 1.2], [6, 1], [2, 0.6], [5, 0.8]],
  4: [[0, 3.5], [5, 2], [3, 1], [4, 0.8], [6, 0.5]],
  5: [[1, 2], [3, 2], [4, 2], [0, 1.5], [2, 1], [5, 0.5]],
  6: [[0, 3], [5, 1.5], [4, 1], [3, 0.8]],
};

/* Narrative arcs: map piece position 0..1 to energy 0..1. */
export const ARCS = {
  arch:   t => 0.18 + 0.82 * Math.pow(Math.sin(Math.PI * clamp(t * 1.04, 0, 1)), 0.9),
  ascent: t => 0.15 + 0.85 * Math.pow(t, 1.4),
  waves:  t => clamp(0.5 + 0.3 * Math.sin(2 * Math.PI * 3 * t - Math.PI / 2) + 0.13 * Math.sin(2 * Math.PI * 7.1 * t), 0.08, 1),
  still:  t => 0.24 + 0.08 * Math.sin(2 * Math.PI * 2 * t),
  plunge: t => 0.95 - 0.8 * Math.pow(t, 0.8),
  twinPeaks: t => clamp(0.2 + 0.78 * Math.max(
    Math.exp(-Math.pow((t - 0.3) / 0.14, 2)),
    Math.exp(-Math.pow((t - 0.78) / 0.12, 2))), 0.08, 1),
  valley:    t => 0.88 - 0.68 * Math.pow(Math.sin(Math.PI * clamp(t, 0, 1)), 1.2),
  staircase: t => 0.2 + 0.75 * Math.min(4, Math.floor(t * 5)) / 4,
  sawtooth:  t => 0.22 + 0.68 * Math.pow((t * 3) % 1, 1.15),
  slowBurn:  t => t < 0.6
    ? 0.18 + 0.05 * Math.sin(2 * Math.PI * 4 * t)
    : 0.18 + 0.82 * Math.pow((t - 0.6) / 0.4, 1.6),
};

/* Recursive rhythmic subdivision of a group of `len` 16th steps. */
export function subdivide(rng, len, density, depth) {
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
