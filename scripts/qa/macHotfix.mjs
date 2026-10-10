import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.argv[2] === "check") {
  const { default: ts } = await import("typescript");
  const input = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
  assert.equal(input.error, undefined);
  const config = ts.parseJsonConfigFileContent(input.config, ts.sys, process.cwd());
  const program = ts.createProgram(
    [...config.fileNames, "scripts/qa/macHotfix.ts"],
    config.options,
  );
  const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    console.error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      }),
    );
    process.exit(1);
  }
  console.log("Repo-config typecheck including native QA passed");
  process.exit(0);
}

assert.equal(process.platform, "darwin", "This is native macOS QA, not a browser substitute");
const oldFs = process.argv[2] === "old-fs";
const outputDir = path.resolve("test-results/mac-hotfix", oldFs ? "old-fs" : "fixed");
await mkdir(outputDir, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "artdaddy-mac-hotfix-"));
const config = path.join(root, "tauri.qa.json");
const reportPath = path.join(root, "report.json");
const url = `http://127.0.0.1:5175/scripts/qa/macHotfix.html?root=${encodeURIComponent(root)}`;
await writeFile(
  config,
  JSON.stringify({
    identifier: "com.artdaddy.qa.mac-hotfix",
    build: {
      devUrl: "http://127.0.0.1:5175",
      beforeDevCommand: "npx vite --host 127.0.0.1 --port 5175 --strictPort",
      beforeBuildCommand: "",
    },
    app: {
      windows: [{ label: "main", title: "Isolated Mac Hotfix QA", url, width: 1100, height: 800 }],
    },
    bundle: {
      active: false,
      externalBin: ["binaries/artdaddy-ffmpeg", "binaries/artdaddy-ffprobe"],
      resources: [],
    },
    ...(oldFs ? { plugins: { fs: { requireLiteralLeadingDot: true } } } : {}),
  }),
);
const log = createWriteStream(path.join(outputDir, "native-app.log"));
const child = spawn(
  process.execPath,
  [path.resolve("node_modules/@tauri-apps/cli/tauri.js"), "dev", "--no-watch", "--config", config],
  {
    cwd: process.cwd(),
    detached: true,
    env: { ...process.env, VITE_API_BASE_URL: "http://127.0.0.1:9", VITE_SENTRY_DSN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let watcher;
let timer;
try {
  const report = await new Promise((resolve, reject) => {
    let reading = false;
    const inspect = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = JSON.parse(await readFile(reportPath, "utf8"));
        resolve(value);
      } catch (error) {
        if (error.code !== "ENOENT") reject(error);
      } finally {
        reading = false;
      }
    };
    watcher = watch(root, () => void inspect());
    timer = setTimeout(
      () => reject(new Error("Native Mac QA timed out without a report")),
      20 * 60_000,
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Native Mac QA exited ${code} before reporting`));
      else void inspect();
    });
    void inspect();
  });
  await copyFile(reportPath, path.join(outputDir, "report.json"));
  if (oldFs) {
    assert.equal(report.ok, false);
    assert.equal(report.failedAt, "hidden-stage-exists");
    assert.match(report.error, /forbidden path.*\.test_28764f\.mp4\.w9t626\.partial/);
    console.log("OLD POLICY: actual Tauri fs IPC refuses the reported hidden staging filename");
  } else {
    assert.equal(report.ok, true, JSON.stringify(report));
    for (const seconds of [0.4, 2]) {
      await copyFile(
        path.join(root, `preview-${seconds}.png`),
        path.join(outputDir, `preview-${seconds}.png`),
      );
    }
    await copyFile(report.export.output, path.join(outputDir, "recording-export.mp4"));
    console.log(
      "FIXED: native Record / Stop & save / Source Monitor / changing WebCodecs pixels / hidden-stage export",
      JSON.stringify(report),
    );
  }
} finally {
  watcher?.close();
  clearTimeout(timer);
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  log.end();
}
