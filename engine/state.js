/* ---------------------------------------------------------------------
   Shared audio-engine state.

   The graph, voices and render code all read/write these while an offline
   render is in flight. ES modules can't reassign an imported binding across
   files, so the state lives on ONE object shared by reference; the split
   modules mutate its properties (A.ctx, A.fast, …). No logic change — this is
   just the home for what used to be module-level `let`s in the monolith.
--------------------------------------------------------------------- */
export const A = {
  ctx: null,               // active (Offline)AudioContext during a render
  nodes: null,             // buses & master chain
  noiseBuf: null,          // shared seeded noise buffer
  audioSeed: 1,            // seeds the noise buffer + reverb impulse (deterministic)
  agen: Math.random,       // seeded generator, set per buildGraph
  reverbSeconds: 3.2,      // convolver IR length (Fast mode shortens it)
  reverbMono: false,       // Fast mode uses a mono IR (cheaper convolution)
  fast: false,             // Fast mode: thinner instruments (fewer oscillators)

  // Frozen params for the current render. renderSong()/auditionVoice() set this
  // before building the offline graph; the instrument + mix code reads it.
  // There is NO live tuning — the whole song is pre-rendered.
  params: {
    tempo: 96, key: 'random', mode: 'auto', meter: '4/4', lengthSec: 180, arc: 'arch',
    complexity: 0.55, variety: 0.40, gravity: 0.60, wanderlust: 0.30, shadow: 0.25,
    humanity: 0.50, fractality: 0.60, hocket: 0.20, sparkle: 0.30, tide: 0.35, swing: 0,
    mix: { lead: 0.80, counter: 0.55, pad: 0.65, arp: 0.50, bass: 0.75, perc: 0.60 },
    leadTimbre: 'glass', padTimbre: 'warm',
    reverb: 0.45, echo: 0.30, master: 0.80, seed: 1207,
  },
};

export function readParams() { return A.params; }
