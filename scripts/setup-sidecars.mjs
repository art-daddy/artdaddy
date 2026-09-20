#!/usr/bin/env node
// Stage the Tauri sidecar binaries into src-tauri/binaries/<name>-<host-triple>.
// For DEV this copies ffmpeg/ffprobe/yt-dlp/whisper-cli from PATH and uses the
// current Node runtime as the browser sidecar (which runs the bundled
// Playwright script). For RELEASE, replace the PATH copies with the real
// per-platform binaries and add playwright + a chromium headless-shell as
// resources. Run: `npm run setup:sidecars`.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const binariesDir = join(here, "..", "src-tauri", "binaries");
const { identity } = JSON.parse(readFileSync(join(here, "..", "src", "brand.json"), "utf8"));
const browserBin = `${identity.sidecarPrefix}-browser`;
const packagedName = (name) => `${identity.sidecarPrefix}-${name}`;

function hostTriple() {
  try {
    const m = execSync("rustc -vV", { encoding: "utf8" }).match(/host:\s*(\S+)/);
    if (m) return m[1];
  } catch {
    /* rustc missing -> fall back to a platform guess */
  }
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

function which(name) {
  try {
    const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
    return (
      execSync(cmd, { encoding: "utf8" })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0] || null
    );
  } catch {
    return null;
  }
}

const triple = hostTriple();
const ext = process.platform === "win32" ? ".exe" : "";
mkdirSync(binariesDir, { recursive: true });

for (const name of ["ffmpeg", "ffprobe", "yt-dlp", "whisper-cli"]) {
  const src = which(name);
  if (!src) {
    console.warn(`[sidecars] SKIP ${name}: not found on PATH (bundle the real binary for release)`);
    continue;
  }
  const dst = join(binariesDir, `${packagedName(name)}-${triple}${ext}`);
  copyFileSync(src, dst);
  console.log(`[sidecars] staged ${name} -> ${dst}`);
}

// whisper-cli is a DYNAMIC build: stage its sibling runtime DLLs (next to the
// PATH exe) as the bundled resource the runner points whisper-cli's cwd at, so
// DEV transcription can actually load. (Release: fetch-sidecars stages these
// from the downloaded zip.)
const whisperSrc = which("whisper-cli");
if (whisperSrc) {
  const whisperResDir = join(here, "..", "src-tauri", "resources", "whisper");
  mkdirSync(whisperResDir, { recursive: true });
  const dlls = readdirSync(dirname(whisperSrc)).filter((n) => /\.dll$/i.test(n));
  for (const n of dlls) copyFileSync(join(dirname(whisperSrc), n), join(whisperResDir, n));
  console.log(`[sidecars] staged ${dlls.length} whisper DLL(s) -> resources/whisper/`);
}

// The browser sidecar = the Node runtime; the Playwright script ships as a resource.
const nodeDst = join(binariesDir, `${browserBin}-${triple}${ext}`);
copyFileSync(process.execPath, nodeDst);
console.log(`[sidecars] staged ${browserBin} (node) -> ${nodeDst}`);
try {
  execSync(`node "${join(here, "build-sidecar.mjs")}"`, { stdio: "inherit" });
} catch (e) {
  console.warn(`[sidecars] ${browserBin} script bundle failed: ${e.message}`);
}

console.log(`[sidecars] done (triple=${triple}).`);
console.log("[sidecars] RELEASE also needs: playwright + a chromium headless-shell as resources,");
console.log("[sidecars]   and real ffmpeg/ffprobe/yt-dlp/whisper-cli binaries for each target.");
