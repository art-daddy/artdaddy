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
import { describePictureFailures, judgeSourcePictures } from "./exporterQualification.mjs";

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

async function checkPictureControls(plain, rotated, leadIn) {
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
  const decodeAt = (source, phone, at, wrongControl) => {
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
  // Runs the harness's own extracted picture check, with the shared verdict module it imports.
  const runBlock = (source, sourceClass, values) => JSON.parse(JSON.stringify(runInNewContext(
    `let sourcePictureProof, orientationProof; ${layerCheck} ${block}; sourcePictureProof`, {
      assert, Buffer, spawnSync, createHash, executable: () => ffmpeg, judgeSourcePictures, describePictureFailures,
      promiseFixture: { realWorld: true, paths: [source] },
      promiseCase: { source: sourceClass, videoLayers: 1, visualClips: 1, durationSeconds: 10 },
      native: { imageHeight: 0.8, columns: 1, rows: 1 }, samples: values, sampleSize: 160 * 90 * 3,
    }, { timeout: 10000 })));
  for (const [sourceClass, requirements] of Object.entries(library.sourceClasses)) {
    if (!requirements.realWorld) continue;
    const phone = sourceClass === "phone-vfr-rotation";
    const source = phone ? rotated : plain;
    const decode = (at, wrongControl) => decodeAt(source, phone, at, wrongControl);
    const samples = [0.15, 0.75, 2].map((at) => decode(at, false));
    const check = (values) => runBlock(source, sourceClass, values);
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
  // A source whose first sampled frame is black can only prove the output is black there. The earlier blank-frame
  // comparison (0 < 0) refused every export of such a clip; it must now be accepted, and a wrong picture must not.
  const dark = [0.15, 0.75, 2].map((at) => decodeAt(leadIn, false, at, false));
  const faithful = runBlock(leadIn, "web-download", dark);
  assert.ok(faithful[0].blankError < 1, "the lead-in fixture must really begin with a black frame");
  assert.ok(faithful.every((entry) => entry.sourceError === 0));
  const wrongOverBlack = dark.map((sample) => Buffer.from(sample));
  wrongOverBlack[0].fill(200, 0, 160 * 72 * 3);
  assert.throws(() => runBlock(leadIn, "web-download", wrongOverBlack), /near-black reference/);
  const lostBehindBlack = dark.map((sample) => Buffer.from(sample));
  lostBehindBlack[1].fill(0, 0, 160 * 72 * 3);
  assert.throws(() => runBlock(leadIn, "web-download", lostBehindBlack), /picture is missing/);
}

test("original-audio checks accept preserved sound and reject missing or wrong channels", async () => {
  const text = await readFile(driver, "utf8");
  const syntax = typescript.createSourceFile(driver, text, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
  const declaration = syntax.statements.find((node) => typescript.isFunctionDeclaration(node) && node.name?.text === "compareOriginalAudio");
  assert.ok(declaration);
  const compare = runInNewContext(`${declaration.getText(syntax)}; compareOriginalAudio`, { assert, Buffer });
  const frames = 48000;
  const original = Buffer.alloc(frames * 16);
  const swapped = Buffer.alloc(original.length);
  const inverted = Buffer.alloc(original.length);
  const mono = Buffer.alloc(original.length);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 2; channel++) {
    const value = 0.1 * Math.sin(2 * Math.PI * (channel ? 883 : 431) * frame / 48000);
    original.writeDoubleLE(value, frame * 16 + channel * 8);
    swapped.writeDoubleLE(value, frame * 16 + (1 - channel) * 8);
    inverted.writeDoubleLE(-value, frame * 16 + channel * 8);
    mono.writeDoubleLE(0.1 * Math.sin(2 * Math.PI * 431 * frame / 48000), frame * 16 + channel * 8);
  }
  assert.equal(compare(original, Buffer.from(original)).comparedFrames, frames);
  assert.equal(compare(mono, Buffer.from(mono)).comparedFrames, frames);
  assert.equal(compare(Buffer.alloc(original.length), Buffer.alloc(original.length)).comparedFrames, frames);
  const dropout = Buffer.from(original);
  dropout.fill(0, Math.round(frames * 0.45) * 16, Math.round(frames * 0.47) * 16);
  const frozen = Buffer.alloc(original.length);
  const slice = original.subarray(0, 480 * 16);
  for (let offset = 0; offset < frozen.length; offset += slice.length) slice.copy(frozen, offset);
  assert.throws(() => compare(original, Buffer.alloc(original.length)), /Original audio channel/);
  assert.throws(() => compare(original, swapped), /Original audio channel/);
  assert.throws(() => compare(original, inverted), /Original audio channel/);
  assert.throws(() => compare(original, dropout), /Original audio channel/);
  assert.throws(() => compare(original, frozen), /Original audio channel/);
  assert.throws(() => compare(original, original.subarray(16)), /comparison spans differ/);
  assert.throws(() => compare(Buffer.alloc(original.length), original), /Silent original audio/);
});

test("original-audio reference retains a source timestamp gap", { skip: !ffmpeg }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artdaddy-source-audio-clock-"));
  try {
    const source = path.join(root, "delayed-source.nut");
    const generated = spawnSync(ffmpeg, ["-n", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=s=16x16:r=30:d=2",
      "-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*431*t)|0.1*sin(2*PI*883*t):s=48000:d=2",
      "-af", "asetpts=PTS+0.044/TB", "-c:v", "ffv1", "-c:a", "pcm_f64le", "-f", "nut", source], { encoding: "utf8", timeout: 10000 });
    assert.equal(generated.status, 0, generated.error?.message ?? generated.stderr);
    const text = await readFile(driver, "utf8");
    const syntax = typescript.createSourceFile(driver, text, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
    const declaration = syntax.statements.find((node) => typescript.isFunctionDeclaration(node) && node.name?.text === "compareOriginalAudio");
    let decoder;
    function visit(node) {
      if (typescript.isVariableDeclaration(node) && node.name.getText(syntax) === "decodeAudio") decoder = node;
      typescript.forEachChild(node, visit);
    }
    visit(syntax);
    assert.ok(declaration && decoder);
    const checker = runInNewContext(`${declaration.getText(syntax)}; const ${decoder.getText(syntax)}; ({compareOriginalAudio, decodeAudio})`,
      { assert, Buffer, spawnSync, executable: () => ffmpeg, promiseCase: { durationSeconds: 1 } });
    const reference = checker.decodeAudio(source);
    const expected = Buffer.alloc(48000 * 16);
    const delayFrames = 2112;
    for (let frame = 0; frame < 48000; frame++) for (let channel = 0; channel < 2; channel++) {
      if (frame < delayFrames) assert.equal(reference.readDoubleLE(frame * 16 + channel * 8), 0);
      else expected.writeDoubleLE(0.1 * Math.sin(2 * Math.PI * (channel ? 883 : 431) * (frame - delayFrames) / 48000), frame * 16 + channel * 8);
    }
    const proof = checker.compareOriginalAudio(expected, reference);
    assert.ok(proof.channels.every((entry) => entry.correlation > 0.999999 && entry.relativeError < 1e-10));
    const advanced = Buffer.alloc(reference.length);
    reference.copy(advanced, 0, delayFrames * 16);
    assert.throws(() => checker.compareOriginalAudio(expected, advanced), /Original audio channel/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
    const leadIn = path.join(root, "black-lead-in.mp4");
    const darkStart = spawnSync(ffmpeg, ["-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=128x72:r=30:d=0.5",
      "-f", "lavfi", "-i", "testsrc2=s=128x72:r=30:d=12", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", leadIn], { encoding: "utf8" });
    assert.equal(darkStart.status, 0, darkStart.stderr);
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
    await prepare(root, await mapping(rotated), /requires an actual source audio stream/, "phone-original-audio");
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
    await checkPictureControls(plain, rotated, leadIn);
  } finally { await rm(root, { recursive: true, force: true }); }
});
