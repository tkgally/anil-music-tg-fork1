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
  const ui = (typeof document !== "undefined") ? mountLive(started) : null;
  let pass = 0, fail = 0, skip = 0;
  const fails = [];
  for (let i = 0; i < started.length; i++) {
    const t = started[i];
    if (ui) { ui.status(i, "run"); ui.head(pass, fail, skip, i); await paint(); }  // flush prior results + "running"
    if (t.skip) { skip++; line("skip", t.name, t.reason); if (ui) ui.status(i, "skip", t.reason); continue; }
    try { await t.fn(); pass++; line("pass", t.name); if (ui) ui.status(i, "pass"); }
    catch (e) { fail++; fails.push({ name: t.name, err: e }); line("FAIL", t.name, e && e.message); if (ui) ui.status(i, "fail", (e && e.stack) || e); }
  }
  print(`\n${pass} passed · ${fail} failed · ${skip} skipped`);
  for (const f of fails) print(`  ✗ ${f.name}\n    ${(f.err && f.err.stack) || f.err}`);
  if (isNode) process.exitCode = fail ? 1 : 0;
  globalThis.__testrun = { pass, fail, skip };   // record driver / CI can poll this
  if (ui) { ui.head(pass, fail, skip, started.length); await paint(); }
  return { pass, fail, skip };
}

// yields long enough for the browser to actually repaint between tests
const paint = () => new Promise((r) =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => requestAnimationFrame(r)) : setTimeout(r));

function line(kind, name, extra) {
  const mark = kind === "pass" ? "✓" : kind === "skip" ? "–" : "✗";
  print(`${mark} ${name}${extra ? "  (" + extra + ")" : ""}`);
}
function print(s) { console.log(s); }

// Live in-page reporter: a header + progress bar + one row per test, updated as
// each test completes (not just at the end).
function mountLive(tests) {
  const COL = { run: "#2563eb", pass: "#0a7d2c", fail: "#c0261a", skip: "#8a8f98", pend: "#c4c8cf" };
  const GLYPH = { pend: "○", run: "▶", pass: "✓", fail: "✗", skip: "–" };
  const total = tests.length;
  const wrap = document.createElement("div");
  wrap.style.cssText = "font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:920px;margin:8px 16px 48px";
  const hd = document.createElement("div");
  hd.style.cssText = "font-weight:600;margin-bottom:8px;color:" + COL.run;
  hd.textContent = "▶ running… 0/" + total;
  const barOuter = document.createElement("div");
  barOuter.style.cssText = "height:6px;background:#eceef2;border-radius:4px;overflow:hidden;margin-bottom:14px";
  const bar = document.createElement("div");
  bar.style.cssText = "height:100%;width:0;background:" + COL.run + ";transition:width .12s ease";
  barOuter.appendChild(bar);
  const list = document.createElement("div");
  wrap.append(hd, barOuter, list);
  document.body.appendChild(wrap);

  const rows = tests.map((t) => {
    const li = document.createElement("div");
    li.style.cssText = "display:flex;gap:8px;padding:2px 0;color:" + COL.pend;
    const g = document.createElement("span"); g.textContent = GLYPH.pend; g.style.width = "1em"; g.style.flex = "0 0 auto";
    const nm = document.createElement("span"); nm.textContent = t.name; nm.style.color = "#1a1d22";
    li.append(g, nm); list.appendChild(li);
    return { li, g, nm };
  });

  return {
    status(i, s, extra) {
      const r = rows[i]; if (!r) return;
      r.g.textContent = GLYPH[s]; r.g.style.color = COL[s]; r.li.style.color = COL[s];
      if (s === "skip" && extra) r.nm.textContent = tests[i].name + "  (" + extra + ")";
      if (s === "fail" && extra) {
        const pre = document.createElement("pre");
        pre.style.cssText = "margin:3px 0 6px 1.7em;padding:8px 10px;background:#fff5f5;border-left:3px solid " + COL.fail +
          ";color:" + COL.fail + ";white-space:pre-wrap;overflow:auto";
        pre.textContent = String(extra);
        r.li.after(pre);
      }
    },
    head(pass, fail, skip, done) {
      const running = done < total;
      hd.textContent = (running ? "▶ running… " : fail ? "✗ done " : "✓ done ") +
        done + "/" + total + "  ·  " + pass + " passed · " + fail + " failed · " + skip + " skipped";
      hd.style.color = running ? COL.run : fail ? COL.fail : COL.pass;
      bar.style.width = Math.round((done / total) * 100) + "%";
      bar.style.background = fail ? COL.fail : running ? COL.run : COL.pass;
    },
  };
}
