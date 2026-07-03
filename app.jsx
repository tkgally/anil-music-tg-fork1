// Daysong — a unique generative piece, composed just for you, today. (reactized)
//
// Model: NO live tuning. You set the knobs, hit Generate → the whole song is
// rendered offline into an AudioBuffer (+ a piano-roll JSON kept in memory),
// then encoded to the chosen format (opus / mp3 / webm) held in memory, then
// played back from that encoded blob with the visualization driven by the JSON.
// The song is downloadable. The URL (seed in the path + every knob) is the recipe.

import React, { useState, useEffect, useRef, useLayoutEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  Play,
  Pause,
  Download,
  RefreshCw,
  Dices,
  Sparkles,
  Info,
  Music4,
  ArrowLeft,
  Link as LinkIcon,
  Wand2,
  AudioLines,
  Coffee,
  SkipBack,
  SkipForward,
  Star,
  SlidersHorizontal,
  UserX,
  Check,
} from "https://esm.sh/lucide-react@0.460.0?external=react";
import * as engine from "engine";

/* ---------------------------------------------------------------------
   Option lists (mirror the original <select>s)
--------------------------------------------------------------------- */
const KEY_OPTS = [
  ["random", "Random"], ["0", "C"], ["1", "C♯"], ["2", "D"], ["3", "E♭"],
  ["4", "E"], ["5", "F"], ["6", "F♯"], ["7", "G"], ["8", "A♭"], ["9", "A"],
  ["10", "B♭"], ["11", "B"],
];
const MODE_OPTS = [
  ["auto", "Auto"], ["ionian", "Ionian (major)"], ["dorian", "Dorian"],
  ["phrygian", "Phrygian"], ["lydian", "Lydian"], ["mixolydian", "Mixolydian"],
  ["aeolian", "Aeolian (minor)"], ["harmonicMinor", "Harmonic minor"],
  ["melodicMinor", "Melodic minor"],
];
const METER_OPTS = [["4/4", "4/4"], ["3/4", "3/4"], ["6/8", "6/8"], ["5/4", "5/4"], ["7/8", "7/8"]];
const ARC_OPTS = [
  ["arch", "Arch — rise & fall"], ["ascent", "Ascent — ever upward"],
  ["waves", "Waves — tides of tension"], ["still", "Stillness — quiet plateau"],
  ["plunge", "Plunge — bright to dark"], ["twinPeaks", "Twin peaks — two climaxes"],
  ["valley", "Valley — bright edges, dark heart"], ["staircase", "Staircase — rising in steps"],
  ["sawtooth", "Sawtooth — build, break, rebuild"], ["slowBurn", "Slow burn — patience, then fire"],
];
const LEAD_OPTS = [
  ["glass", "Glass (FM bell)"], ["reed", "Reed (filtered saw)"], ["breath", "Breath (flute-ish)"],
  ["keys", "Keys (electric piano)"], ["brass", "Brass (swelling saw)"],
  ["organ", "Organ (drawbars)"], ["pure", "Pure (sine)"],
  ["bansuri", "Bansuri (bamboo flute)"], ["whistle", "Whistle"], ["santoor", "Santoor (hammered)"],
  ["sarangi", "Sarangi (bowed)"], ["shehnai", "Shehnai (double-reed)"], ["harmonium", "Harmonium (reed organ)"],
];
const PAD_OPTS = [
  ["warm", "Warm (analog)"], ["halo", "Halo (glass air)"], ["choir", "Choir (vowel formants)"],
  ["strings", "Strings (ensemble)"], ["hollow", "Hollow (woody dark)"],
  ["tanpura", "Tanpura (drone)"],
];

/* ---------------------------------------------------------------------
   Control layout (the four panels)
--------------------------------------------------------------------- */
const GROUPS = [
  {
    title: "Essence",
    controls: [
      { k: "tempo", type: "range", label: "Tempo", help: "Beats per minute", min: 40, max: 180, step: 1 },
      { k: "key", type: "select", label: "Key", help: "Home key — the music may wander but is drawn back here", options: KEY_OPTS },
      { k: "mode", type: "select", label: "Mode", help: "The scale color of the home key", options: MODE_OPTS },
      { k: "meter", type: "select", label: "Meter", help: "Time signature — odd meters give the rhythm a limp and a lilt", options: METER_OPTS },
      { k: "length", type: "range", label: "Length", help: "Length of the piece (up to 5 minutes)", min: 20, max: 300, step: 5 },
      { k: "arc", type: "select", label: "Arc", help: "The narrative shape of tension over the whole piece", options: ARC_OPTS },
      { k: "seed", type: "seed", label: "Seed", help: "Random seed — same seed + same settings = same piece" },
    ],
  },
  {
    title: "Character",
    controls: [
      { k: "complexity", type: "range", label: "Complexity", help: "Rhythmic subdivision, harmonic density, busyness of all voices" },
      { k: "variety", type: "range", label: "Tonal variety", help: "Tonal variety — adventurous chords, distant modulations, richer scale colors" },
      { k: "gravity", type: "range", label: "Gravity", help: "ORIGINAL — how strongly melodies are pulled toward the tonal center; low values float free" },
      { k: "wanderlust", type: "range", label: "Wanderlust", help: "ORIGINAL — the urge to modulate to new keys at section boundaries" },
      { k: "shadow", type: "range", label: "Shadow", help: "ORIGINAL — borrowed chords, secondary dominants and chromatic passing tones that darken the harmony" },
      { k: "fractality", type: "range", label: "Fractality", help: "ORIGINAL — motivic self-similarity: how often the music develops its own themes (transposed, inverted, reversed) rather than inventing new material" },
      { k: "hocket", type: "range", label: "Hocket", help: "ORIGINAL — medieval interlocking: the counter-voice sings in the gaps the melody leaves" },
      { k: "sparkle", type: "range", label: "Sparkle", help: "ORIGINAL — grace notes, ornaments and octave glints scattered over the surface" },
      { k: "tide", type: "range", label: "Tide", help: "ORIGINAL — slow swells of brightness and dynamics, like breathing on a long cycle" },
      { k: "humanity", type: "range", label: "Humanity", help: "Timing looseness, velocity variation and slight detuning — a machine pretending to breathe" },
      { k: "swing", type: "range", label: "Swing", help: "Shuffle feel on offbeats (ignored in compound meters)" },
    ],
  },
  {
    title: "Ensemble",
    controls: [
      { k: "mixLead", type: "range", label: "Lead", help: "The main melodic voice" },
      { k: "leadTimbre", type: "select", label: "voice", help: "Timbre of the lead voice", options: LEAD_OPTS, sub: true },
      { k: "mixCounter", type: "range", label: "Counterpoint", help: "A second voice in counterpoint with the lead" },
      { k: "mixPad", type: "range", label: "Pads", help: "Sustained harmony beneath everything" },
      { k: "padTimbre", type: "select", label: "voice", help: "Timbre of the pad", options: PAD_OPTS, sub: true },
      { k: "mixArp", type: "range", label: "Arpeggio", help: "A rippling broken-chord pattern" },
      { k: "mixBass", type: "range", label: "Bass", help: "The foundation voice" },
      { k: "mixPerc", type: "range", label: "Percussion", help: "Synthesized drums — they only enter when the music has enough energy" },
    ],
  },
  {
    title: "Space",
    controls: [
      { k: "reverb", type: "range", label: "Reverb", help: "A generated hall — the room the ensemble plays in" },
      { k: "echo", type: "range", label: "Echo", help: "Tempo-synced dotted-eighth echo on lead and arpeggio" },
      { k: "master", type: "range", label: "Volume", help: "Master volume" },
    ],
    note:
      "Daysong composes the whole piece up front: it invents motifs, develops them by " +
      "transposition, inversion and retrograde, harmonizes with functional progressions " +
      "(with borrowed shadows and secondary dominants), modulates when wanderlust strikes, " +
      "and shapes the arc you choose. Set the knobs, then Generate — the song is rendered " +
      "and encoded once, then played back. Every seed is a different piece.",
  },
];

/* ---------------------------------------------------------------------
   Defaults + param <-> engine + URL round-trip
--------------------------------------------------------------------- */
const DEFAULTS = {
  tempo: 96, key: "random", mode: "auto", meter: "4/4", length: 180, arc: "arch",
  complexity: 55, variety: 40, gravity: 60, wanderlust: 30, shadow: 25,
  fractality: 60, hocket: 20, sparkle: 30, tide: 35, humanity: 50, swing: 0,
  mixLead: 80, mixCounter: 55, mixPad: 65, mixArp: 50, mixBass: 75, mixPerc: 60,
  leadTimbre: "glass", padTimbre: "warm",
  reverb: 45, echo: 30, master: 80,
};
const PARAM_KEYS = Object.keys(DEFAULTS);
const TEXT_KEYS = new Set(["key", "mode", "meter", "arc", "leadTimbre", "padTimbre"]);
const FORMATS = [["opus", "Opus"], ["mp3", "MP3"], ["webm", "WebM"]];

const randomSeed = () => Math.floor(Math.random() * 999999) + 1;
const clampPct = (x) => Math.min(100, Math.max(0, x));

function fmtTime(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m + ":" + String(s).padStart(2, "0");
}
function formatVal(k, v) {
  if (k === "tempo") return v + " bpm";
  if (k === "length") return fmtTime(Number(v));
  return v + "%";
}
function fmtSize(bytes) {
  if (!bytes) return "—";
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return Math.round(bytes / 1024) + " KB";
}

// React params (raw slider units) -> engine params (0..1 mixes etc.)
function toEngine(p, seed) {
  const n = (k) => Number(p[k]);
  return {
    tempo: n("tempo"), key: p.key, mode: p.mode, meter: p.meter,
    lengthSec: n("length"),
    arc: p.arc,
    complexity: n("complexity") / 100, variety: n("variety") / 100, gravity: n("gravity") / 100,
    wanderlust: n("wanderlust") / 100, shadow: n("shadow") / 100, humanity: n("humanity") / 100,
    fractality: n("fractality") / 100, hocket: n("hocket") / 100, sparkle: n("sparkle") / 100,
    tide: n("tide") / 100, swing: n("swing") / 100,
    mix: {
      lead: n("mixLead") / 100, counter: n("mixCounter") / 100, pad: n("mixPad") / 100,
      arp: n("mixArp") / 100, bass: n("mixBass") / 100, perc: n("mixPerc") / 100,
    },
    leadTimbre: p.leadTimbre, padTimbre: p.padTimbre,
    reverb: n("reverb") / 100, echo: n("echo") / 100, master: n("master") / 100,
    seed: Number(seed) || 1,
  };
}

/* ---- hash routing ----
   #/                          landing (asks your name; remembers it)
   #/:name/:date               the day's playlist  (date = YYMMDD)
   #/:name/:date/:four-words   one song of that playlist, alone
   #/p/:four-words             a shared song (playlist stays private)
   #/studio, #/song/:seed?...  the original studio (legacy URLs keep working)
   #/roster  #/about                                                        */
function parseHash() {
  const hash = location.hash.replace(/^#/, "");
  const [path, queryStr = ""] = hash.split("?");
  const segs = path.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  if (segs.length === 0) return { route: "landing" };
  const s0 = segs[0].toLowerCase();
  if (s0 === "about") return { route: "about" };
  if (s0 === "roster") return { route: "roster" };
  if (s0 === "p" && segs[1]) return { route: "shared", words: segs[1].toLowerCase() };
  if (s0 === "stars") return { route: "stars" };
  if (s0 === "studio" || s0 === "song") {
    const seedSeg = s0 === "song" ? segs[1] : null;
    const q = new URLSearchParams(queryStr);
    const params = { ...DEFAULTS };
    for (const k of PARAM_KEYS) {
      if (q.has(k)) params[k] = TEXT_KEYS.has(k) ? q.get(k) : Number(q.get(k));
    }
    const seed = seedSeg != null && seedSeg !== "" ? Number(seedSeg) : randomSeed();
    return { route: "studio", params, seed };
  }
  if (segs.length >= 2 && /^\d{6}$/.test(segs[1])) {
    return {
      route: "day", name: engine.normalizeName(s0), date: segs[1],
      words: segs[2] ? segs[2].toLowerCase() : null,
    };
  }
  return { route: "landing" };
}
function songHash(seed, params) {
  const q = new URLSearchParams();
  for (const k of PARAM_KEYS) q.set(k, String(params[k]));
  return `#/song/${seed}?${q.toString()}`;
}

/* ---------------------------------------------------------------------
   Instant tooltips (light popover, viewport-clamped)
--------------------------------------------------------------------- */
function Tooltips() {
  const [tip, setTip] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    const onOver = (e) => {
      const el = e.target.closest ? e.target.closest("[data-help]") : null;
      if (!el) { setTip(null); return; }
      setTip({ text: el.getAttribute("data-help"), rect: el.getBoundingClientRect() });
    };
    const onOut = (e) => { if (e.target.closest && e.target.closest("[data-help]")) setTip(null); };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    return () => { document.removeEventListener("mouseover", onOver); document.removeEventListener("mouseout", onOut); };
  }, []);
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const el = ref.current, tw = el.offsetWidth, th = el.offsetHeight, r = tip.rect;
    let x = r.left, y = r.bottom + 8;
    if (x + tw > window.innerWidth - 8) x = window.innerWidth - tw - 8;
    if (x < 8) x = 8;
    if (y + th > window.innerHeight - 8) y = r.top - th - 8;
    el.style.left = x + "px"; el.style.top = y + "px";
  }, [tip]);
  if (!tip) return null;
  return (
    <div ref={ref} className="fixed z-50 max-w-[280px] rounded-lg border border-primary/30 bg-base-100 px-3 py-2 text-xs leading-relaxed shadow-xl pointer-events-none" style={{ left: -9999, top: -9999 }}>
      {tip.text}
    </div>
  );
}

/* ---------------------------------------------------------------------
   Controls
--------------------------------------------------------------------- */
function Slider({ ctrl, value, onChange }) {
  return (
    <div className="grid grid-cols-[92px_1fr_52px] items-center gap-2.5 mb-2">
      <label data-help={ctrl.help} className="text-xs cursor-help truncate">{ctrl.label}</label>
      <input type="range" className="range range-xs range-primary" min={ctrl.min ?? 0} max={ctrl.max ?? 100} step={ctrl.step ?? 1}
        value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output className="text-[11px] text-base-content/60 text-right tabular-nums">{formatVal(ctrl.k, value)}</output>
    </div>
  );
}
function Selectbox({ ctrl, value, onChange }) {
  return (
    <div className="grid grid-cols-[92px_1fr] items-center gap-2.5 mb-2">
      <label data-help={ctrl.help} className="text-xs cursor-help truncate">{ctrl.sub ? "\u00a0\u00a0voice" : ctrl.label}</label>
      <select className="select select-bordered select-xs w-full" value={value} onChange={(e) => onChange(e.target.value)}>
        {ctrl.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}
function SeedRow({ ctrl, seed, setSeed }) {
  return (
    <div className="grid grid-cols-[92px_1fr_auto] items-center gap-2.5 mb-2">
      <label data-help={ctrl.help} className="text-xs cursor-help truncate">{ctrl.label}</label>
      <input type="number" min="1" max="999999" step="1" className="input input-bordered input-xs w-full"
        value={seed} onChange={(e) => setSeed(Number(e.target.value) || 1)} />
      <button data-help="Roll a new seed" className="btn btn-ghost btn-xs" onClick={() => setSeed(randomSeed())}>
        <Dices size={14} />
      </button>
    </div>
  );
}
function ControlGroup({ group, params, setParam, seed, setSeed }) {
  return (
    <div className="card bg-base-100 border border-base-300 shadow-sm">
      <div className="card-body p-4">
        <h2 className="text-[11px] tracking-[0.3em] uppercase text-base-content/50 mb-2">{group.title}</h2>
        {group.controls.map((ctrl) => {
          if (ctrl.type === "seed") return <SeedRow key={ctrl.k} ctrl={ctrl} seed={seed} setSeed={setSeed} />;
          if (ctrl.type === "select") return <Selectbox key={ctrl.k} ctrl={ctrl} value={params[ctrl.k]} onChange={(v) => setParam(ctrl.k, v)} />;
          return <Slider key={ctrl.k} ctrl={ctrl} value={params[ctrl.k]} onChange={(v) => setParam(ctrl.k, v)} />;
        })}
        {group.note && <p className="mt-3 text-[11.5px] leading-relaxed text-base-content/60">{group.note}</p>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------
   Meters (clock + scrubber + readouts) — polls the <audio> element
--------------------------------------------------------------------- */
function Meters({ audioRef, song, idleLen }) {
  const [, force] = useState(0);
  useEffect(() => {
    let raf;
    const loop = () => { force((n) => (n + 1) % 1e9); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const a = audioRef.current;
  const now = song && a ? a.currentTime : 0;
  const dur = song ? song.duration : idleLen;
  const cue = song ? engine.cueAt(song.displayCues, now) : { key: "—", chord: "—", section: "—" };
  const pct = dur ? clampPct((now / dur) * 100) : 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm tabular-nums tracking-wide w-[92px]">{fmtTime(now)} / {fmtTime(dur)}</span>
        <input
          type="range" className="range range-xs range-primary flex-1" min={0} max={Math.max(1, dur)} step={0.01}
          value={Math.min(now, dur)} disabled={!song}
          onChange={(e) => { if (a) a.currentTime = Number(e.target.value); }}
        />
      </div>
      <div className="flex gap-2 flex-wrap">
        <span data-help="Current key & mode" className="badge badge-outline badge-sm text-primary min-w-[52px]">{cue.key}</span>
        <span data-help="Current chord" className="badge badge-outline badge-sm text-secondary min-w-[52px]">{cue.chord}</span>
        <span data-help="Current section" className="badge badge-outline badge-sm text-accent min-w-[52px]">{cue.section}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------
   Visualization — the dark "stage"; drawn each rAF from the JSON notes
--------------------------------------------------------------------- */
// A monotonic progress bar that eases toward the real value and gently creeps
// between updates, so long gaps (a batch of segments finishing at once) don't
// look frozen. Never runs more than ~6% ahead of the truth.
function SmoothProgress({ target, label, sub, compact }) {
  const [disp, setDisp] = useState(0);
  const tRef = useRef(target);
  tRef.current = target;
  useEffect(() => {
    let raf, last = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      setDisp((d) => {
        const t = tRef.current;
        const cap = Math.min(0.995, t + 0.06);
        let nd = d + (t - d) * Math.min(1, dt * 4);       // catch up when behind
        if (nd < cap) nd = Math.min(cap, nd + dt * 0.02);  // creep so it never stalls
        return Math.max(d, nd);                             // monotonic
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => { if (target >= 1) setDisp(1); }, [target]);
  if (compact) return <progress className="progress progress-primary progress-xs w-full" value={disp} max="1" />;
  return (
    <div className="flex flex-col items-center gap-2 w-64">
      <span className="text-xs tracking-[0.25em] uppercase">{label} {Math.round(disp * 100)}%</span>
      <progress className="progress progress-primary w-full" value={disp} max="1" />
      {sub && <span className="text-[10px] text-white/40">{sub}</span>}
    </div>
  );
}

function Viz({ song, audioRef, analyserRef, phase, prog, seg, format }) {
  const ref = useRef(null);
  const notes = song ? song.notes : null;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let cx = engine.fitCanvas(canvas);
    const onResize = () => { cx = engine.fitCanvas(canvas); };
    window.addEventListener("resize", onResize);
    let raf;
    const loop = () => {
      const a = audioRef.current;
      const now = a ? a.currentTime : 0;
      const playing = !!(a && !a.paused && !a.ended);
      engine.drawViz(canvas, cx, { notes: notes || [], now, analyser: analyserRef.current, playing });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, [notes]);

  let overlay = null;
  if (phase === "composing") {
    overlay = <div className="flex flex-col items-center gap-3 text-white/60"><span className="loading loading-ring loading-lg" /><span className="text-xs tracking-[0.25em] uppercase">Composing…</span></div>;
  } else if (phase === "rendering") {
    overlay = (
      <div className="text-white/70">
        <SmoothProgress key="r" target={prog} label="Rendering…"
          sub={seg && seg.total ? `${seg.done} / ${seg.total} segments · rendered in parallel` : "rendering the whole song"} />
      </div>
    );
  } else if (phase === "encoding") {
    overlay = (
      <div className="text-white/70">
        <SmoothProgress key="e" target={prog} label={`Encoding ${format.toUpperCase()}…`}
          sub="encoding in memory" />
      </div>
    );
  } else if (!song) {
    overlay = <div className="text-xs tracking-[0.3em] uppercase text-white/40">press generate — the machine will compose the whole song</div>;
  }

  return (
    <div className="relative h-full w-full rounded-xl overflow-hidden border border-base-300" style={{ background: "linear-gradient(180deg,#0b0e14,#121826)" }}>
      <canvas ref={ref} className="block w-full h-full" />
      {overlay && <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-4 text-center">{overlay}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------
   Transport / generate column (left side of the top region)
--------------------------------------------------------------------- */
function Transport({
  format, setFormat, quality, setQuality, phase, prog, song, dirty,
  onGenerate, onTogglePlay, playing, audioRef, idleLen,
  onSurprise, onShare, copied,
}) {
  const busy = phase === "composing" || phase === "rendering" || phase === "encoding";
  const busyLabel = phase === "composing" ? "Composing…" : phase === "rendering" ? "Rendering…" : "Encoding…";
  return (
    <div className="flex flex-col gap-3 md:w-[380px] shrink-0">
      {/* brand */}
      <div className="flex items-center gap-2.5">
        <Music4 size={20} className="text-primary" />
        <div className="leading-none">
          <h1 className="text-lg font-bold tracking-[0.4em] bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">DAYSONG</h1>
          <p className="text-[9px] tracking-[0.18em] uppercase text-base-content/50 mt-1">a unique song, just for today</p>
        </div>
        <a href="#/roster" className="btn btn-ghost btn-xs btn-square ml-auto" data-help="Voice roster — hear every instrument"><AudioLines size={15} /></a>
        <a href="#/about" className="btn btn-ghost btn-xs btn-square" data-help="About Daysong"><Info size={15} /></a>
      </div>

      {/* format + generate */}
      <div className="flex items-center gap-2">
        <div className="join" data-help="Encoding format held in memory (also used for Download)">
          {FORMATS.map(([f, label]) => (
            <button key={f} className={`join-item btn btn-xs ${format === f ? "btn-primary" : "btn-ghost border border-base-300"}`}
              onClick={() => setFormat(f)} disabled={busy}>{label}</button>
          ))}
        </div>
        <button className={`btn btn-sm gap-2 flex-1 ${dirty || !song ? "btn-primary" : "btn-outline"}`} onClick={onGenerate} disabled={busy}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : (song ? <RefreshCw size={15} /> : <Wand2 size={15} />)}
          {busy ? busyLabel : (song ? "Regenerate" : "Generate")}
        </button>
      </div>
      {busy
        ? <SmoothProgress key={phase} target={prog} compact />
        : (
          <label className="flex items-center gap-2 text-[11px] text-base-content/60 cursor-pointer self-start"
            data-help="Fast render: ~3–4× faster for a subtle quality trade — 24 kHz internal rate (top ~12 kHz rolled off), a lighter (mono, shorter) reverb, and thinner pad/counter voices. Great for auditioning; switch off for the final render.">
            <input type="checkbox" className="toggle toggle-xs toggle-primary"
              checked={quality === "fast"} onChange={(e) => setQuality(e.target.checked ? "fast" : "high")} />
            <span>Fast render <span className="opacity-60">~3–4×, subtle quality trade</span></span>
          </label>
        )}

      {/* transport (ready) */}
      <div className="flex items-center gap-2 min-h-8">
        <button className={`btn btn-sm gap-2 ${playing ? "btn-error" : "btn-primary"}`} onClick={onTogglePlay} disabled={!song}>
          {playing ? <Pause size={16} /> : <Play size={16} />}{playing ? "Pause" : "Play"}
        </button>
        {song ? (
          <a className="btn btn-ghost btn-sm gap-1.5" href={song.url} download={`daysong-${song.seed}.${song.ext}`} data-help="Download the encoded song">
            <Download size={15} /> Download
          </a>
        ) : (
          <span className="text-[11px] text-base-content/40">Generate to render &amp; encode the whole song</span>
        )}
        {song && (
          <span className="badge badge-ghost badge-sm ml-auto tabular-nums" data-help={song.fallback ? "Chosen codec unavailable — saved as WAV" : song.mime}>
            {song.ext.toUpperCase()} · {fmtSize(song.size)}
          </span>
        )}
      </div>

      {/* clock + scrubber + readouts */}
      <Meters audioRef={audioRef} song={song} idleLen={idleLen} />

      {/* actions */}
      <div className="flex items-center gap-2 flex-wrap mt-auto pt-1">
        <button data-help="Randomize the character of the music (then Generate)" className="btn btn-ghost btn-sm gap-1.5" onClick={onSurprise} disabled={busy}>
          <Sparkles size={15} /> Surprise me
        </button>
        <button data-help="Copy this song's URL — seed + every setting, one link" className="btn btn-ghost btn-sm gap-1.5" onClick={onShare}>
          <LinkIcon size={15} /> {copied ? "Copied!" : "Share"}
        </button>
        <span className="text-[10px] text-base-content/40 ml-auto self-center">space = play/pause</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------
   Studio — owns params + seed + the render/encode/playback lifecycle
--------------------------------------------------------------------- */
function Studio({ params, setParams, seed, setSeed }) {
  const [format, setFormat] = useState("opus");
  const [quality, setQuality] = useState("high");  // high | fast
  const [phase, setPhase] = useState("idle");      // idle | composing | rendering | encoding | ready
  const [prog, setProg] = useState(0);
  const [seg, setSeg] = useState(null);            // { done, total } during rendering
  const [song, setSong] = useState(null);          // { url, mime, ext, size, notes, displayCues, duration, seed, format, fallback }
  const [dirty, setDirty] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [copied, setCopied] = useState(false);

  const audioRef = useRef(null);
  const analyserRef = useRef(null);
  const acRef = useRef(null);
  const renderCacheRef = useRef({ key: null, data: null });   // last rendered buffer (big)
  const encCacheRef = useRef(new Map());                      // encoded blobs by recipe+format

  const setParam = (k, v) => setParams((p) => ({ ...p, [k]: v }));

  // mark the generated song stale when the recipe, format or quality changes
  useEffect(() => { if (phase === "ready") setDirty(true); }, [params, seed, format, quality]);

  // attach an analyser to the <audio> element for the live waveform
  useEffect(() => {
    if (!song || !audioRef.current) return;
    let srcNode, ac;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ac = new AC();
      srcNode = ac.createMediaElementSource(audioRef.current);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      srcNode.connect(analyser);
      analyser.connect(ac.destination);
      analyserRef.current = analyser;
      acRef.current = ac;
    } catch (e) { analyserRef.current = null; }
    return () => {
      try { srcNode && srcNode.disconnect(); } catch (_) {}
      try { ac && ac.close(); } catch (_) {}
      analyserRef.current = null; acRef.current = null;
    };
  }, [song && song.url]);

  const generate = async () => {
    if (["composing", "rendering", "encoding"].includes(phase)) return;
    if (audioRef.current) audioRef.current.pause();
    setPlaying(false); setDirty(false);

    const rk = JSON.stringify(toEngine(params, seed)) + "::" + quality;   // render recipe
    const ek = rk + "::" + format;                                        // + encode format
    try {
      let enc = encCacheRef.current.get(ek);
      if (!enc) {
        let rendered = renderCacheRef.current.key === rk ? renderCacheRef.current.data : null;
        if (!rendered) {
          setSong(null); setPhase("composing"); setProg(0); setSeg(null);
          rendered = await engine.renderSong(toEngine(params, seed), {
            fast: quality === "fast",
            onProgress: ({ phase: ph, progress, done, total }) => {
              setPhase(ph); setProg(progress || 0);
              if (total) setSeg({ done, total });
            },
          });
          renderCacheRef.current = { key: rk, data: rendered };
        }
        setPhase("encoding"); setProg(0);
        const out = await engine.encodeSong(rendered.audioBuffer, format, {
          onProgress: ({ progress }) => setProg(progress),
        });
        enc = { ...out, notes: rendered.notes, displayCues: rendered.displayCues, duration: rendered.duration, seed };
        encCacheRef.current.set(ek, enc);
      }
      setSong({ ...enc, format });
      setPhase("ready");
    } catch (e) {
      console.error("[daysong] generate failed", e);
      setPhase("idle");
    }
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (acRef.current && acRef.current.state === "suspended") acRef.current.resume();
    if (a.paused) a.play(); else a.pause();
  };

  // spacebar → play/pause (once a song exists)
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== "Space") return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(tag)) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const surprise = () => {
    const R = (a, b) => Math.round(a + Math.random() * (b - a));
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    setParams((p) => ({
      ...p,
      tempo: R(60, 150),
      key: String(Math.floor(Math.random() * 12)),
      mode: pick(["ionian", "dorian", "phrygian", "lydian", "mixolydian", "aeolian", "harmonicMinor", "melodicMinor"]),
      meter: pick(["4/4", "4/4", "4/4", "3/4", "6/8", "5/4", "7/8"]),
      arc: pick(["arch", "ascent", "waves", "still", "plunge", "twinPeaks", "valley", "staircase", "sawtooth", "slowBurn"]),
      complexity: R(25, 90), variety: R(15, 85), gravity: R(30, 85), wanderlust: R(5, 70),
      shadow: R(0, 70), humanity: R(30, 80), fractality: R(30, 90), hocket: R(0, 70),
      sparkle: R(10, 70), tide: R(10, 80), swing: Math.random() < 0.3 ? R(20, 60) : 0,
      mixLead: R(55, 95), mixCounter: Math.random() < 0.2 ? 0 : R(30, 80), mixPad: R(35, 85),
      mixArp: Math.random() < 0.2 ? 0 : R(25, 80), mixBass: R(50, 90),
      mixPerc: Math.random() < 0.25 ? 0 : R(35, 85),
      leadTimbre: pick(["glass", "reed", "breath", "keys", "brass", "organ", "pure", "bansuri", "whistle", "santoor", "sarangi", "shehnai", "harmonium"]),
      padTimbre: pick(["warm", "halo", "choir", "strings", "hollow"]),
      reverb: R(25, 70), echo: R(5, 55),
    }));
    setSeed(randomSeed());
  };

  const share = async () => {
    const url = location.origin + location.pathname + songHash(seed, params);
    try { await navigator.clipboard.writeText(url); } catch (_) {}
    setCopied(true); setTimeout(() => setCopied(false), 1400);
  };

  const busy = phase === "composing" || phase === "rendering" || phase === "encoding";

  return (
    <div className="h-screen w-full flex flex-col">
      {/* TOP — thin region: transport/actions (left) + visualization (right) */}
      <section className="flex flex-col md:flex-row gap-4 p-3 border-b border-base-300 shrink-0 md:h-[268px]">
        <Transport
          format={format} setFormat={setFormat} quality={quality} setQuality={setQuality}
          phase={phase} prog={prog} song={song} dirty={dirty}
          onGenerate={generate} onTogglePlay={togglePlay} playing={playing} audioRef={audioRef} idleLen={Number(params.length)}
          onSurprise={surprise} onShare={share} copied={copied}
        />
        <div className="flex-1 min-w-0 h-[190px] md:h-auto">
          <Viz song={song} audioRef={audioRef} analyserRef={analyserRef} phase={phase} prog={prog} seg={seg} format={format} />
        </div>
      </section>

      {/* BOTTOM — the four control sections (frozen while rendering/encoding) */}
      <main className={`flex-1 min-h-0 overflow-y-auto grid gap-4 p-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 items-start content-start ${busy ? "opacity-60 pointer-events-none" : ""}`}>
        {GROUPS.map((g) => (
          <ControlGroup key={g.title} group={g} params={params} setParam={setParam} seed={seed} setSeed={setSeed} />
        ))}
      </main>

      {/* hidden player: keyed by url so each new song gets a fresh element/source */}
      {song && (
        <audio
          key={song.url}
          ref={audioRef}
          src={song.url}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   Voice roster — hear every existing instrument on its own (#/roster)
--------------------------------------------------------------------- */
const ROSTER = [
  {
    group: "Lead voices",
    blurb: "The main melodic line — pick one as the lead in the studio.",
    items: [
      { id: "lead-glass",  voice: "lead", timbre: "glass",  name: "Glass",  tag: "FM bell",        desc: "Bright metallic bell with a glassy shimmer (FM synthesis)." },
      { id: "lead-reed",   voice: "lead", timbre: "reed",   name: "Reed",   tag: "filtered saw",   desc: "A woody, reedy tone — sawtooth through a swept lowpass, with vibrato." },
      { id: "lead-breath", voice: "lead", timbre: "breath", name: "Breath", tag: "flute-ish",      desc: "Airy and hollow — twin oscillators plus breath noise and vibrato." },
      { id: "lead-keys",   voice: "lead", timbre: "keys",   name: "Keys",   tag: "electric piano", desc: "An FM electric piano with a bell-like tine — a Rhodes." },
      { id: "lead-brass",  voice: "lead", timbre: "brass",  name: "Brass",  tag: "swelling saw",   desc: "Detuned saws that swell in with a filter sweep — a brass section." },
      { id: "lead-organ",  voice: "lead", timbre: "organ",  name: "Organ",  tag: "drawbars",       desc: "Additive drawbar organ — stacked harmonic partials." },
      { id: "lead-pure",    voice: "lead", timbre: "pure",    name: "Pure",    tag: "sine",            desc: "A clean sine with gentle vibrato — the simplest voice." },
      { id: "lead-bansuri", voice: "lead", timbre: "bansuri", name: "Bansuri", tag: "bamboo flute",    desc: "Breathy bamboo flute — a near-pure tone with an airy chiff, blooming vibrato, and a meend scoop into each note." },
      { id: "lead-whistle", voice: "lead", timbre: "whistle", name: "Whistle", tag: "pure + air",       desc: "A human whistle — an almost-pure tone with faint breath, wide vibrato, and a gentle slide into each note." },
      { id: "lead-santoor", voice: "lead", timbre: "santoor", name: "Santoor", tag: "hammered dulcimer", desc: "Bright, metallic struck strings with beating detuned pairs and a long shimmering ring — the Kashmiri dulcimer." },
      { id: "lead-sarangi", voice: "lead", timbre: "sarangi", name: "Sarangi", tag: "bowed, vocal",      desc: "The most vocal of bowed strings — a large meend, expressive vibrato, and a vowel formant for that singing quality." },
      { id: "lead-shehnai", voice: "lead", timbre: "shehnai", name: "Shehnai", tag: "double-reed",       desc: "Bright, nasal and penetrating — a reedy double-reed with a nasal formant and reedy vibrato." },
      { id: "lead-harmonium", voice: "lead", timbre: "harmonium", name: "Harmonium", tag: "reed organ",  desc: "A sustained reed organ — stacked sawtooth reeds with a gentle bellows shimmer." },
    ],
  },
  {
    group: "Pad voices",
    blurb: "Sustained harmony under everything — pick one as the pad in the studio.",
    items: [
      { id: "pad-warm",    voice: "pad", timbre: "warm",    name: "Warm",    tag: "analog",         desc: "Three detuned saws — a warm, wide analog wash." },
      { id: "pad-halo",    voice: "pad", timbre: "halo",    name: "Halo",    tag: "glass air",      desc: "Triangle plus an octave shimmer — glassy air." },
      { id: "pad-choir",   voice: "pad", timbre: "choir",   name: "Choir",   tag: "vowel formants", desc: "Saws shaped by vowel formants — an ‘aah’ choir." },
      { id: "pad-strings", voice: "pad", timbre: "strings", name: "Strings", tag: "ensemble",       desc: "Four detuned saws with a slow bowing LFO — a string section." },
      { id: "pad-hollow",  voice: "pad", timbre: "hollow",  name: "Hollow",  tag: "woody dark",     desc: "Square plus triangle — dark, woody and hollow." },
      { id: "pad-tanpura", voice: "pad", timbre: "tanpura", name: "Tanpura", tag: "drone",          desc: "The cyclic four-string drone (Pa–Sa–Sa–Sa) — each string a rich plucked harmonic stack with jivari buzz." },
    ],
  },
  {
    group: "Rhythm & inner voices",
    blurb: "The supporting cast, shaped by the mix sliders.",
    items: [
      { id: "bass",    voice: "bass",    name: "Bass",         tag: "sub + saw",       desc: "A sub sine plus a saw through a lowpass — the foundation." },
      { id: "arp",     voice: "arp",     name: "Arpeggio",     tag: "resonant square", desc: "A rippling broken-chord pattern on a resonant square." },
      { id: "counter", voice: "counter", name: "Counterpoint", tag: "triangle",        desc: "A second voice that sings against the lead." },
    ],
  },
  {
    group: "Percussion",
    blurb: "Synthesized drums — noise plus tuned tones. In a piece they only enter with enough energy.",
    items: [
      { id: "perc-kick",    voice: "perc", timbre: "kick",    name: "Kick",     tag: "pitched thump",    desc: "A pitch-dropping sine with a noise click." },
      { id: "perc-snare",   voice: "perc", timbre: "snare",   name: "Snare",    tag: "noise + tone",     desc: "A filtered noise burst over a short tuned tone." },
      { id: "perc-hat",     voice: "perc", timbre: "hat",     name: "Hi-hat",   tag: "closed",          desc: "A short, bright tick of highpassed noise." },
      { id: "perc-hatOpen", voice: "perc", timbre: "hatOpen", name: "Open hat", tag: "sizzle",          desc: "The same, held longer — an open sizzle." },
      { id: "perc-shaker",  voice: "perc", timbre: "shaker",  name: "Shaker",   tag: "bandpassed noise", desc: "A soft, breathy shaker — bandpassed noise." },
      { id: "perc-tabla",   voice: "perc", timbre: "tabla",   name: "Tabla",    tag: "teental theka",    desc: "Dayan + bayan — a 16-beat teental groove of na / tin / ge strokes, with the bayan’s sliding gham." },
    ],
  },
];

function Roster({ backHash }) {
  const acRef = useRef(null);
  const srcRef = useRef(null);
  const [busyId, setBusyId] = useState(null);
  const [playingId, setPlayingId] = useState(null);

  function stopCurrent() {
    if (srcRef.current) { try { srcRef.current.onended = null; srcRef.current.stop(); } catch (e) {} srcRef.current = null; }
    setPlayingId(null);
  }
  useEffect(() => () => { stopCurrent(); if (acRef.current) acRef.current.close().catch(() => {}); }, []);

  async function play(item) {
    if (playingId === item.id) { stopCurrent(); return; }   // tap again to stop
    let ac = acRef.current;
    if (!ac) ac = acRef.current = new (window.AudioContext || window.webkitAudioContext)();
    await ac.resume();
    stopCurrent();
    setBusyId(item.id);
    let buf;
    try {
      buf = await engine.auditionVoice({ voice: item.voice, timbre: item.timbre }, { sampleRate: ac.sampleRate });
    } catch (e) { console.error(e); setBusyId(null); return; }
    setBusyId(null);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.onended = () => { if (srcRef.current === src) { srcRef.current = null; setPlayingId(null); } };
    srcRef.current = src;
    setPlayingId(item.id);
    src.start();
  }

  return (
    <div className="max-w-4xl mx-auto px-5 py-8">
      <a href={backHash} className="btn btn-ghost btn-sm gap-1.5 mb-5"><ArrowLeft size={15} /> Back</a>
      <div className="flex items-center gap-3 mb-2">
        <AudioLines size={24} className="text-primary" />
        <h1 className="text-2xl font-bold tracking-[0.3em] bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">VOICE ROSTER</h1>
      </div>
      <p className="text-sm text-base-content/60 mb-8 max-w-2xl">
        Every instrument Daysong can synthesize today — no samples, all Web Audio. Tap a card to hear a short
        phrase on that voice (tap again to stop). This is the full palette.
      </p>

      {ROSTER.map((section) => (
        <section key={section.group} className="mb-9">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-base-content/50 mb-1">{section.group}</h2>
          <p className="text-xs text-base-content/40 mb-3">{section.blurb}</p>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {section.items.map((item) => {
              const isBusy = busyId === item.id;
              const isPlaying = playingId === item.id;
              return (
                <button key={item.id} onClick={() => play(item)}
                  data-state={isBusy ? "busy" : isPlaying ? "playing" : "idle"}
                  aria-pressed={isPlaying}
                  className={`text-left rounded-xl border p-3 transition-colors ${isPlaying ? "border-primary bg-primary/5" : "border-base-300 bg-base-100 hover:border-primary/50 hover:bg-base-200/40"}`}>
                  <div className="flex items-center gap-2.5">
                    <span className={`flex items-center justify-center w-8 h-8 rounded-full shrink-0 ${isPlaying ? "bg-primary text-primary-content" : "bg-base-200 text-base-content/70"}`}>
                      {isBusy ? <span className="loading loading-spinner loading-xs" /> : isPlaying ? <Pause size={15} /> : <Play size={15} />}
                    </span>
                    <div className="flex items-baseline gap-1.5 min-w-0">
                      <span className="font-semibold text-sm">{item.name}</span>
                      <span className="text-[10px] uppercase tracking-wide text-base-content/40 truncate">{item.tag}</span>
                    </div>
                  </div>
                  <p className="text-xs text-base-content/55 mt-2 leading-snug">{item.desc}</p>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------
   About page
--------------------------------------------------------------------- */
function About({ backHash }) {
  return (
    <div className="max-w-2xl mx-auto px-5 py-10">
      <a href={backHash} className="btn btn-ghost btn-sm gap-1.5 mb-6"><ArrowLeft size={15} /> Back</a>
      <div className="flex items-center gap-3 mb-4">
        <Music4 size={26} className="text-primary" />
        <h1 className="text-2xl font-bold tracking-[0.35em] bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">DAYSONG</h1>
      </div>
      <div className="prose prose-sm max-w-none text-base-content/80 space-y-3">
        <p>
          <strong>Daysong</strong> is an autonomous generative synthesizer — a unique piece,
          composed just for you, today. It composes the whole piece
          up front with pure Web Audio — no samples, no libraries — inventing motifs and developing
          them by transposition, inversion and retrograde, harmonizing with functional progressions
          (with borrowed shadows and secondary dominants), modulating when wanderlust strikes, and
          shaping the arc you choose.
        </p>
        <p>
          <strong>Render, don't stream.</strong> Set the knobs and hit <em>Generate</em>: the entire
          song (up to 5 minutes) is rendered offline into audio, encoded in memory to your chosen
          format (<strong>Opus</strong>, <strong>MP3</strong> or <strong>WebM</strong>), then played
          back — with the piano-roll visualization driven from the note data captured during the
          render. There is no on-the-fly tuning; change a knob and Regenerate to hear it. You can
          Download the encoded file.
        </p>
        <p>
          <strong>One URL is one song.</strong> Four words from a frozen 1024-word list encode a
          complete song (<code>#/p/happy-silver-context-imagine</code>) — tempo, key, mode, voices,
          arc, energy and seed, all tuned toward bright, good-mood music. And{" "}
          <strong>your name + today's date make a playlist</strong>: <code>#/&lt;name&gt;/&lt;yymmdd&gt;</code>{" "}
          derives the same twelve songs on any device, forever — no server, no accounts. Songs bake
          (render + encode) right in your browser, then play. <kbd className="kbd kbd-sm">space</kbd>{" "}
          plays / pauses.
        </p>
        <p>
          The original <a className="link" href="#/studio">studio</a> with every raw knob
          (<code>#/song/&lt;seed&gt;?…</code>) is still here for tinkering.
        </p>
        <p className="text-base-content/50">
          Reactized (React 18 + daisyUI, light chrome, CDN-only, no build step) from the original
          Fable prototype. The composition + audio engine is unchanged in <code>engine.js</code>; only the I/O
          boundary (offline render + encode) is new.
        </p>
      </div>
    </div>
  );
}

/* =====================================================================
   THE DAY EXPERIENCE
   #/:name/:date is a playlist of twelve songs derived from your name and
   the date — the same twelve on any device, forever. Songs bake (fast
   render + opus encode) in the browser, cache in IndexedDB, and play as
   soon as the first one lands. The page wears your colors: background
   hue from the name, accent hue from the date.
   ===================================================================== */
const NAME_LS = "daysong.name";
const BAKE_V = "fast|opus|v2";   // bumped with codec v2: same words = a different song now
const keyOf = (s) => s.words.join("-");
const bakeKey = (s) => keyOf(s) + "|" + BAKE_V;

// ---- starred songs (localStorage; their bakes survive pruning) ----
const STARS_LS = "daysong.stars.v1";
const loadStars = () => { try { return JSON.parse(localStorage.getItem(STARS_LS) || "[]"); } catch (_) { return []; } };
const saveStars = (arr) => { try { localStorage.setItem(STARS_LS, JSON.stringify(arr)); } catch (_) {} };
function useStars() {
  const [stars, setStars] = useState(loadStars);
  const starredSet = useMemo(() => new Set(stars.map((s) => s.words)), [stars]);
  const toggleStar = (song) => {
    const w = Array.isArray(song.words) ? song.words.join("-") : song.words;
    setStars((prev) => {
      const has = prev.some((s) => s.words === w);
      const next = has ? prev.filter((s) => s.words !== w) : [...prev, { words: w, title: song.title, ts: Date.now() }];
      saveStars(next);
      return next;
    });
  };
  return { stars, starredSet, toggleStar };
}

// ---- tiny IndexedDB promise wrappers (store "songs", out-of-line keys) ----
let _dbP = null;
function idb() {
  if (!_dbP) _dbP = new Promise((res, rej) => {
    const req = indexedDB.open("daysong", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("songs");
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return _dbP;
}
async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const r = db.transaction("songs").objectStore("songs").get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
  } catch (_) { return null; }
}
async function idbPut(key, val) {
  try {
    const db = await idb();
    await new Promise((res) => {
      const tx = db.transaction("songs", "readwrite");
      tx.objectStore("songs").put(val, key);
      tx.oncomplete = res; tx.onerror = res;
    });
  } catch (_) {}
}
async function idbPrune(days = 2) {          // keep today + yesterday…
  try {
    const db = await idb();
    const cutoff = Date.now() - days * 864e5;
    const starred = new Set(loadStars().map((s) => s.words));   // …and starred bakes forever
    const st = db.transaction("songs", "readwrite").objectStore("songs");
    const req = st.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const words = String(c.key).split("|")[0];
      if (((c.value && c.value.ts) || 0) < cutoff && !starred.has(words)) c.delete();
      c.continue();
    };
  } catch (_) {}
}

// ---- little helpers ----
function prettyDate(yymmdd) {
  const d = new Date(2000 + +yymmdd.slice(0, 2), +yymmdd.slice(2, 4) - 1, +yymmdd.slice(4, 6));
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}
const greeting = () => { const h = new Date().getHours(); return h < 5 ? "good night" : h < 12 ? "good morning" : h < 17 ? "good afternoon" : "good evening"; };
const accentCss = (h) => `hsl(${h} 62% 40%)`;

/* The identity backdrop — breathes with the music (––pulse via rAF). */
function MoodBackdrop({ bgHue, accentHue, audioRef, tempo }) {
  const ref = useRef(null);
  useEffect(() => {
    let raf;
    const loop = () => {
      const el = ref.current, a = audioRef && audioRef.current;
      if (el) {
        const playing = !!(a && !a.paused && !a.ended);
        const t = a ? a.currentTime : 0;
        const beat = 0.5 + 0.5 * Math.sin(2 * Math.PI * t * ((tempo || 110) / 60) / 4);
        el.style.setProperty("--pulse", playing ? (0.25 + 0.75 * beat).toFixed(3) : "0");
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tempo]);
  return <div ref={ref} className="ds-backdrop" style={{ "--bgh": bgHue, "--ach": accentHue }} />;
}

/* The day pages' own light visualization — no dark stage. Translucent card
   over the identity backdrop; note colors are picked from the page's hues
   (accent family + the complement of the background wash). The studio keeps
   the original dark engine viz. */
function LightViz({ notes, audioRef, bgHue, accentHue, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let cx = engine.fitCanvas(canvas);
    const onResize = () => { cx = engine.fitCanvas(canvas); };
    window.addEventListener("resize", onResize);
    const comp = (bgHue + 180) % 360;                    // complement of the wash
    const COLORS = {
      lead:    `hsl(${accentHue} 62% 42%)`,
      counter: `hsl(${(accentHue + 40) % 360} 52% 52%)`,
      arp:     `hsl(${comp} 55% 52%)`,
      bass:    `hsl(${(comp + 30) % 360} 48% 42%)`,
      pad:     `hsl(${bgHue} 45% 62%)`,
      perc:    `hsl(${bgHue} 12% 55%)`,
    };
    let raf;
    const loop = () => {
      const a = audioRef.current;
      const now = a ? a.currentTime : 0;
      const playing = !!(a && !a.paused && !a.ended);
      const r = canvas.getBoundingClientRect();
      const W = r.width, H = r.height;
      cx.clearRect(0, 0, W, H);
      const pxPerSec = W / 18;
      const playheadX = W * 0.68;
      const midiToY = (m) => H - ((m - 30) / 66) * (H - 14) - 7;
      for (const n of notes || []) {
        const x = playheadX + (n.t - now) * pxPerSec;
        if (n.voice === "perc") {
          if (x < -4 || x > W + 4) continue;
          cx.globalAlpha = 0.45;
          cx.fillStyle = COLORS.perc;
          cx.beginPath(); cx.arc(x, H - 6, 1.4, 0, 7); cx.fill();
          cx.globalAlpha = 1;
          continue;
        }
        const w = Math.max(3, n.dur * pxPerSec - 2);
        if (x + w < 0 || x > W) continue;
        const y = midiToY(n.midi);
        const active = now >= n.t && now <= n.t + n.dur;
        const h = n.voice === "pad" ? 3 : active ? 5.5 : 4;
        cx.fillStyle = COLORS[n.voice] || COLORS.lead;
        cx.globalAlpha = active ? 0.95 : n.t > now ? 0.3 : 0.55;
        cx.beginPath();
        if (cx.roundRect) cx.roundRect(x, y - h / 2, w, h, h / 2); else cx.rect(x, y - h / 2, w, h);
        cx.fill();
        cx.globalAlpha = 1;
      }
      if (playing) {
        cx.fillStyle = `hsl(${accentHue} 60% 42% / 0.35)`;
        cx.fillRect(playheadX - 0.5, 4, 1, H - 8);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, [notes, bgHue, accentHue]);
  return (
    <div className={`rounded-2xl border border-white/60 bg-white/30 overflow-hidden ${className || ""}`}>
      <canvas ref={ref} className="block w-full h-full" />
    </div>
  );
}

/* Thin seek bar + clock for the solo song view. */
function MiniMeter({ audioRef, dur, accent }) {
  const [, force] = useState(0);
  useEffect(() => {
    let raf;
    const loop = () => { force((n) => (n + 1) % 1e9); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const a = audioRef.current;
  const now = a ? a.currentTime : 0;
  return (
    <div className="flex items-center gap-3 w-full">
      <span className="text-xs tabular-nums text-base-content/50 w-10 text-right">{fmtTime(now)}</span>
      <input
        type="range" min={0} max={Math.max(1, dur || 0)} step={0.01} value={Math.min(now, dur || 0)}
        onChange={(e) => { if (a) a.currentTime = Number(e.target.value); }}
        className="range range-xs flex-1" style={{ "--range-shdw": "none", accentColor: accent }}
      />
      <span className="text-xs tabular-nums text-base-content/50 w-10">{fmtTime(dur || 0)}</span>
    </div>
  );
}

const EqBars = ({ accent }) => (
  <span className="ds-eq inline-flex items-end gap-[2px] h-3.5" aria-label="playing">
    <span style={{ background: accent, height: "75%" }} /><span style={{ background: accent }} /><span style={{ background: accent, height: "60%" }} />
  </span>
);

/* ---------------------------------------------------------------------
   #/  — “Hi. What’s your name?”  (remembers you in localStorage)
--------------------------------------------------------------------- */
function Landing() {
  const [val, setVal] = useState("");
  const [hueName, setHueName] = useState("");   // debounced — colors settle after you stop typing
  const today = engine.dateCode();
  useEffect(() => {
    let saved = null;
    try { saved = localStorage.getItem(NAME_LS); } catch (_) {}
    if (saved) location.replace(location.href.split("#")[0] + `#/${saved}/${today}`);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setHueName(val), 550);
    return () => clearTimeout(t);
  }, [val]);
  const go = () => {
    const name = engine.normalizeName(val);
    try { localStorage.setItem(NAME_LS, name); } catch (_) {}
    location.hash = `#/${name}/${today}`;
  };
  const hues = engine.identityHues(hueName || "daysong", today);
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <MoodBackdrop bgHue={hues.bgHue} accentHue={hues.accentHue} audioRef={{ current: null }} />
      <div className="w-full max-w-md pb-16">
        <p className="ds-serif text-7xl font-light ds-up">Hi.</p>
        <p className="ds-serif text-3xl mt-6 text-base-content/70 ds-up" style={{ animationDelay: "0.35s" }}>
          What’s your name?
        </p>
        <div className="mt-9 ds-up" style={{ animationDelay: "0.7s" }}>
          <input
            autoFocus value={val} spellCheck={false} autoComplete="off" aria-label="your name"
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && engine.normalizeName(val) !== "friend") go(); }}
            placeholder="type it here…"
            className="ds-serif w-full bg-transparent text-4xl outline-none border-b-2 pb-2 placeholder:text-base-content/20"
            style={{ borderColor: accentCss(hues.accentHue), caretColor: accentCss(hues.accentHue) }}
          />
          <p className="mt-4 text-sm text-base-content/50">
            press <kbd className="kbd kbd-xs">enter</kbd> — your background work music, made for today.
          </p>
        </div>
        <p className="mt-16 ds-up flex gap-1.5 text-base-content/35" style={{ animationDelay: "1.1s" }}>
          <a className="btn btn-ghost btn-xs btn-square" href="#/about" data-help="About Daysong"><Info size={14} /></a>
          <a className="btn btn-ghost btn-xs btn-square" href="#/roster" data-help="The voices"><AudioLines size={14} /></a>
          <a className="btn btn-ghost btn-xs btn-square" href="#/studio" data-help="The studio — every raw knob"><SlidersHorizontal size={14} /></a>
          <a className="btn btn-ghost btn-xs btn-square" href="#/stars" data-help="Your starred songs"><Star size={14} /></a>
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------
   #/:name/:date(/:words)  — the day’s twelve + the solo song view.
   One component owns the bakery and the player, so music keeps playing
   while you move between the playlist and a song.
--------------------------------------------------------------------- */
function DayPage({ name, date, words }) {
  const songs = useMemo(() => engine.playlistFor(name, date), [name, date]);
  const hues = useMemo(() => engine.identityHues(name, date), [name, date]);
  const accent = accentCss(hues.accentHue);
  const seenKey = `daysong.seen.${name}.${date}`;
  const { starredSet, toggleStar } = useStars();
  const starBtn = (song, size = 15) => (
    <button
      className="btn btn-ghost btn-xs btn-square"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleStar(song); }}
      data-help={starredSet.has(keyOf(song)) ? "Unstar" : "Star — keep this song around"}
    >
      <Star size={size} style={starredSet.has(keyOf(song)) ? { fill: accent, color: accent } : { color: "currentColor", opacity: 0.45 }} />
    </button>
  );

  const [bakes, setBakesState] = useState({});
  const bakesRef = useRef({});
  const patchBake = (k, patch) => {
    bakesRef.current = { ...bakesRef.current, [k]: { ...(bakesRef.current[k] || {}), ...patch } };
    setBakesState(bakesRef.current);
  };
  const [currentIdx, setCurrentIdx] = useState(-1);
  const currentIdxRef = useRef(-1);
  useEffect(() => { currentIdxRef.current = currentIdx; }, [currentIdx]);
  const [playing, setPlaying] = useState(false);
  const [baking, setBaking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reveal, setReveal] = useState(() => {
    try { return localStorage.getItem(seenKey) ? "shown" : "creating"; } catch (_) { return "shown"; }
  });
  const audioRef = useRef(null);
  const qRef = useRef({ running: false, want: null });
  const wantPlayRef = useRef(false);
  const urlsRef = useRef([]);

  // first visit today: a short “composing your twelve” moment, then reveal
  useEffect(() => {
    if (reveal !== "creating") return;
    const t = setTimeout(() => {
      setReveal("shown");
      try { localStorage.setItem(seenKey, "1"); } catch (_) {}
    }, 2600);
    return () => clearTimeout(t);
  }, [reveal]);

  // hydrate from the IndexedDB cache (second visit plays without baking)
  useEffect(() => {
    let dead = false;
    idbPrune().catch(() => {});
    (async () => {
      for (const s of songs) {
        const rec = await idbGet(bakeKey(s));
        if (dead) return;
        if (!rec) continue;
        const url = URL.createObjectURL(rec.blob);
        urlsRef.current.push(url);
        patchBake(keyOf(s), { status: "ready", url, notes: rec.notes, displayCues: rec.displayCues, duration: rec.duration, ext: rec.ext });
        playIfWantReady();
      }
    })();
    return () => {
      dead = true;
      if (audioRef.current) audioRef.current.pause();
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
    };
  }, []);

  const bakeSong = async (i) => {
    const s = songs[i], k = keyOf(s);
    patchBake(k, { status: "baking", prog: 0 });
    // Someone is WAITING for the wanted song (first press / a clicked row):
    // bake it with full parallelism. Everything else bakes one segment at a
    // time so the CPU stays free for the user's actual work.
    const urgent = qRef.current.want === k;
    try {
      const rendered = await engine.renderSong(s.params, {
        fast: true,
        batch: urgent ? undefined : 1,
        onProgress: ({ progress }) => patchBake(k, { prog: progress || 0 }),
      });
      const enc = await engine.encodeSong(rendered.audioBuffer, "opus", { onProgress: () => {} });
      const rec = { blob: enc.blob, ext: enc.ext, notes: rendered.notes, displayCues: rendered.displayCues, duration: rendered.duration, ts: Date.now() };
      idbPut(bakeKey(s), rec);
      const url = URL.createObjectURL(enc.blob);
      urlsRef.current.push(url);
      patchBake(k, { status: "ready", prog: 1, url, notes: rec.notes, displayCues: rec.displayCues, duration: rec.duration, ext: rec.ext });
      playIfWantReady();
    } catch (e) {
      console.error("[daysong] bake failed:", s.title, e);
      patchBake(k, { status: "error" });
    }
  };

  // Honor a pending "play this when it's ready" — called after a bake lands,
  // after IDB hydration, and when the queue drains. (Without the hydration
  // call there's a race: press play before the cache loads and the queue
  // finds nothing to bake, so the wanted song would never start.)
  const playIfWantReady = () => {
    const w = qRef.current.want;
    if (!w) return;
    const i = songs.findIndex((s) => keyOf(s) === w);
    const st = bakesRef.current[w];
    if (i >= 0 && st && st.status === "ready") {
      qRef.current.want = null;
      wantPlayRef.current = true;
      setCurrentIdx(i);
    }
  };

  const runQueue = () => {
    if (qRef.current.running) return;
    qRef.current.running = true;
    setBaking(true);
    (async () => {
      try {
        for (;;) {
          const pending = songs.map((_, i) => i).filter((i) => {
            const st = bakesRef.current[keyOf(songs[i])];
            return !st || !st.status || st.status === "idle";
          });
          if (!pending.length) break;
          let next = pending[0];
          if (qRef.current.want) {
            const wi = songs.findIndex((s) => keyOf(s) === qRef.current.want);
            if (wi >= 0 && pending.includes(wi)) next = wi;
          }
          await bakeSong(next);
        }
        playIfWantReady();
      } finally {
        qRef.current.running = false;
        setBaking(false);
      }
    })();
  };

  const play = (i) => {
    const k = keyOf(songs[i]);
    const st = bakesRef.current[k];
    if (st && st.status === "ready") {
      if (i === currentIdxRef.current && audioRef.current) { audioRef.current.play().catch(() => {}); return; }
      qRef.current.want = null;
      wantPlayRef.current = true;
      setCurrentIdx(i);
    } else {
      qRef.current.want = k;
      setCurrentIdx(i);
      runQueue();
    }
  };

  const bakeAndPlay = () => {
    const firstReady = songs.findIndex((s) => (bakesRef.current[keyOf(s)] || {}).status === "ready");
    if (firstReady >= 0) play(firstReady);
    else qRef.current.want = keyOf(songs[0]);
    runQueue();
  };

  const cur = currentIdx >= 0 ? songs[currentIdx] : null;
  const curBake = cur ? bakes[keyOf(cur)] : null;
  const curUrl = curBake && curBake.status === "ready" ? curBake.url : null;

  // start playback once the wanted song's <audio> exists
  useEffect(() => {
    if (wantPlayRef.current && curUrl && audioRef.current) {
      wantPlayRef.current = false;
      audioRef.current.play().catch(() => {});
    }
  }, [curUrl, currentIdx]);

  // play ALL: when a song ends, move on — and after the twelfth, loop back to
  // the first, so the day's music just keeps going.
  const onEnded = () => {
    setPlaying(false);
    play((currentIdxRef.current + 1) % songs.length);
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (a) { if (a.paused) a.play().catch(() => {}); else a.pause(); }
    else if (cur == null) bakeAndPlay();
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== "Space") return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(tag)) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const share = async (s) => {
    const url = location.origin + location.pathname + "#/p/" + keyOf(s);
    try { await navigator.clipboard.writeText(url); } catch (_) {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const readyCount = songs.filter((s) => (bakes[keyOf(s)] || {}).status === "ready").length;
  const allReady = readyCount === songs.length;

  // one persistent player for BOTH views — music keeps going while you
  // move between the playlist and a song page
  const audioEl = curUrl ? (
    <audio key={curUrl} ref={audioRef} src={curUrl}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={onEnded} />
  ) : null;

  // ---- solo view (#/:name/:date/:words): everything else goes away ----
  const soloIdx = words ? songs.findIndex((s) => keyOf(s) === words) : -1;
  const solo = soloIdx >= 0 ? songs[soloIdx] : null;

  const sb = solo ? (bakes[keyOf(solo)] || {}) : null;
  const isCur = solo ? currentIdx === soloIdx : false;

  /* ONE stable tree for all three views: the backdrop and the <audio> keep
     fixed positions, so the music never stops while you move between the
     playlist and a song page. */
  return (
    <div className="min-h-screen">
      <MoodBackdrop bgHue={hues.bgHue} accentHue={hues.accentHue} audioRef={audioRef}
        tempo={solo ? solo.params.tempo : cur ? cur.params.tempo : 110} />
      {audioEl}
      {words && !solo ? (
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <p className="ds-serif text-2xl">That song isn’t part of this day.</p>
            <a className="link text-sm" href={`#/${name}/${date}`}>back to {name}’s {prettyDate(date).toLowerCase()}</a>
          </div>
        </div>
      ) : solo ? (
      <div className="min-h-screen flex flex-col px-6 py-8">
        <a href={`#/${name}/${date}`} className="self-start btn btn-ghost btn-sm gap-1.5 opacity-60 hover:opacity-100" data-help="Back to the day's twelve">
          <ArrowLeft size={15} /> the other eleven
        </a>
        <div className="flex-1 flex flex-col items-center justify-center w-full max-w-3xl mx-auto gap-7">
          <div className="text-center ds-up">
            <p className="text-[11px] tracking-[0.3em] uppercase text-base-content/40">{name} · {prettyDate(date)}</p>
            <h1 className="ds-serif text-4xl md:text-5xl font-light mt-2" style={{ color: accent }}>{solo.title}</h1>
          </div>
          <LightViz notes={isCur && curBake ? curBake.notes : sb.notes} audioRef={isCur ? audioRef : { current: null }} bgHue={hues.bgHue} accentHue={hues.accentHue} className="w-full h-[22vh] ds-up" />
          <div className="w-full max-w-xl flex flex-col items-center gap-4 ds-up">
            {isCur && curUrl ? <MiniMeter audioRef={audioRef} dur={curBake.duration} accent={accent} /> : null}
            <div className="flex items-center gap-2">
              {sb.status === "baking" ? (
                <span className="flex items-center gap-3 text-sm text-base-content/60">
                  <span className="loading loading-ring loading-sm" style={{ color: accent }} />
                  {Math.round((sb.prog || 0) * 100)}% — <Coffee size={14} className="inline" />
                </span>
              ) : (
                <button
                  className="btn btn-circle btn-lg text-white border-0 shadow-md"
                  style={{ background: accent }}
                  onClick={() => (isCur ? togglePlay() : play(soloIdx))}
                  data-help={sb.status === "ready" ? "Play / pause" : "Bake this song, then play it"}
                >
                  {isCur && playing ? <Pause size={22} /> : <Play size={22} className="translate-x-[1.5px]" />}
                </button>
              )}
              <button className="btn btn-ghost btn-sm btn-square" onClick={() => share(solo)} data-help="Copy a link to just this song — your playlist stays private">
                {copied ? <Check size={15} style={{ color: accent }} /> : <LinkIcon size={15} />}
              </button>
              {starBtn(solo)}
              {sb.status === "ready" && (
                <a className="btn btn-ghost btn-sm btn-square" href={sb.url} download={`daysong-${keyOf(solo)}.${sb.ext || "opus"}`} data-help="Download this song">
                  <Download size={15} />
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
      ) : (
      <div className="px-6 py-10">
      <div className="max-w-2xl mx-auto">
        <header className="ds-up">
          <p className="text-[11px] tracking-[0.3em] uppercase" style={{ color: accent }}>{prettyDate(date)}</p>
          <h1 className="ds-serif text-5xl font-light mt-1.5">{name}’s daysong</h1>
          <p className="text-sm text-base-content/50 mt-2">your background work music — just for today.</p>
        </header>

        {reveal === "creating" ? (
          <div className="mt-24 flex flex-col items-center gap-3 text-center">
            <p className="ds-serif text-3xl ds-up">{greeting()}, {name}.</p>
            <p className="ds-serif text-xl text-base-content/60 ds-shimmer ds-up" style={{ "--ach": hues.accentHue, animationDelay: "0.5s" }}>
              composing today’s twelve…
            </p>
          </div>
        ) : (
          <>
            {/* transport + viz */}
            <div className="mt-7 ds-up" style={{ animationDelay: "0.1s" }}>
              <LightViz notes={curBake ? curBake.notes : null} audioRef={audioRef} bgHue={hues.bgHue} accentHue={hues.accentHue} className="w-full h-24 md:h-28" />
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <button className="btn text-white border-0 btn-circle shadow-sm" style={{ background: accent }} onClick={togglePlay}
                  data-help={allReady || baking ? "Play all / pause — loops all day (space)" : "Bake all twelve — playback starts with the first song, then loops all day"}>
                  {playing ? <Pause size={18} /> : <Play size={18} className="translate-x-[1px]" />}
                </button>
                {cur && (
                  <>
                    <button className="btn btn-ghost btn-sm btn-circle" disabled={currentIdx <= 0} onClick={() => play(currentIdx - 1)} data-help="Previous song"><SkipBack size={16} /></button>
                    <button className="btn btn-ghost btn-sm btn-circle" disabled={currentIdx >= songs.length - 1} onClick={() => play(currentIdx + 1)} data-help="Next song"><SkipForward size={16} /></button>
                    <a className="ds-serif text-lg truncate hover:underline" style={{ color: accent }} href={`#/${name}/${date}/${keyOf(cur)}`} data-help="Open just this song">{cur.title}</a>
                  </>
                )}
                {baking && (
                  <span className="flex items-center gap-2 text-sm text-base-content/55 ml-auto" data-help="Baking continues in the background">
                    <Coffee size={15} style={{ color: accent }} />
                    go have a coffee — {readyCount}/{songs.length}
                  </span>
                )}
              </div>
            </div>

            {/* the twelve */}
            <ol className="mt-6 divide-y divide-base-content/5">
              {songs.map((s, i) => {
                const st = bakes[keyOf(s)] || {};
                const isCurRow = i === currentIdx;
                return (
                  <li key={s.code} className="ds-up" style={{ animationDelay: `${0.12 + i * 0.05}s` }}>
                    <a
                      href={`#/${name}/${date}/${keyOf(s)}`}
                      onClick={() => { if (st.status === "ready") play(i); }}
                      className="group flex items-center gap-4 py-3 px-2 rounded-lg transition-colors"
                      style={isCurRow ? { background: `hsl(${hues.accentHue} 60% 95% / 0.75)` } : null}
                      data-help={st.status === "ready" ? "Play — opens the song page" : "Open the song page"}
                    >
                      <span className="text-xs tabular-nums text-base-content/35 w-6 text-right">{String(i + 1).padStart(2, "0")}</span>
                      <span className={`ds-serif text-lg flex-1 truncate ${isCurRow ? "" : "group-hover:translate-x-1"} transition-transform`} style={isCurRow ? { color: accent } : null}>
                        {s.title}
                      </span>
                      {starBtn(s, 14)}
                      <span className="text-xs tabular-nums text-base-content/40">{fmtTime(s.lengthSec)}</span>
                      <span className="w-8 flex justify-center">
                        {isCurRow && playing ? <EqBars accent={accent} />
                          : st.status === "baking" ? <span className="ds-baking inline-block w-2 h-2 rounded-full" style={{ background: accent }} />
                          : st.status === "ready" ? <span className="inline-block w-2 h-2 rounded-full" style={{ background: accent, opacity: 0.85 }} />
                          : st.status === "error" ? <span className="text-error text-xs">!</span>
                          : <span className="inline-block w-2 h-2 rounded-full border border-base-content/25" />}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ol>

            <footer className="mt-10 pb-6 flex gap-1.5 text-base-content/40 ds-up" style={{ animationDelay: "0.8s" }}>
              <a className="btn btn-ghost btn-xs btn-square" href="#/about" data-help="About Daysong"><Info size={14} /></a>
              <a className="btn btn-ghost btn-xs btn-square" href="#/roster" data-help="The voices"><AudioLines size={14} /></a>
              <a className="btn btn-ghost btn-xs btn-square" href="#/studio" data-help="The studio — every raw knob"><SlidersHorizontal size={14} /></a>
              <a className="btn btn-ghost btn-xs btn-square" href="#/stars" data-help="Your starred songs"><Star size={14} /></a>
              <a className="btn btn-ghost btn-xs btn-square ml-auto" href="#/" onClick={() => { try { localStorage.removeItem(NAME_LS); } catch (_) {} }} data-help={`Not ${name}? Start over`}><UserX size={14} /></a>
            </footer>
          </>
        )}
      </div>
      </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   #/p/:words — a shared song. Just the song; whose day it came from —
   and the other eleven — stay private (the hash is one-way).
--------------------------------------------------------------------- */
function SharedPage({ words }) {
  const song = useMemo(() => engine.decodeSong(words), [words]);
  const hues = useMemo(() => engine.identityHues(words, words), [words]);
  const accent = accentCss(hues.accentHue);
  const [bake, setBake] = useState({ status: "idle" });
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const wantPlayRef = useRef(false);
  const { starredSet, toggleStar } = useStars();

  useEffect(() => {
    if (!song) return;
    let dead = false;
    (async () => {
      const rec = await idbGet(words + "|" + BAKE_V);
      if (dead || !rec) return;
      setBake({ status: "ready", url: URL.createObjectURL(rec.blob), notes: rec.notes, duration: rec.duration, ext: rec.ext });
    })();
    return () => { dead = true; if (audioRef.current) audioRef.current.pause(); };
  }, [words]);

  const bakeIt = async () => {
    setBake({ status: "baking", prog: 0 });
    try {
      const rendered = await engine.renderSong(song.params, {
        fast: true,
        onProgress: ({ progress }) => setBake((b) => ({ ...b, prog: progress || 0 })),
      });
      const enc = await engine.encodeSong(rendered.audioBuffer, "opus", { onProgress: () => {} });
      idbPut(words + "|" + BAKE_V, { blob: enc.blob, ext: enc.ext, notes: rendered.notes, displayCues: rendered.displayCues, duration: rendered.duration, ts: Date.now() });
      wantPlayRef.current = true;
      setBake({ status: "ready", url: URL.createObjectURL(enc.blob), notes: rendered.notes, duration: rendered.duration, ext: enc.ext });
    } catch (e) {
      console.error("[daysong] bake failed", e);
      setBake({ status: "error" });
    }
  };

  useEffect(() => {
    if (wantPlayRef.current && bake.url && audioRef.current) {
      wantPlayRef.current = false;
      audioRef.current.play().catch(() => {});
    }
  }, [bake.url]);

  if (!song) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <MoodBackdrop bgHue={40} accentHue={250} audioRef={{ current: null }} />
        <div className="text-center">
          <p className="ds-serif text-2xl">Those four words aren’t a song.</p>
          <a className="link text-sm" href="#/">start your own daysong →</a>
        </div>
      </div>
    );
  }

  const togglePlay = () => {
    const a = audioRef.current;
    if (a) { if (a.paused) a.play().catch(() => {}); else a.pause(); }
    else if (bake.status === "idle") bakeIt();
  };

  return (
    <div className="min-h-screen flex flex-col px-6 py-8">
      <MoodBackdrop bgHue={hues.bgHue} accentHue={hues.accentHue} audioRef={audioRef} tempo={song.params.tempo} />
      <div className="flex-1 flex flex-col items-center justify-center w-full max-w-3xl mx-auto gap-7">
        <div className="text-center ds-up">
          <p className="text-[11px] tracking-[0.3em] uppercase text-base-content/40">someone sent you a song</p>
          <h1 className="ds-serif text-4xl md:text-5xl font-light mt-2" style={{ color: accent }}>{song.title}</h1>
        </div>
        <LightViz notes={bake.notes} audioRef={audioRef} bgHue={hues.bgHue} accentHue={hues.accentHue} className="w-full h-[22vh] ds-up" />
        <div className="w-full max-w-xl flex flex-col items-center gap-4 ds-up">
          {bake.status === "ready" && <MiniMeter audioRef={audioRef} dur={bake.duration} accent={accent} />}
          {bake.status === "baking" ? (
            <span className="flex items-center gap-3 text-sm text-base-content/60">
              <span className="loading loading-ring loading-sm" style={{ color: accent }} />
              baking this song in your browser… {Math.round((bake.prog || 0) * 100)}%
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <button className="btn btn-circle btn-lg text-white border-0 shadow-md" style={{ background: accent }} onClick={togglePlay} data-help="Bake (render in your browser), then play">
                {playing ? <Pause size={22} /> : <Play size={22} className="translate-x-[1.5px]" />}
              </button>
              <button className="btn btn-ghost btn-sm btn-square" onClick={() => toggleStar(song)} data-help={starredSet.has(words) ? "Unstar" : "Star — keep this song around"}>
                <Star size={15} style={starredSet.has(words) ? { fill: accent, color: accent } : { opacity: 0.45 }} />
              </button>
            </div>
          )}
          <a className="text-xs text-base-content/40 hover:underline" href="#/">what’s a daysong? get your own twelve →</a>
        </div>
      </div>
      {bake.url && (
        <audio key={bake.url} ref={audioRef} src={bake.url}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   #/stars — everything you starred, playable in place. Starred bakes are
   never pruned from the IndexedDB cache.
--------------------------------------------------------------------- */
function StarsPage() {
  const { stars, toggleStar } = useStars();
  const songs = useMemo(() => stars.map((s) => engine.decodeSong(s.words)).filter(Boolean), [stars]);
  const today = engine.dateCode();
  let savedName = "daysong";
  try { savedName = localStorage.getItem(NAME_LS) || "daysong"; } catch (_) {}
  const hues = engine.identityHues(savedName, today);
  const accent = accentCss(hues.accentHue);

  const [bakes, setBakesState] = useState({});
  const bakesRef = useRef({});
  const patch = (k, p) => {
    bakesRef.current = { ...bakesRef.current, [k]: { ...(bakesRef.current[k] || {}), ...p } };
    setBakesState(bakesRef.current);
  };
  const [currentIdx, setCurrentIdx] = useState(-1);
  const currentIdxRef = useRef(-1);
  useEffect(() => { currentIdxRef.current = currentIdx; }, [currentIdx]);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const busyRef = useRef(false);
  const wantPlayRef = useRef(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      for (const s of songs) {
        const rec = await idbGet(bakeKey(s));
        if (dead) return;
        if (rec) patch(keyOf(s), { status: "ready", url: URL.createObjectURL(rec.blob), notes: rec.notes, duration: rec.duration, ext: rec.ext });
      }
    })();
    return () => { dead = true; if (audioRef.current) audioRef.current.pause(); };
  }, []);

  const play = async (i) => {
    const s = songs[i];
    if (!s) return;
    const k = keyOf(s);
    const st = bakesRef.current[k];
    if (st && st.status === "ready") {
      if (i === currentIdxRef.current && audioRef.current) {
        const a = audioRef.current;
        if (a.paused) a.play().catch(() => {}); else a.pause();
        return;
      }
      wantPlayRef.current = true;
      setCurrentIdx(i);
      return;
    }
    if (busyRef.current || (st && st.status === "baking")) return;
    busyRef.current = true;
    patch(k, { status: "baking", prog: 0 });
    try {
      const rendered = await engine.renderSong(s.params, { fast: true, onProgress: ({ progress }) => patch(k, { prog: progress || 0 }) });
      const enc = await engine.encodeSong(rendered.audioBuffer, "opus", { onProgress: () => {} });
      idbPut(bakeKey(s), { blob: enc.blob, ext: enc.ext, notes: rendered.notes, displayCues: rendered.displayCues, duration: rendered.duration, ts: Date.now() });
      patch(k, { status: "ready", prog: 1, url: URL.createObjectURL(enc.blob), notes: rendered.notes, duration: rendered.duration, ext: enc.ext });
      wantPlayRef.current = true;
      setCurrentIdx(i);
    } catch (e) {
      console.error("[daysong] bake failed", e);
      patch(k, { status: "error" });
    }
    busyRef.current = false;
  };

  const cur = currentIdx >= 0 ? songs[currentIdx] : null;
  const curBake = cur ? bakes[keyOf(cur)] : null;
  const curUrl = curBake && curBake.status === "ready" ? curBake.url : null;
  useEffect(() => {
    if (wantPlayRef.current && curUrl && audioRef.current) {
      wantPlayRef.current = false;
      audioRef.current.play().catch(() => {});
    }
  }, [curUrl, currentIdx]);

  return (
    <div className="min-h-screen px-6 py-10">
      <MoodBackdrop bgHue={hues.bgHue} accentHue={hues.accentHue} audioRef={audioRef} tempo={cur ? cur.params.tempo : 110} />
      {curUrl && (
        <audio key={curUrl} ref={audioRef} src={curUrl}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); if (songs.length) play((currentIdxRef.current + 1) % songs.length); }} />
      )}
      <div className="max-w-2xl mx-auto">
        <a href={`#/${savedName}/${today}`} className="btn btn-ghost btn-sm gap-1.5 opacity-60 hover:opacity-100 -ml-3" data-help="Back to today">
          <ArrowLeft size={15} /> today
        </a>
        <header className="ds-up mt-3">
          <h1 className="ds-serif text-5xl font-light flex items-center gap-3">
            starred <Star size={26} style={{ fill: accent, color: accent }} />
          </h1>
          <p className="text-sm text-base-content/50 mt-2">songs you kept — their bakes stick around.</p>
        </header>
        {songs.length > 0 && (
          <div className="mt-6 ds-up">
            <LightViz notes={curBake ? curBake.notes : null} audioRef={audioRef} bgHue={hues.bgHue} accentHue={hues.accentHue} className="w-full h-24 md:h-28" />
          </div>
        )}
        {songs.length === 0 ? (
          <p className="ds-serif text-xl text-base-content/45 mt-16 text-center ds-up">
            nothing starred yet — tap the <Star size={16} className="inline -mt-1" /> on any song.
          </p>
        ) : (
          <ol className="mt-4 divide-y divide-base-content/5">
            {songs.map((s, i) => {
              const st = bakes[keyOf(s)] || {};
              const isCurRow = i === currentIdx;
              return (
                <li key={s.code} className="ds-up" style={{ animationDelay: `${0.08 + i * 0.04}s` }}>
                  <div
                    role="button" tabIndex={0}
                    onClick={() => play(i)}
                    onKeyDown={(e) => { if (e.key === "Enter") play(i); }}
                    className="group w-full text-left flex items-center gap-4 py-3 px-2 rounded-lg transition-colors cursor-pointer"
                    style={isCurRow ? { background: `hsl(${hues.accentHue} 60% 95% / 0.75)` } : null}
                    data-help={st.status === "ready" ? "Play / pause" : "Bake, then play"}
                  >
                    <span className="text-xs tabular-nums text-base-content/35 w-6 text-right">{String(i + 1).padStart(2, "0")}</span>
                    <span className={`ds-serif text-lg flex-1 truncate ${isCurRow ? "" : "group-hover:translate-x-1"} transition-transform`} style={isCurRow ? { color: accent } : null}>
                      {s.title}
                    </span>
                    <a className="btn btn-ghost btn-xs btn-square opacity-0 group-hover:opacity-100" href={`#/p/${keyOf(s)}`}
                      onClick={(e) => e.stopPropagation()} data-help="Open this song's page"><LinkIcon size={13} /></a>
                    <button className="btn btn-ghost btn-xs btn-square" onClick={(e) => { e.stopPropagation(); toggleStar(s); }} data-help="Unstar">
                      <Star size={14} style={{ fill: accent, color: accent }} />
                    </button>
                    <span className="text-xs tabular-nums text-base-content/40">{fmtTime(s.lengthSec)}</span>
                    <span className="w-8 flex justify-center">
                      {isCurRow && playing ? <EqBars accent={accent} />
                        : st.status === "baking" ? <span className="ds-baking inline-block w-2 h-2 rounded-full" style={{ background: accent }} />
                        : st.status === "ready" ? <span className="inline-block w-2 h-2 rounded-full" style={{ background: accent, opacity: 0.85 }} />
                        : st.status === "error" ? <span className="text-error text-xs">!</span>
                        : <span className="inline-block w-2 h-2 rounded-full border border-base-content/25" />}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------
   App + router
--------------------------------------------------------------------- */
function StudioRoute({ init }) {
  const [params, setParams] = useState(init.params);
  const [seed, setSeed] = useState(init.seed);
  useEffect(() => { history.replaceState(null, "", songHash(seed, params)); }, [seed, params]);
  return <Studio params={params} setParams={setParams} seed={seed} setSeed={setSeed} />;
}

function App() {
  const [nav, setNav] = useState(parseHash);
  useEffect(() => {
    const onNav = () => setNav(parseHash());
    window.addEventListener("popstate", onNav);
    window.addEventListener("hashchange", onNav);
    return () => { window.removeEventListener("popstate", onNav); window.removeEventListener("hashchange", onNav); };
  }, []);

  return (
    <>
      <Tooltips />
      {nav.route === "about" ? <About backHash="#/" />
        : nav.route === "roster" ? <Roster backHash="#/" />
        : nav.route === "studio" ? <StudioRoute key={`studio-${nav.seed}`} init={nav} />
        : nav.route === "shared" ? <SharedPage key={nav.words} words={nav.words} />
        : nav.route === "stars" ? <StarsPage key="stars" />
        : nav.route === "day" ? <DayPage key={`${nav.name}/${nav.date}`} name={nav.name} date={nav.date} words={nav.words} />
        : <Landing />}
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
