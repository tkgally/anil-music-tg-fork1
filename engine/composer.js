/* ---------------------------------------------------------------------
   The Composer - generates one bar of music at a time.
   Pure + deterministic (no audio state). Extracted verbatim.
--------------------------------------------------------------------- */
import { RNG, clamp, lerp } from "./rng.js";
import { MODES, MODE_LABELS, METERS, strengthArray, euclid, DEG_NEXT, ARCS, subdivide, NOTE_NAMES } from "./theory.js";

export class Composer {
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
