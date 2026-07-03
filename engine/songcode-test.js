// Song codes v2: 4 words = 40 bits = a complete song. The layout and the
// derived-knob recipe are frozen (v2) — the golden decode pins them.
import { test, assert, eq } from "./testkit.js";
import {
  packCode, unpackCode, codeToWords, wordsToCode, decodeSong, makeCode,
  CODE_SPACE, CODE_MODES, ENSEMBLES, AVAILABLE_LEADS, AVAILABLE_PADS,
} from "./songcode.js";
import { RNG } from "./rng.js";

test("songcode: pack/unpack round-trips every field", () => {
  const rng = new RNG(7);
  for (let i = 0; i < 500; i++) {
    const f = {
      seed: rng.int(0, 4095), tempo: rng.int(0, 15), key: rng.int(0, 15), mode: rng.int(0, 7),
      lead: rng.int(0, 15), pad: rng.int(0, 7), arc: rng.int(0, 7), energy: rng.int(0, 7),
      length: rng.int(0, 3), ensemble: rng.int(0, 3),
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

test("songcode: decode is deterministic and stays in the palette", () => {
  const rng = new RNG(23);
  for (let i = 0; i < 300; i++) {
    const s = decodeSong(makeCode(rng));
    const P = s.params;
    assert(P.tempo >= 96 && P.tempo <= 141, "tempo " + P.tempo);
    assert(CODE_MODES.includes(P.mode), "mode " + P.mode);
    assert(P.shadow <= 0.45 && P.wanderlust <= 0.60 && P.gravity >= 0.45, "knob ranges");
    assert(AVAILABLE_LEADS.has(P.leadTimbre), "lead " + P.leadTimbre);
    assert(AVAILABLE_PADS.has(P.padTimbre), "pad " + P.padTimbre);
    assert([120, 150, 180, 210].includes(P.lengthSec), "length");
    assert(ENSEMBLES.includes(s.ensemble), "ensemble");
    assert(P.reverbSec >= 2.2 && P.reverbSec <= 4.4, "room size");
    assert(P.percKit === "kit" || P.percKit === "tabla", "kit");
    assert(P.seed >= 1, "seed");
    eq(decodeSong(s.code).params, P, "same code -> identical params");
  }
});

test("songcode: the ensemble field actually changes the band", () => {
  const base = { seed: 77, tempo: 8, key: 0, mode: 0, lead: 0, pad: 0, arc: 0, energy: 4, length: 2 };
  const by = {};
  for (let e = 0; e < 4; e++) by[ENSEMBLES[e]] = decodeSong(packCode({ ...base, ensemble: e })).params.mix;
  eq(by.unplugged.perc, 0, "unplugged has no drums");
  eq(by.chamber.perc, 0, "chamber has no drums");
  eq(by.chamber.arp, 0, "chamber has no arp");
  assert(by.groove.perc >= 0.6, "groove is perc-forward");
  assert(by.full.perc > 0, "full has drums");
});

test("songcode: retired/alias lead slots still decode to playable voices", () => {
  // slot 3 is retired pluck -> keys; 14/15 alias glass/breath
  for (const lead of [3, 14, 15]) {
    const code = packCode({ seed: 1, tempo: 0, key: 0, mode: 0, lead, pad: 6, arc: 0, energy: 4, length: 2, ensemble: 0 });
    const P = decodeSong(code).params;
    assert(AVAILABLE_LEADS.has(P.leadTimbre), `slot ${lead} -> ${P.leadTimbre}`);
    assert(AVAILABLE_PADS.has(P.padTimbre), `pad slot 6 -> ${P.padTimbre}`);
  }
  eq(decodeSong(packCode({ seed: 1, tempo: 0, key: 0, mode: 0, lead: 3, pad: 0, arc: 0, energy: 4, length: 2, ensemble: 0 })).params.leadTimbre, "keys");
});

test("songcode: FROZEN v2 — the flagship URL decodes to the same song forever", () => {
  const s = decodeSong("happy-silver-context-imagine");
  eq(s.code, 424973357488);
  eq(s.title, "happy silver context imagine");
  eq(s.ensemble, "unplugged");
  const P = s.params;
  eq([P.tempo, P.key, P.mode, P.leadTimbre, P.padTimbre, P.arc, P.meter, P.lengthSec, P.percKit, P.seed],
    [135, "2", "mixolydian", "keys", "warm", "twinPeaks", "4/4", 180, "kit", 3709263555]);
  // pin the derived knobs too (1e-12 rounding for cross-engine ULP safety)
  const r = (x) => Math.round(x * 1e12) / 1e12;
  eq(r(P.complexity), 0.395339213246, "complexity");
  eq(r(P.shadow), 0.083449981071, "shadow");
  eq(r(P.reverbSec), 3.427098912233, "reverbSec");
});

test("songcode: makeCode honors forced fields", () => {
  const rng = new RNG(5);
  for (let e = 0; e <= 7; e++) eq(unpackCode(makeCode(rng, { energy: e })).energy, e);
  const f = unpackCode(makeCode(rng, { lead: 9, mode: 6, ensemble: 3, tempo: 2, key: 11 }));
  eq([f.lead, f.mode, f.ensemble, f.tempo, f.key], [9, 6, 3, 2, 11]);
});
