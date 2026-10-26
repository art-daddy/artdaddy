// Samples what the Linux kernel says about memory next to the size of the export workers, so the product's own figures can be checked
// against the system's. Read-only, a few milliseconds a sample, one tab-separated row each:
//   node scripts/qa/linuxSampler.mjs <out.tsv> [seconds between samples, default 30] [parent pid to follow]
// It stops by itself when the parent process is gone, so it cannot outlive a batch that was killed.
// Columns (sizes in GiB):
//   utc                               when the sample was taken, to the second
//   mem_total_gib, mem_available_gib  /proc/meminfo MemTotal and MemAvailable (what the kernel can hand out without swapping)
//   swap_used_gib                     SwapTotal - SwapFree
//   psi_mem_some_avg10                percent of the last 10 s in which some task stalled on memory (/proc/pressure/memory)
//   load1                             one-minute load average
//   cg_unit                           the QA service's cgroup (artdaddy-export-qa-<id>.service); "-" while none runs
//   cg_current_gib, cg_peak_gib, cg_max_gib   that cgroup's memory.current, memory.peak (its high-water mark) and memory.max (the cap); both
//                                     count the page cache too, which the kernel gives back before it kills anything
//   cg_anon_gib, cg_file_gib          the same cgroup's memory.stat anon (what processes hold) and file (page cache): the part that can run out
//                                     is the first one
//   cg_oom_kill                       oom_kill in its memory.events (processes the kernel killed inside the cap)
//   workers, workers_rss_gib, largest_worker_rss_gib   the artdaddy-ffmpeg processes (resident size)
//   worker_dec_threads, worker_enc_threads, worker_inputs   what those processes were actually STARTED with, read from /proc/<pid>/cmdline:
//                                     the -threads:v values before the last -c:v (the decoders') and the ones after it (the encoder's), each as
//                                     value x count (1x24 is twenty-four decoders on one thread; 2x3+4x1 three on two and one on four), and the
//                                     most inputs (-i) any one worker has; "-" when none is set
//   app_rss_gib, webkit_rss_gib, node_rss_gib         the app (comm "artdaddy"), WebKit's processes, and node (the harness and its web server)
// A value that cannot be read is "-", never a guess.
import { readFileSync } from "node:fs";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GIB = 1024 ** 3;
export const COLUMNS = ["utc", "mem_total_gib", "mem_available_gib", "swap_used_gib", "psi_mem_some_avg10", "load1", "cg_unit", "cg_current_gib",
  "cg_peak_gib", "cg_max_gib", "cg_anon_gib", "cg_file_gib", "cg_oom_kill", "workers", "workers_rss_gib", "largest_worker_rss_gib",
  "worker_dec_threads", "worker_enc_threads", "worker_inputs", "app_rss_gib", "webkit_rss_gib", "node_rss_gib"];
const UNIT = /^artdaddy-export-qa-[0-9a-f]{32}\.service$/;

const gib = (bytes) => (Number.isFinite(bytes) ? (bytes / GIB).toFixed(2) : "-");
const whole = (text) => (/^\d+$/.test(text?.trim() ?? "") ? Number(text.trim()) : null);

async function tryRead(file) {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

export function parseMeminfo(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB\s*$/.exec(line);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }
  return values;
}

export function parseStatusRss(text) {
  const match = /^VmRSS:\s+(\d+)\s*kB\s*$/m.exec(text);
  return match ? Number(match[1]) * 1024 : 0;
}

export function parsePressure(text) {
  const match = /^some\s+avg10=(\d+(?:\.\d+)?)/m.exec(text);
  return match ? match[1] : null;
}

export function parseEvents(text) {
  const match = /^oom_kill\s+(\d+)\s*$/m.exec(text);
  return match ? Number(match[1]) : null;
}

// memory.stat lists "<name> <bytes>" per line; anon and file are whole-line names, not prefixes of anon_thp, file_mapped and the rest.
export function parseStat(text) {
  const read = (name) => {
    const match = new RegExp(`^${name}\\s+(\\d+)\\s*$`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  return { anon: read("anon"), file: read("file") };
}

// /proc/<pid>/cmdline is the arguments, each ended by a NUL. The thread flags count by where they sit: ffmpeg applies -threads:v to the next
// input when it comes before an -i, and to the next encoder when it comes after the last -c:v (the same rule the harness reads them by).
export function threadFlags(cmdline) {
  const args = cmdline.split("\0");
  if (args[args.length - 1] === "") args.pop();
  const encoderAt = args.lastIndexOf("-c:v");
  const decoders = [];
  let encoder = null;
  let inputs = 0;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "-i") inputs++;
    if (args[index] === "-threads:v" && /^\d+$/.test(args[index + 1] ?? "")) {
      if (encoderAt >= 0 && index > encoderAt) encoder = args[index + 1]; else decoders.push(args[index + 1]);
    }
  }
  return { decoders, encoder, inputs };
}

const tally = (values) => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts.size ? [...counts].sort((a, b) => Number(a[0]) - Number(b[0])).map(([value, count]) => `${value}x${count}`).join("+") : "-";
};

// comm is the first 15 characters of the executable's file name, so "artdaddy-ffmpeg-x86_64-unknown-linux-gnu" reads as "artdaddy-ffmpeg".
export function classify(comm) {
  if (comm === "artdaddy-ffmpeg") return "worker";
  if (comm === "artdaddy") return "app";
  if (comm.startsWith("WebKit")) return "webkit";
  if (comm === "node") return "node";
  return null;
}

async function readCgroup(cgroup) {
  const slice = path.join(cgroup, "system.slice");
  const units = (await readdir(slice).catch(() => [])).filter((name) => UNIT.test(name)).sort();
  if (!units.length) return { unit: "-", current: null, peak: null, max: null, anon: null, file: null, oom: null };
  const unit = units[units.length - 1];
  const directory = path.join(slice, unit);
  const max = (await tryRead(path.join(directory, "memory.max")))?.trim();
  const stat = parseStat((await tryRead(path.join(directory, "memory.stat"))) ?? "");
  return { unit, current: whole(await tryRead(path.join(directory, "memory.current"))), peak: whole(await tryRead(path.join(directory, "memory.peak"))),
    max: max === "max" ? Infinity : whole(max), anon: stat.anon, file: stat.file,
    oom: parseEvents((await tryRead(path.join(directory, "memory.events"))) ?? "") };
}

export async function readSample({ proc = "/proc", cgroup = "/sys/fs/cgroup", now = new Date() } = {}) {
  const meminfo = parseMeminfo((await tryRead(path.join(proc, "meminfo"))) ?? "");
  const pressure = parsePressure((await tryRead(path.join(proc, "pressure", "memory"))) ?? "");
  const load = (await tryRead(path.join(proc, "loadavg")))?.split(" ")[0];
  const group = await readCgroup(cgroup);
  const workers = [];
  const decoders = [];
  const encoders = [];
  let inputs = 0;
  const total = { app: 0, webkit: 0, node: 0 };
  for (const entry of await readdir(proc).catch(() => [])) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    // A process can end between the listing and the reads; whatever vanished is simply not counted.
    const kind = classify(((await tryRead(path.join(proc, entry, "comm"))) ?? "").trim());
    if (!kind) continue;
    const status = await tryRead(path.join(proc, entry, "status"));
    if (status === null) continue;
    const rss = parseStatusRss(status);
    if (kind !== "worker") { total[kind] += rss; continue; }
    workers.push(rss);
    const flags = threadFlags((await tryRead(path.join(proc, entry, "cmdline"))) ?? "");
    decoders.push(...flags.decoders);
    if (flags.encoder !== null) encoders.push(flags.encoder);
    inputs = Math.max(inputs, flags.inputs);
  }
  const swapUsed = Number.isFinite(meminfo.SwapTotal) && Number.isFinite(meminfo.SwapFree) ? meminfo.SwapTotal - meminfo.SwapFree : null;
  return [now.toISOString().replace(/\.\d+Z$/, "Z"), gib(meminfo.MemTotal), gib(meminfo.MemAvailable), gib(swapUsed), pressure ?? "-",
    load && Number.isFinite(Number(load)) ? load : "-", group.unit, gib(group.current), gib(group.peak), group.max === Infinity ? "max" : gib(group.max),
    gib(group.anon), gib(group.file), group.oom ?? "-", String(workers.length), gib(workers.reduce((sum, value) => sum + value, 0)),
    gib(workers.length ? Math.max(...workers) : 0), tally(decoders), tally(encoders), inputs ? String(inputs) : "-", gib(total.app), gib(total.webkit),
    gib(total.node)].join("\t");
}

export function alive(pid, proc = "/proc") {
  try { process.kill(pid, 0); } catch (error) { return error.code === "EPERM"; }
  // A parent that has exited but has not been reaped still answers kill(pid, 0); on Linux its state says what it is.
  try { return !/^State:\s+[ZX]/m.test(readFileSync(path.join(proc, String(pid), "status"), "utf8")); } catch { return true; }
}

export async function sampleUntilParentExits({ out, seconds, parent, proc, cgroup }) {
  await writeFile(out, `${COLUMNS.join("\t")}\n`, "utf8");
  for (;;) {
    await appendFile(out, `${await readSample({ proc, cgroup })}\n`, "utf8");
    if (parent && !alive(parent)) return;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [out, seconds = "30", parent = ""] = process.argv.slice(2);
  if (!out || !(Number(seconds) >= 1) || (parent && !/^[1-9]\d*$/.test(parent))) {
    console.error("usage: node linuxSampler.mjs <out.tsv> [seconds >= 1, default 30] [parent pid]");
    process.exit(2);
  }
  await sampleUntilParentExits({ out, seconds: Number(seconds), parent: parent ? Number(parent) : 0,
    proc: process.env.QA_PROC_ROOT ?? "/proc", cgroup: process.env.QA_CGROUP_ROOT ?? "/sys/fs/cgroup" });
}
