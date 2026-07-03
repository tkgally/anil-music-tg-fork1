// The word list is FROZEN: a URL is a song forever, so any edit to
// wordlist.js is a breaking change. The checksum test enforces that.
import { test, assert, eq } from "./testkit.js";
import { WORDS, WORD_INDEX } from "./wordlist.js";
import { hashStr } from "./playlist.js";

test("wordlist: exactly 1024 words (10 bits each)", () => {
  eq(WORDS.length, 1024);
});

test("wordlist: all lowercase 3-8 letters, unique", () => {
  const seen = new Set();
  for (const w of WORDS) {
    assert(/^[a-z]{3,8}$/.test(w), `bad word: ${JSON.stringify(w)}`);
    assert(!seen.has(w), `duplicate: ${w}`);
    seen.add(w);
  }
});

test("wordlist: sorted, and the index round-trips", () => {
  for (let i = 1; i < WORDS.length; i++) assert(WORDS[i - 1] < WORDS[i], `not sorted at ${i}`);
  for (let i = 0; i < WORDS.length; i += 41) eq(WORD_INDEX.get(WORDS[i]), i);
});

test("wordlist: FROZEN — checksum pinned forever (v1)", () => {
  eq(hashStr(WORDS.join(",")), 938528263155222,
    "wordlist.js changed! It is frozen forever: existing URLs would decode to different songs.");
});

test("wordlist: the flagship words exist", () => {
  for (const w of ["happy", "silver", "context", "imagine"]) assert(WORD_INDEX.has(w), w);
});
