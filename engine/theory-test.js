// Unit tests for the music-theory tables/helpers (pure; Node or browser).
import { test, assert, eq } from "./testkit.js";
import { MODES, METERS, strengthArray, euclid, DEG_NEXT, ARCS, subdivide, NOTE_NAMES } from "./theory.js";
import { RNG } from "./rng.js";

test("NOTE_NAMES has 12 chromatic entries", () => eq(NOTE_NAMES.length, 12));

test("MODES are 7-note ascending sets rooted at 0 within an octave", () => {
  for (const [name, iv] of Object.entries(MODES)) {
    eq(iv.length, 7, name + " length");
    eq(iv[0], 0, name + " root");
    for (let i = 1; i < 7; i++) assert(iv[i] > iv[i - 1], name + " ascending");
    assert(iv[6] <= 11, name + " within octave");
  }
});

test("METER groups cover exactly `steps`", () => {
  for (const [name, m] of Object.entries(METERS)) {
    eq(m.groups.reduce((s, [, l]) => s + l, 0), m.steps, name);
  }
});

test("strengthArray: downbeat strongest, right length", () => {
  const s = strengthArray(METERS["4/4"]);
  eq(s.length, 16); eq(s[0], 3); assert(s[4] >= 1);
});

test("euclid spreads k onsets across n", () => {
  eq(euclid(4, 16), [0, 4, 8, 12]);
  eq(euclid(3, 8).length, 3);
});

test("ARCS map [0,1] -> [0,1]", () => {
  for (const [name, f] of Object.entries(ARCS)) {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const v = f(t);
      assert(v >= -0.001 && v <= 1.001, `${name}(${t}) = ${v} out of range`);
    }
  }
});

test("DEG_NEXT: 7 degrees with valid weighted targets", () => {
  eq(Object.keys(DEG_NEXT).length, 7);
  for (const d of Object.keys(DEG_NEXT)) {
    for (const [to, w] of DEG_NEXT[d]) { assert(to >= 0 && to <= 6, "target"); assert(w > 0, "weight"); }
  }
});

test("subdivide partitions sum back to len and are deterministic", () => {
  for (const len of [3, 4, 5, 6, 8, 12]) {
    eq(subdivide(new RNG(1), len, 0.8, 0).reduce((a, b) => a + b, 0), len, "len " + len);
  }
  eq(subdivide(new RNG(3), 8, 0.7, 0), subdivide(new RNG(3), 8, 0.7, 0));
});
