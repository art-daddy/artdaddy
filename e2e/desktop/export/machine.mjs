// Where the PC's processor time goes, read from the kernel's own counters (Win32_Process CPU times): no profiler,
// nothing that slows the run being measured. Two uses:
// - `machineLoad`: is the PC quiet enough to time an export? A time measured while other work runs measures that
//   work too, so the heavy scenarios wait for a quiet PC.
// - `cpuSampler`: during a timed export, how much of the processor the app itself, its encoders, its web view and
//   everything else used. The app should idle while ffmpeg works; a busy app during an export is a bug.
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

const SNAPSHOT = `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime | ForEach-Object { '{0}:{1}:{2}:{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, ([int64]$_.KernelModeTime + [int64]$_.UserModeTime) }`;

/** One sample: pid -> { parent, name, cpu seconds so far }. */
function parse(lines) {
  const procs = new Map();
  for (const line of lines) {
    const m = /^(\d+):(\d+):(.*):(\d+)$/.exec(line.trim());
    if (m) procs.set(Number(m[1]), { parent: Number(m[2]), name: m[3], cpu: Number(m[4]) / 1e7 });
  }
  return procs;
}

function snapshot() {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", SNAPSHOT], { encoding: "utf8", windowsHide: true });
  return { at: Date.now(), procs: parse((r.stdout ?? "").split(/\r?\n/)) };
}

/** CPU seconds each process used between two samples (only processes alive in both). */
function deltas(a, b) {
  const out = [];
  for (const [pid, p] of b.procs) {
    const before = a.procs.get(pid);
    if (before && before.name === p.name && p.cpu >= before.cpu) out.push({ pid, name: p.name, parent: p.parent, seconds: p.cpu - before.cpu });
  }
  return out;
}

/** The processes under `rootPid` (itself included), by the parent links in `procs`. */
function treeOf(rootPid, procs) {
  const tree = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, p] of procs) if (!tree.has(pid) && tree.has(p.parent)) (tree.add(pid), (grew = true));
  }
  return tree;
}

const round = (n, d = 1) => Number(n.toFixed(d));

/** The busiest process names, as cores used on average over `wallSeconds`. */
function topByName(rows, wallSeconds, n = 6) {
  const by = new Map();
  for (const r of rows) by.set(r.name, (by.get(r.name) ?? 0) + r.seconds);
  return [...by]
    .map(([name, s]) => ({ name, cores: round(s / wallSeconds, 2) }))
    .filter((x) => x.cores >= 0.05)
    .sort((a, b) => b.cores - a.cores)
    .slice(0, n);
}

/** How busy the whole PC was over `seconds`: percent of all its processor time, and who used it. */
export function machineLoad(seconds = 10) {
  const a = snapshot();
  spawnSync("powershell", ["-NoProfile", "-Command", `Start-Sleep -Seconds ${seconds}`], { windowsHide: true });
  const b = snapshot();
  const wall = (b.at - a.at) / 1000;
  const rows = deltas(a, b).filter((r) => r.pid !== 0 && !/^(System Idle Process|Idle)$/i.test(r.name));
  const used = rows.reduce((s, r) => s + r.seconds, 0);
  return { busyPercent: round((100 * used) / (wall * os.cpus().length)), seconds: round(wall), top: topByName(rows, wall) };
}

export const describeLoad = (m) =>
  `${m.busyPercent}% of the processor busy over ${m.seconds} s${m.top.length ? ` (${m.top.map((x) => `${x.name} ${x.cores} cores`).join(", ")})` : ""}`;

/** Other heavy work on the PC that is not this run's app: test runners, builds, encoders. Any of it makes a time
 *  measured now a measure of the contention too. */
export function otherHeavyWork(appPid) {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { '{0}\t{1}\t{2}\t{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine }"],
    { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  const procs = new Map();
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const [pid, parent, name, ...cmd] = line.split("\t");
    if (pid) procs.set(Number(pid), { parent: Number(parent), name: name ?? "", cmd: cmd.join("\t") });
  }
  const mine = appPid ? treeOf(appPid, procs) : new Set();
  const heavy = [];
  for (const [pid, p] of procs) {
    if (mine.has(pid) || pid === process.pid) continue;
    const what =
      /^(cargo|rustc|link|cl|msbuild)\.exe$/i.test(p.name) ? p.name
      : /ffmpeg/i.test(p.name) ? `${p.name} (not this run's app)`
      : /^node\.exe$/i.test(p.name) && /vitest|stryker|playwright|wdio|vite(\.js)? build|tsc(\.js)?\b|\bsmoke\b/i.test(p.cmd) ? `node ${(/vitest|stryker|playwright|wdio|vite(\.js)? build|tsc|smoke/i.exec(p.cmd) ?? [""])[0]}`
      : null;
    if (what) heavy.push(what);
  }
  const counted = new Map();
  for (const h of heavy) counted.set(h, (counted.get(h) ?? 0) + 1);
  return [...counted].map(([what, n]) => (n > 1 ? `${what} x${n}` : what));
}

/** Sample every process's CPU time every `everyMs` from one long-lived PowerShell (lighter than one per sample)
 *  until `stop()`, which returns where the time went: the app's own process, its encoders (ffmpeg), its web view,
 *  its other children, and everything else on the PC, each as cores used on average. */
export function cpuSampler(appPid, everyMs = 5000) {
  const script = `while ($true) { '#' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); ${SNAPSHOT}; '.'; [Console]::Out.Flush(); Start-Sleep -Milliseconds ${everyMs} }`;
  const child = spawn("powershell", ["-NoProfile", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const samples = [];
  let buffer = "";
  let current = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("#")) current = { at: Number(line.slice(1)), lines: [] };
      else if (line === "." && current) (samples.push({ at: current.at, procs: parse(current.lines) }), (current = null));
      else current?.lines.push(line);
    }
  });
  return {
    stop() {
      child.kill();
      if (samples.length < 2) return { samples: samples.length, note: "too few samples to say" };
      const sums = { host: 0, encoders: 0, webview: 0, appOther: 0, others: 0 };
      const otherRows = [];
      for (let i = 1; i < samples.length; i++) {
        const tree = treeOf(appPid, samples[i].procs);
        for (const r of deltas(samples[i - 1], samples[i])) {
          if (r.pid === 0 || /^(System Idle Process|Idle)$/i.test(r.name)) continue;
          if (r.pid === appPid) sums.host += r.seconds;
          else if (tree.has(r.pid)) {
            if (/ffmpeg/i.test(r.name)) sums.encoders += r.seconds;
            else if (/^msedgewebview2/i.test(r.name)) sums.webview += r.seconds;
            else sums.appOther += r.seconds;
          } else {
            sums.others += r.seconds;
            otherRows.push(r);
          }
        }
      }
      const wall = (samples.at(-1).at - samples[0].at) / 1000;
      const cores = Object.fromEntries(Object.entries(sums).map(([k, s]) => [k, round(s / wall, 2)]));
      return { samples: samples.length, seconds: round(wall), cores, othersTop: topByName(otherRows, wall, 5), cpus: os.cpus().length };
    },
  };
}
