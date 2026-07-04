/* ---------------------------------------------------------------------
   03 · Pulse — main.js
   State, UI wiring, presets, hash/localStorage persistence, the
   step-ring visualization and the status line. Audio lives in
   engine.js; pattern/harmony material in theory.js.
--------------------------------------------------------------------- */
'use strict';

/* ----- state ----- */
function todaySeed() {
  const d = new Date();
  return (d.getFullYear() % 100) * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

const DEFAULTS = {
  seed: todaySeed(), volume: 70, preset: '',
  tempo: 78, energy: 40, evolve: 'steady', brightness: 45, pulse: 30,
  root: 9, mode: 'aeolian', chordset: 'dusk', chordrate: 2,
  regcenter: 60, regspan: 9, swing: 8, density: 9,
  wpitch: 50, wtoggle: 20, wrhythm: 30, freeze: false,
  canonoff: 3, canonlvl: 55, canonint: 'octave',
  mixkeys: 100, mixbass: 100, mixhaze: 100, mixtick: 100, reverb: 50,
};

/* short keys for the hash */
const HKEYS = {
  seed: 'seed', volume: 'vol', preset: 'pr',
  tempo: 'tp', energy: 'en', evolve: 'ev', brightness: 'br', pulse: 'pu',
  root: 'rt', mode: 'md', chordset: 'cs', chordrate: 'cr',
  regcenter: 'rc', regspan: 'rs', swing: 'sw', density: 'dn',
  wpitch: 'wp', wtoggle: 'wt', wrhythm: 'wr', freeze: 'fz',
  canonoff: 'co', canonlvl: 'cl', canonint: 'ci',
  mixkeys: 'mk', mixbass: 'mb', mixhaze: 'mh', mixtick: 'mt', reverb: 'rv',
};
const BOOLS = ['freeze'];
const STRINGS = ['preset', 'evolve', 'mode', 'chordset', 'canonint'];
const LSKEY = 'proto-03-pulse';

const PRESETS = {
  tape:      { tempo: 66, energy: 25, evolve: 'gentle', brightness: 30, pulse: 0 },
  clockwork: {},
  runner:    { tempo: 92, energy: 60, pulse: 55 },
  night:     { tempo: 70, energy: 30, brightness: 25, pulse: 15, root: 4, mode: 'aeolian' },
};
const PRESET_FIELDS = ['tempo', 'energy', 'evolve', 'brightness', 'pulse', 'root', 'mode'];

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
    else if (STRINGS.includes(k)) into[k] = v;
    else { v = Number(v); if (isFinite(v)) into[k] = v; }
  }
}

function validate(s) {
  const num = (k, lo, hi) => { s[k] = clamp(Number(s[k]) || 0, lo, hi); };
  num('volume', 0, 100); num('tempo', 56, 104); num('energy', 0, 100);
  num('brightness', 0, 100); num('pulse', 0, 100);
  num('root', 0, 11); num('chordrate', 1, 4);
  num('regcenter', 55, 67); num('regspan', 5, 12); num('swing', 0, 30);
  num('density', 5, 12); num('wpitch', 0, 100); num('wtoggle', 0, 100);
  num('wrhythm', 0, 100); num('canonoff', 2, 5); num('canonlvl', 0, 100);
  num('mixkeys', 0, 100); num('mixbass', 0, 100); num('mixhaze', 0, 100);
  num('mixtick', 0, 100); num('reverb', 0, 100);
  for (const k of ['tempo', 'root', 'chordrate', 'regcenter', 'regspan', 'swing',
                   'density', 'canonoff']) s[k] = Math.round(s[k]);
  s.seed = Math.max(0, Math.floor(Number(s.seed) || todaySeed()));
  if (!MODES[s.mode]) s.mode = 'aeolian';
  if (!CHORD_SETS[s.chordset]) s.chordset = 'dusk';
  if (!['off', 'gentle', 'steady', 'restless'].includes(s.evolve)) s.evolve = 'steady';
  if (!['octave', 'fifth', 'off'].includes(s.canonint)) s.canonint = 'octave';
  s.freeze = !!s.freeze;
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

const FMT = {
  tempo: v => v + ' bpm', swing: v => v + ' %',
  chordrate: v => v + (v === 1 ? ' loop' : ' loops'),
  regcenter: v => 'MIDI ' + v, regspan: v => '±' + v + ' st',
  canonoff: v => v + ' steps',
};
const SLIDERS = ['volume', 'tempo', 'energy', 'brightness', 'pulse', 'chordrate',
                 'regcenter', 'regspan', 'swing', 'density', 'wpitch', 'wtoggle',
                 'wrhythm', 'canonoff', 'canonlvl', 'mixkeys', 'mixbass', 'mixhaze',
                 'mixtick', 'reverb'];
const CHECKS = ['freeze'];

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
  $('canonint').value = S.canonint;
  document.querySelectorAll('#presets .chip').forEach(ch =>
    ch.classList.toggle('on', ch.dataset.preset === S.preset));
  document.querySelectorAll('#evolve .chip').forEach(ch =>
    ch.classList.toggle('on', ch.dataset.ev === S.evolve));
  document.querySelectorAll('#chordset .chip').forEach(ch =>
    ch.classList.toggle('on', ch.dataset.cs === S.chordset));
}

function changed(fromPreset) {
  if (!fromPreset) {
    S.preset = '';
    document.querySelectorAll('#presets .chip').forEach(ch => ch.classList.remove('on'));
  }
  validate(S);
  Pulse.applyParams(S);
  save();
}

function wire() {
  const rootSel = $('root');
  NOTE_NAMES.forEach((n, i) => {
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
  $('canonint').addEventListener('change', () => { S.canonint = $('canonint').value; changed(false); });
  $('seed').addEventListener('change', () => {
    S.seed = Math.max(0, Math.floor(Number($('seed').value) || 0));
    changed(false);
  });

  document.querySelectorAll('#evolve .chip').forEach(ch => {
    ch.addEventListener('click', () => {
      S.evolve = ch.dataset.ev;
      document.querySelectorAll('#evolve .chip').forEach(c =>
        c.classList.toggle('on', c === ch));
      changed(false);
    });
  });
  document.querySelectorAll('#chordset .chip').forEach(ch => {
    ch.addEventListener('click', () => {
      S.chordset = ch.dataset.cs;
      document.querySelectorAll('#chordset .chip').forEach(c =>
        c.classList.toggle('on', c === ch));
      changed(false);
    });
  });

  $('nudge').addEventListener('click', () => { Pulse.nudgeNow(); });

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
    Pulse.applyParams(S);
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
    if (!document.hidden) Pulse.tick();
  });
}

function toggle() {
  if (Pulse.playing) Pulse.pause(); else Pulse.play();
  const on = Pulse.playing;
  $('play').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('icon-play').style.display = on ? 'none' : '';
  $('icon-pause').style.display = on ? '' : 'none';
  updateStatus();
}

/* ----- display state: consume engine viz events at their audible time ----- */
const D = {
  pattern: null, roman: '—', rootName: '', loop: 0, age: 0,
  nextMutT: Infinity, stepDur: (60 / 78) / 2, loopStart: 0,
  evolveOff: false, frozen: false, canonoff: 3, degSpan: 5,
};
function pumpViz() {
  const now = Pulse.ctx ? Pulse.ctx.currentTime : 0;
  while (Pulse.vizEvents.length && Pulse.vizEvents[0].t <= now) {
    Object.assign(D, Pulse.vizEvents.shift());
  }
}

/* ----- status line + clock (1x per second) ----- */
function updateStatus() {
  const el = $('status');
  const secs = Math.floor(Pulse.elapsed());
  $('clock').textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  if (!Pulse.everPlayed) { el.textContent = 'press play — 16 steps, one gentle rewrite at a time'; return; }
  pumpViz();
  const chord = 'chord ' + D.roman;
  if (!Pulse.playing) {
    el.textContent = 'paused · ' + chord + ' · pattern age ' + D.age;
    return;
  }
  let mut;
  if (D.frozen) mut = 'pattern frozen';
  else if (D.evolveOff) mut = 'evolution off';
  else {
    const now = Pulse.ctx.currentTime;
    const dt = D.nextMutT - now;
    mut = isFinite(dt) ? 'mutation in ' + Math.max(0, Math.round(dt)) + ' s' : 'mutation —';
  }
  el.textContent = chord + ' · ' + mut + ' · pattern age ' + D.age + ' · loop ' + D.loop;
}
setInterval(() => { if (!document.hidden) updateStatus(); }, 1000);

/* ----- step-ring visualization ----- */
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
window.addEventListener('resize', () => { sizeCanvas(); drawViz(); });

function cellXY(i, deg) {
  const cx = vizW / 2, cy = vizH / 2;
  const R = Math.min(vizH * 0.5 - 18, 120);
  const ang = -Math.PI / 2 + (i / 16) * 2 * Math.PI;
  const r = R + (deg || 0) * 2.4;
  return [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, ang, R];
}

function drawViz() {
  if (document.hidden || !vizW) return;
  pumpViz();
  cx2d.clearRect(0, 0, vizW, vizH);
  const now = Pulse.ctx ? Pulse.ctx.currentTime : 0;
  const cx = vizW / 2, cy = vizH / 2;

  /* center: current chord, large and dim */
  cx2d.textAlign = 'center';
  cx2d.font = '600 26px system-ui, sans-serif';
  cx2d.fillStyle = 'rgba(217,160,91,0.34)';
  cx2d.fillText(D.roman, cx, cy + 2);
  cx2d.font = '500 11px system-ui, sans-serif';
  cx2d.fillStyle = 'rgba(125,135,148,0.55)';
  cx2d.fillText(D.rootName || '', cx, cy + 20);

  /* playhead: continuous sweep hand + step marker */
  let step = -1, frac = 0;
  if (Pulse.playing && D.loopStart && now >= D.loopStart) {
    const stepsIn = (now - D.loopStart) / D.stepDur;
    step = Math.floor(stepsIn) % 16;
    frac = stepsIn % 16;
  }
  if (step >= 0) {
    const ang = -Math.PI / 2 + (frac / 16) * 2 * Math.PI;
    const [, , , R] = cellXY(0, 0);
    cx2d.strokeStyle = 'rgba(217,160,91,0.13)';
    cx2d.lineWidth = 1.5;
    cx2d.beginPath();
    cx2d.moveTo(cx, cy);
    cx2d.lineTo(cx + Math.cos(ang) * (R - 20), cy + Math.sin(ang) * (R - 20));
    cx2d.stroke();
  }

  /* the 16 cells */
  const span = Math.max(3, D.degSpan);
  for (let i = 0; i < 16; i++) {
    const slot = D.pattern ? D.pattern[i] : null;
    const [x, y] = cellXY(i, slot ? slot.deg : 0);
    if (!slot) {
      cx2d.fillStyle = i === step ? 'rgba(125,135,148,0.5)' : 'rgba(125,135,148,0.22)';
      cx2d.beginPath(); cx2d.arc(x, y, 2, 0, Math.PI * 2); cx2d.fill();
      continue;
    }
    const a = 0.34 + 0.5 * clamp((slot.deg + span) / (2 * span), 0, 1);
    cx2d.fillStyle = 'rgba(217,160,91,' + a.toFixed(3) + ')';
    cx2d.beginPath(); cx2d.arc(x, y, 3 + slot.dur * 0.6, 0, Math.PI * 2); cx2d.fill();
  }

  /* canon playhead: a dim echo marker trailing behind */
  if (step >= 0 && S.canonint !== 'off') {
    const ci = (step - D.canonoff + 32) % 16;
    const cslot = D.pattern ? D.pattern[ci] : null;
    const [x, y] = cellXY(ci, cslot ? cslot.deg : 0);
    cx2d.strokeStyle = 'rgba(125,160,200,0.4)';
    cx2d.lineWidth = 1;
    cx2d.beginPath(); cx2d.arc(x, y, 7, 0, Math.PI * 2); cx2d.stroke();
  }

  /* currently-sounding cells bloom */
  for (const m of Pulse.noteMarks) {
    if (m.t > now || now > m.t + m.dur) continue;
    const k = 1 - (now - m.t) / m.dur;
    const slot = D.pattern ? D.pattern[m.step] : null;
    const [x, y] = cellXY(m.step, slot ? slot.deg : 0);
    const rad = 14;
    const grad = cx2d.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(240,196,140,' + (0.5 * k).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(240,196,140,0)');
    cx2d.fillStyle = grad;
    cx2d.beginPath(); cx2d.arc(x, y, rad, 0, Math.PI * 2); cx2d.fill();
  }

  /* mutation flash: the rewritten cell blinks white for ~1 s */
  for (const f of Pulse.flashes) {
    const age = now - f.t;
    if (age < 0 || age > 1.2) continue;
    const k = 1 - age / 1.2;
    for (const sl of [f.slot, f.slot2]) {
      if (sl == null) continue;
      const slot = D.pattern ? D.pattern[sl] : null;
      const [x, y] = cellXY(sl, slot ? slot.deg : 0);
      cx2d.strokeStyle = 'rgba(235,240,245,' + (0.85 * k).toFixed(3) + ')';
      cx2d.lineWidth = 1.5;
      cx2d.beginPath(); cx2d.arc(x, y, 6 + age * 6, 0, Math.PI * 2); cx2d.stroke();
    }
  }
}

let lastDraw = 0;
function vizLoop(ts) {
  requestAnimationFrame(vizLoop);
  if (document.hidden) return;
  if (!Pulse.playing && ts - lastDraw < 1000) return;   // freeze-ish when paused
  if (ts - lastDraw < 40) return;                       // ~25 fps is plenty
  lastDraw = ts;
  drawViz();
}

/* ----- boot ----- */
load();
wire();
refreshUI();
Pulse.applyParams(S);
sizeCanvas();
drawViz();
requestAnimationFrame(vizLoop);
