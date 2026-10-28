import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import fc from "fast-check";
import { REAL_CAPTION_SAMPLES, REAL_COLD_MESSAGE, REAL_PHONE_PICTURES, qualifiedEvidence } from "./exporterQualification.fixtures.mjs";

const script = fileURLToPath(new URL("./exporterPromiseReport.mjs", import.meta.url));
const library = JSON.parse(await readFile(new URL("./exporterPromiseCases.json", import.meta.url), "utf8"));
const definition = library.cases.find((entry) => entry.id === "youtube-hd");
assert.ok(definition);
async function fixture(cases = [definition], platforms = ["win32"], profiles = ["8gb"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "artdaddy-promise-report-"));
  await mkdir(path.join(root, "scripts/qa"), { recursive: true });
  await mkdir(path.join(root, "reports/qa/exporter"), { recursive: true });
  await writeFile(path.join(root, "scripts/qa/exporterPromiseCases.json"), JSON.stringify({ ...library,
    platforms, profiles: Object.fromEntries(profiles.map((name) => [name, library.profiles[name]])),
    sourceClasses: { ...library.sourceClasses, missing: { realWorld: true, path: null } }, cases }));
  return root;
}
async function record(root, name, override = {}) {
  const dir = path.join(root, "reports/qa/exporter", name);
  await mkdir(dir);
  await writeFile(path.join(dir, "report.json"), JSON.stringify({ ok: true,
    native: { resources: { temporary_space: library.temporarySpace } } }));
  const frames = Math.round(definition.durationSeconds * definition.fps);
  await writeFile(path.join(dir, "promise-library.json"), JSON.stringify({ version: library.version, temporarySpace: library.temporarySpace,
    caseId: definition.id, kind: "promise", profile: "8gb", platform: "win32",
    mode: "quality", definition, encodedVideo: { width: definition.width, height: definition.height, fps: `${definition.fps}/1`, frames }, projectFrames: frames,
    elapsedMs: 60_000, passed: true, artifactVerified: true, publicationVerified: true, stagingCleaned: true, scratchCleaned: true,
    sourceReady: true, temporarySpaceQualified: true, estimateProvided: true, readiness: "ready", profileRunId: "kernel-proof",
    ...qualifiedEvidence(library.temporarySpace), ...override }));
  return dir;
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

test("Unix host evidence qualifies only matching independently measured bounded runs", async () => {
  for (const platform of ["darwin", "linux"]) {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 256, max: 32768 }), fc.integer({ min: 256, max: 32768 }),
      async (nodeMiB, nativeMiB) => {
        const root = await fixture([definition], [platform]);
        try {
          const host = { scope: "measured-host-memory", runId: "isolated-run", platform,
            nodeTotalMemoryBytes: nodeMiB * 1024 ** 2, nativeTotalMemoryBytes: nativeMiB * 1024 ** 2 };
          const dir = await record(root, "host", { platform, hostProfileEvidence: host });
          const envelope = { ok: true, identifier: host.runId,
            hardware: { platform, totalMemoryBytes: host.nodeTotalMemoryBytes },
            native: { resources: { total_memory_bytes: host.nativeTotalMemoryBytes, temporary_space: library.temporarySpace } } };
          await writeFile(path.join(dir, "report.json"), JSON.stringify(envelope));
          const result = summary(root);
          const fits = nodeMiB <= 8192 && nativeMiB <= 8192;
          assert.equal(result.overallPassed, Number(fits));
          assert.equal(result.physicalLibraryQualified, false);
          assert.deepEqual(result.rows[0].profileEvidenceKinds, [fits ? "measured-host-memory" : "unverified"]);
          envelope.identifier = "different-run";
          await writeFile(path.join(dir, "report.json"), JSON.stringify(envelope));
          assert.equal(summary(root).overallPassed, 0);
          envelope.identifier = host.runId;
          envelope.native.resources.total_memory_bytes += 1;
          await writeFile(path.join(dir, "report.json"), JSON.stringify(envelope));
          assert.equal(summary(root).overallPassed, 0);
        } finally { await rm(root, { recursive: true, force: true }); }
      }), { numRuns: 8, examples: [[7168, 7168], [8192, 8192], [8193, 7168], [7168, 8193]] });
  }
});

test("missing and non-finite host measurements never turn profile labels into proof", async () => {
  for (const measurement of [null, 0, -1, "7516192768", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const root = await fixture([definition], ["darwin"]);
    try {
      const host = { scope: "measured-host-memory", runId: "isolated-run", platform: "darwin",
        nodeTotalMemoryBytes: measurement, nativeTotalMemoryBytes: measurement };
      const dir = await record(root, "unknown", { platform: "darwin", hostProfileEvidence: host, profileEnforced: true });
      await writeFile(path.join(dir, "report.json"), JSON.stringify({ ok: true, identifier: host.runId,
        hardware: { platform: "darwin", totalMemoryBytes: measurement },
        native: { resources: { total_memory_bytes: measurement, temporary_space: library.temporarySpace } } }));
      assert.equal(summary(root).overallPassed, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
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

test("every schema-defined temporary field must match both the attempt and native evidence", async () => {
  const root = await fixture();
  try {
    await receipt(root);
    await record(root, "current");
    let attempts = 1;
    for (const [key, expected] of Object.entries(library.temporarySpace)) {
      const mutations = [undefined, null, typeof expected === "number" ? expected + 1 : `${expected}-other`];
      for (const value of mutations) for (const surface of ["attempt", "native"]) {
        const name = `${surface}-${key}-${attempts}`;
        const changed = { ...library.temporarySpace, [key]: value };
        const dir = await record(root, name, surface === "attempt" ? { temporarySpace: changed } : {});
        if (surface === "native")
          await writeFile(path.join(dir, "report.json"), JSON.stringify({ ok: true, native: { resources: { temporary_space: changed } } }));
        attempts++;
      }
    }
    const result = summary(root);
    assert.equal(result.overallAttempts, attempts);
    assert.equal(result.overallPassed, 1);
    assert.equal(result.overallPassRate, 1 / attempts);
    assert.equal(result.rows[0].temporarySpaceQualifiedAttempts, 1);
    assert.deepEqual(result.rows[0].temporarySpaceEvidenceKinds,
      [library.temporarySpace.scope, "legacy-or-mismatched-contract"].sort());
    assert.equal(result.physicalLibraryQualified, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy and future-version flags cannot acquire current managed qualification or leave the denominator", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1000 }).filter((version) => version !== library.version), async (version) => {
    const root = await fixture();
    try {
      await receipt(root);
      const dir = await record(root, "other-version", { version });
      const original = await readFile(path.join(dir, "promise-library.json"), "utf8");
      const result = summary(root);
      assert.equal(result.overallAttempts, 1);
      assert.equal(result.overallPassed, 0);
      assert.equal(result.rows[0].temporarySpaceQualifiedAttempts, 0);
      assert.equal(result.rows[0].status, "attempted-unqualified");
      assert.equal(await readFile(path.join(dir, "promise-library.json"), "utf8"), original);
    } finally { await rm(root, { recursive: true, force: true }); }
  }), { numRuns: 12, examples: [[0], [library.version - 1], [library.version + 1]] });
});

test("declaring the current managed contract does not replace qualification or physical-device proof", async () => {
  const root = await fixture();
  try {
    await receipt(root);
    await record(root, "declared-only", { temporarySpaceQualified: false });
    await record(root, "unspecified", { version: undefined, temporarySpace: undefined });
    const result = summary(root);
    assert.equal(result.overallAttempts, 2);
    assert.equal(result.overallPassed, 0);
    assert.equal(result.rows[0].temporarySpaceQualifiedAttempts, 0);
    assert.deepEqual(result.rows[0].temporarySpaceEvidenceKinds, ["legacy-or-mismatched-contract", "unqualified"]);
    assert.equal(result.physicalLibraryQualified, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("non-promise runs cannot raise promise success or qualification", async () => {
  for (const kind of ["pilot", "measurement", "stretch"]) {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 12 }), async (count) => {
      const root = await fixture([definition, { ...definition, id: kind, kind }]);
      try {
        await receipt(root);
        await record(root, "failed", { passed: false });
        for (let index = 0; index < count; index++) await record(root, `${kind}-${index}`, { caseId: kind, kind });
        const result = summary(root);
        const row = result.rows.find((entry) => entry.caseId === kind);
        assert.equal(row.attempts, count);
        assert.equal(row.softwareQualified, false);
        assert.equal(row.physicalQualified, false);
        assert.equal(result.pilotAttempts, kind === "pilot" ? count : 0);
        assert.equal(result.plannedVariants, 1);
        assert.equal(result.overallAttempts, 1);
        assert.equal(result.overallPassRate, 0);
        assert.equal(result.softwareLibraryQualified, false);
      } finally { await rm(root, { recursive: true, force: true }); }
    }), { numRuns: 4 });
  }
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

test("recorded booleans cannot qualify an attempt without the raw measurements they claim to summarize", async () => {
  const good = qualifiedEvidence(library.temporarySpace);
  const mutated = (pick, change) => { const copy = structuredClone(good); change(pick(copy)); return copy; };
  const failures = {
    "no-temporary-evidence": { temporarySpaceEvidence: undefined },
    "no-estimate-evidence": { estimateEvidence: undefined },
    "allowance-still-held-after-settlement": { temporarySpaceEvidence: mutated((e) => e.temporarySpaceEvidence,
      (evidence) => evidence.passes[1].samples.push({ atMs: 500, temporaryBytes: evidence.passes[1].beforeBytes - 4096 })).temporarySpaceEvidence },
    "cold-export-leaked-its-allowance": { temporarySpaceEvidence: mutated((e) => e.temporarySpaceEvidence,
      (evidence) => { evidence.passes[0].samples = [{ atMs: 0, temporaryBytes: evidence.passes[0].beforeBytes - 1 }]; }).temporarySpaceEvidence },
    "repeated-export-left-its-scratch-behind": { temporarySpaceEvidence: mutated((e) => e.temporarySpaceEvidence,
      (evidence) => { evidence.passes[1].scratchCleaned = false; }).temporarySpaceEvidence },
    "estimate-hidden-by-the-confirmation": { estimateEvidence: mutated((e) => e.estimateEvidence,
      (evidence) => { evidence.estimate.preflight = [{ message: REAL_COLD_MESSAGE, warning: true }]; }).estimateEvidence },
    "cold-export-was-not-cold": { estimateEvidence: mutated((e) => e.estimateEvidence, (evidence) => { evidence.cold.historySamples = 1; }).estimateEvidence },
    "silent-without-readiness": { estimateEvidence: mutated((e) => e.estimateEvidence, (evidence) => { evidence.estimate.readiness = "unknown"; }).estimateEvidence },
  };
  for (const [name, override] of Object.entries(failures)) {
    const root = await fixture();
    try {
      await receipt(root);
      // The flags still claim qualification: only the evidence differs.
      await record(root, name, { ...override, temporarySpaceQualified: true, estimateProvided: true });
      const result = summary(root);
      assert.equal(result.overallAttempts, 1, name);
      assert.equal(result.overallPassed, 0, name);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  const root = await fixture();
  try {
    await receipt(root);
    await record(root, "honest");
    const result = summary(root);
    assert.equal(result.overallPassed, 1);
    assert.equal(result.rows[0].temporarySpaceQualifiedAttempts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a promise line must meet its speed line on the cold export as well as the repeated one, but only on 16 GB", async () => {
  const limitMs = definition.durationSeconds * definition.speedFactor16gb * 1000;
  for (const [cold, repeated, passes] of [[limitMs, limitMs, 1], [limitMs + 1, 1000, 0], [1000, limitMs + 1, 0], [undefined, 1000, 0], [Number.NaN, 1000, 0]]) {
    const root = await fixture([definition], ["win32"], ["16gb"]);
    try {
      await receipt(root);
      await record(root, "attempt", { profile: "16gb", elapsedMs: repeated, coldPass: { elapsedMs: cold } });
      assert.equal(summary(root).overallPassed, passes, `cold=${cold} repeated=${repeated}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  const root = await fixture();
  try {
    await receipt(root);
    await record(root, "slow-cold-on-8gb", { coldPass: { elapsedMs: 10 ** 9 } });
    assert.equal(summary(root).overallPassed, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an artifact flag cannot qualify an attempt whose recorded caption measurements fail on either export", async () => {
  const failures = {
    "captions-never-painted-on-the-repeated-export": { captionSamples: [0, 0] },
    "captions-already-visible-before-the-fade": { captionSamples: [270, 270] },
    "captions-missing-from-the-repeated-export": { captionSamples: undefined },
    "captions-never-painted-on-the-cold-export": { coldVerification: { captionSamples: [0, 0] } },
    "cold-export-was-never-verified": { coldVerification: undefined },
  };
  for (const [name, override] of Object.entries(failures)) {
    const root = await fixture();
    try {
      await receipt(root);
      await record(root, name, { ...override, artifactVerified: true });
      assert.equal(summary(root).overallPassed, 0, name);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("a real-world source needs its recorded picture proof on both exports, and a record cannot opt out", async () => {
  const phone = library.cases.find((entry) => entry.id === "phone-vfr-rotation");
  assert.equal(library.sourceClasses[phone.source].realWorld, true);
  const frames = Math.round(phone.durationSeconds * phone.fps);
  const attempt = (override = {}) => ({ caseId: phone.id, definition: phone, projectFrames: frames,
    encodedVideo: { width: phone.width, height: phone.height, fps: `${phone.fps}/1`, frames },
    sourcePictureProof: REAL_PHONE_PICTURES, coldVerification: { captionSamples: REAL_CAPTION_SAMPLES, sourcePictureProof: REAL_PHONE_PICTURES }, ...override });
  const lost = REAL_PHONE_PICTURES.map((sample, index) => index === 1 ? { ...sample, sourceError: sample.blankError } : sample);
  const rotationIgnored = REAL_PHONE_PICTURES.map((sample, index) => index === 2 ? { ...sample, sourceError: sample.controlError } : sample);
  const cases = {
    "no-picture-proof": [attempt({ sourcePictureProof: undefined }), 0],
    "record-claims-it-is-not-real-world": [attempt({ sourcePictureProof: undefined, fixture: { realWorld: false } }), 0],
    "repeated-export-lost-its-picture": [attempt({ sourcePictureProof: lost }), 0],
    "repeated-export-ignored-the-rotation": [attempt({ sourcePictureProof: rotationIgnored }), 0],
    "cold-export-has-no-picture-proof": [attempt({ coldVerification: { captionSamples: REAL_CAPTION_SAMPLES } }), 0],
    "cold-export-lost-its-picture": [attempt({ coldVerification: { captionSamples: REAL_CAPTION_SAMPLES, sourcePictureProof: lost } }), 0],
    "both-exports-proven": [attempt(), 1],
  };
  for (const [name, [override, passes]] of Object.entries(cases)) {
    const root = await fixture([phone]);
    try {
      await receipt(root);
      await record(root, name, { ...override, artifactVerified: true });
      assert.equal(summary(root).overallPassed, passes, name);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
