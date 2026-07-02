/* ---------------------------------------------------------------------
   Visualization — draw one frame of the piano-roll + waveform. React calls
   this each rAF with the current playback time. `notes` is never mutated.
--------------------------------------------------------------------- */
const VOICE_COLORS = {
  lead: '#ffb84d', counter: '#4dd6c1', pad: 'rgba(110,140,255,0.45)',
  arp: '#b18cff', bass: '#ff6f61', perc: '#8a93a6',
};
let _waveArr = null;

export function fitCanvas(canvas) {
  const cx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.floor(r.width * dpr);
  canvas.height = Math.floor(r.height * dpr);
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return cx;
}

export function drawViz(canvas, cx, state) {
  const { notes = [], now = 0, analyser = null, playing = false } = state || {};
  const r = canvas.getBoundingClientRect();
  const W = r.width, H = r.height;
  cx.clearRect(0, 0, W, H);

  // waveform backdrop (from a live analyser on the <audio> element)
  if (analyser && playing) {
    if (!_waveArr || _waveArr.length !== analyser.fftSize) _waveArr = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(_waveArr);
    cx.beginPath();
    for (let i = 0; i < _waveArr.length; i++) {
      const x = (i / _waveArr.length) * W;
      const y = H / 2 + ((_waveArr[i] - 128) / 128) * H * 0.4;
      i === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y);
    }
    cx.strokeStyle = 'rgba(255,255,255,0.06)';
    cx.lineWidth = 1.4;
    cx.stroke();
  }

  const pxPerSec = W / 15.3;
  const playheadX = W * 0.72;
  const midiToY = m => H - ((m - 26) / 70) * (H - 24) - 12;

  for (const n of notes) {
    const x = playheadX + (n.t - now) * pxPerSec;
    if (n.voice === 'perc') {
      if (x < -6 || x > W + 6) continue;
      const y = H - 8 - (n.type === 'kick' ? 0 : n.type === 'snare' ? 6 : 11);
      cx.fillStyle = n.type === 'kick' ? 'rgba(255,111,97,0.7)' : 'rgba(160,170,190,0.5)';
      cx.fillRect(x - 1.5, y, 3, 3);
      continue;
    }
    const w = Math.max(2.5, n.dur * pxPerSec - 1.5);
    if (x + w < 0 || x > W) continue;
    const y = midiToY(n.midi);
    const active = now >= n.t && now <= n.t + n.dur;
    const h = n.voice === 'pad' ? 3 : 5;
    cx.fillStyle = VOICE_COLORS[n.voice] || '#fff';
    cx.globalAlpha = active ? 1 : (n.t > now ? 0.35 : 0.55);
    if (active && n.voice !== 'pad') { cx.shadowColor = VOICE_COLORS[n.voice]; cx.shadowBlur = 9; }
    cx.fillRect(x, y - h / 2, w, h);
    cx.shadowBlur = 0;
    cx.globalAlpha = 1;
  }

  if (playing) {
    cx.fillStyle = 'rgba(255,255,255,0.12)';
    cx.fillRect(playheadX, 0, 1, H);
  }
}

// Pick the key/chord/section readout active at time `now`.
export function cueAt(displayCues, now) {
  if (!displayCues || !displayCues.length) return { key: '—', chord: '—', section: '—' };
  let cur = displayCues[0];
  for (const c of displayCues) { if (c.t <= now) cur = c; else break; }
  return cur;
}
