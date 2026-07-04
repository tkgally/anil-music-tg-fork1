/* ---------------------------------------------------------------------
   05 · Deep Work — main.js
   State, UI wiring, presets, pinning, hash/localStorage persistence,
   the piano-roll ribbon, the status line and the session ring.
   Audio lives in engine.js; bar generation in composer.js.
--------------------------------------------------------------------- */
'use strict';

/* ----- state ----- */
function todaySeed() {
  const d = new Date();
  return (d.getFullYear() % 100) * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

const DEFAULTS = {
  seed: todaySeed(), volume: 70, preset: '',
  presence: 25, tempo: 84, motion: 35, session: 'endless',
  root: 2, mode: 'dorian', meter: '4/4',
  complexity: 35, gravity: 60, shadow: 0, fractality: 85, hocket: 15,
  humanity: 50, wanderlust: 0, swing: 0,
  /* pinnable mixes default to what Presence derives at 25 (only used when pinned) */
  mixlead: 29, mixcounter: 15, mixpad: 74, mixbass: 60, mixperc: 50,
  leadTimbre: 'breath', padTimbre: 'warm',
  reverb: 50, echo: 11, masterlp: 3600,
  focuspulse: 'off',
  pinned: [],
};

/* short keys for the hash */
const HKEYS = {
  seed: 'seed', volume: 'vol', preset: 'pr',
  presence: 'ps', tempo: 'tp', motion: 'mn', session: 'ss',
  root: 'rt', mode: 'md', meter: 'mt',
  complexity: 'cx', gravity: 'gv', shadow: 'sh', fractality: 'fr', hocket: 'hk',
  humanity: 'hu', wanderlust: 'wl', swing: 'sw',
  mixlead: 'ml', mixcounter: 'mc', mixpad: 'mp', mixbass: 'mb', mixperc: 'mk',
  leadTimbre: 'lt', padTimbre: 'pt',
  reverb: 'rv', echo: 'ec', masterlp: 'lp',
  focuspulse: 'fp', pinned: 'pin',
};
const STRINGS = ['preset', 'session', 'mode', 'meter', 'leadTimbre', 'padTimbre', 'focuspulse'];
const LSKEY = 'proto-05-deepwork';

const MOODS = {
  calm:   { root: 9, mode: 'aeolian' },
  warm:   { root: 2, mode: 'dorian' },
  bright: { root: 5, mode: 'lydian' },
  open:   { root: 7, mode: 'mixolydian' },
};

const PRESETS = {
  deep: { presence: 15, motion: 25, root: 9, mode: 'aeolian' },
  desk: {},
  lift: { presence: 45, tempo: 92, root: 5, mode: 'lydian' },
  song: { presence: 85, motion: 60 },                    // "Daysong mode", for A/B
};
const PRESET_FIELDS = ['presence', 'motion', 'tempo', 'root', 'mode'];

/* which Advanced controls pin which Presence-driven params */
const PIN_OF = { mixlead: 'lead', mixcounter: 'counter', mixpad: 'pad', echo: 'echo', masterlp: 'lowpass' };

let S = Object.assign({}, DEFAULTS, { pinned: [] });

/* ----- persistence ----- */
function serialize() {
  const parts = ['v=1'];
  for (const k in HKEYS) {
    let v = S[k];
    if (k === 'pinned') {
      if (!v.length) continue;
      v = v.join('.');
    } else if (k !== 'seed' && String(v) === String(DEFAULTS[k])) continue;
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
    if (k === 'pinned') into.pinned = v ? v.split('.') : [];
    else if (STRINGS.includes(k)) into[k] = v;
    else { v = Number(v); if (isFinite(v)) into[k] = v; }
  }
}

function validate(s) {
  const num = (k, lo, hi) => { s[k] = clamp(Math.round(Number(s[k]) || 0), lo, hi); };
  num('volume', 0, 100); num('presence', 0, 100); num('tempo', 56, 110);
  num('motion', 0, 100); num('root', 0, 11);
  num('complexity', 0, 100); num('gravity', 0, 100); num('shadow', 0, 100);
  num('fractality', 0, 100); num('hocket', 0, 100); num('humanity', 0, 100);
  num('wanderlust', 0, 100); num('swing', 0, 100);
  num('mixlead', 0, 100); num('mixcounter', 0, 100); num('mixpad', 0, 100);
  num('mixbass', 0, 100); num('mixperc', 0, 100);
  num('reverb', 0, 100); num('echo', 0, 40); num('masterlp', 1200, 12000);
  s.seed = Math.max(0, Math.floor(Number(s.seed) || todaySeed()));
  if (!MODES[s.mode]) s.mode = 'dorian';
  if (!METERS[s.meter]) s.meter = '4/4';
  if (!['endless', '25', '50'].includes(s.session)) s.session = 'endless';
  if (!['breath', 'glass', 'keys'].includes(s.leadTimbre)) s.leadTimbre = 'breath';
  if (!['warm', 'halo', 'strings'].includes(s.padTimbre)) s.padTimbre = 'warm';
  if (!['off', 'gentle', 'stronger'].includes(s.focuspulse)) s.focuspulse = 'off';
  const okPins = ['lead', 'counter', 'pad', 'echo', 'lowpass'];
  s.pinned = (Array.isArray(s.pinned) ? s.pinned : []).filter(p => okPins.includes(p));
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
  tempo: v => v + ' bpm', swing: v => v + ' %', echo: v => v + ' %',
  masterlp: v => (v >= 10000 ? (v / 1000).toFixed(1) + ' kHz' : v + ' Hz'),
};
const SLIDERS = ['volume', 'presence', 'tempo', 'motion',
                 'complexity', 'gravity', 'shadow', 'fractality', 'hocket',
                 'humanity', 'wanderlust', 'swing',
                 'mixlead', 'mixcounter', 'mixpad', 'mixbass', 'mixperc',
                 'reverb', 'echo', 'masterlp'];
const SELECTS = ['root', 'mode', 'meter', 'leadTimbre', 'padTimbre'];
const SELECT_IDS = { root: 'root', mode: 'mode', meter: 'meter', leadTimbre: 'leadtimbre', padTimbre: 'padtimbre' };

function setOut(k, v) {
  const out = $(k + '-out');
  if (out) out.textContent = FMT[k] ? FMT[k](v) : String(v);
}

function currentMood() {
  for (const m in MOODS) {
    if (MOODS[m].root === S.root && MOODS[m].mode === S.mode) return m;
  }
  return '';
}

function refreshUI() {
  for (const k of SLIDERS) {
    const el = $(k); if (!el) continue;
    el.value = S[k];
    setOut(k, S[k]);
  }
  for (const k of SELECTS) $(SELECT_IDS[k]).value = String(S[k]);
  $('seed').value = S.seed;
  const mood = currentMood();
  document.querySelectorAll('#presets .chip').forEach(ch =>
    ch.classList.toggle('on', ch.dataset.preset === S.preset));
  document.querySelectorAll('#moods .chip').forEach(ch =>
    ch.classList.toggle('on', ch.dataset.mood === mood));
  document.querySelectorAll('#sessions .chip').forEach(ch =>
    ch.classList.toggle('on', ch.dataset.ss === S.session));
  document.querySelectorAll('#focus .chip').forEach(ch =>
    ch.classList.toggle('on', ch.dataset.fp === S.focuspulse));
  refreshPins();
  trackAutoControls();
  renderPmap();
}

/* pin markers + presence-driven slider tracking */
function refreshPins() {
  for (const id in PIN_OF) {
    const btn = $('pin-' + id);
    if (btn) btn.hidden = S.pinned.indexOf(PIN_OF[id]) < 0;
  }
}

function trackAutoControls() {
  const D = DW.derive(S);
  const auto = {
    mixlead: Math.round(D.mixLead * 100),
    mixcounter: Math.round(D.mixCounter * 100),
    mixpad: Math.round(D.mixPad * 100),
    echo: Math.round(D.echoWet * 100),
    masterlp: D.masterLP,
  };
  for (const id in auto) {
    if (S.pinned.indexOf(PIN_OF[id]) >= 0) continue;      // pinned: user value stays
    const el = $(id);
    el.value = auto[id];
    setOut(id, auto[id]);
  }
}

/* the live mapping table: what Presence is deriving right now */
function renderPmap() {
  const D = DW.derive(S);
  const pin = k => S.pinned.indexOf(k) >= 0;
  const pct = x => Math.round(x * 100) + ' %';
  const opsTxt = ['exact / transpose', '+ embellish', '+ invert / retro'][D.ops];
  const rows = [
    ['mix.lead', pct(D.mixLead), pin('lead')],
    ['mix.counter', pct(D.mixCounter), pin('counter')],
    ['mix.pad', pct(D.mixPad), pin('pad')],
    ['mix.arp', pct(D.mixArp), null],
    ['melody ceiling', 'MIDI ' + D.melCeil + ' (' + NOTE_NAMES[D.melCeil % 12] + (Math.floor(D.melCeil / 12) - 1) + ')', null],
    ['melody density', '×' + D.melDensity.toFixed(2), null],
    ['perc energy gate', D.percGate.toFixed(2), null],
    ['energy ceiling', D.energyCeil.toFixed(2), null],
    ['master lowpass', D.masterLP + ' Hz', pin('lowpass')],
    ['echo wet', pct(D.echoWet), pin('echo')],
    ['develop ops', opsTxt, null],
  ];
  let html = '<tr><th>engine param</th><th>now</th><th>driven by</th></tr>';
  for (const [name, val, pinned] of rows) {
    const src = pinned === null ? 'presence' : (pinned ? '⚲ pinned' : 'presence');
    html += '<tr' + (pinned ? ' class="pinned"' : '') + '><td>' + name +
      '</td><td class="val">' + val + '</td><td class="src">' + src + '</td></tr>';
  }
  $('pmap').innerHTML = html;
}

function changed(fromPreset) {
  if (!fromPreset) {
    S.preset = '';
    document.querySelectorAll('#presets .chip').forEach(ch => ch.classList.remove('on'));
  }
  validate(S);
  DW.applyParams(S);
  trackAutoControls();
  renderPmap();
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
      setOut(k, S[k]);
      if (PIN_OF[k] && S.pinned.indexOf(PIN_OF[k]) < 0) {   // touching pins it
        S.pinned.push(PIN_OF[k]);
        refreshPins();
      }
      changed(false);
    });
  }
  for (const k of SELECTS) {
    const el = $(SELECT_IDS[k]);
    el.addEventListener('change', () => {
      S[k] = (k === 'root') ? Number(el.value) : el.value;
      refreshUI();
      changed(false);
    });
  }
  $('seed').addEventListener('change', () => {
    S.seed = Math.max(0, Math.floor(Number($('seed').value) || 0));
    changed(false);
  });
  $('reroll').addEventListener('click', () => {
    const r = new RNG((Date.now() ^ (performance.now() * 1000)) >>> 0);
    S.seed = r.int(1, 999999);
    $('seed').value = S.seed;
    changed(false);
  });
  $('reset').addEventListener('click', () => {
    S = Object.assign({}, DEFAULTS, { seed: todaySeed(), pinned: [] });
    try { localStorage.removeItem(LSKEY); } catch (e) {}
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    refreshUI();
    DW.applyParams(S);
  });

  /* pin release buttons */
  for (const id in PIN_OF) {
    const btn = $('pin-' + id);
    if (!btn) continue;
    btn.addEventListener('click', () => {
      S.pinned = S.pinned.filter(p => p !== PIN_OF[id]);
      refreshPins();
      changed(false);
    });
  }

  /* chip groups */
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
  document.querySelectorAll('#moods .chip').forEach(ch => {
    ch.addEventListener('click', () => {
      Object.assign(S, MOODS[ch.dataset.mood]);
      refreshUI();
      changed(false);
    });
  });
  document.querySelectorAll('#sessions .chip').forEach(ch => {
    ch.addEventListener('click', () => {
      S.session = ch.dataset.ss;
      refreshUI();
      changed(false);
      updateStatus();
    });
  });
  document.querySelectorAll('#focus .chip').forEach(ch => {
    ch.addEventListener('click', () => {
      S.focuspulse = ch.dataset.fp;
      refreshUI();
      changed(false);
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

  DW.onstate = refreshTransport;
}

function toggle() {
  if (DW.playing) DW.pause(); else DW.play();
}

function refreshTransport() {
  const on = DW.playing;
  $('play').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('icon-play').style.display = on ? 'none' : '';
  $('icon-pause').style.display = on ? '' : 'none';
  updateStatus();
  drawViz();
}

/* ----- display state: consume engine cues at their audible time ----- */
function currentCue() {
  const now = DW.ctx ? DW.ctx.currentTime : 0;
  let cur = null;
  for (const c of DW.cues) {
    if (c.t <= now) cur = c; else break;
  }
  return cur;
}

/* ----- status line + clock + session ring (1x per second) ----- */
const EGLYPH = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'];

function fmtTime(secs) {
  secs = Math.max(0, Math.floor(secs));
  return Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
}

function updateStatus() {
  const el = $('status');
  $('clock').textContent = fmtTime(DW.elapsed());

  /* session ring */
  const prog = DW.sessionProgress();
  const ring = $('ring');
  if (prog == null) {
    ring.style.display = 'none';
  } else {
    ring.style.display = '';
    $('ring-fg').style.strokeDashoffset = (197.9 * (1 - prog)).toFixed(1);
  }

  if (!DW.everPlayed) {
    el.textContent = 'press play — Daysong, folded into the background';
    return;
  }
  if (DW.sessionDone) {
    el.textContent = 'session complete — nice work';
    return;
  }
  const cue = currentCue();
  if (!cue) { el.textContent = DW.playing ? 'listening…' : 'paused'; return; }
  const parts = [cue.section, cue.key, cue.chord,
    'energy ' + EGLYPH[clamp(Math.floor(cue.energy * EGLYPH.length), 0, EGLYPH.length - 1)]];
  if (cue.pivot) parts.push('pivot breath');
  else parts.push('next section ' + cue.barsLeft + (cue.barsLeft === 1 ? ' bar' : ' bars'));
  const pend = DW.pendingHomeLabel();
  if (pend) parts.push('→ ' + pend + ' next section');
  if (DW.sessionLen != null && DW.started) {
    const left = DW.sessionLen - (DW.ctx.currentTime - DW.sessionStartT);
    parts.push(DW.sessionEnding ? 'winding down' : fmtTime(left) + ' left');
  }
  if (!DW.playing) parts.unshift('paused');
  el.textContent = parts.join(' · ');
}
setInterval(() => { if (!document.hidden) { updateStatus(); trackAutoControls(); renderPmap(); } }, 1000);

/* ----- piano-roll ribbon: notes scroll left, playhead fixed ----- */
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

const PAST = 31, FUT = 14;                       // ~45 s window
const VOICE_STYLE = {
  pad:     { color: '111,159,216', alpha: 0.10, h: 9 },
  lead:    { color: '159,196,239', alpha: 0.75, h: 3 },
  counter: { color: '130,160,195', alpha: 0.40, h: 2.5 },
  bass:    { color: '96,140,185',  alpha: 0.45, h: 4.5 },
  arp:     { color: '140,180,220', alpha: 0.45, h: 2 },
};

function midiY(m) {
  const lo = 30, hi = 84;
  return 10 + (1 - clamp((m - lo) / (hi - lo), 0, 1)) * (vizH - 36);
}

function drawViz() {
  if (!vizW) return;
  cx2d.clearRect(0, 0, vizW, vizH);
  const now = DW.ctx ? DW.ctx.currentTime : 0;
  const x0 = now - PAST;
  const px = vizW / (PAST + FUT);
  const playX = PAST * px;

  /* energy curve: faint area along the bottom */
  if (DW.cues.length) {
    cx2d.beginPath();
    cx2d.moveTo(0, vizH);
    for (const c of DW.cues) {
      const x = (c.t - x0) * px;
      const y = vizH - 4 - c.energy * (vizH * 0.28);
      cx2d.lineTo(clamp(x, 0, vizW), y);
      cx2d.lineTo(clamp(x + c.barDur * px, 0, vizW), y);
    }
    cx2d.lineTo(vizW, vizH);
    cx2d.closePath();
    cx2d.fillStyle = 'rgba(111,159,216,0.07)';
    cx2d.fill();
  }

  /* notes */
  for (const n of DW.vizNotes) {
    const st = VOICE_STYLE[n.voice];
    const x = (n.t - x0) * px;
    if (n.voice === 'perc') {
      if (x < -2 || x > vizW) continue;
      cx2d.fillStyle = 'rgba(125,135,148,0.35)';
      cx2d.fillRect(x, vizH - 12, 1.5, 6);
      continue;
    }
    if (!st) continue;
    const w = Math.max(2, n.dur * px - 1);
    if (x + w < 0 || x > vizW) continue;
    const y = midiY(n.midi);
    const past = n.t + n.dur < now;
    cx2d.fillStyle = 'rgba(' + st.color + ',' + (st.alpha * (past ? 0.7 : 1)).toFixed(3) + ')';
    cx2d.beginPath();
    cx2d.roundRect(x, y - st.h / 2, w, st.h, st.h / 2);
    cx2d.fill();
  }

  /* playhead */
  cx2d.fillStyle = 'rgba(111,159,216,0.22)';
  cx2d.fillRect(playX, 6, 1, vizH - 12);
}

let lastDraw = 0;
function vizLoop(ts) {
  requestAnimationFrame(vizLoop);
  if (document.hidden) return;
  if (!DW.playing) return;                       // freeze on pause
  if (ts - lastDraw < 50) return;                // ~20 fps is plenty
  lastDraw = ts;
  drawViz();
}

/* ----- boot ----- */
load();
wire();
refreshUI();
DW.applyParams(S);
sizeCanvas();
drawViz();
requestAnimationFrame(vizLoop);
