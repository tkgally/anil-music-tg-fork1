/* ---------------------------------------------------------------------
   The day's playlist: (name, date) -> the same 12 songs, forever, on any
   device — no backend. A one-way string hash seeds the RNG, so a song's
   four words never reveal whose playlist it came from.

   v2: diversity is built in, not hoped for —
     · 12 DISTINCT leads (a shuffled bag of all 13 playable slots)
     · every ensemble appears (chamber/unplugged land on the calm slots,
       groove on the hottest)
     · ≥4 distinct modes incl. at least one minor-family color
     · ≥2 songs not in 4/4 (re-seeded until the derived meter cooperates)
     · no adjacent key repeats; the day's energy arc rotates per day
   All draws come from one seeded RNG in a fixed order — FROZEN (v2).
--------------------------------------------------------------------- */
import { RNG, clamp } from "./rng.js";
import { makeCode, packCode, decodeSong, unpackCode, MINOR_MODES, CODE_MODES } from "./songcode.js";

// cyrb53 — tiny, well-mixed 53-bit string hash
export function hashStr(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function normalizeName(s) {
  const n = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  return n || 'friend';
}

// local date -> 'YYMMDD' (a Daysong day is the visitor's own day)
export function dateCode(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getFullYear() % 100) + p(d.getMonth() + 1) + p(d.getDate());
}

export const PLAYLIST_SIZE = 12;
// gentle arc: ease in, peak late, land soft — rotated (and sometimes
// reversed) per day so Monday's shape isn't Tuesday's
const ENERGY_PROFILE = [4, 5, 4, 5, 6, 5, 6, 7, 6, 5, 4, 3];

function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function playlistFor(name, date) {
  const key = normalizeName(name) + '/' + String(date);
  const rng = new RNG((hashStr(key) % 4294967291) >>> 0);

  // 1. the day's energy arc (rotate, occasionally reverse, jitter)
  const rot = rng.int(0, 11);
  const reversed = rng.chance(0.3);
  const energies = [];
  for (let i = 0; i < PLAYLIST_SIZE; i++) {
    const base = ENERGY_PROFILE[(i + rot) % 12];
    energies.push(clamp(base + rng.int(-1, 1), 0, 7));
  }
  if (reversed) energies.reverse();
  // the opener should start fast: cap its energy (dense energy-7 songs also
  // take the longest to bake, and song 1 is what the listener waits for)
  if (energies[0] > 5) {
    const j = energies.findIndex((e) => e <= 5);
    if (j > 0) { const t = energies[0]; energies[0] = energies[j]; energies[j] = t; }
  }

  // 2. twelve DISTINCT leads: shuffled bag of all 13 playable slots
  const leadBag = shuffle(rng, [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).slice(0, PLAYLIST_SIZE);

  // 3. ensembles: quiet colors on the calmest slots, groove on the hottest
  const byEnergy = energies.map((e, i) => [e, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const ensembles = new Array(PLAYLIST_SIZE).fill(0);           // full
  ensembles[byEnergy[0][1]] = 3;                                // chamber on the calmest
  ensembles[byEnergy[1][1]] = 1;                                // unplugged next
  ensembles[byEnergy[11][1]] = 2;                               // groove on the hottest
  ensembles[byEnergy[10][1]] = 2;
  ensembles[byEnergy[rng.int(2, 6)][1]] = 1;                    // one more unplugged mid-arc

  // 4. draw the songs (keys must differ from the previous slot's)
  const fields = [];
  let prevKey = -1;
  for (let i = 0; i < PLAYLIST_SIZE; i++) {
    let code, f;
    // slot 0 also gets a shorter length (≤ 3:00) so playback starts sooner
    const openerLen = i === 0 ? { length: Number(rng.weighted([['0', 1.5], ['1', 2], ['2', 2]])) } : {};
    for (let tries = 0; tries < 8; tries++) {
      code = makeCode(rng, { energy: energies[i], lead: leadBag[i], ensemble: ensembles[i], ...openerLen });
      f = unpackCode(code);
      if (f.key % 12 !== prevKey) break;
    }
    prevKey = f.key % 12;
    fields.push(f);
  }

  // 5. mode quota: ≥4 distinct, ≥1 minor-family (fixed scan, deterministic)
  const modes = () => new Set(fields.map((f) => f.mode));
  if (![...modes()].some((m) => MINOR_MODES.has(CODE_MODES[m]))) {
    fields[byEnergy[2][1]].mode = rng.pick([3, 4]);             // dorian | aeolian on a calm slot
  }
  for (let guard = 0; modes().size < 4 && guard < 8; guard++) {
    const unused = CODE_MODES.map((_, m) => m).filter((m) => !modes().has(m));
    const friendly = unused.filter((m) => [0, 1, 3, 4, 6].includes(m)); // ion/lyd/dor/aeo/mixo
    const counts = {};
    for (const f of fields) counts[f.mode] = (counts[f.mode] || 0) + 1;
    const dupIdx = fields.findIndex((f) => counts[f.mode] > 1);
    fields[dupIdx].mode = rng.pick(friendly.length ? friendly : unused);
  }

  // 6. meter quota: ≥2 songs not in 4/4. Meter is derived from the seed, so
  //    re-roll seeds on fixed slots until the decoded meter cooperates.
  const meterOf = (f) => decodeSong(packCode(f)).params.meter;
  const nonCommon = () => fields.filter((f) => meterOf(f) !== '4/4').length;
  for (const slot of [2, 7, 4, 9]) {
    if (nonCommon() >= 2) break;
    const f = fields[slot];
    for (let tries = 0; tries < 24 && meterOf(f) === '4/4'; tries++) f.seed = rng.int(0, 4095);
  }

  // 7. decode the final twelve
  return fields.map((f) => decodeSong(packCode(f)));
}

/* Page identity: background hue from the NAME, accent hue from the DATE
   (kept at least 50 degrees from the background so it always reads). */
export function identityHues(name, date) {
  const bgHue = hashStr('bg:' + normalizeName(name)) % 360;
  let accentHue = hashStr('accent:' + String(date)) % 360;
  const dist = (a, b) => Math.min((a - b + 360) % 360, (b - a + 360) % 360);
  while (dist(accentHue, bgHue) < 50) accentHue = (accentHue + 61) % 360;
  return { bgHue, accentHue };
}
