import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, realpath, readdir, readlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, normalizePath } from "vite";
import { readLinuxMemoryCgroup, cgroupFits, sameCgroup, cgroupEncoderPids } from "./exporterLinuxMemory.mjs";

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

function compareOriginalAudio(reference, delivered, sampleRate = 48000) {
  assert.equal(reference.length % 16, 0);
  assert.equal(delivered.length % 16, 0);
  assert.equal(delivered.length, reference.length, "Original-audio comparison spans differ");
  const frames = reference.length / 16;
  assert.ok(frames >= sampleRate, "Original-audio comparison needs a complete second");
  const margin = Math.round(sampleRate * 0.05);
  const windowFrames = Math.round(sampleRate / 4);
  const channels = [];
  for (let channel = 0; channel < 2; channel++) for (let start = margin; start < frames - margin; start += windowFrames) {
    const end = Math.min(start + windowFrames, frames - margin);
    let sourceEnergy = 0, outputEnergy = 0, errorEnergy = 0, cross = 0;
    for (let frame = start; frame < end; frame++) {
      const expected = reference.readDoubleLE(frame * 16 + channel * 8);
      const actual = delivered.readDoubleLE(frame * 16 + channel * 8);
      assert.ok(Number.isFinite(expected) && Number.isFinite(actual), "Original-audio comparison contains a non-finite sample");
      sourceEnergy += expected * expected;
      outputEnergy += actual * actual;
      errorEnergy += (actual - expected) ** 2;
      cross += expected * actual;
    }
    const correlation = sourceEnergy > 0 && outputEnergy > 0 ? cross / Math.sqrt(sourceEnergy * outputEnergy) : null;
    const relativeError = sourceEnergy > 0 ? errorEnergy / sourceEnergy : null;
    if (sourceEnergy / (end - start) > 1e-8)
      assert.ok(correlation !== null && correlation >= 0.98 && relativeError !== null && relativeError <= 0.1,
        `Original audio channel ${channel} is missing, shifted or altered: correlation=${correlation},relativeError=${relativeError}`);
    else assert.ok(outputEnergy / (end - start) <= 1e-8, "Silent original audio acquired unrelated sound");
    channels.push({ channel, startFrame: start, endFrame: end, correlation, relativeError, sourceEnergy, outputEnergy });
  }
  return { comparedFrames: frames, ignoredEdgeFrames: margin, channels };
}

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "artdaddy-export-native-")));
const prepareOnly = process.argv.includes("--prepare-only");
const identifier = `com.artdaddy.qa.exporter-${Date.now()}`;
const output = prepareOnly ? path.join(root, "source-preparation") :
  path.join(repository, "reports", "qa", "exporter", `${target}-${Date.now()}`);
await mkdir(output, { recursive: true });
const fastQualitySource = process.env.ARTDADDY_QA_FAST_QUALITY_SOURCE ?? "";
if (fastQualitySource) {
  assert.equal(process.platform, "win32", "This private Fast measurement targets only the local AMF device");
  assert.ok(fastQualitySource.replaceAll("\\", "/").includes("/artdaddy-export-native-") &&
    path.basename(fastQualitySource) === "promise-heavy-eight-things-pilot.mp4", "Fast measurement only accepts the retained generated QA pilot");
  assert.ok(Number(process.env.ARTDADDY_QA_MEMORY_CAP_BYTES) > 0, "Fast measurement requires the existing process-tree cap harness");
  const before = createHash("sha256").update(await readFile(fastQualitySource)).digest("hex");
  const candidates = [
    { mode: "full-quality", codec: ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-threads:v", "1"] },
    { mode: "fast-candidate", codec: ["-c:v", "h264_amf", "-usage", "transcoding", "-quality", "quality", "-rc", "cqp",
      "-qp_i", "18", "-qp_p", "18", "-qp_b", "18"] },
  ];
  const measured = [];
  for (const candidate of candidates) {
    const destination = path.join(root, `${candidate.mode}.mp4`);
    const started = performance.now();
    const encoded = spawnSync(executable("artdaddy-ffmpeg"), ["-y", "-hide_banner", "-nostdin", "-v", "warning", "-i", fastQualitySource,
      "-map", "0:v:0", "-an", ...candidate.codec, "-pix_fmt", "yuv420p", "-frames:v", "300", "-movflags", "+faststart", destination],
      { encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(encoded.status, 0, encoded.error?.message ?? encoded.stderr);
    const encodingMs = performance.now() - started;
    const probe = spawnSync(executable("artdaddy-ffprobe"), ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
      "stream=width,height,r_frame_rate,nb_read_frames,codec_name", "-of", "json", destination], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    const video = JSON.parse(probe.stdout).streams[0];
    assert.deepEqual([video.width, video.height, video.r_frame_rate, Number(video.nb_read_frames), video.codec_name], [1920, 1080, "30/1", 300, "h264"]);
    const metrics = {};
    for (const metric of ["psnr", "ssim"]) {
      const checked = spawnSync(executable("artdaddy-ffmpeg"), ["-hide_banner", "-nostdin", "-v", "info", "-i", fastQualitySource, "-i", destination,
        "-lavfi", `[0:v]setpts=PTS-STARTPTS[reference];[1:v]setpts=PTS-STARTPTS[actual];[reference][actual]${metric}`,
        "-an", "-f", "null", "-"], { encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
      assert.equal(checked.status, 0, checked.error?.message ?? checked.stderr);
      const value = checked.stderr.match(metric === "psnr" ? /average:([\d.]+|inf)/ : /All:([\d.]+)/)?.[1];
      assert.ok(value, `${metric} did not report an artifact measurement`);
      metrics[metric] = value;
    }
    measured.push({ mode: candidate.mode, encodingMs, bytes: (await stat(destination)).size, video, metrics });
  }
  assert.equal(createHash("sha256").update(await readFile(fastQualitySource)).digest("hex"), before);
  await writeFile(path.join(output, "fast-quality.json"), JSON.stringify({ version: 2, sourceSha256: before,
    sourceClass: "retained generated seven-video-and-caption pilot, decoded as a common encoder input", sourceUnchanged: true,
    measured, qualityAccepted: false, productionEnabled: false, physicalQualified: false,
    scope: "local AMD AMF video-encoder comparison only; not original-timeline, audio, other devices or full-workload qualification" }, null, 2));
  console.log(`FAST QUALITY ${JSON.stringify({ output, measured, productionEnabled: false })}`);
  process.exit(0);
}

const promiseLibrary = JSON.parse(await readFile(path.join(repository, "scripts/qa/exporterPromiseCases.json"), "utf8"));
const promiseId = process.env.ARTDADDY_QA_PROMISE_CASE ?? "";
const promiseProfile = process.env.ARTDADDY_QA_PROMISE_PROFILE ?? "16gb";
const promiseCase = promiseId ? promiseLibrary.cases.find((entry) => entry.id === promiseId) : null;
assert.ok(!promiseId || promiseCase, "Unknown promise-library case");
assert.ok(!prepareOnly || promiseCase, "Source preparation requires a promise-library case");
const fastEncoderProbe = process.env.ARTDADDY_QA_FAST_ENCODER_PROBE ?? "";
assert.ok(!fastEncoderProbe || fastEncoderProbe === "amf-cqp18" && process.platform === "win32" && promiseCase?.kind === "pilot",
  "Fast encoder integration is a private Windows short-pilot measurement only");
assert.ok(!process.env.ARTDADDY_QA_ENCODER_THREADS_PROBE, "The private thread candidate was retired; measure the approved production policy instead");
assert.ok(promiseLibrary.profiles[promiseProfile], "Unknown promise-library profile");
const promiseAttempt = promiseCase ? { version: 2, caseId: promiseCase.id, profile: promiseProfile, kind: promiseCase.kind,
  line: promiseCase.line, platform: process.platform, profileRunId: process.env.ARTDADDY_QA_MEMORY_RUN_ID ?? null,
  definition: { width: promiseCase.width, height: promiseCase.height, fps: promiseCase.fps,
    durationSeconds: promiseCase.durationSeconds, visualClips: promiseCase.visualClips, videoLayers: promiseCase.videoLayers } } : null;
if (promiseAttempt) await writeFile(path.join(output, "promise-library.json"), JSON.stringify({ ...promiseAttempt,
  status: "preparing", sourceReady: false, artifactVerified: false, passed: false }, null, 2));
let promiseFixture;
if (promiseCase) {
  const started = performance.now();
  const sourceClass = promiseLibrary.sourceClasses[promiseCase.source];
  const paths = [];
  let mappedSource;
  try {
  if (promiseCase.source !== "generated") {
    let asset = sourceClass.path ? path.join(repository, sourceClass.path) : null;
    const manifestPath = process.env.ARTDADDY_QA_SOURCE_MANIFEST;
    if (manifestPath) {
      assert.ok((await stat(manifestPath)).size <= 65536, "Private source manifest exceeds 64 KiB");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.version, 1, "Unsupported private source manifest version");
      mappedSource = manifest.sources?.[promiseCase.source];
      if (mappedSource) {
        assert.ok(typeof mappedSource.path === "string" && mappedSource.path.trim(), "Private source path is missing");
        assert.match(mappedSource.sha256, /^[a-f0-9]{64}$/i, "Private source requires its expected SHA256");
        for (const field of ["provenance", "permission"])
          assert.ok(typeof mappedSource[field] === "string" && mappedSource[field].trim() && mappedSource[field].length <= 1000,
            `Private source requires ${field}`);
        if (promiseCase.source === "web-download")
          assert.equal(new URL(mappedSource.origin).protocol, "https:", "Downloaded source requires its recorded HTTPS origin");
        asset = path.resolve(path.dirname(manifestPath), mappedSource.path);
      }
    }
    if (!asset || !(await present(asset))) {
      throw new Error(`Promise case${promiseId} is blocked: its required real-world source is unavailable`);
    }
    for (let index = 0; index < promiseCase.videoLayers; index++) paths.push(asset);
  } else {
    const countPerLayer = Math.floor(promiseCase.visualClips / promiseCase.videoLayers);
    const seconds = Math.ceil(promiseCase.durationSeconds / countPerLayer) + 1;
    for (let index = 0; index < promiseCase.videoLayers; index++) {
      const asset = path.join(root, `promise-source-${index}.mp4`);
      const generated = spawnSync(executable("artdaddy-ffmpeg"), ["-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
        `testsrc2=s=${promiseCase.width}x${promiseCase.height}:r=${promiseCase.fps}:d=${seconds}`,
        "-vf", `hue=h=${index * 360 / promiseCase.videoLayers}`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-pix_fmt", "yuv420p", asset], { encoding: "utf8" });
      assert.equal(generated.status, 0, generated.error?.message ?? generated.stderr);
      paths.push(asset);
    }
  }
  const sources = [];
  for (const asset of [...new Set(paths)]) {
    const result = spawnSync(executable("artdaddy-ffprobe"), ["-v", "error", "-show_streams", "-show_format", "-of", "json", asset],
      { encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(result.stdout);
    const video = metadata.streams.find((entry) => entry.codec_type === "video");
    assert.ok(video && video.width > 0 && video.height > 0);
    if (promiseCase.sourceAudio) assert.ok(metadata.streams.some((entry) => entry.codec_type === "audio"),
      "Original-audio measurement requires an actual source audio stream");
    const duration = Number(video.duration ?? metadata.format.duration);
    const required = promiseCase.durationSeconds / Math.floor(promiseCase.visualClips / promiseCase.videoLayers);
    assert.ok(duration + 1 / promiseCase.fps >= required, "A promise fixture may not declare source footage beyond its actual end");
    if (sourceClass.realWorld && promiseCase.kind === "promise")
      assert.ok(Math.max(video.width, video.height) <= 3840 && Math.min(video.width, video.height) <= 2160,
        "A source above 4K cannot qualify an inside-promise real-world case");
    const digest = createHash("sha256");
    for await (const bytes of createReadStream(asset)) digest.update(bytes);
    const sha256 = digest.digest("hex");
    if (mappedSource) assert.equal(sha256, mappedSource.sha256.toLowerCase(), "Private source bytes do not match its expected SHA256");
    const rotation = Number(video.tags?.rotate ?? video.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ?? 0);
    let timingProof;
    if (promiseCase.source === "phone-vfr-rotation") {
      assert.ok(Number.isFinite(rotation) && rotation % 360 !== 0, "Phone fixture requires actual rotation metadata");
      const packets = spawnSync(executable("artdaddy-ffprobe"), ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+10",
        "-show_packets", "-show_entries", "packet=pts_time", "-of", "json", asset],
        { encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
      assert.equal(packets.status, 0, packets.error?.message ?? packets.stderr);
      const times = JSON.parse(packets.stdout).packets.map((packet) => Number(packet.pts_time)).filter(Number.isFinite).sort((left, right) => left - right);
      const intervals = times.slice(1).map((time, index) => Math.round((time - times[index]) * 1000000)).filter((value) => value > 0);
      const minIntervalMicros = Math.min(...intervals), maxIntervalMicros = Math.max(...intervals);
      assert.ok(intervals.length > 1 && maxIntervalMicros - minIntervalMicros > 1000, "Phone fixture requires measured variable presentation intervals");
      timingProof = { windowSeconds: 10, packets: times.length, minIntervalMicros, maxIntervalMicros, variableFrameRate: true };
    }
    sources.push({ path: asset, sha256, duration,
      width: video.width, height: video.height, fps: video.r_frame_rate, averageFps: video.avg_frame_rate,
      rotation, ...(timingProof ? { timingProof } : {}) });
  }
  promiseFixture = { preparationMs: performance.now() - started, realWorld: sourceClass.realWorld,
    provenance: mappedSource?.provenance ?? sourceClass.provenance,
    ...(mappedSource ? { permission: mappedSource.permission, origin: mappedSource.origin ?? null } : {}), paths, sources };
  await writeFile(path.join(root, "promise-input.json"), JSON.stringify({ case: promiseCase, profile: promiseProfile,
    profileSpec: promiseLibrary.profiles[promiseProfile], fixture: promiseFixture }));
  await writeFile(path.join(output, "promise-library.json"), JSON.stringify({ ...promiseAttempt, status: "prepared",
    sourceReady: true, artifactVerified: false, passed: false }, null, 2));
  } catch (error) {
    await writeFile(path.join(output, "promise-library.json"), JSON.stringify({ ...promiseAttempt,
      status: "blocked-source", sourceReady: false, artifactVerified: false, passed: false,
      reason: "Required source was missing or failed identity, metadata or provenance validation", physicalQualified: false }, null, 2));
    console.error(`SOURCE PREPARATION ${JSON.stringify({ root, output, sourceReady: false })}`);
    throw error;
  }
}
if (prepareOnly) {
  console.log(`SOURCE PREPARATION ${JSON.stringify({ root, output, sourceReady: true })}`);
  process.exit(0);
}
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
const linuxMemoryRunId = process.platform === "linux" ? process.env.ARTDADDY_QA_MEMORY_RUN_ID : undefined;
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
    if (linuxMemoryRunId) {
      assert.match(linuxMemoryRunId, /^[a-f0-9]{32}$/, "Invalid Linux memory run identity");
      const nodeBefore = await readLinuxMemoryCgroup();
      assert.ok(cgroupFits(nodeBefore, Number(process.env.ARTDADDY_QA_MEMORY_CAP_BYTES)), "Requested Linux kernel cap is absent");
      assert.ok(nodeBefore.path.endsWith(`/artdaddy-export-qa-${linuxMemoryRunId}.service`), "Native harness entered the wrong memory cgroup");
      proof.memoryCgroupEvidence = { runId: linuxMemoryRunId, nodeBefore };
    }
    await collectSources("src");
    await collectSources("src-tauri/src");
    sourceFiles.push("package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
      "src-tauri/tauri.conf.json", "scripts/qa/exporterNative.mjs", "scripts/qa/exporterNative.ts", "scripts/qa/exporterNative.html",
      "scripts/qa/exporterMemory.ps1", "scripts/qa/exporterLinuxMemory.mjs", "scripts/qa/exporterPromiseCases.json",
      "scripts/qa/exporterPromiseReport.mjs", "scripts/qa/exporterLinuxMemory.test.mjs",
      "scripts/qa/exporterPromiseReport.test.mjs", ".github/workflows/exporter-native-qa.yml");
    proof.sourceFiles = await Promise.all(sourceFiles.sort().map(async (filename) => ({ path: filename.replaceAll(path.sep, "/"), sha256: await fileHash(path.join(repository, filename)) })));
    proof.sourceSetSha256 = createHash("sha256").update(JSON.stringify(proof.sourceFiles)).digest("hex");
    proof.inputSha256 = await fileHash(source);
    proof.nodeVersion = process.version;
    console.log(`Isolated native QA: ${root}; output: ${output}`);
  await vite.listen();
  const address = vite.httpServer.address();
  assert.equal(typeof address, "object");
  const url = `http://127.0.0.1:${address.port}`;
  const page = `${url}/scripts/qa/exporterNative.html?${new URLSearchParams({ root, identifier, profileSeconds: String(profileSeconds), denseSourceRoot, promiseId, fastEncoderProbe })}`;
  const config = path.join(root, "tauri.qa.json");
  await writeFile(config, JSON.stringify({ identifier,
    build: { devUrl: url, beforeDevCommand: "", beforeBuildCommand: "" },
    app: { windows: [{ label: "main", title: "Isolated Exporter Native QA", url: page, width: 960, height: 640 }] },
    bundle: { active: false, externalBin: ["binaries/artdaddy-ffmpeg", "binaries/artdaddy-ffprobe"], resources: ["resources/fonts"] },
    plugins: { "deep-link": { desktop: { schemes: ["artdaddy-exporter-qa"] } } } }));
  const first = start(config, 1);
  const admitted = await changedFile(path.join(root, "native-armed.json"), (report) => Boolean(report.id), first);
  if (proof.memoryCgroupEvidence) {
    const evidence = proof.memoryCgroupEvidence;
    evidence.nativeBefore = admitted.resources?.memory_cgroup;
    assert.ok(sameCgroup(evidence.nodeBefore, evidence.nativeBefore), "First native app did not inherit the kernel cap");
    assert.deepEqual(await readLinuxMemoryCgroup(evidence.nativeBefore.process_id), evidence.nativeBefore,
      "Native cgroup evidence did not match its actual process");
    const workers = [];
    const members = await cgroupEncoderPids(path.join("/sys/fs/cgroup", evidence.nodeBefore.path), "/proc");
    for (const pid of members) {
      let executablePath;
      try { executablePath = await readlink(`/proc/${pid}/exe`); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!/^artdaddy-ffmpeg(?:-|$)/.test(path.basename(executablePath))) continue;
      const cgroup = await readLinuxMemoryCgroup(pid);
      assert.ok(sameCgroup(evidence.nodeBefore, cgroup), "Actual encoder escaped the kernel cap");
      const sha256 = await fileHash(executablePath);
      assert.equal(sha256, await fileHash(executable("artdaddy-ffmpeg")), "Observed capped encoder is not the staged worker");
      workers.push({ cgroup, sha256 });
    }
    assert.ok(workers.length > 0, "No actual encoder was observed inside the memory cgroup");
    evidence.workers = workers;
  }
  proof.steps.push({ phase: "native-job-armed", ...admitted });
  stopOwned(first);
  proof.steps.push({ phase: "owned-native-process-crashed" });
  const second = start(config, 2);
  const report = await changedFile(path.join(root, "native-report.json"), (report) => report.ok === true, second);
  if (proof.memoryCgroupEvidence) {
    const evidence = proof.memoryCgroupEvidence;
    evidence.nativeAfter = report.resources?.memory_cgroup;
    evidence.nodeAfter = await readLinuxMemoryCgroup();
    assert.ok([evidence.nativeAfter, evidence.nodeAfter].every((group) => sameCgroup(evidence.nodeBefore, group)),
      "Recovery or final reporting did not retain the kernel cap");
    assert.notEqual(evidence.nativeBefore.process_id, evidence.nativeAfter.process_id, "Recovery did not replace the app process");
    assert.deepEqual(await readLinuxMemoryCgroup(evidence.nativeAfter.process_id), evidence.nativeAfter,
      "Recovered app evidence did not match its actual process");
  }
  proof.hostProfileEvidence = ["darwin", "linux"].includes(process.platform) ? {
    scope: "measured-host-memory", runId: identifier, platform: process.platform,
    nodeTotalMemoryBytes: proof.hardware.totalMemoryBytes,
    nativeTotalMemoryBytes: report.resources?.total_memory_bytes ?? null,
  } : null;
  proof.softwareProfileInputs = Object.fromEntries(Object.entries(promiseLibrary.profiles).map(([profile, limits]) => [profile, {
    hostWithinMemoryBound: !!proof.hostProfileEvidence &&
      [proof.hostProfileEvidence.nodeTotalMemoryBytes, proof.hostProfileEvidence.nativeTotalMemoryBytes]
        .every((bytes) => Number.isSafeInteger(bytes) && bytes > 0 && bytes <= limits.systemMemoryBytes),
    cgroupWithinMemoryBound: !!proof.memoryCgroupEvidence &&
      cgroupFits(proof.memoryCgroupEvidence.nodeBefore, limits.systemMemoryBytes),
    physicalQualified: false, promiseQualified: false,
  }]));
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
  if (promiseCase) {
    const native = report.promiseResult;
    assert.equal(native?.caseId, promiseCase.id);
    assert.equal(native.state, "done");
    assert.equal(native.publicationVerified, true, "Promise output identity/catalog/ledger publication differs");
    assert.equal(native.stagingCleaned, true, "Promise staging file was not cleaned");
    assert.equal(native.selection?.policy, "auto", "Promise case must use the approved Automatic policy");
    if (promiseCase.videoLayers + Number(promiseCase.captions) > 4 ||
      promiseCase.width * promiseCase.height > 1920 * 1080 && promiseCase.videoLayers > 1 ||
      promiseCase.width * promiseCase.height > 2560 * 1440) // the one-pass picture ceiling, FILE_SEQUENCE_MAX_PIXELS in src/timeline/exportOptions.ts
      assert.equal(native.selection.backend, "partition-pipes-v1", "Dense promise case must use the bounded existing FFmpeg path");
    // The product asks only about a problem the export is known to have; a missing measurement (a
    // cold export, or the first one after an update) is not one. So a pilot that starts cleanly
    // sees no confirmation, and one that IS asked still has to say what it knows about the time.
    assert.ok((native.preflight?.length ?? 0) <= 1, "Promise pilot must not need more than one request-level preflight confirmation");
    for (const asked of native.preflight ?? [])
      assert.ok(asked.message.includes("Estimated time:") || asked.message.includes("Estimated encoding and saving time:"),
        "Preflight must show a measured estimate or explicitly unknown time");
    if (native.selection.backend === "partition-pipes-v1")
      assert.equal(native.encoderThreads, !fastEncoderProbe && promiseCase.width * promiseCase.height > 1920 * 1080 ? "2" : "1");
    assert.ok(native.calibrationRecords > 0, "Validated published exports must populate encoder-specific local measured history");
    if (fastEncoderProbe) {
      assert.equal(native.resources?.local_fast_candidate, true, "Local Fast pilot requires the measured native device eligibility");
      assert.equal(native.localFastEnabled, true, "Local Fast pilot must use the real selected-mode encoder path");
    }
    assert.ok(Number.isSafeInteger(native.resources?.total_memory_bytes) && native.resources.total_memory_bytes > 0,
      "Native resource snapshot did not measure system memory");
    assert.ok(Number.isSafeInteger(native.resources?.scratch_free_bytes) && native.resources.scratch_free_bytes >= 0,
      "Native resource snapshot did not measure scratch free space");
    assert.ok(Number.isSafeInteger(native.resources?.destination_free_bytes) && native.resources.destination_free_bytes >= 0,
      "Native resource snapshot did not measure destination free space");
    const probed = spawnSync(executable("artdaddy-ffprobe"), ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", native.destination], { encoding: "utf8" });
    assert.equal(probed.status, 0, probed.stderr);
    const metadata = JSON.parse(probed.stdout);
    const video = metadata.streams.filter((entry) => entry.codec_type === "video");
    const audio = metadata.streams.filter((entry) => entry.codec_type === "audio");
    assert.equal(video.length, 1);
    assert.equal(audio.length, Number(promiseCase.audio));
    assert.equal(video[0].width, promiseCase.width);
    assert.equal(video[0].height, promiseCase.height);
    assert.equal(video[0].r_frame_rate, `${promiseCase.fps}/1`);
    assert.equal(Number(video[0].nb_read_frames), promiseCase.durationSeconds * promiseCase.fps);
    assert.equal(video[0].codec_name, "h264");
    assert.ok(metadata.format.format_name.split(",").includes("mp4"));
    const bytes = await readFile(native.destination);
    assert.equal(bytes.length, native.finalIdentity.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), native.finalIdentity.sha256);
    const sampleSize = 160 * 90 * 3;
    const samples = [0.15, 0.75, Math.min(2, promiseCase.durationSeconds - 0.1)].map((at) => {
      const decoded = spawnSync(executable("artdaddy-ffmpeg"), ["-nostdin", "-v", "error", "-ss", String(at), "-i", native.destination,
        "-frames:v", "1", "-vf", "scale=160:90", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: sampleSize + 1024 * 1024 });
      assert.equal(decoded.status, 0, String(decoded.stderr));
      assert.equal(decoded.stdout.length, sampleSize);
      return decoded.stdout;
    });
    assert.ok(!samples[0].equals(samples[2]), "Promise picture is frozen");
    const tiles = Array.from({ length: promiseCase.videoLayers }, (_, index) => {
      const x = Math.floor(((index % native.columns) + 0.5) * 160 / native.columns);
      const y = Math.floor((Math.floor(index / native.columns) + 0.5) * 90 * native.imageHeight / native.rows);
      const values = Buffer.concat(Array.from({ length: 8 }, (_, row) => {
        const offset = ((y + row - 4) * 160 + x - 8) * 3;
        return samples[1].subarray(offset, offset + 16 * 3);
      }));
      if (!promiseFixture.realWorld) assert.ok(values.some((value) => value > 48), `Promise layer${index} is blank`);
      return createHash("sha256").update(values).digest("hex");
    });
    assert.equal(new Set(tiles).size, promiseCase.videoLayers, "Promise layers collapsed to identical pictures");
    let sourcePictureProof;
    let orientationProof;
    if (promiseFixture.realWorld) {
      assert.equal(promiseCase.videoLayers, 1, "Source-picture checks require the single-source fixture layout");
      assert.equal(promiseCase.visualClips, 1, "Source-picture checks require the uncut fixture timeline");
      const phone = promiseCase.source === "phone-vfr-rotation";
      const height = Math.round(90 * native.imageHeight);
      const picture = (frame) => Buffer.concat(Array.from({ length: height }, (_, row) =>
        frame.subarray(row * 160 * 3, (row + 1) * 160 * 3)));
      const pictures = samples.map(picture);
      assert.ok(!pictures[0].equals(pictures[2]), "Real-source picture is frozen despite changing captions");
      sourcePictureProof = [0.15, 0.75, Math.min(2, promiseCase.durationSeconds - 0.1)].map((at, index) => {
        const sourceFrame = (wrongControl) => {
          const decoded = spawnSync(executable("artdaddy-ffmpeg"), ["-nostdin", "-v", "error",
            ...(wrongControl && phone ? ["-noautorotate"] : []), "-ss", String(at), "-i", promiseFixture.paths[0],
            "-frames:v", "1", "-vf", `scale=160:${height}${wrongControl && !phone ? ",vflip" : ""}`,
            "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
            { maxBuffer: sampleSize + 1024 * 1024 });
          assert.equal(decoded.status, 0, String(decoded.stderr));
          assert.equal(decoded.stdout.length, 160 * height * 3);
          return decoded.stdout;
        };
        const actual = pictures[index];
        const error = (reference) => {
          let sum = 0;
          for (let offset = 0; offset < actual.length; offset++) sum += Math.abs(actual[offset] - reference[offset]);
          return sum / actual.length;
        };
        const reference = sourceFrame(false);
        const sourceError = error(reference);
        const blankError = reference.reduce((sum, value) => sum + value, 0) / reference.length;
        assert.ok(sourceError < blankError, "Real-source picture is missing or no closer than a blank frame");
        const controlError = error(sourceFrame(true));
        assert.ok(sourceError < controlError, "Real-source output does not follow the mapped source picture");
        return { at, sourceError, blankError, controlError, control: phone ? "rotation-ignored" : "vertical-flip" };
      });
      if (phone) orientationProof = sourcePictureProof.map(({ at, sourceError, controlError }) =>
        ({ at, correctlyRotatedError: sourceError, ignoredRotationError: controlError }));
    }
    let captionSamples;
    if (promiseCase.captions) {
      const painted = [0.15, 0.75].map((at) => {
        const decoded = spawnSync(executable("artdaddy-ffmpeg"), ["-nostdin", "-v", "error", "-ss", String(at), "-i", native.destination,
          "-frames:v", "1", "-vf", "scale=384:216", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1024 * 1024 });
        assert.equal(decoded.status, 0, String(decoded.stderr));
        assert.equal(decoded.stdout.length, 384 * 216 * 3);
        let count = 0;
        for (let row = 172; row < 216; row++) for (let column = 0; column < 384; column++) {
          const index = (row * 384 + column) * 3;
          if (decoded.stdout[index] > 150 && decoded.stdout[index + 1] > 150 && decoded.stdout[index + 2] > 150) count++;
        }
        return count;
      });
      assert.ok(painted[1] > 0 && painted[1] > painted[0], "Promise caption did not visibly fade in");
      captionSamples = painted;
    }
    let sound;
    if (promiseCase.audio) {
      assert.equal(audio[0].channels, 2);
      assert.equal(Number(audio[0].sample_rate), 48000);
      sound = await new Promise((resolve, reject) => {
        const child = spawn(executable("artdaddy-ffmpeg"), ["-nostdin", "-v", "error", "-i", native.destination,
          "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-f", "f64le", "-"], { windowsHide: true });
        let pending = Buffer.alloc(0), frames = 0, error = "";
        const energy = [0, 0], real = [0, 0, 0, 0], imaginary = [0, 0, 0, 0];
        child.stdout.on("data", (chunk) => {
          const bytes = Buffer.concat([pending, chunk]);
          const complete = bytes.length - bytes.length % 16;
          for (let offset = 0; offset < complete; offset += 16) {
            const values = [bytes.readDoubleLE(offset), bytes.readDoubleLE(offset + 8)];
            if (!values.every(Number.isFinite)) { error = "non-finite audio sample"; child.kill(); return; }
            for (let channel = 0; channel < 2; channel++) {
              energy[channel] += values[channel] ** 2;
              if (frames < 48000) for (let tone = 0; tone < 2; tone++) {
                const angle = 2 * Math.PI * (tone ? 880 : 440) * frames / 48000;
                real[channel * 2 + tone] += values[channel] * Math.cos(angle);
                imaginary[channel * 2 + tone] += values[channel] * Math.sin(angle);
              }
            }
            frames++;
          }
          pending = bytes.subarray(complete);
        });
        child.stderr.on("data", (chunk) => { error = (error + String(chunk)).slice(-4096); });
        child.once("error", reject);
        child.once("close", (code) => code === 0 && pending.length === 0 ? resolve({ frames, energy,
          tones: real.map((value, index) => 2 * Math.hypot(value, imaginary[index]) / Math.min(frames, 48000)) }) : reject(new Error(error || `Audio decode failed:${code}`)));
      });
      assert.ok(sound.frames >= promiseCase.durationSeconds * 48000 && sound.frames <= promiseCase.durationSeconds * 48000 + 1024);
      if (promiseCase.sourceAudio) {
        const decodeAudio = (filename) => {
          const result = spawnSync(executable("artdaddy-ffmpeg"), ["-nostdin", "-v", "error", "-i", filename,
            "-map", "0:a:0", "-af", `aresample=48000:async=1:first_pts=0,apad,atrim=end_sample=${promiseCase.durationSeconds * 48000}`,
            "-ar", "48000", "-ac", "2", "-f", "f64le", "-"],
          { maxBuffer: promiseCase.durationSeconds * 48000 * 16 + 1024 * 1024 });
          assert.equal(result.status, 0, String(result.stderr));
          assert.ok(result.stdout.length >= promiseCase.durationSeconds * 48000 * 16, "Original audio span is incomplete");
          return result.stdout;
        };
        sound.originalAudio = compareOriginalAudio(decodeAudio(promiseFixture.paths[0]), decodeAudio(native.destination));
      } else {
        assert.ok(sound.energy.every((value) => value > 0));
        assert.ok(sound.tones[0] > 0.06 && sound.tones[3] > 0.04 && sound.tones[1] < 0.01 && sound.tones[2] < 0.01,
          "Promise audio lost, swapped or mixed the authored stereo tones");
      }
    }
    const speedLimit = promiseProfile === "16gb" ? promiseCase.speedFactor16gb : null;
    const timingQualified = speedLimit === null || native.elapsedMs <= promiseCase.durationSeconds * speedLimit * 1000;
    const cap = Number(process.env.ARTDADDY_QA_MEMORY_CAP_BYTES ?? 0);
    const profileBound = promiseLibrary.profiles[promiseProfile].systemMemoryBytes;
    const hostProfileEvidence = proof.hostProfileEvidence;
    const hostProfileFits = !!hostProfileEvidence && [hostProfileEvidence.nodeTotalMemoryBytes, hostProfileEvidence.nativeTotalMemoryBytes]
      .every((bytes) => Number.isSafeInteger(bytes) && bytes > 0 && bytes <= profileBound);
    const cgroupFitsProfile = !!proof.memoryCgroupEvidence &&
      cgroupFits(proof.memoryCgroupEvidence.nodeBefore, profileBound);
    const profileEnforced = process.platform === "win32" && cap > 0 && cap <= profileBound || hostProfileFits || cgroupFitsProfile;
    const temporarySpaceQualified = false;
    proof.promiseResult = { ...promiseAttempt, ...native, fixture: promiseFixture, sound, captionSamples, sourcePictureProof, orientationProof, sourceReady: true,
      mode: native.encoder === "libx264" ? "quality" : native.encoder === "h264_amf" ? "fast" : "unknown",
      encodedVideo: { width: video[0].width, height: video[0].height, fps: video[0].r_frame_rate, frames: Number(video[0].nb_read_frames) },
      artifactVerified: true, timingQualified,
      profileRunId: process.env.ARTDADDY_QA_MEMORY_RUN_ID ?? null,
      hostProfileEvidence,
      profileEnforced, physicalQualified: false, temporarySpaceQualified,
      passed: promiseCase.kind === "promise" && timingQualified && profileEnforced && temporarySpaceQualified && native.scratchCleaned && native.estimateProvided,
      qualificationStatus: promiseCase.kind === "pilot" ? "pilot-only" : "incomplete-resource-and-estimate-proof" };
    await writeFile(path.join(output, "promise-library.json"), JSON.stringify(proof.promiseResult, null, 2));
    console.log(`PROMISE LIBRARY ${JSON.stringify(proof.promiseResult)}`);
  }
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
  if (promiseAttempt && !proof.promiseResult) await writeFile(path.join(output, "promise-library.json"), JSON.stringify({ ...promiseAttempt,
    status: "failed", sourceReady: !!promiseFixture, artifactVerified: false, passed: false,
    elapsedMs: proof.elapsedMs, physicalQualified: false }, null, 2));
  throw error;
} finally {
  for (const child of children) stopOwned(child);
  for (const log of logs) log.end();
  await vite.close();
  for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
  Object.assign(process.env, previousEnvironment);
}