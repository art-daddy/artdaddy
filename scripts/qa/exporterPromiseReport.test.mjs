import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import fc from "fast-check";

const script = fileURLToPath(new URL("./exporterPromiseReport.mjs", import.meta.url));
const definition = { id: "hd-full", line: "hd", kind: "promise", source: "generated", width: 1920, height: 1080,
  fps: 30, durationSeconds: 60, visualClips: 10, videoLayers: 1, speedFactor16gb: 2 };
async function fixture(cases = [definition]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "artdaddy-promise-report-"));
  await mkdir(path.join(root, "scripts/qa"), { recursive: true });
  await mkdir(path.join(root, "reports/qa/exporter"), { recursive: true });
  await writeFile(path.join(root, "scripts/qa/exporterPromiseCases.json"), JSON.stringify({ version: 2,
    platforms: ["win32"], profiles: { "8gb": { systemMemoryBytes: 8 * 1024 ** 3 } },
    sourceClasses: { generated: { realWorld: false }, missing: { realWorld: true, path: null } }, cases }));
  return root;
}
async function record(root, name, override = {}) {
  const dir = path.join(root, "reports/qa/exporter", name);
  await mkdir(dir);
  await writeFile(path.join(dir, "report.json"), JSON.stringify({ ok: true }));
  await writeFile(path.join(dir, "promise-library.json"), JSON.stringify({ caseId: definition.id, kind: "promise", profile: "8gb", platform: "win32",
    mode: "quality", definition, encodedVideo: { width: 1920, height: 1080, fps: "30/1", frames: 1800 }, projectFrames: 1800,
    elapsedMs: 60_000, passed: true, artifactVerified: true, publicationVerified: true, stagingCleaned: true, scratchCleaned: true,
    sourceReady: true, temporarySpaceQualified: true, estimateProvided: true, readiness: "ready", profileRunId: "kernel-proof", ...override }));
}
async function receipt(root) {
  await writeFile(path.join(root, "reports/qa/exporter/memory-proof.json"), JSON.stringify({ runId: "kernel-proof", workload: "App",
    scope: "windows-job-commit-pressure-simulation", exitCode: 0, configuredCommitLimitBytes: 6 * 1024 ** 3 }));
}
function summary(root) {
  const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("unrun and missing-source rows remain visible without inventing a rate", async () => {
  const root = await fixture([definition, { ...definition, id: "phone", source: "missing" }]);
  try {
    const result = summary(root);
    assert.equal(result.plannedVariants, 2);
    assert.equal(result.attemptedVariants, 0);
    assert.equal(result.readyPassRate, null);
    assert.equal(result.softwareLibraryQualified, false);
    assert.deepEqual(result.rows.map((row) => row.status), ["deferred", "blocked-source"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("profile labels and short or Fast artifacts cannot replace complete Full-quality proof", async () => {
  const root = await fixture();
  try {
    await record(root, "missing-kernel");
    assert.equal(summary(root).overallPassed, 0);
    await receipt(root);
    assert.equal(summary(root).overallPassed, 1);
    await record(root, "short", { encodedVideo: { width: 1920, height: 1080, fps: "30/1", frames: 300 }, projectFrames: 300 });
    await record(root, "fast", { mode: "fast" });
    const result = summary(root);
    assert.equal(result.overallAttempts, 3);
    assert.equal(result.overallPassed, 1);
    assert.equal(result.readyPassRate, 1 / 3);
    assert.equal(result.softwareLibraryQualified, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown/blocked readiness stays separate and private fields never enter the summary", async () => {
  const root = await fixture();
  try {
    await receipt(root);
    await record(root, "ready");
    await record(root, "blocked", { status: "blocked-source", readiness: "not_ready", passed: false, error: "C:/private/person/movie.mp4" });
    await record(root, "unknown", { readiness: "unknown", passed: false, destination: "C:/private/person/movie.mp4" });
    const result = summary(root);
    assert.equal(result.overallPassRate, 1 / 3);
    assert.equal(result.readyPassRate, 1);
    assert.equal(result.rows[0].unknownReadiness, 1);
    assert.equal(result.rows[0].sourceBlockedAttempts, 1);
    assert(!JSON.stringify(result).includes("private"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("adding any number of pilots cannot raise promise success or qualification", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 12 }), async (count) => {
    const root = await fixture([definition, { ...definition, id: "pilot", kind: "pilot" }]);
    try {
      await receipt(root);
      await record(root, "failed", { passed: false });
      for (let index = 0; index < count; index++) await record(root, `pilot-${index}`, { caseId: "pilot", kind: "pilot" });
      const result = summary(root);
      assert.equal(result.pilotAttempts, count);
      assert.equal(result.overallAttempts, 1);
      assert.equal(result.overallPassRate, 0);
      assert.equal(result.softwareLibraryQualified, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }), { numRuns: 8 });
});

test("identifiable historical failures remain counted without rewriting evidence", async () => {
  const root = await fixture();
  const owned = await mkdtemp(path.join(os.tmpdir(), "artdaddy-export-native-"));
  try {
    await writeFile(path.join(owned, "promise-input.json"), JSON.stringify({ case: definition, profile: "8gb" }));
    const dir = path.join(root, "reports/qa/exporter/old-failed");
    await mkdir(dir);
    const report = JSON.stringify({ ok: false, root: owned, hardware: { platform: "win32" }, elapsedMs: 1000,
      error: "private source path must not enter the summary" });
    await writeFile(path.join(dir, "report.json"), report);
    const result = summary(root);
    assert.equal(result.overallAttempts, 1);
    assert.equal(result.overallPassed, 0);
    assert.equal(result.recoveredLegacyFailures, 1);
    assert.equal(await (await import("node:fs/promises")).readFile(path.join(dir, "report.json"), "utf8"), report);
    assert(!JSON.stringify(result).includes("private"));
  } finally { await rm(root, { recursive: true, force: true }); await rm(owned, { recursive: true, force: true }); }
});