/* ---------------------------------------------------------------------
   01 · Tides — main.js
   State, UI wiring, presets, hash/localStorage persistence, the
   waterline visualization and the status line. Audio lives in audio.js.
--------------------------------------------------------------------- */
'use strict';

/* ----- state ----- */
function todaySeed() {
  const d = new Date();
  return (d.getFullYear() % 100) * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

const DEFAULTS = {
  seed: todaySeed(), volume: 70, preset: '',
  depth: 55, swell: 50, tide: 40, drift: 45, texture: 25, glints: 15,
  root: 9, mode: 'dorian', seventh: 40, sus: true, quartal: true, ji: true,
  voices: 5, detune: 6, glide: 2, width: 70,
  lfoa: 26, lfob: 41, lfoc: 63, foamhz: 800, voicemask: false,
  mixsub: 70, mixbed: 100, mixfoam: 100, mixglints: 100,
  mutesub: false, mutebed: false, mutefoam: false, muteglints: false,
  rsize: 3.5, rmix: 50,
};

/* short keys for the hash */
const HKEYS = {
  seed:'seed', volume:'vol', preset:'pr', depth:'de', swell:'sw', tide:'ti',
  drift:'dr', texture:'tx', glints:'gl', root:'rt', mode:'md', seventh:'s7',
  sus:'su', quartal:'qu', ji:'ji', voices:'nv', detune:'dt', glide:'gd',
  width:'wd', lfoa:'la', lfob:'lb', lfoc:'lc', foamhz:'fh', voicemask:'vm',
  mixsub:'ms', mixbed:'mb', mixfoam:'mf', mixglints:'mg',
  mutesub:'xs', mutebed:'xb', mutefoam:'xf', muteglints:'xg',
  rsize:'rs', rmix:'rm',
};
const BOOLS = ['sus','quartal','ji','voicemask','mutesub','mutebed','mutefoam','muteglints'];
const LSKEY = 'proto-01-tides';

const PRESETS = {
  still: { swell: 25, tide: 20, drift: 20, texture: 12, glints: 0 },
  open:  { swell: 75, tide: 55, texture: 45, glints: 10 },
  kelp:  { mode: 'aeolian', depth: 30, drift: 35, glints: 8 },
  first: { mode: 'lydian', depth: 70, swell: 40, glints: 25 },
};
const PRESET_FIELDS = ['depth','swell','tide','drift','texture','glints','root','mode'];

let S = Object.assign({}, DEFAULTS);

/* ----- persistence ----- */
function serialize() {
  const parts = ['v=1'];
  for (const k in HKEYS) {
    let v = S[k];
    if (k !== 'seed' && String(v) === String(DEFAULTS[k])) continue;
    if (BOOLS.includes(k)) v = v ? 1 : 0;
    parts.push(HKEYS[k] + '=' + encodeURIComponent(v));
  }
  return parts.join('&');
}

function deserialize(str, into) {
  const rev = {};
  for (const k in HKEYS) rev[HKEYS[k]] = k;
  for (const pair of str.replace(/^#/, '').split('&')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const k = rev[pair.slice(0, i)];
    if (!k) continue;
    let v = decodeURIComponent(pair.slice(i + 1));
    if (BOOLS.includes(k)) into[k] = v === '1' || v === 'true';
    else if (k === 'mode' || k === 'preset') into[k] = v;
    else { v = Number(v); if (isFinite(v)) into[k] = v; }
  }
}

function validate(s) {
  const num = (k, lo, hi) => { s[k] = clamp(Number(s[k]) || 0, lo, hi); };
  num('volume', 0, 100); num('depth', 0, 100); num('swell', 0, 100);
  num('tide', 0, 100); num('drift', 0, 100); num('texture', 0, 100);
  num('glints', 0, 100); num('root', 0, 11); num('seventh', 0, 100);
  num('voices', 3, 7); num('detune', 0, 14); num('glide', 1, 12);
  num('width', 0, 100); num('lfoa', 8, 120); num('lfob', 8, 120);
  num('lfoc', 8, 120); num('foamhz', 300, 2000);
  num('mixsub', 0, 100); num('mixbed', 0, 100); num('mixfoam', 0, 100);
  num('mixglints', 0, 100); num('rsize', 2, 5); num('rmix', 0, 100);
  s.seed = Math.max(0, Math.floor(Number(s.seed) || todaySeed()));
  s.voices = Math.round(s.voices); s.root = Math.round(s.root);
  if (!MODES[s.mode]) s.mode = 'dorian';
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const str = serialize();
    try { history.replaceState(null, '', '#' + str); } catch (e) {}
    try { localStorage.setItem(LSKEY, str); } catch (e) {}
  }, 150);
}

function load() {
  let src = null;
  if (location.hash.length > 2) src = location.hash;
  else { try { src = localStorage.getItem(LSKEY); } catch (e) {} }
  if (src) deserialize(src, S);
  validate(S);
}

/* ----- UI wiring ----- */
const $ = id => document.getElementById(id);
const NOTE_OPTIONS = NOTE_NAMES;

const FMT = {
  glide: v => v.toFixed(1) + ' s', detune: v => v.toFixed(1) + ' ¢',
  lfoa: v => v + ' s', lfob: v => v + ' s', lfoc: v => v + ' s',
  foamhz: v => v + ' Hz', rsize: v => v.toFixed(1) + ' s',
};
const SLIDERS = ['volume','depth','swell','tide','drift','texture','glints','seventh',
                 'voices','detune','glide','width','lfoa','lfob','lfoc','foamhz',
                 'mixsub','mixbed','mixfoam','mixglints','rsize','rmix'];
const CHECKS = ['sus','quartal','ji','voicemask','mutesub','mutebed','mutefoam','muteglints'];

function refreshUI() {
  for (const k of SLIDERS) {
    const el = $(k); if (!el) continue;
    el.value = S[k];
    const out = $(k + '-out');
    if (out) out.textContent = FMT[k] ? FMT[k](S[k]) : String(S[k]);
  }
  for (const k of CHECKS) { const el = $(k); if (el) el.checked = !!S[k]; }
  $('seed').value = S.seed;
  $('root').value = S.root;
  $('mode').value = S.mode;
  document.querySelectorAll('#presets .chip').forEach(ch =>
    ch.classList.toggle('on', ch.dataset.preset === S.preset));
}

function changed(fromPreset) {
  if (!fromPreset) { S.preset = ''; refreshChips(); }
  validate(S);
  Tides.applyParams(S);
  save();
}
function refreshChips() {
  document.querySelectorAll('#presets .chip').forEach(ch =>
    ch.classList.toggle('on', ch.dataset.preset === S.preset));
}

function wire() {
  const rootSel = $('root');
  NOTE_OPTIONS.forEach((n, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = n;
    rootSel.appendChild(o);
  });

  for (const k of SLIDERS) {
    const el = $(k); if (!el) continue;
    el.addEventListener('input', () => {
      S[k] = Number(el.value);
      const out = $(k + '-out');
      if (out) out.textContent = FMT[k] ? FMT[k](S[k]) : String(S[k]);
      changed(false);
    });
  }
  for (const k of CHECKS) {
    const el = $(k); if (!el) continue;
    el.addEventListener('change', () => { S[k] = el.checked; changed(false); });
  }
  rootSel.addEventListener('change', () => { S.root = Number(rootSel.value); changed(false); });
  $('mode').addEventListener('change', () => { S.mode = $('mode').value; changed(false); });
  $('seed').addEventListener('change', () => { S.seed = Math.max(0, Math.floor(Number($('seed').value) || 0)); changed(false); });

  $('reroll').addEventListener('click', () => {
    const r = new RNG((Date.now() ^ (performance.now() * 1000)) >>> 0);
    S.seed = r.int(1, 999999);
    $('seed').value = S.seed;
    changed(false);
  });
  $('reset').addEventListener('click', () => {
    S = Object.assign({}, DEFAULTS, { seed: todaySeed() });
    try { localStorage.removeItem(LSKEY); } catch (e) {}
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    refreshUI();
    Tides.applyParams(S);
  });

  document.querySelectorAll('#presets .chip').forEach(ch => {
    ch.addEventListener('click', () => {
      const p = PRESETS[ch.dataset.preset];
      for (const f of PRESET_FIELDS) S[f] = DEFAULTS[f];
      Object.assign(S, p);
      S.preset = ch.dataset.preset;
      refreshUI();
      changed(true);
    });
  });

  /* transport */
  const playBtn = $('play');
  playBtn.addEventListener('click', toggle);
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space') return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (t !== playBtn && tag === 'BUTTON') return;
    e.preventDefault();
    toggle();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) Tides.tick();
  });
}

function toggle() {
  if (Tides.playing) Tides.pause(); else Tides.play();
  const on = Tides.playing;
  $('play').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('icon-play').style.display = on ? 'none' : '';
  $('icon-pause').style.display = on ? '' : 'none';
  updateStatus();
}

/* ----- status line + clock (1x per second) ----- */
const BLOCKS = ['▁','▂','▃','▄','▅','▆','▇'];
function meterChar(v) { return BLOCKS[clamp(Math.round((v + 1) / 2 * 6), 0, 6)]; }

function updateStatus() {
  const el = $('status');
  const secs = Math.floor(Tides.elapsed());
  $('clock').textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  if (!Tides.everPlayed) { el.textContent = 'press play — the tide is out'; return; }
  const chord = Tides.chordName + ' (' + Tides.modeName + ')';
  if (!Tides.playing) { el.textContent = 'paused · ' + chord; return; }
  const d = Tides.nextDriftIn();
  const meter = meterChar(Tides.lfoValue('A')) + meterChar(Tides.lfoValue('B')) + meterChar(Tides.lfoValue('C'));
  el.textContent = chord + ' · next drift ' + (d == null ? '—' : Math.max(0, Math.round(d)) + ' s') + ' · tide ' + meter;
}
setInterval(() => { if (!document.hidden) updateStatus(); }, 1000);

/* ----- waterline visualization ----- */
const canvas = $('viz');
const cx2d = canvas.getContext('2d');
let vizW = 0, vizH = 0;

function sizeCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  vizW = canvas.clientWidth; vizH = canvas.clientHeight;
  canvas.width = Math.round(vizW * dpr);
  canvas.height = Math.round(vizH * dpr);
  cx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => { sizeCanvas(); drawViz(true); });

const RIBBONS = [
  { key: 'A', color: 'rgba(79,184,168,0.45)', cycles: 1.6, base: 0.40 },
  { key: 'B', color: 'rgba(79,184,168,0.28)', cycles: 1.1, base: 0.52 },
  { key: 'C', color: 'rgba(120,170,200,0.20)', cycles: 0.8, base: 0.64 },
];

function drawViz(force) {
  if (document.hidden) return;
  const now = Tides.ctx ? Tides.ctx.currentTime : 0;
  cx2d.clearRect(0, 0, vizW, vizH);
  const sw = S.swell / 100;
  for (const r of RIBBONS) {
    const L = Tides.lfo[r.key];
    const phase = L ? (L.phase + L.f * (now - L.t0)) : 0;
    const v = Math.sin(2 * Math.PI * phase);
    const centerY = vizH * r.base - v * vizH * 0.10 * (0.35 + sw);
    const amp = (3 + 14 * sw) * (0.6 + 0.4 * Math.cos(2 * Math.PI * phase));
    cx2d.beginPath();
    for (let x = 0; x <= vizW; x += 4) {
      const y = centerY + amp * Math.sin(2 * Math.PI * (x / vizW * r.cycles + phase));
      if (x === 0) cx2d.moveTo(x, y); else cx2d.lineTo(x, y);
    }
    cx2d.strokeStyle = r.color;
    cx2d.lineWidth = 1.5;
    cx2d.stroke();
  }
  /* glints: a soft radial glow, x = pitch */
  for (const m of Tides.glintMarks) {
    const age = now - m.t;
    if (age < 0 || age > m.dur) continue;
    const a = age < 1.2 ? age / 1.2 : 1 - (age - 1.2) / (m.dur - 1.2);
    const x = vizW * clamp(Math.log(m.f / 146) / Math.log(588 / 146), 0, 1);
    const y = vizH * 0.30;
    const grad = cx2d.createRadialGradient(x, y, 0, x, y, 16);
    grad.addColorStop(0, 'rgba(190,235,225,' + (0.55 * a).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(190,235,225,0)');
    cx2d.fillStyle = grad;
    cx2d.beginPath(); cx2d.arc(x, y, 16, 0, Math.PI * 2); cx2d.fill();
  }
}

let lastDraw = 0;
function vizLoop(ts) {
  requestAnimationFrame(vizLoop);
  if (document.hidden) return;
  if (!Tides.playing && ts - lastDraw < 1000) return;   // freeze-ish when paused
  if (ts - lastDraw < 40) return;                       // ~25 fps is plenty
  lastDraw = ts;
  drawViz();
}

/* ----- boot ----- */
load();
wire();
refreshUI();
Tides.applyParams(S);
sizeCanvas();
drawViz(true);
requestAnimationFrame(vizLoop);
