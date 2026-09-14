// Web research tools (client): web_search / get_page / get_page_image.
// Ports research.py — these need a REAL IP + browser (anti-bot), so they run on
// the desktop client against a bundled Playwright + headless-chromium sidecar,
// invoked via the CommandRunner like ffmpeg/yt-dlp. The
// sidecar prints a small JSON result on stdout; pages/screenshots land in the
// shared project store (screenshots ride the _attachments transport).
import { type Attachment, imageAttachment } from "./attachments";
import { stderrExcerpt } from "./command";
import { encodeImageForGemini } from "./geminiEncode";
import type { ClientToolContext } from "./context";
import { registerLibraryClip } from "./import";
import { shortHash } from "./media";
import type { ClientToolRegistry } from "./registry";
import { BROWSER_BIN } from "./sidecar";

type Result = Record<string, unknown>;
type Args = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };
const HELPER = BROWSER_BIN;

// Viewport presets in SOURCE pixels (mirrors research.py _VIEWPORTS).
const VIEWPORTS: Record<string, [number, number]> = {
  mobile: [1170, 2532],
  tablet: [2304, 3072],
  desktop: [3840, 2400],
  wide: [4320, 2700],
  large_monitor: [5760, 3240],
  ultrawide: [7680, 4320],
};

/** Resolve a viewport name or freeform "{w}x{h}" to a "WxH" string. */
export function resolveViewport(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "desktop";
  if (s in VIEWPORTS) {
    const [w, h] = VIEWPORTS[s];
    return `${w}x${h}`;
  }
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (m) return `${m[1]}x${m[2]}`;
  const [w, h] = VIEWPORTS.desktop;
  return `${w}x${h}`;
}

// CSS breakpoint behind each preset. The contract states `viewport` is in SOURCE
// pixels of the PNG, and every preset above is exactly its CSS size x3 — so we
// render at the CSS size with dsf 3 and the output pixels are unchanged, while
// the site finally sees a real breakpoint (a mobile UA at 1170 CSS px was asking
// for a desktop layout with a phone's identity).
const BREAKPOINTS: Record<string, { css: [number, number]; dsf: number; mobile: boolean }> = {
  mobile: { css: [390, 844], dsf: 3, mobile: true },
  tablet: { css: [768, 1024], dsf: 3, mobile: true },
  desktop: { css: [1280, 800], dsf: 3, mobile: false },
  wide: { css: [1440, 900], dsf: 3, mobile: false },
  large_monitor: { css: [1920, 1080], dsf: 3, mobile: false },
  ultrawide: { css: [2560, 1440], dsf: 3, mobile: false },
};

export interface RenderProfile {
  viewport: string;
  dsf: number;
  mobile: boolean;
}

/** CSS viewport + device pixel ratio + device class for a viewport request.
 *  Freeform "{w}x{h}" stays dsf 1 desktop: the size is the caller's literal
 *  pixel demand and we can't infer a device class from it. */
export function resolveRenderProfile(v: unknown): RenderProfile {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "desktop";
  const preset = BREAKPOINTS[s] ?? (/^\d+x\d+$/.test(s) ? null : BREAKPOINTS.desktop);
  if (preset) {
    return {
      viewport: `${preset.css[0]}x${preset.css[1]}`,
      dsf: preset.dsf,
      mobile: preset.mobile,
    };
  }
  const m = /^(\d+)x(\d+)$/.exec(s) as RegExpExecArray;
  return { viewport: `${m[1]}x${m[2]}`, dsf: 1, mobile: false };
}

/** Invoke the browser sidecar and parse its JSON result. Throws on failure. */
async function runBrowser(ctx: ClientToolContext, args: string[]): Promise<Result> {
  const r = await ctx.runner.run(HELPER, args);
  if (r.code !== 0) {
    // The helper often writes its real diagnostic (e.g. a missing Chromium) to
    // stdout as JSON, so include both streams rather than an opaque bare code.
    const detail = stderrExcerpt(r.stderr || r.stdout || "no output from browser helper");
    throw new Error(`browser helper failed (code=${r.code}): ${detail}`);
  }
  const out = (r.stdout || "").trim();
  if (!out) throw new Error("browser helper produced no output");
  let data: Result;
  try {
    data = JSON.parse(out) as Result;
  } catch {
    throw new Error(`browser helper returned invalid JSON: ${out.slice(0, 200)}`);
  }
  // A block is a structured, actionable outcome the caller must be able to tell
  // apart from a generic helper error — don't flatten it into a bare Error.
  if (data.blocked) return data;
  if (data.ok === false) throw new Error(String(data.error || "browser helper error"));
  return data;
}

/** Bare hostname for a `site:` filter. Tolerates a model passing a full URL or
 *  an already-prefixed "site:x.com", since both are common. */
function normalizeSite(v: unknown): string {
  let s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  s = s.replace(/^site:/i, "").trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.split("/")[0].split("?")[0].trim();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s) ? s.toLowerCase() : "";
}

export async function webSearchTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  const raw = typeof args.query === "string" ? args.query.trim() : "";
  if (!raw) return { ok: false, error: "query is required" };
  const n = typeof args.n === "number" ? Math.max(1, Math.trunc(args.n)) : 5;
  const site = normalizeSite(args.site);
  // Echo the composed query so the model sees exactly what was searched.
  const query = site && !/\bsite:/i.test(raw) ? `site:${site} ${raw}` : raw;
  let data: Result;
  try {
    data = await runBrowser(ctx, ["search", "--query", query, "--n", String(n)]);
  } catch (e) {
    return { ok: false, query, error: `web_search failed: ${String(e)}` };
  }
  // An anti-bot challenge is a TOOL failure. Reporting it as "no results" had the
  // model retry four different queries into the same wall, then answer from
  // memory without ever saying the search was broken.
  if (data.blocked) {
    return {
      ok: false,
      query,
      blocked: true,
      error: String(data.error ?? "search engine blocked the request"),
    };
  }
  const results = Array.isArray(data.results) ? (data.results as Result[]).slice(0, n) : [];
  if (!results.length) return { ok: false, query, error: "no results from the browser helper" };
  return {
    ok: true,
    query,
    engine: data.engine ?? "browser",
    result_count: results.length,
    results,
  };
}

export async function getPageTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) return { ok: false, error: "url is required" };
  const viewport = resolveViewport(args.viewport);
  const force = args.force_refresh === true;
  const out = await ctx.store.prepareArtifact(
    `research/page_${shortHash(`${url}|${viewport}`)}.html`,
  );

  if (!force && (await ctx.store.exists(out))) {
    const cachedHtml = await ctx.store.readText(out);
    return { ok: true, url, html_artifact_id: out, html_chars: cachedHtml.length, cached: true };
  }
  let data: Result;
  try {
    const p = resolveRenderProfile(args.viewport);
    data = await runBrowser(ctx, [
      "page",
      "--url",
      url,
      "--viewport",
      p.viewport,
      "--dsf",
      String(p.dsf),
      "--mobile",
      p.mobile ? "1" : "0",
    ]);
  } catch (e) {
    return { ok: false, error: `get_page failed: ${String(e)}` };
  }
  const html = typeof data.html === "string" ? data.html : "";
  await ctx.store.writeText(out, html);
  return {
    ok: true,
    url,
    final_url: data.final_url ?? url,
    title: data.title ?? null,
    html_artifact_id: out,
    html_chars: html.length,
    cached: false,
  };
}

export async function getPageImageTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) return { ok: false, error: "url is required" };
  const viewport = resolveViewport(args.viewport);
  const force = args.force_refresh === true;
  const out = await ctx.store.prepareArtifact(
    `research/shot_${shortHash(`${url}|${viewport}`)}.png`,
  );

  const cached = !force && (await ctx.store.exists(out));
  let clippedFrom = 0;
  if (!cached) {
    try {
      const p = resolveRenderProfile(args.viewport);
      const shot = await runBrowser(ctx, [
        "shot",
        "--url",
        url,
        "--viewport",
        p.viewport,
        "--dsf",
        String(p.dsf),
        "--mobile",
        p.mobile ? "1" : "0",
        "--out",
        out,
      ]);
      clippedFrom = Number(shot.truncated_height) || 0;
    } catch (e) {
      return { ok: false, error: `get_page_image failed: ${String(e)}` };
    }
    if (!(await ctx.store.exists(out))) return { ok: false, error: "screenshot was not produced" };
  }
  const attachments: Attachment[] = [
    imageAttachment(
      await encodeImageForGemini(ctx, out, { tag: "research" }),
      `get_page_image ${url}`,
    ),
  ];
  // Hand back a LIBRARY REF, never the cache path. The screenshot is ours, but the
  // model has no way to address a bare artifact: `image_path` used to return the
  // project-RELATIVE form, which import_media rejects (it resolves only absolutes) —
  // so the one obvious next step, putting the shot on the timeline, was impossible.
  // registerLibraryClip is content-addressed, so re-shooting a page reuses the id.
  let mediaRef: string | null = null;
  let refError: string | undefined;
  try {
    const bytes = await ctx.store.readBytes(out);
    const entry = await registerLibraryClip(
      ctx.store,
      bytes,
      `screenshot_${shortHash(`${url}|${viewport}`)}.png`,
      "image",
      { tool: "get_page_image", url },
      undefined,
      { origin: ctx.origin, signal: ctx.signal },
    );
    mediaRef = entry.id;
  } catch (e) {
    // Named, not swallowed: the shot is still attached for reading, but the model must
    // know placement is unavailable rather than see a silent null.
    refError = `screenshot not added to the library: ${String(e)}`;
  }
  return {
    ok: true,
    url,
    viewport,
    media_ref: mediaRef,
    ...(refError ? { media_ref_error: refError } : {}),
    ...(clippedFrom
      ? { note: `the page is ${clippedFrom}px tall; this capture is the top portion only` }
      : {}),
    cached,
    _attachments: attachments,
  };
}

export function registerWebTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("web_search", (a) => webSearchTool(a, getCtx()));
  registry.register("get_page", (a) => getPageTool(a, getCtx()));
  registry.register("get_page_image", (a) => getPageImageTool(a, getCtx()));
}
