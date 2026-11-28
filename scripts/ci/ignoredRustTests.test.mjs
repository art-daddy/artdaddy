import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { IGNORED_IN_CI, passedTests, verdict } from "./ignoredRustTests.mjs";

// Every #[ignore]d test of the Rust shell is named by something that runs it. A plain `cargo test` leaves an ignored
// test out, so one that no workflow, hook, script or parent test names never runs: three such tests sat unnamed until
// the coverage measurement of 26 Nov found them (an export's scratch capture, a crash-recovered export, the cgroup
// reading). This walks the Rust sources, so a new ignored test fails here until a lane runs it or it is listed below
// as run by hand, with the reason.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

/** Ignored tests that only a person runs, on purpose. */
const BY_HAND = {
  adapters_of_this_pc:
    "reads this PC's graphics adapters and only prints what it found: a diagnostic for a PC with a graphics chip, which no CI runner has",
};

function filesUnder(rel, keep) {
  const out = [];
  const walk = (at) => {
    for (const entry of readdirSync(path.join(ROOT, at), { withFileTypes: true })) {
      const next = `${at}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "target") walk(next);
      } else if (keep(entry.name)) out.push(next);
    }
  };
  walk(rel);
  return out;
}

/** The module a Rust file is, from its place under src-tauri/src (`jobs/stream.rs` is `jobs::stream`). */
function modulePath(rel) {
  if (!rel.startsWith("src-tauri/src/")) return "";
  const parts = rel.slice("src-tauri/src/".length).replace(/\.rs$/, "").split("/");
  if (["lib", "main", "mod"].includes(parts[parts.length - 1])) parts.pop();
  return parts.join("::");
}

/** Every #[ignore]d test in a Rust file's text: its function, its path in the crate and the reason it gives. */
function ignoredTests(rel, text) {
  const lines = text.split("\n");
  const found = [];
  let testModule = "";
  for (let i = 0; i < lines.length; i++) {
    const mod = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*\{/.exec(lines[i]);
    if (mod) testModule = mod[1];
    const ignore = /^\s*#\[ignore(?:\s*=\s*"([^"]*)")?\]/.exec(lines[i]);
    if (!ignore) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const fn = /\bfn\s+(\w+)\s*\(/.exec(lines[j]);
      if (!fn) continue;
      const crate = rel.startsWith("src-tauri/tests/") ? "" : modulePath(rel);
      found.push({
        file: rel,
        line: j + 1,
        name: fn[1],
        full: [crate, testModule, fn[1]].filter(Boolean).join("::"),
        reason: ignore[1] ?? "",
      });
      break;
    }
  }
  return found;
}

/** The lanes: what can start a test (workflows, the hook, scripts, the smoke lane and its helpers) and the Rust tests
 *  that launch a child test by its name. */
function lanes() {
  const text = (rel) => ({ rel, text: read(rel) });
  const scripts = filesUnder("scripts", (name) => /\.(mjs|cjs|js|ts|mts|ps1|sh)$/.test(name))
    .filter((rel) => rel !== "scripts/ci/ignoredRustTests.test.mjs")
    .map(text);
  return {
    runners: [
      ...filesUnder(".github/workflows", (name) => name.endsWith(".yml")).map(text),
      text(".githooks/pre-push"),
      ...scripts,
      ...filesUnder("src/test", (name) => /\.(ts|mjs)$/.test(name)).map(text),
      text("src/tools/__e2e.ts"),
      ...filesUnder("src", (name) => name.endsWith(".e2e.ts")).map(text),
    ],
    rust: [
      ...filesUnder("src-tauri/src", (name) => name.endsWith(".rs")),
      ...filesUnder("src-tauri/tests", (name) => name.endsWith(".rs")),
    ].map(text),
  };
}

/** How a lane runs `test`, or null when none does. */
function runBy(test, { runners, rust }) {
  const word = new RegExp(`\\b${test.name}\\b`);
  for (const { rel, text } of runners) if (word.test(text)) return `${rel} names it`;
  // A parent test that starts this one as a child names it in a string.
  const quoted = new RegExp(`"[^"\\n]*\\b${test.name}\\b[^"\\n]*"`);
  for (const { rel, text } of rust)
    for (const line of text.split("\n"))
      if (!line.trimStart().startsWith("//") && quoted.test(line)) return `${rel} starts it`;
  // A run of a whole module or an integration test file with its ignored tests included.
  const stem = test.file.startsWith("src-tauri/tests/") ? path.basename(test.file, ".rs") : null;
  for (const { rel, text } of runners)
    for (const line of text.split("\n")) {
      if (!/--(include-)?ignored\b/.test(line)) continue;
      const prefixes =
        line.match(/\b[a-z_][a-z0-9_]*(?:::[a-z_][a-z0-9_]*)*::(?=\s|$|["'])/g) ?? [];
      if (prefixes.some((prefix) => test.full.startsWith(prefix))) return `${rel} runs its module`;
      if (stem && new RegExp(`\\b${stem}\\b`).test(line)) return `${rel} runs its file`;
    }
  return null;
}

describe("every #[ignore]d Rust test is run by a lane", () => {
  const rust = [
    ...filesUnder("src-tauri/src", (name) => name.endsWith(".rs")),
    ...filesUnder("src-tauri/tests", (name) => name.endsWith(".rs")),
  ];
  const tests = rust.flatMap((rel) => ignoredTests(rel, read(rel)));
  const known = lanes();

  it("finds the ignored tests, so an empty list is not a scanner that sees nothing", () => {
    expect(tests.length).toBeGreaterThan(20);
    const names = tests.map((t) => t.full);
    expect(names).toContain(
      "jobs::export_delivery_tests::crash_recovery_renders_and_publishes_a_real_video",
    );
    expect(names).toContain("tests::without_a_secret_service_the_session_lives_in_a_private_file");
  });

  it("names a lane for each one, or says why only a person runs it", () => {
    const unrun = tests
      .filter((t) => !Object.hasOwn(BY_HAND, t.name) && runBy(t, known) === null)
      .map((t) => `${t.full} (${t.file}:${t.line}): "${t.reason}"`);
    expect(
      unrun,
      "a plain cargo test leaves these out and nothing else runs them: add one to scripts/ci/ignoredRustTests.mjs (CI) or name the lane that runs it",
    ).toEqual([]);
  });

  it("lists by hand only tests that exist and are ignored, each with its reason", () => {
    for (const [name, reason] of Object.entries(BY_HAND)) {
      expect(
        tests.map((t) => t.name),
        name,
      ).toContain(name);
      expect(reason.length).toBeGreaterThan(30);
    }
  });

  it("runs, in CI, ignored tests that exist under those names, from the cargo test jobs of ci.yml", () => {
    const full = new Set(tests.map((t) => t.full));
    for (const { test, systems } of IGNORED_IN_CI) {
      expect(full.has(test), `${test} is not an ignored test of the shell any more`).toBe(true);
      expect(systems.length).toBeGreaterThan(0);
    }
    const ci = read(".github/workflows/ci.yml");
    expect(ci.match(/node scripts\/ci\/ignoredRustTests\.mjs/g) ?? []).toHaveLength(2);
  });

  it("finds no lane for a test nothing names, and the lane for one a workflow runs by module or a parent starts", () => {
    const lone = {
      file: "src-tauri/src/jobs.rs",
      name: "nobody_runs_this",
      full: "jobs::tests::nobody_runs_this",
    };
    expect(runBy(lone, known)).toBeNull();
    const streamed = tests.find(
      (t) => t.full.startsWith("jobs::stream::tests::") && t.reason.includes("real bundled ffmpeg"),
    );
    expect(runBy(streamed, known)).toBe(".github/workflows/exporter-native-qa.yml runs its module");
    const child = tests.find((t) => t.name === "allocation_child");
    expect(runBy(child, known)).toMatch(/src-tauri\/src\/jobs\/budget\.rs starts it/);
  });

  it("reads cargo's report: each wanted test by name, and an exit that is not 0", () => {
    const out =
      "running 2 tests\ntest a::b::one ... ok\ntest a::b::two ... FAILED\n\ntest result: FAILED.";
    expect([...passedTests(out)]).toEqual(["a::b::one"]);
    expect(verdict(["a::b::one"], out, 0)).toEqual([]);
    expect(verdict(["a::b::one", "a::b::two"], out, 101)).toEqual([
      "cargo test exited 101",
      "a::b::two was not reported as passed",
    ]);
    // A run that matched nothing exits 0 and passes nothing: that is a failure here.
    expect(verdict(["a::b::renamed"], "running 0 tests\n\ntest result: ok. 0 passed", 0)).toEqual([
      "a::b::renamed was not reported as passed",
    ]);
  });
});
