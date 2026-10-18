import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "../..");
const reports = path.join(repository, "reports/qa/exporter");
const allocationBytes = 192 * 1024 ** 2;
const discriminatorCap = 128 * 1024 ** 2;
const scope = "linux-cgroup-v2-process-tree-simulation";
const bytes = (value) => Number.isSafeInteger(value) && value >= 0;
const groupPath = (value) => typeof value === "string" && value.startsWith("/") &&
  !/[\0\r\n]/.test(value) && (value === "/" ||
    value.slice(1).split("/").every((part) => part && part !== "." && part !== ".."));

export function cgroupMembership(text) {
  const groups = text.split("\n").filter((line) => line.startsWith("0::")).map((line) => line.slice(3));
  assert.ok(groups.length === 1 && groupPath(groups[0]), "Unified cgroup membership is unavailable or malformed");
  return groups[0];
}

export function memoryLimit(text) {
  const value = text.trim();
  if (value === "max") return null;
  assert.match(value, /^\d+$/, "Cgroup memory limit is malformed");
  const result = Number(value);
  assert.ok(bytes(result), "Cgroup memory limit is outside the supported range");
  return result;
}

export async function memoryHierarchy(root, directory) {
  root = path.resolve(root);
  directory = path.resolve(directory);
  assert.ok(directory === root || directory.startsWith(`${root}${path.sep}`), "Cgroup escaped its mount");
  let memory = null, swap = null;
  for (let current = directory; ; current = path.dirname(current)) {
    for (const filename of ["memory.max", "memory.swap.max"]) {
      let text;
      try { text = await readFile(path.join(current, filename), "utf8"); }
      catch (error) { if (current === root && error.code === "ENOENT") continue; throw error; }
      const limit = memoryLimit(text);
      if (limit !== null) {
        if (filename === "memory.max") memory = Math.min(memory ?? limit, limit);
        else swap = Math.min(swap ?? limit, limit);
      }
    }
    if (current === root) break;
  }
  return { memory_max_bytes: memory, swap_max_bytes: swap };
}

export async function readLinuxMemoryCgroup(pid = process.pid) {
  assert.equal(process.platform, "linux", "Cgroup measurements require Linux");
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "Invalid cgroup process identity");
  const proc = `/proc/${pid}/cgroup`;
  const membership = await readFile(proc, "utf8");
  const group = cgroupMembership(membership);
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  assert.ok(mounts.split("\n").some((line) => {
    const [left, right] = line.split(" - ");
    const fields = left.split(" ");
    return fields[3] === "/" && fields[4] === "/sys/fs/cgroup" && right?.split(" ")[0] === "cgroup2";
  }), "Standard unified cgroup mount is unavailable");
  const root = "/sys/fs/cgroup";
  const directory = path.join(root, group);
  const before = await stat(directory, { bigint: true });
  const limits = await memoryHierarchy(root, directory);
  const after = await stat(directory, { bigint: true });
  assert.ok(before.dev === after.dev && before.ino === after.ino &&
    cgroupMembership(await readFile(proc, "utf8")) === group, "Cgroup identity changed during measurement");
  return { version: 2, path: group, identity: `${after.dev}:${after.ino}`, process_id: pid, ...limits };
}

export function cgroupFits(group, bound) {
  return bytes(bound) && bound > 0 && group?.version === 2 && groupPath(group.path) &&
    typeof group.identity === "string" && /^\d+:\d+$/.test(group.identity) &&
    Number.isSafeInteger(group.process_id) && group.process_id > 0 &&
    bytes(group.memory_max_bytes) && group.memory_max_bytes > 0 && group.memory_max_bytes <= bound &&
    group.swap_max_bytes === 0;
}

export function sameCgroup(first, second) {
  return cgroupFits(first, Number.MAX_SAFE_INTEGER) && cgroupFits(second, Number.MAX_SAFE_INTEGER) &&
    ["version", "path", "identity", "memory_max_bytes", "swap_max_bytes"].every((key) => first[key] === second[key]);
}

export async function cgroupEncoderPids(directory, procDirectory) {
  const text = (await readFile(path.join(directory, "cgroup.procs"), "utf8")).trim();
  const members = text ? text.split("\n") : [];
  const encoders = [];
  for (const member of members) {
    assert.match(member, /^[1-9]\d*$/, "Cgroup process identity is malformed");
    const pid = Number(member);
    assert.ok(Number.isSafeInteger(pid), "Cgroup process identity is outside the supported range");
    let name;
    try { name = await readFile(path.join(procDirectory, member, "comm"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    // WebKit siblings can deny exe inspection; comm only selects candidates for the mandatory executable/hash checks.
    if (name === "artdaddy-ffmpeg\n") encoders.push(pid);
  }
  return encoders;
}

export function discriminatorVerified(receipt) {
  return receipt?.scope === scope && receipt.workload === "Discriminator" && receipt.exitCode === 0 &&
    receipt.configuredMemoryLimitBytes === discriminatorCap && receipt.control?.exitCode === 0 &&
    receipt.control.completedBytes === allocationBytes && receipt.allocation?.exitCode === 73 &&
    receipt.allocation.completedBytes === null && receipt.eventsAfter?.oom_kill > receipt.eventsBefore?.oom_kill &&
    cgroupFits(receipt.before, discriminatorCap) && sameCgroup(receipt.before, receipt.after) &&
    sameCgroup(receipt.before, receipt.allocation.grandchild);
}

export function linuxProfileVerified(result, envelope, receipt, bound) {
  const evidence = envelope?.memoryCgroupEvidence;
  return envelope?.hardware?.platform === "linux" && result.platform === "linux" &&
    receipt?.scope === scope && receipt.workload === "App" && receipt.exitCode === 0 &&
    typeof result.profileRunId === "string" && /^[a-f0-9]{32}$/.test(result.profileRunId) &&
    receipt.runId === result.profileRunId && evidence?.runId === receipt.runId &&
    receipt.applicationIdentifier === envelope.identifier &&
    evidence?.nativeBefore?.process_id !== evidence?.nativeAfter?.process_id &&
    evidence?.nodeBefore?.process_id === evidence?.nodeAfter?.process_id &&
    bytes(receipt.configuredMemoryLimitBytes) && receipt.configuredMemoryLimitBytes > 0 &&
    receipt.configuredMemoryLimitBytes <= bound && discriminatorVerified(receipt.discriminator) &&
    cgroupFits(receipt.before, receipt.configuredMemoryLimitBytes) &&
    receipt.before.path.endsWith(`/artdaddy-export-qa-${receipt.runId}.service`) &&
    Array.isArray(evidence.workers) && evidence.workers.length > 0 &&
    evidence.workers.every((worker) => sameCgroup(receipt.before, worker.cgroup) &&
      typeof worker.sha256 === "string" && /^[a-f0-9]{64}$/.test(worker.sha256) &&
      worker.sha256 === envelope.native?.workerIdentity?.sha256) &&
    [receipt.after, evidence.nodeBefore, evidence.nodeAfter, evidence.nativeBefore,
      evidence.nativeAfter, envelope.native?.resources?.memory_cgroup]
      .every((group) => sameCgroup(receipt.before, group));
}

async function memoryEvents(group) {
  const text = await readFile(path.join("/sys/fs/cgroup", group.path, "memory.events"), "utf8");
  const events = Object.fromEntries(text.trim().split("\n").map((line) => line.split(" ").map((part, index) => index ? Number(part) : part)));
  assert.ok(bytes(events.oom_kill), "Kernel did not report the allocation outcome");
  return events;
}

function allocationTree() {
  const run = spawnSync(process.execPath, [script, "--allocation-tree"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.ifError(run.error);
  const records = run.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const first = records.find((record) => record.phase === "allocator-start");
  return { exitCode: run.status, signal: run.signal, grandchild: first?.cgroup ?? null,
    completedBytes: records.find((record) => record.phase === "allocator-complete")?.bytes ?? null,
    stderr: run.stderr };
}

async function execute(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`${command} ended by ${signal}`)) : resolve(code));
  });
}

async function inside(runId, cap, selfTest) {
  assert.match(runId, /^[a-f0-9]{32}$/);
  assert.notEqual(process.getuid(), 0, "The app must not run as root");
  const before = await readLinuxMemoryCgroup();
  assert.ok(cgroupFits(before, cap), "Requested memory cap is not active");
  assert.ok(before.path.endsWith(`/artdaddy-export-qa-${runId}.service`), "Wrong inherited QA cgroup");
  const receipt = { scope, workload: selfTest ? "Discriminator" : "App", runId,
    configuredMemoryLimitBytes: cap, before, physicalMinimumMachine: false, exactPeakCeiling: false };
  const existing = new Set(await readdir(reports));
  try {
    receipt.eventsBefore = await memoryEvents(before);
    if (selfTest) {
      receipt.allocation = allocationTree();
      receipt.exitCode = receipt.allocation.exitCode === 73 ? 0 : 1;
    } else {
      receipt.exitCode = await execute("xvfb-run", ["-a", "dbus-run-session", "--", process.execPath,
        path.join(repository, "scripts/qa/exporterNative.mjs")]);
      const candidates = (await readdir(reports)).filter((name) => !existing.has(name) && name.startsWith("x86_64-unknown-linux-gnu-"));
      assert.equal(candidates.length, 1, "Expected one source-bound native app report");
      const native = JSON.parse(await readFile(path.join(reports, candidates[0], "report.json"), "utf8"));
      assert.equal(native.memoryCgroupEvidence?.runId, runId, "Native report did not bind this kernel run");
      receipt.applicationIdentifier = native.identifier;
      receipt.nativeReport = candidates[0];
    }
    receipt.after = await readLinuxMemoryCgroup();
    receipt.eventsAfter = await memoryEvents(before);
    assert.ok(sameCgroup(before, receipt.after), "QA cgroup changed while work was running");
    return receipt.exitCode;
  } catch (error) {
    receipt.exitCode = 1;
    receipt.error = String(error);
    throw error;
  } finally {
    await writeFile(path.join(reports, `memory-${runId}.json`), JSON.stringify(receipt, null, 2));
  }
}

async function cappedRun(cap, selfTest) {
  const runId = randomUUID().replaceAll("-", "");
  const unit = `artdaddy-export-qa-${runId}.service`;
  const environment = ["HOME", "PATH", "CARGO_HOME", "CARGO_BUILD_JOBS", "TAURI_CONFIG",
    "VITE_API_BASE_URL", "VITE_SENTRY_DSN", "SENTRY_DSN",
    "ARTDADDY_QA_PROMISE_CASE", "ARTDADDY_QA_PROMISE_PROFILE", "ARTDADDY_QA_SOURCE_MANIFEST"];
  const args = ["-n", "systemd-run", "--wait", "--pipe", "--collect", `--unit=${unit}`,
    `--uid=${process.getuid()}`, `--gid=${process.getgid()}`, `--working-directory=${repository}`,
    "--service-type=exec", "--property=MemoryAccounting=yes", `--property=MemoryMax=${cap}`,
    "--property=MemorySwapMax=0", "--property=OOMPolicy=continue", "--property=Delegate=no", "--property=ProtectControlGroups=yes",
    "--property=RuntimeMaxSec=2700",
    ...environment.filter((key) => process.env[key] !== undefined).map((key) => `--setenv=${key}=${process.env[key]}`),
    `--setenv=ARTDADDY_QA_MEMORY_RUN_ID=${runId}`, `--setenv=ARTDADDY_QA_MEMORY_CAP_BYTES=${cap}`,
    process.execPath, script, "--inside", runId, String(cap), ...(selfTest ? ["--self-test"] : [])];
  const stop = () => {
    const stopped = spawnSync("sudo", ["-n", "systemctl", "stop", unit], { encoding: "utf8" });
    if (stopped.status !== 0) console.error(`Could not stop owned QA unit ${unit}: ${stopped.stderr}`);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const code = await execute("sudo", args);
    assert.equal(code, 0, `Capped QA service failed; inspect memory-${runId}.json and the original log`);
    const receipt = JSON.parse(await readFile(path.join(reports, `memory-${runId}.json`), "utf8"));
    assert.equal(receipt.runId, runId);
    assert.equal(receipt.exitCode, 0);
    return receipt;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function main() {
  assert.equal(process.platform, "linux", "Use a Linux cgroup v2 host");
  await mkdir(reports, { recursive: true });
  if (process.argv.includes("--allocator")) {
    console.log(JSON.stringify({ phase: "allocator-start", cgroup: await readLinuxMemoryCgroup() }));
    const values = Array.from({ length: 24 }, () => Buffer.alloc(8 * 1024 ** 2, 37));
    console.log(JSON.stringify({ phase: "allocator-complete", bytes: values.reduce((sum, value) => sum + value.length, 0) }));
    return;
  }
  if (process.argv.includes("--allocation-tree")) {
    const run = spawnSync(process.execPath, [script, "--allocator"], { stdio: "inherit", detached: true });
    assert.ifError(run.error);
    process.exitCode = run.signal === "SIGKILL" ? 73 : run.status ?? 1;
    return;
  }
  const position = process.argv.indexOf("--inside");
  if (position !== -1) {
    process.exitCode = await inside(process.argv[position + 1], Number(process.argv[position + 2]), process.argv.includes("--self-test"));
    return;
  }
  const control = allocationTree();
  assert.equal(control.exitCode, 0, "Unrestricted control failed: this host cannot demonstrate the cap");
  assert.equal(control.completedBytes, allocationBytes);
  const discriminator = await cappedRun(discriminatorCap, true);
  discriminator.control = control;
  assert.ok(discriminatorVerified(discriminator), "The kernel cap had no demonstrated allocation effect");
  await writeFile(path.join(reports, `memory-${discriminator.runId}.json`), JSON.stringify(discriminator, null, 2));
  console.log(`PASS Linux inherited allocation discriminator: control=${control.completedBytes}, capped=${discriminatorCap}, oomKills=${discriminator.eventsAfter.oom_kill - discriminator.eventsBefore.oom_kill}`);
  if (process.argv.includes("--self-test")) return;
  const receipt = await cappedRun(8 * 1024 ** 3, false);
  receipt.discriminator = discriminator;
  await writeFile(path.join(reports, `memory-${receipt.runId}.json`), JSON.stringify(receipt, null, 2));
  const native = JSON.parse(await readFile(path.join(reports, receipt.nativeReport, "report.json"), "utf8"));
  assert.ok(linuxProfileVerified({ platform: "linux", profileRunId: receipt.runId }, native, receipt, 8 * 1024 ** 3),
    "Actual app and recovery did not match the demonstrated kernel profile");
  console.log(`PASS Linux 8 GB software-profile inputs: ${receipt.nativeReport}; physical/full-size/promise qualification remains false`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  await main();
}
