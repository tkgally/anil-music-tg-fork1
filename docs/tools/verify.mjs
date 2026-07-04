#!/usr/bin/env node
/* ---------------------------------------------------------------------
   verify.mjs — objective listening test for the studio prototypes.

   Loads a prototype's index.html from file:// in headless Chromium
   (the same way a downloaded copy runs), presses Play, records the
   final mix for N seconds, and reports metrics that map onto the
   "good background music" requirements:

     rmsDb            average loudness of the mix (dBFS)
     levelSpreadDb    p95−p5 spread of 1-second loudness windows —
                      how much the music pumps/jumps around
     centroidHz       average spectral centroid — where the energy sits
     pctAbove2k/5k    fraction of energy in the upper registers
     onsetsPerMin     sharp-attack events per minute — "pluckiness"
     silenceGapSec    longest near-silent gap (music shouldn't vanish)
     ctx/consoleErrors sanity: audio graph actually running, no errors

   Usage:
     node tools/verify.mjs <prototype-dir> [seconds] [screenshot.png]

   Prototypes cooperate by exposing:  window.__studio = { ctx, tap }
   where `tap` is the last AudioNode before ctx.destination.
   Requires the globally-installed playwright (npm root -g).
--------------------------------------------------------------------- */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const globalRoot = execSync('npm root -g').toString().trim();
const { chromium } = require(path.join(globalRoot, 'playwright'));

const dir = process.argv[2];
const seconds = Number(process.argv[3] || 25);
const shot = process.argv[4] || null;
if (!dir) { console.error('usage: node tools/verify.mjs <prototype-dir> [seconds] [screenshot.png]'); process.exit(2); }
const html = fs.statSync(dir).isDirectory() ? path.join(dir, 'index.html') : dir;
const url = 'file://' + path.resolve(html);

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

await page.goto(url);
await page.waitForTimeout(600);

// Press play: the conventional hook first, else the visible play button.
const started = await page.evaluate(() => {
  const s = window.__studio;
  if (s && typeof s.play === 'function') { s.play(); return 'api'; }
  return null;
});
if (!started) {
  const btn = page.locator('[data-play], #play, button:has-text("play"), button:has-text("Play")').first();
  await btn.click({ timeout: 5000 });
}
await page.waitForTimeout(1500);

const metrics = await page.evaluate(async (secs) => {
  const s = window.__studio;
  if (!s || !s.ctx || !s.tap) return { error: 'window.__studio = { ctx, tap } not exposed' };
  const ctx = s.ctx;
  if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) {} }
  const t0 = ctx.currentTime;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  s.tap.connect(analyser);

  const proc = ctx.createScriptProcessor(2048, 2, 1);
  const sink = ctx.createGain(); sink.gain.value = 0;
  s.tap.connect(proc); proc.connect(sink); sink.connect(ctx.destination);

  const blockE = [];    // per-block (≈46 ms) mean-square energy
  let peak = 0;
  proc.onaudioprocess = (e) => {
    let sum = 0, n = 0;
    for (let ch = 0; ch < e.inputBuffer.numberOfChannels; ch++) {
      const d = e.inputBuffer.getChannelData(ch);
      for (let i = 0; i < d.length; i += 2) { const v = d[i]; sum += v * v; n++; const a = Math.abs(v); if (a > peak) peak = a; }
    }
    blockE.push(sum / Math.max(1, n));
  };

  // spectral frames every ~120 ms
  const freqs = new Float32Array(analyser.frequencyBinCount);
  const nyquist = ctx.sampleRate / 2;
  let centW = 0, centWF = 0, eTot = 0, e2k = 0, e5k = 0, frames = 0;
  const spec = setInterval(() => {
    analyser.getFloatFrequencyData(freqs);
    for (let i = 1; i < freqs.length; i++) {
      const db = freqs[i];
      if (!isFinite(db) || db < -110) continue;
      const m = Math.pow(10, db / 20);
      const f = (i / freqs.length) * nyquist;
      centW += m; centWF += m * f;
      const p = m * m;
      eTot += p; if (f > 2000) e2k += p; if (f > 5000) e5k += p;
    }
    frames++;
  }, 120);

  await new Promise(r => setTimeout(r, secs * 1000));
  clearInterval(spec);
  proc.onaudioprocess = null;
  try { s.tap.disconnect(analyser); s.tap.disconnect(proc); } catch (e) {}

  // ---- reduce ----
  const srBlocks = ctx.sampleRate / 2048;               // blocks per second
  const perSec = [];
  for (let i = 0; i + srBlocks <= blockE.length; i += srBlocks) {
    let sum = 0, n = 0;
    for (let j = Math.floor(i); j < Math.floor(i + srBlocks); j++) { sum += blockE[j]; n++; }
    perSec.push(sum / Math.max(1, n));
  }
  const db = x => 10 * Math.log10(Math.max(1e-12, x));
  const secDb = perSec.map(db).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  const meanE = blockE.reduce((a, b) => a + b, 0) / Math.max(1, blockE.length);

  // onsets: block energy jumps over the trailing 0.4 s median, refractory 180 ms.
  // strong (≥6 dB above the bed) = attention-grabbing; soft (≥3 dB) = audible motion.
  let onsets = 0, softOnsets = 0, last = -1, lastSoft = -1;
  const win = Math.round(0.4 * srBlocks);
  for (let i = win; i < blockE.length; i++) {
    const prev = blockE.slice(i - win, i).sort((a, b) => a - b);
    const base = prev[Math.floor(prev.length / 2)];
    const dt = 2048 / ctx.sampleRate;
    if (blockE[i] > base * 4 && blockE[i] > 1e-7 && (i - last) * dt > 0.18) { onsets++; last = i; }
    if (blockE[i] > base * 2 && blockE[i] > 1e-7 && (i - lastSoft) * dt > 0.18) { softOnsets++; lastSoft = i; }
  }

  // longest near-silent gap (1 s windows under −55 dBFS)
  let gap = 0, run = 0;
  for (const e of perSec) { if (db(e) < -55) { run++; gap = Math.max(gap, run); } else run = 0; }

  return {
    sampleRate: ctx.sampleRate,
    ctxState: ctx.state,
    ctxAdvanced: +(ctx.currentTime - t0).toFixed(1),
    rmsDb: +db(meanE).toFixed(1),
    peak: +peak.toFixed(3),
    levelSpreadDb: +(q(secDb, 0.95) - q(secDb, 0.05)).toFixed(1),
    centroidHz: centW > 0 ? Math.round(centWF / centW) : null,
    pctAbove2k: eTot > 0 ? +(100 * e2k / eTot).toFixed(1) : null,
    pctAbove5k: eTot > 0 ? +(100 * e5k / eTot).toFixed(1) : null,
    onsetsPerMin: +(onsets / (secs / 60)).toFixed(1),
    softOnsetsPerMin: +(softOnsets / (secs / 60)).toFixed(1),
    silenceGapSec: gap,
    specFrames: frames,
  };
}, seconds);

if (shot) await page.screenshot({ path: shot, fullPage: false });
await browser.close();

const report = { dir: path.resolve(dir), seconds, consoleErrors, ...metrics };
console.log(JSON.stringify(report, null, 2));
if (metrics.error || consoleErrors.length || metrics.ctxState !== 'running' || (metrics.ctxAdvanced ?? 0) < seconds * 0.8) {
  process.exit(1);
}
