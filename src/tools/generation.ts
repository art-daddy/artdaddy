// AI generation tools (client): model selection + validation + result persistence
// live here; the thin /ai/generate/* proxies make only the authed provider call.
// list_models has NO external call at all — it's a pure client-side catalog.
import { callAiProxy, fromB64, toB64 } from "../api/ai";
import { RateLimitError } from "../api/http";
import type { ClientToolContext } from "./context";
import {
  audioModelsInfo,
  DEFAULTS,
  GEN_BY_ID,
  IMAGE_IDS,
  IMAGE_MODELS,
  modelInfo,
  VIDEO_IDS,
  VIDEO_MODELS,
  type GenModel,
} from "./genModels";
import { encodeImageForGemini } from "./geminiEncode";
import { submitGeneration } from "./genJobs";
import type { ClientToolRegistry } from "./registry";

type Result = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };

/** Hybrid rate-limit guidance for the model: switch model, or ask the user. */
function rateLimited(id: string, kind: "image" | "video"): Result {
  return {
    ok: false,
    reason: "rate_limited",
    error: `${id} is rate-limited / out of quota right now (429). Do NOT retry the same model — either switch to a DIFFERENT ${kind} model (call list_models for options), or if none is available, tell the user it's rate-limited and to try again shortly.`,
  };
}

function resolveGenModel(id: string, kind: "image" | "video", dflt: string): GenModel | null {
  const m = GEN_BY_ID[(id || dflt).trim()];
  return m && m.kind === kind ? m : null;
}

/** Name the reference image as a suspect when a generation is refused while one is attached.
 *
 *  Veo refuses a photoreal HUMAN likeness used as a reference and blames the PROMPT for it
 *  ("violated usage guidelines … try rephrasing"), which sends the caller rewriting the one
 *  thing that is not at fault — measured over three shots, rewording never helped and dropping
 *  the reference passed first try. We cannot change the provider's text, only stop it being
 *  the whole story. */
function withReferenceHint(error: string, provArgs: Record<string, unknown>): string {
  const refs = provArgs.reference_images;
  const n = Array.isArray(refs) ? refs.length : 0;
  if (!n || !/filter|safety|guideline|violat|blocked|refus/i.test(error)) return error;
  return (
    `${error}\n\nNOTE: ${n} reference image(s) were attached. A refusal that blames the prompt is ` +
    `often the REFERENCE — a photoreal human likeness is refused this way. Before rewriting the ` +
    `prompt again, retry once with reference_images omitted and the character described in words; ` +
    `if that passes, the reference was the cause.`
  );
}

/** List the available AI generation models + capabilities (ports list_models_tool). */
function listModels(args: Record<string, unknown>): Result {
  const kind = String(args.type ?? "")
    .trim()
    .toLowerCase();
  const models: Record<string, unknown>[] = [];
  if (kind === "" || kind === "image") models.push(...IMAGE_MODELS.map(modelInfo));
  if (kind === "" || kind === "video") models.push(...VIDEO_MODELS.map(modelInfo));
  if (kind === "" || kind === "audio") models.push(...audioModelsInfo());
  return {
    ok: true,
    models,
    defaults: {
      image: DEFAULTS.image,
      video: DEFAULTS.video,
      tts: DEFAULTS.tts,
      music: DEFAULTS.music,
    },
  };
}

export function registerGenerationTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("list_models", (args) => listModels(args));
  registry.register("generate_image", (args) => generateImage(getCtx(), args));
  registry.register("generate_video", (args) => generateVideo(getCtx(), args));
}

/** Generate still image(s) (ports generate_image_tool). Client owns catalog +
 *  validation + param mapping + persistence; the server makes the provider call. */
async function generateImage(
  ctx: ClientToolContext | null,
  args: Record<string, unknown>,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) return { ok: false, error: "prompt is required" };
  const m = resolveGenModel(String(args.model ?? ""), "image", DEFAULTS.image);
  if (!m)
    return {
      ok: false,
      error: `unknown image model ${JSON.stringify(args.model)}; call list_models (options: ${IMAGE_IDS.join(", ")})`,
    };
  const count = Math.max(1, Math.min(m.max_images ?? 1, Math.trunc(Number(args.count ?? 1)) || 1));
  const refRefs = (Array.isArray(args.reference_images) ? args.reference_images : [])
    .map(String)
    .filter((s) => s.trim());
  if (refRefs.length && !m.supports_reference_images)
    return { ok: false, error: `${m.id} does not support reference images` };
  let quality = args.quality != null ? String(args.quality) : undefined;
  let resolution = args.resolution != null ? String(args.resolution) : undefined;
  const aspect = String(args.aspect_ratio ?? "9:16");
  if (quality && !m.qualities?.length) quality = undefined;
  else if (quality && !m.qualities?.includes(quality))
    return { ok: false, error: `${m.id} quality must be one of ${JSON.stringify(m.qualities)}` };
  if (resolution && !m.resolutions?.length) resolution = undefined;
  else if (resolution && !m.resolutions?.includes(resolution))
    return {
      ok: false,
      error: `${m.id} resolution must be one of ${JSON.stringify(m.resolutions)}`,
    };
  // parity with established NLEs: default the resolution to the model's first when it HAS a resolution
  // lever and none was given, so the server always sets Gemini's ImageConfig and the
  // requested aspect_ratio is enforced at the API level, not merely as a prompt hint (R11-1).
  if (!resolution && m.resolutions?.length) resolution = m.resolutions[0];
  if (aspect && !m.aspect_ratios.includes(aspect))
    return {
      ok: false,
      error: `${m.id} aspect_ratio must be one of ${JSON.stringify(m.aspect_ratios)}`,
    };

  const media: Record<string, { b64: string; ext?: string }> = {};
  const refKeys: string[] = [];
  for (let i = 0; i < refRefs.length; i += 1) {
    const abs = await ctx.store.resolveMediaRef(refRefs[i]);
    if (!abs) return { ok: false, error: `reference image not found: ${refRefs[i]}` };
    const key = `ref${i}`;
    const enc = await encodeImageForGemini(ctx, abs, { maxDim: 2048, quality: 90, tag: "genref" });
    media[key] = { b64: toB64(await ctx.store.readBytes(enc)), ext: ".jpg" };
    refKeys.push(key);
  }

  const provArgs: Record<string, unknown> = {
    provider: m.provider,
    backend_id: m.backend_id,
    prompt,
    count,
    reference_images: refKeys,
  };
  if (args.seed != null) provArgs.seed = args.seed;
  if (args.negative_prompt != null) provArgs.negative_prompt = String(args.negative_prompt);
  // Send only the validated LEVERS the generation API accepts (aspect_ratio / resolution
  // / quality); the SERVER maps them to each vendor's native pixel size at the call
  // boundary (other NLEs' client/backend split). The client never computes raw pixels.
  provArgs.aspect_ratio = aspect;
  if (resolution) provArgs.resolution = resolution;
  if (quality) provArgs.quality = quality;

  const name = args.name != null ? String(args.name) : undefined;
  const sub = await submitGeneration({
    store: ctx.store,
    tool: "generate_image",
    label: count > 1 ? `${count} images` : "an image",
    mediaKind: "image",
    count,
    filename: (i) => name ?? `generated-${i + 1}.png`,
    source: { origin: "generated", model: m.id, prompt },
    origin: ctx.origin,
    model: m.id,
    // No ctx.signal on purpose: Stop and project-close must not cancel a call already paid for.
    run: async () => {
      let dto;
      try {
        dto = await callAiProxy<{ ok?: boolean; error?: string; reason?: string }>(
          "generate_image",
          {
            args: provArgs,
            media,
          },
        );
      } catch (e) {
        if (e instanceof RateLimitError) throw new Error(String(rateLimited(m.id, "image").error));
        throw e;
      }
      const r = dto.result ?? {};
      if (r.ok === false) {
        if (r.reason === "rate_limited") throw new Error(String(rateLimited(m.id, "image").error));
        throw new Error(String(r.error ?? "image generation failed"));
      }
      const outMedia = dto.media ?? [];
      if (!outMedia.length) throw new Error(`image generation returned no images (model=${m.id})`);
      return outMedia.map((gm) => ({ bytes: fromB64(gm.b64), ext: gm.ext }));
    },
  });
  return {
    ok: true,
    model: m.id,
    status: "generating",
    count,
    assets: sub.media_refs.map((media_ref) => ({ media_ref, kind: "image" })),
  };
}

/** Generate one short video clip (ports generate_video_tool). */
async function generateVideo(
  ctx: ClientToolContext | null,
  args: Record<string, unknown>,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) return { ok: false, error: "prompt is required" };
  const m = resolveGenModel(String(args.model ?? ""), "video", DEFAULTS.video);
  if (!m)
    return {
      ok: false,
      error: `unknown video model ${JSON.stringify(args.model)}; call list_models (options: ${VIDEO_IDS.join(", ")})`,
    };
  let dur = Math.trunc(Number(args.duration ?? 8)) || 8;
  const startFrame = args.start_frame != null ? String(args.start_frame) : "";
  const endFrame = args.end_frame != null ? String(args.end_frame) : "";
  const refRefs = (Array.isArray(args.reference_images) ? args.reference_images : [])
    .map(String)
    .filter((s) => s.trim());
  if (startFrame && !m.supports_start_frame)
    return { ok: false, error: `${m.id} does not support a start frame (image-to-video)` };
  if (endFrame && !m.supports_end_frame)
    return { ok: false, error: `${m.id} does not support an end frame (interpolation)` };
  if (refRefs.length && !m.supports_reference_images)
    return { ok: false, error: `${m.id} does not support reference images` };
  if (endFrame && !startFrame)
    return {
      ok: false,
      error: "end_frame requires start_frame (the clip interpolates start_frame -> end_frame)",
    };
  if (refRefs.length && (startFrame || endFrame))
    return {
      ok: false,
      error: "reference_images is a separate mode; don't combine it with start_frame/end_frame",
    };
  let resolution = args.resolution != null ? String(args.resolution) : undefined;
  if (resolution && !m.resolutions?.length) resolution = undefined;
  else if (resolution && !m.resolutions?.includes(resolution))
    return {
      ok: false,
      error: `${m.id} resolution must be one of ${JSON.stringify(m.resolutions)}`,
    };
  const aspect = String(args.aspect_ratio ?? "9:16");
  if (aspect && !m.aspect_ratios.includes(aspect))
    return {
      ok: false,
      error: `${m.id} aspect_ratio must be one of ${JSON.stringify(m.aspect_ratios)}`,
    };
  if (refRefs.length && dur !== 8) dur = 8; // reference-image mode is 8s only

  const media: Record<string, { b64: string; ext?: string }> = {};
  const addFrame = async (ref: string, key: string): Promise<string> => {
    const abs = await ctx.store.resolveMediaRef(ref);
    if (!abs) throw new Error(`frame not found: ${ref}`);
    const enc = await encodeImageForGemini(ctx, abs, { maxDim: 2048, quality: 90, tag: "genref" });
    media[key] = { b64: toB64(await ctx.store.readBytes(enc)), ext: ".jpg" };
    return key;
  };
  const provArgs: Record<string, unknown> = {
    provider: m.provider,
    backend_id: m.backend_id,
    prompt,
    aspect_ratio: aspect,
    duration: dur,
    generate_audio: args.generate_audio !== false,
  };
  if (resolution) provArgs.resolution = resolution;
  if (args.seed != null) provArgs.seed = args.seed;
  if (args.negative_prompt != null) provArgs.negative_prompt = String(args.negative_prompt);
  try {
    if (startFrame) provArgs.start_frame = await addFrame(startFrame, "start_frame");
    if (endFrame) provArgs.end_frame = await addFrame(endFrame, "end_frame");
    const vkeys: string[] = [];
    for (let i = 0; i < refRefs.length; i += 1) vkeys.push(await addFrame(refRefs[i], `vref${i}`));
    if (vkeys.length) provArgs.reference_images = vkeys;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const name = args.name != null ? String(args.name) : undefined;
  const sub = await submitGeneration({
    store: ctx.store,
    tool: "generate_video",
    label: `a ${dur}s video`,
    mediaKind: "video",
    count: 1,
    filename: () => name ?? "generated.mp4",
    durationS: dur,
    source: { origin: "generated", model: m.id, prompt },
    origin: ctx.origin,
    model: m.id,
    // No ctx.signal on purpose: Stop and project-close must not cancel a call already paid for.
    run: async () => {
      let dto;
      try {
        dto = await callAiProxy<{
          ok?: boolean;
          error?: string;
          reason?: string;
          controls?: unknown;
        }>("generate_video", { args: provArgs, media });
      } catch (e) {
        if (e instanceof RateLimitError) throw new Error(String(rateLimited(m.id, "video").error));
        throw e;
      }
      const r = dto.result ?? {};
      if (r.ok === false) {
        if (r.reason === "rate_limited") throw new Error(String(rateLimited(m.id, "video").error));
        throw new Error(withReferenceHint(String(r.error ?? "video generation failed"), provArgs));
      }
      const outMedia = dto.media ?? [];
      if (!outMedia.length)
        throw new Error(`video generation returned no downloadable file (model=${m.id})`);
      return [{ bytes: fromB64(outMedia[0].b64), ext: outMedia[0].ext }];
    },
  });
  return {
    ok: true,
    model: m.id,
    kind: "video",
    status: "generating",
    media_ref: sub.media_refs[0],
  };
}
