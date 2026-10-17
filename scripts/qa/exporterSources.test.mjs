import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const driver = path.join(repository, "scripts/qa/exporterNative.mjs");
const targets = { "win32-x64": "x86_64-pc-windows-msvc.exe", "darwin-arm64": "aarch64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu" };
const target = targets[`${process.platform}-${process.arch}`];
const ffmpeg = target ? path.join(repository, "src-tauri/binaries", `artdaddy-ffmpeg-${target}`) : null;

async function prepare(root, source, expectedFailure) {
  const manifest = path.join(root, "source-map.json");
  await writeFile(manifest, JSON.stringify({ version: 1, sources: { "phone-vfr-rotation": source } }));
  const result = spawnSync(process.execPath, [driver, "--prepare-only"], { cwd: repository,
    env: { ...process.env, ARTDADDY_QA_PROMISE_CASE: "phone-vfr-rotation", ARTDADDY_QA_PROMISE_PROFILE: "16gb",
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

test("private-source failures remain blocked before native launch", { skip: !ffmpeg }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artdaddy-source-controls-"));
  try {
    const plain = path.join(root, "constant-rate.mp4");
    const short = path.join(root, "short.mp4");
    const rotated = path.join(root, "rotated-constant-rate.mp4");
    for (const [file, duration] of [[plain, 12], [short, 1]]) {
      const generated = spawnSync(ffmpeg, ["-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
        `testsrc2=s=128x72:r=30:d=${duration}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file], { encoding: "utf8" });
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
    await prepare(root, { ...(await mapping(rotated)), permission: "" }, /requires permission/);
  } finally { await rm(root, { recursive: true, force: true }); }
});