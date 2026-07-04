/* ---------------------------------------------------------------------
   05 · Deep Work — the composer.
   Daysong's Composer (engine/composer.js), reduced and retuned for the
   background. What changed vs the studio original:
     · endless sections only — flow / thin / swell (5:2:2), 6–16 bars,
       no finite plan, no coda, no fills, no climax labelling
     · melody register window 48..ceiling (ceiling from Presence, 62–79)
       instead of 55..81; density × Presence scale; rest prob +0.10;
       velocities compressed to 0.30–0.55; grace notes/sparkle removed
     · motif develop ops gated by Presence: exact/transpose always,
       +embellish above ~45, +invert/retro above ~70 (cleverness is
       foreground)
     · harmonic rhythm: chord per bar or slower (Motion), occasional
       mid-bar change only at high Motion
     · bass tiers 0–1 only; perc reduced to shaker + soft hat + rare
       kick-thump, gated by energy > percGate (Presence-driven)
     · modulation: fifthDown/relative only, wanderlust-gated, and every
       key change takes a 2-bar pad-only "pivot breath" so it never lurches
   Pure + deterministic: same seed and same parameter history -> same bars.
--------------------------------------------------------------------- */
'use strict';

class DWComposer {
  constructor(seed, P) {
    this.rng = new RNG(seed >>> 0);
    this.homeRoot = P.root;
    this.homeMode = P.mode;
    this.keyRoot = P.root;
    this.modeName = P.mode;
    this.scale = MODES[this.modeName];
    this.buildScaleMidis();

    this.meterKey = P.meter;
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
    this.chordHold = 0;
    this.pivot = 0;            // pad-only bars remaining after a key change
    this.pendingHome = null;   // {root, mode} adopted at the next section
    this.nextChord = this.buildChord(0, false);
    this.advanceSection(P);
  }

  /* ----- scale machinery (verbatim) ----- */
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

  /* ----- chords (verbatim; variety = Complexity here) ----- */
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
    const pairs = (DEG_NEXT[from] || DEG_NEXT[0]).map(([d, w]) => {
      let weight = Math.pow(w, 1 - P.complexity * 0.45);      // complexity flattens
      if ((d === 4 || d === 6) && energy > 0.55) weight *= 1 + (energy - 0.55);
      return [d, weight];
    });
    const deg = this.rng.weighted(pairs);
    const seventh = this.rng.chance(0.15 + energy * 0.3 + P.complexity * 0.3);
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

  secondaryDominant(target) {
    const root = (target.rootPc + 7) % 12;
    const r = ((root - this.keyRoot) % 12 + 12) % 12;
    const offs = [r, r + 4, r + 7, r + 10];
    const c = this.finishChord(-1, offs);
    c.secondary = true;
    return c;
  }

  /* ----- home key: mood/root/mode changes land at the next section ----- */
  setHome(root, mode) {
    if (this.homeRoot === root && this.homeMode === mode) { this.pendingHome = null; return; }
    this.pendingHome = { root, mode };
  }

  goHome() {
    this.keyRoot = this.homeRoot;
    this.modeName = this.homeMode;
    this.scale = MODES[this.modeName];
    this.buildScaleMidis();
    this.curChord = null;
    this.chordHold = 0;
    this.nextChord = this.buildChord(0, false);
  }

  /* Rare fifthDown/relative modulation; any key change gets a 2-bar
     pad-only pivot breath so it never lurches. */
  maybeModulate(P) {
    const r = this.rng;
    const away = this.keyRoot !== this.homeRoot || this.modeName !== this.homeMode;
    if (away) {
      if (r.chance(0.5)) { this.goHome(); this.pivot = 2; }
      return;
    }
    if (P.wanderlust <= 0) return;
    if (!r.chance(P.wanderlust * 0.3)) return;              // ~0.15/section at 50
    const majorish = this.scale[2] === 4;
    const move = r.weighted([['fifthDown', 3], ['relative', 2.2]]);
    if (move === 'fifthDown') {
      this.keyRoot = (this.keyRoot + 5) % 12;
    } else if (majorish) {
      this.keyRoot = (this.keyRoot + 9) % 12; this.modeName = 'aeolian';
    } else {
      this.keyRoot = (this.keyRoot + 3) % 12; this.modeName = 'ionian';
    }
    this.scale = MODES[this.modeName];
    this.buildScaleMidis();
    this.curChord = null;
    this.chordHold = 0;
    this.nextChord = this.buildChord(0, false);
    this.pivot = 2;
  }

  /* ----- endless structure: flow / thin / swell ----- */
  nextSection(P) {
    const r = this.rng;
    let type = r.weighted([['flow', 5], ['thin', 2], ['swell', 2]]);
    let theme = r.pick(['A', 'A', 'B', 'B', 'C']);
    if (this.sectionIdx === 0) { type = 'flow'; theme = 'A'; }   // stable opening
    const pool = P.motion < 0.34 ? [10, 12, 12, 14, 16]
               : P.motion < 0.67 ? [8, 8, 10, 12, 12]
               : [6, 8, 8, 10];
    const bars = r.pick(pool);
    const label = type === 'thin' ? 'Interlude'
                : type === 'swell' ? 'Swell · ' + theme
                : 'Theme ' + theme;
    return { name: 'Mvt ' + this.movement + ' · ' + label, type, theme, bars };
  }

  advanceSection(P) {
    this.sectionIdx++;
    this.barInSection = 0;
    if (this.sectionIdx > 0 && this.sectionIdx % 5 === 0) this.movement++;
    if (this.pendingHome) {
      this.homeRoot = this.pendingHome.root;
      this.homeMode = this.pendingHome.mode;
      this.pendingHome = null;
      this.goHome();
      this.pivot = 2;
    } else if (this.sectionIdx > 0) {
      this.maybeModulate(P);
    }
    this.section = this.nextSection(P);
  }

  /* Daysong's infinite energy formula, clamped into the Presence ceiling
     and scaled by the session meta-curve. */
  energyForBar(P) {
    this.energyDrift = clamp(this.energyDrift + this.rng.range(-0.04, 0.04), -0.15, 0.15);
    // +12-bar phase offset vs Daysong: start mid-rise, not at the trough,
    // so the piece is "already going" a minute in
    let e = 0.52 + 0.3 * Math.sin(2 * Math.PI * (this.barIndex + 12) / 48 - Math.PI / 2) + this.energyDrift;
    if (this.section.type === 'thin') e *= 0.55;
    if (this.section.type === 'swell') e = Math.max(e, 0.72);
    e = Math.min(e, P.energyCeil) * P.sessionMult;
    return clamp(e, Math.max(0.05, 0.15 * P.sessionMult), 1);
  }

  /* ----- the main event: one bar ----- */
  nextBar(P) {
    const r = this.rng;
    if (this.barInSection >= this.section.bars) this.advanceSection(P);
    if (P.meter !== this.meterKey) {
      this.meterKey = P.meter;
      this.motifs = {};
      this.prevVoicing = null;
    }
    const meter = METERS[P.meter];
    const strength = strengthArray(meter);
    const energy = this.energyForBar(P);
    const sec = this.section;
    const swingOK = !meter.groups.some(g => g[1] % 3 === 0);
    const swingAmt = swingOK ? P.swing * 0.62 : 0;

    /* --- harmony: chord per bar or slower (Motion) --- */
    if (!this.curChord || this.chordHold <= 0) {
      let chord;
      if (this.barInSection === 0 && r.chance(0.6)) {
        chord = this.pickNextChord(P, energy, r.chance(0.7) ? 0 : 5);   // open tonic-ish
      } else {
        chord = this.nextChord;
      }
      this.nextChord = this.pickNextChord(P, energy);
      if (P.shadow > 0 && this.nextChord.deg !== chord.deg && r.chance(P.shadow * 0.22)) {
        chord = this.secondaryDominant(this.nextChord);
      }
      this.curChord = chord;
      const holdP = clamp(0.5 - P.motion, 0, 0.5) * 1.6;    // slow Motion holds 2 bars
      this.chordHold = r.chance(holdP) ? 2 : 1;
    }
    this.chordHold--;
    const chord = this.curChord;

    const barChords = [{ step: 0, chord }];
    if (this.chordHold <= 0 && P.motion > 0.55 && r.chance((P.motion - 0.55) * 1.2)) {
      const mid = meter.groups[Math.floor(meter.groups.length / 2)][0];
      barChords.push({ step: mid, chord: this.nextChord });   // carries into next bar
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

    /* --- voice gating: structure, energy, session, pivot breath --- */
    const pivot = this.pivot > 0;
    if (this.pivot > 0) this.pivot--;
    const padActive = P.padOn;
    const bassActive = P.bassOn && !pivot;
    const leadActive = P.leadOn && !pivot && sec.type !== 'thin';
    const counterActive = P.counterOn && !pivot && sec.type !== 'thin' &&
      (sec.type === 'swell' || energy > 0.42);
    const arpActive = P.arpOn && !pivot && sec.type !== 'thin' && energy > 0.28;
    const percActive = P.percOn && !pivot && energy > P.percGate;

    /* --- PAD (the bed; always present) --- */
    if (padActive) {
      for (let ci = 0; ci < barChords.length; ci++) {
        const bc = barChords[ci];
        const end = (ci + 1 < barChords.length) ? barChords[ci + 1].step : meter.steps;
        const voicing = this.voiceChord(bc.chord);
        const swellBonus = sec.type === 'swell' ? 0.08 : 0;
        for (const m of voicing) {
          ev.push({ voice: 'pad', step: bc.step, dur: end - bc.step, midi: m,
                    vel: clamp(0.42 + energy * 0.28 + swellBonus + velJit() * 0.4, 0.28, 0.8) });
        }
      }
    }

    /* --- MELODY --- */
    let melodyNotes = [];
    if (leadActive) {
      melodyNotes = this.makeMelody(P, meter, strength, energy, chordAt, sec, r);
      for (const n of melodyNotes) {
        ev.push({ voice: 'lead', step: clamp(swing(n.step) + hum(false), 0, meter.steps - 0.05),
                  dur: n.dur * 0.92, midi: n.midi, vel: n.vel });
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

    /* --- BASS (tiers 0–1 only) --- */
    if (bassActive) {
      this.makeBass(P, meter, energy, chordAt, r).forEach(n => {
        ev.push({ voice: 'bass', step: clamp(swing(n.step) + hum(true), 0, meter.steps - 0.05),
                  dur: n.dur * 0.95, midi: n.midi, vel: n.vel });
      });
    }

    /* --- ARPEGGIO (only above Presence ≈ 0.6) --- */
    if (arpActive) {
      this.makeArp(P, meter, strength, energy, chordAt, r).forEach(n => {
        ev.push({ voice: 'arp', step: clamp(swing(n.step) + hum(true), 0, meter.steps - 0.05),
                  dur: n.dur, midi: n.midi, vel: n.vel });
      });
    }

    /* --- PERCUSSION (shaker / soft hat / rare thump) --- */
    if (percActive) {
      this.makePerc(P, meter, energy, swing, r).forEach(n => ev.push(n));
    }

    const result = {
      events: ev,
      steps: meter.steps,
      energy,
      display: {
        key: NOTE_NAMES[this.keyRoot] + ' ' + (MODE_LABELS[this.modeName] || this.modeName),
        chord: chord.label + (chord.borrowed ? ' *' : '') + (chord.secondary ? ' →' : ''),
        section: sec.name,
        barsLeft: sec.bars - this.barInSection,
        pivot,
      },
    };
    this.barIndex++;
    this.barInSection++;
    return result;
  }

  /* ----- melody (retuned: low window, sparse, compressed touch) ----- */
  makeMelody(P, meter, strength, energy, chordAt, sec, r) {
    const density = clamp((0.22 + P.complexity * 0.52 + energy * 0.26) * P.melDensity, 0.06, 0.9);
    const theme = sec.theme || 'A';
    let notes = null;
    if (this.motifs[theme] && this.motifs[theme].steps === meter.steps &&
        r.chance(P.fractality * 0.85)) {
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

    for (const n of notes) {
      const s = Math.round(n.step) % meter.steps;
      const acc = (strength[s] >= 2) ? 0.16 : (strength[s] === 1 ? 0.06 : 0);
      const raw = clamp(0.5 + energy * 0.32 + acc + (r.next() * 2 - 1) * P.humanity * 0.12, 0.12, 1);
      n.vel = 0.3 + (raw - 0.12) * (0.25 / 0.88);           // compressed to 0.30..0.55
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
    // rest probability +0.10 vs the studio original: silence is background's friend
    const restP = (slot) => {
      const s = slot.step % meter.steps;
      if (s === 0) return 0.14;
      return (strength[s] >= 2 ? 0.17 : 0.26) + (1 - energy) * 0.14;
    };
    const notes = slots.filter(sl => !r.chance(restP(sl)));

    // pitches: weighted random walk inside 48..melCeil
    const lo = 48 + Math.round(energy * 4);
    const hi = Math.max(lo + 7, P.melCeil);
    const center = this.snapToPc(Math.round((lo + hi) / 2) + 1, this.keyRoot % 12);
    let prev = this.lastMelodyPitch != null
      ? clamp(this.lastMelodyPitch, lo, hi)
      : this.idxPitch(this.nearestIdx(center));
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
        }
      }
    }
    return notes;
  }

  developMotif(motif, P, chordAt, r) {
    // develop ops gated by Presence: cleverness is foreground
    const pool = [['exact', 2], ['transpose', 2.5]];
    if (P.ops >= 1) pool.push(['embellish', 1.4]);
    if (P.ops >= 2) pool.push(['invert', 0.8 + P.fractality * 1.2],
                              ['retro', 0.5 + P.fractality * 0.8]);
    const op = r.weighted(pool);
    let src = motif.notes.map(n => ({ ...n }));
    if (op === 'retro') {
      const total = motif.steps;
      src = src.map(n => ({ ...n, step: total - n.step - n.dur })).sort((a, b) => a.step - b.step);
    }
    // anchor: nearest chord tone (inside the window) to where the melody last was
    const chord = chordAt(src.length ? src[0].step : 0);
    const near = this.lastMelodyPitch != null ? this.lastMelodyPitch : this.keyRoot + 58;
    let anchorMidi = near;
    let bd = Infinity;
    for (const m of this.scaleMidis) {
      if (m < 48 || m > P.melCeil) continue;
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

  /* ----- counterpoint (verbatim logic, lower + softer) ----- */
  makeCounter(P, meter, strength, energy, chordAt, melodyNotes, r) {
    const out = [];
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
      for (const [gs, gl] of meter.groups) {
        if (r.chance(0.42 + energy * 0.3)) slots.push({ step: gs, dur: gl });
      }
    }

    let prev = this.lastCounterPitch != null ? this.lastCounterPitch : this.keyRoot + 55;
    const melDir = melodyNotes.length >= 2
      ? Math.sign(melodyNotes[melodyNotes.length - 1].midi - melodyNotes[0].midi) : 0;

    for (const sl of slots) {
      const chord = chordAt(sl.step);
      const cands = this.scaleMidis.filter(m => m >= 48 && m <= 64 &&
        chord.pcs.includes(((m % 12) + 12) % 12));
      if (!cands.length) continue;
      const pairs = cands.map(c => {
        let w = 1 / (1 + Math.abs(c - prev) / 2.5);
        if (melDir !== 0 && Math.sign(c - prev) === -melDir) w *= 2.1;  // contrary motion
        return [c, w];
      });
      const midi = r.weighted(pairs);
      out.push({ step: sl.step, dur: sl.dur, midi,
                 vel: clamp(0.26 + energy * 0.2 + (r.next() * 2 - 1) * 0.05, 0.15, 0.5) });
      prev = midi;
    }
    if (out.length) this.lastCounterPitch = out[out.length - 1].midi;
    return out;
  }

  /* ----- bass: tiers 0–1 only (whole roots / group roots + fifths) ----- */
  makeBass(P, meter, energy, chordAt, r) {
    const out = [];
    const rootMidi = (pc) => 36 + ((pc - 36) % 12 + 12) % 12;
    const tier = clamp(Math.floor((energy * 0.62 + P.complexity * 0.58) * 4), 0, 1);
    const groups = meter.groups;
    const vel = clamp(0.36 + energy * 0.2, 0.3, 0.6);
    if (tier === 0) {
      const c = chordAt(0);
      out.push({ step: 0, dur: meter.steps, midi: rootMidi(c.rootPc), vel });
      const mid = groups[Math.floor(groups.length / 2)][0];
      if (mid > 0 && chordAt(mid) !== c) {
        out[0].dur = mid;
        out.push({ step: mid, dur: meter.steps - mid, midi: rootMidi(chordAt(mid).rootPc), vel: vel * 0.95 });
      }
    } else {
      for (let i = 0; i < groups.length; i++) {
        const [gs, gl] = groups[i];
        const c = chordAt(gs);
        const useFifth = i % 2 === 1 && r.chance(0.7);
        const pc = useFifth ? (c.rootPc + 7) % 12 : c.rootPc;
        out.push({ step: gs, dur: gl, midi: rootMidi(pc), vel: vel * (i === 0 ? 1 : 0.9) });
      }
    }
    return out;
  }

  /* ----- arpeggio (foreground only; Presence gates the mix) ----- */
  makeArp(P, meter, strength, energy, chordAt, r) {
    const out = [];
    const rate = 2;                                    // eighths only — no 16th sparkle
    if (this.arpShape == null || this.barInSection === 0) {
      this.arpShape = r.pick(['up', 'down', 'updown', 'weave']);
    }
    let k = 0;
    for (let s = 0; s < meter.steps; s += rate) {
      const dens = 0.4 + energy * 0.35 + P.complexity * 0.15;
      if (!r.chance(dens)) { k++; continue; }
      const chord = chordAt(s);
      const pool = [];
      const top = Math.min(80, P.melCeil + 4);
      for (let m = 58; m <= top; m++) {
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
      out.push({ step: s, dur: rate * 0.8, midi: pool[idx],
                 vel: clamp(0.18 + energy * 0.2 + (strength[s] >= 2 ? 0.06 : 0), 0.08, 0.45) });
      k++;
    }
    return out;
  }

  /* ----- percussion: shaker + soft hat + rare kick-thump ----- */
  makePerc(P, meter, energy, swing, r) {
    const out = [];
    const push = (type, step, vel) =>
      out.push({ voice: 'perc', type, step: clamp(step, 0, meter.steps - 0.05), vel });
    for (const [gs] of meter.groups) {
      if (r.chance(0.6)) push('shaker', gs, 0.16 + energy * 0.12);
    }
    if (energy > P.percGate + 0.05) {
      for (let s = 2; s < meter.steps; s += 4) {
        if (r.chance(0.45)) push('hat', swing(s), 0.1 + energy * 0.12);
      }
    }
    if (energy > P.percGate + 0.12 && r.chance(0.25)) push('thump', 0, 0.3);
    return out;
  }

  /* ----- pad voicing with smooth voice-leading (verbatim) ----- */
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
