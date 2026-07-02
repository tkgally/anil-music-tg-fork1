/* ---------------------------------------------------------------------
   Seeded RNG + math utilities. Leaf module (no deps). Extracted verbatim
   from the original engine.
--------------------------------------------------------------------- */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic per-note random in [0,1) from stable note identity. Used for
// the audio layer (oscillator detune) so a note gets the SAME micro-detune no
// matter which render segment/worker produces it -> seamless parallel seams,
// and fully reproducible renders.
export function noteRnd(seed, t, midi) {
  const k = ((seed >>> 0) ^ (Math.round(t * 1000) >>> 0) ^ Math.imul(midi & 0xff, 2654435761)) >>> 0;
  return mulberry32(k)();
}

export class RNG {
  constructor(seed) { this.f = mulberry32(seed); }
  next() { return this.f(); }
  range(a, b) { return a + (b - a) * this.f(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.f() * arr.length)]; }
  chance(p) { return this.f() < p; }
  weighted(pairs) {            // pairs: [[item, weight], ...]
    let tot = 0;
    for (const p of pairs) tot += p[1];
    if (tot <= 0) return pairs[0][0];
    let r = this.f() * tot;
    for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
    return pairs[pairs.length - 1][0];
  }
}

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
