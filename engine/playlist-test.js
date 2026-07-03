// The day's playlist: (name, date) -> the same 12 songs, forever. The
// derivation is frozen (v2) — the golden playlist pins it — and diversity
// is guaranteed by construction, so the quota tests below must always hold.
import { test, assert, eq } from "./testkit.js";
import { playlistFor, identityHues, normalizeName, dateCode, hashStr, PLAYLIST_SIZE } from "./playlist.js";
import { wordsToCode, unpackCode, MINOR_MODES, ENSEMBLES } from "./songcode.js";

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

test("playlist: diversity quotas hold for every name/date", () => {
  for (const who of ["anil", "maya", "kiran", "zoe", "ravi", "lena"]) {
    for (const date of ["260703", "260819", "271225"]) {
      const pl = playlistFor(who, date);
      const tag = `${who}/${date}`;
      eq(new Set(pl.map((s) => s.params.leadTimbre)).size, 12, tag + ": 12 distinct leads");
      assert(new Set(pl.map((s) => s.params.mode)).size >= 4, tag + ": >=4 modes");
      assert(pl.some((s) => MINOR_MODES.has(s.params.mode)), tag + ": a minor-family color");
      eq(new Set(pl.map((s) => s.ensemble)).size, ENSEMBLES.length, tag + ": every ensemble");
      assert(pl.filter((s) => s.params.meter !== "4/4").length >= 2, tag + ": >=2 non-4/4");
      assert(pl.some((s) => s.params.mix.perc === 0), tag + ": a drumless song");
      for (let i = 1; i < pl.length; i++) {
        assert(unpackCode(pl[i - 1].code).key % 12 !== unpackCode(pl[i].code).key % 12, tag + ` #${i} repeats key`);
      }
    }
  }
});

test("playlist: FROZEN v2 — anil/260703 opens with the same song forever", () => {
  eq(playlistFor("anil", "260703")[0].title, "canoe brook ochre tango");
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
