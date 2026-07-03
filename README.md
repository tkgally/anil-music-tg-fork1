# Daysong — a unique generative song, just for you, today

A React port of the original **Fable** prototype. Daysong composes music with pure
Web Audio — no samples, no libraries — inventing motifs and developing them
(transposition, inversion, retrograde), harmonizing with functional
progressions, modulating, and shaping a whole piece along a chosen narrative
arc. Every seed is a different piece.

## How it works: render → encode → play (no live tuning)

There is **no on-the-fly tuning**. You set the knobs and hit **Generate**:

1. **Compose + render offline.** The whole song (length capped at **5 min**) is
   composed bar-by-bar and rendered *faster than realtime* through
   `OfflineAudioContext`s into an `AudioBuffer` — the real convolution reverb and
   every instrument are used exactly as in the original (nothing swapped).
2. **Capture the visualization.** The same pass records the piano-roll **JSON**
   (every note's time/dur/midi/voice + the key/chord/section cues), kept in memory.
3. **Encode in memory.** The buffer is encoded to the chosen format — a radio of
   **Opus (default)**, **MP3**, **WebM** — and held as a Blob.
4. **Play the encoded song.** Playback is the encoded Blob via an `<audio>`
   element; the piano-roll animates from the JSON and the waveform from a live
   analyser. **Download** saves the encoded file.

Change any knob and **Regenerate** to hear it. `space` = play / pause.

## Making it fast

A single long offline render is **O(duration²)**: finished Web-Audio nodes aren't
freed mid-render (`onended` fires only afterwards), so every node ever scheduled
is processed for the whole render. The fixes (all sound-preserving):

- **Segmented render.** The song is rendered in ~12 s segments, each in its own
  `OfflineAudioContext`, then stitched. This makes cost ~linear (a big win that
  grows with length). Each segment renders with a **pre-roll** so reverb / echo /
  filter tails crossing a seam are correct. (Workers can't help — `OfflineAudioContext`
  isn't available in Workers — so segments render in **concurrent batches on the
  main thread**; the browser runs each `startRendering()` on its own thread.)
- **Seeded audio RNG.** Oscillator detune + the noise/reverb-impulse buffers are
  seeded (not `Math.random`), so a note sounds identical in any segment — seams
  are bit-exact for deterministic voices — **and renders are fully reproducible**.
- **Integer-sample seams** so stitched segments tile with no drift.
- **44.1 kHz** render; **recipe cache** (switching format re-encodes without
  re-rendering; regenerating an identical recipe is instant).

### Fast render (quality option)

A **Fast render** toggle trades a little fidelity for **~3–4×** speed — good for
auditioning, then switch it off for the final. It's `renderSong(params, { fast:true })`
and bundles:

- **24 kHz** internal rate (rolls off above ~12 kHz — sample rate is the dominant
  cost lever: on its own 44.1k→24k is ~2.8×),
- a **mono, 1.4 s** reverb impulse (vs stereo 3.2 s),
- **thinner voices** (pads use 2 saws instead of 3–4 and drop their modulation
  LFOs; counterpoint drops its octave partial) and **no safety limiter**.

High vs Fast are cached separately, so you can A/B them without a re-render.

## Encoding (all faster than realtime)

- **Opus** (`.opus`) — **WebCodecs `AudioEncoder`** → hand-written **Ogg** muxer.
- **WebM** (`.webm`) — WebCodecs → `webm-muxer`.
- **MP3** (`.mp3`) — **`wasm-media-encoders`** (WASM LAME, **stereo**), ≈ 3× faster
  than pure-JS `lamejs`. (`vmsg` was rejected: its LAME build is mono-only.)

Each WebCodecs output is validated with `decodeAudioData`; anything unavailable
falls back gracefully (MediaRecorder → lossless **WAV**; MP3 → `lamejs`). Typical
speeds (in-browser): Opus ~24×, WebM ~25×, MP3 ~12× realtime.

**Bitrate follows the render's bandwidth.** A Fast (24 kHz) render has nothing
above ~12 kHz, so the encoder drops from 160→96 kbps (Opus/WebM) and 192→128 kbps
(MP3) with no audible loss — **~40% smaller files** (and Opus, which then encodes in
its native super-wideband mode instead of fullband, is also ~1.8× faster). High
mode stays at full bitrate. It's automatic, keyed off `buffer.sampleRate`.

## Run it

Served by a dumb static server (no build step, everything is CDN):

```bash
cd /mnt/music
miniserve .            # if installed
# or
python3 -m http.server 8000
```

Then open <http://localhost:8000/> (or the folder's URL if you serve a parent).

## One URL == one song

Routing is hash-based (works on any static host):

- `#/song/<seed>?<params>` — the **seed is the song's identity in the path**;
  every other knob (tempo, key, mode, meter, arc, the character sliders, the
  ensemble mix, timbres, space) is encoded in the query. A link therefore
  fully reproduces a piece — bookmark it, share it (the **Share** button copies
  it), or hand-edit it. Same seed + same settings = the same piece.
- `#/about` — a real second route; browser back/forward moves between it and
  the studio.
- `#/roster` — the **voice roster**: every instrument Daysong can synthesize,
  grouped (lead / pad / rhythm / percussion). Tap a card to hear a short
  characteristic phrase on that voice (tap again to stop). It uses
  `engine.auditionVoice({ voice, timbre })`, which renders the phrase through
  the *exact* same voice + master chain a full render uses — so it's a faithful
  preview, not a separate mock. This is the palette we grow when adding voices.

`space` toggles play/stop. Everything can be tweaked while it plays.

## Files

| File | What it is |
|------|-----------|
| `index.html` | React + daisyUI (light theme) CDN shell. Maps `engine` in the importmap. |
| `engine/`    | The synth, split into focused ES modules (see below). **DOM-free.** |
| `app.jsx`    | React UI: transport, control panels, meters, the dark viz "stage", tooltips, and the hash router. |

### The `engine/` modules

`engine/engine.js` is a thin **barrel** that re-exports the public API, so the
importmap and `app.jsx` never change. Internals:

| Module | Responsibility |
|--------|----------------|
| `composer.js` | `composeSong` + the `Composer` — pure, deterministic composition. |
| `render.js` | `renderSong` / `renderSegment` / `auditionVoice` — offline audio core. |
| `state.js` | the one shared audio-state object `A` (ctx, nodes, params, flags). |
| `graph.js` | master chain, reverb/echo, per-voice buses, mixes. |
| `voices.js` | the instruments (`play*`) — **add new voices here.** |
| `encoders.js` | `bufferToWav` / `encodeSong` (+ opus/mp3/webm codecs & muxers). |
| `viz.js` | `fitCanvas` / `drawViz` / `cueAt`. |
| `rng.js` / `theory.js` | seeded RNG + math; scales, meters, arcs, rhythm. |

The split was done under a **golden-master safety net** (see Tests): the
composition and audio outputs are byte/fingerprint-identical to the pre-split
monolith.

## Tests

A tiny zero-dependency harness (`engine/testkit.js`) — no framework — that runs
under **Node** or in a **browser** (`test.browser(...)` cases auto-skip without
Web Audio). Convention: `foo.js` is tested by `foo-test.js`.

```bash
node engine/tests.mjs          # pure suites (rng, theory, composer, wav, cueAt)
# browser suites (render, voices, encode): serve the repo, open engine/tests.html
# regenerate baselines:  node engine/composer-test.js --record  /  tests.html?record
```

- **composer** is locked bit-exact (rounded 1e-6 so V8 `Math.*` ULP noise is
  cross-environment stable).
- **render / voices** compare a perceptual fingerprint (peak / RMS / 16-window
  RMS envelope) within tolerance, because Web Audio's offline render is *not*
  bit-reproducible (echo/convolver tails vary ~1e-9 run-to-run).

## Reactization notes

- **Light chrome, dark stage.** UI chrome (header, panels, footer) is daisyUI
  `data-theme="light"`. The visualization canvas — the content surface the
  prototype is *about* — stays dark, as allowed by `prototypes/AGENTS.md`.
- The engine keeps all music/audio logic byte-for-byte; only the DOM wiring
  (reading `<input>`s, writing readouts, the tooltip system, event listeners)
  moved into React.
- No `node_modules`, no build: React 18 + Babel-standalone + Tailwind Play CDN
  + daisyUI, all from a CDN.
