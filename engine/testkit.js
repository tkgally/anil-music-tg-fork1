// Tiny zero-dependency test harness.
//
// The same *-test.js file runs three ways:
//   • `node engine/foo-test.js`        — runs that file's suite, sets exit code
//   • open engine/tests.html (served)  — every imported *-test.js runs together
//   • imported by another module        — still auto-runs once
//
// Tests register synchronously during module evaluation and auto-run on the
// next microtask, so importing several test files produces one combined run.
// `test.browser(...)` is skipped under Node (no Web Audio); pure suites run
// everywhere.

const reg = [];
let scheduled = false;

export const isNode = typeof process !== "undefined" && !!(process.versions && process.versions.node);
export const hasAudio =
  typeof OfflineAudioContext !== "undefined" || typeof globalThis.webkitOfflineAudioContext !== "undefined";

export function test(name, fn) { reg.push({ name, fn, skip: false }); schedule(); }
test.browser = (name, fn) => { reg.push({ name, fn, skip: !hasAudio, reason: "needs Web Audio" }); schedule(); };
test.skip = (name, fn) => { reg.push({ name, fn, skip: true, reason: "skipped" }); schedule(); };

export function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

export function eq(a, b, msg) {
  const sa = stable(a), sb = stable(b);
  if (sa !== sb) throw new Error((msg ? msg + ": " : "") + `not equal\n  a = ${trunc(sa)}\n  b = ${trunc(sb)}`);
}

export function close(a, b, eps = 1e-9, msg) {
  if (!(Math.abs(a - b) <= eps)) throw new Error((msg ? msg + ": " : "") + `|${a} - ${b}| = ${Math.abs(a - b)} > ${eps}`);
}

export function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  if (!threw) throw new Error(msg || "expected function to throw");
}

// --- golden-master helpers -------------------------------------------------
// RECORD is true with `node foo-test.js --record` or `tests.html?record`.
export const RECORD =
  (isNode && process.argv.includes("--record")) ||
  (typeof location !== "undefined" && /[?&]record(\b|=)/.test(location.search));

// Goldens live next to this file (engine/<name>-golden.js).
export async function recordGolden(name, data) {
  if (isNode) {
    const { writeFileSync } = await import("fs");
    const { fileURLToPath } = await import("url");
    const p = fileURLToPath(new URL(`./${name}-golden.js`, import.meta.url));
    writeFileSync(p, "// AUTO-GENERATED golden baseline. Regenerate with --record.\nexport default " + JSON.stringify(data, null, 1) + ";\n");
    console.log(`recorded ${name}-golden.js`);
  } else {
    (globalThis.__goldens ||= {})[name] = data;   // the browser record driver reads this
    console.log(`captured ${name} golden (browser)`);
  }
}

export async function loadGolden(name) {
  return (await import(`./${name}-golden.js`)).default;
}

// FNV-1a over bytes -> 8-hex string. Accepts Uint8Array / ArrayBuffer / typed array.
export function fnv1a(data) {
  const bytes = data instanceof Uint8Array ? data
    : data.buffer ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength)
    : new Uint8Array(data);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// deterministic stringify (sorted keys) so object comparisons are order-stable
function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}
function trunc(s, n = 240) { return s && s.length > n ? s.slice(0, n) + `…(${s.length} chars)` : s; }

function schedule() {
  if (scheduled) return;
  scheduled = true;
  const soon = typeof queueMicrotask === "function" ? queueMicrotask : (f) => Promise.resolve().then(f);
  soon(runAll);
}

async function runAll() {
  const started = reg.slice();
  let pass = 0, fail = 0, skip = 0;
  const fails = [];
  for (const t of started) {
    if (t.skip) { skip++; line("skip", t.name, t.reason); continue; }
    try { await t.fn(); pass++; line("pass", t.name); }
    catch (e) { fail++; fails.push({ name: t.name, err: e }); line("FAIL", t.name, e && e.message); }
  }
  print(`\n${pass} passed · ${fail} failed · ${skip} skipped`);
  for (const f of fails) print(`  ✗ ${f.name}\n    ${(f.err && f.err.stack) || f.err}`);
  if (isNode) process.exitCode = fail ? 1 : 0;
  globalThis.__testrun = { pass, fail, skip };   // record driver / CI can poll this
  if (typeof document !== "undefined") toPage(pass, fail, skip, fails);
  return { pass, fail, skip };
}

function line(kind, name, extra) {
  const mark = kind === "pass" ? "✓" : kind === "skip" ? "–" : "✗";
  print(`${mark} ${name}${extra ? "  (" + extra + ")" : ""}`);
}
function print(s) { console.log(s); }

function toPage(pass, fail, skip, fails) {
  const pre = document.createElement("pre");
  pre.style.cssText = "font:13px ui-monospace,monospace;padding:16px;white-space:pre-wrap";
  pre.textContent = reg.map((t) => `${t.skip ? "–" : "•"} ${t.name}`).join("\n") +
    `\n\n${pass} passed · ${fail} failed · ${skip} skipped` +
    fails.map((f) => `\n\n✗ ${f.name}\n${(f.err && f.err.stack) || f.err}`).join("");
  pre.style.color = fail ? "#b00" : "#080";
  document.body.appendChild(pre);
}
