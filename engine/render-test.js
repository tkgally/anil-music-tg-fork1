// renderSong golden-master. Web Audio isn't bit-reproducible, so we compare a
// perceptual fingerprint (peak/rms/envelope) within tolerance for a single-
// segment song, a segmented (>30s) song, and a Fast render. Browser only.
// Record via tests.html?record.
import { test, RECORD, recordGolden, loadGolden } from "./testkit.js";
import { renderSong } from "./engine.js";
import { P, RENDER_CASES } from "./fixtures.js";
import { fingerprint, closeFP } from "./audio-fp.js";

export async function compute() {
  const out = {};
  for (const [name, { params, opts }] of Object.entries(RENDER_CASES)) {
    const r = await renderSong(P(params), opts);
    out[name] = { ...fingerprint(r.audioBuffer), segments: r.segments, sr: r.sampleRate, dur: +r.duration.toFixed(3) };
  }
  return out;
}

function assertClose(name, got, want) {
  const errs = closeFP(got, want);
  if (got.segments !== want.segments) errs.push(`segments ${got.segments} vs ${want.segments}`);
  if (got.sr !== want.sr) errs.push(`sr ${got.sr} vs ${want.sr}`);
  if (errs.length) throw new Error(`${name}: ${errs.join("; ")}`);
}

if (RECORD) {
  test.browser("record render golden", async () => recordGolden("render", await compute()));
} else {
  test.browser("renderSong is deterministic (within tolerance)", async () => {
    const p = P(RENDER_CASES["short-24s"].params);
    const a = fingerprint((await renderSong(p, {})).audioBuffer);
    const b = fingerprint((await renderSong(p, {})).audioBuffer);
    const e = closeFP(a, b);
    if (e.length) throw new Error(e.join("; "));
  });
  test.browser("renderSong matches golden", async () => {
    const got = await compute(), want = await loadGolden("render");
    for (const k of Object.keys(want)) assertClose(k, got[k], want[k]);
  });
}
