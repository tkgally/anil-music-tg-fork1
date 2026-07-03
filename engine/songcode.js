/* ---------------------------------------------------------------------
   Song codes: 4 words = 40 bits = one complete song.

   A Daysong URL is a song, forever. The word list, the bit layout, the
   frozen timbre tables and the derived-knob recipe below can therefore
   NEVER change once shipped (v1) — the songcode test pins them.

   Layout, LSB -> MSB (40 bits total):
     seed 14 | tempo 4 | key 4 | mode 2 | lead 4 | pad 3 |
     arc 2 | energy 3 | length 2 | swing 2

   Everything musically salient is explicit bits; the remaining soft
   knobs are derived deterministically from the code through a seeded
   RNG using *good-mood* ranges (low shadow, low wanderlust, high
   gravity). The engine itself is untouched: this module only produces
   the parameter object that renderSong() already accepts.
--------------------------------------------------------------------- */
import { WORDS, WORD_INDEX } from "./wordlist.js";
import { RNG, clamp } from "./rng.js";

// --- frozen field tables (v1) ---
export const TEMPOS = Array.from({ length: 16 }, (_, i) => 96 + i * 3); // 96..141 BPM
export const CODE_MODES = ['ionian', 'lydian', 'mixolydian', 'dorian']; // the good-mood set
export const CODE_ARCS = ['arch', 'ascent', 'waves', 'twinPeaks'];
export const CODE_LENGTHS = [120, 150, 180, 210];
export const CODE_SWINGS = [0, 0.08, 0.12, 0.16];
// 16 lead slots, frozen — slot NAMES never change (the table is part of the
// URL contract). Slots 8-13 are reserved for instruments that are already
// designed but not yet merged. Whether a slot is *playable today* is
// AVAILABLE_LEADS; a retired voice keeps its slot and remaps via
// RETIRED_LEADS ('pluck' retired 2026-07 — sounded bad; its songs now play
// keys). GEN_LEADS stays 8 so the code bit-stream (and every existing
// playlist) is unchanged.
export const LEAD_TABLE = ['glass', 'reed', 'breath', 'pluck', 'keys', 'brass', 'organ', 'pure',
  'bansuri', 'whistle', 'santoor', 'sarangi', 'shehnai', 'harmonium', 'glass', 'breath'];
export const AVAILABLE_LEADS = new Set(['glass', 'reed', 'breath', 'keys', 'brass', 'organ', 'pure']);
export const RETIRED_LEADS = { pluck: 'keys' };
export const GEN_LEADS = 8;
export const PAD_TABLE = ['warm', 'halo', 'choir', 'strings', 'hollow', 'tanpura', 'warm', 'halo'];
export const AVAILABLE_PADS = new Set(['warm', 'halo', 'choir', 'strings', 'hollow']);
export const GEN_PADS = 5;

// --- 40-bit packing (arithmetic, not bitwise: > 32 bits) ---
const FIELDS = [                 // [name, cardinality] LSB -> MSB
  ['seed', 16384], ['tempo', 16], ['key', 16], ['mode', 4], ['lead', 16],
  ['pad', 8], ['arc', 4], ['energy', 8], ['length', 4], ['swing', 4],
];
export const CODE_SPACE = FIELDS.reduce((n, [, c]) => n * c, 1); // 2^40

export function packCode(f) {
  let code = 0, place = 1;
  for (const [name, card] of FIELDS) {
    const v = f[name] | 0;
    if (v < 0 || v >= card) throw new Error(`field ${name}=${v} out of range`);
    code += v * place;
    place *= card;
  }
  return code;
}
export function unpackCode(code) {
  if (!(code >= 0 && code < CODE_SPACE)) throw new Error('bad code ' + code);
  const f = {};
  let rest = code;
  for (const [name, card] of FIELDS) { f[name] = rest % card; rest = Math.floor(rest / card); }
  return f;
}

// --- words <-> code (4 x 10 bits, first word = most significant) ---
export function codeToWords(code) {
  const w = [];
  let rest = code;
  for (let i = 0; i < 4; i++) { w.unshift(WORDS[rest % 1024]); rest = Math.floor(rest / 1024); }
  return w;
}
export function wordsToCode(words) {
  const w = typeof words === 'string' ? words.split(/[-\s]+/).filter(Boolean) : words;
  if (w.length !== 4) return null;
  let code = 0;
  for (const word of w) {
    const i = WORD_INDEX.get(word.toLowerCase());
    if (i == null) return null;
    code = code * 1024 + i;
  }
  return code;
}

// fold a 40-bit code onto 32 bits for the engine RNGs
const fold = (code) => (((code % 4294967296) ^ Math.imul(Math.floor(code / 4294967296) + 1, 2654435761)) >>> 0);

/* Decode a code (or "four-word-string") into the full engine parameter
   object. Derivation recipe is FROZEN (v1): call order below never changes. */
export function decodeSong(input) {
  const code = typeof input === 'number' ? input : wordsToCode(input);
  if (code == null) return null;
  const f = unpackCode(code);
  const rng = new RNG(fold(code) ^ 0x9e3779b9);
  const e = f.energy / 7;                                  // 0..1 energy macro

  let leadName = LEAD_TABLE[f.lead];
  if (!AVAILABLE_LEADS.has(leadName)) leadName = LEAD_TABLE[f.lead % 8];          // reserved slot
  if (!AVAILABLE_LEADS.has(leadName)) leadName = RETIRED_LEADS[leadName] || 'glass'; // retired voice
  const padName = PAD_TABLE[f.pad];
  const params = {
    tempo: TEMPOS[f.tempo],
    key: String(f.key % 12),
    mode: CODE_MODES[f.mode],
    meter: rng.weighted([['4/4', 8], ['3/4', 1], ['6/8', 1]]),
    lengthSec: CODE_LENGTHS[f.length],
    arc: CODE_ARCS[f.arc],
    complexity: clamp(0.45 + 0.28 * e + rng.range(-0.04, 0.04), 0, 1),
    variety: rng.range(0.30, 0.55),
    gravity: rng.range(0.55, 0.80),          // resolves home — satisfying
    wanderlust: rng.range(0.10, 0.35),       // few wandering modulations
    shadow: rng.range(0.05, 0.25),           // little borrowed-minor melancholy
    humanity: rng.range(0.40, 0.65),
    fractality: rng.range(0.45, 0.75),
    hocket: rng.range(0.00, 0.30),
    sparkle: clamp(0.22 + 0.35 * e + rng.range(-0.05, 0.05), 0, 1),
    tide: rng.range(0.20, 0.45),
    swing: CODE_SWINGS[f.swing],
    mix: {
      lead: rng.range(0.78, 0.90),
      counter: rng.chance(0.12) ? 0 : rng.range(0.45, 0.62),
      pad: rng.range(0.50, 0.70),
      arp: rng.chance(0.12) ? 0.25 : rng.range(0.45, 0.65),
      bass: rng.range(0.68, 0.85),
      perc: clamp(0.50 + 0.22 * e + rng.range(-0.03, 0.03), 0, 1),
    },
    leadTimbre: leadName,
    padTimbre: AVAILABLE_PADS.has(padName) ? padName : PAD_TABLE[f.pad % 5],
    reverb: rng.range(0.35, 0.55),
    echo: rng.range(0.15, 0.40),
    master: 0.80,
    seed: fold(code) || 1,
  };
  const words = codeToWords(code);
  return { code, words, title: words.join(' '), params, energy: f.energy, lengthSec: params.lengthSec };
}

/* Sample a fresh peppy code. `opts.energy` (0..7) lets the playlist shape an
   arc across the day; everything else is drawn from good-mood weights. */
export function makeCode(rng, opts = {}) {
  const energy = opts.energy != null ? clamp(Math.round(opts.energy), 0, 7) : rng.int(3, 6);
  return packCode({
    seed: rng.int(0, 16383),
    tempo: clamp(Math.round(2 + (energy / 7) * 11 + rng.range(-2, 2)), 0, 15),
    key: rng.int(0, 11),
    mode: Number(rng.weighted([['0', 3], ['1', 2], ['2', 3], ['3', 1.5]])), // ionian/lydian/mixo/dorian
    lead: rng.int(0, GEN_LEADS - 1),
    pad: rng.int(0, GEN_PADS - 1),
    arc: Number(rng.weighted([['0', 3], ['1', 2], ['2', 2], ['3', 1]])),
    energy,
    length: Number(rng.weighted([['0', 1], ['1', 2], ['2', 3], ['3', 1]])),
    swing: Number(rng.weighted([['0', 6], ['1', 2], ['2', 1.5], ['3', 0.5]])),
  });
}
