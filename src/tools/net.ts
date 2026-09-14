// Client-side network tools (yt-dlp) — run on the desktop via the Tauri shell.
// Ported from src/akaru/v4/tools/mechanical.py to match the server contracts.
import { stderrExcerpt, type CommandResult, type CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { registerLibraryClip } from "./import";
import { numOrNull, probePath } from "./media";
import type { ClientToolRegistry } from "./registry";

type Result = Record<string, unknown>;

const DESCRIPTION_MAX_CHARS = 2000;
const HEATMAP_TOP_N = 10;

// YouTube tightened its bot-detection, so a single unauthenticated call with the
// default player_client readily trips "Sign in to confirm you're not a bot".
// Mirror the backend (video_clipper.py): rotate the player_client on failure and
// apply the same reliability flags. NO cookies are injected — the desktop makes a
// cookieless call, exactly as the backend does by default.
const YT_PLAYER_CLIENTS = ["default", "web_safari", "ios"] as const;
const YTDLP_COMMON_ARGS = ["--retries", "3", "--fragment-retries", "3", "--sleep-requests", "1.5"];

/** Run yt-dlp, rotating the YouTube player_client (default -> web_safari -> ios)
 *  until one succeeds — this sidesteps most YouTube anti-bot / throttling walls.
 *  The extractor + reliability flags are prepended to `baseArgs` each attempt.
 *  `needStdout` also requires non-empty stdout (info tools); the download tool
 *  passes false and verifies its output file instead. */
async function runYtdlp(
  runner: CommandRunner,
  baseArgs: string[],
  needStdout: boolean,
): Promise<CommandResult> {
  let last: CommandResult = { code: -1, stdout: "", stderr: "" };
  for (const client of YT_PLAYER_CLIENTS) {
    last = await runner.run("yt-dlp", [
      "--extractor-args",
      `youtube:player_client=${client}`,
      ...YTDLP_COMMON_ARGS,
      ...baseArgs,
    ]);
    if (last.code === 0 && (!needStdout || last.stdout.trim().length > 0)) return last;
  }
  return last;
}

function pick<T>(info: Record<string, unknown>, key: string): T | undefined {
  return info[key] as T | undefined;
}

interface Chapter {
  start_time?: number | null;
  end_time?: number | null;
  title?: string | null;
}
interface HeatmapBucket {
  start_time?: number | null;
  end_time?: number | null;
  value?: number | null;
}
interface Thumb {
  url?: string;
  width?: number;
  height?: number;
}
interface Fmt {
  protocol?: string;
  format_id?: string;
}

/** Project a raw yt-dlp info-json onto the curated shape (mirrors _curate_info_json). */
export function curateInfoJson(info: Record<string, unknown>, url: string): Result {
  let desc = pick<string>(info, "description") ?? "";
  const descTruncated = desc.length > DESCRIPTION_MAX_CHARS;
  if (descTruncated) desc = desc.slice(0, DESCRIPTION_MAX_CHARS);

  const rawChapters = pick<Chapter[]>(info, "chapters") ?? [];
  const chapters = rawChapters
    .filter((c) => c.start_time !== null && c.start_time !== undefined)
    .map((c) => ({
      start_s: c.start_time ?? null,
      end_s: c.end_time ?? null,
      title: c.title ?? null,
    }));

  const rawHeatmap = pick<HeatmapBucket[]>(info, "heatmap") ?? [];
  const parsedHeatmap = rawHeatmap
    .filter(
      (h) =>
        h.start_time !== null &&
        h.start_time !== undefined &&
        h.value !== null &&
        h.value !== undefined,
    )
    .map((h) => ({
      start_s: h.start_time as number,
      end_s: h.end_time ?? null,
      value: h.value as number,
    }));
  const heatmapTotalBuckets = parsedHeatmap.length;
  let heatmap = parsedHeatmap;
  if (heatmapTotalBuckets > HEATMAP_TOP_N) {
    heatmap = [...parsedHeatmap]
      .sort((a, b) => b.value - a.value)
      .slice(0, HEATMAP_TOP_N)
      .sort((a, b) => a.start_s - b.start_s);
  }

  let hasStoryboards = false;
  for (const fmt of pick<Fmt[]>(info, "formats") ?? []) {
    const proto = (fmt.protocol ?? "").toLowerCase();
    const fmtId = (fmt.format_id ?? "").toLowerCase();
    if (fmtId.includes("storyboard") || proto === "mhtml" || fmtId.startsWith("sb")) {
      hasStoryboards = true;
      break;
    }
  }

  const rawThumbs = pick<Thumb[]>(info, "thumbnails") ?? [];
  let thumbnailUrl = pick<string>(info, "thumbnail") ?? null;
  if (!thumbnailUrl && rawThumbs.length) {
    const best = rawThumbs.reduce((a, b) =>
      (a.width ?? 0) * (a.height ?? 0) >= (b.width ?? 0) * (b.height ?? 0) ? a : b,
    );
    thumbnailUrl = best.url ?? null;
  }

  const captionsAvailable = Boolean(pick(info, "subtitles") || pick(info, "automatic_captions"));

  return {
    url,
    extractor: pick(info, "extractor_key") ?? pick(info, "extractor") ?? null,
    title: pick(info, "title") ?? null,
    duration_s: pick(info, "duration") ?? null,
    channel: pick(info, "channel") ?? pick(info, "uploader") ?? null,
    uploader: pick(info, "uploader") ?? null,
    upload_date: pick(info, "upload_date") ?? null,
    view_count: pick(info, "view_count") ?? null,
    like_count: pick(info, "like_count") ?? null,
    description: desc,
    description_truncated: descTruncated,
    thumbnail_url: thumbnailUrl,
    chapters,
    heatmap,
    heatmap_total_buckets: heatmapTotalBuckets,
    has_storyboards: hasStoryboards,
    captions_available: captionsAvailable,
    is_live: pick(info, "is_live") ?? null,
    was_live: pick(info, "was_live") ?? null,
  };
}

/** Lean projection for search-result ranking (mirrors _slim_metadata_for_ranking). */
export function slimMetadata(m: Result): Result {
  const desc = (m.description as string | undefined) ?? "";
  const chapters = (m.chapters as unknown[] | undefined) ?? [];
  return {
    duration_s: m.duration_s ?? null,
    channel: m.channel ?? null,
    upload_date: m.upload_date ?? null,
    view_count: m.view_count ?? null,
    like_count: m.like_count ?? null,
    thumbnail_url: m.thumbnail_url ?? null,
    n_chapters: chapters.length,
    n_heatmap_buckets: m.heatmap_total_buckets ?? null,
    has_storyboards: m.has_storyboards ?? null,
    captions_available: m.captions_available ?? null,
    is_live: m.is_live ?? null,
    was_live: m.was_live ?? null,
    description_first_300: desc.slice(0, 300),
  };
}

const metadataCache = new Map<string, Result>();
/** Test hook: reset the process-wide metadata cache. */
export function clearMetadataCache(): void {
  metadataCache.clear();
}

/** Download a video (or a sub-window) via yt-dlp into cache/downloads/ (mirrors download_video). */
export async function downloadVideoTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return { ok: false, error: "client tool runtime not ready" };
  const url = String(args.url ?? "").trim();
  const outputName = String(args.output_name ?? "").trim();
  if (!url) return { ok: false, error: "url is required." };
  if (!outputName) return { ok: false, error: "output_name is required." };
  if (/[\\/]|\.\./.test(outputName)) {
    return { ok: false, error: `invalid output_name ${outputName} (simple filename only).` };
  }
  const withAudio = args.with_audio === true;
  let startS = numOrNull(args.start_s);
  let endS = numOrNull(args.end_s);

  // A degenerate window (one bound, or end <= start) is never intentional:
  // promote to a full download with a note rather than failing.
  let fullVideo = startS === null && endS === null;
  let note = "";
  if (!fullVideo) {
    if (startS === null || endS === null) {
      note =
        "only one of start_s/end_s was provided; downloaded the FULL video. " +
        "Omit BOTH for the whole video, or pass BOTH for a sub-window.";
      fullVideo = true;
      startS = null;
      endS = null;
    } else if (endS <= startS) {
      note =
        "requested window was empty/inverted; downloaded the FULL video instead. " +
        "For a sub-window pass start_s < end_s; omit both for the whole video.";
      fullVideo = true;
      startS = null;
      endS = null;
    }
  }

  const outPath = await ctx.store.prepareArtifact(`downloads/${outputName}`);
  // Cap on yt-dlp's `res` (the LOWER of width/height) so the limit means the same thing
  // in both orientations: `height<=720` is the LONG edge on 9:16 media, so every vertical
  // source quietly came down at 360x640.
  const fmt = withAudio ? "bv*+ba/b" : "bv*/b";
  const cmd = [
    "--js-runtimes",
    "node",
    "-f",
    fmt,
    "-S",
    "res:720,ext:mp4:m4a",
    "--merge-output-format",
    "mp4",
  ];
  if (!fullVideo && startS !== null && endS !== null) {
    cmd.push("--download-sections", `*${startS.toFixed(2)}-${endS.toFixed(2)}`);
  }
  cmd.push("-o", outPath, "--no-playlist", "--no-warnings", "--force-overwrites", url);

  const r = await runYtdlp(ctx.runner, cmd, false);
  const exists = await ctx.store.exists(outPath);
  if (r.code !== 0 || !exists) {
    // A bare "cancelled" reads as "the user stopped it", and nobody had. The only thing that
    // aborts this is the caller's own signal — for an MCP client, its request timeout — and a
    // `--download-sections` seek deep into a long source is exactly what outruns one. Say which
    // it was and what to do instead of leaving a real abort and a timeout indistinguishable.
    const stopped = ctx.signal?.aborted === true || /^cancelled$/i.test((r.stderr ?? "").trim());
    if (stopped)
      return {
        ok: false,
        error:
          !fullVideo && startS !== null
            ? `the download was cancelled before it finished. Seeking to ${startS.toFixed(0)}s in a long source can take longer than the caller allows — ask for a shorter section, or download the whole video once and trim the clip on the timeline.`
            : "the download was cancelled before it finished.",
      };
    return { ok: false, error: stderrExcerpt(r.stderr || r.stdout || "yt-dlp failed", 500) };
  }

  const meta = await probePath(ctx.runner, outPath);
  const okMeta = meta.ok === true;
  const outDur = okMeta ? (meta.duration_s as number | null) : null;
  if (!fullVideo && outDur !== null && startS !== null && endS !== null) {
    const requested = endS - startS;
    if (outDur < Math.min(0.5, requested * 0.25)) {
      return {
        ok: false,
        error:
          `yt-dlp produced a near-empty clip (actual_duration=${outDur.toFixed(2)}s, ` +
          `requested=${requested.toFixed(2)}s). Likely an out-of-bounds section. Try a different window.`,
        video_duration_s: null,
      };
    }
  }

  const vmeta = okMeta ? (meta.video as Result | null) : null;
  // Register the download as a first-class library asset (like import_media) so the
  // model gets a portable media_ref instead of an ad-hoc cache path.
  const entry = await registerLibraryClip(
    ctx.store,
    await ctx.store.readBytes(outPath),
    outputName,
    "video",
    { added_by: "download_video", url },
    undefined,
    { origin: ctx.origin, signal: ctx.signal },
  );
  return {
    ok: true,
    media_ref: entry.id,
    size_bytes: okMeta ? meta.size_bytes : null,
    duration_s: outDur,
    width: vmeta?.width ?? null,
    height: vmeta?.height ?? null,
    fps: vmeta?.fps ?? null,
    has_audio: okMeta ? meta.has_audio : null,
    metadata: okMeta ? meta : null,
    actual_duration_s: outDur,
    video_duration_s: null,
    ...(note ? { note } : {}),
  };
}

/** Fetch + curate a URL's metadata via yt-dlp --dump-single-json (mirrors video_get_metadata). */
export async function videoGetMetadataTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return { ok: false, error: "client tool runtime not ready" };
  const url = String(args.url ?? "").trim();
  if (!url) return { ok: false, error: "url is required." };

  const cached = metadataCache.get(url);
  if (cached) return { ok: true, cached: true, metadata: cached };

  const r = await runYtdlp(
    ctx.runner,
    ["--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", url],
    true,
  );
  if (r.code !== 0 || !r.stdout.trim()) {
    return { ok: false, error: stderrExcerpt(r.stderr || "yt-dlp failed"), url };
  }
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `yt-dlp JSON parse failed: ${String(e)}`, url };
  }
  const curated = curateInfoJson(info, url);
  metadataCache.set(url, curated);
  return { ok: true, cached: false, metadata: curated };
}

interface SearchEntry {
  id?: string;
  url?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
}

/** Search YouTube via yt-dlp ytsearch, optionally enriching each hit (mirrors youtube_search). */
export async function youtubeSearchTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return { ok: false, error: "client tool runtime not ready" };
  const query = String(args.query ?? "").trim();
  if (!query) return { ok: false, error: "query is required." };
  const n = Math.max(1, Math.min(25, Number(args.n ?? 5) || 5));
  const enrich = args.enrich !== false;
  const beatId = args.beat_id ?? null;

  const r = await runYtdlp(
    ctx.runner,
    [
      `ytsearch${n}:${query}`,
      "--dump-single-json",
      "--flat-playlist",
      "--skip-download",
      "--no-warnings",
    ],
    true,
  );
  if (r.code !== 0 || !r.stdout.trim()) {
    return {
      ok: false,
      error: `ytsearch failed: ${stderrExcerpt(r.stderr || "no output", 300)}`,
      query,
    };
  }
  let searchInfo: { entries?: SearchEntry[] };
  try {
    searchInfo = JSON.parse(r.stdout) as { entries?: SearchEntry[] };
  } catch (e) {
    return { ok: false, error: `ytsearch JSON parse failed: ${String(e)}`, query };
  }

  const baseResults: Result[] = [];
  for (const e of searchInfo.entries ?? []) {
    const url = e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null);
    if (!url) continue;
    baseResults.push({
      url,
      title: e.title ?? null,
      channel: e.channel ?? e.uploader ?? null,
      duration_s: e.duration ?? null,
      is_short: false,
    });
  }

  if (baseResults.length === 0) {
    return { ok: true, query, result_count: 0, results: [], enriched: enrich, beat_id: beatId };
  }
  if (!enrich) {
    const results = baseResults.map((br) => ({ ...br, metadata: null, metadata_error: null }));
    return {
      ok: true,
      query,
      result_count: results.length,
      results,
      enriched: false,
      beat_id: beatId,
    };
  }

  const pairs = await Promise.all(
    baseResults.map(async (br) => ({
      url: br.url as string,
      meta: await videoGetMetadataTool({ url: br.url as string }, ctx),
    })),
  );
  const byUrl = new Map(pairs.map((p) => [p.url, p.meta]));
  const results = baseResults.map((br) => {
    const meta = byUrl.get(br.url as string);
    if (meta && meta.ok) {
      return { ...br, metadata: slimMetadata(meta.metadata as Result), metadata_error: null };
    }
    return {
      ...br,
      metadata: null,
      metadata_error: meta ? (meta.error ?? "unknown") : "metadata fetch skipped",
    };
  });
  return {
    ok: true,
    query,
    result_count: results.length,
    results,
    enriched: true,
    beat_id: beatId,
  };
}

export function registerNetTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("download_video", (args) => downloadVideoTool(args, getCtx()));
  registry.register("video_get_metadata", (args) => videoGetMetadataTool(args, getCtx()));
  registry.register("youtube_search", (args) => youtubeSearchTool(args, getCtx()));
}
