/* =====================================================================
   FABLE - autonomous generative synthesizer  (public entry / barrel)

   Pure Web Audio. No samples, no libraries. The engine is split into focused
   peer modules; this file only re-exports the public API, so the importmap
   ("engine" -> engine/engine.js) and app.jsx (`import * as engine from
   "engine"`) never change.

     composer.js   composeSong                     (pure, deterministic)
     render.js     renderSong / renderSegment / auditionVoice   ← audio core
       ├ state.js    shared audio state object (A)
       ├ graph.js    master chain, reverb/echo, per-voice buses, mixes
       └ voices.js   the instruments (play*)        ← add new voices here
     encoders.js   bufferToWav / encodeSong (+ opus/mp3/webm codecs)
     viz.js        fitCanvas / drawViz / cueAt
     rng.js        seeded RNG + math utils
     theory.js     scales, meters, arcs, rhythm helpers
   ===================================================================== */
export { composeSong } from "./composer.js";
export { renderSegment, renderSong, auditionVoice } from "./render.js";
export { bufferToWav, encodeSong } from "./encoders.js";
export { fitCanvas, drawViz, cueAt } from "./viz.js";
