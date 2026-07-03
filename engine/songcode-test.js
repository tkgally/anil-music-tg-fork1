// Song codes: 4 words = 40 bits = a complete song. The layout and the
// derived-knob recipe are frozen (v1) — the golden decode pins them.
import { test, assert, eq } from "./testkit.js";
import {
  packCode, unpackCode, codeToWords, wordsToCode, decodeSong, makeCode,
  CODE_SPACE, CODE_MODES, TEMPOS, AVAILABLE_LEADS, AVAILABLE_PADS,
} from "./songcode.js";
import { RNG } from "./rng.js";

test("songcode: pack/unpack round-trips every field", () => {
  const rng = new RNG(7);
  for (let i = 0; i < 500; i++) {
    const f = {
      seed: rng.int(0, 16383), tempo: rng.int(0, 15), key: rng.int(0, 15), mode: rng.int(0, 3),
      lead: rng.int(0, 15), pad: rng.int(0, 7), arc: rng.int(0, 3), energy: rng.int(0, 7),
      length: rng.int(0, 3), swing: rng.int(0, 3),
    };
    const code = packCode(f);
    assert(code >= 0 && code < CODE_SPACE && Number.isSafeInteger(code), "code in range");
    eq(unpackCode(code), f);
  }
});

test("songcode: words <-> code round-trips; case/separator tolerant", () => {
  const rng = new RNG(11);
  for (let i = 0; i < 500; i++) {
    const code = Math.floor(rng.next() * CODE_SPACE);
    const words = codeToWords(code);
    eq(words.length, 4);
    eq(wordsToCode(words), code);
    eq(wordsToCode(words.join("-")), code);
    eq(wordsToCode(words.join(" ").toUpperCase()), code);
  }
});

test("songcode: junk input decodes to null, not a crash", () => {
  eq(wordsToCode("not-a-real-word-list"), null);
  eq(wordsToCode("happy-silver-context"), null);
  eq(decodeSong("xyzzy-plugh-foo-bar"), null);
  eq(decodeSong(""), null);
});

test("songcode: decode is deterministic and good-mood tuned", () => {
  const rng = new RNG(23);
  for (let i = 0; i < 300; i++) {
    const s = decodeSong(makeCode(rng));
    const P = s.params;
    assert(P.tempo >= 96 && P.tempo <= 141, "tempo " + P.tempo);
    assert(CODE_MODES.includes(P.mode), "mode " + P.mode);
    assert(P.shadow <= 0.25 && P.wanderlust <= 0.35 && P.gravity >= 0.55, "good-mood knobs");
    assert(AVAILABLE_LEADS.has(P.leadTimbre), "lead " + P.leadTimbre);
    assert(AVAILABLE_PADS.has(P.padTimbre), "pad " + P.padTimbre);
    assert([120, 150, 180, 210].includes(P.lengthSec), "length");
    assert(P.seed >= 1, "seed");
    eq(decodeSong(s.code).params, P, "same code -> identical params");
  }
});

test("songcode: reserved lead/pad slots fall back to shipped voices", () => {
  // slots 8..15 name instruments that are not merged yet; decode must still
  // produce a playable timbre today
  for (let lead = 8; lead < 16; lead++) {
    const code = packCode({ seed: 1, tempo: 0, key: 0, mode: 0, lead, pad: 5, arc: 0, energy: 4, length: 2, swing: 0 });
    const P = decodeSong(code).params;
    assert(AVAILABLE_LEADS.has(P.leadTimbre), `slot ${lead} -> ${P.leadTimbre}`);
    assert(AVAILABLE_PADS.has(P.padTimbre), `pad slot 5 -> ${P.padTimbre}`);
  }
});

test("songcode: FROZEN — the flagship URL decodes to the same song forever", () => {
  const s = decodeSong("happy-silver-context-imagine");
  eq(s.code, 424973357488);
  eq(s.title, "happy silver context imagine");
  const P = s.params;
  eq([P.tempo, P.key, P.mode, P.leadTimbre, P.padTimbre, P.arc, P.lengthSec, P.seed],
    [129, "8", "lydian", "breath", "halo", "ascent", 180, 3709263555]);
  // pin the derived knobs too (1e-12 rounding for cross-engine ULP safety)
  const r = (x) => Math.round(x * 1e12) / 1e12;
  eq(r(P.complexity), 0.460226142164, "complexity");
  eq(r(P.shadow), 0.076759984856, "shadow");
});

test("songcode: makeCode honors the requested energy", () => {
  const rng = new RNG(5);
  for (let e = 0; e <= 7; e++) eq(unpackCode(makeCode(rng, { energy: e })).energy, e);
});
