/* ---------------------------------------------------------------------
   The day's playlist: (name, date) -> the same 12 songs, forever, on any
   device — no backend. A one-way string hash seeds the RNG, so a song's
   four words never reveal whose playlist it came from.

   FROZEN (v1): the hash, the energy profile and the sampling order below
   define everyone's playlists and can never change.
--------------------------------------------------------------------- */
import { RNG, clamp } from "./rng.js";
import { makeCode, decodeSong, unpackCode } from "./songcode.js";

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
// gentle good-mood arc across the day's 12: ease in, peak late, land soft
const ENERGY_PROFILE = [4, 5, 4, 5, 6, 5, 6, 7, 6, 5, 4, 3];

export function playlistFor(name, date) {
  const key = normalizeName(name) + '/' + String(date);
  const rng = new RNG((hashStr(key) % 4294967291) >>> 0);
  const songs = [];
  let prev = null;
  for (let i = 0; i < PLAYLIST_SIZE; i++) {
    const energy = clamp(ENERGY_PROFILE[i] + rng.int(-1, 1), 0, 7);
    let code, f;
    for (let tries = 0; tries < 8; tries++) {          // variety: don't repeat
      code = makeCode(rng, { energy });                 // lead or key back-to-back
      f = unpackCode(code);
      if (!prev || (f.lead !== prev.lead && f.key !== prev.key)) break;
    }
    prev = f;
    songs.push(decodeSong(code));
  }
  return songs;
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
