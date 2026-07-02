# Fable — agent instructions

**Fable** is an autonomous generative music synthesizer: a self-contained,
no-build web app that composes a whole piece with pure Web Audio, renders it
offline to an `AudioBuffer`, encodes it in-memory (Opus / MP3 / WebM), and plays
it back. Reactized from the original prototype; the repo is `anilgulecha/music`.

Read this file **and** `METALEARNINGS.md` at the start of a session, and apply
both pre-emptively.

## Ground rules (inherited from the prototypes charter)

1. **No `node_modules/`, no build step.** Everything is pulled from a CDN at
   runtime — React 18, Babel standalone (in-browser JSX), Tailwind Play CDN +
   daisyUI, lucide icons, and the audio codecs (`webm-muxer`, `wasm-media-encoders`,
   `@breezystack/lamejs`). Tooling (Playwright/Chromium, miniserve) is **global**,
   resolved via `npm root -g` in test scripts.
2. **Light chrome, dark stage.** UI chrome defaults to daisyUI `data-theme="light"`.
   The visualization canvas — the content surface the app is *about* — may stay dark.
3. **One URL = one song.** Hash routing (static-host friendly): the **seed lives in
   the path** (`#/song/<seed>`), every knob in the query; plus `#/about` and
   `#/roster`. A link fully reproduces a piece. Round-trip the URL (read on load +
   `hashchange`, write with `history.replaceState`).
4. **Served with a dumb static server** (`miniserve .` or `python3 -m http.server`),
   because module imports and codec fetches need `http://`, not `file://`.
5. **Self-documenting.** Keep `README.md` current when structure or behavior changes.

## Repo layout

```
index.html   CDN shell + importmap ("engine" -> ./engine/engine.js)
app.jsx      React UI: transport, panels, viz stage, hash router, roster
engine/      the synth, split into focused ES modules + its test suite
README.md    what it is + how it works + how to test
```

## The engine (`engine/`)

`engine/engine.js` is a thin **barrel** — the only thing the importmap and
`app.jsx` know about. Internals:

- `composer.js` — `Composer` + `composeSong`; **pure & deterministic**.
- `render.js` — `renderSong` / `renderSegment` / `auditionVoice` (offline core).
- `state.js` — the one shared audio-state object `A` (ctx, nodes, params, flags).
- `graph.js` — master chain, reverb/echo, per-voice buses, mixes.
- `voices.js` — the instruments (`play*`). **New instruments go here.**
- `encoders.js` — `bufferToWav` / `encodeSong` (+ opus/mp3/webm codecs, muxers).
- `viz.js` — `fitCanvas` / `drawViz` / `cueAt`.
- `rng.js`, `theory.js` — seeded RNG + math; scales, meters, arcs, rhythm.

Model & rules:

- **Render → encode → play.** No live tuning; set knobs → *Generate* → the whole
  piece (≤ 5 min) is rendered offline, encoded once, then played. Change a knob →
  *Regenerate*. Determinism comes from seeded RNG (`mulberry32`, `noteRnd`) — same
  seed + settings ⇒ same piece.
- **Treat the sound as sacred.** The musical/composition/audio math is preserved
  byte-for-byte; only touch the I/O boundary. The one sanctioned exception is an
  **explicitly opted-in** quality trade (the Fast toggle): 24 kHz + lighter
  reverb + thinned voices + bandwidth-matched bitrate, ~3–4× faster.
- **Adding a voice** = a new `play*` in `voices.js` (+ a `leadTimbre`/`padTimbre`
  option or perc type). It automatically gets a `/roster` card and a golden
  fingerprint. Previews (roster) run through the **real** engine, never a mock.

## Tests (`engine/*-test.js`)

A **golden-master safety net** guards every change. Framework-free harness
(`engine/testkit.js`) that runs under **Node** or in a **browser**; `foo.js` is
tested by `foo-test.js`; `test.browser(...)` cases auto-skip without Web Audio.

```bash
node engine/tests.mjs         # pure suites (rng, theory, composer, wav, cueAt)
# browser suites (render, voices, encode): serve, open engine/tests.html (live progress)
node engine/composer-test.js --record   # re-record a node golden
#   tests.html?record                    # re-record the browser goldens
```

Invariants (these are the *reason* the refactor was safe — keep them green):

- **composer** is locked **bit-exact** (rounded 1e-6, so V8 `Math.*` ULP noise is
  cross-environment stable).
- **render / voices** compare a **perceptual fingerprint** (peak / RMS / windowed
  envelope) within tolerance — Web Audio's offline render is *not* bit-reproducible
  (echo/convolver tails vary ~1e-9 run-to-run).

Before refactoring anything: confirm green, move in small steps, confirm green,
commit. If a change to a voice is *intended*, re-record the golden and say so.

## METALEARNINGS.md

`METALEARNINGS.md` holds the **generalized principles** inferred from human
feedback on this project — the things the human turned out to care about (often
not stated up front), written as **portable rules, not a task log**. After a
correction, work out what it *generalizes to* and record it there; load it
alongside this file and apply it pre-emptively. Inferring and updating it is the
agent's job, not something to wait to be asked for.

## Deploy

`.github/workflows/pages.yml` publishes to GitHub Pages. **The repo is private on
a free plan, so Pages is disabled** (and that workflow fails on push) — resolve
hosting before relying on it: make it public, upgrade to Pro, or point a
free static host (Cloudflare Pages / Netlify / Vercel) at the private repo.
