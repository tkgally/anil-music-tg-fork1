// Shared parameter fixtures for the test suites (not a test itself).

export const BASE = {
  tempo: 96, key: "0", mode: "aeolian", meter: "4/4", lengthSec: 40, arc: "arch",
  complexity: 0.55, variety: 0.4, gravity: 0.6, wanderlust: 0.3, shadow: 0.25,
  humanity: 0.5, fractality: 0.6, hocket: 0.2, sparkle: 0.3, tide: 0.35, swing: 0,
  mix: { lead: 0.8, counter: 0.55, pad: 0.65, arp: 0.5, bass: 0.75, perc: 0.6 },
  leadTimbre: "glass", padTimbre: "warm", reverb: 0.45, echo: 0.3, master: 0.8, seed: 1,
};

export function P(over = {}) {
  return { ...BASE, ...over, mix: { ...BASE.mix, ...(over.mix || {}) } };
}

// Composition battery — varied seed / mode / meter / arc / character.
export const COMPOSE_CASES = {
  "aeolian-4x4":      { seed: 1 },
  "dorian-3x4":       { seed: 7, mode: "dorian", meter: "3/4" },
  "lydian-7x8-waves": { seed: 42, mode: "lydian", meter: "7/8", arc: "waves", variety: 0.7, wanderlust: 0.6 },
  "busy-6x8-swing":   { seed: 99, meter: "6/8", complexity: 0.9, hocket: 0.6, sparkle: 0.7, swing: 0.4 },
  "sparse-still":     { seed: 3, arc: "still", complexity: 0.2, gravity: 0.9, shadow: 0.0 },
  "harmonicMinor":    { seed: 21, mode: "harmonicMinor", key: "9", shadow: 0.6, variety: 0.5, lengthSec: 60 },
};

// Render battery — one short (single-segment), one long (segmented), one Fast.
export const RENDER_CASES = {
  "short-24s":     { params: { seed: 5, lengthSec: 24 }, opts: {} },
  "segmented-70s": { params: { seed: 8, lengthSec: 70, padTimbre: "strings" }, opts: {} },
  "fast-40s":      { params: { seed: 5, lengthSec: 40 }, opts: { fast: true } },
};

// Every voice the roster auditions (voice + timbre/percType).
export const AUDITION_SPECS = [
  { voice: "lead", timbre: "glass" }, { voice: "lead", timbre: "reed" },
  { voice: "lead", timbre: "breath" },
  { voice: "lead", timbre: "keys" }, { voice: "lead", timbre: "brass" },
  { voice: "lead", timbre: "organ" }, { voice: "lead", timbre: "pure" },
  { voice: "lead", timbre: "bansuri" }, { voice: "lead", timbre: "whistle" },
  { voice: "lead", timbre: "santoor" }, { voice: "lead", timbre: "sarangi" },
  { voice: "lead", timbre: "shehnai" }, { voice: "lead", timbre: "harmonium" },
  { voice: "pad", timbre: "warm" }, { voice: "pad", timbre: "halo" },
  { voice: "pad", timbre: "choir" }, { voice: "pad", timbre: "strings" },
  { voice: "pad", timbre: "hollow" }, { voice: "pad", timbre: "tanpura" },
  { voice: "bass" }, { voice: "arp" }, { voice: "counter" },
  { voice: "perc", timbre: "kick" }, { voice: "perc", timbre: "snare" },
  { voice: "perc", timbre: "hat" }, { voice: "perc", timbre: "hatOpen" },
  { voice: "perc", timbre: "shaker" }, { voice: "perc", timbre: "tabla" },
];
