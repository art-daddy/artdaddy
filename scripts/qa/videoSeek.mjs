import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { build } from "esbuild";

const baseline = process.argv[2];
assert.match(baseline ?? "", /^[a-f0-9]{40}$/);
const output = path.resolve("test-results/video-seek");
await mkdir(output, { recursive: true });
const recording = await readFile("e2e/ui/fixtures/mac-recording-preview.mp4");
const inputHash = createHash("sha256").update(recording).digest("hex");
const original = execFileSync("git", ["show", `${baseline}:src/preview/videoSource.ts`], {
  encoding: "utf8",
});
const bundles = {};
for (const version of ["before", "after"]) {
  const bundle = await build({
    entryPoints: ["src/preview/videoSource.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "VideoProbe",
    plugins: version === "before" ? [{
      name: "original-decoder",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]videoSource\.ts$/ }, () => ({
          contents: original,
          loader: "ts",
          resolveDir: path.resolve("src/preview"),
        }));
      },
    }] : [],
  });
  bundles[version] = bundle.outputFiles[0].text;
}
const probe = `
  const shots = { fresh: {}, sequence: [] };
  const pixel = (frame) => {
    if (!frame) return null;
    const canvas = document.createElement("canvas");
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(frame, 0, 0);
    return {
      timestamp: frame.timestamp,
      color: [...context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data].slice(0, 3),
      png: canvas.toDataURL("image/png"),
    };
  };
  (async () => {
    for (const seconds of [0.4, 2, 2.9]) {
      const source = new VideoProbe.VideoSource("/recording.mp4");
      try {
        await source.whenReady();
        shots.fresh[seconds] = pixel(await source.frameAt(seconds));
      } catch (error) {
        shots.fresh[seconds] = { error: String(error) };
      } finally { source.close(); }
    }
    const source = new VideoProbe.VideoSource("/recording.mp4");
    try {
      await source.whenReady();
      for (const seconds of [0.4, 2, 0.4, 2.9, 2]) {
        shots.sequence.push({ seconds, frame: pixel(await source.frameAt(seconds)) });
      }
      const cancelled = source.frameAt(0.4);
      const latest = source.frameAt(2);
      shots.superseded = await cancelled === null;
      shots.latest = pixel(await latest);
      source.idle();
      shots.afterIdle = pixel(await source.frameAt(2));
    } catch (error) { shots.error = String(error); }
    finally { source.close(); }
    window.__rotation = shots;
  })().catch((error) => { window.__rotation = { error: String(error) }; });
`;
const server = createServer((request, response) => {
  if (request.url === "/recording.mp4") {
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    if (!range) { response.writeHead(416).end(); return; }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), recording.length - 1);
    if (start > end) { response.writeHead(416).end(); return; }
    response.writeHead(206, {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes ${start}-${end}/${recording.length}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
    });
    response.end(recording.subarray(start, end + 1));
    return;
  }
  const version = request.url === "/before" ? "before" : "after";
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<!doctype html><html><body><script>${bundles[version]}\n${probe}</script></body></html>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const reports = {};
try {
  for (const version of ["before", "after"]) {
    const reportPath = path.join(output, `${version}.json`);
    await new Promise((resolve, reject) => {
      const child = spawn("swift", [
        "scripts/qa/systemWebkitPixels.swift", `http://127.0.0.1:${port}/${version}`, reportPath,
      ], { stdio: "inherit", timeout: 80_000 });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`WKWebView exited ${code}`)));
    });
    reports[version] = JSON.parse(await readFile(reportPath, "utf8"));
    for (const [index, frame] of Object.entries(reports[version].shots.fresh ?? {})) {
      if (frame?.png) await writeFile(path.join(output, `${version}-${index}.png`), Buffer.from(frame.png.split(",")[1], "base64"));
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
const colorIs = (frame, seconds) => {
  if (!frame?.color || !Number.isFinite(frame.timestamp)) return false;
  const [red, green, blue] = frame.color;
  return blue < 90 && (seconds < 1 ? red > 150 && green < 100 : green > 150 && red < 100);
};
const after = reports.after.shots;
await writeFile(path.join(output, "comparison.json"), JSON.stringify({
  baseline,
  inputHash,
  beforeLater: reports.before.shots.fresh[2],
  afterLater: after.fresh[2],
  originalReproduced: !colorIs(reports.before.shots.fresh[2], 2),
}, null, 2));
assert.equal(reports.after.engine, "system WKWebView");
assert.equal(after.error, undefined);
for (const seconds of [0.4, 2, 2.9]) assert.ok(colorIs(after.fresh[seconds], seconds), `No correct fresh frame at ${seconds}s`);
for (const item of after.sequence) assert.ok(colorIs(item.frame, item.seconds), `No correct sequential frame at ${item.seconds}s`);
assert.equal(after.superseded, true);
assert.ok(colorIs(after.latest, 2), "A superseded seek displaced the latest frame");
assert.ok(colorIs(after.afterIdle, 2), "The source did not recover after releasing its decoder");
assert.ok(!colorIs(reports.before.shots.fresh[2], 2), "The original decoder did not exhibit the saved Mac failure; this run cannot certify the fix");
assert.equal(createHash("sha256").update(await readFile("e2e/ui/fixtures/mac-recording-preview.mp4")).digest("hex"), inputHash);
console.log("The same Mac recording fails before and shows correct earlier/later pixels after the preview change.");