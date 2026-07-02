// Unit tests for the seeded RNG + math utils (pure; Node or browser).
import { test, assert, eq, close } from "./testkit.js";
import { mulberry32, noteRnd, RNG, clamp, lerp, midiToFreq } from "./rng.js";

test("mulberry32 is deterministic and in [0,1)", () => {
  const a = mulberry32(12345), b = mulberry32(12345);
  for (let i = 0; i < 5; i++) { const x = a(); assert(x >= 0 && x < 1, "out of range"); eq(x, b()); }
});

test("mulberry32 depends on the seed", () => {
  assert(mulberry32(1)() !== mulberry32(2)(), "different seeds should differ");
});

test("noteRnd is stable per (seed,t,midi) and varies with identity", () => {
  eq(noteRnd(5, 1.25, 60), noteRnd(5, 1.25, 60));
  assert(noteRnd(5, 1.25, 60) !== noteRnd(5, 1.25, 61), "midi should change it");
  assert(noteRnd(5, 1.25, 60) !== noteRnd(6, 1.25, 60), "seed should change it");
});

test("RNG helpers are deterministic", () => {
  const r = new RNG(7), r2 = new RNG(7);
  for (let i = 0; i < 4; i++) eq(r.next(), r2.next());
  eq(new RNG(1).int(3, 3), 3);
  assert([10, 20].includes(new RNG(2).pick([10, 20])));
  eq(new RNG(9).weighted([["a", 0], ["b", 1], ["c", 0]]), "b");
});

test("clamp / lerp / midiToFreq", () => {
  eq(clamp(5, 0, 3), 3); eq(clamp(-1, 0, 3), 0); eq(clamp(2, 0, 3), 2);
  eq(lerp(0, 10, 0.5), 5);
  close(midiToFreq(69), 440, 1e-9);
  close(midiToFreq(81), 880, 1e-9);
  close(midiToFreq(57), 220, 1e-9);
});
