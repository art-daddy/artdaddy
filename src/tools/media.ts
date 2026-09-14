// Client-side media tools (run on the desktop via the Tauri shell + fs plugins).
// Ported from src/akaru/v4/tools/mechanical.py to match the server contracts.
import { stderrExcerpt, type CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { registerLibraryClip } from "./import";
import { unresolvedRefError } from "./refState";
import type { ClientToolRegistry } from "./registry";
import { kindOf } from "../media/formats";

type Result = Record<string, unknown>;

/** Media kind from an output filename's extension, or null for a non-media file. */
const mediaKindOf = kindOf;

/** "30/1" -> 30, "30000/1001" -> 29.97, else null (mirrors _parse_fraction). */
export function parseFraction(s: unknown): number | null {
  if (typeof s !== "string" || !s.includes("/")) return null;
  const [a, b] = s.split("/");
  const n = Number(a);
  const d = Number(b);
  if (!d || Number.isNaN(n) || Number.isNaN(d)) return null;
  return n / d;
}

interface FfStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  codec_name?: string;
  pix_fmt?: string;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  nb_frames?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  side_data_list?: Array<Record<string, unknown>>;
  tags?: Record<string, unknown>;
}
interface FfProbe {
  format?: { format_name?: string; duration?: string; size?: string };
  streams?: FfStream[];
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Parse ffprobe JSON into the trimmed contract (mirrors _probe_media_path). */
export function parseProbe(path: string, raw: string): Result {
  let data: FfProbe;
  try {
    data = JSON.parse(raw) as FfProbe;
  } catch (e) {
    return { ok: false, error: `ffprobe JSON parse failed: ${String(e)}` };
  }
  // A corrupted/garbage ffprobe payload can parse to a non-object, carry a
  // non-array `streams`, or hold non-object stream/side-data entries; treat all
  // of that as "no usable metadata" instead of crashing.
  const d = (data !== null && typeof data === "object" ? data : {}) as FfProbe;
  const isObj = (s: unknown): s is Record<string, unknown> => s !== null && typeof s === "object";
  const fmt = d.format ?? {};
  const streams = Array.isArray(d.streams) ? d.streams : [];
  const v = streams.find((s) => isObj(s) && s.codec_type === "video");
  const a = streams.find((s) => isObj(s) && s.codec_type === "audio");

  let video: Result | null = null;
  if (v) {
    let rotation: number | null = null;
    const sideList = Array.isArray(v.side_data_list) ? v.side_data_list : [];
    for (const sd of sideList) {
      if (isObj(sd) && "rotation" in sd) {
        rotation = numOrNull(sd.rotation);
        break;
      }
    }
    if (rotation === null) rotation = numOrNull((v.tags ?? {}).rotate);
    // DISPLAY dimensions, not coded ones. A phone shoots portrait by recording a 1920x1080
    // frame plus a 90° display matrix, and every decoder honours it: ffmpeg auto-rotates
    // (nothing here passes -noautorotate) and so does a <video>. Reporting 1920x1080 told the
    // model the clip was landscape, so on a 9:16 canvas it "corrected" a video that was
    // already upright and the export came out on its side.
    const turned = rotation !== null && Math.abs(Math.round(rotation)) % 180 === 90;
    const cw = numOrNull(v.width);
    const ch = numOrNull(v.height);
    video = {
      width: (turned ? ch : cw) ?? null,
      height: (turned ? cw : ch) ?? null,
      fps: parseFraction(v.r_frame_rate),
      avg_fps: parseFraction(v.avg_frame_rate),
      codec: v.codec_name ?? null,
      pix_fmt: v.pix_fmt ?? null,
      sample_aspect_ratio: v.sample_aspect_ratio ?? null,
      display_aspect_ratio: v.display_aspect_ratio ?? null,
      rotation,
      nb_frames: v.nb_frames ?? null,
    };
  }
  let audio: Result | null = null;
  if (a) {
    audio = {
      codec: a.codec_name ?? null,
      sample_rate: a.sample_rate ?? null,
      channels: a.channels ?? null,
      channel_layout: a.channel_layout ?? null,
    };
  }
  return {
    ok: true,
    path,
    duration_s: numOrNull(fmt.duration),
    format: fmt.format_name ?? null,
    size_bytes: numOrNull(fmt.size),
    n_streams: streams.length,
    has_audio: a !== undefined,
    video,
    audio,
  };
}

export async function probePath(runner: CommandRunner, path: string): Promise<Result> {
  const r = await runner.run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  if (r.code !== 0 || !r.stdout.trim()) {
    return { ok: false, error: stderrExcerpt(r.stderr || "ffprobe produced no output") };
  }
  const res = parseProbe(path, r.stdout);
  // Never expose the absolute system path in probe results (model sees refs only).
  if (res.ok) delete (res as Record<string, unknown>).path;
  return res;
}

export async function probeMediaTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return { ok: false, error: "client tool runtime not ready" };
  const mediaRef = String(args.media_ref ?? "").trim();
  const path = await ctx.store.resolveMediaRef(mediaRef);
  if (!path) {
    return unresolvedRefError(
      ctx.store,
      mediaRef,
      `media not found: ${mediaRef}. Pass a library asset id or filename (not a system path).`,
    );
  }
  return probePath(ctx.runner, path);
}

const PLACEHOLDER = /\{(\w+)\}/g;

export async function runFfmpegTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return { ok: false, error: "client tool runtime not ready" };
  const inputs = args.inputs;
  const rawArgs = args.args;
  const outputName = String(args.output_name ?? "").trim();

  if (!Array.isArray(inputs) || !inputs.every((x) => typeof x === "string")) {
    return { ok: false, error: "inputs must be a list of strings." };
  }
  if (
    !Array.isArray(rawArgs) ||
    rawArgs.length === 0 ||
    !rawArgs.every((x) => typeof x === "string")
  ) {
    return { ok: false, error: "args must be a non-empty list of strings." };
  }
  if (inputs.length > 12) return { ok: false, error: "too many inputs (max 12)." };
  if (!outputName) return { ok: false, error: "output_name is required." };
  if (/[\\/]|\.\./.test(outputName)) {
    return { ok: false, error: `invalid output_name ${outputName} (simple filename only).` };
  }

  const inPaths: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const p = await ctx.store.resolveMediaRef(inputs[i] as string);
    if (!p) {
      return unresolvedRefError(
        ctx.store,
        String(inputs[i]),
        `input ${i} not found: ${String(inputs[i])}. Pass a library asset id or filename (not a system path).`,
      );
    }
    inPaths.push(p);
  }

  const outPath = await ctx.store.prepareArtifact(`ffmpeg/${outputName}`);
  const subs: Record<string, string> = { out: outPath };
  inPaths.forEach((p, i) => {
    subs[`in${i}`] = p;
  });

  const bad: string[] = [];
  const subArgs = (rawArgs as string[]).map((arg) =>
    arg.replace(PLACEHOLDER, (m, k: string) => {
      if (!(k in subs)) {
        bad.push(k);
        return m;
      }
      return subs[k];
    }),
  );
  if (bad.length) {
    return {
      ok: false,
      error: `unknown placeholder(s) ${JSON.stringify([...new Set(bad)].sort())}; available: ${JSON.stringify(Object.keys(subs).sort())}.`,
    };
  }
  if (!(rawArgs as string[]).some((a) => a.includes("{out}"))) {
    return { ok: false, error: "args must reference the output via {out} at least once." };
  }

  const r = await ctx.runner.run("ffmpeg", ["-y", "-nostdin", ...subArgs]);
  const stderrTail = stderrExcerpt(r.stderr);
  const exists = await ctx.store.exists(outPath);
  if (r.code !== 0 || !exists) {
    return {
      ok: false,
      error: `ffmpeg failed (code=${r.code}). Read stderr_tail and fix your args.`,
      stderr_tail: stderrTail,
    };
  }
  const probe = await probePath(ctx.runner, outPath);
  const kind = mediaKindOf(outputName);
  if (kind) {
    // Register the output as a library asset so the model gets a portable refid
    // (media_…) it can place directly — never a cache/system path.
    const entry = await registerLibraryClip(
      ctx.store,
      await ctx.store.readBytes(outPath),
      outputName,
      kind,
      {
        added_by: "run_ffmpeg",
      },
      undefined,
      { origin: ctx.origin, signal: ctx.signal },
    );
    return {
      ok: true,
      media_ref: entry.id,
      filename: entry.filename,
      kind,
      duration_s: probe.ok ? probe.duration_s : null,
      video: probe.ok ? probe.video : null,
      audio: probe.ok ? probe.audio : null,
    };
  }
  // Non-media output (e.g. a text artifact): a project-relative ref, no system path.
  return {
    ok: true,
    output_ref: ctx.store.toRef(outPath),
    duration_s: probe.ok ? probe.duration_s : null,
  };
}

/** Stable 12-hex digest for deterministic artifact filenames (double FNV-1a). */
export function shortHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
}

/** Trim a clip to cache/cuts/ via ffmpeg (mirrors clip_video). */
export async function clipVideoTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return { ok: false, error: "client tool runtime not ready" };
  const inputRef = String(args.media_ref ?? "").trim();
  const startS = numOrNull(args.start_s);
  const endS = numOrNull(args.end_s);
  const outputName = String(args.output_name ?? "").trim();
  const reencode = args.reencode === true;

  if (!inputRef) return { ok: false, error: "media_ref is required." };
  if (startS === null || endS === null) {
    return { ok: false, error: "start_s and end_s are required numbers." };
  }
  if (endS <= startS) return { ok: false, error: "end_s must be > start_s" };
  if (!outputName) return { ok: false, error: "output_name is required." };
  if (/[\\/]|\.\./.test(outputName)) {
    return { ok: false, error: `invalid output_name ${outputName} (simple filename only).` };
  }

  const src = await ctx.store.resolveRef(inputRef);
  if (!src) return unresolvedRefError(ctx.store, inputRef, `input not found: ${inputRef}`);

  const outPath = await ctx.store.prepareArtifact(`cuts/${outputName}`);
  const cmd = ["-y", "-ss", startS.toFixed(3), "-to", endS.toFixed(3), "-i", src];
  if (reencode) cmd.push("-c:v", "libx264", "-preset", "fast", "-c:a", "aac");
  else cmd.push("-c", "copy");
  cmd.push(outPath);

  const r = await ctx.runner.run("ffmpeg", cmd);
  const exists = await ctx.store.exists(outPath);
  if (r.code !== 0 || !exists) {
    return { ok: false, error: stderrExcerpt(r.stderr || r.stdout || "ffmpeg failed", 500) };
  }
  const probe = await probePath(ctx.runner, outPath);
  const entry = await registerLibraryClip(
    ctx.store,
    await ctx.store.readBytes(outPath),
    outputName,
    mediaKindOf(outputName) ?? "video",
    { added_by: "clip_video" },
  );
  return {
    ok: true,
    media_ref: entry.id,
    filename: entry.filename,
    size_bytes: probe.ok ? probe.size_bytes : null,
  };
}

/** Crop an image to cache/crops/ via the ffmpeg crop filter (mirrors crop_image; PIL -> ffmpeg). */
export async function cropImageTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return { ok: false, error: "client tool runtime not ready" };
  const ref = String(args.media_ref ?? "").trim();
  if (!ref) return { ok: false, error: "media_ref is required." };

  const src = await ctx.store.resolveRef(ref);
  if (!src) return unresolvedRefError(ctx.store, ref, `image not found: ${ref}`);

  const bbox = (args.bbox ?? {}) as Record<string, unknown>;
  const bx = numOrNull(bbox.x) ?? 0;
  const by = numOrNull(bbox.y) ?? 0;
  const bw = numOrNull(bbox.w) ?? numOrNull(bbox.width) ?? 0;
  const bh = numOrNull(bbox.h) ?? numOrNull(bbox.height) ?? 0;
  if (bw <= 0 || bh <= 0) return { ok: false, error: "bbox width and height must be positive" };

  const probe = await probePath(ctx.runner, src);
  const v = probe.ok ? (probe.video as Result | null) : null;
  const wImg = v ? numOrNull(v.width) : null;
  const hImg = v ? numOrNull(v.height) : null;
  if (wImg === null || hImg === null) {
    return { ok: false, error: `could not read image dimensions: ${ref}` };
  }

  const x0 = Math.round(Math.max(0, bx));
  const y0 = Math.round(Math.max(0, by));
  const x1 = Math.round(Math.min(wImg, bx + bw));
  const y1 = Math.round(Math.min(hImg, by + bh));
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw <= 0 || ch <= 0) return { ok: false, error: "bbox does not overlap the image" };

  const digest = shortHash(`${src}|${x0},${y0},${x1},${y1}`);
  const outPath = await ctx.store.prepareArtifact(`crops/${digest}.png`);
  const r = await ctx.runner.run("ffmpeg", [
    "-y",
    "-nostdin",
    "-i",
    src,
    "-vf",
    `crop=${cw}:${ch}:${x0}:${y0}`,
    "-frames:v",
    "1",
    outPath,
  ]);
  const exists = await ctx.store.exists(outPath);
  if (r.code !== 0 || !exists) {
    return { ok: false, error: stderrExcerpt(r.stderr || r.stdout || "ffmpeg crop failed", 500) };
  }
  // The crop is a first-class library asset (like clip_video), addressed by a
  // media_ref every other tool accepts — not an ad-hoc artifact id.
  const entry = await registerLibraryClip(
    ctx.store,
    await ctx.store.readBytes(outPath),
    `crop_${digest}.png`,
    "image",
    { added_by: "crop_image" },
  );
  return {
    ok: true,
    media_ref: entry.id,
    filename: entry.filename,
    source_media_ref: ctx.store.toRef(src),
    source_size: { w: wImg, h: hImg },
    bbox: { x: x0, y: y0, w: cw, h: ch },
    size: { w: cw, h: ch },
  };
}

export function registerMediaTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("probe_media", (args) => probeMediaTool(args, getCtx()));
  registry.register("run_ffmpeg", (args) => runFfmpegTool(args, getCtx()));
  registry.register("clip_video", (args) => clipVideoTool(args, getCtx()));
  registry.register("crop_image", (args) => cropImageTool(args, getCtx()));
}
