/* ---------------------------------------------------------------------
   Song codes v2: 4 words = 40 bits = one complete song.

   A Daysong URL is a song, forever. The word list, the bit layout, the
   frozen timbre tables and the derived-knob recipe below can therefore
   NEVER change once shipped — the songcode test pins them. (v2 re-cut
   2026-07, prerelease: opened the palette up — all 8 modes, 8 arcs, an
   explicit ensemble field, wider derived ranges, per-song room size and
   an optional tabla kit — because v1's narrow good-mood bands made
   every song sound alike.)

   Layout, LSB -> MSB (40 bits total):
     seed 12 | tempo 4 | key 4 | mode 3 | lead 4 | pad 3 |
     arc 3 | energy 3 | length 2 | ensemble 2

   Everything musically salient is explicit bits; the remaining soft
   knobs are derived deterministically from the code through a seeded
   RNG (draw order below is part of the contract). The generator keeps
   the *weights* peppy; the *space* now supports contrast. The engine
   itself is untouched: this module only produces the parameter object
   that renderSong() already accepts.
--------------------------------------------------------------------- */
import { WORDS, WORD_INDEX } from "./wordlist.js";
import { RNG, clamp } from "./rng.js";

// --- frozen field tables (v2) ---
export const TEMPOS = Array.from({ length: 16 }, (_, i) => 96 + i * 3); // 96..141 BPM
export const CODE_MODES = ['ionian', 'lydian', 'harmonicMinor', 'dorian',
  'aeolian', 'melodicMinor', 'mixolydian', 'phrygian'];                 // full engine palette
export const MINOR_MODES = new Set(['dorian', 'aeolian', 'melodicMinor', 'harmonicMinor', 'phrygian']);
export const CODE_ARCS = ['arch', 'ascent', 'waves', 'twinPeaks', 'slowBurn', 'valley', 'still', 'sawtooth'];
export const CODE_LENGTHS = [120, 150, 180, 210];
export const ENSEMBLES = ['full', 'unplugged', 'groove', 'chamber'];
// 16 lead slots, frozen — slot NAMES never change (they are part of the URL
// contract). Slot 3 ('pluck') is retired and remaps via RETIRED_LEADS;
// slots 14/15 are aliases. The generator draws only GEN_LEAD_SLOTS.
export const LEAD_TABLE = ['glass', 'reed', 'breath', 'pluck', 'keys', 'brass', 'organ', 'pure',
  'bansuri', 'whistle', 'santoor', 'sarangi', 'shehnai', 'harmonium', 'glass', 'breath'];
export const AVAILABLE_LEADS = new Set(['glass', 'reed', 'breath', 'keys', 'brass', 'organ', 'pure',
  'bansuri', 'whistle', 'santoor', 'sarangi', 'shehnai', 'harmonium']);
export const RETIRED_LEADS = { pluck: 'keys' };
export const GEN_LEAD_SLOTS = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];   // 13 playable slots
export const INDIAN_LEADS = new Set(['bansuri', 'santoor', 'sarangi', 'shehnai', 'harmonium']);
export const PAD_TABLE = ['warm', 'halo', 'choir', 'strings', 'hollow', 'tanpura', 'warm', 'halo'];
export const AVAILABLE_PADS = new Set(['warm', 'halo', 'choir', 'strings', 'hollow', 'tanpura']);
export const GEN_PAD_SLOTS = [0, 1, 2, 3, 4, 5];

// --- 40-bit packing (arithmetic, not bitwise: > 32 bits) ---
const FIELDS = [                 // [name, cardinality] LSB -> MSB
  ['seed', 4096], ['tempo', 16], ['key', 16], ['mode', 8], ['lead', 16],
  ['pad', 8], ['arc', 8], ['energy', 8], ['length', 4], ['ensemble', 4],
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
   object. The derivation — including the RNG draw ORDER — is FROZEN (v2). */
export function decodeSong(input) {
  const code = typeof input === 'number' ? input : wordsToCode(input);
  if (code == null) return null;
  const f = unpackCode(code);
  const rng = new RNG(fold(code) ^ 0x9e3779b9);
  const e = f.energy / 7;                                  // 0..1 energy macro
  const mode = CODE_MODES[f.mode];
  const ensemble = ENSEMBLES[f.ensemble];
  const minorish = MINOR_MODES.has(mode);

  let leadName = LEAD_TABLE[f.lead];
  if (!AVAILABLE_LEADS.has(leadName)) leadName = LEAD_TABLE[f.lead % 8];          // alias slot
  if (!AVAILABLE_LEADS.has(leadName)) leadName = RETIRED_LEADS[leadName] || 'glass'; // retired voice
  const padName = PAD_TABLE[f.pad];
  const pad = AVAILABLE_PADS.has(padName) ? padName : PAD_TABLE[f.pad % 5];

  // ---- derived knobs: draw order is part of the v2 contract ----
  const meter = rng.weighted([['4/4', 6], ['3/4', 2], ['6/8', 2], ['5/4', 0.5]]);
  const complexity = clamp(0.40 + 0.28 * e + rng.range(-0.06, 0.06), 0, 1);   // capped: density is also bake time
  const variety = rng.range(0.25, 0.80);
  const gravity = rng.range(0.45, 0.85);
  const wanderlust = rng.range(0.05, 0.60);
  const shadow = minorish ? rng.range(0.15, 0.45) : rng.range(0.05, 0.30);
  const humanity = ensemble === 'unplugged' ? rng.range(0.55, 0.85) : rng.range(0.35, 0.70);
  const fractality = rng.range(0.35, 0.85);
  const hocket = rng.range(0, 0.50);
  const sparkle = clamp(0.18 + 0.38 * e + rng.range(-0.08, 0.08), 0, 1);
  const tide = rng.range(0.15, 0.60);
  const swing = ensemble === 'groove'
    ? rng.pick([0.12, 0.16, 0.20])
    : (rng.chance(0.25) ? rng.pick([0.08, 0.12]) : 0);

  // ---- the band: which voices play, and how loud (per ensemble) ----
  let mix;
  if (ensemble === 'unplugged') {
    mix = {
      lead: rng.range(0.78, 0.90),
      counter: rng.range(0.35, 0.60),
      pad: rng.range(0.55, 0.75),
      arp: rng.chance(0.5) ? 0 : rng.range(0.30, 0.50),
      bass: rng.range(0.55, 0.75),
      perc: 0,
    };
  } else if (ensemble === 'groove') {
    mix = {
      lead: rng.range(0.70, 0.85),
      counter: rng.chance(0.3) ? 0 : rng.range(0.40, 0.55),
      pad: rng.range(0.35, 0.55),
      arp: rng.range(0.50, 0.68),
      bass: rng.range(0.75, 0.90),
      perc: clamp(0.60 + 0.20 * e, 0, 1),
    };
  } else if (ensemble === 'chamber') {
    mix = {
      lead: rng.range(0.78, 0.92),
      counter: rng.range(0.50, 0.70),
      pad: rng.range(0.50, 0.75),
      arp: 0,
      bass: rng.chance(0.4) ? 0 : rng.range(0.40, 0.60),
      perc: 0,
    };
  } else { // full
    mix = {
      lead: rng.range(0.75, 0.90),
      counter: rng.chance(0.15) ? 0 : rng.range(0.45, 0.65),
      pad: rng.range(0.45, 0.70),
      arp: rng.chance(0.15) ? 0.2 : rng.range(0.40, 0.65),
      bass: rng.range(0.65, 0.85),
      perc: clamp(0.45 + 0.25 * e, 0, 1),
    };
  }

  // drum kit: tabla is likelier under an Indian lead (drawn even when perc=0
  // so the draw count per path stays fixed)
  const percKit = rng.weighted(INDIAN_LEADS.has(leadName)
    ? [['kit', 1.2], ['tabla', 1]]
    : [['kit', 5], ['tabla', 1]]);

  const reverb = rng.range(0.30, 0.60);
  const echo = rng.range(0.10, 0.50);
  // every song gets its own room; unplugged/chamber lean toward the hall
  const reverbSec = clamp(rng.range(2.2, 4.0) + (ensemble === 'unplugged' || ensemble === 'chamber' ? 0.4 : 0), 2.2, 4.4);

  const params = {
    tempo: TEMPOS[f.tempo],
    key: String(f.key % 12),
    mode, meter,
    lengthSec: CODE_LENGTHS[f.length],
    arc: CODE_ARCS[f.arc],
    complexity, variety, gravity, wanderlust, shadow, humanity, fractality,
    hocket, sparkle, tide, swing, mix,
    leadTimbre: leadName,
    padTimbre: pad,
    percKit,
    reverb, echo, reverbSec,
    master: 0.80,
    seed: fold(code) || 1,
  };
  const words = codeToWords(code);
  return { code, words, title: words.join(' '), params, energy: f.energy, lengthSec: params.lengthSec, ensemble };
}

/* Sample a fresh code. Weights stay peppy; opts can force any field so the
   playlist can enforce day-level diversity quotas. */
export function makeCode(rng, opts = {}) {
  const energy = opts.energy != null ? clamp(Math.round(opts.energy), 0, 7) : rng.int(3, 6);
  return packCode({
    seed: opts.seed != null ? opts.seed : rng.int(0, 4095),
    tempo: opts.tempo != null ? opts.tempo : clamp(Math.round(2 + (energy / 7) * 11 + rng.range(-2, 2)), 0, 15),
    key: opts.key != null ? opts.key : rng.int(0, 11),
    mode: opts.mode != null ? opts.mode : Number(rng.weighted([   // peppy-leaning: ~2/3 major-family
      ['0', 3], ['1', 1.5], ['2', 0.35], ['3', 1.8], ['4', 1.0], ['5', 0.5], ['6', 2.5], ['7', 0.1],
    ])),
    lead: opts.lead != null ? opts.lead : rng.pick(GEN_LEAD_SLOTS),
    pad: opts.pad != null ? opts.pad : rng.pick(GEN_PAD_SLOTS),
    arc: opts.arc != null ? opts.arc : Number(rng.weighted([
      ['0', 3], ['1', 2], ['2', 2], ['3', 1], ['4', 1], ['5', 0.8], ['6', 0.7], ['7', 0.5],
    ])),
    energy,
    length: opts.length != null ? opts.length : Number(rng.weighted([['0', 1], ['1', 2], ['2', 3], ['3', 1]])),
    ensemble: opts.ensemble != null ? opts.ensemble : Number(rng.weighted([['0', 4], ['1', 1.5], ['2', 2], ['3', 1]])),
  });
}
