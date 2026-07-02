/* =====================================================================
   FABLE - autonomous generative synthesizer
   Pure Web Audio. No samples, no libraries.

   ES-module port of the original synth.js. All music/composition/audio
   logic below is unchanged. The song is now rendered OFFLINE (no live
   tuning): renderSong(params) composes every bar and renders the whole
   piece into an AudioBuffer + a piano-roll JSON; encodeSong() turns the
   buffer into an opus/mp3/webm Blob; drawViz() paints one visualization
   frame from the JSON against the current playback time.
   ===================================================================== */

/* ---------------------------------------------------------------------
   Utilities
--------------------------------------------------------------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic per-note random in [0,1) from stable note identity. Used for
// the audio layer (oscillator detune) so a note gets the SAME micro-detune no
// matter which render segment/worker produces it -> seamless parallel seams,
// and fully reproducible renders.
function noteRnd(seed, t, midi) {
  const k = ((seed >>> 0) ^ (Math.round(t * 1000) >>> 0) ^ Math.imul(midi & 0xff, 2654435761)) >>> 0;
  return mulberry32(k)();
}

class RNG {
  constructor(seed) { this.f = mulberry32(seed); }
  next() { return this.f(); }
  range(a, b) { return a + (b - a) * this.f(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.f() * arr.length)]; }
  chance(p) { return this.f() < p; }
  weighted(pairs) {            // pairs: [[item, weight], ...]
    let tot = 0;
    for (const p of pairs) tot += p[1];
    if (tot <= 0) return pairs[0][0];
    let r = this.f() * tot;
    for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
    return pairs[pairs.length - 1][0];
  }
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);

/* ---------------------------------------------------------------------
   Music theory
--------------------------------------------------------------------- */
const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

const MODES = {
  ionian:        [0, 2, 4, 5, 7, 9, 11],
  dorian:        [0, 2, 3, 5, 7, 9, 10],
  phrygian:      [0, 1, 3, 5, 7, 8, 10],
  lydian:        [0, 2, 4, 6, 7, 9, 11],
  mixolydian:    [0, 2, 4, 5, 7, 9, 10],
  aeolian:       [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor:  [0, 2, 3, 5, 7, 9, 11],
};
const MODE_LABELS = {
  ionian: 'major', dorian: 'dorian', phrygian: 'phrygian', lydian: 'lydian',
  mixolydian: 'mixo', aeolian: 'minor', harmonicMinor: 'h.minor', melodicMinor: 'm.minor',
};

/* Meters: everything is on a 16th-note step grid.
   groups: [start, length] phrases for rhythm generation.
   snare: backbeat steps. primary: the heaviest accents.            */
const METERS = {
  '4/4': { steps: 16, groups: [[0, 4], [4, 4], [8, 4], [12, 4]], snare: [4, 12], primary: [0, 8] },
  '3/4': { steps: 12, groups: [[0, 4], [4, 4], [8, 4]],          snare: [8],     primary: [0] },
  '6/8': { steps: 12, groups: [[0, 6], [6, 6]],                  snare: [6],     primary: [0, 6] },
  '5/4': { steps: 20, groups: [[0, 4], [4, 4], [8, 4], [12, 4], [16, 4]], snare: [12], primary: [0, 12] },
  '7/8': { steps: 14, groups: [[0, 4], [4, 4], [8, 6]],          snare: [8],     primary: [0, 8] },
};

/* Per-meter accent strength per step: 3 = downbeat, 2 = group start,
   1 = inner pulse, 0 = weak.                                         */
function strengthArray(meter) {
  const arr = new Array(meter.steps).fill(0);
  for (const [gs, gl] of meter.groups) {
    arr[gs] = Math.max(arr[gs], gs === 0 ? 3 : 2);
    const sub = (gl % 3 === 0) ? 3 : 2;
    for (let s = gs + sub; s < gs + gl; s += sub) arr[s] = Math.max(arr[s], 1);
  }
  return arr;
}

/* Euclidean-ish rhythm: k onsets spread over n steps. */
function euclid(k, n) {
  const out = [];
  for (let i = 0; i < n; i++) if (((i * k) % n) < k) out.push(i);
  return out;
}

/* Degree-to-degree transition weights (0-indexed scale degrees). */
const DEG_NEXT = {
  0: [[1, 2], [2, 1], [3, 3], [4, 2.5], [5, 2], [6, 0.8], [0, 1]],
  1: [[4, 3.5], [6, 1.5], [0, 1], [2, 0.8], [3, 1], [5, 0.7]],
  2: [[5, 2.5], [3, 2], [1, 1.5], [0, 0.7]],
  3: [[4, 3], [0, 2], [1, 1.2], [6, 1], [2, 0.6], [5, 0.8]],
  4: [[0, 3.5], [5, 2], [3, 1], [4, 0.8], [6, 0.5]],
  5: [[1, 2], [3, 2], [4, 2], [0, 1.5], [2, 1], [5, 0.5]],
  6: [[0, 3], [5, 1.5], [4, 1], [3, 0.8]],
};

/* Narrative arcs: map piece position 0..1 to energy 0..1. */
const ARCS = {
  arch:   t => 0.18 + 0.82 * Math.pow(Math.sin(Math.PI * clamp(t * 1.04, 0, 1)), 0.9),
  ascent: t => 0.15 + 0.85 * Math.pow(t, 1.4),
  waves:  t => clamp(0.5 + 0.3 * Math.sin(2 * Math.PI * 3 * t - Math.PI / 2) + 0.13 * Math.sin(2 * Math.PI * 7.1 * t), 0.08, 1),
  still:  t => 0.24 + 0.08 * Math.sin(2 * Math.PI * 2 * t),
  plunge: t => 0.95 - 0.8 * Math.pow(t, 0.8),
  twinPeaks: t => clamp(0.2 + 0.78 * Math.max(
    Math.exp(-Math.pow((t - 0.3) / 0.14, 2)),
    Math.exp(-Math.pow((t - 0.78) / 0.12, 2))), 0.08, 1),
  valley:    t => 0.88 - 0.68 * Math.pow(Math.sin(Math.PI * clamp(t, 0, 1)), 1.2),
  staircase: t => 0.2 + 0.75 * Math.min(4, Math.floor(t * 5)) / 4,
  sawtooth:  t => 0.22 + 0.68 * Math.pow((t * 3) % 1, 1.15),
  slowBurn:  t => t < 0.6
    ? 0.18 + 0.05 * Math.sin(2 * Math.PI * 4 * t)
    : 0.18 + 0.82 * Math.pow((t - 0.6) / 0.4, 1.6),
};

/* Recursive rhythmic subdivision of a group of `len` 16th steps. */
function subdivide(rng, len, density, depth) {
  if (len <= 1) return [len];
  const p = density * (depth === 0 ? 0.95 : 0.55) * Math.min(1, len / 4);
  if (!rng.chance(Math.min(0.92, p))) return [len];
  let parts;
  if (len % 2 === 0) {
    if (len >= 6 && rng.chance(0.4)) {
      parts = (len === 6) ? [2, 2, 2] : [len / 2, len / 4, len / 4];
    } else if (len % 4 === 0 && rng.chance(0.2)) {
      parts = rng.chance(0.5) ? [3 * len / 4, len / 4] : [len / 4, 3 * len / 4];
    } else {
      parts = [len / 2, len / 2];
    }
  } else if (len === 3) {
    parts = rng.pick([[2, 1], [1, 2], [1, 1, 1]]);
  } else if (len === 5) {
    parts = rng.pick([[3, 2], [2, 3], [2, 2, 1]]);
  } else {
    parts = [Math.ceil(len / 2), Math.floor(len / 2)];
  }
  const out = [];
  for (const part of parts) out.push(...subdivide(rng, part, density * 0.78, depth + 1));
  return out;
}

/* ---------------------------------------------------------------------
   The Composer - generates one bar of music at a time
--------------------------------------------------------------------- */
class Composer {
  constructor(seed, P) {
    this.rng = new RNG(seed);
    this.homeKey = (P.key === 'random') ? this.rng.int(0, 11) : Number(P.key);
    this.homeMode = (P.mode === 'auto')
      ? this.rng.weighted([['dorian', 3], ['aeolian', 3], ['mixolydian', 2], ['lydian', 2], ['ionian', 2], ['harmonicMinor', 1.2], ['phrygian', 0.8]])
      : P.mode;
    this.keyRoot = this.homeKey;
    this.modeName = this.homeMode;
    this.scale = MODES[this.modeName];
    this.buildScaleMidis();

    this.meterKey = P.meter;
    const meter = METERS[P.meter];
    const barSec = (meter.steps / 4) * (60 / P.tempo);
    this.totalBars = (P.lengthSec == null) ? null : Math.max(5, Math.round(P.lengthSec / barSec));
    this.arc = P.arc;

    this.barIndex = 0;
    this.sectionIdx = -1;
    this.barInSection = 0;
    this.section = null;
    this.movement = 1;
    this.energyDrift = 0;

    this.lastMelodyPitch = null;
    this.lastCounterPitch = null;
    this.prevVoicing = null;
    this.motifs = {};          // theme letter -> motif
    this.curChord = null;
    this.nextChord = this.buildChord(0, false);

    if (this.totalBars != null) this.plan = this.planFinite(this.totalBars);
    this.advanceSection(P);
  }

  /* ----- scale machinery ----- */
  buildScaleMidis() {
    this.scaleMidis = [];
    for (let m = 24; m <= 96; m++) {
      const pc = ((m - this.keyRoot) % 12 + 12) % 12;
      if (this.scale.includes(pc)) this.scaleMidis.push(m);
    }
  }

  nearestIdx(midi) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.scaleMidis.length; i++) {
      const d = Math.abs(this.scaleMidis[i] - midi);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  idxPitch(idx) { return this.scaleMidis[clamp(idx, 0, this.scaleMidis.length - 1)]; }

  /* ----- chords ----- */
  buildChord(deg, seventh, scaleOverride) {
    const scale = scaleOverride || this.scale;
    const size = seventh ? 4 : 3;
    const offs = [];
    for (let k = 0; k < size; k++) {
      const idx = deg + 2 * k;
      offs.push(scale[idx % 7] + 12 * Math.floor(idx / 7));
    }
    return this.finishChord(deg, offs);
  }

  finishChord(deg, offs) {
    const rootPc = ((this.keyRoot + offs[0]) % 12 + 12) % 12;
    const pcs = offs.map(o => ((this.keyRoot + o) % 12 + 12) % 12);
    const third = offs[1] - offs[0], fifth = offs[2] - offs[0];
    const seventh = offs.length > 3 ? offs[3] - offs[0] : null;
    let q = '';
    if (third === 3 && fifth === 6) q = seventh === 9 ? '°7' : (seventh === 10 ? 'ø7' : 'dim');
    else if (third === 3) q = seventh === 10 ? 'm7' : (seventh === 11 ? 'mM7' : 'm');
    else if (third === 4 && fifth === 8) q = '+';
    else q = seventh === 10 ? '7' : (seventh === 11 ? 'maj7' : '');
    return { deg, offs, pcs, rootPc, label: NOTE_NAMES[rootPc] + q };
  }

  pickNextChord(P, energy, forceDeg) {
    if (forceDeg != null) {
      return this.buildChord(forceDeg, this.rng.chance(0.3 + energy * 0.4));
    }
    const from = this.curChord ? this.curChord.deg : 0;
    let pairs = (DEG_NEXT[from] || DEG_NEXT[0]).map(([d, w]) => {
      let weight = Math.pow(w, 1 - P.variety * 0.45);            // variety flattens the distribution
      if ((d === 4 || d === 6) && energy > 0.55) weight *= 1 + (energy - 0.55);
      return [d, weight];
    });
    const deg = this.rng.weighted(pairs);
    const seventh = this.rng.chance(0.15 + energy * 0.3 + P.variety * 0.3);
    let chord = this.buildChord(deg, seventh);

    // Shadow: borrow the same degree from the parallel mode
    if (P.shadow > 0 && this.rng.chance(P.shadow * 0.3)) {
      const majorish = this.scale[2] === 4;
      const par = MODES[majorish ? 'aeolian' : 'ionian'];
      chord = this.buildChord(deg, seventh, par);
      chord.borrowed = true;
    }
    return chord;
  }

  /* Turn the current chord into V7 of the chord that follows. */
  secondaryDominant(target) {
    const root = (target.rootPc + 7) % 12;
    const r = ((root - this.keyRoot) % 12 + 12) % 12;
    const offs = [r, r + 4, r + 7, r + 10];
    const c = this.finishChord(-1, offs);
    c.secondary = true;
    return c;
  }

  /* ----- structure ----- */
  planFinite(total) {
    const sections = [];
    if (total <= 8) {
      sections.push({ name: 'Theme A', type: 'theme', theme: 'A', bars: Math.max(1, total - 2) });
      sections.push({ name: 'Coda', type: 'coda', bars: Math.min(2, total - 1) });
      return sections;
    }
    const intro = clamp(Math.round(total * 0.12), 1, 8);
    const coda = clamp(Math.round(total * 0.15), 2, 10);
    let body = total - intro - coda;
    sections.push({ name: 'Intro', type: 'intro', bars: intro });
    const chunk = body >= 24 ? 8 : (body >= 10 ? 6 : Math.max(2, body));
    const themes = ['A', 'B', 'A', 'C', 'B', 'A', 'C', 'A'];
    let i = 0;
    while (body > 0) {
      const b = Math.min(chunk, body);
      sections.push({ name: 'Theme ' + themes[i % themes.length], type: 'theme', theme: themes[i % themes.length], bars: b });
      body -= b; i++;
    }
    sections.push({ name: 'Coda', type: 'coda', bars: coda });
    // label the section nearest the arc peak as the climax
    let acc = 0, best = -1, bestE = -1;
    const arcF = ARCS[this.arc] || ARCS.arch;
    for (let s = 0; s < sections.length; s++) {
      const mid = (acc + sections[s].bars / 2) / total;
      const e = arcF(mid);
      if (sections[s].type === 'theme' && e > bestE) { bestE = e; best = s; }
      acc += sections[s].bars;
    }
    if (best >= 0) sections[best].name = 'Climax · ' + sections[best].name;
    return sections;
  }

  nextInfiniteSection() {
    const r = this.rng;
    const type = r.weighted([['theme', 6], ['breakdown', 1.4], ['soar', 1.4]]);
    const theme = r.pick(['A', 'A', 'B', 'B', 'C']);
    const bars = r.pick([6, 8, 8, 8, 10, 12]);
    let name;
    if (type === 'breakdown') name = 'Interlude';
    else if (type === 'soar') name = 'Soar · ' + theme;
    else name = 'Theme ' + theme;
    return { name: 'Mvt ' + this.movement + ' · ' + name, type, theme, bars };
  }

  advanceSection(P) {
    this.sectionIdx++;
    this.barInSection = 0;
    if (this.totalBars != null) {
      this.section = this.plan[Math.min(this.sectionIdx, this.plan.length - 1)];
    } else {
      if (this.sectionIdx > 0 && this.sectionIdx % 5 === 0) this.movement++;
      this.section = this.nextInfiniteSection();
    }

    if (this.sectionIdx > 0 && this.section.type !== 'coda') {
      this.maybeModulate(P);
    }
    // approaching the end, come home
    if (this.totalBars != null && this.section.type === 'coda') this.goHome();
  }

  maybeModulate(P) {
    const r = this.rng;
    const away = this.keyRoot !== this.homeKey || this.modeName !== this.homeMode;
    if (away && r.chance(0.45)) { this.goHome(); return; }
    if (!r.chance(P.wanderlust * 0.55)) return;

    const majorish = this.scale[2] === 4;
    const move = r.weighted([
      ['fifthUp', 3], ['fifthDown', 3],
      ['relative', 2.2], ['parallel', 1 + P.variety * 1.5],
      ['mediant', P.variety * 2], ['stepUp', P.variety * 1.2],
    ]);
    if (move === 'fifthUp') this.keyRoot = (this.keyRoot + 7) % 12;
    else if (move === 'fifthDown') this.keyRoot = (this.keyRoot + 5) % 12;
    else if (move === 'stepUp') this.keyRoot = (this.keyRoot + 2) % 12;
    else if (move === 'mediant') this.keyRoot = (this.keyRoot + (r.chance(0.5) ? 4 : 8)) % 12;
    else if (move === 'relative') {
      if (majorish) { this.keyRoot = (this.keyRoot + 9) % 12; this.modeName = 'aeolian'; }
      else { this.keyRoot = (this.keyRoot + 3) % 12; this.modeName = 'ionian'; }
    } else if (move === 'parallel') {
      this.modeName = majorish ? 'aeolian' : (r.chance(0.4) ? 'lydian' : 'ionian');
    }
    this.scale = MODES[this.modeName];
    this.buildScaleMidis();
    this.curChord = null;
    this.nextChord = this.buildChord(0, false);
  }

  goHome() {
    this.keyRoot = this.homeKey;
    this.modeName = this.homeMode;
    this.scale = MODES[this.modeName];
    this.buildScaleMidis();
    this.curChord = null;
    this.nextChord = this.buildChord(0, false);
  }

  energyForBar(P) {
    let e;
    if (this.totalBars != null) {
      const t = this.barIndex / this.totalBars;
      e = (ARCS[this.arc] || ARCS.arch)(t);
      const sec = this.section;
      if (sec.type === 'intro') e *= lerp(0.45, 0.9, (this.barInSection + 1) / sec.bars);
      if (sec.type === 'coda') e *= lerp(0.75, 0.15, this.barInSection / Math.max(1, sec.bars - 1));
    } else {
      this.energyDrift = clamp(this.energyDrift + this.rng.range(-0.04, 0.04), -0.15, 0.15);
      e = 0.52 + 0.3 * Math.sin(2 * Math.PI * this.barIndex / 48 - Math.PI / 2) + this.energyDrift;
      if (this.section.type === 'breakdown') e *= 0.42;
      if (this.section.type === 'soar') e = Math.max(e, 0.78);
    }
    return clamp(e, 0.08, 1);
  }

  /* ----- the main event: one bar ----- */
  nextBar(P) {
    const r = this.rng;
    if (this.barInSection >= this.section.bars) this.advanceSection(P);
    // user changed home key/mode mid-flight: adopt at section change only (handled in goHome/modulate);
    // but if the home itself changed, follow it now
    const wantKey = (P.key === 'random') ? this.homeKey : Number(P.key);
    if (wantKey !== this.homeKey) { this.homeKey = wantKey; this.goHome(); }
    if (P.mode !== 'auto' && P.mode !== this.homeMode) { this.homeMode = P.mode; this.goHome(); }

    if (P.meter !== this.meterKey) { this.meterKey = P.meter; this.motifs = {}; }
    const meter = METERS[P.meter];
    const strength = strengthArray(meter);
    const energy = this.energyForBar(P);
    const sec = this.section;
    const finite = this.totalBars != null;
    const fromEnd = finite ? this.totalBars - this.barIndex : Infinity;
    const isLast = finite && fromEnd === 1;
    const swingOK = !meter.groups.some(g => g[1] % 3 === 0);
    const swingAmt = swingOK ? P.swing * 0.62 : 0;

    /* --- harmony for this bar --- */
    let chord;
    if (finite && fromEnd === 2) {
      chord = this.buildChord(4, true);                       // penultimate: dominant
      this.nextChord = this.buildChord(0, false);
    } else if (isLast) {
      chord = this.buildChord(0, energy > 0.4);               // final tonic
      this.nextChord = chord;
    } else {
      if (this.barInSection === 0 && sec.type !== 'coda') {
        chord = this.pickNextChord(P, energy, r.chance(0.7) ? 0 : 5);   // sections open on tonic-ish
      } else if (this.barInSection === sec.bars - 1 && r.chance(0.6)) {
        chord = this.pickNextChord(P, energy, 4);             // phrase-final dominant
      } else {
        chord = this.nextChord;
      }
      this.nextChord = this.pickNextChord(P, energy);
      // shadow: secondary dominant pointing at what comes next
      if (P.shadow > 0 && this.nextChord.deg !== chord.deg && r.chance(P.shadow * 0.22)) {
        chord = this.secondaryDominant(this.nextChord);
      }
    }
    this.curChord = chord;

    // occasionally two chords per bar at higher complexity
    const barChords = [{ step: 0, chord }];
    if (!isLast && fromEnd > 2 && P.complexity > 0.6 && r.chance((P.complexity - 0.6) * 0.85)) {
      const mid = meter.groups[Math.floor(meter.groups.length / 2)][0];
      barChords.push({ step: mid, chord: this.nextChord });
    }
    const chordAt = step => {
      let c = barChords[0].chord;
      for (const bc of barChords) if (bc.step <= step) c = bc.chord;
      return c;
    };

    const ev = [];
    const hum = (tight) => (r.next() * 2 - 1) * P.humanity * (tight ? 0.04 : 0.09);
    const swing = (step) => {
      if (swingAmt <= 0) return step;
      const pos = ((step % 4) + 4) % 4;
      if (pos === 2) return step + swingAmt;
      if (pos === 1 || pos === 3) return step + swingAmt * 0.3;
      return step;
    };
    const velJit = () => (r.next() * 2 - 1) * P.humanity * 0.12;

    /* --- voice gating by structure & energy --- */
    const leadActive = P.mix.lead > 0 &&
      (sec.type !== 'intro' || this.barInSection >= Math.max(0, sec.bars - 2)) &&
      sec.type !== 'breakdown';
    const counterActive = P.mix.counter > 0 && energy > 0.42 && sec.type !== 'intro' && sec.type !== 'breakdown' && !isLast;
    const arpActive = P.mix.arp > 0 && (energy > 0.28 || sec.type === 'intro' || sec.type === 'breakdown') && !isLast;
    const percActive = P.mix.perc > 0 && energy > 0.34 && sec.type !== 'breakdown' && fromEnd > 2;
    const padActive = P.mix.pad > 0;
    const bassActive = P.mix.bass > 0;

    /* --- PAD --- */
    if (padActive) {
      for (let ci = 0; ci < barChords.length; ci++) {
        const bc = barChords[ci];
        const end = (ci + 1 < barChords.length) ? barChords[ci + 1].step : meter.steps;
        const voicing = this.voiceChord(bc.chord);
        for (const m of voicing) {
          ev.push({ voice: 'pad', step: bc.step, dur: end - bc.step, midi: m,
                    vel: clamp(0.32 + energy * 0.3 + velJit() * 0.5, 0.1, 0.85) });
        }
      }
    }

    /* --- MELODY --- */
    let melodyNotes = [];
    if (leadActive && !isLast) {
      melodyNotes = this.makeMelody(P, meter, strength, energy, chordAt, sec, r);
      for (const n of melodyNotes) {
        ev.push({ voice: 'lead', step: clamp(swing(n.step) + hum(false), 0, meter.steps - 0.05),
                  dur: n.dur * 0.92, midi: n.midi, vel: n.vel });
        // sparkle: grace note
        if (P.sparkle > 0 && n.dur >= 2 && r.chance(P.sparkle * 0.22)) {
          const gi = this.nearestIdx(n.midi) + (r.chance(0.6) ? 1 : -1);
          ev.push({ voice: 'lead', step: Math.max(0, swing(n.step) - 0.28), dur: 0.26,
                    midi: this.idxPitch(gi), vel: n.vel * 0.45, grace: true });
        }
      }
    }
    if (isLast) {
      // final gesture: a long tonic, maybe approached from the fifth
      const tonic = this.idxPitch(this.nearestIdx(this.lastMelodyPitch || (this.keyRoot + 64)));
      const tonicMidi = this.snapToPc(tonic, this.keyRoot % 12);
      if (P.mix.lead > 0) {
        ev.push({ voice: 'lead', step: 0, dur: meter.steps, midi: tonicMidi, vel: 0.6 });
        if (r.chance(0.5)) ev.push({ voice: 'lead', step: 0, dur: meter.steps, midi: tonicMidi + 7, vel: 0.35 });
      }
    }

    /* --- COUNTERPOINT --- */
    if (counterActive) {
      const cNotes = this.makeCounter(P, meter, strength, energy, chordAt, melodyNotes, r);
      for (const n of cNotes) {
        ev.push({ voice: 'counter', step: clamp(swing(n.step) + hum(false), 0, meter.steps - 0.05),
                  dur: n.dur * 0.9, midi: n.midi, vel: n.vel });
      }
    }

    /* --- BASS --- */
    if (bassActive) {
      this.makeBass(P, meter, strength, energy, chordAt, isLast, r).forEach(n => {
        ev.push({ voice: 'bass', step: clamp(swing(n.step) + hum(true), 0, meter.steps - 0.05),
                  dur: n.dur * 0.95, midi: n.midi, vel: n.vel });
      });
    }

    /* --- ARPEGGIO --- */
    if (arpActive) {
      this.makeArp(P, meter, strength, energy, chordAt, r).forEach(n => {
        ev.push({ voice: 'arp', step: clamp(swing(n.step) + hum(true), 0, meter.steps - 0.05),
                  dur: n.dur, midi: n.midi, vel: n.vel });
      });
    }

    /* --- PERCUSSION --- */
    if (percActive) {
      this.makePerc(P, meter, strength, energy, sec, swing, r).forEach(n => ev.push(n));
    } else if (isLast && P.mix.perc > 0) {
      ev.push({ voice: 'perc', type: 'hatOpen', step: 0, vel: 0.25 });
    }

    /* --- tempo feel --- */
    let tempoFactor = 1;
    if (finite) {
      if (fromEnd === 1) tempoFactor = 1.22;
      else if (fromEnd === 2) tempoFactor = 1.1;
      else if (fromEnd === 3) tempoFactor = 1.04;
    }

    const result = {
      events: ev,
      steps: meter.steps,
      tempoFactor,
      isLast,
      energy,
      display: {
        key: NOTE_NAMES[this.keyRoot] + ' ' + (MODE_LABELS[this.modeName] || this.modeName),
        chord: chord.label + (chord.borrowed ? ' *' : '') + (chord.secondary ? ' →' : ''),
        section: sec.name,
      },
    };
    this.barIndex++;
    this.barInSection++;
    return result;
  }

  snapToPc(nearMidi, pc) {
    let best = nearMidi, bd = Infinity;
    for (let m = nearMidi - 11; m <= nearMidi + 11; m++) {
      if (((m % 12) + 12) % 12 === pc) {
        const d = Math.abs(m - nearMidi);
        if (d < bd) { bd = d; best = m; }
      }
    }
    return best;
  }

  /* ----- melody ----- */
  makeMelody(P, meter, strength, energy, chordAt, sec, r) {
    const density = clamp(0.22 + P.complexity * 0.52 + energy * 0.26, 0.1, 0.95);

    // motif logic: themes remember their material (fractality)
    const theme = sec.theme || 'A';
    let notes = null;
    if (this.motifs[theme] && this.motifs[theme].steps === meter.steps && r.chance(P.fractality * 0.8)) {
      notes = this.developMotif(this.motifs[theme], P, chordAt, r);
    }
    if (!notes) {
      notes = this.freshMelody(P, meter, strength, density, energy, chordAt, r);
      if (!this.motifs[theme] && notes.length >= 2) {
        this.motifs[theme] = {
          steps: meter.steps,
          notes: notes.map(n => ({ step: n.step, dur: n.dur,
            degOff: this.nearestIdx(n.midi) - this.nearestIdx(notes[0].midi) })),
        };
      }
    }

    // velocities + register shaping
    for (const n of notes) {
      const s = Math.round(n.step) % meter.steps;
      const acc = (strength[s] >= 2) ? 0.16 : (strength[s] === 1 ? 0.06 : 0);
      n.vel = clamp(0.5 + energy * 0.32 + acc + (r.next() * 2 - 1) * P.humanity * 0.12, 0.12, 1);
    }
    if (notes.length) this.lastMelodyPitch = notes[notes.length - 1].midi;
    return notes;
  }

  freshMelody(P, meter, strength, density, energy, chordAt, r) {
    // rhythm
    const slots = [];
    for (const [gs, gl] of meter.groups) {
      const durs = subdivide(r, gl, density, 0);
      let s = gs;
      for (const d of durs) { slots.push({ step: s, dur: d }); s += d; }
    }
    const restP = (slot) => {
      const s = slot.step % meter.steps;
      if (s === 0) return 0.04;
      return (strength[s] >= 2 ? 0.07 : 0.16) + (1 - energy) * 0.14;
    };
    const notes = slots.filter(sl => !r.chance(restP(sl)));

    // pitches: weighted random walk
    const lo = 55 + Math.round(energy * 6), hi = lo + 26;
    const center = this.snapToPc(67, this.keyRoot % 12);
    let prev = this.lastMelodyPitch != null ? this.lastMelodyPitch : this.idxPitch(this.nearestIdx(center));
    let forcedDir = 0, repeats = 0;

    for (const n of notes) {
      const chord = chordAt(n.step);
      const strong = strength[Math.round(n.step) % meter.steps] >= 2;
      const cands = this.scaleMidis.filter(m =>
        m >= Math.max(lo, prev - 9) && m <= Math.min(hi, prev + 9));
      if (!cands.length) { n.midi = prev; continue; }
      const pairs = cands.map(c => {
        const iv = Math.abs(c - prev);
        let w = 1 / (1 + Math.pow(iv, 1.45));
        const inChord = chord.pcs.includes(((c % 12) + 12) % 12);
        if (strong) w *= inChord ? 3.2 : 0.45;
        else if (inChord) w *= 1.35;
        w *= 1 / (1 + (Math.abs(c - center) / 12) * P.gravity * 2.2);
        if (forcedDir !== 0) {
          const dir = Math.sign(c - prev);
          if (dir === forcedDir && iv <= 4) w *= 4;
          else if (dir === -forcedDir) w *= 0.15;
        }
        if (c === prev) w *= (repeats >= 2 ? 0.06 : 0.55);
        return [c, w];
      });
      n.midi = r.weighted(pairs);
      const jump = n.midi - prev;
      forcedDir = (Math.abs(jump) >= 5) ? -Math.sign(jump) : 0;
      repeats = (n.midi === prev) ? repeats + 1 : 0;
      prev = n.midi;
    }

    // shadow: chromatic approach tones on weak short notes
    if (P.shadow > 0) {
      for (let i = 0; i < notes.length - 1; i++) {
        const n = notes[i], nx = notes[i + 1];
        if (n.dur <= 1 && strength[Math.round(n.step) % meter.steps] === 0 &&
            Math.abs(nx.midi - n.midi) >= 2 && r.chance(P.shadow * 0.3)) {
          n.midi = nx.midi + (nx.midi > n.midi ? -1 : 1);
          n.chromatic = true;
        }
      }
    }
    return notes;
  }

  developMotif(motif, P, chordAt, r) {
    const op = r.weighted([
      ['exact', 2], ['transpose', 2.5],
      ['invert', 0.8 + P.fractality * 1.2],
      ['retro', 0.5 + P.fractality * 0.8],
      ['embellish', 1.4],
    ]);
    let src = motif.notes.map(n => ({ ...n }));
    if (op === 'retro') {
      const total = motif.steps;
      src = src.map(n => ({ ...n, step: total - n.step - n.dur })).sort((a, b) => a.step - b.step);
    }
    // anchor: nearest chord tone to where the melody last was
    const chord = chordAt(src.length ? src[0].step : 0);
    const near = this.lastMelodyPitch != null ? this.lastMelodyPitch : this.keyRoot + 64;
    let anchorMidi = near;
    let bd = Infinity;
    for (const m of this.scaleMidis) {
      if (m < 55 || m > 84) continue;
      if (!chord.pcs.includes(((m % 12) + 12) % 12)) continue;
      const d = Math.abs(m - near);
      if (d < bd) { bd = d; anchorMidi = m; }
    }
    const anchorIdx = this.nearestIdx(anchorMidi);
    const shift = (op === 'transpose') ? r.pick([-2, -1, 1, 2]) : 0;
    const sign = (op === 'invert') ? -1 : 1;

    const out = src.map(n => ({
      step: n.step, dur: n.dur,
      midi: this.idxPitch(anchorIdx + sign * n.degOff + shift),
    }));

    if (op === 'embellish') {
      const extra = [];
      for (const n of out) {
        if (n.dur >= 2 && r.chance(0.5)) {
          const half = n.dur / 2;
          extra.push({ step: n.step + half, dur: half,
                       midi: this.idxPitch(this.nearestIdx(n.midi) + r.pick([-1, 1])) });
          n.dur = half;
        }
      }
      out.push(...extra);
      out.sort((a, b) => a.step - b.step);
    }
    if (out.length) this.lastMelodyPitch = out[out.length - 1].midi;
    return out;
  }

  /* ----- counterpoint ----- */
  makeCounter(P, meter, strength, energy, chordAt, melodyNotes, r) {
    const out = [];
    const melOnsets = new Set(melodyNotes.map(n => Math.round(n.step)));
    const covered = new Set();
    for (const n of melodyNotes) {
      for (let s = Math.floor(n.step); s < Math.min(meter.steps, n.step + n.dur); s++) covered.add(s);
    }
    let slots = [];
    if (P.hocket > 0.35) {
      // sing in the melody's silences
      let s = 0;
      while (s < meter.steps) {
        if (!covered.has(s) && r.chance(0.35 + P.hocket * 0.55)) {
          let len = 1;
          while (s + len < meter.steps && !covered.has(s + len) && len < 4) len++;
          slots.push({ step: s, dur: len });
          s += len;
        } else s++;
      }
    }
    if (slots.length === 0) {
      // slower line on group starts
      for (const [gs, gl] of meter.groups) {
        if (r.chance(0.42 + energy * 0.3)) slots.push({ step: gs, dur: gl });
      }
    }

    let prev = this.lastCounterPitch != null ? this.lastCounterPitch : this.keyRoot + 55;
    const melDir = melodyNotes.length >= 2
      ? Math.sign(melodyNotes[melodyNotes.length - 1].midi - melodyNotes[0].midi) : 0;

    for (const sl of slots) {
      const chord = chordAt(sl.step);
      const cands = this.scaleMidis.filter(m => m >= 48 && m <= 70 &&
        chord.pcs.includes(((m % 12) + 12) % 12));
      if (!cands.length) continue;
      const pairs = cands.map(c => {
        let w = 1 / (1 + Math.abs(c - prev) / 2.5);
        if (melDir !== 0 && Math.sign(c - prev) === -melDir) w *= 2.1;  // contrary motion
        return [c, w];
      });
      const midi = r.weighted(pairs);
      out.push({ step: sl.step, dur: sl.dur,
                 midi, vel: clamp(0.36 + energy * 0.26 + (r.next() * 2 - 1) * 0.07, 0.1, 0.8) });
      prev = midi;
    }
    if (out.length) this.lastCounterPitch = out[out.length - 1].midi;
    return out;
  }

  /* ----- bass ----- */
  makeBass(P, meter, strength, energy, chordAt, isLast, r) {
    const out = [];
    const rootMidi = (pc) => 36 + ((pc - 36) % 12 + 12) % 12;
    if (isLast) {
      const c = chordAt(0);
      out.push({ step: 0, dur: meter.steps, midi: rootMidi(c.rootPc), vel: 0.6 });
      return out;
    }
    const tier = clamp(Math.floor((energy * 0.62 + P.complexity * 0.58) * 4), 0, 3);
    const groups = meter.groups;
    if (tier === 0) {
      const c = chordAt(0);
      out.push({ step: 0, dur: meter.steps, midi: rootMidi(c.rootPc), vel: 0.5 + energy * 0.2 });
      const mid = groups[Math.floor(groups.length / 2)][0];
      if (mid > 0 && chordAt(mid) !== c) {
        out[0].dur = mid;
        out.push({ step: mid, dur: meter.steps - mid, midi: rootMidi(chordAt(mid).rootPc), vel: 0.5 });
      }
    } else if (tier === 1) {
      for (let i = 0; i < groups.length; i++) {
        const [gs, gl] = groups[i];
        const c = chordAt(gs);
        const useFifth = i % 2 === 1 && r.chance(0.7);
        const pc = useFifth ? (c.rootPc + 7) % 12 : c.rootPc;
        out.push({ step: gs, dur: gl, midi: rootMidi(pc), vel: 0.48 + energy * 0.22 });
      }
    } else if (tier === 2) {
      // groove: roots with octave pops and rests
      for (const [gs, gl] of groups) {
        const c = chordAt(gs);
        const root = rootMidi(c.rootPc);
        const sub = gl % 3 === 0 ? 3 : 2;
        for (let s = gs; s < gs + gl; s += sub) {
          if (s !== gs && r.chance(0.3)) continue;
          const oct = (s !== gs && r.chance(0.3 + P.sparkle * 0.3));
          out.push({ step: s, dur: sub, midi: root + (oct ? 12 : 0),
                     vel: (s === gs ? 0.62 : 0.42) + energy * 0.18 });
        }
      }
    } else {
      // walking: chord tones stepping toward the next group's root
      for (let i = 0; i < groups.length; i++) {
        const [gs, gl] = groups[i];
        const c = chordAt(gs);
        const nxt = (i + 1 < groups.length) ? chordAt(groups[i + 1][0]) : this.nextChord;
        const root = rootMidi(c.rootPc);
        out.push({ step: gs, dur: Math.min(4, gl), midi: root, vel: 0.6 + energy * 0.15 });
        if (gl >= 4) {
          const targetRoot = rootMidi(nxt.rootPc);
          const tones = [root + 7, root + (c.offs[1] - c.offs[0]), targetRoot + (r.chance(0.5) ? 1 : -1)];
          const pickMid = tones[r.int(0, tones.length - 1)];
          out.push({ step: gs + Math.floor(gl / 2), dur: Math.ceil(gl / 2),
                     midi: clamp(pickMid, 30, 52), vel: 0.45 + energy * 0.15 });
        }
      }
    }
    return out;
  }

  /* ----- arpeggio ----- */
  makeArp(P, meter, strength, energy, chordAt, r) {
    const out = [];
    const sixteenths = P.complexity > 0.58 && energy > 0.55;
    const rate = sixteenths ? 1 : 2;
    if (this.arpShape == null || this.barInSection === 0) {
      this.arpShape = r.pick(['up', 'down', 'updown', 'weave']);
    }
    let k = 0;
    for (let s = 0; s < meter.steps; s += rate) {
      const dens = 0.45 + energy * 0.4 + P.complexity * 0.15;
      if (!r.chance(dens)) { k++; continue; }
      const chord = chordAt(s);
      const pool = [];
      for (let m = 60; m <= 79; m++) {
        if (chord.pcs.includes(((m % 12) + 12) % 12)) pool.push(m);
      }
      if (!pool.length) { k++; continue; }
      let idx;
      const L = pool.length;
      if (this.arpShape === 'up') idx = k % L;
      else if (this.arpShape === 'down') idx = (L - 1) - (k % L);
      else if (this.arpShape === 'updown') {
        const cyc = k % (2 * L - 2 || 1);
        idx = cyc < L ? cyc : (2 * L - 2 - cyc);
      } else idx = (k * 3 + Math.floor(k / L)) % L;
      let midi = pool[idx];
      if (P.sparkle > 0 && r.chance(P.sparkle * 0.12)) midi += 12;
      out.push({ step: s, dur: rate * 0.8,
                 midi, vel: clamp(0.26 + energy * 0.3 + (strength[s] >= 2 ? 0.1 : 0), 0.08, 0.7) });
      k++;
    }
    return out;
  }

  /* ----- percussion ----- */
  makePerc(P, meter, strength, energy, sec, swing, r) {
    const out = [];
    const steps = meter.steps;
    const full = energy > 0.55;
    const lastOfSection = this.barInSection === sec.bars - 1;
    const push = (type, step, vel) => out.push({ voice: 'perc', type, step: clamp(step, 0, steps - 0.05), vel });

    // kick
    const kCount = clamp(1 + Math.round(energy * 2.6 + P.complexity * 1.2), 1, 5);
    const kicks = euclid(kCount, steps).filter(s => strength[s] >= 1 || r.chance(P.complexity * 0.5));
    if (!kicks.includes(0)) kicks.unshift(0);
    for (const s of kicks) push('kick', s, 0.7 + (strength[s] >= 2 ? 0.2 : 0));

    // snare: backbeat, or euclid scatter at high complexity
    if (full) {
      const snares = (P.complexity > 0.7 && r.chance(0.35))
        ? euclid(3, steps).map(s => (s + 2) % steps)
        : meter.snare;
      for (const s of snares) push('snare', swing(s), 0.55 + energy * 0.2);
    }

    // hats
    if (energy > 0.42) {
      const compound = meter.groups.some(g => g[1] % 3 === 0);
      const hatRate = (full && P.complexity > 0.55) ? 1 : (compound ? 3 : 2);
      for (let s = 0; s < steps; s += hatRate) {
        if (r.chance(0.12)) continue;
        const acc = strength[s] >= 2 ? 0.3 : (strength[s] === 1 ? 0.16 : 0.06);
        push('hat', swing(s), 0.18 + acc + energy * 0.15);
      }
      if (P.sparkle > 0 && r.chance(P.sparkle * 0.4)) {
        push('hatOpen', swing(steps - 2), 0.3);
      }
    } else {
      // low energy: soft shaker pulse
      for (const [gs] of meter.groups) {
        if (r.chance(0.6)) push('shaker', gs, 0.2);
      }
    }
    if (full && energy > 0.6) {
      for (let s = 1; s < steps; s += 2) if (r.chance(0.25)) push('shaker', swing(s), 0.18);
    }

    // section-final fill
    if (lastOfSection && energy > 0.5 && r.chance(0.75)) {
      const fillStart = steps - Math.min(4, Math.floor(steps / 4));
      for (let s = fillStart; s < steps; s++) {
        push('snare', s, 0.3 + 0.5 * (s - fillStart) / Math.max(1, steps - fillStart - 1));
      }
    }
    return out;
  }

  /* ----- pad voicing with smooth voice-leading ----- */
  voiceChord(chord) {
    const pcs = chord.pcs.slice(0, 4);
    const lo = 46, hi = 71;
    let voicing;
    if (!this.prevVoicing) {
      voicing = [];
      let base = this.snapToPc(50, chord.rootPc);
      voicing.push(base);
      for (let i = 1; i < pcs.length; i++) {
        let m = this.snapToPc(voicing[i - 1] + 4, pcs[i]);
        while (m <= voicing[i - 1]) m += 12;
        if (m > hi) m -= 12;
        voicing.push(m);
      }
    } else {
      voicing = pcs.map(pc => {
        let best = null, bd = Infinity;
        for (let m = lo; m <= hi; m++) {
          if (((m % 12) + 12) % 12 !== pc) continue;
          let d = Infinity;
          for (const pv of this.prevVoicing) d = Math.min(d, Math.abs(m - pv));
          if (d < bd) { bd = d; best = m; }
        }
        return best == null ? this.snapToPc(58, pc) : best;
      });
      voicing = [...new Set(voicing)].sort((a, b) => a - b);
    }
    this.prevVoicing = voicing;
    return voicing;
  }
}

/* ---------------------------------------------------------------------
   Audio engine
--------------------------------------------------------------------- */
let ctx = null;
let nodes = null;        // buses & master chain
let noiseBuf = null;
let _audioSeed = 1;      // seeds the noise buffer + reverb impulse (deterministic)
let _agen = Math.random; // seeded generator, set per buildGraph
let _reverbSeconds = 3.2; // convolver IR length (Fast mode shortens it)
let _reverbMono = false;  // Fast mode uses a mono IR (cheaper convolution)
let _fast = false;        // Fast mode: thinner instruments (fewer oscillators)

function buildGraph(context) {
  ctx = context;
  _agen = mulberry32(((_audioSeed >>> 0) ^ 0x6d2b79f5) >>> 0);   // deterministic noise/impulse

  const master = ctx.createGain();
  const tideFilter = ctx.createBiquadFilter();
  tideFilter.type = 'lowpass';
  tideFilter.frequency.value = 18000;
  tideFilter.Q.value = 0.4;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 22;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.24;
  // hard safety limiter: clamps anything that slips past the compressor
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.1;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;

  master.connect(tideFilter);
  tideFilter.connect(comp);
  if (_fast) { comp.connect(analyser); }             // Fast: skip the safety limiter
  else { comp.connect(limiter); limiter.connect(analyser); }
  analyser.connect(ctx.destination);

  // reverb
  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(_reverbSeconds, 2.6);
  const reverbOut = ctx.createGain();
  reverbOut.gain.value = 1;
  convolver.connect(reverbOut);
  reverbOut.connect(master);

  // echo (dotted eighth) for lead & arp
  const echoIn = ctx.createGain();
  const delay = ctx.createDelay(2.0);
  delay.delayTime.value = 0.42;
  const fb = ctx.createGain();
  fb.gain.value = 0.34;
  const echoTone = ctx.createBiquadFilter();
  echoTone.type = 'lowpass';
  echoTone.frequency.value = 4200;
  const echoWet = ctx.createGain();
  echoWet.gain.value = 0.3;
  echoIn.connect(delay);
  delay.connect(echoTone);
  echoTone.connect(fb);
  fb.connect(delay);
  echoTone.connect(echoWet);
  echoWet.connect(master);
  echoWet.connect(convolver);

  // voice buses with individual reverb sends
  const buses = {};
  const sendAmt = { lead: 0.4, counter: 0.38, pad: 0.6, arp: 0.34, bass: 0.07, perc: 0.18 };
  const sends = {};
  for (const name of ['lead', 'counter', 'pad', 'arp', 'bass', 'perc']) {
    const g = ctx.createGain();
    g.connect(master);
    const send = ctx.createGain();
    send.gain.value = 0;
    g.connect(send);
    send.connect(convolver);
    buses[name] = g;
    sends[name] = send;
  }

  // shared noise buffer (seeded -> identical across render segments)
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = _agen() * 2 - 1;

  nodes = { master, tideFilter, comp, analyser, convolver, reverbOut, echoIn, delay, fb, echoWet, buses, sends, sendAmt };
  applyMixes();
  applySpace();
}

function makeImpulse(seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const chs = _reverbMono ? 1 : 2;
  const buf = ctx.createBuffer(chs, len, rate);
  for (let ch = 0; ch < chs; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (_agen() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function noiseSource(t, dur) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  src.start(t);
  src.stop(t + dur);
  return src;
}

function scrap(src, parts) {
  src.onended = () => { for (const n of parts) { try { n.disconnect(); } catch (e) {} } };
}

/* ----- instruments ----- */
function playLead(t, freq, dur, vel, P, rnd) {
  const bus = nodes.buses.lead;
  const detune = ((rnd == null ? Math.random() : rnd) * 2 - 1) * P.humanity * 7;
  const timbre = P.leadTimbre;
  if (timbre === 'glass') {
    const car = ctx.createOscillator();
    car.frequency.value = freq;
    car.detune.value = detune;
    const mod = ctx.createOscillator();
    mod.frequency.value = freq * 3.003;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(freq * (1.4 + vel * 1.6), t);
    mg.gain.exponentialRampToValueAtTime(freq * 0.04, t + Math.max(0.25, dur * 0.85));
    mod.connect(mg);
    mg.connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.17 * vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.5);
    car.connect(g);
    g.connect(bus);
    g.connect(nodes.echoIn);
    car.start(t); mod.start(t);
    car.stop(t + dur + 0.6); mod.stop(t + dur + 0.6);
    scrap(car, [g, mg, mod]);
  } else if (timbre === 'reed') {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibG = ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(5, t + Math.min(0.4, dur * 0.5));
    vib.connect(vibG); vibG.connect(osc.detune);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(700 + vel * 2600, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(500, 400 + vel * 1200), t + dur);
    lp.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.15 * vel, t + 0.025);
    g.gain.setValueAtTime(0.15 * vel, t + Math.max(0.03, dur - 0.05));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.08);
    osc.connect(lp); lp.connect(g); g.connect(bus); g.connect(nodes.echoIn);
    osc.start(t); vib.start(t);
    osc.stop(t + dur + 0.15); vib.stop(t + dur + 0.15);
    scrap(osc, [g, lp, vib, vibG]);
  } else if (timbre === 'breath') {
    const o1 = ctx.createOscillator();
    o1.frequency.value = freq;
    o1.detune.value = detune;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = freq * 1.004;
    const o2g = ctx.createGain(); o2g.gain.value = 0.4;
    const vib = ctx.createOscillator(); vib.frequency.value = 4.8;
    const vibG = ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(7, t + Math.min(0.5, dur * 0.6));
    vib.connect(vibG); vibG.connect(o1.detune); vibG.connect(o2.detune);
    const breath = noiseSource(t, dur + 0.2);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq * 2; bp.Q.value = 4;
    const bg = ctx.createGain(); bg.gain.value = 0.05 * vel;
    breath.connect(bp); bp.connect(bg);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16 * vel, t + 0.05);
    g.gain.setValueAtTime(0.16 * vel, t + Math.max(0.06, dur - 0.06));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.12);
    o1.connect(g); o2.connect(o2g); o2g.connect(g); bg.connect(g);
    g.connect(bus); g.connect(nodes.echoIn);
    o1.start(t); o2.start(t); vib.start(t);
    o1.stop(t + dur + 0.2); o2.stop(t + dur + 0.2); vib.stop(t + dur + 0.2);
    scrap(o1, [g, o2, o2g, vib, vibG, bp, bg]);
  } else if (timbre === 'pluck') { // Karplus-Strong
    const burst = noiseSource(t, Math.min(0.05, 2 / freq + 0.005));
    const dl = ctx.createDelay(0.1);
    dl.delayTime.value = 1 / freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(freq * 9, 1200, 9500);
    lp.Q.value = -6;   // dB: no resonance peak - keeps the feedback loop gain < 1 (stable)
    const fbg = ctx.createGain();
    fbg.gain.value = clamp(0.975 - freq / 18000, 0.88, 0.975);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.34 * vel, t);
    g.gain.setValueAtTime(0.34 * vel, t + Math.max(0.05, dur));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.3);
    burst.connect(dl);
    dl.connect(lp); lp.connect(fbg); fbg.connect(dl);
    lp.connect(g); g.connect(bus); g.connect(nodes.echoIn);
    const ms = (t - ctx.currentTime + dur + 0.9) * 1000;
    setTimeout(() => { for (const n of [dl, lp, fbg, g]) { try { n.disconnect(); } catch (e) {} } }, Math.max(50, ms));
  } else if (timbre === 'keys') { // FM electric piano
    const car = ctx.createOscillator();
    car.frequency.value = freq;
    car.detune.value = detune;
    const mod = ctx.createOscillator();
    mod.frequency.value = freq;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(freq * (0.5 + vel * 1.1), t);
    mg.gain.exponentialRampToValueAtTime(freq * 0.03, t + Math.max(0.3, dur));
    mod.connect(mg);
    mg.connect(car.frequency);
    const tine = ctx.createOscillator();
    tine.frequency.value = freq * 6.93;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.05 * vel, t);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    tine.connect(tg);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.19 * vel, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.7);
    car.connect(g); tg.connect(g);
    g.connect(bus); g.connect(nodes.echoIn);
    car.start(t); mod.start(t); tine.start(t);
    car.stop(t + dur + 0.8); mod.stop(t + dur + 0.8); tine.stop(t + 0.12);
    scrap(car, [g, mg, mod, tg]);
  } else if (timbre === 'brass') {
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth'; o1.frequency.value = freq; o1.detune.value = detune - 5;
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth'; o2.frequency.value = freq; o2.detune.value = detune + 5;
    const vib = ctx.createOscillator(); vib.frequency.value = 4.6;
    const vibG = ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(5, t + Math.min(0.45, dur * 0.6));
    vib.connect(vibG); vibG.connect(o1.detune); vibG.connect(o2.detune);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(280 + vel * 250, t);
    lp.frequency.linearRampToValueAtTime(900 + vel * 2900, t + 0.09);
    lp.frequency.exponentialRampToValueAtTime(600 + vel * 1600, t + Math.max(0.12, dur));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13 * vel, t + 0.045);
    g.gain.setValueAtTime(0.13 * vel, t + Math.max(0.05, dur - 0.05));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
    o1.connect(lp); o2.connect(lp); lp.connect(g);
    g.connect(bus); g.connect(nodes.echoIn);
    o1.start(t); o2.start(t); vib.start(t);
    o1.stop(t + dur + 0.15); o2.stop(t + dur + 0.15); vib.stop(t + dur + 0.15);
    scrap(o1, [g, lp, o2, vib, vibG]);
  } else if (timbre === 'organ') { // additive drawbars
    const partials = [[1, 0.5], [2, 0.32], [3, 0.18], [4, 0.1]];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13 * vel, t + 0.012);
    g.gain.setValueAtTime(0.13 * vel, t + Math.max(0.02, dur - 0.04));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.06);
    const vib = ctx.createOscillator(); vib.frequency.value = 6;
    const vibG = ctx.createGain(); vibG.gain.value = 4;
    vib.connect(vibG);
    const parts = [];
    for (const [ratio, amp] of partials) {
      const o = ctx.createOscillator();
      o.frequency.value = freq * ratio;
      o.detune.value = detune;
      vibG.connect(o.detune);
      const og = ctx.createGain(); og.gain.value = amp;
      o.connect(og); og.connect(g);
      o.start(t); o.stop(t + dur + 0.1);
      parts.push(o, og);
    }
    vib.start(t); vib.stop(t + dur + 0.1);
    g.connect(bus); g.connect(nodes.echoIn);
    scrap(parts[0], [g, vib, vibG, ...parts.slice(1)]);
  } else { // pure sine
    const o = ctx.createOscillator();
    o.frequency.value = freq; o.detune.value = detune;
    const vib = ctx.createOscillator(); vib.frequency.value = 5;
    const vibG = ctx.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(6, t + Math.min(0.45, dur * 0.6));
    vib.connect(vibG); vibG.connect(o.detune);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18 * vel, t + 0.03);
    g.gain.setValueAtTime(0.18 * vel, t + Math.max(0.04, dur - 0.07));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
    o.connect(g); g.connect(bus); g.connect(nodes.echoIn);
    o.start(t); vib.start(t);
    o.stop(t + dur + 0.15); vib.stop(t + dur + 0.15);
    scrap(o, [g, vib, vibG]);
  }
}

function playCounter(t, freq, dur, vel) {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.15 * vel, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.04 * vel + 0.0001, t + Math.max(0.1, dur * 0.7));
  g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
  osc.connect(lp); lp.connect(g); g.connect(nodes.buses.counter);
  osc.start(t); osc.stop(t + dur + 0.15);
  const extra = [];
  if (!_fast) {   // Fast: drop the octave shimmer partial
    const o2 = ctx.createOscillator();
    o2.frequency.value = freq * 2.001;
    const o2g = ctx.createGain(); o2g.gain.value = 0.18;
    o2.connect(o2g); o2g.connect(lp);
    o2.start(t); o2.stop(t + dur + 0.15);
    extra.push(o2, o2g);
  }
  scrap(osc, [g, lp, ...extra]);
}

function playPad(t, freq, dur, vel, P, energy) {
  const bus = nodes.buses.pad;
  const timbre = P.padTimbre;
  const levels = { warm: 0.052, halo: 0.052, choir: 0.06, strings: 0.042, hollow: 0.055 };
  const level = (levels[timbre] || 0.05) * vel;
  const g = ctx.createGain();
  const atk = (timbre === 'strings')
    ? Math.min(0.7, dur * 0.22 + 0.12)
    : Math.min(1.3, dur * 0.3 + 0.15);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + atk);
  g.gain.setValueAtTime(level, t + Math.max(atk, dur - 0.2));
  g.gain.linearRampToValueAtTime(0, t + dur + 1.4);
  g.connect(bus);
  const stopAt = t + dur + 1.6;
  const oscs = [];        // sources (started/stopped below)
  const extras = [];      // non-source nodes to disconnect

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.7;

  if (timbre === 'warm') {
    lp.frequency.value = 450 + energy * 2200;
    for (const det of (_fast ? [-7, 7] : [-8, 0, 8])) {   // Fast: 2 saws instead of 3
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(lp);
      oscs.push(o);
    }
    lp.connect(g); extras.push(lp);
  } else if (timbre === 'halo') {
    lp.frequency.value = 1400 + energy * 3600;
    const o1 = ctx.createOscillator();
    o1.type = 'triangle'; o1.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.frequency.value = freq * 2;
    const o2g = ctx.createGain(); o2g.gain.value = 0.3;
    o1.connect(lp); o2.connect(o2g); o2g.connect(lp);
    lp.connect(g);
    oscs.push(o1, o2);
    extras.push(lp, o2g);
    if (!_fast) {   // shimmer LFO (subtle) dropped in Fast mode
      const shim = ctx.createOscillator(); shim.frequency.value = 0.31;
      const shimG = ctx.createGain(); shimG.gain.value = 7;
      shim.connect(shimG); shimG.connect(o1.detune); shimG.connect(o2.detune);
      oscs.push(shim); extras.push(shimG);
    }
  } else if (timbre === 'choir') {
    const mix = ctx.createGain(); mix.gain.value = 1;
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(mix);
      oscs.push(o);
    }
    // two vowel formants plus a darker body
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.frequency.value = 640; f1.Q.value = 5;
    const f1g = ctx.createGain(); f1g.gain.value = 0.9;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.frequency.value = 1100; f2.Q.value = 6;
    const f2g = ctx.createGain(); f2g.gain.value = 0.55;
    lp.frequency.value = 750;
    const lpg = ctx.createGain(); lpg.gain.value = 0.5;
    mix.connect(f1); f1.connect(f1g); f1g.connect(g);
    mix.connect(f2); f2.connect(f2g); f2g.connect(g);
    mix.connect(lp); lp.connect(lpg); lpg.connect(g);
    extras.push(mix, f1, f1g, f2, f2g, lp, lpg);
  } else if (timbre === 'strings') {
    lp.frequency.value = 750 + energy * 2700;
    for (const det of (_fast ? [-8, 6] : [-12, -4, 5, 11])) {   // Fast: 2 saws instead of 4
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
      o.connect(lp);
      oscs.push(o);
    }
    lp.connect(g);
    extras.push(lp);
    if (!_fast) {   // bowing LFO dropped in Fast mode
      const bow = ctx.createOscillator(); bow.frequency.value = 0.4;
      const bowG = ctx.createGain(); bowG.gain.value = 180;
      bow.connect(bowG); bowG.connect(lp.frequency);
      oscs.push(bow); extras.push(bowG);
    }
  } else { // hollow
    lp.frequency.value = 520 + energy * 1500;
    const o1 = ctx.createOscillator();
    o1.type = 'square'; o1.frequency.value = freq;
    const o1g = ctx.createGain(); o1g.gain.value = 0.55;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle'; o2.frequency.value = freq;
    o1.connect(o1g); o1g.connect(lp); o2.connect(lp);
    lp.connect(g);
    oscs.push(o1, o2);
    extras.push(lp, o1g);
  }

  for (const o of oscs) { o.start(t); o.stop(stopAt); }
  scrap(oscs[0], [g, ...extras, ...oscs.slice(1)]);
}

function playBass(t, freq, dur, vel) {
  const sub = ctx.createOscillator();
  sub.frequency.value = freq;
  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = freq;
  const sawG = ctx.createGain(); sawG.gain.value = 0.3;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(180 + vel * 480, t);
  lp.frequency.exponentialRampToValueAtTime(140, t + Math.max(0.1, dur));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.34 * vel, t + 0.012);
  g.gain.setValueAtTime(0.34 * vel, t + Math.max(0.02, dur - 0.06));
  g.gain.linearRampToValueAtTime(0, t + dur + 0.08);
  sub.connect(lp); saw.connect(sawG); sawG.connect(lp); lp.connect(g);
  g.connect(nodes.buses.bass);
  sub.start(t); saw.start(t);
  sub.stop(t + dur + 0.12); saw.stop(t + dur + 0.12);
  scrap(sub, [g, lp, saw, sawG]);
}

function playArp(t, freq, dur, vel) {
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = freq;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1600 + vel * 3800;
  lp.Q.value = 2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.085 * vel, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.08, dur * 0.9));
  osc.connect(lp); lp.connect(g);
  g.connect(nodes.buses.arp);
  g.connect(nodes.echoIn);
  osc.start(t); osc.stop(t + dur + 0.1);
  scrap(osc, [g, lp]);
}

function playPerc(t, type, vel) {
  const bus = nodes.buses.perc;
  if (type === 'kick') {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(43, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    o.connect(g); g.connect(bus);
    o.start(t); o.stop(t + 0.3);
    scrap(o, [g]);
    const click = noiseSource(t, 0.012);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1200;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.12 * vel, t);
    cg.gain.linearRampToValueAtTime(0, t + 0.012);
    click.connect(hp); hp.connect(cg); cg.connect(bus);
    scrap(click, [hp, cg]);
  } else if (type === 'snare') {
    const n = noiseSource(t, 0.16);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    n.connect(bp); bp.connect(g); g.connect(bus);
    const tone = ctx.createOscillator();
    tone.type = 'triangle'; tone.frequency.value = 195;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.14 * vel, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    tone.connect(tg); tg.connect(bus);
    tone.start(t); tone.stop(t + 0.09);
    scrap(n, [bp, g]); scrap(tone, [tg]);
  } else if (type === 'hat' || type === 'hatOpen') {
    const dur = type === 'hat' ? 0.045 : 0.4;
    const n = noiseSource(t, dur + 0.02);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 8200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(hp); hp.connect(g); g.connect(bus);
    scrap(n, [hp, g]);
  } else if (type === 'shaker') {
    const n = noiseSource(t, 0.09);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 5800; bp.Q.value = 2.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.12 * vel, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    n.connect(bp); bp.connect(g); g.connect(bus);
    scrap(n, [bp, g]);
  }
}

/* ---------------------------------------------------------------------
   Parameters (pushed in from React) & callbacks (pushed out to React)
--------------------------------------------------------------------- */

// Frozen params for the current render. renderSong() sets this before it
// builds the offline graph; the instrument + mix code reads it. There is NO
// live tuning any more — the whole song is pre-rendered, so parameters only
// matter at render time.
let _params = {
  tempo: 96, key: 'random', mode: 'auto', meter: '4/4', lengthSec: 180, arc: 'arch',
  complexity: 0.55, variety: 0.40, gravity: 0.60, wanderlust: 0.30, shadow: 0.25,
  humanity: 0.50, fractality: 0.60, hocket: 0.20, sparkle: 0.30, tide: 0.35, swing: 0,
  mix: { lead: 0.80, counter: 0.55, pad: 0.65, arp: 0.50, bass: 0.75, perc: 0.60 },
  leadTimbre: 'glass', padTimbre: 'warm',
  reverb: 0.45, echo: 0.30, master: 0.80, seed: 1207,
};

function readParams() { return _params; }

function applyMixes() {
  if (!nodes) return;
  const P = readParams();
  const scale = { lead: 1, counter: 1, pad: 1, arp: 1, bass: 1, perc: 1 };
  for (const name of Object.keys(nodes.buses)) {
    nodes.buses[name].gain.value = Math.pow(P.mix[name === 'pad' ? 'pad' : name] ?? 0, 1.4) * scale[name];
    nodes.sends[name].gain.value = P.reverb * nodes.sendAmt[name] * 1.6;
  }
}

function applySpace() {
  if (!nodes) return;
  const P = readParams();
  nodes.echoWet.gain.value = P.echo * 0.85;
  nodes.fb.gain.value = 0.18 + P.echo * 0.32;
  nodes.master.gain.value = Math.pow(P.master, 1.6);
}


/* ---------------------------------------------------------------------
   Offline render — compose the WHOLE piece, then render it (faster than
   realtime) into an AudioBuffer, capturing the piano-roll JSON as we go.

   For speed the render is SEGMENTED across Web Workers (each with its own
   OfflineAudioContext) and stitched. Each segment renders with a pre-roll so
   reverb / echo / filter tails crossing the boundary are correct; with the
   seeded audio RNG the seams are sample-exact. Falls back to a single
   main-thread render when workers / worker-OfflineAudioContext are absent.
--------------------------------------------------------------------- */
const RENDER_SR = 44100;      // 44.1k renders ~8% fewer samples than 48k
const REVERB_TAIL = 4.2;      // seconds appended so note/reverb tails ring out
const REVERB_IR = 3.2;        // convolver impulse length (see makeImpulse)
const SEG_MIN = 30;           // songs shorter than this render in one shot

// Compose every bar up front -> events + viz JSON + automation. Deterministic.
export function composeSong(params) {
  const P = params;
  const seed = Number(P.seed) || 1;
  const composer = new Composer(seed, P);
  const notes = [], displayCues = [], scheduled = [], automation = [];
  let cursor = 0, end = null, guard = 0;
  while (end == null && guard++ < 200000) {
    const bar = composer.nextBar(P);
    const spStep = (60 / P.tempo) / 4 * bar.tempoFactor;
    const barDur = bar.steps * spStep;
    for (const e of bar.events) {
      const t = cursor + e.step * spStep;
      const durSec = (e.dur || 1) * spStep;
      scheduled.push({ t, durSec, voice: e.voice, midi: e.midi, type: e.type, vel: e.vel, energy: bar.energy });
      if (e.voice === 'perc') notes.push({ t, dur: 0.1, midi: 30, voice: 'perc', type: e.type });
      else notes.push({ t, dur: durSec, midi: e.midi, voice: e.voice });
    }
    displayCues.push({ t: cursor, ...bar.display });
    let tideCutoff = 18000;
    if (P.tide > 0) {
      const phase = Math.sin(2 * Math.PI * cursor / 26);
      tideCutoff = Math.max(900, 18000 * (1 - P.tide * 0.55 * (0.5 - 0.5 * phase)));
    }
    automation.push({ t: cursor, tideCutoff, delayTime: 0.75 * (60 / P.tempo) });
    cursor += barDur;
    if (bar.isLast) end = cursor;
  }
  return { notes, displayCues, scheduled, automation, songEnd: end || cursor, seed };
}

// Render one window [a, b) (+ tail on the final segment) into raw PCM.
// Returns { channels:[Float32Array,Float32Array], length, sampleRate }.
export async function renderSegment(params, seg, composed) {
  const P = params;
  const seed = Number(P.seed) || 1;
  const sr = seg.sampleRate || RENDER_SR;
  const a = seg.a, b = seg.b, tail = seg.tail || 0;
  // work in integer samples so segments tile exactly when stitched
  const aSamp = Math.round(a * sr), bSamp = Math.round(b * sr), tailSamp = Math.round(tail * sr);
  const prerollSamp = Math.round((seg.preroll || 0) * sr);
  const startSamp = Math.max(0, aSamp - prerollSamp);
  const start = startSamp / sr;                         // context-local 0 (sample-aligned)
  const keepFromSamp = aSamp - startSamp;               // samples discarded from the front
  const keepLen = (bSamp - aSamp) + tailSamp;

  const { scheduled, automation } = composed || composeSong(P);

  const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const off = new OfflineCtx(2, Math.max(1, keepFromSamp + keepLen), sr);
  _audioSeed = seed;
  _reverbSeconds = seg.reverbSeconds || 3.2;
  _reverbMono = !!seg.reverbMono;
  _fast = !!seg.fast;
  buildGraph(off);

  // master: fade in only on the segment containing absolute t=0
  const target = Math.pow(P.master, 1.6);
  nodes.master.gain.cancelScheduledValues(0);
  if (start <= 1e-6) {
    nodes.master.gain.setValueAtTime(0, 0);
    nodes.master.gain.linearRampToValueAtTime(target, 0.3);
  } else {
    nodes.master.gain.setValueAtTime(target, 0);
  }

  // seed tide/echo to the value active at `start`, then replay automation
  let init = null;
  for (const au of automation) { if (au.t <= start) init = au; else break; }
  if (init) {
    nodes.tideFilter.frequency.setValueAtTime(init.tideCutoff, 0);
    nodes.delay.delayTime.setValueAtTime(init.delayTime, 0);
  }
  for (const au of automation) {
    if (au.t > start && au.t < b) {
      const lt = au.t - start;
      nodes.tideFilter.frequency.setTargetAtTime(au.tideCutoff, lt, 1.2);
      nodes.delay.delayTime.setTargetAtTime(au.delayTime, lt, 0.4);
    }
  }

  // schedule every note whose onset is within [start, b). Snap the onset to the
  // sample grid (integer sample - startSamp) so a note lands on the exact same
  // absolute sample in every segment and in the single-shot render -> the
  // stitched result is bit-identical, not just perceptually close.
  for (const e of scheduled) {
    if (e.t < start || e.t >= b) continue;
    const lt = (Math.round(e.t * sr) - startSamp) / sr;
    if (e.voice === 'perc') { playPerc(lt, e.type, e.vel * Math.pow(P.mix.perc, 0.5)); continue; }
    const freq = midiToFreq(e.midi);
    if (e.voice === 'lead') playLead(lt, freq, e.durSec, e.vel, P, noteRnd(seed, e.t, e.midi));
    else if (e.voice === 'counter') playCounter(lt, freq, e.durSec, e.vel);
    else if (e.voice === 'pad') playPad(lt, freq, e.durSec, e.vel, P, e.energy);
    else if (e.voice === 'bass') playBass(lt, freq, e.durSec, e.vel);
    else if (e.voice === 'arp') playArp(lt, freq, e.durSec, e.vel);
  }

  const buf = await off.startRendering();
  ctx = null; nodes = null; noiseBuf = null;

  const channels = [];
  for (let c = 0; c < 2; c++) {
    const out = new Float32Array(keepLen);
    out.set(buf.getChannelData(c).subarray(keepFromSamp, keepFromSamp + keepLen));
    channels.push(out);
  }
  return { channels, length: keepLen, sampleRate: sr };
}

function makeAudioBuffer(numCh, length, sr) {
  if (typeof AudioBuffer === 'function') {
    try { return new AudioBuffer({ numberOfChannels: numCh, length, sampleRate: sr }); } catch (_) {}
  }
  const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  return new OfflineCtx(numCh, length, sr).createBuffer(numCh, length, sr);
}

/* Segmented render. A single long offline render is ~O(duration^2): finished
   nodes aren't freed mid-render (onended/scrap fire only afterwards), so every
   node ever scheduled is processed for the whole render. Rendering short
   segments makes it ~linear; a pre-roll re-triggers notes that started before
   each seam so reverb/echo/filter tails are correct there (seeded audio RNG ->
   seam-exact). Batches of segments render concurrently for extra multi-core
   parallelism. All on the main thread — OfflineAudioContext isn't available in
   Workers. */
export async function renderSong(params, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const fast = !!opts.fast;
  const sr = opts.sampleRate || (fast ? 24000 : RENDER_SR);
  const revSec = opts.reverbSeconds != null ? opts.reverbSeconds : (fast ? 1.4 : REVERB_IR);
  const revMono = opts.reverbMono != null ? opts.reverbMono : fast;
  const tailSec = revSec + 1.0;
  onProgress({ phase: 'composing', progress: 0 });

  const composed = composeSong(params);
  const { notes, displayCues, songEnd, seed, scheduled } = composed;
  const songEndSamp = Math.round(songEnd * sr);
  const totalLen = songEndSamp + Math.round(tailSec * sr);

  // pre-roll must cover the reverb IR + the longest note's tail
  let maxDur = 0;
  for (const e of scheduled) if (e.voice !== 'perc' && e.durSec > maxDur) maxDur = e.durSec;
  const preroll = opts.preroll != null ? opts.preroll : Math.min(14, Math.max(6, maxDur + revSec + 1.8));

  // segment length ~= preroll minimises total quadratic cost; short songs = 1 seg
  const single = opts.parallel === false || songEnd < SEG_MIN;
  const segLen = single ? songEnd : (opts.segLen != null ? opts.segLen : Math.max(6, Math.min(songEnd, preroll)));
  const K = Math.max(1, Math.ceil(songEnd / segLen));

  // integer-sample boundaries so stitched segments tile exactly (no drift)
  const bound = [];
  for (let i = 0; i <= K; i++) bound.push(Math.round(i * songEndSamp / K));
  const segs = [], segOff = [];
  for (let i = 0; i < K; i++) {
    segs.push({
      a: bound[i] / sr,
      b: bound[i + 1] / sr,
      preroll: i === 0 ? 0 : preroll,
      tail: (i === K - 1) ? tailSec : 0,
      sampleRate: sr,
      reverbSeconds: revSec, reverbMono: revMono, fast,
    });
    segOff.push(bound[i]);
  }

  const channels = [new Float32Array(totalLen), new Float32Array(totalLen)];
  onProgress({ phase: 'rendering', progress: 0, done: 0, total: K });

  // concurrent batches (each renderSegment builds its graph synchronously
  // before its first await, so the module globals never interleave)
  const batch = opts.batch != null ? opts.batch : Math.max(1, Math.min(K, navigator.hardwareConcurrency || 2));
  let done = 0;
  for (let i = 0; i < K; i += batch) {
    await Promise.all(segs.slice(i, i + batch).map((s, jj) => {
      const idx = i + jj;
      return renderSegment(params, s, composed).then((r) => {
        const at = segOff[idx], n = Math.min(r.length, totalLen - at);
        if (n > 0) {
          channels[0].set(r.channels[0].subarray(0, n), at);
          channels[1].set(r.channels[1].subarray(0, n), at);
        }
        done++; onProgress({ phase: 'rendering', progress: done / K, done, total: K });
      });
    }));
  }

  const audioBuffer = makeAudioBuffer(2, totalLen, sr);
  audioBuffer.getChannelData(0).set(channels[0]);
  audioBuffer.getChannelData(1).set(channels[1]);

  onProgress({ phase: 'rendering', progress: 1 });
  return { audioBuffer, notes, displayCues, duration: songEnd, seed, params, sampleRate: sr, segments: K, fast };
}

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
