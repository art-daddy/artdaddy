// Vision tools (client): resolve + read the media locally, then make the ONE
// hosted-vision model call via the thin server proxy (/ai/vision_image). The
// image bytes cross the wire; the model credential stays server-side. Ported
// from the server's research.py vision tools (now client-side).
import { callAiProxy, toB64 } from "../api/ai";
import { stderrExcerpt } from "./command";
import type { ClientToolContext } from "./context";
import { probePath, shortHash } from "./media";
import { encodeImageForGemini } from "./geminiEncode";
import { unresolvedRefError } from "./refState";
import type { ClientToolRegistry } from "./registry";

type Result = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };

// Internal vision-model default (was AUTOSHOT_TOOL_VISION_DESCRIBE_MODEL on the
// server). Not user-facing; kept in sync with the server's Gemini availability.
const VISION_DESCRIBE_MODEL = "gemini-3.1-flash-lite";

/** Describe a single still image. Mirrors research.py::vision_describe. */
async function visionDescribe(
  ctx: ClientToolContext | null,
  args: Record<string, unknown>,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const mediaRef = String(args.media_ref ?? "");
  const prompt = String(args.prompt ?? "Describe what you see in this image.");
  const abs = await ctx.store.resolveMediaRef(mediaRef);
  if (!abs) {
    return unresolvedRefError(
      ctx.store,
      mediaRef,
      `image not found: ${mediaRef}. Pass a library asset id or a project-relative artifact ref (not a system path).`,
    );
  }
  const bytes = await ctx.store.readBytes(
    await encodeImageForGemini(ctx, abs, { maxDim: 1536, quality: 85, tag: "vision" }),
  );
  try {
    const dto = await callAiProxy<{ text?: string; ok?: boolean; error?: string }>(
      "vision_image",
      {
        args: {
          model: VISION_DESCRIBE_MODEL,
          system_prompt: "You are a careful visual describer.",
          user_prompt: prompt,
          images: ["img0"],
          response_mime_type: null,
        },
        media: { img0: { b64: toB64(bytes), ext: ".jpg" } },
      },
      ctx.signal,
    );
    const r = dto.result ?? {};
    if (r.ok === false) return { ok: false, error: String(r.error ?? "vision call failed") };
    return { ok: true, description: String(r.text ?? "") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function registerVisionTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("vision_describe", (args) => visionDescribe(getCtx(), args));
  registry.register("image_ask", (args) => imageAsk(getCtx(), args));
  registry.register("find_content", (args) => findContent(getCtx(), args));
}

/** Width x height of an image via ffprobe (0x0 if it can't be probed). */
async function imageDims(ctx: ClientToolContext, path: string): Promise<{ w: number; h: number }> {
  try {
    const p = await probePath(ctx.runner, path);
    const v = (p.video ?? {}) as { width?: number; height?: number };
    return { w: Number(v.width ?? 0), h: Number(v.height ?? 0) };
  } catch {
    return { w: 0, h: 0 };
  }
}

// ── image_ask: free-form Q&A over 1..8 images (research.py::image_ask) ──
const IMAGE_ASK_MODEL = "gemini-3.1-flash-lite";
const IMAGE_ASK_MAX_IMAGES = 8;
const IMAGE_ASK_SYSTEM =
  "You are a careful visual analyst. Respond to queries about the supplied images directly and concisely. If the image does not contain the information needed to answer, say so.";

async function imageAsk(
  ctx: ClientToolContext | null,
  args: Record<string, unknown>,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) return { ok: false, error: "prompt must be a non-empty string" };
  const images = Array.isArray(args.images) ? args.images : [];
  if (!images.length) return { ok: false, error: "images must be a non-empty list" };
  if (images.length > IMAGE_ASK_MAX_IMAGES) {
    return { ok: false, error: `too many images: ${images.length} > ${IMAGE_ASK_MAX_IMAGES}` };
  }

  const media: Record<string, { b64: string; ext?: string }> = {};
  const keys: string[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const spec = images[i] as { media_ref?: string } | null;
    if (!spec || typeof spec !== "object")
      return { ok: false, error: `image[${i}]: must be an object` };
    const ref = String(spec.media_ref ?? "");
    const abs = ref ? await ctx.store.resolveMediaRef(ref) : null;
    if (!abs) return { ok: false, error: `image[${i}]: must supply a media_ref` };
    const key = `img${i}`;
    const enc = await encodeImageForGemini(ctx, abs, { maxDim: 1536, quality: 85, tag: "vision" });
    media[key] = { b64: toB64(await ctx.store.readBytes(enc)), ext: ".jpg" };
    keys.push(key);
  }

  try {
    const dto = await callAiProxy<{ text?: string; ok?: boolean; error?: string }>(
      "vision_image",
      {
        args: {
          model: IMAGE_ASK_MODEL,
          system_prompt: IMAGE_ASK_SYSTEM,
          user_prompt: prompt,
          images: keys,
          response_mime_type: null,
        },
        media,
      },
      ctx.signal,
    );
    const r = dto.result ?? {};
    if (r.ok === false) return { ok: false, error: String(r.error ?? "vision model failed") };
    return {
      ok: true,
      prompt,
      answer: String(r.text ?? "").trim(),
      model: IMAGE_ASK_MODEL,
      n_images: keys.length,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── find_content: vision-locate a region on a screenshot (research.py) ──
// The client does the pre-processing the server's Pillow path used to do —
// downsample toward the vision target width, slice into vertical tiles via
// ffmpeg — then the model call (JSON) is the only server sub-call, and the
// client maps the returned tile-normalized bbox back to original pixels.
const FIND_CONTENT_MODEL = "gemini-3.1-flash-lite";
const FIND_CONTENT_TARGET_WIDTH = 1500;
const M2_MAX_TILES = 8;
const M2_TILE_TARGET_H = 3000;
const M2_SYSTEM = "You return tight bounding boxes for visible regions on screenshots.";

function pickVisionDownsample(width: number): number {
  if (width <= FIND_CONTENT_TARGET_WIDTH) return 1;
  return Math.max(2, Math.round(width / FIND_CONTENT_TARGET_WIDTH));
}

function m2Prompt(nTiles: number, task: string): string {
  return (
    `You will be shown ${nTiles} numbered tiles, sliced vertically from a ` +
    `single full-page web screenshot (tile 1 is the top, tile ${nTiles} is ` +
    `the bottom). Each tile is a contiguous horizontal slice of the same page.\n\n` +
    `TASK: ${task}\n\n` +
    `Return ONLY a JSON object describing the SMALLEST rectangle that fully ` +
    `contains the target region (and nothing extra), plus the contents of that region:\n` +
    `  {"tile": <int, 1-based>, "box_2d": [y_min, x_min, y_max, x_max], ` +
    `"label": "<one short phrase>", "contents": "<verbatim text + bracketed visual notes>"}\n\n` +
    `\`tile\` is the tile number where the target appears (pick the single best tile if the ` +
    `target spans multiple). \`box_2d\` is normalized 0-1000 within THAT tile (top-left = 0,0; ` +
    `bottom-right = 1000,1000; order is [y_min, x_min, y_max, x_max], NOT [x,y,w,h]).\n\n` +
    `CONTENTS rules:\n` +
    `  - Quote every piece of TEXT inside the region VERBATIM, preserving punctuation, casing, ` +
    `and ordering (top to bottom, left to right). Wrap each text run in straight double quotes.\n` +
    `  - For non-text elements inside the region (photos, logos, icons, buttons, charts, video ` +
    `stills), insert a short bracketed description, e.g. [photo: man at podium], [logo: TBPN red], ` +
    `[chart: bar graph], [button: 'Subscribe'].\n` +
    `  - Separate items with a single space; do not invent text that is not visible. Keep contents ` +
    `under ~600 characters.\n\n` +
    `Be tight: include the element, exclude surrounding whitespace and unrelated neighbors. If the ` +
    `target is not present in any tile, return tile=1, box_2d=[0,0,0,0], contents="", label="not ` +
    `found". JSON only, no prose, no markdown.`
  );
}

/** Vertical-slice plan: <= maxTiles tiles of ~targetH height (mirrors _slice_into_tiles). */
function planTiles(dsH: number, maxTiles: number, targetH: number): { y0: number; y1: number }[] {
  const nNatural = Math.max(1, Math.ceil(dsH / targetH));
  let nTiles: number;
  let tileH: number;
  if (nNatural <= maxTiles) {
    nTiles = nNatural;
    tileH = targetH;
  } else {
    nTiles = maxTiles;
    tileH = Math.ceil(dsH / nTiles);
  }
  const offs: { y0: number; y1: number }[] = [];
  for (let i = 0; i < nTiles; i += 1) {
    const y0 = i * tileH;
    const y1 = Math.min(dsH, y0 + tileH);
    if (y0 >= dsH) break;
    offs.push({ y0, y1 });
  }
  return offs;
}

/** Parse {"tile", "box_2d":[y1,x1,y2,x2], "label", "contents"} (mirrors _parse_tile_bbox). */
function parseTileBbox(
  text: string,
): { tile: number; box: number[]; contents: string; label: string } | null {
  if (!text) return null;
  let t = text.trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (Array.isArray(obj)) {
    if (!obj.length) return null;
    obj = obj[0];
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const tile = o.tile;
  const box = (o.box_2d ?? o.bbox ?? o.box) as unknown;
  if (tile == null || !Array.isArray(box) || box.length !== 4) return null;
  const boxN = box.map((x) => Math.round(Number(x)));
  if (boxN.some((n) => Number.isNaN(n))) return null;
  const contents = typeof o.contents === "string" ? o.contents : "";
  const label = typeof o.label === "string" ? o.label.trim().slice(0, 120) : "";
  const tileN = Math.trunc(Number(tile));
  if (Number.isNaN(tileN)) return null;
  return { tile: tileN, box: boxN, contents, label };
}

async function downsamplePng(ctx: ClientToolContext, src: string, factor: number): Promise<string> {
  if (factor <= 1) return src;
  const out = await ctx.store.prepareArtifact(`vision/ds_${shortHash(`${src}|${factor}`)}.png`);
  if (await ctx.store.exists(out)) return out;
  const r = await ctx.runner.run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    src,
    "-vf",
    `scale=iw/${factor}:ih/${factor}:flags=lanczos`,
    out,
  ]);
  if (r.code !== 0 || !(await ctx.store.exists(out))) {
    throw new Error(`downsample failed: ${stderrExcerpt(r.stderr, 200)}`);
  }
  return out;
}

async function cropTile(
  ctx: ClientToolContext,
  src: string,
  w: number,
  h: number,
  y0: number,
  i: number,
): Promise<string> {
  const out = await ctx.store.prepareArtifact(
    `vision/tile_${shortHash(`${src}|${i}|${y0}|${h}`)}.png`,
  );
  if (await ctx.store.exists(out)) return out;
  const r = await ctx.runner.run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    src,
    "-vf",
    `crop=${w}:${h}:0:${y0}`,
    out,
  ]);
  if (r.code !== 0 || !(await ctx.store.exists(out))) {
    throw new Error(`tile crop failed: ${stderrExcerpt(r.stderr, 200)}`);
  }
  return out;
}

async function findContent(
  ctx: ClientToolContext | null,
  args: Record<string, unknown>,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const prompt = String(args.prompt ?? "");
  const mediaRef = args.media_ref != null ? String(args.media_ref) : "";
  if (!mediaRef) return { ok: false, error: "media_ref is required", prompt };
  const abs = await ctx.store.resolveMediaRef(mediaRef);
  if (!abs)
    return {
      ...(await unresolvedRefError(ctx.store, mediaRef, `image not found: ${mediaRef}`)),
      prompt,
    };

  const { w: fullW, h: fullH } = await imageDims(ctx, abs);
  if (!fullW || !fullH)
    return { ok: false, error: `could not read image: ${mediaRef}`, prompt, media_ref: mediaRef };

  const df = pickVisionDownsample(fullW);
  let dsPath = abs;
  let dsW = fullW;
  let dsH = fullH;
  try {
    if (df > 1) {
      dsPath = await downsamplePng(ctx, abs, df);
      const d = await imageDims(ctx, dsPath);
      dsW = d.w || Math.floor(fullW / df);
      dsH = d.h || Math.floor(fullH / df);
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      prompt,
      media_ref: mediaRef,
    };
  }

  const offsets = planTiles(dsH, M2_MAX_TILES, M2_TILE_TARGET_H);
  const media: Record<string, { b64: string; ext?: string }> = {};
  const keys: string[] = [];
  try {
    for (let i = 0; i < offsets.length; i += 1) {
      const { y0, y1 } = offsets[i];
      const tilePath = await cropTile(ctx, dsPath, dsW, y1 - y0, y0, i);
      const key = `tile${i}`;
      media[key] = { b64: toB64(await ctx.store.readBytes(tilePath)), ext: ".png" };
      keys.push(key);
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      prompt,
      media_ref: mediaRef,
    };
  }
  if (!keys.length)
    return { ok: false, error: "tiling produced no tiles", prompt, media_ref: mediaRef };

  let raw = "";
  try {
    const dto = await callAiProxy<{ text?: string; ok?: boolean; error?: string }>(
      "vision_image",
      {
        args: {
          model: FIND_CONTENT_MODEL,
          system_prompt: M2_SYSTEM,
          user_prompt: m2Prompt(keys.length, prompt),
          images: keys,
          response_mime_type: "application/json",
        },
        media,
      },
      ctx.signal,
    );
    const r = dto.result ?? {};
    if (r.ok === false)
      return {
        ok: false,
        error: `vision model failed: ${r.error ?? ""}`,
        prompt,
        media_ref: mediaRef,
      };
    raw = String(r.text ?? "");
  } catch (e) {
    return {
      ok: false,
      error: `vision model failed: ${e instanceof Error ? e.message : String(e)}`,
      prompt,
      media_ref: mediaRef,
    };
  }

  const parsed = parseTileBbox(raw);
  if (!parsed) {
    return {
      ok: false,
      error: "vision model returned no parseable tile/bbox",
      raw_response: raw.slice(0, 300),
      prompt,
      media_ref: mediaRef,
    };
  }
  if (parsed.tile < 1 || parsed.tile > keys.length) {
    return {
      ok: false,
      error: `vision model picked tile=${parsed.tile} but only ${keys.length} tiles exist`,
      raw_response: raw.slice(0, 300),
      prompt,
      media_ref: mediaRef,
    };
  }

  const { y0: tileY0, y1: tileY1 } = offsets[parsed.tile - 1];
  const tileHds = tileY1 - tileY0;
  const [y1n, x1n, y2n, x2n] = parsed.box;
  const xds = (x1n / 1000) * dsW;
  const yds = tileY0 + (y1n / 1000) * tileHds;
  const wds = ((x2n - x1n) / 1000) * dsW;
  const hds = ((y2n - y1n) / 1000) * tileHds;
  const bbox = {
    x: Math.max(0, Math.min(fullW, Math.round(xds * df))),
    y: Math.max(0, Math.min(fullH, Math.round(yds * df))),
    w: Math.max(0, Math.round(wds * df)),
    h: Math.max(0, Math.round(hds * df)),
  };
  return {
    ok: true,
    prompt,
    media_ref: mediaRef,
    bbox,
    label: parsed.label,
    contents: parsed.contents,
    tile: parsed.tile,
    n_tiles: keys.length,
    image_size: { w: fullW, h: fullH },
  };
}
