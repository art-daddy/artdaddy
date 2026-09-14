// extract_style (client): acquire the reference reels (local or yt-dlp), re-encode
// each to a compact 360p (audio kept) clip, call the ONE whole-video Gemini pass
// via the thin /ai/style_analyze proxy, then parse + version + write the style into
// the project's `internals/styles/<name>/`. Ports style_extraction/pipeline.py — the
// deterministic cv2 "measure" path is dead code and is NOT part of this flow.
import { callAiProxy, toB64 } from "../api/ai";
import type { ClientToolContext } from "./context";
import { probePath, shortHash } from "./media";
import type { ClientToolRegistry } from "./registry";
import { INTERNAL_DIR, joinPath } from "./store";
import { parseStyleMarkdown, SECTION_DISPLAY_NAMES } from "./styleSchema";

type Result = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MAX_REFERENCES = 5;
const MAX_TOTAL_SECONDS = 3600;
const INLINE_BYTES_LIMIT = 18 * 1024 * 1024;
const ENCODE_HEIGHT = 360;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const nowIso = (): string => new Date().toISOString();

/** fps by total reference length (ports analyze.pick_fps). */
function pickFps(total: number): number {
  if (total <= 300) return 16;
  if (total <= 600) return 8;
  return 4;
}

/** Resolve a reference to a local file: a library ref/path as-is, else yt-dlp it. */
async function acquireRef(ctx: ClientToolContext, ref: string): Promise<string> {
  const abs = await ctx.store.resolveMediaRef(ref);
  if (abs) return abs;
  const out = await ctx.store.prepareArtifact(`style_dl/ref_${shortHash(ref)}.mp4`);
  if (await ctx.store.exists(out)) return out;
  const r = await ctx.runner.run("yt-dlp", [
    "-f",
    "best",
    "-S",
    "res:720",
    "--no-playlist",
    "-o",
    out,
    ref,
  ]);
  if (r.code !== 0 || !(await ctx.store.exists(out))) {
    throw new Error(
      `could not download '${ref}' with yt-dlp. If this is a site yt-dlp can't handle (e.g. Instagram), download the video manually, import_media it, and pass its media id instead.`,
    );
  }
  return out;
}

/** Re-encode to 360p H.264, AUDIO KEPT (ports analyze._encode_for_gemini). */
async function encodeStyleRef(ctx: ClientToolContext, src: string): Promise<string> {
  const out = await ctx.store.prepareArtifact(`style_enc/${shortHash(src)}.style.mp4`);
  if (await ctx.store.exists(out)) return out;
  const r = await ctx.runner.run("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    src,
    "-vf",
    `scale=-2:${ENCODE_HEIGHT}`,
    "-c:v",
    "libx264",
    "-crf",
    "32",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-y",
    out,
  ]);
  if (r.code !== 0 || !(await ctx.store.exists(out))) return src; // fall back to original bytes
  return out;
}

async function probeDuration(ctx: ClientToolContext, path: string): Promise<number> {
  try {
    const p = await probePath(ctx.runner, path);
    return typeof p.duration_s === "number" ? p.duration_s : 0;
  } catch {
    return 0;
  }
}

/** Append a new style version + update meta (ports versioning.create_version). */
async function createVersion(
  ctx: ClientToolContext,
  stylesDir: string,
  name: string,
  body: string,
  references: string[],
  diffSummary: string,
): Promise<number> {
  const dir = joinPath(stylesDir, name);
  const metaP = joinPath(dir, "meta.json");
  let meta: Record<string, unknown> | null = null;
  try {
    if (await ctx.store.exists(metaP))
      meta = JSON.parse(await ctx.store.readText(metaP)) as Record<string, unknown>;
  } catch {
    meta = null;
  }
  if (!meta)
    meta = { name, current_version: 0, created_at: nowIso(), updated_at: nowIso(), versions: [] };
  const version = (Number(meta.current_version) || 0) + 1;
  await ctx.store.writeProjectText(joinPath(dir, "versions", `v${version}.md`), body);
  await ctx.store.writeProjectText(joinPath(dir, "style.md"), body);
  meta.current_version = version;
  meta.updated_at = nowIso();
  const versions = Array.isArray(meta.versions) ? (meta.versions as unknown[]) : [];
  versions.push({
    version,
    origin: "extraction",
    references,
    diff_summary: diffSummary,
    timestamp: nowIso(),
  });
  meta.versions = versions;
  await ctx.store.writeProjectText(metaP, JSON.stringify(meta, null, 2));
  return version;
}

async function extractStyle(
  ctx: ClientToolContext | null,
  args: Record<string, unknown>,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const refs = (Array.isArray(args.references) ? args.references : [])
    .map(String)
    .filter((s) => s.trim());
  const styleName = String(args.style_name ?? "");
  if (!refs.length) return { ok: false, error: "no references provided" };
  if (refs.length > MAX_REFERENCES)
    return { ok: false, error: `too many references (${refs.length}); max ${MAX_REFERENCES}` };
  if (!NAME_RE.test(styleName))
    return { ok: false, error: "style_name must be lowercase a-z0-9 with - or _ (2-64 chars)" };

  const stylesDir = joinPath(ctx.store.projectDir, INTERNAL_DIR, "styles");
  if (
    (await ctx.store.exists(joinPath(stylesDir, styleName))) ||
    (await ctx.store.exists(joinPath(stylesDir, `${styleName}.md`)))
  ) {
    return { ok: false, error: `style '${styleName}' already exists; choose another name` };
  }

  const media: Record<string, { b64: string; ext?: string }> = {};
  const videoKeys: string[] = [];
  const durations: number[] = [];
  let payload = 0;
  for (let i = 0; i < refs.length; i += 1) {
    let local: string;
    try {
      local = await acquireRef(ctx, refs[i]);
    } catch (e) {
      return {
        ok: false,
        error: `reference ${i + 1}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    durations.push(await probeDuration(ctx, local));
    const enc = await encodeStyleRef(ctx, local);
    const bytes = await ctx.store.readBytes(enc);
    payload += bytes.length;
    if (payload > INLINE_BYTES_LIMIT) {
      return {
        ok: false,
        error: `reference payload ${(payload / 1e6).toFixed(1)} MB exceeds the inline transport limit (${(INLINE_BYTES_LIMIT / 1e6).toFixed(0)} MB). Trim references; a GCS-backed long-video path is a planned follow-up.`,
      };
    }
    const key = `v${i}`;
    media[key] = { b64: toB64(bytes), ext: ".mp4" };
    videoKeys.push(key);
  }

  const total = durations.reduce((a, b) => a + b, 0);
  if (total > MAX_TOTAL_SECONDS) {
    return {
      ok: false,
      error: `total reference length ${total.toFixed(0)}s exceeds the 1-hour cap (${MAX_TOTAL_SECONDS}s); use fewer/shorter references`,
    };
  }
  const fps = pickFps(total);

  let dto;
  try {
    dto = await callAiProxy<{
      ok?: boolean;
      error?: string;
      body?: string;
      input_tokens?: number;
      output_tokens?: number;
    }>(
      "style_analyze",
      {
        args: { fps, n: refs.length, videos: videoKeys, durations },
        media,
      },
      ctx.signal,
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const r = dto.result ?? {};
  if (r.ok === false) return { ok: false, error: String(r.error ?? "analyze stage failed") };
  const body = String(r.body ?? "").trim();
  if (!body) return { ok: false, error: "analyze stage produced empty output" };

  const parsed = parseStyleMarkdown(styleName, body);
  const warnings: string[] = [];
  if (parsed.missing_required.length) {
    warnings.push(
      `generated style missing required dimension(s): ${parsed.missing_required.map((c) => SECTION_DISPLAY_NAMES[c]).join(", ")} (consider re-running or editing)`,
    );
  }

  const inTok = Number(r.input_tokens ?? 0);
  const outTok = Number(r.output_tokens ?? 0);
  const payloadMb = round2(payload / 1e6);
  const totalS = round1(total);
  const version = await createVersion(
    ctx,
    stylesDir,
    styleName,
    body,
    refs,
    `extracted from ${refs.length} reference(s) (single Gemini pass)`,
  );
  await ctx.store.writeProjectText(
    joinPath(stylesDir, styleName, "extraction", "analyze.json"),
    JSON.stringify(
      {
        fps,
        n_references: refs.length,
        total_seconds: totalS,
        payload_mb: payloadMb,
        input_tokens: inTok,
        output_tokens: outTok,
        references: refs,
      },
      null,
      2,
    ),
  );

  return {
    ok: true,
    style_name: styleName,
    version,
    style_path: joinPath(stylesDir, styleName, "style.md"),
    references: refs,
    metrics_summary: {
      fps,
      total_seconds: totalS,
      payload_mb: payloadMb,
      dimensions_present: [...parsed.present_required, ...parsed.present_optional],
    },
    draft_preview: body.slice(0, 1200),
    cost: { analyze_input_tokens: inTok, analyze_output_tokens: outTok },
    warnings,
  };
}

export function registerStyleTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("extract_style", (args) => extractStyle(getCtx(), args));
}
