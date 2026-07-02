/* ---------------------------------------------------------------------
   Encoding — the rendered buffer -> a downloadable/playable Blob.
     mp3   : lamejs (pure JS, faster than realtime)
     webm  : MediaRecorder, audio/webm;codecs=opus (real-time)
     opus  : MediaRecorder, prefers audio/ogg;codecs=opus, else webm/opus
   Falls back to lossless WAV if the browser can't encode the choice.
--------------------------------------------------------------------- */
function bufferToInt16Channels(buffer) {
  const out = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const f = buffer.getChannelData(c);
    const i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    out.push(i16);
  }
  return out;
}

export function bufferToWav(buffer) {
  const numCh = buffer.numberOfChannels, sr = buffer.sampleRate, frames = buffer.length;
  const chs = bufferToInt16Channels(buffer);
  const blockAlign = numCh * 2, dataLen = frames * blockAlign;
  const ab = new ArrayBuffer(44 + dataLen), dv = new DataView(ab);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); wr(8, 'WAVE');
  wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, numCh, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * blockAlign, true); dv.setUint16(32, blockAlign, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < frames; i++) for (let c = 0; c < numCh; c++) { dv.setInt16(o, chs[c][i], true); o += 2; }
  return new Blob([ab], { type: 'audio/wav' });
}

async function encodeMP3(buffer, kbps, onProgress) {
  const lame = await import('https://esm.sh/@breezystack/lamejs@1.2.7');
  const Mp3Encoder = lame.Mp3Encoder || (lame.default && lame.default.Mp3Encoder);
  const numCh = Math.min(2, buffer.numberOfChannels);
  const enc = new Mp3Encoder(numCh, buffer.sampleRate, kbps || 192);
  const chs = bufferToInt16Channels(buffer);
  const left = chs[0], right = numCh > 1 ? chs[1] : chs[0];
  const block = 1152, data = [];
  for (let i = 0; i < left.length; i += block) {
    const l = left.subarray(i, i + block), r = right.subarray(i, i + block);
    const mp3 = numCh > 1 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
    if (mp3.length) data.push(new Uint8Array(mp3));
    if (i % (block * 64) === 0) onProgress(i / left.length);
  }
  const flush = enc.flush();
  if (flush.length) data.push(new Uint8Array(flush));
  return { blob: new Blob(data, { type: 'audio/mpeg' }), mime: 'audio/mpeg', ext: 'mp3' };
}

async function encodeMediaRecorder(buffer, preferOgg, onProgress) {
  const candidates = preferOgg
    ? ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus']
    : ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus'];
  const mime = globalThis.MediaRecorder ? candidates.find(m => MediaRecorder.isTypeSupported(m)) : null;
  if (!mime) {
    // no Opus encoder here -> lossless WAV so playback + download still work
    return { blob: bufferToWav(buffer), mime: 'audio/wav', ext: 'wav', fallback: true };
  }
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const ac = new AC();
  try { await ac.resume(); } catch (_) {}   // needs to actually run (real-time capture)
  const src = ac.createBufferSource(); src.buffer = buffer;
  const dest = ac.createMediaStreamDestination(); src.connect(dest);
  const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: opusBitrate(buffer.sampleRate) });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { rec.onstop = res; });
  const ended = new Promise(res => { src.onended = res; });
  let raf = 0; const dur = buffer.duration || 1;
  const tick = () => { onProgress(Math.min(0.999, ac.currentTime / dur)); raf = requestAnimationFrame(tick); };
  rec.start(250); src.start(); tick();
  await ended;
  rec.stop(); await stopped;
  if (raf) cancelAnimationFrame(raf);
  try { await ac.close(); } catch (_) {}
  const actual = (chunks[0] && chunks[0].type) || mime;
  const container = actual.split(';')[0];
  return { blob: new Blob(chunks, { type: container }), mime: actual, ext: container.includes('ogg') ? 'opus' : 'webm' };
}

/* ---- WebCodecs Opus (faster than realtime) ----
   AudioEncoder produces raw Opus packets; we mux them into Ogg (.opus) or
   WebM ourselves. Validated with decodeAudioData; any failure falls back to
   the MediaRecorder path (real-time) so encoding always succeeds. ---- */
function hasWebCodecsOpus() {
  return typeof globalThis.AudioEncoder === 'function' && typeof globalThis.AudioData === 'function';
}

// Bitrate follows the source bandwidth: a 24 kHz (Fast) render has nothing above
// ~12 kHz, so a lower bitrate is transparent (and the file is ~40% smaller).
function opusBitrate(sr) { return sr >= 40000 ? 160000 : sr >= 30000 ? 128000 : 96000; }
function mp3Kbps(sr) { return sr >= 40000 ? 192 : sr >= 30000 ? 160 : 128; }

// Ogg CRC-32 (poly 0x04c11db7, MSB-first, init 0, no final xor)
const _oggCrcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    t[i] = r >>> 0;
  }
  return t;
})();
function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ _oggCrcTable[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}
function oggPage(serial, seq, headerType, granule, packets) {
  const lacing = [];
  for (const pkt of packets) { let n = pkt.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); }
  let bodyLen = 0; for (const p of packets) bodyLen += p.length;
  const page = new Uint8Array(27 + lacing.length + bodyLen);
  const dv = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);           // 'OggS'
  page[5] = headerType;
  dv.setUint32(6, granule >>> 0, true);
  dv.setUint32(10, Math.floor(granule / 4294967296) >>> 0, true);
  dv.setUint32(14, serial >>> 0, true);
  dv.setUint32(18, seq >>> 0, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) { page.set(p, o); o += p.length; }
  dv.setUint32(22, oggCrc(page), true);
  return page;
}
function muxOgg(chunks, channels, preSkip, inRate) {
  const head = new Uint8Array(19);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);   // 'OpusHead'
  head[8] = 1; head[9] = channels;
  new DataView(head.buffer).setUint16(10, preSkip, true);
  new DataView(head.buffer).setUint32(12, inRate, true);
  const vendor = new TextEncoder().encode('fable');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0);   // 'OpusTags'
  const tdv = new DataView(tags.buffer);
  tdv.setUint32(8, vendor.length, true); tags.set(vendor, 12);
  tdv.setUint32(12 + vendor.length, 0, true);
  const serial = (Math.random() * 0x7fffffff) | 0;
  const pages = [oggPage(serial, 0, 0x02, 0, [head]), oggPage(serial, 1, 0x00, 0, [tags])];
  let seq = 2, granule = 0;
  const per = 50;
  for (let i = 0; i < chunks.length; i += per) {
    const group = chunks.slice(i, i + per);
    for (const c of group) granule += c.samples;
    const last = i + per >= chunks.length;
    pages.push(oggPage(serial, seq++, last ? 0x04 : 0x00, granule, group.map(c => c.data)));
  }
  let total = 0; for (const p of pages) total += p.length;
  const out = new Uint8Array(total); let o = 0;
  for (const p of pages) { out.set(p, o); o += p.length; }
  return new Blob([out], { type: 'audio/ogg' });
}
async function validateDecodable(blob) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const ac = new AC();
  try { await ac.decodeAudioData((await blob.arrayBuffer()).slice(0)); }
  finally { try { await ac.close(); } catch (_) {} }
}
async function encodeOpusWC(buffer, container, onProgress) {
  const sr = buffer.sampleRate;
  const channels = Math.min(2, buffer.numberOfChannels);
  let muxer = null, oggChunks = null;
  if (container === 'webm') {
    const mod = await import('https://esm.sh/webm-muxer@5.0.3');
    const Muxer = mod.Muxer, ArrayBufferTarget = mod.ArrayBufferTarget;
    muxer = new Muxer({ target: new ArrayBufferTarget(), audio: { codec: 'A_OPUS', sampleRate: sr, numberOfChannels: channels } });
  } else { oggChunks = []; }

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (muxer) { muxer.addAudioChunk(chunk, meta); }
      else { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); oggChunks.push({ data: d, samples: Math.round((chunk.duration || 20000) * 48000 / 1e6) }); }
    },
    error: (e) => { throw e; },
  });
  encoder.configure({ codec: 'opus', sampleRate: sr, numberOfChannels: channels, bitrate: opusBitrate(sr) });

  const frame = 8192;
  const ch0 = buffer.getChannelData(0), ch1 = channels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0);
  for (let i = 0; i < buffer.length; i += frame) {
    const n = Math.min(frame, buffer.length - i);
    const data = new Float32Array(n * channels);
    data.set(ch0.subarray(i, i + n), 0);
    if (channels > 1) data.set(ch1.subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round(i / sr * 1e6), data });
    encoder.encode(ad); ad.close();
    if (i % (frame * 16) === 0) onProgress(0.6 * i / buffer.length);
  }
  await encoder.flush();
  encoder.close();
  onProgress(0.8);

  let blob, mime, ext;
  if (muxer) { muxer.finalize(); blob = new Blob([muxer.target.buffer], { type: 'audio/webm' }); mime = 'audio/webm'; ext = 'webm'; }
  else { blob = muxOgg(oggChunks, channels, 312, sr); mime = 'audio/ogg'; ext = 'opus'; }
  await validateDecodable(blob);   // throws -> caller falls back to MediaRecorder
  return { blob, mime, ext };
}

// Stereo WASM LAME (faster than the pure-JS lamejs). Streaming API: encode()
// returns a view into wasm memory that's invalidated on the next call, so copy.
async function encodeMP3Wasm(buffer, kbps, onProgress) {
  const mod = await import('https://esm.sh/wasm-media-encoders@0.7.0');
  const enc = await mod.createMp3Encoder();
  const channels = Math.min(2, buffer.numberOfChannels);
  enc.configure({ sampleRate: buffer.sampleRate, channels, bitrate: kbps || 192 });
  const ch0 = buffer.getChannelData(0);
  const ch1 = channels > 1 ? buffer.getChannelData(1) : ch0;
  const block = 1152 * 16, parts = [];
  for (let i = 0; i < buffer.length; i += block) {
    const n = Math.min(block, buffer.length - i);
    const chunk = enc.encode(channels > 1 ? [ch0.subarray(i, i + n), ch1.subarray(i, i + n)] : [ch0.subarray(i, i + n)]);
    if (chunk.length) parts.push(chunk.slice());
    if (i % (block * 8) === 0) onProgress(i / buffer.length);
  }
  const tail = enc.finalize();
  if (tail.length) parts.push(tail.slice());
  return { blob: new Blob(parts, { type: 'audio/mpeg' }), mime: 'audio/mpeg', ext: 'mp3' };
}

export async function encodeSong(audioBuffer, format, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  onProgress({ phase: 'encoding', progress: 0 });
  const P = (p) => onProgress({ phase: 'encoding', progress: p });
  let out;
  try {
    if (format === 'mp3') {
      const kbps = mp3Kbps(audioBuffer.sampleRate);
      try { out = await encodeMP3Wasm(audioBuffer, kbps, P); }             // WASM LAME (stereo, fast)
      catch (e) { console.warn('[fable] wasm mp3 failed, using lamejs:', e); out = await encodeMP3(audioBuffer, kbps, P); }
    } else {
      const container = format === 'webm' ? 'webm' : 'ogg';
      if (hasWebCodecsOpus()) {
        try { out = await encodeOpusWC(audioBuffer, container, P); }
        catch (e) { console.warn('[fable] WebCodecs opus failed, using MediaRecorder:', e); out = null; }
      }
      if (!out) out = await encodeMediaRecorder(audioBuffer, container === 'ogg', P);
    }
  } catch (err) {
    console.warn('[fable] encode failed, falling back to WAV:', err);
    out = { blob: bufferToWav(audioBuffer), mime: 'audio/wav', ext: 'wav', fallback: true };
  }
  onProgress({ phase: 'encoding', progress: 1 });
  const url = URL.createObjectURL(out.blob);
  return { blob: out.blob, url, mime: out.mime, ext: out.ext, size: out.blob.size, fallback: !!out.fallback };
}
