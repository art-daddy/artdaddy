// The one implementation of the shared timing helper. Its interface, and how to name a wait, are documented at the top
// of `timing.ts` beside it: Playwright specs import `timing.ts`, the plain-Node desktop lanes import this file, and both
// get these same functions.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

/** The environment variable that names the results file (one JSON line per measurement). */
export const TIMING_FILE_ENV = "ARTDADDY_TIMING_FILE";
/** The environment variable that overrides the build recorded on each line (default: the checkout's commit). */
export const BUILD_ENV = "ARTDADDY_BUILD";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Where measurements go: `ARTDADDY_TIMING_FILE`, else one file per day under the system temp folder. */
export function timingFile(env = process.env, now = new Date()) {
  const named = env[TIMING_FILE_ENV]?.trim();
  if (named) return path.resolve(named);
  return path.join(os.tmpdir(), "artdaddy-timing", `timing-${localDate(now)}.jsonl`);
}

let commit;
/** The build that ran: `ARTDADDY_BUILD`, else this checkout's commit (`+dirty` when tracked files are changed). */
function currentBuild() {
  const named = process.env[BUILD_ENV]?.trim();
  if (named) return named;
  if (commit === undefined) {
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: REPO,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    try {
      const sha = git("rev-parse", "HEAD");
      commit = git("status", "--porcelain", "--untracked-files=no") ? `${sha}+dirty` : sha;
    } catch {
      commit = "unknown";
    }
  }
  return commit;
}

function checkScenario(scenario) {
  if (typeof scenario !== "string" || !scenario.trim() || /[\r\n]/.test(scenario)) {
    throw new TypeError(
      `timing: a scenario is a non-empty, one-line name; got ${JSON.stringify(scenario)}`,
    );
  }
}

const told = new Set();
function write(scenario, ms, startedAt) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new TypeError(
      `timing: "${scenario}" needs a duration of 0 ms or more; got ${String(ms)}`,
    );
  }
  const entry = {
    scenario,
    ms: Math.round(ms),
    machine: os.hostname(),
    build: currentBuild(),
    at: new Date(startedAt).toISOString(),
  };
  const file = timingFile();
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  if (!told.has(file)) {
    told.add(file);
    console.log(`[timing] results: ${file}`);
  }
  console.log(`[timing] ${scenario}: ${entry.ms} ms`);
  return entry;
}

/** Time `fn` and record the wait once it resolves. A wait that throws is not recorded; the error goes on. */
export async function measure(scenario, fn) {
  checkScenario(scenario);
  if (typeof fn !== "function")
    throw new TypeError(`timing: measure("${scenario}") needs a function to time`);
  const startedAt = Date.now();
  const began = performance.now();
  const value = await fn();
  write(scenario, performance.now() - began, startedAt);
  return value;
}

/** Start a wait now; `stop()` records it, once. A timer that is never stopped records nothing. */
export function startTimer(scenario) {
  checkScenario(scenario);
  const startedAt = Date.now();
  const began = performance.now();
  let stopped = false;
  return {
    stop() {
      if (stopped) throw new Error(`timing: "${scenario}" was already stopped`);
      stopped = true;
      return write(scenario, performance.now() - began, startedAt);
    },
  };
}

/** Record a wait measured by another clock (the app's own performance marks, its process age). */
export function record(scenario, ms) {
  checkScenario(scenario);
  return write(scenario, ms, Date.now() - (Number.isFinite(ms) && ms > 0 ? ms : 0));
}
