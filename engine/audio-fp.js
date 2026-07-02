// Perceptual fingerprint of an AudioBuffer for the audio golden tests.
//
// Web Audio's offline render is NOT bit-reproducible: voices routed through the
// echo/convolver path vary by ~1e-9 run-to-run (denormal echo-tail samples), so
// hashing raw samples is useless. Peak / RMS / a windowed RMS envelope are
// stable to ~1e-9, yet any real synthesis change moves them by >>1e-3.

const round = (x) => +x.toFixed(6);

export function fingerprint(buf, N = 16) {
  const ch = buf.numberOfChannels, len = buf.length, W = Math.max(1, Math.floor(len / N));
  const env = new Array(N).fill(0);
  let peak = 0, sq = 0;
  for (let c = 0; c < ch; c++) {
    const x = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const a = Math.abs(x[i]); if (a > peak) peak = a;
      const v = x[i] * x[i]; sq += v;
      env[Math.min(N - 1, (i / W) | 0)] += v;
    }
  }
  const tot = len * ch;
  return {
    shape: `${ch}x${len}@${Math.round(buf.sampleRate)}`,
    peak: round(peak),
    rms: round(Math.sqrt(sq / tot)),
    env: env.map((e) => round(Math.sqrt(e / (W * ch)))),
  };
}

// Returns a list of human-readable diffs (empty === match). tol comfortably
// clears the 6-decimal rounding (~1e-6) + render noise (~1e-9) while catching
// any audible regression.
export function closeFP(a, b, tol = 1e-4) {
  const errs = [];
  if (!a || !b) return ["missing fingerprint"];
  if (a.shape !== b.shape) errs.push(`shape ${a.shape} != ${b.shape}`);
  if (Math.abs(a.peak - b.peak) > tol) errs.push(`peak ${a.peak} vs ${b.peak}`);
  if (Math.abs(a.rms - b.rms) > tol) errs.push(`rms ${a.rms} vs ${b.rms}`);
  const n = Math.max(a.env.length, b.env.length);
  for (let i = 0; i < n; i++) {
    if (Math.abs((a.env[i] ?? 0) - (b.env[i] ?? 0)) > tol) errs.push(`env[${i}] ${a.env[i]} vs ${b.env[i]}`);
  }
  return errs;
}
