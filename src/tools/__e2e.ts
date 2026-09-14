// Shared harness for the opt-in e2e lane (vitest.smoke.config.ts, `*.e2e.ts`).
// Real child-process CommandRunner + real fs, driving the actual tools against
// real ffmpeg/ffprobe. NOT a test file itself (no `.e2e.ts` suffix), so it is
// imported, never run as a suite. Measurement helpers assert RENDERED output by
// NUMBERS (average RGB / luma via inspect_color, dB via volumedetect) so the
// goldens stay stable across ffmpeg builds instead of pinning exact pixels.
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";

import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { kindOf, type MediaKind } from "../media/formats";
import { inspectColorTool } from "./inspect";
import { registerLibraryClip } from "./import";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import { renderTimelineTool } from "../timeline/render";
import { ProjectDocument } from "../project/ProjectDocument";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { asProjectId } from "../project/types";

type Rec = Record<string, unknown>;

// Since Phase 5.5 every timeline commit requires an OPEN ProjectDocument (openDocumentByDir -> the
// injected resolver). The e2e lane drives the REAL tools against real dirs, so back EVERY project
// dir with a fresh ephemeral open document, keyed (exactly like openDocumentByDir) by the dir's last
// path segment. Install once per e2e file (beforeAll) and clear in afterAll.
const e2eDocs = new Map<string, ProjectDocument>();
const e2eCloseFailures: string[] = [];
function segOf(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";
}
/** Install the leaf resolver as a pure LOOKUP — a document is exposed only AFTER openE2EDoc() has
 *  awaited its real open(), so tools never run against a half-open (still "opening") document. */
export function installE2EDocuments(): void {
  e2eCloseFailures.length = 0;
  setOpenDocumentResolver((id) => e2eDocs.get(String(id)));
}
/** Create + AWAIT-open a ProjectDocument for `dir`, then expose it in the resolver. Idempotent per
 *  dir. Drives the real phase machine (opening -> open) and refuses to expose a failed open. */
export async function openE2EDoc(dir: string): Promise<ProjectDocument> {
  const seg = segOf(dir);
  let doc = e2eDocs.get(seg);
  if (!doc) {
    doc = new ProjectDocument(
      asProjectId(seg),
      { open: async () => "loaded", dispose: async () => {} },
      { onCloseSaveFailed: (id) => e2eCloseFailures.push(String(id)) },
    );
    const outcome = await doc.open();
    if (outcome !== "loaded") throw new Error(`e2e: ProjectDocument.open() failed for ${dir}`);
    e2eDocs.set(seg, doc); // expose ONLY after a successful awaited open
  }
  return doc;
}
/** Land the in-memory autosave for `dir`'s document so a subsequent RAW disk read sees the edits
 *  (edits are in-memory + async-persisted since Phase 5.4). */
export async function flushE2EDoc(dir: string): Promise<void> {
  await e2eDocs.get(segOf(dir))?.autosave.flush();
}
/** Close every open document through the REAL close() transition (drain gate + jobs, flush autosave,
 *  dispose) and SURFACE any failure: a thrown close OR a persistent final-save failure on close fails
 *  the suite instead of being swallowed. */
export async function resetE2EDocuments(): Promise<void> {
  const errors: string[] = [];
  for (const doc of e2eDocs.values()) {
    try {
      await doc.close();
    } catch (e) {
      errors.push(String(e));
    }
  }
  e2eDocs.clear();
  setOpenDocumentResolver(() => undefined);
  const failures = [
    ...errors,
    ...e2eCloseFailures.map((id) => `final save failed on close: ${id}`),
  ];
  e2eCloseFailures.length = 0;
  if (failures.length) throw new Error(`e2e document close failures: ${failures.join("; ")}`);
}

function kindFromExt(name: string): MediaKind {
  return kindOf(name) ?? "video";
}
/** Register an existing on-disk file as an EXTERNAL (link-in-place) library asset and return its
 *  media_ref. Agent tools (add_clips / inspect_*) take library ids, not raw system paths (agent
 *  absolute-path hardening, Round 20), so the harness registers its synthesized files first — the
 *  same content-addressed door the human import flow uses. */
export async function libRef(
  ctx: ClientToolContext,
  absPath: string,
  kind?: MediaKind,
): Promise<string> {
  const bytes = await nodeFs.readBytes!(absPath); // nodeFs defines readBytes concretely (FsLike marks it optional)
  const name = absPath.replace(/\\/g, "/").split("/").pop() || "src";
  const entry = await registerLibraryClip(
    ctx.store,
    bytes,
    name,
    kind ?? kindFromExt(name),
    undefined,
    absPath,
  );
  return entry.id;
}

/** Resolve a bare sidecar name to the bundled binary, as the app's Tauri shell does. Without this
 *  the harness only ever finds tools that happen to be on PATH — ffmpeg usually is, whisper-cli
 *  never is, so the transcription path reported ENOENT and looked like a product failure. */
function sidecar(program: string): string {
  const triple =
    process.platform === "win32"
      ? "x86_64-pc-windows-msvc"
      : process.platform === "darwin"
        ? "aarch64-apple-darwin"
        : "x86_64-unknown-linux-gnu";
  const ext = process.platform === "win32" ? ".exe" : "";
  const p = path.resolve(process.cwd(), "src-tauri/binaries", `${program}-${triple}${ext}`);
  return existsSync(p) ? p : program;
}

export const nodeRunner: CommandRunner = {
  // `cwd` is honoured because runRenderPlan relies on it: the caption .ass files are staged into a
  // scratch dir and referenced by BARE name. A runner that drops it renders every text clip as
  // "ass_read_file: fopen failed", which is a harness lie about a feature that works.
  run(program, args, _signal, cwd): Promise<CommandResult> {
    return new Promise((resolve) => {
      // Mirrors TauriCommandRunner.build: whisper.cpp's Windows build is DYNAMIC, and ggml
      // resolves its CPU backend by scanning the process's own directory, so putting the DLL
      // dir on PATH is NOT enough — the exe loads and then dies on GGML_ASSERT(device). The app
      // runs whisper-cli with that dir as its CWD; a harness that does anything else reports a
      // product failure that does not exist.
      const dllDir = path.resolve(process.cwd(), "src-tauri/resources/whisper");
      const runCwd = program === "whisper-cli" && existsSync(dllDir) ? dllDir : cwd;
      const child = spawn(sidecar(program), args, { cwd: runCwd, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  },
};

export const nodeFs: FsLike = {
  async exists(p) {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  readTextFile: (p) => fsp.readFile(p, "utf8"),
  async writeTextFile(p, c) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, c);
  },
  async readBytes(p) {
    const b = await fsp.readFile(p);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  },
  async writeBytes(p, bytes) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, bytes);
  },
  async rename(src, dst) {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.rename(src, dst);
  },
  async readDir(p) {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  },
  async remove(p) {
    await fsp.rm(p, { recursive: true, force: true });
  },
  async copyFile(src, dst) {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  },
  async mkdir(p) {
    await fsp.mkdir(p, { recursive: true });
  },
};

/** True if a binary answers its version flag (ffmpeg/ffprobe -version). */
export async function have(program: string): Promise<boolean> {
  const flag = program === "yt-dlp" ? "--version" : "-version";
  const r = await nodeRunner.run(program, [flag]);
  return r.code === 0;
}

/** A fresh project context rooted at `dir` (real fs + real runner). */
export function mkCtx(dir: string): ClientToolContext {
  return { store: new ProjectStoreAccess(dir, nodeFs), runner: nodeRunner };
}

/** Run ffmpeg, throwing (with stderr) on a non-zero exit. */
export async function ff(args: string[]): Promise<void> {
  const r = await nodeRunner.run("ffmpeg", args);
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.slice(-800)}`);
}

/** Synthesize a solid-colour clip (optionally carrying a sine tone) at `out`. */
export async function srcSolid(
  out: string,
  o: { color: string; w?: number; h?: number; dur?: number; freq?: number },
): Promise<string> {
  const w = o.w ?? 320;
  const h = o.h ?? 240;
  const dur = o.dur ?? 2;
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${o.color}:size=${w}x${h}:rate=30:duration=${dur}`,
  ];
  if (o.freq) args.push("-f", "lavfi", "-i", `sine=frequency=${o.freq}:duration=${dur}`);
  args.push("-shortest", "-pix_fmt", "yuv420p", out);
  await ff(args);
  return out;
}

/** Synthesize an AUDIO-ONLY sine tone at `out` (e.g. a .wav) for audio-track clips. */
export async function srcTone(out: string, o: { freq: number; dur?: number }): Promise<string> {
  await ff(["-y", "-f", "lavfi", "-i", `sine=frequency=${o.freq}:duration=${o.dur ?? 1}`, out]);
  return out;
}

/** Synthesize a left|right split-colour clip (hstack of two solids) at `out`. */
export async function srcSplit(
  out: string,
  o: { left: string; right: string; w?: number; h?: number; dur?: number },
): Promise<string> {
  const w = o.w ?? 120;
  const h = o.h ?? 120;
  const dur = o.dur ?? 1;
  const hw = Math.round(w / 2);
  await ff([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${o.left}:size=${hw}x${h}:rate=30:duration=${dur}`,
    "-f",
    "lavfi",
    "-i",
    `color=c=${o.right}:size=${w - hw}x${h}:rate=30:duration=${dur}`,
    "-filter_complex",
    "[0][1]hstack",
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
  return out;
}

/** Pull one frame from `src` (a video at `atSec`, or an image) to a PNG at `out`,
 *  optionally through a `vf` filter chain (e.g. a crop to measure one region).
 *  `-ss` is placed AFTER `-i` so the seek is frame-accurate (needed to land on a
 *  precise transition/keyframe frame, not the nearest keyframe). */
export async function framePng(
  src: string,
  out: string,
  o?: { atSec?: number; vf?: string },
): Promise<string> {
  const seek = o?.atSec ? ["-ss", String(o.atSec)] : [];
  const vf = o?.vf ? ["-vf", o.vf] : [];
  await ff(["-y", "-i", src, ...seek, "-frames:v", "1", ...vf, out]);
  return out;
}

export interface Scopes {
  mean: [number, number, number]; // average R,G,B in 0..1
  luma: number; // average luma in 0..1
  saturation: number;
  warmCool: number; // meanR - meanB
  hue: number[]; // 12-bin normalized hue histogram
}

/** Average colour scopes of a PNG via the real inspect_color tool. */
export async function measureColor(ctx: ClientToolContext, pngAbsPath: string): Promise<Scopes> {
  const ref = await libRef(ctx, pngAbsPath, "image"); // inspect_color takes a library ref, not a system path
  const r = (await inspectColorTool({ media_ref: ref }, ctx)) as Rec;
  if (!r.ok) throw new Error(`inspect_color failed: ${JSON.stringify(r)}`);
  const s = r.scopes as Rec;
  return {
    mean: s.mean as [number, number, number],
    luma: s.mean_luma as number,
    saturation: s.saturation as number,
    warmCool: s.warm_cool as number,
    hue: s.hue_histogram as number[],
  };
}

/** Convenience: extract a frame (optionally cropped) and measure its scopes. */
export async function regionScopes(
  ctx: ClientToolContext,
  src: string,
  out: string,
  o?: { atSec?: number; vf?: string },
): Promise<Scopes> {
  await framePng(src, out, o);
  return measureColor(ctx, out);
}

/** mean_volume (dB) over the whole file, or a [ssSec, durSec] window. */
export async function meanVolumeDb(
  mp4: string,
  win?: { ss: number; dur: number },
): Promise<number> {
  const pre = win ? ["-ss", String(win.ss), "-t", String(win.dur)] : [];
  const r = await nodeRunner.run("ffmpeg", [
    ...pre,
    "-i",
    mp4,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const m = r.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  if (!m) throw new Error(`no mean_volume in ffmpeg output: ${r.stderr.slice(-500)}`);
  return Number(m[1]);
}

export interface Probe {
  width: number;
  height: number;
  durationS: number;
  vDurationS: number;
  aDurationS: number;
  hasAudio: boolean;
}

/** ffprobe a media file into {width,height,duration,per-stream durations,hasAudio}. */
export async function probe(file: string): Promise<Probe> {
  const r = await nodeRunner.run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    file,
  ]);
  const j = JSON.parse(r.stdout || "{}") as Rec;
  const streams = (j.streams as Rec[]) ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const fmt = (j.format as Rec) ?? {};
  const dur = Number(fmt.duration) || 0;
  return {
    width: Number(v?.width) || 0,
    height: Number(v?.height) || 0,
    durationS: dur,
    vDurationS: Number(v?.duration) || dur,
    aDurationS: Number(a?.duration) || dur,
    hasAudio: Boolean(a),
  };
}

/** Render the active timeline; return the ABSOLUTE path to the output mp4. */
export async function renderMp4(ctx: ClientToolContext, dir: string): Promise<string> {
  const r = (await renderTimelineTool({}, ctx)) as Rec;
  if (!r.ok) throw new Error(`render failed: ${JSON.stringify(r)}`);
  return joinPath(dir, r.final_mp4 as string); // final_mp4 is project-relative
}
