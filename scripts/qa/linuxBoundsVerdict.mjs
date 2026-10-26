// Says, case by case, whether a batch's exports finished and were verified, from the files the harness recorded under reports/qa/exporter:
//   node linuxBoundsVerdict.mjs <reports dir> <case> [<case> ...] [--must-pass]
// A case is judged by its NEWEST attempt (the folder names carry the start time), so a re-run replaces what it re-ran.
//   EXPORTED   the run finished and BOTH exports of the line (cold and repeat) were delivered, published and verified
//   FAILED     a result was recorded, but not that
//   NO RESULT  nothing at all was recorded for the case: the batch never reached it, or the harness died before it wrote anything
// This is not the promise verdict (qaSummary.mjs prints that: memory class, speed limit, temporary space, estimate); it answers the question the
// numbers rest on, whether the export worked. Exit 1 when any case has NO RESULT, or, with --must-pass, when any case is not EXPORTED.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const load = async (file) => {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
};
const GIB = 1024 ** 3;
const seconds = (ms) => (Number.isFinite(ms) ? `${Math.round(ms / 1000)}s` : "-");

export function judge(result, report) {
  const cold = result.coldPass;
  const exported = report?.ok === true && result.state === "done" && cold?.state === "done" && result.artifactVerified === true &&
    result.publicationVerified === true && cold?.publicationVerified === true;
  const peaks = [result.localCalibration?.memoryBytes, cold?.localCalibration?.memoryBytes].filter(Number.isFinite);
  return { verdict: exported ? "EXPORTED" : "FAILED", cold: seconds(cold?.elapsedMs), repeat: seconds(result.elapsedMs), engine: result.selection?.backend ?? "-",
    peak: peaks.length ? `${(Math.max(...peaks) / GIB).toFixed(2)} GiB` : "-",
    error: String(result.error ?? report?.error ?? "").replace(/\s+/g, " ").slice(0, 200) };
}

export async function verdicts(directory, cases) {
  const newest = new Map();
  const folders = (await readdir(directory, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const folder of folders) {
    const result = await load(path.join(directory, folder, "promise-library.json"));
    if (result?.caseId) newest.set(result.caseId, { folder, result, report: await load(path.join(directory, folder, "report.json")) });
  }
  return cases.map((id) => {
    const found = newest.get(id);
    return found ? { id, folder: found.folder, ...judge(found.result, found.report) } : { id, verdict: "NO RESULT" };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mustPass = args.includes("--must-pass");
  const [directory, ...cases] = args.filter((arg) => arg !== "--must-pass");
  if (!directory || !cases.length) {
    console.error("usage: node linuxBoundsVerdict.mjs <reports dir> <case> [<case> ...] [--must-pass]");
    process.exit(2);
  }
  const rows = await verdicts(directory, cases);
  for (const row of rows) {
    console.log(`${row.id.padEnd(16)} ${row.verdict.padEnd(10)}${row.cold === undefined ? "" : ` cold ${row.cold}, repeat ${row.repeat}; engine ${row.engine}; worker peak ${row.peak}`}${row.error ? `; ${row.error}` : ""}`);
  }
  const missing = rows.filter((row) => row.verdict === "NO RESULT");
  const notExported = rows.filter((row) => row.verdict !== "EXPORTED");
  if (missing.length) console.error(`No result was recorded for: ${missing.map((row) => row.id).join(", ")}`);
  if (mustPass && notExported.length) console.error(`Not exported and verified: ${notExported.map((row) => row.id).join(", ")}`);
  process.exit(missing.length || (mustPass && notExported.length) ? 1 : 0);
}
