import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mergeCases } from "./linuxBoundsCases.mjs";
import { judge, verdicts } from "./linuxBoundsVerdict.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, "../..");
const GIB = 1024 ** 3;
const read = async (...parts) => JSON.parse(await readFile(path.join(here, ...parts), "utf8"));
const library = await read("exporterPromiseCases.json");
const scratch = await read("linuxBoundsCases.json");
const run = (script, args, env = {}) => spawnSync(process.execPath, [path.join(here, script), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("the scratch cases join the library without changing anything that was already in it", () => {
  const merged = mergeCases(library, scratch);
  assert.deepEqual(merged.added, scratch.map((entry) => entry.id), "every scratch case is new to the library");
  assert.deepEqual(merged.library.cases.slice(0, library.cases.length), library.cases, "the existing cases, in their order, untouched");
  assert.deepEqual({ ...merged.library, cases: null }, { ...library, cases: null }, "nothing outside the case list moved");
  assert.equal(new Set(merged.library.cases.map((entry) => entry.id)).size, merged.library.cases.length, "no name is used twice");
});

test("a scratch case is shaped like the library's own generated cases, so the harness reads it the same way", () => {
  const reference = library.cases.find((entry) => entry.kind === "promise" && entry.source === "generated");
  for (const entry of scratch) {
    assert.deepEqual(Object.keys(entry).sort(), Object.keys(reference).sort(), entry.id);
    for (const key of ["width", "height", "fps", "durationSeconds", "visualClips", "videoLayers", "speedFactor16gb"])
      assert.ok(Number.isInteger(entry[key]) && entry[key] > 0, `${entry.id}.${key}`);
    assert.equal(entry.kind, "promise");
    assert.equal(entry.source, "generated");
    assert.equal(typeof entry.captions, "boolean");
    assert.ok(library.profiles && entry.line.length > 0);
  }
  // The shortened 4K cases differ from their full-length twins in nothing but name and length.
  for (const short of scratch.filter((entry) => entry.id.endsWith("-ci"))) {
    const full = scratch.find((entry) => entry.id === short.id.replace(/-ci$/, ""));
    assert.ok(full, `${short.id} has a full-length twin`);
    assert.deepEqual({ ...short, id: 0, line: 0, durationSeconds: 0 }, { ...full, id: 0, line: 0, durationSeconds: 0 });
    assert.ok(short.durationSeconds < full.durationSeconds);
  }
});

test("merging twice changes nothing, a different definition under a known name is refused, and so is a wrong field list", () => {
  const once = mergeCases(library, scratch);
  const twice = mergeCases(once.library, scratch);
  assert.deepEqual(twice.added, []);
  assert.deepEqual(twice.library, once.library);
  assert.throws(() => mergeCases(once.library, [{ ...scratch[0], width: scratch[0].width + 2 }]), /already defined/);
  assert.throws(() => mergeCases(library, [{ ...scratch[0], extra: 1 }]), /fields differ/);
  const { speedFactor16gb: _omitted, ...fewer } = scratch[0];
  assert.throws(() => mergeCases(library, [fewer]), /fields differ/);
  assert.throws(() => mergeCases(library, [{ ...scratch[0], source: "screen-recording" }]), /generate its own source/);
  assert.throws(() => mergeCases({ cases: [] }, scratch), /no generated promise case/);
});

test("the command line merges into the file it is given, and refuses a case that does not exist", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "artdaddy-linux-cases-"));
  try {
    const file = path.join(dir, "exporterPromiseCases.json");
    await writeFile(file, JSON.stringify(library), "utf8");
    const first = run("linuxBoundsCases.mjs", [file], { CASES: "hd60 seq1080-n24 seq4k-ci" });
    assert.equal(first.status, 0, first.stderr);
    const after = JSON.parse(await readFile(file, "utf8"));
    for (const entry of scratch) assert.deepEqual(after.cases.find((candidate) => candidate.id === entry.id), entry);
    const second = run("linuxBoundsCases.mjs", [file], { CASES: "hd60" });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already in the library/);
    const typo = run("linuxBoundsCases.mjs", [file], { CASES: "hd60 seq4k-cl" });
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /Unknown cases: seq4k-cl/);
    assert.equal(run("linuxBoundsCases.mjs", []).status, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const exportedResult = (id, overrides = {}) => ({ caseId: id, state: "done", artifactVerified: true, publicationVerified: true, elapsedMs: 118000,
  selection: { backend: "partition-pipes-v1" }, localCalibration: { memoryBytes: Math.round(2.05 * GIB) },
  coldPass: { state: "done", publicationVerified: true, elapsedMs: 121000, localCalibration: { memoryBytes: Math.round(2.01 * GIB) } }, ...overrides });
const failedResult = (id, error) => ({ caseId: id, status: "failed", sourceReady: true, artifactVerified: false, passed: false, elapsedMs: 31000, error });

async function reports(folders) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "artdaddy-linux-verdict-"));
  for (const [name, { result, report }] of Object.entries(folders)) {
    await mkdir(path.join(dir, name));
    if (result) await writeFile(path.join(dir, name, "promise-library.json"), JSON.stringify(result), "utf8");
    if (report) await writeFile(path.join(dir, name, "report.json"), JSON.stringify(report), "utf8");
  }
  return dir;
}

test("an export counts only when the run finished and BOTH of its exports were published and verified", () => {
  assert.equal(judge(exportedResult("a"), { ok: true }).verdict, "EXPORTED");
  assert.equal(judge(exportedResult("a"), { ok: true }).peak, "2.05 GiB", "the larger of the two passes' worker peaks");
  const broken = [
    [exportedResult("a"), { ok: false, error: "x" }],
    [exportedResult("a"), null],
    [exportedResult("a", { state: "failed" }), { ok: true }],
    [exportedResult("a", { artifactVerified: false }), { ok: true }],
    [exportedResult("a", { publicationVerified: false }), { ok: true }],
    [exportedResult("a", { coldPass: { ...exportedResult("a").coldPass, publicationVerified: false } }), { ok: true }],
    [exportedResult("a", { coldPass: { ...exportedResult("a").coldPass, state: "failed" } }), { ok: true }],
    [exportedResult("a", { coldPass: undefined }), { ok: true }],
    [failedResult("a", "boom"), { ok: false, error: "boom" }],
  ];
  for (const [result, report] of broken) assert.equal(judge(result, report).verdict, "FAILED", JSON.stringify([result, report]).slice(0, 120));
});

test("each case is judged by its newest attempt, and a case with no record is NO RESULT", async () => {
  const dir = await reports({
    "x86_64-unknown-linux-gnu-100": { result: failedResult("retried", "Failed to fetch dynamically imported module"), report: { ok: false, error: "Failed to fetch" } },
    "x86_64-unknown-linux-gnu-200": { result: exportedResult("retried"), report: { ok: true } },
    "x86_64-unknown-linux-gnu-300": { result: exportedResult("regressed"), report: { ok: true } },
    "x86_64-unknown-linux-gnu-400": { result: failedResult("regressed", "resident memory budget exceeded"), report: { ok: false, error: "resident memory budget exceeded" } },
    "x86_64-unknown-linux-gnu-500": { result: null, report: { ok: false, error: "died before writing a result" } },
  });
  try {
    const rows = await verdicts(dir, ["retried", "regressed", "never-run"]);
    assert.deepEqual(rows.map((row) => [row.id, row.verdict]), [["retried", "EXPORTED"], ["regressed", "FAILED"], ["never-run", "NO RESULT"]]);
    assert.match(rows[1].error, /resident memory budget exceeded/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the command line's exit code says whether the batch can be trusted", async () => {
  const good = await reports({ a: { result: exportedResult("one"), report: { ok: true } }, b: { result: exportedResult("two"), report: { ok: true } } });
  const mixed = await reports({ a: { result: exportedResult("one"), report: { ok: true } }, b: { result: failedResult("two", "oom"), report: { ok: false, error: "oom" } } });
  try {
    assert.equal(run("linuxBoundsVerdict.mjs", [good, "one", "two", "--must-pass"]).status, 0);
    assert.equal(run("linuxBoundsVerdict.mjs", [mixed, "one", "two"]).status, 0, "a comparison leg only has to leave a result");
    const strict = run("linuxBoundsVerdict.mjs", [mixed, "one", "two", "--must-pass"]);
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /Not exported and verified: two/);
    const missing = run("linuxBoundsVerdict.mjs", [good, "one", "three"]);
    assert.equal(missing.status, 1, "a case nothing was recorded for fails even without --must-pass");
    assert.match(missing.stderr, /No result was recorded for: three/);
    assert.equal(run("linuxBoundsVerdict.mjs", [good]).status, 2);
    assert.equal(run("linuxBoundsVerdict.mjs", [path.join(good, "nowhere"), "one"]).status, 1, "an empty reports folder is NO RESULT, not an empty success");
  } finally {
    await rm(good, { recursive: true, force: true });
    await rm(mixed, { recursive: true, force: true });
  }
});

test("the workflow names real cases, pinned commits and scripts that exist", async () => {
  const yaml = (await import("js-yaml")).default;
  const text = await readFile(path.join(repository, ".github/workflows/exporter-linux-bounds-qa.yml"), "utf8");
  const workflow = yaml.load(text);
  const legs = workflow.jobs.bounds.strategy.matrix.include;
  const known = new Set([...library.cases, ...scratch].map((entry) => entry.id));
  assert.ok(legs.length >= 2);
  assert.equal(new Set(legs.map((leg) => leg.code)).size, legs.length, "each leg tests a different commit");
  assert.ok(legs.some((leg) => leg.must_pass === true), "at least one leg can fail the job");
  for (const leg of legs) {
    assert.match(leg.code, /^[0-9a-f]{40}$/, `${leg.leg}: a pinned commit is a full hash, not a name that can move`);
    assert.equal(typeof leg.must_pass, "boolean");
    const cases = leg.cases.split(/\s+/);
    assert.equal(new Set(cases).size, cases.length, `${leg.leg}: no case twice`);
    for (const id of cases) assert.ok(known.has(id), `${leg.leg}: ${id} is defined nowhere`);
  }
  assert.ok(workflow.jobs.instrument, "the instrument's own tests run in the workflow");
  assert.equal(workflow.jobs.bounds.needs, undefined, "the legs do not wait for the instrument's tests: a failure there is a separate, visible signal, and hours of evidence are not held up by it");
  const on = workflow.on ?? workflow[true];
  assert.deepEqual(on.push.branches, ["qa/linux-bounds-*"]);
  for (const [, name] of text.matchAll(/scripts\/qa\/([A-Za-z0-9_.-]+\.m?js)\b/g)) assert.ok(existsSync(path.join(here, name)), `${name} is run by the workflow but is not in scripts/qa`);
  for (const [, name] of text.matchAll(/node --test (?:\S+\s+)*?scripts\/qa\/(\S+\.test\.mjs)/g)) assert.ok(existsSync(path.join(here, name)), name);
});
