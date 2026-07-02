// Encoders. bufferToWav is pure (runs in Node with a fake buffer); encodeSong
// needs Web Audio / WebCodecs so it's browser-only and asserts the output is
// a decodable blob of the right duration.
import { test, assert, eq } from "./testkit.js";
import { bufferToWav, encodeSong } from "./engine.js";

// --- bufferToWav (Node + browser) ---
function fakeBuffer(chData, sr = 44100) {
  return {
    numberOfChannels: chData.length,
    sampleRate: sr,
    length: chData[0].length,
    getChannelData: (c) => chData[c],
  };
}
const u16 = (bytes, o) => bytes[o] | (bytes[o + 1] << 8);
const s16 = (bytes, o) => { const v = u16(bytes, o); return v >= 0x8000 ? v - 0x10000 : v; };
const u32 = (bytes, o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
const str = (bytes, o, n) => String.fromCharCode(...bytes.slice(o, o + n));

test("bufferToWav writes a correct 16-bit stereo PCM header", async () => {
  const L = new Float32Array([0, 1, -1, 0.5]);
  const R = new Float32Array([0, -1, 1, -0.5]);
  const blob = bufferToWav(fakeBuffer([L, R], 48000));
  const b = new Uint8Array(await blob.arrayBuffer());
  eq(str(b, 0, 4), "RIFF"); eq(str(b, 8, 4), "WAVE"); eq(str(b, 12, 4), "fmt "); eq(str(b, 36, 4), "data");
  eq(u16(b, 20), 1, "PCM tag"); eq(u16(b, 22), 2, "channels"); eq(u32(b, 24), 48000, "sampleRate");
  eq(u16(b, 32), 4, "blockAlign = ch*2"); eq(u16(b, 34), 16, "bitsPerSample");
  eq(u32(b, 40), 4 * 4, "dataLen = frames * blockAlign");
  eq(b.length, 44 + 16, "total size");
});

test("bufferToWav quantizes samples and interleaves L/R", async () => {
  const L = new Float32Array([0, 1, -1, 0.5]);
  const R = new Float32Array([0, -1, 1, -0.5]);
  const b = new Uint8Array(await bufferToWav(fakeBuffer([L, R])).arrayBuffer());
  const pcm = [];
  for (let o = 44; o < b.length; o += 2) pcm.push(s16(b, o));
  eq(pcm, [0, 0, 32767, -32768, -32768, 32767, 16383, -16384]);
});

// --- encodeSong (browser only) ---
async function sineBuffer(sec = 1, sr = 44100, freq = 220) {
  const buf = new OfflineAudioContext(2, Math.ceil(sec * sr), sr).createBuffer(2, Math.ceil(sec * sr), sr);
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = 0.2 * Math.sin(2 * Math.PI * freq * i / sr); }
  return buf;
}

for (const fmt of ["opus", "webm", "mp3"]) {
  test.browser(`encodeSong(${fmt}) -> decodable blob`, async () => {
    const buf = await sineBuffer(1);
    const out = await encodeSong(buf, fmt);
    assert(out.blob && out.size > 500, `${fmt}: implausibly small (${out.size})`);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const dec = await ac.decodeAudioData(await out.blob.arrayBuffer());
    await ac.close();
    assert(Math.abs(dec.duration - 1) < 0.25, `${fmt}: decoded duration ${dec.duration.toFixed(3)}s off`);
  });
}
