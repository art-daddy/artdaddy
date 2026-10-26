import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import fc from "fast-check";
import { COLUMNS, alive, classify, parseEvents, parseMeminfo, parsePressure, parseStat, parseStatusRss, readSample, threadFlags } from "./linuxSampler.mjs";

const script = fileURLToPath(new URL("./linuxSampler.mjs", import.meta.url));
const KIB = 1024;
const GIB_KB = 1024 ** 2;
const UNIT = "artdaddy-export-qa-0123456789abcdef0123456789abcdef.service";

// The shape of a real Ubuntu 22.04 /proc/meminfo: HugePages_Total has no unit and must not be read as a size.
const MEMINFO = `MemTotal:       ${16 * GIB_KB} kB
MemFree:         9573372 kB
MemAvailable:   ${12 * GIB_KB} kB
Buffers:          160664 kB
Cached:          5156252 kB
SwapCached:            0 kB
SwapTotal:       ${4 * GIB_KB} kB
SwapFree:        ${3 * GIB_KB} kB
Hugetlb:               0 kB
HugePages_Total:       0
HugePages_Free:        0
Hugepagesize:       2048 kB
`;
const PRESSURE = "some avg10=1.25 avg60=0.40 avg300=0.10 total=123456\nfull avg10=0.50 avg60=0.20 avg300=0.05 total=654321\n";
// memory.stat names that START with anon or file (anon_thp, file_mapped, file_dirty) come before and after the whole-line ones.
const STAT = `anon_thp 536870912\nfile_mapped 99\nanon ${2 * 1024 ** 3}\nfile_dirty 77\nfile ${1024 ** 3}\nkernel 4096\n`;
const status = (name, rssKb) => `Name:\t${name}\nUmask:\t0022\nState:\tS (sleeping)\nVmPeak:\t 9999999 kB\nVmSize:\t 9999999 kB\nVmRSS:\t ${rssKb} kB\nRssAnon:\t ${rssKb - 1} kB\n`;

async function fakeMachine(spec) {
  const root = await mkdtemp(path.join(os.tmpdir(), "artdaddy-linux-sampler-"));
  const proc = path.join(root, "proc");
  const cgroup = path.join(root, "cgroup");
  await mkdir(proc, { recursive: true });
  await mkdir(path.join(cgroup, "system.slice"), { recursive: true });
  const put = (file, text) => writeFile(file, text, "utf8");
  if (spec.meminfo) await put(path.join(proc, "meminfo"), MEMINFO);
  if (spec.loadavg) await put(path.join(proc, "loadavg"), "0.52 0.40 0.30 1/321 4242\n");
  if (spec.pressure) { await mkdir(path.join(proc, "pressure")); await put(path.join(proc, "pressure", "memory"), PRESSURE); }
  if (spec.unit) {
    const directory = path.join(cgroup, "system.slice", UNIT);
    await mkdir(directory);
    if (spec.current) await put(path.join(directory, "memory.current"), `${3 * 1024 ** 3}\n`);
    if (spec.peak) await put(path.join(directory, "memory.peak"), `${4 * 1024 ** 3}\n`);
    if (spec.max) await put(path.join(directory, "memory.max"), `${8 * 1024 ** 3}\n`);
    if (spec.events) await put(path.join(directory, "memory.events"), "low 0\nhigh 0\nmax 17\noom 2\noom_kill 2\noom_group_kill 0\n");
    if (spec.stat) await put(path.join(directory, "memory.stat"), STAT);
  }
  for (const [pid, name, rssKb, withStatus = true, cmdline = ""] of spec.processes ?? []) {
    await mkdir(path.join(proc, String(pid)));
    await put(path.join(proc, String(pid), "comm"), `${name}\n`);
    if (cmdline) await put(path.join(proc, String(pid), "cmdline"), cmdline);
    if (withStatus) await put(path.join(proc, String(pid), "status"), status(name, rssKb));
  }
  return { root, proc, cgroup };
}

const nul = (...args) => `${args.join("\0")}\0`;
// A one-pass command as the product builds it: a thread flag in front of each input, and one for the encoder after the last -c:v.
const ONE_PASS = nul("artdaddy-ffmpeg", "-hide_banner", "-threads:v", "1", "-i", "a.mp4", "-threads:v", "1", "-i", "b.mp4", "-filter_complex", "[0][1]overlay",
  "-c:v", "libx264", "-threads:v", "2", "out.mp4");
const PRODUCER = nul("artdaddy-ffmpeg", "-threads:v", "3", "-i", "c.mp4", "-c:v", "rawvideo", "pipe:1");

const row = (text) => Object.fromEntries(COLUMNS.map((column, index) => [column, text.split("\t")[index]]));
const ALL = { meminfo: true, loadavg: true, pressure: true, unit: true, current: true, peak: true, max: true, events: true, stat: true };
const PROCESSES = [[101, "artdaddy-ffmpeg", 2 * GIB_KB, true, ONE_PASS], [102, "artdaddy-ffmpeg", GIB_KB / 2, true, PRODUCER], [103, "artdaddy", GIB_KB / 4],
  [104, "WebKitWebProces", GIB_KB], [105, "WebKitNetworkPr", GIB_KB / 2], [106, "node", GIB_KB * 3 / 4], [107, "node", GIB_KB / 4],
  [108, "bash", 5 * GIB_KB], [109, "artdaddy-ffprob", 5 * GIB_KB]];

test("the parsers read the real file formats, not only the numbers in them", () => {
  const info = parseMeminfo(MEMINFO);
  assert.equal(info.MemTotal, 16 * 1024 ** 3);
  assert.equal(info.MemAvailable, 12 * 1024 ** 3);
  assert.equal(info.HugePages_Total, undefined, "a line without a unit is a count, not a size");
  assert.equal(parseStatusRss(status("x", 2048)), 2048 * KIB);
  assert.equal(parseStatusRss("Name:\tkthreadd\nState:\tS (sleeping)\n"), 0, "a kernel thread has no resident size");
  assert.equal(parsePressure(PRESSURE), "1.25", "the 'some' line, not the 'full' one");
  assert.equal(parsePressure(""), null);
  assert.equal(parseEvents("low 0\nmax 17\noom 2\noom_kill 3\n"), 3, "oom_kill, not oom");
  assert.equal(parseEvents("low 0\n"), null);
  assert.deepEqual(parseStat(STAT), { anon: 2 * 1024 ** 3, file: 1024 ** 3 }, "anon and file, not anon_thp, file_mapped or file_dirty");
  assert.deepEqual(parseStat("anon_thp 5\n"), { anon: null, file: null });
  fc.assert(fc.property(fc.integer({ min: 0, max: 2 ** 40 }), (kb) => parseStatusRss(status("p", kb)) === kb * KIB && parseMeminfo(`MemTotal: ${kb} kB\n`).MemTotal === kb * KIB));
});

test("the thread flags a worker was started with are read by where they sit in its command", async () => {
  assert.deepEqual(threadFlags(ONE_PASS), { decoders: ["1", "1"], encoder: "2", inputs: 2 });
  assert.deepEqual(threadFlags(PRODUCER), { decoders: ["3"], encoder: null, inputs: 1 });
  assert.deepEqual(threadFlags(nul("artdaddy-ffmpeg", "-threads:v", "4", "-i", "a.mp4", "-threads:v", "5", "-i", "b.mp4", "out.mp4")), { decoders: ["4", "5"], encoder: null, inputs: 2 },
    "with no -c:v at all, every flag belongs to an input");
  assert.deepEqual(threadFlags(nul("artdaddy-ffmpeg", "-i", "a.mp4", "-c:v", "libx264", "out.mp4")), { decoders: [], encoder: null, inputs: 1 }, "no flag, no value");
  assert.deepEqual(threadFlags(nul("artdaddy-ffmpeg", "-threads:v", "auto", "-i", "a.mp4", "-threads:v")), { decoders: [], encoder: null, inputs: 1 }, "a flag without a number is not a count");
  assert.deepEqual(threadFlags(""), { decoders: [], encoder: null, inputs: 0 });
  await fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 24 }), { maxLength: 32 }), fc.option(fc.integer({ min: 1, max: 8 }), { nil: null }), (counts, encoder) => {
    const args = ["artdaddy-ffmpeg", "-hide_banner", ...counts.flatMap((count, index) => ["-threads:v", String(count), "-i", `in${index}.mp4`]), "-c:v", "libx264",
      ...(encoder === null ? [] : ["-threads:v", String(encoder)]), "out.mp4"];
    assert.deepEqual(threadFlags(nul(...args)), { decoders: counts.map(String), encoder: encoder === null ? null : String(encoder), inputs: counts.length });
  }));
});

test("only the export's own processes are counted, by the name the kernel gives them", () => {
  assert.equal(classify("artdaddy-ffmpeg"), "worker");
  assert.equal(classify("artdaddy"), "app");
  assert.equal(classify("WebKitWebProces"), "webkit");
  assert.equal(classify("WebKitNetworkPr"), "webkit");
  assert.equal(classify("node"), "node");
  for (const other of ["artdaddy-ffprob", "artdaddy-ffmpeg2", "ffmpeg", "nodemon", "bash", "", "ARTDADDY"]) assert.equal(classify(other), null, other);
});

test("a sample reports each figure from the machine it read, process by process", async () => {
  const machine = await fakeMachine({ ...ALL, processes: [...PROCESSES, [110, "artdaddy-ffmpeg", 7 * GIB_KB, false]] });
  try {
    await mkdir(path.join(machine.proc, "self"));
    await mkdir(path.join(machine.proc, "sys"));
    const text = await readSample({ proc: machine.proc, cgroup: machine.cgroup, now: new Date("2026-10-27T01:02:03.456Z") });
    assert.deepEqual(row(text), {
      utc: "2026-10-27T01:02:03Z", mem_total_gib: "16.00", mem_available_gib: "12.00", swap_used_gib: "1.00", psi_mem_some_avg10: "1.25", load1: "0.52",
      cg_unit: UNIT, cg_current_gib: "3.00", cg_peak_gib: "4.00", cg_max_gib: "8.00", cg_anon_gib: "2.00", cg_file_gib: "1.00", cg_oom_kill: "2",
      workers: "2", workers_rss_gib: "2.50", largest_worker_rss_gib: "2.00", worker_dec_threads: "1x2+3x1", worker_enc_threads: "2x1", worker_inputs: "2",
      app_rss_gib: "0.25", webkit_rss_gib: "1.50", node_rss_gib: "1.00",
    });
    assert.equal(text.split("\t").length, COLUMNS.length);
  } finally { await rm(machine.root, { recursive: true, force: true }); }
});

test("whatever the machine does not provide is a dash, and the row always has every column", async () => {
  const flags = fc.record({ meminfo: fc.boolean(), loadavg: fc.boolean(), pressure: fc.boolean(), unit: fc.boolean(), current: fc.boolean(),
    peak: fc.boolean(), max: fc.boolean(), events: fc.boolean(), stat: fc.boolean(), withProcesses: fc.boolean() });
  await fc.assert(fc.asyncProperty(flags, async (spec) => {
    const machine = await fakeMachine({ ...spec, processes: spec.withProcesses ? PROCESSES : [] });
    try {
      const fields = row(await readSample({ proc: machine.proc, cgroup: machine.cgroup }));
      assert.equal(Object.keys(fields).length, COLUMNS.length);
      assert.ok(COLUMNS.every((column) => fields[column] !== undefined && fields[column] !== ""), "no empty field");
      if (!spec.meminfo) assert.deepEqual([fields.mem_total_gib, fields.mem_available_gib, fields.swap_used_gib], ["-", "-", "-"]);
      if (spec.meminfo) assert.equal(fields.mem_available_gib, "12.00");
      assert.equal(fields.load1, spec.loadavg ? "0.52" : "-");
      assert.equal(fields.psi_mem_some_avg10, spec.pressure ? "1.25" : "-");
      assert.equal(fields.cg_unit, spec.unit ? UNIT : "-");
      assert.equal(fields.cg_current_gib, spec.unit && spec.current ? "3.00" : "-");
      assert.equal(fields.cg_peak_gib, spec.unit && spec.peak ? "4.00" : "-");
      assert.equal(fields.cg_max_gib, spec.unit && spec.max ? "8.00" : "-");
      assert.equal(fields.cg_anon_gib, spec.unit && spec.stat ? "2.00" : "-");
      assert.equal(fields.cg_file_gib, spec.unit && spec.stat ? "1.00" : "-");
      assert.equal(fields.cg_oom_kill, spec.unit && spec.events ? "2" : "-");
      assert.equal(fields.workers, spec.withProcesses ? "2" : "0");
      assert.deepEqual([fields.worker_dec_threads, fields.worker_enc_threads, fields.worker_inputs], spec.withProcesses ? ["1x2+3x1", "2x1", "2"] : ["-", "-", "-"]);
    } finally { await rm(machine.root, { recursive: true, force: true }); }
  }), { numRuns: 80 });
});

test("an unlimited cgroup says so, and a unit that is not the QA service's is ignored", async () => {
  const machine = await fakeMachine({ ...ALL });
  try {
    await writeFile(path.join(machine.cgroup, "system.slice", UNIT, "memory.max"), "max\n");
    await mkdir(path.join(machine.cgroup, "system.slice", "artdaddy-export-qa-not-a-run-id.service"));
    await mkdir(path.join(machine.cgroup, "system.slice", "cron.service"));
    const fields = row(await readSample({ proc: machine.proc, cgroup: machine.cgroup }));
    assert.equal(fields.cg_max_gib, "max");
    assert.equal(fields.cg_unit, UNIT);
  } finally { await rm(machine.root, { recursive: true, force: true }); }
});

const samplerEnv = (machine) => ({ ...process.env, QA_PROC_ROOT: machine.proc, QA_CGROUP_ROOT: machine.cgroup });

test("a header and one row per sample are written, and the sampler ends when its parent does", async () => {
  const machine = await fakeMachine({ ...ALL, processes: PROCESSES });
  const out = path.join(machine.root, "samples.tsv");
  const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], { stdio: "ignore" });
  try {
    // Asynchronous, so that this process can reap the parent when it ends, as the shell that starts the sampler is reaped by its own parent.
    const sampler = spawn(process.execPath, [script, out, "1", String(parent.pid)], { stdio: ["ignore", "ignore", "pipe"], env: samplerEnv(machine) });
    let stderr = "";
    sampler.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve) => {
      const timer = setTimeout(() => { sampler.kill(); resolve(null); }, 30_000);
      sampler.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(status, 0, stderr || "the sampler outlived its parent");
    const lines = (await readFile(out, "utf8")).trimEnd().split("\n");
    assert.equal(lines[0], COLUMNS.join("\t"));
    assert.ok(lines.length >= 4, `expected the header and at least three rows, got ${lines.length} lines`);
    for (const line of lines.slice(1)) assert.equal(row(line).workers, "2");
  } finally {
    parent.kill();
    await rm(machine.root, { recursive: true, force: true });
  }
});

test("a parent that has exited but has not been reaped is not alive, whatever kill(pid, 0) says", async () => {
  const machine = await fakeMachine({});
  try {
    await mkdir(path.join(machine.proc, String(process.pid)));
    const status = path.join(machine.proc, String(process.pid), "status");
    for (const [state, expected] of [["S (sleeping)", true], ["R (running)", true], ["D (disk sleep)", true], ["T (stopped)", true], ["Z (zombie)", false], ["X (dead)", false]]) {
      await writeFile(status, `Name:\tnode\nState:\t${state}\nTgid:\t${process.pid}\n`, "utf8");
      assert.equal(alive(process.pid, machine.proc), expected, state);
    }
    await rm(status);
    assert.equal(alive(process.pid, machine.proc), true, "with nothing to read, kill(pid, 0) is all there is to go on");
    assert.equal(alive(2 ** 22 + 12345, machine.proc), false, "no such process");
  } finally { await rm(machine.root, { recursive: true, force: true }); }
});

test("a parent that has ended but not been reaped is an ended parent", { skip: process.platform !== "linux" }, async () => {
  const machine = await fakeMachine({ ...ALL, processes: PROCESSES });
  const out = path.join(machine.root, "samples.tsv");
  const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { stdio: "ignore" });
  try {
    // spawnSync keeps this process's event loop from reaping the parent, so it ends as a zombie, and a zombie still answers kill(pid, 0).
    const started = Date.now();
    const sampler = spawnSync(process.execPath, [script, out, "1", String(parent.pid)], { encoding: "utf8", timeout: 20_000, env: samplerEnv(machine) });
    const waited = Date.now() - started;
    assert.match(readFileSync(`/proc/${parent.pid}/status`, "utf8"), /^State:\s+Z/m, "the premise of this test: the parent really is a zombie");
    assert.equal(sampler.status, 0, sampler.stderr || "the sampler never saw the zombie parent end");
    assert.ok(waited >= 1500, `it must not stop before the parent does (waited ${waited} ms)`);
  } finally {
    parent.kill();
    await rm(machine.root, { recursive: true, force: true });
  }
});

test("bad arguments are refused before anything is written", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "artdaddy-linux-sampler-args-"));
  try {
    for (const args of [[], [path.join(dir, "a.tsv"), "0"], [path.join(dir, "a.tsv"), "x"], [path.join(dir, "a.tsv"), "5", "abc"]]) {
      const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
      assert.equal(run.status, 2, JSON.stringify(args));
    }
    assert.equal(spawnSync(process.execPath, ["-e", `process.exit(require("node:fs").existsSync(${JSON.stringify(path.join(dir, "a.tsv"))}) ? 1 : 0)`]).status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("every column is documented at the top of the script", async () => {
  const header = (await readFile(script, "utf8")).split("\nimport ")[0];
  for (const column of COLUMNS) assert.ok(header.includes(column), `${column} is not described`);
});

test("on a real Linux kernel the parsers find what they look for", { skip: process.platform !== "linux" }, async () => {
  const fields = row(await readSample());
  assert.ok(Number(fields.mem_total_gib) > 0, "MemTotal");
  assert.ok(Number(fields.mem_available_gib) > 0 && Number(fields.mem_available_gib) <= Number(fields.mem_total_gib), "MemAvailable");
  assert.ok(Number.isFinite(Number(fields.load1)), "load average");
  assert.ok(Number(fields.node_rss_gib) > 0, "this test runs in a node process, which has a resident size");
});
