import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, realpath, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, normalizePath } from "vite";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const targets = { "win32-x64": "x86_64-pc-windows-msvc", "darwin-arm64": "aarch64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu" };
const target = targets[`${process.platform}-${process.arch}`];
assert.ok(target, "Use a supported native Windows x64, macOS arm64 or Linux x64 machine");
const userData = process.platform === "win32" ? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming") :
  process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
const present = async (filename) => {
  try { return await stat(filename); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
};
assert.ok(await present(path.join(userData, "ArtDaddy")) || !(await present(path.join(userData, "Akaru")))?.isDirectory(),
  "QA refused: native startup could migrate an existing legacy data folder; do not alter customer folders for this test");
const executable = (program) => path.join(repository, "src-tauri", "binaries", `${program}-${target}${process.platform === "win32" ? ".exe" : ""}`);
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "artdaddy-export-native-")));
const identifier = `com.artdaddy.qa.exporter-${Date.now()}`;
const output = path.join(repository, "reports", "qa", "exporter", `${target}-${Date.now()}`);
await mkdir(output, { recursive: true });
const source = path.join(root, "source.nut");
const generated = spawnSync(executable("artdaddy-ffmpeg"), ["-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
  "testsrc2=s=320x180:r=30:d=1", "-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*440*t)|0.08*sin(2*PI*880*t):s=48000:d=1",
  "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-c:a", "pcm_f64le", "-f", "nut", source], { encoding: "utf8" });
assert.equal(generated.status, 0, generated.error?.message ?? generated.stderr);

const profileSeconds = Number(process.env.ARTDADDY_QA_DENSE_PROFILE_SECONDS ?? 0);
assert.ok(profileSeconds === 0 || [6, 15, 30, 60].includes(profileSeconds), "Dense profile must explicitly select6,15,30or60seconds");
const denseSourceRoot = process.env.ARTDADDY_QA_DENSE_SOURCE_ROOT ?? root;
let denseFixture;
if (profileSeconds) {
  const started = performance.now();
  const sourcePixels = new Set();
  for (let index = 0; index < 16; index++) {
    const seed = path.join(denseSourceRoot, `dense-seed-${index}.mp4`);
    const media = path.join(denseSourceRoot, `dense-source-${index}.mp4`);
    if (denseSourceRoot === root) {
    const generated = spawnSync(executable("artdaddy-ffmpeg"), ["-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "testsrc2=s=3840x2160:r=60:d=1", "-vf", `hue=h=${index * 22.5}`, "-c:v", "libx264", "-preset", "medium", "-crf", "23",
      "-g", "60", "-pix_fmt", "yuv420p", seed], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const repeated = spawnSync(executable("artdaddy-ffmpeg"), ["-y", "-nostdin", "-v", "error", "-stream_loop", "29", "-i", seed,
      "-t", "30", "-c", "copy", media], { encoding: "utf8" });
    assert.equal(repeated.status, 0, repeated.stderr);
    }
    const metadata = spawnSync(executable("artdaddy-ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=width,height,r_frame_rate,duration,nb_frames,codec_name", "-of", "json", media], { encoding: "utf8" });
    assert.equal(metadata.status, 0, metadata.stderr);
    const video = JSON.parse(metadata.stdout).streams[0];
    assert.equal(video.width, 3840);
    assert.equal(video.height, 2160);
    assert.equal(video.r_frame_rate, "60/1");
    assert.equal(Number(video.nb_frames), 1800);
    assert.ok(Number(video.duration) >= 30);
    const sample = spawnSync(executable("artdaddy-ffmpeg"), ["-nostdin", "-v", "error", "-i", media, "-frames:v", "1",
      "-vf", "scale=32:18", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1024 * 1024 });
    assert.equal(sample.status, 0, String(sample.stderr));
    sourcePixels.add(createHash("sha256").update(sample.stdout).digest("hex"));
    console.log(`Dense4K60fixture ${index + 1}/16ready`);
  }
  assert.equal(sourcePixels.size, 16, "Dense profile must decode genuinely distinct source pictures");
  denseFixture = { preparationMs: performance.now() - started, reusedSources: denseSourceRoot !== root, distinctDecodedSources: sourcePixels.size,
    sourceSize: [3840, 2160], sourceFps: 60, repeatedSeedSeconds: 1, sourceDurationSeconds: 30 };
}

const previousEnvironment = { ...process.env };
Object.assign(process.env, { ARTDADDY_DATA_DIR: root, ARTDADDY_PROJECTS_DIR: path.join(root, "projects"),
  VITE_API_BASE_URL: "http://127.0.0.1:9", VITE_SENTRY_DSN: "", ARTDADDY_DEV_API_TARGET: "" });
const nativeCore = `/@fs/${normalizePath(path.join(repository, "node_modules", "@tauri-apps", "api", "core.js"))}`;
const virtualCore = "\0exporter-qa-isolated-core";
const vite = await createServer({ root: repository, configFile: path.join(repository, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: true },
  plugins: [{ name: "exporter-qa-isolated-root", enforce: "pre",
    resolveId: (name) => name === "@tauri-apps/api/core" ? virtualCore : undefined,
    load: (name) => name === virtualCore ? `
      export * from ${JSON.stringify(nativeCore)};
      import { invoke as nativeInvoke } from ${JSON.stringify(nativeCore)};
      export function invoke(command, args, options) {
        if (command === "get_env") return Promise.resolve(args.name === "ARTDADDY_DATA_DIR" ? ${JSON.stringify(root)} :
          args.name === "ARTDADDY_PROJECTS_DIR" ? ${JSON.stringify(path.join(root, "projects"))} : null);
        return nativeInvoke(command, args, options);
      }
    ` : undefined }],
  optimizeDeps: { exclude: ["@tauri-apps/api", "@tauri-apps/plugin-fs", "@tauri-apps/plugin-shell"] } });
const children = [];
const logs = [];

function changedFile(filename, accept, child) {
  return new Promise((resolve, reject) => {
    let reading = false;
    let completed = false;
    const watcher = watch(path.dirname(filename), () => void inspect());
    const finish = (error, result) => {
      if (completed) return;
      completed = true;
      watcher.close();
      clearTimeout(timeout);
      child.off("error", failed);
      child.off("exit", exited);
      if (error) reject(error); else resolve(result);
    };
    const inspect = async () => {
      if (reading || completed) return;
      reading = true;
      try {
        if (path.basename(filename) !== "native-report.json") {
          try {
            const failure = JSON.parse(await readFile(path.join(root, "native-report.json"), "utf8"));
            if (failure.ok === false) { finish(new Error(failure.error)); return; }
          } catch (error) {
            if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
          }
        }
        const report = JSON.parse(await readFile(filename, "utf8"));
        if (report.ok === false) finish(new Error(report.error));
        else if (accept(report)) finish(null, report);
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) finish(error);
      } finally { reading = false; }
    };
    const failed = (error) => finish(error);
    const exited = (code, signal) => finish(new Error(`Owned native QA exited before its outcome: code=${code} signal=${signal}; inspect native log`));
    const timeout = setTimeout(() => finish(new Error(`No native outcome: ${filename}`)), 12 * 60_000);
    child.once("error", failed);
    child.once("exit", exited);
    if (child.exitCode !== null || child.signalCode !== null) { exited(child.exitCode, child.signalCode); return; }
    void inspect();
  });
}

function stopOwned(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } else {
    process.kill(-child.pid, "SIGKILL");
  }
}

function start(config, run) {
  const log = createWriteStream(path.join(output, `native-${run}.log`));
  logs.push(log);
  const cargoDirectory = path.join(os.homedir(), ".cargo", "bin");
  const child = spawn(process.execPath, [path.join(repository, "node_modules", "@tauri-apps", "cli", "tauri.js"),
    "dev", "--no-watch", "--config", config], { cwd: repository, detached: process.platform !== "win32",
    env: { ...process.env, PATH: `${cargoDirectory}${path.delimiter}${process.env.PATH ?? ""}` }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  return child;
}

const started = Date.now();
const proof = { version: 1, scope: "native-owner-capture-and-crash-recovery", target, root, identifier,
  memorySimulation: { configuredCommitLimitBytes: Number(process.env.ARTDADDY_QA_MEMORY_CAP_BYTES ?? 0),
    physicalMinimumMachine: false, exactPeakCeiling: false },
  hardware: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(), minimumMachineQualified: false }, paidCalls: 0, customerProjectsTouched: false, steps: [] };
  const fileHash = async (filename) => createHash("sha256").update(await readFile(filename)).digest("hex");
  const sourceFiles = [];
  async function collectSources(directory) {
    for (const entry of await readdir(path.join(repository, directory), { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Source provenance must not follow a symbolic link: ${filename}`);
      if (entry.isDirectory()) await collectSources(filename);
      else if (/\.(?:ts|tsx|rs|json)$/.test(entry.name)) sourceFiles.push(filename);
    }
  }
try {
    await collectSources("src");
    await collectSources("src-tauri/src");
    sourceFiles.push("package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
      "src-tauri/tauri.conf.json", "scripts/qa/exporterNative.mjs", "scripts/qa/exporterNative.ts", "scripts/qa/exporterNative.html",
      "scripts/qa/exporterMemory.ps1");
    proof.sourceFiles = await Promise.all(sourceFiles.sort().map(async (filename) => ({ path: filename.replaceAll(path.sep, "/"), sha256: await fileHash(path.join(repository, filename)) })));
    proof.sourceSetSha256 = createHash("sha256").update(JSON.stringify(proof.sourceFiles)).digest("hex");
    proof.inputSha256 = await fileHash(source);
    proof.nodeVersion = process.version;
    console.log(`Isolated native QA: ${root}; output: ${output}`);
  await vite.listen();
  const address = vite.httpServer.address();
  assert.equal(typeof address, "object");
  const url = `http://127.0.0.1:${address.port}`;
  const page = `${url}/scripts/qa/exporterNative.html?${new URLSearchParams({ root, identifier, profileSeconds: String(profileSeconds), denseSourceRoot })}`;
  const config = path.join(root, "tauri.qa.json");
  await writeFile(config, JSON.stringify({ identifier,
    build: { devUrl: url, beforeDevCommand: "", beforeBuildCommand: "" },
    app: { windows: [{ label: "main", title: "Isolated Exporter Native QA", url: page, width: 960, height: 640 }] },
    bundle: { active: false, externalBin: ["binaries/artdaddy-ffmpeg", "binaries/artdaddy-ffprobe"], resources: ["resources/fonts"] },
    plugins: { "deep-link": { desktop: { schemes: ["artdaddy-exporter-qa"] } } } }));
  const first = start(config, 1);
  const admitted = await changedFile(path.join(root, "native-armed.json"), (report) => Boolean(report.id), first);
  proof.steps.push({ phase: "native-job-armed", ...admitted });
  stopOwned(first);
  proof.steps.push({ phase: "owned-native-process-crashed" });
  const second = start(config, 2);
  const report = await changedFile(path.join(root, "native-report.json"), (report) => report.ok === true, second);
  assert.equal(report.producerComplete, true, "Native success must have persisted producer completion");
  assert.equal(report.recoveryAttempts, 1, "Crash must consume the bounded native recovery attempt");
  assert.ok(admitted.progress.includes("frame="), "Crash was not armed after real encoder progress");
  assert.equal(report.workerIdentity.sha256, await fileHash(executable("artdaddy-ffmpeg")), "Staged native worker differs from input sidecar");
  proof.workerIdentity = report.workerIdentity;
  proof.commandSha256 = report.commandSha256;
  proof.nativeAppSha256 = await fileHash(path.join(repository, "src-tauri", "target", "debug", `artdaddy${process.platform === "win32" ? ".exe" : ""}`));
  for (const [stream, format, length] of [["0:v:0", "rawvideo", 320 * 180 * 3 / 2 * 30], ["0:a:0", "f64le", 48000 * 2 * 8]]) {
    const decode = (filename) => {
      const decoded = spawnSync(executable("artdaddy-ffmpeg"), ["-nostdin", "-v", "error", "-i", filename,
        "-map", stream, "-f", format, "-"], { maxBuffer: 8 * 1024 * 1024 });
      assert.equal(decoded.status, 0, decoded.error?.message ?? String(decoded.stderr));
      assert.equal(decoded.stdout.length, length, `${stream} complete frame/sample count`);
      return decoded.stdout;
    };
    const expected = decode(source);
    for (const filename of [report.captured, report.delivered]) {
      const actual = decode(filename);
      assert.ok(expected.equals(actual), `${stream} changed in ${filename}`);
      proof.steps.push({ phase: "decoded-artifact", filename, stream, bytes: actual.length,
        sha256: createHash("sha256").update(actual).digest("hex") });
    }
  }
  assert.equal(report.protocol, admitted.protocol);
  const delivered = await readFile(report.delivered);
  assert.equal(createHash("sha256").update(delivered).digest("hex"), report.identity.sha256);
  const sourceBytes = await readFile(source);
  assert.equal(report.copies.length, 2, "Both queued recovery and live IPC copy lanes must run");
  for (const copy of report.copies) {
    const actual = await readFile(copy.delivered);
    assert.ok(sourceBytes.equals(actual), `${copy.kind} changed imported source bytes`);
    assert.equal(createHash("sha256").update(actual).digest("hex"), copy.identity.sha256);
    assert.equal(actual.length, copy.identity.size);
    proof.steps.push({ phase: "copied-artifact", kind: copy.kind, filename: copy.delivered, ...copy.identity });
  }
  assert.notEqual(report.unbound.code, 0, "Unbound interruption must not claim a successful producer");
  assert.equal(report.unbound.planGuessed, false);
  assert.equal(await readFile(report.unbound.delivered, "utf8"), "previous complete output");
  if (profileSeconds) {
    assert.ok(report.denseProfile, "Requested dense profile did not produce a result");
    const profile = report.denseProfile;
    const probed = spawnSync(executable("artdaddy-ffprobe"), ["-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,nb_read_frames,r_frame_rate", "-of", "json", profile.delivered], { encoding: "utf8" });
    assert.equal(probed.status, 0, probed.stderr);
    const video = JSON.parse(probed.stdout).streams[0];
    assert.equal(video.width, 3840);
    assert.equal(video.height, 2160);
    assert.equal(video.r_frame_rate, "60/1");
    assert.equal(Number(video.nb_read_frames), profileSeconds * 60);
    const decoded = spawnSync(executable("artdaddy-ffmpeg"), ["-nostdin", "-v", "error", "-i", profile.delivered,
      "-an", "-vf", "scale=384:216", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: profileSeconds * 60 * 384 * 216 * 3 + 1024 * 1024 });
    assert.equal(decoded.status, 0, String(decoded.stderr));
    const frameBytes = 384 * 216 * 3;
    assert.equal(decoded.stdout.length, frameBytes * profileSeconds * 60);
    const first = decoded.stdout.subarray(0, frameBytes);
    const tiles = Array.from({ length: 16 }, (_, index) => {
      const pixels = Buffer.concat(Array.from({ length: 30 }, (_, vertical) => {
        const start = ((Math.floor(index / 4) * 43 + vertical + 5) * 384 + index % 4 * 96 + 5) * 3;
        return first.subarray(start, start + 80 * 3);
      }));
      assert.ok(pixels.some((value) => value > 50), `Dense source${index} is blank`);
      return createHash("sha256").update(pixels).digest("hex");
    });
    assert.equal(new Set(tiles).size, 16, "Dense output must paint16distinct sources");
    assert.ok(!first.equals(decoded.stdout.subarray(frameBytes, frameBytes * 2)), "Dense output is frozen");
    const stereo = spawnSync(executable("artdaddy-ffmpeg"), ["-nostdin", "-v", "error", "-i", profile.delivered,
      "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-f", "f64le", "-"], { maxBuffer: profileSeconds * 48000 * 16 + 1024 * 1024 });
    assert.equal(stereo.status, 0, String(stereo.stderr));
    assert.ok(stereo.stdout.length >= profileSeconds * 48000 * 16, "Dense stereo samples are incomplete");
    const energy = [0, 0];
    let differentChannels = false;
    for (let offset = 0; offset + 16 <= stereo.stdout.length; offset += 16) {
      const left = stereo.stdout.readDoubleLE(offset);
      const right = stereo.stdout.readDoubleLE(offset + 8);
      assert.ok(Number.isFinite(left) && Number.isFinite(right));
      energy[0] += left * left;
      energy[1] += right * right;
      differentChannels ||= left !== right;
    }
    assert.ok(energy.every((value) => value > 0) && differentChannels, "Dense audio must retain two non-silent distinct channels");
    const caption = [0.15, 0.75].map((at) => {
      const decoded = spawnSync(executable("artdaddy-ffmpeg"), ["-nostdin", "-v", "error", "-ss", String(at), "-i", profile.delivered,
        "-frames:v", "1", "-vf", "scale=384:216", "-pix_fmt", "gray", "-f", "rawvideo", "-"], { maxBuffer: 1024 * 1024 });
      assert.equal(decoded.status, 0, String(decoded.stderr));
      let painted = 0;
      for (let vertical = 174; vertical < 210; vertical++) for (let horizontal = 60; horizontal < 324; horizontal++)
        if (decoded.stdout[vertical * 384 + horizontal] > 200) painted++;
      return { at, painted };
    });
    assert.ok(caption[1].painted > 20 && caption[1].painted > caption[0].painted, "Dense caption fade did not change actual footer pixels");
    proof.denseProfile = { ...profile, fixture: denseFixture, decodedVideo: video, distinctVisibleSources: new Set(tiles).size,
      stereoSampleFrames: stereo.stdout.length / 16, stereoEnergy: energy, captionSamples: caption,
      artifactVerified: true, shortTimingQualified: profile.withinFourTimesOutput,
      minimumMachineQualified: false, fullTwoHourWorkloadQualified: false };
    console.log(`DENSE PROFILE ${JSON.stringify(proof.denseProfile)}`);
  }
  assert.equal(report.compiled.length, 3, "Standard, explicit Streaming and Automatic must deliver through the shared queue");
  assert.deepEqual(report.compiled.map((entry) => entry.engine), ["file-sequence-v1", "partition-pipes-v1", "auto"]);
  assert.ok(report.compiled.every((entry) => entry.encoderThreads === report.compiled[0].encoderThreads), "Transport conformance must compare identical encoder settings");
  for (const candidate of report.compiled.slice(1)) {
    assert.ok(candidate.partitions >= 2, "Streaming artifact must cross real partition boundaries");
    assert.equal(candidate.continuousAudio, true, "Streamed output must use the single persistent audio graph");
    assert.equal(candidate.selection.backend, "partition-pipes-v1");
  }
  for (const [stream, format] of [["0:v:0", "rawvideo"], ["0:a:0", "f64le"]]) {
    const decode = (filename) => {
      const decoded = spawnSync(executable("artdaddy-ffmpeg"), ["-nostdin", "-v", "error", "-i", filename,
        "-map", stream, "-f", format, "-"], { maxBuffer: 16 * 1024 * 1024 });
      assert.equal(decoded.status, 0, decoded.error?.message ?? String(decoded.stderr));
      return decoded.stdout;
    };
    const expected = decode(report.compiled[0].delivered);
    for (const candidate of report.compiled.slice(1)) {
    const actual = decode(candidate.delivered);
    assert.ok(expected.equals(actual), `Current compiler ${candidate.engine} ${stream} differs from standard transport`);
    if (stream === "0:v:0") {
      assert.equal(actual.length, 320 * 180 * 3 / 2 * 98, "Compiled stream dropped or duplicated frames");
      const frameBytes = 320 * 180 * 3 / 2;
      assert.ok(!actual.subarray(0, frameBytes).equals(actual.subarray(frameBytes, frameBytes * 2)), "Compiled clip transforms are inert");
      const captionPixels = [0, 97].map((frame) => {
        let painted = 0;
        for (let vertical = 149; vertical < 174; vertical++) for (let horizontal = 50; horizontal < 270; horizontal++)
          if (actual[frame * frameBytes + vertical * 320 + horizontal] > 200) painted++;
        assert.ok(painted > 20, `Bundled caption did not paint below the media at frame ${frame}`);
        return { frame, painted };
      });
      proof.steps.push({ phase: "compiled-caption-pixels", engine: candidate.engine, samples: captionPixels, bundledFontsStagedByNativeOwner: true });
    } else { assert.ok(actual.length >= 156800 * 16, "Compiled stereo audio is incomplete"); }
    proof.steps.push({ phase: "compiled-stream-artifact", engine: candidate.engine, stream, bytes: actual.length,
      sha256: createHash("sha256").update(actual).digest("hex"), partitions: candidate.partitions });
    }
  }
  proof.ok = true;
  proof.native = report;
  proof.elapsedMs = Date.now() - started;
  await writeFile(path.join(output, "report.json"), JSON.stringify(proof, null, 2));
  console.log(`PASS native capture/recovery: ${output}`);
} catch (error) {
  proof.ok = false;
  proof.error = String(error);
  proof.elapsedMs = Date.now() - started;
  await writeFile(path.join(output, "report.json"), JSON.stringify(proof, null, 2));
  throw error;
} finally {
  for (const child of children) stopOwned(child);
  for (const log of logs) log.end();
  await vite.close();
  for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
  Object.assign(process.env, previousEnvironment);
}