// Node test runner (counterpart of tests.html). Runs every suite; the Web
// Audio suites auto-skip under Node. Static imports (no top-level await) so all
// cases register before testkit's single auto-run.
//   node engine/tests.mjs            run pure suites (audio skipped)
//   node engine/tests.mjs --record   re-record the Node-recordable goldens
import "./rng-test.js";
import "./theory-test.js";
import "./wordlist-test.js";
import "./songcode-test.js";
import "./playlist-test.js";
import "./composer-test.js";
import "./viz-test.js";
import "./encoders-test.js";
import "./render-test.js";
import "./voices-test.js";
