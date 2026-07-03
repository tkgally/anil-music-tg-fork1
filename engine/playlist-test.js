// The day's playlist: (name, date) -> the same 12 songs, forever. The
// derivation is frozen (v1) — the golden playlist pins it.
import { test, assert, eq } from "./testkit.js";
import { playlistFor, identityHues, normalizeName, dateCode, hashStr, PLAYLIST_SIZE } from "./playlist.js";
import { wordsToCode, unpackCode } from "./songcode.js";

test("playlist: deterministic — same name+date is the same 12 songs", () => {
  const a = playlistFor("anil", "260703");
  const b = playlistFor("Anil!", "260703");         // normalization folds these
  eq(a.length, PLAYLIST_SIZE);
  eq(a.map((s) => s.code), b.map((s) => s.code));
});

test("playlist: different name or date -> a different day", () => {
  const a = playlistFor("anil", "260703").map((s) => s.code).join();
  assert(a !== playlistFor("maya", "260703").map((s) => s.code).join(), "name changes the list");
  assert(a !== playlistFor("anil", "260704").map((s) => s.code).join(), "date changes the list");
});

test("playlist: every entry is a valid, playable 4-word song", () => {
  for (const s of playlistFor("maya", "271225")) {
    eq(wordsToCode(s.words), s.code);
    assert(s.params && s.params.tempo >= 96, s.title);
    assert(/^[a-z]+( [a-z]+){3}$/.test(s.title), "title is 4 words");
  }
});

test("playlist: variety — no lead or key repeats back-to-back", () => {
  for (const who of ["anil", "maya", "kiran", "zoe"]) {
    const pl = playlistFor(who, "260703");
    for (let i = 1; i < pl.length; i++) {
      const a = unpackCode(pl[i - 1].code), b = unpackCode(pl[i].code);
      assert(a.lead !== b.lead || a.key !== b.key, `${who} #${i} repeats lead+key`);
    }
  }
});

test("playlist: FROZEN — anil/260703 opens with the same song forever", () => {
  eq(playlistFor("anil", "260703")[0].title, "dash easy hummus legend");
});

test("identity: hues deterministic, in range, and separated", () => {
  const { bgHue, accentHue } = identityHues("anil", "260703");
  eq(identityHues("anil", "260703"), { bgHue, accentHue });
  assert(bgHue >= 0 && bgHue < 360 && accentHue >= 0 && accentHue < 360, "range");
  for (const [n, d] of [["anil", "260703"], ["maya", "991231"], ["q", "260101"]]) {
    const h = identityHues(n, d);
    const dist = Math.min((h.bgHue - h.accentHue + 360) % 360, (h.accentHue - h.bgHue + 360) % 360);
    assert(dist >= 50, `${n}/${d} accent too close to bg (${dist})`);
  }
});

test("normalizeName: folds case/punctuation, never empty", () => {
  eq(normalizeName("  Añil G.! "), "ailg");                // strips non a-z0-9
  eq(normalizeName("Maya"), "maya");
  eq(normalizeName("???"), "friend");
  eq(normalizeName(""), "friend");
});

test("dateCode: YYMMDD from a local date", () => {
  eq(dateCode(new Date(2026, 6, 3)), "260703");
  eq(dateCode(new Date(2031, 11, 31)), "311231");
  eq(dateCode(new Date(2027, 0, 1)), "270101");
});

test("hashStr: stable and well-spread", () => {
  eq(hashStr("anil/260703"), hashStr("anil/260703"));
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(hashStr("k" + i) % 4096);
  assert(seen.size > 1400, "poor spread: " + seen.size);   // ~ birthday expectation ≈ 1580
});
