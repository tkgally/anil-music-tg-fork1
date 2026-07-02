// auditionVoice golden-master: perceptual fingerprint (within tolerance) of
// every roster voice in isolation — so any per-voice synthesis regression is
// caught at full sensitivity. Browser only. Record via tests.html?record.
import { test, RECORD, recordGolden, loadGolden } from "./testkit.js";
import { auditionVoice } from "./engine.js";
import { AUDITION_SPECS } from "./fixtures.js";
import { fingerprint, closeFP } from "./audio-fp.js";

const key = (s) => s.voice + (s.timbre ? "/" + s.timbre : "");

export async function compute() {
  const out = {};
  for (const spec of AUDITION_SPECS) {
    const buf = await auditionVoice(spec, { sampleRate: 44100 });
    out[key(spec)] = fingerprint(buf);
  }
  return out;
}

if (RECORD) {
  test.browser("record voices golden", async () => recordGolden("voices", await compute()));
} else {
  test.browser("auditionVoice is deterministic (within tolerance)", async () => {
    const a = fingerprint(await auditionVoice({ voice: "lead", timbre: "pluck" }, { sampleRate: 44100 }));
    const b = fingerprint(await auditionVoice({ voice: "lead", timbre: "pluck" }, { sampleRate: 44100 }));
    const e = closeFP(a, b);
    if (e.length) throw new Error(e.join("; "));
  });
  test.browser("auditionVoice matches golden (all 21 voices)", async () => {
    const got = await compute(), want = await loadGolden("voices");
    for (const k of Object.keys(want)) {
      const errs = closeFP(got[k], want[k]);
      if (errs.length) throw new Error(`${k}: ${errs.join("; ")}`);
    }
  });
}
