# Five studio prototypes — background music for working brains

Five self-contained explorations of what Daysong's studio could become if it
aimed at **background music for coders and other knowledge workers**. Each
folder is plain HTML/CSS/JS — no libraries, no build, no network — so you can
download a folder and open its `index.html` **directly from disk** (double-click;
`file://` works). Press play. `space` toggles. Every control applies live.

| # | Prototype | One line | Headline control |
|---|-----------|----------|------------------|
| 01 | **Tides** | A just-intoned drone chord over a fixed pedal, swelling like the sea; harmony drifts one voice at a time | Depth |
| 02 | **Drift** | Eno's *Music for Airports* trick as an editable instrument: a few soft tones, each looping on its own slow clock | Pace |
| 03 | **Pulse** | A soft clockwork ostinato (keys + octave-down canon) that rewrites itself one cell at a time | Energy |
| 04 | **Dust** | Fully-synthesized lo-fi beats: lazy swung drums, dark jazz chords, crackle and rain, no melody unless you ask | Dust |
| 05 | **Deep Work** | Daysong's own engine (chord walk, voices, motifs) folded behind one *presence* slider, with a work-session arc | Presence |

`index.html` at this folder's root is a hub linking all five.

## What the five have in common

- **Two-level controls** (Tom's suggestion): a Simple panel — preset chips, one
  full-width headline macro, a handful of plain-English sliders — and an
  **Advanced** disclosure with the full set. The successful focus products
  (Brain.fm, Endel) all converge on "mode picker + one knob + play"; the mixer
  products that work (myNoise, Noisli) survive by putting presets *above* the
  mixer. These prototypes do both.
- **Background-first defaults**: melody sparse/soft/capped ≈ C5, mix centered
  on bass and midrange, high frequencies quiet, gentle glue compression, no
  fills, no climaxes, nothing enters suddenly. Repetition is generous;
  evolution happens one small step at a time, tens of seconds apart.
- **Live parameters, endless play** — there is no *Generate* button. This is
  the biggest architectural difference from Daysong's render→encode→play
  studio, chosen deliberately so you can *feel* a control while the music
  plays. (Trade-off notes below.)
- **Deterministic**: seeded RNG everywhere (`mulberry32`, as in Daysong). The
  default seed is **today's date** (YYMMDD) — everyone hears the same piece on
  the same day, a nod to Daysong's name+date idea and a hedge against
  habituation. The full state lives in the URL hash (and localStorage), so a
  link reproduces a piece exactly.
- **Hidden-tab safe**: lookahead scheduling with a 6 s horizon (12 s when the
  tab is hidden). Chrome throttles hidden-tab timers to 1 s — and only exempts
  tabs that are *audibly playing* from the harsher 1-wake/minute throttling —
  so the prototypes keep an always-audible bed and schedule far ahead. Music
  for coders lives in a background tab by definition; this matters more than
  it looks.

## Why these five

They sit on a deliberate spectrum from least to most stimulating:

```
Tides ── Drift ── Deep Work (adjustable) ── Pulse ── Dust
texture ──────────────────────────────────────── groove
```

The research (below) says the right level of stimulation depends on the task
and the listener — complex work wants near-texture; routine work tolerates and
often likes rhythm. Rather than guess, the set spans the axis, and Deep Work
puts the axis on a single slider.

Each also explores a different **generative paradigm**:

1. **Tides — the zero-melody extreme.** Five detuned-saw drone voices tuned in
   just intonation over a fixed pedal (small-integer ratios beat slowly and
   consonantly — it's why drone stacks sound *deep* rather than chorused; an
   Advanced toggle lets you A/B against equal temperament). Three slow LFOs at
   unrelated periods (~26/41/63 s) breathe the filter, level and stereo tilt.
   Chords change by *voice-leading glides*: one voice at a time, ~35 s per full
   change — harmony as weather, not progression. Optional "voice-masking" foam
   re-shapes the texture layer into the speech band (250 Hz–4 kHz) to blunt
   nearby conversation — the one focus feature with solid evidence behind it.
2. **Drift — repetition without staleness.** N single-tone loops with
   incommensurate periods (seeded around the documented *Music for Airports*
   loop lengths, ~18–34 s). Every element repeats exactly; only the alignment
   evolves. The Advanced "studio" is a layer table (note / period / level / pan
   per loop) plus a live **repeat horizon** readout (LCM of the periods —
   Eno's three loops ≈ 27 days; tape-drift jitter makes it *never*). The orbit
   visualization makes the whole idea legible in one glance.
3. **Pulse — gradual evolution made literal.** One 16-step pattern, soft FM
   keys plus an octave-down canon three steps behind, bass and a pad haze.
   Every ~25 s exactly one seeded mutation (re-pitch / rest-toggle / swap)
   rewrites the pattern; you never catch the moment, but half an hour later
   it's somewhere new. Freeze/nudge give the listener control over evolution
   itself — a control no commercial product exposes.
4. **Dust — the genre benchmark.** What people actually play while coding,
   rebuilt from oscillators: 76 BPM, 57% swing, rim-click backbeat, rootless
   m9/maj9 voicings on an FM Rhodes through tape wow/flutter, sparse vinyl
   pops over hiss, decorrelated rain. The design lesson it demonstrates: lo-fi
   is mostly *subtraction* — lowpass everything, no fills, no hook. Melody
   exists but defaults to **zero**.
5. **Deep Work — the answer to "how would Daysong do this?".** A live port of
   the actual engine pieces (DEG_NEXT chord walk, `voiceChord` voice-leading,
   motif develop, the voices) retuned: melody register 48–67, density halved,
   fractality ≈ 0.85, sparkle removed, pad louder than lead, modulation off by
   default. One **Presence** slider (background ↔ foreground) drives ~10 engine
   parameters at once — at 100 it sounds like Daysong's studio, at 15 it's a
   pad-led drift — and Advanced shows the live mapping table, so the fold from
   full studio to one knob is inspectable. Plus session shapes (endless / 25 /
   50 min with ramp-in, wind-down, a soft end chime) and an optional,
   honestly-labeled 16 Hz amplitude-modulation "focus pulse" (Brain.fm's
   approach; evidence mixed, strongest for ADHD-type listeners).

## What the research says (the short version)

Grounding for the defaults, from a literature/product sweep done for this
design (the details are worth discussing on the call):

- **Steady-state vs changing-state** is the load-bearing distinction
  (irrelevant-sound-effect literature): sound whose spectrum varies
  unpredictably token-to-token disrupts verbal working memory; repetitive,
  predictable sound barely does. Attention capture tracks *prediction error*,
  not loudness. Design consequence: predictability everywhere — regular meter,
  slow telegraphed change, one-thing-at-a-time evolution.
- **Lyrics are the most robust distractor** (silence > instrumental > vocal
  for reading/comprehension). Nothing here sings; even formant-like pad
  timbres are off by default.
- **Melodic salience** rises with register deviation, sharp onsets, brightness,
  and being isolated above the texture. Hence the C5 ceiling, soft attacks,
  and melody buried in the mix (or absent).
- **Background music is not a cognitive enhancer** — meta-analytically it's
  slightly negative for cognition, positive for mood/arousal, and it helps
  easy/automatized tasks while hurting hard ones. The honest pitch is mood and
  distraction-masking, matched to task difficulty — hence the stimulation
  spectrum rather than one "focus boost" claim.
- **Amplitude modulation** (Brain.fm): ~16 Hz periodic AM has real but
  vendor-heavy evidence, strongest for listeners with attention difficulties.
  Deep Work ships it as an off-by-default experiment with honest copy. The
  same literature warns that *irregular* AM is extra-distracting — if you
  modulate, modulate like clockwork.
- **Noise is population-specific** (helps ADHD-type listeners, hurts
  neurotypicals on average) → texture/noise layers are opt-in sliders, never
  the default core.
- **~45 dB is the sweet spot** for sustained attention; defaults are mixed
  quiet (≈ −22 dBFS RMS) and the volume slider is always visible.
- **Habituation erodes benefits** of any fixed piece → generative variety
  within a stable style; the date-seed gives a fresh-but-stable palette daily.
- **The delivery layer matters as much as the notes.** At quiet listening
  levels the ear loses bass and treble (equal-loudness contours), so a mix
  tuned loud sounds thin when played soft — every prototype adds a gentle
  bass/treble tilt as the volume slider falls. Presets are level-matched
  (±1.5 dB) so nobody "prefers" a preset for being louder. And since coders
  listen on headphones, nothing is statically hard-panned. For an all-day
  product, hearing dose is real: WHO's safe-listening line (~80 dB for
  40 h/week) is exactly the exposure profile of someone who codes to music —
  another argument for the quiet default and for session breaks.
- **What's culture-robust vs culture-specific.** The structural rules
  (predictability, no lyrics, slow evolution, steady spectra, low-register
  roughness avoidance) travel across cultures; chord *vocabulary* (lo-fi's
  maj7/m9 grammar, major-key warmth) is a learned aesthetic. Worth remembering
  for an international audience: the texture-first prototypes (01/02) lean on
  the universal layer, the genre prototype (04) on the learned one.
- Product landscape: every successful tool is "pick a mode, press play, one
  intensity knob"; every surviving mixer hides itself behind presets. The
  two-level design follows directly. (`musicforprogramming.net`'s curation
  manifesto — drones, textures without rhythm, minor complex chords, very few
  drums, walls of reverb — reads like a spec for prototypes 01/02.)

## The objective "listening test"

`tools/verify.mjs` loads a prototype from `file://` in headless Chromium,
presses play, records the mix, and reports: RMS level and 1-second level
spread, spectral centroid, % energy above 2 k/5 kHz, salient-onset rate,
longest near-silence, plus console errors. Each prototype was tuned against
targets (e.g. Tides: centroid < 900 Hz, zero strong onsets; Dust: centroid
< 1300 Hz despite drums). It's a crude ear, but it makes "less prominent
melody, midrange forward, no sudden events" *checkable*:

```bash
node studio-prototypes/tools/verify.mjs studio-prototypes/01-tides 30
```

(Requires the globally-installed Playwright the repo already uses for tests.)

## Trade-offs worth discussing with Anil

- **Live scheduling vs Daysong's render→encode→play.** Live wins for a
  background tool (endless play, instant control response, no wait) but gives
  up: encode/download, the O(duration) render trick, and exact
  reproducibility-as-a-file. A hybrid is plausible: Daysong's offline renderer
  for *songs*, this live scheduler for an *ambient/focus mode* — they can share
  the composer and voices.
- **One macro vs many original knobs.** Deep Work's presence mapping shows one
  way to keep the expressive parameter space while presenting one knob; the
  "pinning" behavior (hand-moved Advanced sliders detach from the macro) is a
  possible convention for the main studio.
- **What repeats?** The five differ mainly in the unit of repetition (drone /
  loop / pattern / groove / motif). Which feels best over a multi-hour session
  is exactly what these builds are for evaluating.
- **Session shapes** (25/50-min arcs, wind-down chime) — cheap to add to any
  engine, and the product research says timers are table stakes in this
  category.
- **Interruption behavior** (not built here): what should the music do when a
  video call grabs the tab's audio focus, or a notification fires? A
  duck-and-recover pattern, and a considered "re-entry" after pauses, are open
  design questions a real product would need. Likewise loudness metering
  (LUFS-style) inside the engine so *generated* output is level-managed the
  way mastered releases are.

## Repo notes

- These prototypes deliberately deviate from the repo's CDN-shell convention:
  they must run from `file://` with zero network, so everything is inline and
  classic-script. They don't touch the app or engine; `engine/` code was
  *adapted into* 05 (and idioms borrowed everywhere) rather than imported.
- Everything is seeded and deterministic except unavoidable Web-Audio-level
  jitter; two runs with the same URL produce the same piece.
