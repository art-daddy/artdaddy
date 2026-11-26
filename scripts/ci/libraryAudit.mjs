// The library audit in CI: every npm advisory is reported, and the run fails only when the change added or moved
// a library that has a HIGH or CRITICAL advisory of its own. An advisory published for a library nobody touched is
// reported and never turns a run red by itself.
//
//   node scripts/ci/libraryAudit.mjs --audit all.json --lock package-lock.json [--shipped-audit shipped.json]
//     [--base-lock base-lock.json] [--canary-audit canary.json --canary-package lodash]
//
// --audit is `npm audit --json` (every library), --shipped-audit the same with --omit=dev (what ships; for the
// report), --base-lock the change base's package-lock.json, given only when the change touched package.json or
// package-lock.json (without it nothing changed). The canary is an audit of a library version known to carry a high
// advisory: it must come back high, or a clean audit proves nothing.
// Exit 0: nothing blocks. Exit 1: a high advisory on a library the change added or moved. Exit 2: the audit cannot
// be trusted (no report, or the canary not flagged high).
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BLOCKING = new Set(["high", "critical"]);

/** package-lock (v2/v3) as library name -> the versions it is installed at. */
export function lockVersions(lock) {
  const versions = new Map();
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    const at = path.lastIndexOf("node_modules/");
    if (at < 0 || typeof entry?.version !== "string") continue;
    const name = path.slice(at + "node_modules/".length);
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(entry.version);
  }
  return versions;
}

/** Libraries the change added or moved to a version the base did not have. Without a base, nothing changed. */
export function changedLibraries(lock, baseLock) {
  if (!baseLock) return new Set();
  const before = lockVersions(baseLock);
  const changed = new Set();
  for (const [name, versions] of lockVersions(lock)) {
    const had = before.get(name);
    if (!had || [...versions].some((version) => !had.has(version))) changed.add(name);
  }
  return changed;
}

/** The advisories in an `npm audit --json` report, one per (library, advisory). Throws when it is not a report. */
export function advisories(audit) {
  if (!audit?.metadata?.vulnerabilities) {
    throw new Error(`npm audit produced no report: ${JSON.stringify(audit?.error ?? audit).slice(0, 300)}`);
  }
  const found = new Map();
  for (const entry of Object.values(audit.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== "object" || !via) continue; // a string names the library it is vulnerable through
      const key = `${via.name} ${via.url ?? via.source}`;
      if (!found.has(key)) {
        found.set(key, { key, name: via.name, severity: via.severity, title: via.title, url: via.url, range: via.range });
      }
    }
  }
  return [...found.values()];
}

export function judge({ audit, lock, baseLock, shipped, canary, canaryPackage }) {
  if (canary !== undefined) {
    const flagged = advisories(canary).filter((a) => a.name === canaryPackage && BLOCKING.has(a.severity));
    if (!flagged.length) {
      return { code: 2, problems: [`the audit did not report ${canaryPackage}, known to be vulnerable, as high`] };
    }
  }
  const changed = changedLibraries(lock, baseLock);
  const shippedKeys = shipped === undefined ? undefined : new Set(advisories(shipped).map((a) => a.key));
  const rows = advisories(audit).map((a) => ({
    ...a,
    changed: changed.has(a.name),
    shipped: shippedKeys === undefined ? undefined : shippedKeys.has(a.key),
  }));
  const problems = rows
    .filter((row) => row.changed && BLOCKING.has(row.severity))
    .map((row) => `${row.name}, which this change adds or moves, has a ${row.severity} advisory: ${row.title} (${row.url})`);
  return { code: problems.length ? 1 : 0, problems, rows, changed };
}

function options(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error(`bad argument: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

/** The whole run, with file reading and output injected so it can be tested without files. Returns the exit code. */
export function run(argv, { read, print, summary }) {
  let verdict;
  try {
    const args = options(argv);
    const json = (name) => (args[name] === undefined ? undefined : JSON.parse(read(args[name])));
    if (!args.audit || !args.lock) throw new Error("--audit and --lock are required");
    verdict = judge({
      audit: json("audit"),
      lock: json("lock"),
      baseLock: json("base-lock"),
      shipped: json("shipped-audit"),
      canary: json("canary-audit"),
      canaryPackage: args["canary-package"] ?? "lodash",
    });
  } catch (error) {
    print(`::error title=Library audit::the audit cannot be read, so nothing was checked: ${error.message}`);
    return 2;
  }
  for (const problem of verdict.problems) print(`::error title=Library audit::${problem}`);
  if (verdict.code === 2) return 2;
  const count = (severity) => verdict.rows.filter((row) => row.severity === severity).length;
  const lines = [
    "### Library audit (npm audit)",
    "",
    `${verdict.changed.size} libraries changed here${verdict.changed.size ? ` (${[...verdict.changed].sort().join(", ")})` : ""}. ` +
      `${verdict.rows.length} advisories: critical ${count("critical")}, high ${count("high")}, moderate ${count("moderate")}, ` +
      `low ${count("low")}. ${verdict.problems.length} block (high or critical, in a library this change added or moved).`,
  ];
  if (verdict.rows.length) {
    lines.push("", "| Library | Severity | Advisory | Shipped | Changed here |", "| --- | --- | --- | --- | --- |");
    const order = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
    for (const row of [...verdict.rows].sort((a, b) => (order[a.severity] ?? 5) - (order[b.severity] ?? 5))) {
      const shipped = row.shipped === undefined ? "?" : row.shipped ? "yes" : "no (dev)";
      lines.push(`| ${row.name} | ${row.severity} | [${row.title}](${row.url}) | ${shipped} | ${row.changed ? "yes" : "no"} |`);
    }
  }
  print(lines.join("\n"));
  summary(lines.join("\n") + "\n");
  return verdict.code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2), {
    read: (path) => readFileSync(path, "utf8"),
    print: (line) => console.log(line),
    summary: (text) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, text),
  });
}
