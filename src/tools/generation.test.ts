import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { registerGenerationTools } from "./generation";
import { AUDIO_MODELS, IMAGE_IDS, VIDEO_IDS } from "./genModels";
import { ClientToolRegistry } from "./registry";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";

// generation.ts leans on three side-effects: the hosted /ai/generate/* proxy
// call, the local image pre-encode (reference frames), and library persistence.
// Mock all three so no network / ffmpeg / real content-hash fs write runs.
// toB64/fromB64 are stubbed so the (mocked-away) encoded bytes never have to be
// real; registerLibraryClip returns a fixed library entry so assets are stable.
vi.mock("../api/ai", () => ({
  callAiProxy: vi.fn(),
  toB64: () => "b64data",
  fromB64: () => new Uint8Array([1, 2, 3]),
}));
vi.mock("./geminiEncode", () => ({
  encodeImageForGemini: vi.fn(),
}));
// generate_* now SUBMITS: it publishes placeholders and fires the paid call detached. The mock
// still invokes run() so every assertion about what reaches the proxy keeps its teeth, and
// swallows a throw the way the real background settle does.
vi.mock("./genJobs", () => ({
  submitGeneration: vi.fn(),
}));

import { callAiProxy } from "../api/ai";
import { encodeImageForGemini } from "./geminiEncode";
import { submitGeneration } from "./genJobs";

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  touch(p: string): void {
    this.files.set(joinPath(p), "");
  }
  set(p: string, c: string): void {
    this.files.set(joinPath(p), c);
  }
  putBytes(p: string, b: Uint8Array): void {
    this.bytes.set(joinPath(p), b);
  }
  async exists(p: string): Promise<boolean> {
    const n = joinPath(p);
    return this.files.has(n) || this.bytes.has(n);
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const n = joinPath(p);
    const b = this.bytes.get(n);
    if (b !== undefined) return b;
    const t = this.files.get(n);
    if (t !== undefined) return new TextEncoder().encode(t);
    throw new Error("ENOENT");
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async mkdir(): Promise<void> {}
}

const DIR = "C:/proj";
// The path the mocked encodeImageForGemini "returns"; ctxWith seeds its bytes so
// the real ProjectStoreAccess.readBytes call in the tools never throws ENOENT.
const ENCODED = joinPath(DIR, "internals/cache/vision/enc.jpg");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// A runner that never shells out (encode is mocked; generation never probes).
function noopRunner(): CommandRunner {
  return { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) };
}
function ctxWith(fs: MockFs = new MockFs()): ClientToolContext {
  fs.putBytes(ENCODED, new Uint8Array([1, 2, 3]));
  return { store: new ProjectStoreAccess(DIR, fs), runner: noopRunner() };
}
// A context whose project holds the given resolvable reference stills.
function ctxWithFiles(...names: string[]): ClientToolContext {
  const fs = new MockFs();
  for (const n of names) fs.touch(joinPath(DIR, n));
  return ctxWith(fs);
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Any> {
  const reg = new ClientToolRegistry();
  registerGenerationTools(reg, () => ctx);
  return (await reg.run(name, args)) as Any;
}

const proxy = vi.mocked(callAiProxy);
const encode = vi.mocked(encodeImageForGemini);
const submit = vi.mocked(submitGeneration);

/** The error a submitted job settled with, or null when it succeeded. */
let jobError: string | null = null;

// Resolve the proxy with a full {result, media?} DTO envelope.
function proxyDto(dto: Record<string, unknown>): void {
  proxy.mockResolvedValue(dto as Any);
}
// The (name, body) of the most recent proxy call.
function lastCall(): { name: string; body: Any } {
  const c = proxy.mock.calls[proxy.mock.calls.length - 1];
  return { name: c[0] as string, body: c[1] as Any };
}
// Resolve the proxy with a successful video DTO (1 downloadable file).
function videoOk(result: Record<string, unknown> = {}): void {
  proxyDto({ result: { ok: true, ...result }, media: [{ b64: "b", ext: ".mp4", kind: "video" }] });
}

beforeEach(() => {
  encode.mockReset().mockResolvedValue(ENCODED);
  jobError = null;
  submit.mockReset().mockImplementation(async (spec: Any) => {
    // Run the paid call exactly as the real settle does, and swallow its failure the same way:
    // the TOOL has already succeeded by returning a placeholder, so a provider error surfaces
    // later as a job failure, not as this call's result.
    try {
      await spec.run();
    } catch (e) {
      jobError = e instanceof Error ? e.message : String(e);
    }
    return {
      media_refs: Array.from({ length: spec.count as number }, (_, i) => `media_gen_${i}`),
      job_id: "job_1",
    };
  });
  proxy.mockReset();
  // Default: a successful single-image generation (overridden per-test as needed).
  proxyDto({ result: { ok: true }, media: [{ b64: "b", ext: ".png", kind: "image" }] });
});

// ── registration ────────────────────────────────────────────────────────────
describe("registerGenerationTools", () => {
  it("registers exactly list_models + generate_image + generate_video", () => {
    const reg = new ClientToolRegistry();
    registerGenerationTools(reg, () => null);
    expect(reg.names().sort()).toEqual(["generate_image", "generate_video", "list_models"]);
  });
});

// ── list_models ─────────────────────────────────────────────────────────────
describe("list_models", () => {
  it("returns image + video + audio models and the defaults when no type is given", async () => {
    const r = await runTool("list_models", {}, null);
    expect(r.ok).toBe(true);
    const kinds = new Set((r.models as Any[]).map((m) => m.kind));
    expect(kinds).toEqual(new Set(["image", "video", "audio"]));
    expect(r.defaults).toEqual({
      image: "nano-banana-pro",
      video: "veo-3.1-fast",
      tts: "gemini-tts-flash",
      music: "lyria",
    });
    expect(proxy).not.toHaveBeenCalled();
  });

  it("filters to image models when type=image", async () => {
    const r = await runTool("list_models", { type: "image" }, null);
    expect((r.models as Any[]).every((m) => m.kind === "image")).toBe(true);
    // Derived from the catalog: adding a model shouldn't need this test edited.
    expect((r.models as Any[]).map((m) => m.id)).toEqual(IMAGE_IDS);
  });

  it("filters to video models when type=video", async () => {
    const r = await runTool("list_models", { type: "video" }, null);
    expect((r.models as Any[]).every((m) => m.kind === "video")).toBe(true);
    expect((r.models as Any[]).map((m) => m.id)).toEqual(VIDEO_IDS);
  });

  it("filters to audio models when type=audio (upper-cased + padded input)", async () => {
    const r = await runTool("list_models", { type: "  AUDIO  " }, null);
    expect((r.models as Any[]).every((m) => m.kind === "audio")).toBe(true);
    // Derived from the catalog, not a hand-kept number: the point of this case is that the
    // FILTER is right, and a literal count only re-fails every time a model is added.
    expect((r.models as Any[]).length).toBe(AUDIO_MODELS.length);
    expect((r.models as Any[]).length).toBeGreaterThan(0);
  });
});

// ── generate_image: guards & validation ─────────────────────────────────────
describe("generate_image — guards & validation", () => {
  it("returns NOT_READY when the runtime context is null", async () => {
    const r = await runTool("generate_image", { prompt: "a cat" }, null);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("runtime not ready");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("rejects a missing prompt", async () => {
    const r = await runTool("generate_image", {}, ctxWith());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("prompt is required");
  });

  it("rejects a whitespace-only prompt", async () => {
    const r = await runTool("generate_image", { prompt: "   " }, ctxWith());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("prompt is required");
  });

  it("rejects an unknown image model and lists the options", async () => {
    const r = await runTool("generate_image", { prompt: "x", model: "made-up" }, ctxWith());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown image model");
    expect(String(r.error)).toContain("nano-banana");
  });

  it("rejects a video model id for an image request (wrong kind)", async () => {
    const r = await runTool("generate_image", { prompt: "x", model: "veo-3.1" }, ctxWith());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown image model");
  });

  it("rejects an invalid quality for a model that declares qualities", async () => {
    const r = await runTool(
      "generate_image",
      { prompt: "x", model: "gpt-image-1.5", quality: "ultra" },
      ctxWith(),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("quality must be one of");
  });

  it("rejects an invalid resolution for a model that declares resolutions", async () => {
    const r = await runTool(
      "generate_image",
      { prompt: "x", model: "nano-banana-pro", resolution: "8K" },
      ctxWith(),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("resolution must be one of");
  });

  it("rejects an aspect ratio the model does not support", async () => {
    const r = await runTool(
      "generate_image",
      { prompt: "x", model: "nano-banana", aspect_ratio: "21:9" },
      ctxWith(),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("aspect_ratio must be one of");
  });

  it("errors when a reference image cannot be resolved", async () => {
    const r = await runTool(
      "generate_image",
      { prompt: "x", model: "nano-banana", reference_images: ["nope.png"] },
      ctxWith(),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("reference image not found: nope.png");
  });
});

// ── generate_image: model + param resolution ────────────────────────────────
describe("generate_image — model & param resolution", () => {
  it("uses the default model (nano-banana-pro / gemini) and 9:16 aspect", async () => {
    const r = await runTool("generate_image", { prompt: "a cat" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(r.model).toBe("nano-banana-pro");
    const { name, body } = lastCall();
    expect(name).toBe("generate_image");
    expect(body.args.provider).toBe("gemini");
    expect(body.args.backend_id).toBe("gemini-3-pro-image");
    expect(body.args.aspect_ratio).toBe("9:16");
    expect(body.args.count).toBe(1);
    expect(body.args.resolution).toBe("1K"); // defaulted to the model's first so the server enforces aspect (R11-1)
  });

  it("passes a valid gemini resolution through as a resolution lever", async () => {
    await runTool(
      "generate_image",
      { prompt: "x", model: "nano-banana-pro", resolution: "2K" },
      ctxWith(),
    );
    expect(lastCall().body.args.resolution).toBe("2K");
    expect(lastCall().body.args.size).toBeUndefined(); // client never sends raw pixels
  });

  it("silently drops a resolution on a model with none (gemini nano-banana)", async () => {
    const r = await runTool(
      "generate_image",
      { prompt: "x", model: "nano-banana", resolution: "2K" },
      ctxWith(),
    );
    expect(r.ok).toBe(true);
    expect(lastCall().body.args.resolution).toBeUndefined();
  });

  it("silently drops a quality on a model with none (gemini)", async () => {
    const r = await runTool(
      "generate_image",
      { prompt: "x", model: "nano-banana", quality: "high" },
      ctxWith(),
    );
    expect(r.ok).toBe(true);
    expect(lastCall().body.args.quality).toBeUndefined();
  });

  it("sends gpt-image-1.5 the levers (aspect_ratio + quality), never a pixel size", async () => {
    await runTool(
      "generate_image",
      { prompt: "x", model: "gpt-image-1.5", quality: "high" },
      ctxWith(),
    );
    const { body } = lastCall();
    expect(body.args.provider).toBe("gpt-image");
    expect(body.args.aspect_ratio).toBe("9:16");
    expect(body.args.quality).toBe("high");
    expect(body.args.size).toBeUndefined();
  });

  it("sends gpt-image-2 the resolution lever, never a pixel size", async () => {
    await runTool(
      "generate_image",
      { prompt: "x", model: "gpt-image-2", aspect_ratio: "16:9", resolution: "4K" },
      ctxWith(),
    );
    const { body } = lastCall();
    expect(body.args.aspect_ratio).toBe("16:9");
    expect(body.args.resolution).toBe("4K");
    expect(body.args.size).toBeUndefined();
  });

  it("defaults gpt-image-2's resolution to the model's first + sends no pixel size (R11-1)", async () => {
    await runTool("generate_image", { prompt: "x", model: "gpt-image-2" }, ctxWith());
    const { body } = lastCall();
    expect(body.args.aspect_ratio).toBe("9:16");
    expect(body.args.resolution).toBe("1K"); // parity with established NLEs: default so the server maps a concrete size
    expect(body.args.size).toBeUndefined(); // no client-derived pixel size -> server maps aspect+resolution
  });

  it("sends a mai model only the aspect_ratio lever, never width/height", async () => {
    await runTool(
      "generate_image",
      { prompt: "x", model: "mai-image-2.5", aspect_ratio: "16:9" },
      ctxWith(),
    );
    const { body } = lastCall();
    expect(body.args.aspect_ratio).toBe("16:9");
    expect(body.args.width).toBeUndefined();
    expect(body.args.height).toBeUndefined();
  });

  it("clamps count to the model's max_images and forwards seed + negative_prompt", async () => {
    await runTool(
      "generate_image",
      { prompt: "x", model: "nano-banana", count: 10, seed: 42, negative_prompt: "blurry" },
      ctxWith(),
    );
    const { body } = lastCall();
    expect(body.args.count).toBe(4);
    expect(body.args.seed).toBe(42);
    expect(body.args.negative_prompt).toBe("blurry");
  });

  it("floors count=0 back up to 1", async () => {
    await runTool("generate_image", { prompt: "x", model: "nano-banana", count: 0 }, ctxWith());
    expect(lastCall().body.args.count).toBe(1);
  });

  it("encodes a resolvable reference image and forwards it as a media key", async () => {
    const r = await runTool(
      "generate_image",
      { prompt: "x", model: "nano-banana", reference_images: ["ref.png"] },
      ctxWithFiles("ref.png"),
    );
    expect(r.ok).toBe(true);
    expect(encode).toHaveBeenCalledTimes(1);
    const { body } = lastCall();
    expect(body.args.reference_images).toEqual(["ref0"]);
    expect(body.media.ref0).toEqual({ b64: "b64data", ext: ".jpg" });
  });
});

// ── generate_image: submission & proxy responses ────────────────────────────
describe("generate_image — submission & proxy responses", () => {
  const spec = (): Any => submit.mock.calls[0][0] as Any;

  it("hands back a placeholder per image instead of waiting for the call", async () => {
    proxyDto({ result: { ok: true }, media: [{ b64: "b", ext: ".png", kind: "image" }] });
    const r = await runTool("generate_image", { prompt: "x", model: "nano-banana" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(r.model).toBe("nano-banana");
    expect(r.status).toBe("generating");
    expect(r.count).toBe(1);
    expect(r.assets).toEqual([{ media_ref: "media_gen_0", kind: "image" }]);
    expect(spec().tool).toBe("generate_image");
    expect(spec().mediaKind).toBe("image");
  });

  it("uses an explicit name when supplied", async () => {
    await runTool("generate_image", { prompt: "x", model: "nano-banana", name: "hero" }, ctxWith());
    expect(spec().filename(0)).toBe("hero");
  });

  // The name is chosen BEFORE the call, so it cannot depend on what came back.
  it("names the placeholder without consulting the provider's response", async () => {
    proxyDto({ result: { ok: true }, media: [{ b64: "b" }] });
    await runTool("generate_image", { prompt: "x", model: "nano-banana" }, ctxWith());
    expect(spec().filename(0)).toBe("generated-1.png");
  });

  it("asks for one placeholder per requested image", async () => {
    proxyDto({
      result: { ok: true },
      media: [
        { b64: "a", ext: ".png" },
        { b64: "b", ext: ".jpg" },
      ],
    });
    const r = await runTool(
      "generate_image",
      { prompt: "x", model: "nano-banana", count: 2 },
      ctxWith(),
    );
    expect(r.count).toBe(2);
    expect((r.assets as Any[]).length).toBe(2);
    expect(spec().count).toBe(2);
    expect(spec().filename(1)).toBe("generated-2.png");
  });

  it("treats a missing result envelope as success (dto.result ?? {})", async () => {
    proxyDto({ media: [{ b64: "b", ext: ".png" }] });
    const r = await runTool("generate_image", { prompt: "x", model: "nano-banana" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(jobError).toBeNull();
  });

  // Every case below used to fail the CALL. Now the call has already succeeded by handing back a
  // placeholder, so the reason has to reach the JOB instead -- if it did not, the failure would
  // be invisible to everyone.
  it("fails the job on a rate-limit, with the switch-model hint", async () => {
    proxyDto({ result: { ok: false, reason: "rate_limited" } });
    const r = await runTool("generate_image", { prompt: "x", model: "nano-banana" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(String(jobError)).toContain("rate-limited");
    expect(String(jobError)).toContain("DIFFERENT image model");
  });

  it("fails the job with the model-side error", async () => {
    proxyDto({ result: { ok: false, error: "provider down" } });
    const r = await runTool("generate_image", { prompt: "x", model: "nano-banana" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(jobError).toBe("provider down");
  });

  it("fails the job with a default message when the model gives none", async () => {
    proxyDto({ result: { ok: false } });
    await runTool("generate_image", { prompt: "x", model: "nano-banana" }, ctxWith());
    expect(jobError).toBe("image generation failed");
  });

  it("fails the job when the proxy returns no images", async () => {
    proxyDto({ result: { ok: true }, media: [] });
    await runTool("generate_image", { prompt: "x", model: "nano-banana" }, ctxWith());
    expect(String(jobError)).toContain("returned no images");
  });

  it("fails the job when the proxy omits media entirely (dto.media ?? [])", async () => {
    proxyDto({ result: { ok: true } });
    await runTool("generate_image", { prompt: "x", model: "nano-banana" }, ctxWith());
    expect(String(jobError)).toContain("returned no images");
  });

  it("fails the job on a proxy transport failure (Error)", async () => {
    proxy.mockRejectedValue(new Error("net down"));
    const r = await runTool("generate_image", { prompt: "x", model: "nano-banana" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(jobError).toBe("net down");
  });

  it("fails the job on a proxy transport failure (non-Error)", async () => {
    proxy.mockRejectedValue("boom");
    const r = await runTool("generate_image", { prompt: "x", model: "nano-banana" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(jobError).toBe("boom");
  });
});

// ── generate_video: guards & validation ─────────────────────────────────────
describe("generate_video — guards & validation", () => {
  it("returns NOT_READY when the runtime context is null", async () => {
    const r = await runTool("generate_video", { prompt: "a dog" }, null);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("runtime not ready");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("rejects a missing prompt", async () => {
    const r = await runTool("generate_video", {}, ctxWith());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("prompt is required");
  });

  it("rejects an unknown video model and lists the options", async () => {
    const r = await runTool("generate_video", { prompt: "x", model: "made-up" }, ctxWith());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown video model");
    expect(String(r.error)).toContain("veo-3.1");
  });

  it("rejects an image model id for a video request (wrong kind)", async () => {
    const r = await runTool("generate_video", { prompt: "x", model: "nano-banana" }, ctxWith());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown video model");
  });

  it("rejects an end frame without a start frame", async () => {
    const r = await runTool("generate_video", { prompt: "x", end_frame: "b.png" }, ctxWith());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("end_frame requires start_frame");
  });

  it("rejects combining reference images with a start frame", async () => {
    const r = await runTool(
      "generate_video",
      { prompt: "x", start_frame: "a.png", reference_images: ["r.png"] },
      ctxWith(),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("reference_images is a separate mode");
  });

  it("rejects an invalid resolution", async () => {
    const r = await runTool("generate_video", { prompt: "x", resolution: "4K" }, ctxWith());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("resolution must be one of");
  });

  it("rejects an aspect ratio the model does not support", async () => {
    const r = await runTool("generate_video", { prompt: "x", aspect_ratio: "1:1" }, ctxWith());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("aspect_ratio must be one of");
  });

  it("errors (via the encode try/catch) when a start frame cannot be resolved", async () => {
    videoOk();
    const r = await runTool("generate_video", { prompt: "x", start_frame: "nope.png" }, ctxWith());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("frame not found: nope.png");
  });
});

// ── generate_video: model + param resolution ────────────────────────────────
describe("generate_video — model & param resolution", () => {
  it("uses the default model (veo-3.1-fast) with 8s duration + audio on", async () => {
    videoOk();
    const r = await runTool("generate_video", { prompt: "a dog" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(r.model).toBe("veo-3.1-fast");
    const { name, body } = lastCall();
    expect(name).toBe("generate_video");
    expect(body.args.provider).toBe("gemini");
    expect(body.args.backend_id).toBe("veo-3.1-fast-generate-001");
    expect(body.args.aspect_ratio).toBe("9:16");
    expect(body.args.duration).toBe(8);
    expect(body.args.generate_audio).toBe(true);
  });

  it("forwards resolution, seed, negative_prompt and generate_audio=false", async () => {
    videoOk();
    await runTool(
      "generate_video",
      {
        prompt: "x",
        resolution: "1080p",
        seed: 7,
        negative_prompt: "shaky",
        generate_audio: false,
      },
      ctxWith(),
    );
    const { body } = lastCall();
    expect(body.args.resolution).toBe("1080p");
    expect(body.args.seed).toBe(7);
    expect(body.args.negative_prompt).toBe("shaky");
    expect(body.args.generate_audio).toBe(false);
  });

  it("encodes start + end frames into interpolation media keys", async () => {
    videoOk();
    const r = await runTool(
      "generate_video",
      { prompt: "x", start_frame: "ref.png", end_frame: "ref2.png" },
      ctxWithFiles("ref.png", "ref2.png"),
    );
    expect(r.ok).toBe(true);
    expect(encode).toHaveBeenCalledTimes(2);
    const { body } = lastCall();
    expect(body.args.start_frame).toBe("start_frame");
    expect(body.args.end_frame).toBe("end_frame");
    expect(body.media.start_frame).toEqual({ b64: "b64data", ext: ".jpg" });
    expect(body.media.end_frame).toEqual({ b64: "b64data", ext: ".jpg" });
  });

  it("encodes reference images and forces duration back to 8s", async () => {
    videoOk();
    const r = await runTool(
      "generate_video",
      { prompt: "x", reference_images: ["ref.png"], duration: 4 },
      ctxWithFiles("ref.png"),
    );
    expect(r.ok).toBe(true);
    const { body } = lastCall();
    expect(body.args.reference_images).toEqual(["vref0"]);
    expect(body.media.vref0).toEqual({ b64: "b64data", ext: ".jpg" });
    expect(body.args.duration).toBe(8);
  });

  it("honours a non-default duration when there are no reference images", async () => {
    videoOk();
    await runTool("generate_video", { prompt: "x", duration: 6 }, ctxWith());
    expect(lastCall().body.args.duration).toBe(6);
  });

  it("falls back to an 8s duration when duration=0", async () => {
    videoOk();
    await runTool("generate_video", { prompt: "x", duration: 0 }, ctxWith());
    expect(lastCall().body.args.duration).toBe(8);
  });
});

// ── generate_video: submission & proxy responses ────────────────────────────
describe("generate_video — submission & proxy responses", () => {
  const spec = (): Any => submit.mock.calls[0][0] as Any;

  it("hands back a placeholder instead of waiting for the render", async () => {
    videoOk({ controls: { seed: 9 } });
    const r = await runTool("generate_video", { prompt: "x" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("video");
    expect(r.model).toBe("veo-3.1-fast");
    expect(r.status).toBe("generating");
    expect(r.media_ref).toBe("media_gen_0");
    expect(r.path).toBeUndefined(); // the model gets a ref, never a path
    expect(spec().tool).toBe("generate_video");
    expect(spec().mediaKind).toBe("video");
    // `controls` can no longer be echoed: it is only known once the call returns, and by then
    // this result is long gone.
    expect(r.controls).toBeUndefined();
  });

  it("carries the requested duration onto the placeholder", async () => {
    videoOk();
    await runTool("generate_video", { prompt: "x", duration: 6 }, ctxWith());
    expect(spec().durationS).toBe(6);
    expect(spec().label).toContain("6s");
  });

  it("uses an explicit name when supplied", async () => {
    videoOk();
    await runTool("generate_video", { prompt: "x", name: "clip" }, ctxWith());
    expect(spec().filename(0)).toBe("clip");
  });

  it("names the placeholder without consulting the provider's response", async () => {
    proxyDto({ result: { ok: true }, media: [{ b64: "b" }] });
    await runTool("generate_video", { prompt: "x" }, ctxWith());
    expect(spec().filename(0)).toBe("generated.mp4");
  });

  it("treats a missing result envelope as success (dto.result ?? {})", async () => {
    proxyDto({ media: [{ b64: "b", ext: ".mp4" }] });
    const r = await runTool("generate_video", { prompt: "x" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(jobError).toBeNull();
  });

  it("fails the job with the model-side error", async () => {
    proxyDto({ result: { ok: false, error: "render failed" } });
    const r = await runTool("generate_video", { prompt: "x" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(jobError).toBe("render failed");
  });

  it("fails the job with a default message when the model gives none", async () => {
    proxyDto({ result: { ok: false } });
    await runTool("generate_video", { prompt: "x" }, ctxWith());
    expect(jobError).toBe("video generation failed");
  });

  it("fails the job when the proxy returns no downloadable file", async () => {
    proxyDto({ result: { ok: true }, media: [] });
    await runTool("generate_video", { prompt: "x" }, ctxWith());
    expect(String(jobError)).toContain("no downloadable file");
  });

  it("fails the job when the proxy omits media entirely (dto.media ?? [])", async () => {
    proxyDto({ result: { ok: true } });
    await runTool("generate_video", { prompt: "x" }, ctxWith());
    expect(String(jobError)).toContain("no downloadable file");
  });

  it("fails the job on a proxy transport failure (Error)", async () => {
    proxy.mockRejectedValue(new Error("net down"));
    const r = await runTool("generate_video", { prompt: "x" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(jobError).toBe("net down");
  });

  it("fails the job on a proxy transport failure (non-Error)", async () => {
    proxy.mockRejectedValue("boom");
    const r = await runTool("generate_video", { prompt: "x" }, ctxWith());
    expect(r.ok).toBe(true);
    expect(jobError).toBe("boom");
  });
});
