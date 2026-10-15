import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = await fs.mkdtemp(path.join(os.tmpdir(), "artdaddy-export-gpu-"));
const encode = process.argv.includes("--encode");
const decodeReaders = process.argv.includes("--decode16") ? 16 : process.argv.includes("--decode") ? 1 : 0;
const fixture601 = process.argv.includes("--fixture-601");
assert(!fixture601 || decodeReaders, "private colour compatibility requires the frozen source");
let baseline;
let frozen;
if (decodeReaders) {
  baseline = JSON.parse(await fs.readFile(path.join(root, "reports/bench/export-feasibility-baseline.json"), "utf8"));
  frozen = baseline.cases.find((entry) => entry.level === "simple").artifact;
  const source = await fs.realpath(frozen.sourcePath);
  assert(source.startsWith(await fs.realpath(os.tmpdir()) + path.sep));
  assert(path.basename(path.dirname(source)).startsWith("artdaddy-bench-render-"));
  assert.equal(createHash("sha256").update(await fs.readFile(source)).digest("hex"), frozen.sourceSha256);
  const reference = await fs.realpath(frozen.outputPath);
  assert.equal(path.dirname(reference), path.dirname(source));
  assert.equal(createHash("sha256").update(await fs.readFile(reference)).digest("hex"), frozen.outputSha256);
  frozen = { ...frozen, sourcePath: source, outputPath: reference };
}
const reservation = net.createServer();
await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
const port = reservation.address().port;
await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
const server = await createServer({
  root, configFile: false,
  optimizeDeps: { noDiscovery: true, include: ["mp4box"] },
  server: { host: "127.0.0.1", port, strictPort: true,
    fs: { allow: [root, ...(decodeReaders ? [path.dirname(await fs.realpath(frozen.sourcePath))] : [])] } },
});
let browser;
const failures = [];
async function runBinary(binary, args, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    const chunks = [];
    let bytes = 0;
    let stderr = "";
    const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.on("error", (error) => { clearTimeout(deadline); reject(error); });
    child.on("close", (status) => {
      clearTimeout(deadline);
      resolve({ status, stdout: Buffer.concat(chunks), stderr });
    });
  });
}
try {
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  assert(url, "private Vite server did not bind");
  browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("pageerror", (error) => failures.push(String(error)));
  page.on("requestfailed", (request) => failures.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
  await page.goto(new URL("preview-probe.html", url).href, { waitUntil: "commit", timeout: 60_000 });
  await page.waitForFunction(() => typeof window.__exportGpuProbe === "function", { timeout: 60_000 });
  assert.equal(await page.evaluate(() => window.__probe), "ok");
  const sourceUrls = decodeReaders ? Array.from({ length: decodeReaders }, (_, reader) =>
    new URL(`/@fs/${frozen.sourcePath.replaceAll("\\", "/")}?reader=${reader}`, url).href) : [];
  let deadline;
  const report = await Promise.race([
    page.evaluate(({ encode, sourceUrls, fixture601 }) => window.__exportGpuProbe(3840, 2160, 30, encode, sourceUrls, fixture601),
      { encode, sourceUrls, fixture601 }),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("private GPU pipeline deadline exceeded")), 120_000); }),
  ]).finally(() => clearTimeout(deadline));
  const pipelineMeasurement = { ...report };
  delete pipelineMeasurement.encodedChunks;
  await fs.writeFile(path.join(output, "pipeline-measurement.json"), JSON.stringify({
    ...pipelineMeasurement, measuredAt: new Date().toISOString(), browserVersion: browser.version(),
    resources: { peakWholeWorkerMemoryBytes: null, peakPhysicalScratchBytes: null },
    qualification: "unverified pipeline measurement; artifact checks must pass separately",
  }, null, 2));
  assert.equal(failures.length, 0, failures.join("\n"));
  assert.equal(report.hardwareGpu, true, `software/unverified GPU: ${report.rendererName}`);
  assert.equal(report.checks.length, 2);
  assert.equal(report.checks[0].tiles.length, 16);
  assert.notDeepEqual(report.checks[0].tiles, report.checks[1].tiles);
  if (decodeReaders) {
    assert.equal(report.sourceReaders, decodeReaders);
    for (const timestamps of report.decodedTimestamps) {
      assert.equal(timestamps.length, 30);
      for (let frame = 0; frame < timestamps.length; frame++)
        assert(Math.abs(timestamps[frame] - timestamps[0] - Math.round(frame * 1_000_000 / 60)) <= 2);
    }
  }
  if (encode) {
    assert.equal(report.peakEncodeQueue <= 2, true);
    const elementary = path.join(output, "video.h264");
    const video = path.join(output, "video.mp4");
    await fs.writeFile(elementary, Buffer.concat(report.encodedChunks.map((chunk) => Buffer.from(chunk))));
    const ffmpeg = path.join(root, "src-tauri/binaries/artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe");
    const mux = await runBinary(ffmpeg, ["-y", "-v", "error", "-r", "60", "-i", elementary,
      ...(decodeReaders ? ["-i", frozen.sourcePath, "-map", "0:v", "-map", "1:a", "-c:a", "copy", "-t", "0.5"] : []),
      "-c:v", "copy", video]);
    assert.equal(mux.status, 0, mux.stderr);
    const ffprobe = path.join(root, "src-tauri/binaries/artdaddy-ffprobe-x86_64-pc-windows-msvc.exe");
    const probe = await runBinary(ffprobe, ["-v", "error", "-count_frames", "-show_entries",
      "stream=codec_type,width,height,nb_read_frames,r_frame_rate,channels,sample_rate", "-of", "json", video]);
    assert.equal(probe.status, 0, probe.stderr);
    const metadata = JSON.parse(probe.stdout);
    const stream = metadata.streams.find((stream) => stream.codec_type === "video");
    assert.deepEqual([stream.width, stream.height, Number(stream.nb_read_frames), stream.r_frame_rate], [3840, 2160, 30, "60/1"]);
    const decode = await runBinary(ffmpeg, ["-v", "error", "-i", video, "-vf", "scale=32:18", "-pix_fmt", "rgb24",
      "-f", "rawvideo", "-"]);
    assert.equal(decode.status, 0, String(decode.stderr));
    assert.equal(decode.stdout.length, 30 * 32 * 18 * 3);
    const branches = Array.from({ length: 16 }, (_, tile) => `s${tile}`);
    const crops = branches.map((branch, tile) => {
      const x = Math.floor(((tile % 4) + 0.5) * 3840 / 4);
      const y = Math.floor((Math.floor(tile / 4) + 0.5) * 2160 / 4);
      return `[${branch}]crop=1:1:${x}:${y}[p${tile}]`;
    });
    const points = await runBinary(ffmpeg, ["-v", "error", "-i", video, "-filter_complex",
      `[0:v]select='eq(n,0)+eq(n,29)',format=rgb24,split=16${branches.map((branch) => `[${branch}]`).join("")};` +
      crops.join(";") + ";" + branches.map((_, tile) => `[p${tile}]`).join("") + "hstack=inputs=16[out]",
      "-map", "[out]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    assert.equal(points.status, 0, points.stderr);
    assert.equal(points.stdout.length, 2 * 16 * 3);
    const pixelFailures = [];
    for (let pointFrame = 0; pointFrame < report.checks.length; pointFrame++) {
      const check = report.checks[pointFrame];
      for (let tile = 0; tile < 16; tile++) {
        const offset = (pointFrame * 16 + tile) * 3;
        const pixel = Array.from(points.stdout.subarray(offset, offset + 3));
        if (!pixel.every((value, channel) => Math.abs(value - check.tiles[tile][channel]) <= 14))
          pixelFailures.push({ tile, frame: check.frame, actual: pixel, expected: check.tiles[tile] });
      }
    }
    report.artifact = { path: video, verifiedFrames: 30, changingTilePixelsVerified: pixelFailures.length === 0,
      maxTileChannelDifference: 14, pixelFailures };
    if (decodeReaders) {
      const audioStream = metadata.streams.find((stream) => stream.codec_type === "audio");
      assert.deepEqual([audioStream.channels, audioStream.sample_rate], [2, "48000"]);
      const sound = await runBinary(ffmpeg, ["-v", "error", "-i", video, "-map", "0:a", "-ar", "48000",
        "-ac", "2", "-t", "0.5", "-f", "f32le", "-"]);
      assert.equal(sound.status, 0, sound.stderr);
      assert.equal(sound.stdout.length, 24_000 * 2 * 4);
      const magnitude = (channel, frequency) => {
        const count = sound.stdout.length / 8;
        let real = 0;
        let imaginary = 0;
        for (let sample = 0; sample < count; sample++) {
          const value = sound.stdout.readFloatLE(sample * 8 + channel * 4);
          const angle = 2 * Math.PI * frequency * sample / 48000;
          real += value * Math.cos(angle);
          imaginary += value * Math.sin(angle);
        }
        return 2 * Math.hypot(real, imaginary) / count;
      };
      const audio = { left440: magnitude(0, 440), left880: magnitude(0, 880), right440: magnitude(1, 440), right880: magnitude(1, 880) };
      assert(audio.left440 > 0.07 && audio.right880 > 0.05);
      assert(audio.left880 < audio.left440 / 4 && audio.right440 < audio.right880 / 4);
      report.artifact.audio = audio;
      report.sourceSha256 = frozen.sourceSha256;
      report.audioScope = "one frozen stereo source copied into the deliverable; no mixing/ducking/retiming qualification";
      const comparisonArgs = ["-v", "error", "-i"];
      const referenceFrames = await runBinary(ffmpeg, [...comparisonArgs, frozen.outputPath, "-vf",
        "select='eq(n,0)+eq(n,29)',scale=32:18", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
      const candidateFrames = await runBinary(ffmpeg, [...comparisonArgs, video, "-vf",
        "select='eq(n,0)+eq(n,29)',crop=960:540:0:0,scale=32:18", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
      assert.equal(referenceFrames.status, 0, referenceFrames.stderr);
      assert.equal(candidateFrames.status, 0, candidateFrames.stderr);
      const frameBytes = 32 * 18 * 3;
      assert.equal(referenceFrames.stdout.length, 2 * frameBytes);
      assert.equal(candidateFrames.stdout.length, 2 * frameBytes);
      const meanRgbDifferences = [0, 1].map((frame) => {
        let difference = 0;
        for (let pixel = 0; pixel < frameBytes; pixel++) {
          const offset = frame * frameBytes + pixel;
          difference += Math.abs(candidateFrames.stdout[offset] - referenceFrames.stdout[offset] * (frame ? 0.5 : 1));
        }
        return difference / frameBytes;
      });
      assert.notDeepEqual(referenceFrames.stdout.subarray(0, frameBytes), referenceFrames.stdout.subarray(frameBytes));
      report.referenceComparison = { outputSha256: frozen.outputSha256, sampledFrames: [0, 29],
        meanRgbDifferences, maxMeanRgbDifference: 3, passed: meanRgbDifferences.every((difference) => difference < 3),
        scope: "first tile vs frozen simple reference at 32x18, with submitted opacity; not full-resolution/effect parity" };
    }
    delete report.encodedChunks;
  }
  if (decodeReaders) {
    assert.equal(createHash("sha256").update(await fs.readFile(frozen.sourcePath)).digest("hex"), frozen.sourceSha256);
    assert.equal(createHash("sha256").update(await fs.readFile(frozen.outputPath)).digest("hex"), frozen.outputSha256);
  }
  await fs.writeFile(path.join(output, "compositor-report.json"), JSON.stringify({
    ...report, measuredAt: new Date().toISOString(), browserVersion: browser.version(),
    host: { cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
    resources: { peakWholeWorkerMemoryBytes: null, peakPhysicalScratchBytes: null },
    qualification: report.artifact?.pixelFailures.length || report.referenceComparison && !report.referenceComparison.passed
      ? "candidate content conformance failed; retained measurement only"
      : "partial development-host feasibility only",
  }, null, 2));
  console.log(JSON.stringify({ report: path.join(output, "compositor-report.json"),
    renderer: report.rendererName, uploadMs: report.uploadMs,
    meanDrawMs: report.meanDrawMs, meanReadbackMs: report.meanReadbackMs, meanFrameMs: report.meanFrameMs,
    sourceWaitMs: report.meanSourceWaitMs, sourceReaders: report.sourceReaders,
    encodedPixelFailures: report.artifact?.pixelFailures, referenceComparison: report.referenceComparison,
  }, null, 2));
  if (report.artifact) assert.equal(report.artifact.pixelFailures.length, 0, "encoded-picture checks failed; measurements retained");
  if (report.referenceComparison) assert.equal(report.referenceComparison.passed, true, "frozen-reference picture comparison failed; performance evidence retained");
} catch (error) {
  await fs.writeFile(path.join(output, "probe-failure.json"), JSON.stringify({ error: String(error), failures }, null, 2));
  console.error(JSON.stringify({ evidence: path.join(output, "probe-failure.json"), failures }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}