import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import typescript from "typescript";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const driver = path.join(repository, "scripts/qa/exporterNative.mjs");
const library = JSON.parse(await readFile(path.join(repository, "scripts/qa/exporterPromiseCases.json"), "utf8"));
const targets = { "win32-x64": "x86_64-pc-windows-msvc.exe", "darwin-arm64": "aarch64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu" };
const target = targets[`${process.platform}-${process.arch}`];
const ffmpeg = target ? path.join(repository, "src-tauri/binaries", `artdaddy-ffmpeg-${target}`) : null;

async function prepare(root, source, expectedFailure, caseId = "phone-vfr-rotation") {
  const manifest = path.join(root, "source-map.json");
  const definition = library.cases.find((entry) => entry.id === caseId);
  assert.ok(definition);
  await writeFile(manifest, JSON.stringify({ version: 1, sources: { [definition.source]: source } }));
  const result = spawnSync(process.execPath, [driver, "--prepare-only"], { cwd: repository,
    env: { ...process.env, ARTDADDY_QA_PROMISE_CASE: caseId, ARTDADDY_QA_PROMISE_PROFILE: "16gb",
      ARTDADDY_QA_SOURCE_MANIFEST: manifest, ARTDADDY_QA_FAST_QUALITY_SOURCE: "", ARTDADDY_QA_FAST_ENCODER_PROBE: "" },
    encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const reported = `${result.stdout}\n${result.stderr}`.match(/SOURCE PREPARATION (\{[^\n]+\})/);
  assert(reported, result.stderr);
  const outcome = JSON.parse(reported[1]);
  try {
    assert.match(result.stderr, expectedFailure);
    const record = JSON.parse(await readFile(path.join(outcome.output, "promise-library.json"), "utf8"));
    assert.equal(record.passed, false);
    assert.equal(record.artifactVerified, false);
    assert.equal(record.sourceReady, false);
    assert.equal(record.status, "blocked-source");
    assert.equal(await stat(path.join(outcome.root, "native-armed.json")).then(() => true, () => false), false);
    assert.equal(result.status === 0, false);
  } finally { await rm(outcome.root, { recursive: true, force: true }); }
}

async function checkPictureControls(plain, rotated) {
  const text = await readFile(driver, "utf8");
  const syntax = typescript.createSourceFile(driver, text, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
  let block;
  let layerCheck;
  function visit(node) {
    if (typescript.isIfStatement(node) && node.expression.getText(syntax) === "promiseFixture.realWorld")
      block = node.thenStatement.getText(syntax);
    if (typescript.isVariableStatement(node) && node.getText(syntax).includes("promiseCase.videoLayers") &&
      node.declarationList.declarations.some((entry) => entry.name.getText(syntax) === "tiles"))
      layerCheck = node.getText(syntax);
    typescript.forEachChild(node, visit);
  }
  visit(syntax);
  assert.ok(block, "Native real-source picture check is missing");
  assert.ok(layerCheck, "Native layer picture check is missing");
  for (const [sourceClass, requirements] of Object.entries(library.sourceClasses)) {
    if (!requirements.realWorld) continue;
    const phone = sourceClass === "phone-vfr-rotation";
    const source = phone ? rotated : plain;
    const decode = (at, wrongControl) => {
      const result = spawnSync(ffmpeg, ["-nostdin", "-v", "error", ...(wrongControl && phone ? ["-noautorotate"] : []),
        "-ss", String(at), "-i", source, "-frames:v", "1", "-vf", `scale=160:72${wrongControl && !phone ? ",vflip" : ""}`,
        "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 0, String(result.stderr));
      assert.equal(result.stdout.length, 160 * 72 * 3);
      const sample = Buffer.alloc(160 * 90 * 3);
      result.stdout.copy(sample);
      sample.fill(Math.round(at * 50), 160 * 72 * 3);
      return sample;
    };
    const samples = [0.15, 0.75, 2].map((at) => decode(at, false));
    const check = (values) => JSON.parse(JSON.stringify(runInNewContext(
      `let sourcePictureProof, orientationProof; ${layerCheck} ${block}; sourcePictureProof`, {
        assert, Buffer, spawnSync, createHash, executable: () => ffmpeg,
        promiseFixture: { realWorld: true, paths: [source] },
        promiseCase: { source: sourceClass, videoLayers: 1, visualClips: 1, durationSeconds: 10 },
        native: { imageHeight: 0.8, columns: 1, rows: 1 }, samples: values, sampleSize: 160 * 90 * 3,
      }, { timeout: 10000 })));
    assert.ok(check(samples).every((entry) => entry.sourceError === 0));
    const missing = samples.map((sample) => Buffer.from(sample));
    missing[0].fill(0, 0, 160 * 72 * 3);
    assert.throws(() => check(missing), /picture is missing/);
    const frozen = samples.map((sample) => {
      const copy = Buffer.from(sample);
      samples[0].copy(copy, 0, 0, 160 * 72 * 3);
      return copy;
    });
    assert.throws(() => check(frozen), /picture is frozen/);
    assert.throws(() => check([0.15, 0.75, 2].map((at) => decode(at, true))), /picture is missing|does not follow/);
  }
}

test("private-source failures remain blocked before native launch", { skip: !ffmpeg }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artdaddy-source-controls-"));
  try {
    const plain = path.join(root, "constant-rate.mp4");
    const short = path.join(root, "short.mp4");
    const rotated = path.join(root, "rotated-constant-rate.mp4");
    for (const [file, duration] of [[plain, 12], [short, 1]]) {
      const generated = spawnSync(ffmpeg, ["-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
        `testsrc2=s=128x72:r=30:d=${duration}`, "-vf", "drawbox=x=32:y=18:w=64:h=36:color=black:t=fill",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file], { encoding: "utf8" });
      assert.equal(generated.status, 0, generated.stderr);
    }
    const remuxed = spawnSync(ffmpeg, ["-y", "-nostdin", "-v", "error", "-display_rotation", "90", "-i", plain,
      "-c", "copy", rotated], { encoding: "utf8" });
    assert.equal(remuxed.status, 0, remuxed.stderr);
    const probe = spawnSync(path.join(repository, "src-tauri/binaries", `artdaddy-ffprobe-${target}`),
      ["-v", "error", "-show_streams", "-of", "json", rotated], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    assert.ok((JSON.parse(probe.stdout).streams[0].side_data_list ?? []).some((entry) =>
      Number.isFinite(Number(entry.rotation)) && Number(entry.rotation) % 360 !== 0));
    const mapping = async (file) => ({ path: file, sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
      provenance: "Generated deterministic negative control; never a real phone source.", permission: "Local fixture test only." });
    await prepare(root, { ...(await mapping(plain)), path: path.join(root, "missing.mp4") }, /required real-world source is unavailable/);
    await prepare(root, { ...(await mapping(plain)), sha256: "0".repeat(64) }, /bytes do not match its expected SHA256/);
    await prepare(root, await mapping(short), /beyond its actual end/);
    await prepare(root, await mapping(plain), /requires actual rotation metadata/);
    await prepare(root, await mapping(rotated), /requires measured variable presentation intervals/);
    for (const [sourceClass, requirements] of Object.entries(library.sourceClasses)) {
      if (!requirements.realWorld) continue;
      const definition = library.cases.find((entry) => entry.source === sourceClass);
      assert.ok(definition, `Real source class ${sourceClass} has no library case`);
      for (const field of ["provenance", "permission"]) {
        await prepare(root, { ...(await mapping(plain)), origin: "https://example.invalid/control.mp4", [field]: "" },
          new RegExp(`requires ${field}`), definition.id);
      }
    }
    await prepare(root, { ...(await mapping(plain)), origin: "http://example.invalid/control.mp4" },
      /requires its recorded HTTPS origin/, "web-download");
    await checkPictureControls(plain, rotated);
  } finally { await rm(root, { recursive: true, force: true }); }
});