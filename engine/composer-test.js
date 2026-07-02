// composeSong golden-master: locks the entire (pure, deterministic) composer.
// Runs in Node or the browser. Record with:  node engine/composer-test.js --record
import { test, eq, fnv1a, RECORD, recordGolden, loadGolden } from "./testkit.js";
import { composeSong } from "./engine.js";
import { P, COMPOSE_CASES } from "./fixtures.js";

const enc = new TextEncoder();

// Round all numbers so the hash is stable across environments (V8's
// Math.sin/pow can differ by a ULP between the Node and Chromium builds); a
// real regression changes values/structure by far more than 1e-6.
function roundDeep(v, dp = 6) {
  if (typeof v === "number") return Number.isFinite(v) ? +v.toFixed(dp) : v;
  if (Array.isArray(v)) return v.map((x) => roundDeep(x, dp));
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = roundDeep(v[k], dp); return o; }
  return v;
}

export function compute() {
  const out = {};
  for (const [name, over] of Object.entries(COMPOSE_CASES)) {
    const r = composeSong(P(over));
    out[name] = {
      hash: fnv1a(enc.encode(JSON.stringify(roundDeep(r)))),
      notes: r.notes.length,
      scheduled: r.scheduled.length,
      cues: r.displayCues.length,
      songEnd: +r.songEnd.toFixed(6),
      seed: r.seed,
    };
  }
  return out;
}

if (RECORD) {
  test("record composer golden", async () => recordGolden("composer", compute()));
} else {
  test("composeSong is deterministic", () => eq(compute(), compute()));
  test("composeSong matches golden", async () => eq(compute(), await loadGolden("composer")));
}
