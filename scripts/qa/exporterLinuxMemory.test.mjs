import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import fc from "fast-check";
import { cgroupMembership, memoryLimit, memoryHierarchy, cgroupFits, sameCgroup,
  discriminatorVerified, linuxProfileVerified } from "./exporterLinuxMemory.mjs";

test("nested membership parsing preserves supported names and cannot escape its mount", () => {
  const component = fc.array(fc.constantFrom("a", "Z", "0", " ", "'", ":", ";", ".", "ü"), { minLength: 1, maxLength: 24 })
    .map((parts) => parts.join("")).filter((part) => part !== "." && part !== "..");
  fc.assert(fc.property(fc.array(component, { minLength: 1, maxLength: 24 }), (parts) => {
    const group = `/${parts.join("/")}`;
    assert.equal(cgroupMembership(`7:cpu:/unrelated\n0::${group}\n`), group);
    for (const escape of ["/../", "/./", "//"]) {
      assert.throws(() => cgroupMembership(`0::${group}${escape}other\n`));
    }
    assert.throws(() => cgroupMembership(`0::${group}\n0::/other\n`));
  }), { numRuns: 150 });
  for (const malformed of ["", "1:memory:/legacy", "0::relative", "0::/a\0b", "0::/a\rb", "0::/a\r\n"])
    assert.throws(() => cgroupMembership(malformed));
  assert.equal(cgroupMembership("0::/\n"), "/");
});

test("limit parsing retains zero and unlimited as distinct facts and refuses unsafe values", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (limit) => {
    assert.equal(memoryLimit(`${limit}\n`), limit);
    assert.throws(() => memoryLimit(`${limit}junk`));
  }));
  assert.equal(memoryLimit("max\n"), null);
  for (const value of ["", "-1", "+1", "NaN", "Infinity", "1.5", "9007199254740992"])
    assert.throws(() => memoryLimit(value));
});

test("all ancestor caps constrain the result, independent of which level owns the smallest limit", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 32768 }), { minLength: 2, maxLength: 8 }),
    fc.boolean(), async (limits, reverse) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "artdaddy-cgroup-tree-"));
      try {
        const ordered = reverse ? [...limits].reverse() : limits;
        let current = root;
        for (const limit of ordered) {
          current = path.join(current, "child");
          await mkdir(current);
          await writeFile(path.join(current, "memory.max"), String(limit * 1024 ** 2));
          await writeFile(path.join(current, "memory.swap.max"), "0");
        }
        const result = await memoryHierarchy(root, current);
        assert.ok(limits.every((limit) => result.memory_max_bytes <= limit * 1024 ** 2));
        assert.ok(limits.some((limit) => result.memory_max_bytes === limit * 1024 ** 2));
        assert.equal(result.swap_max_bytes, 0);
        await writeFile(path.join(current, "memory.max"), "max");
        assert.ok((await memoryHierarchy(root, current)).memory_max_bytes > 0, "An unlimited leaf must not discard its parent cap");
        await writeFile(path.join(current, "memory.swap.max"), "unknown");
        await assert.rejects(memoryHierarchy(root, current));
        await rm(path.join(current, "memory.swap.max"));
        await assert.rejects(memoryHierarchy(root, current));
      } finally { await rm(root, { recursive: true, force: true }); }
    }), { numRuns: 24 });
});

function linuxEvidence(limit = 8 * 1024 ** 3) {
  const runId = "a".repeat(32);
  const group = { version: 2, path: `/system.slice/artdaddy-export-qa-${runId}.service`,
    identity: "29:712", process_id: 100, memory_max_bytes: limit, swap_max_bytes: 0 };
  const discriminatorGroup = { ...group, path: "/system.slice/discriminator.service", identity: "29:713",
    memory_max_bytes: 128 * 1024 ** 2 };
  const discriminator = { scope: "linux-cgroup-v2-process-tree-simulation", workload: "Discriminator", exitCode: 0,
    configuredMemoryLimitBytes: 128 * 1024 ** 2, before: discriminatorGroup, after: discriminatorGroup,
    control: { exitCode: 0, completedBytes: 192 * 1024 ** 2 },
    allocation: { exitCode: 73, completedBytes: null, grandchild: { ...discriminatorGroup, process_id: 101 } },
    eventsBefore: { oom_kill: 0 }, eventsAfter: { oom_kill: 1 } };
  const receipt = { scope: "linux-cgroup-v2-process-tree-simulation", workload: "App", runId, exitCode: 0,
    configuredMemoryLimitBytes: limit, before: group, after: group, applicationIdentifier: "isolated-app", discriminator };
  const nativeAfter = { ...group, process_id: 201 };
  const worker = { cgroup: { ...group, process_id: 300 }, sha256: "b".repeat(64) };
  const envelope = { identifier: "isolated-app", hardware: { platform: "linux", totalMemoryBytes: 16 * 1024 ** 3 },
    memoryCgroupEvidence: { runId, nodeBefore: group, nodeAfter: group,
      nativeBefore: { ...group, process_id: 200 }, nativeAfter, workers: [worker] },
    native: { resources: { memory_cgroup: nativeAfter }, workerIdentity: { sha256: worker.sha256 } } };
  return { result: { platform: "linux", profileRunId: runId }, envelope, receipt };
}

test("only a matching demonstrated cap qualifies; more host RAM never substitutes for it", () => {
  fc.assert(fc.property(fc.integer({ min: 256, max: 32768 }), fc.integer({ min: 256, max: 32768 }), (capMiB, boundMiB) => {
    const { result, envelope, receipt } = linuxEvidence(capMiB * 1024 ** 2);
    assert.equal(linuxProfileVerified(result, envelope, receipt, boundMiB * 1024 ** 2), capMiB <= boundMiB);
    assert.equal(cgroupFits(receipt.before, boundMiB * 1024 ** 2), capMiB <= boundMiB);
    assert.equal(discriminatorVerified(receipt.discriminator), true);
    assert.equal(sameCgroup(receipt.before, { ...receipt.before, process_id: 999 }), true);
  }), { numRuns: 80 });
});

test("failure, changed identity, missing worker and non-effective compiler flags cannot qualify", () => {
  const mutations = [
    (p) => { p.result.profileRunId = "unrelated"; },
    (p) => { p.receipt.exitCode = 1; },
    (p) => { p.receipt.before.memory_max_bytes = null; },
    (p) => { p.receipt.before.swap_max_bytes = 1; },
    (p) => { p.receipt.applicationIdentifier = "other-app"; },
    (p) => { p.envelope.memoryCgroupEvidence.nativeBefore.identity = "29:999"; },
    (p) => { p.envelope.memoryCgroupEvidence.nativeAfter.memory_max_bytes += 1; },
    (p) => { p.envelope.memoryCgroupEvidence.nativeAfter.process_id = 200; },
    (p) => { p.envelope.memoryCgroupEvidence.nodeAfter.process_id += 1; },
    (p) => { p.envelope.memoryCgroupEvidence.workers = []; },
    (p) => { p.envelope.native.workerIdentity.sha256 = "c".repeat(64); },
    (p) => { p.receipt.discriminator.eventsAfter.oom_kill = 0; },
    (p) => { p.receipt.discriminator.allocation.completedBytes = 192 * 1024 ** 2; },
    (p) => { p.receipt.discriminator.control.exitCode = 1; },
    (p) => { p.receipt.discriminator.allocation.grandchild.identity = "29:999"; },
  ];
  for (const mutate of mutations) {
    const original = linuxEvidence();
    const proof = JSON.parse(JSON.stringify(original));
    mutate(proof);
    assert.equal(linuxProfileVerified(proof.result, proof.envelope, proof.receipt, 8 * 1024 ** 3), false, mutate.toString());
  }
});

test("offline report requires the actual receipt for every declared Linux software profile", async () => {
  const library = JSON.parse(await readFile(new URL("./exporterPromiseCases.json", import.meta.url), "utf8"));
  const definition = library.cases.find((entry) => entry.kind === "promise" && entry.source === "generated");
  assert.ok(definition);
  for (const [profile, limits] of Object.entries(library.profiles)) {
    const root = await mkdtemp(path.join(os.tmpdir(), "artdaddy-linux-profile-report-"));
    try {
      await mkdir(path.join(root, "scripts/qa"), { recursive: true });
      const directory = path.join(root, "reports/qa/exporter/native");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(root, "scripts/qa/exporterPromiseCases.json"), JSON.stringify({
        ...library, cases: [definition], platforms: ["linux"], profiles: { [profile]: limits },
      }));
      const { result, envelope, receipt } = linuxEvidence(limits.systemMemoryBytes);
      const frames = Math.round(definition.durationSeconds * definition.fps);
      const attempt = { ...result, caseId: definition.id, kind: "promise", profile, mode: "quality", definition,
        encodedVideo: { width: definition.width, height: definition.height, fps: `${definition.fps}/1`, frames },
        projectFrames: frames, elapsedMs: 1000, readiness: "ready", passed: true, artifactVerified: true,
        publicationVerified: true, stagingCleaned: true, scratchCleaned: true, sourceReady: true,
        temporarySpaceQualified: true, estimateProvided: true, physicalQualified: false };
      envelope.ok = true;
      await writeFile(path.join(directory, "promise-library.json"), JSON.stringify(attempt));
      await writeFile(path.join(directory, "report.json"), JSON.stringify(envelope));
      const summary = () => {
        const run = spawnSync(process.execPath, [fileURLToPath(new URL("./exporterPromiseReport.mjs", import.meta.url)), root], { encoding: "utf8" });
        assert.equal(run.status, 0, run.stderr);
        return JSON.parse(run.stdout);
      };
      assert.equal(summary().overallPassed, 0, `${profile}: nominal flags cannot replace the missing receipt`);
      const file = path.join(root, "reports/qa/exporter/memory-proof.json");
      await writeFile(file, JSON.stringify(receipt));
      const accepted = summary();
      assert.equal(accepted.overallPassed, 1);
      assert.deepEqual(accepted.rows[0].profileEvidenceKinds, ["linux-kernel-cgroup-v2"]);
      assert.equal(accepted.physicalLibraryQualified, false);
      receipt.discriminator.eventsAfter.oom_kill = 0;
      await writeFile(file, JSON.stringify(receipt));
      const refused = summary();
      assert.equal(refused.overallAttempts, 1);
      assert.equal(refused.overallPassed, 0, `${profile}: an ineffective cap must lose qualification, not its denominator`);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
