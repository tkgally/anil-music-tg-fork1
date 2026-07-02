// Visualization is DATA-only here: cueAt (which display cue is active at t).
// No canvas / pixels. Runs in Node or the browser.
import { test, eq, assert } from "./testkit.js";
import { cueAt } from "./engine.js";

const cues = [
  { t: 0, key: "C", chord: "i", section: "Intro" },
  { t: 4, key: "C", chord: "iv", section: "A" },
  { t: 8, key: "G", chord: "V", section: "B" },
];

test("cueAt: empty input yields placeholders", () => {
  eq(cueAt([], 3), { key: "—", chord: "—", section: "—" });
  eq(cueAt(null, 3), { key: "—", chord: "—", section: "—" });
});

test("cueAt: before the first cue returns the first cue", () => {
  eq(cueAt(cues, -1), cues[0]);
});

test("cueAt: picks the latest cue whose t <= now", () => {
  eq(cueAt(cues, 0), cues[0]);
  eq(cueAt(cues, 3.999), cues[0]);
  eq(cueAt(cues, 4), cues[1]);
  eq(cueAt(cues, 7.5), cues[1]);
  eq(cueAt(cues, 8), cues[2]);
  eq(cueAt(cues, 999), cues[2]);
});

test("cueAt: boundaries are inclusive on the lower edge", () => {
  assert(cueAt(cues, 4).section === "A");
  assert(cueAt(cues, 8).section === "B");
});
