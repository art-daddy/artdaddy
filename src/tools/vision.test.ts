import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { ClientToolRegistry } from "./registry";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import { registerVisionTools } from "./vision";

// The ONE hosted vision-model call (/ai/vision_image) and the local image
// pre-encode are the two side-effects vision.ts leans on; mock both so no
// network / ffmpeg runs. toB64 is stubbed so the (mocked-away) encoded bytes
// never have to be real. find_content's OWN ffmpeg (downsample + tile crop) is
// driven through the injected CommandRunner instead.
vi.mock("../api/ai", () => ({
  callAiProxy: vi.fn(),
  toB64: () => "b64data",
}));
vi.mock("./geminiEncode", () => ({
  encodeImageForGemini: vi.fn(),
}));

import { callAiProxy } from "../api/ai";
import { encodeImageForGemini } from "./geminiEncode";

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

// A minimal image ffprobe payload with the given pixel dimensions.
const probeJson = (w: number, h: number): string =>
  JSON.stringify({
    format: { format_name: "png_pipe", size: "1000" },
    streams: [{ codec_type: "video", width: w, height: h, codec_name: "png" }],
  });

function mockRunner(impl: (program: string, args: string[]) => CommandResult): CommandRunner {
  return { run: vi.fn(async (program: string, args: string[]) => impl(program, args)) };
}
// A runner that never shells out (encode is mocked; describe/ask never probe).
function noopRunner(): CommandRunner {
  return mockRunner(() => ({ code: 0, stdout: "", stderr: "" }));
}

function ctxWith(runner: CommandRunner, fs: MockFs = new MockFs()): ClientToolContext {
  fs.putBytes(ENCODED, new Uint8Array([1, 2, 3]));
  return { store: new ProjectStoreAccess(DIR, fs), runner };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Any> {
  const reg = new ClientToolRegistry();
  registerVisionTools(reg, () => ctx);
  return (await reg.run(name, args)) as Any;
}

const proxy = vi.mocked(callAiProxy);
const encode = vi.mocked(encodeImageForGemini);

// Resolve the proxy with a raw result payload (the `{result}` envelope wrapper).
function proxyResult(result: Record<string, unknown>): void {
  proxy.mockResolvedValue({ result } as Any);
}
// The (name, body) of the most recent proxy call.
function lastProxyCall(): { name: string; body: Any } {
  const c = proxy.mock.calls[proxy.mock.calls.length - 1];
  return { name: c[0] as string, body: c[1] as Any };
}

beforeEach(() => {
  encode.mockReset().mockResolvedValue(ENCODED);
  proxy.mockReset();
  proxyResult({ ok: true, text: "" });
});

// ── vision_describe helpers ────────────────────────────────────────────────
// A context whose project holds a resolvable still (`shot.png`).
function describeCtx(): ClientToolContext {
  const fs = new MockFs();
  fs.touch(joinPath(DIR, "shot.png"));
  return ctxWith(noopRunner(), fs);
}

// ── image_ask helpers ──────────────────────────────────────────────────────
// A context with a project-relative still (`a.png`) and a library clip (media_x).
function imgAskCtx(): ClientToolContext {
  const fs = new MockFs();
  fs.touch(joinPath(DIR, "a.png"));
  fs.set(
    joinPath(DIR, "internals/library.json"),
    JSON.stringify({ clips: [{ id: "media_x", path: "library/x.png", filename: "x.png" }] }),
  );
  fs.touch(joinPath(DIR, "library/x.png"));
  return ctxWith(noopRunner(), fs);
}

// ── find_content helpers ───────────────────────────────────────────────────
// A context whose project holds `shot.png`; ffprobe reports w×h and ffmpeg
// (downsample/crop) touches its output (or fails when ffmpegCode != 0).
function shotCtx(w = 800, h = 600, ffmpegCode = 0): ClientToolContext {
  const fs = new MockFs();
  fs.touch(joinPath(DIR, "shot.png"));
  const runner = mockRunner((program, args) => {
    if (program === "ffmpeg") {
      if (ffmpegCode === 0) fs.touch(args[args.length - 1]);
      return { code: ffmpegCode, stdout: "", stderr: "ffmpeg boom" };
    }
    return { code: 0, stdout: probeJson(w, h), stderr: "" };
  });
  return ctxWith(runner, fs);
}
// Like shotCtx, but ffmpeg exits 0 yet writes nothing (so the tool's
// "output actually exists?" guard trips rather than the exit-code guard).
function noOutputCtx(w: number, h: number): ClientToolContext {
  const fs = new MockFs();
  fs.touch(joinPath(DIR, "shot.png"));
  const runner = mockRunner((program) =>
    program === "ffmpeg"
      ? { code: 0, stdout: "", stderr: "" } // "succeeds" but produces no file
      : { code: 0, stdout: probeJson(w, h), stderr: "" },
  );
  return ctxWith(runner, fs);
}
// Like shotCtx, but the DOWNSAMPLED image's probe fails (0×0) so the tool falls
// back to floor(full/df) for the working dimensions.
function dsFallbackCtx(w: number, h: number): ClientToolContext {
  const fs = new MockFs();
  fs.touch(joinPath(DIR, "shot.png"));
  const runner = mockRunner((program, args) => {
    if (program === "ffmpeg") {
      fs.touch(args[args.length - 1]);
      return { code: 0, stdout: "", stderr: "" };
    }
    const path = args[args.length - 1];
    if (path.includes("ds_")) return { code: 1, stdout: "", stderr: "bad" }; // ds probe fails
    return { code: 0, stdout: probeJson(w, h), stderr: "" };
  });
  return ctxWith(runner, fs);
}
// Run find_content on an 800×600 still with the model returning `text`.
async function runFind(
  text: string | undefined,
  extra: Record<string, unknown> = {},
): Promise<Any> {
  proxyResult({ ok: true, text });
  return runTool(
    "find_content",
    { media_ref: "shot.png", prompt: "find button", ...extra },
    shotCtx(),
  );
}

describe("registerVisionTools", () => {
  it("registers exactly vision_describe + image_ask + find_content", () => {
    const reg = new ClientToolRegistry();
    registerVisionTools(reg, () => null);
    expect(reg.names().sort()).toEqual(["find_content", "image_ask", "vision_describe"]);
  });
});

describe("abort signal threading (R5)", () => {
  it("image_ask forwards ctx.signal to the proxy so Stop can cancel it", async () => {
    const controller = new AbortController();
    await runTool(
      "image_ask",
      { prompt: "q", images: [{ media_ref: "a.png" }] },
      { ...imgAskCtx(), signal: controller.signal },
    );
    expect(proxy.mock.calls.at(-1)![2]).toBe(controller.signal);
  });

  it("find_content forwards ctx.signal to the proxy so Stop can cancel it", async () => {
    proxyResult({ ok: true, text: '{"tile":1,"box_2d":[0,0,0,0],"label":"x","contents":""}' });
    const controller = new AbortController();
    await runTool(
      "find_content",
      { media_ref: "shot.png", prompt: "find x" },
      { ...shotCtx(), signal: controller.signal },
    );
    expect(proxy.mock.calls.at(-1)![2]).toBe(controller.signal);
  });
});

describe("vision_describe", () => {
  it("returns NOT_READY when the runtime context is null", async () => {
    const r = await runTool("vision_describe", { media_ref: "shot.png" }, null);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("runtime not ready");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("errors with resolution guidance when the image cannot be resolved", async () => {
    const r = await runTool("vision_describe", { media_ref: "missing.png" }, ctxWith(noopRunner()));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("image not found: missing.png");
    expect(String(r.error)).toContain("library asset id");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("errors when no media_ref is supplied", async () => {
    const r = await runTool("vision_describe", {}, ctxWith(noopRunner()));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("image not found:");
  });

  it("describes a still with the default prompt and single-image proxy body", async () => {
    proxyResult({ ok: true, text: "a cat on a mat" });
    const r = await runTool("vision_describe", { media_ref: "shot.png" }, describeCtx());
    expect(r.ok).toBe(true);
    expect(r.description).toBe("a cat on a mat");
    const { name, body } = lastProxyCall();
    expect(name).toBe("vision_image");
    expect(body.args.model).toBe("gemini-3.1-flash-lite");
    expect(body.args.user_prompt).toBe("Describe what you see in this image.");
    expect(body.args.images).toEqual(["img0"]);
    expect(body.args.response_mime_type).toBeNull();
    expect(body.media.img0).toEqual({ b64: "b64data", ext: ".jpg" });
  });

  it("passes a custom prompt through to the model", async () => {
    proxyResult({ ok: true, text: "ok" });
    const r = await runTool(
      "vision_describe",
      { media_ref: "shot.png", prompt: "count the people" },
      describeCtx(),
    );
    expect(r.ok).toBe(true);
    expect(lastProxyCall().body.args.user_prompt).toBe("count the people");
  });

  it("returns an empty description when the model omits text", async () => {
    proxyResult({ ok: true });
    const r = await runTool("vision_describe", { media_ref: "shot.png" }, describeCtx());
    expect(r.ok).toBe(true);
    expect(r.description).toBe("");
  });

  it("treats a missing result payload as an empty description", async () => {
    proxy.mockResolvedValue({} as Any); // no `result` key => `dto.result ?? {}`
    const r = await runTool("vision_describe", { media_ref: "shot.png" }, describeCtx());
    expect(r.ok).toBe(true);
    expect(r.description).toBe("");
  });

  it("surfaces a model-side failure with its error", async () => {
    proxyResult({ ok: false, error: "vision boom" });
    const r = await runTool("vision_describe", { media_ref: "shot.png" }, describeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("vision boom");
  });

  it("surfaces a bare model-side failure with a default message", async () => {
    proxyResult({ ok: false });
    const r = await runTool("vision_describe", { media_ref: "shot.png" }, describeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("vision call failed");
  });

  it("catches a proxy transport failure (Error)", async () => {
    proxy.mockRejectedValue(new Error("net down"));
    const r = await runTool("vision_describe", { media_ref: "shot.png" }, describeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("net down");
  });

  it("catches a proxy transport failure (non-Error, e.g. rate_limited)", async () => {
    proxy.mockRejectedValue("rate_limited");
    const r = await runTool("vision_describe", { media_ref: "shot.png" }, describeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("rate_limited");
  });
});

describe("image_ask — guards & image resolution", () => {
  it("returns NOT_READY when the runtime context is null", async () => {
    const r = await runTool("image_ask", { prompt: "q", images: [{ media_ref: "a.png" }] }, null);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("runtime not ready");
  });

  it("rejects an empty prompt", async () => {
    const r = await runTool("image_ask", { images: [{ media_ref: "a.png" }] }, imgAskCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("prompt must be a non-empty string");
  });

  it("rejects a whitespace-only prompt", async () => {
    const r = await runTool(
      "image_ask",
      { prompt: "   ", images: [{ media_ref: "a.png" }] },
      imgAskCtx(),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("prompt must be a non-empty string");
  });

  it("rejects a missing images list", async () => {
    const r = await runTool("image_ask", { prompt: "q" }, imgAskCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("images must be a non-empty list");
  });

  it("rejects an empty images list", async () => {
    const r = await runTool("image_ask", { prompt: "q", images: [] }, imgAskCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("images must be a non-empty list");
  });

  it("rejects more than 8 images", async () => {
    const images = Array.from({ length: 9 }, () => ({ media_ref: "a.png" }));
    const r = await runTool("image_ask", { prompt: "q", images }, imgAskCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("too many images: 9 > 8");
  });

  it("rejects a null image entry", async () => {
    const r = await runTool("image_ask", { prompt: "q", images: [null] }, imgAskCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("image[0]: must be an object");
  });

  it("rejects a non-object image entry", async () => {
    const r = await runTool("image_ask", { prompt: "q", images: ["a.png"] }, imgAskCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("image[0]: must be an object");
  });

  it("rejects an image entry with no ref", async () => {
    const r = await runTool("image_ask", { prompt: "q", images: [{}] }, imgAskCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("image[0]: must supply a media_ref");
  });

  it("rejects an image entry whose ref does not resolve", async () => {
    const r = await runTool(
      "image_ask",
      { prompt: "q", images: [{ media_ref: "nope.png" }] },
      imgAskCtx(),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("image[0]: must supply a media_ref");
  });
});

describe("image_ask — success & model handling", () => {
  it("answers a single-image question and trims the prompt", async () => {
    proxyResult({ ok: true, text: "  two people  " });
    const r = await runTool(
      "image_ask",
      { prompt: "  who?  ", images: [{ media_ref: "a.png" }] },
      imgAskCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.prompt).toBe("who?");
    expect(r.answer).toBe("two people");
    expect(r.model).toBe("gemini-3.1-flash-lite");
    expect(r.n_images).toBe(1);
    const { name, body } = lastProxyCall();
    expect(name).toBe("vision_image");
    expect(body.args.images).toEqual(["img0"]);
    expect(body.args.response_mime_type).toBeNull();
    expect(body.media.img0).toEqual({ b64: "b64data", ext: ".jpg" });
  });

  it("resolves a library id and a filename ref across multiple images", async () => {
    proxyResult({ ok: true, text: "answer" });
    const r = await runTool(
      "image_ask",
      { prompt: "q", images: [{ media_ref: "a.png" }, { media_ref: "media_x" }] },
      imgAskCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.n_images).toBe(2);
    expect(lastProxyCall().body.args.images).toEqual(["img0", "img1"]);
  });

  it("returns an empty answer when the model omits text", async () => {
    proxyResult({ ok: true });
    const r = await runTool(
      "image_ask",
      { prompt: "q", images: [{ media_ref: "a.png" }] },
      imgAskCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.answer).toBe("");
  });

  it("treats a missing result payload as an empty answer", async () => {
    proxy.mockResolvedValue({} as Any);
    const r = await runTool(
      "image_ask",
      { prompt: "q", images: [{ media_ref: "a.png" }] },
      imgAskCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.answer).toBe("");
  });

  it("surfaces a model-side failure with its error", async () => {
    proxyResult({ ok: false, error: "vm boom" });
    const r = await runTool(
      "image_ask",
      { prompt: "q", images: [{ media_ref: "a.png" }] },
      imgAskCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("vm boom");
  });

  it("surfaces a bare model-side failure with a default message", async () => {
    proxyResult({ ok: false });
    const r = await runTool(
      "image_ask",
      { prompt: "q", images: [{ media_ref: "a.png" }] },
      imgAskCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("vision model failed");
  });

  it("catches a proxy transport failure (Error)", async () => {
    proxy.mockRejectedValue(new Error("net down"));
    const r = await runTool(
      "image_ask",
      { prompt: "q", images: [{ media_ref: "a.png" }] },
      imgAskCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("net down");
  });

  it("catches a proxy transport failure (non-Error)", async () => {
    proxy.mockRejectedValue("rate_limited");
    const r = await runTool(
      "image_ask",
      { prompt: "q", images: [{ media_ref: "a.png" }] },
      imgAskCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("rate_limited");
  });
});

describe("find_content — guards & source resolution", () => {
  it("returns NOT_READY when the runtime context is null", async () => {
    const r = await runTool("find_content", { media_ref: "shot.png", prompt: "x" }, null);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("runtime not ready");
  });

  it("errors when media_ref is missing", async () => {
    const r = await runTool("find_content", { prompt: "x" }, shotCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("media_ref is required");
  });

  it("errors when media_ref is an empty string", async () => {
    const r = await runTool("find_content", { media_ref: "", prompt: "x" }, shotCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("media_ref is required");
  });

  it("errors when media_ref does not resolve (default empty prompt)", async () => {
    // No prompt arg here => exercises the `args.prompt ?? ""` default.
    const r = await runTool("find_content", { media_ref: "missing.png" }, ctxWith(noopRunner()));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("image not found: missing.png");
    expect(r.prompt).toBe("");
  });

  it("errors when the image cannot be probed", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "shot.png"));
    const runner = mockRunner((program) =>
      program === "ffprobe"
        ? { code: 1, stdout: "", stderr: "bad" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const r = await runTool(
      "find_content",
      { media_ref: "shot.png", prompt: "x" },
      ctxWith(runner, fs),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("could not read image");
  });

  it("treats a throwing ffprobe as an unreadable image", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "shot.png"));
    const runner = mockRunner((program) => {
      if (program === "ffprobe") throw new Error("probe boom");
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = await runTool(
      "find_content",
      { media_ref: "shot.png", prompt: "x" },
      ctxWith(runner, fs),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("could not read image");
  });
});

describe("find_content — happy path & bbox mapping", () => {
  it("locates a region on a non-downsampled still and maps the bbox back to pixels", async () => {
    proxyResult({
      ok: true,
      text: '{"tile":1,"box_2d":[100,200,300,400],"label":"btn","contents":"Subscribe"}',
    });
    const r = await runTool(
      "find_content",
      { media_ref: "shot.png", prompt: "find button" },
      shotCtx(800, 600),
    );
    expect(r.ok).toBe(true);
    expect(r.prompt).toBe("find button");
    expect(r.media_ref).toBe("shot.png");
    expect(r.bbox).toEqual({ x: 160, y: 60, w: 160, h: 120 });
    expect(r.label).toBe("btn");
    expect(r.contents).toBe("Subscribe");
    expect(r.tile).toBe(1);
    expect(r.n_tiles).toBe(1);
    expect(r.image_size).toEqual({ w: 800, h: 600 });
    const { name, body } = lastProxyCall();
    expect(name).toBe("vision_image");
    expect(body.args.model).toBe("gemini-3.1-flash-lite");
    expect(body.args.response_mime_type).toBe("application/json");
    expect(body.args.images).toEqual(["tile0"]);
    expect(String(body.args.user_prompt)).toContain("shown 1 numbered tiles");
    expect(String(body.args.user_prompt)).toContain("TASK: find button");
    expect(body.media.tile0).toEqual({ b64: "b64data", ext: ".png" });
  });

  it("clamps an over-range bbox to the image bounds", async () => {
    const r = await runFind('{"tile":1,"box_2d":[100,1200,300,1500]}');
    expect(r.ok).toBe(true);
    expect(r.bbox.x).toBe(800); // x clamped to full width
    expect(r.bbox.w).toBe(240);
  });

  it("clamps a negative bbox origin to zero", async () => {
    const r = await runFind('{"tile":1,"box_2d":[-100,-100,100,100]}');
    expect(r.ok).toBe(true);
    expect(r.bbox.x).toBe(0);
    expect(r.bbox.y).toBe(0);
  });
});

describe("find_content — downsample & tiling", () => {
  it("downsamples a wide screenshot and still returns a bbox (probe-reported ds dims)", async () => {
    proxyResult({ ok: true, text: '{"tile":1,"box_2d":[100,200,300,400]}' });
    const ctx = shotCtx(3000, 600); // width > 1500 => df = 2
    const r = await runTool("find_content", { media_ref: "shot.png", prompt: "x" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.image_size).toEqual({ w: 3000, h: 600 });
    // a downsample (scale) ffmpeg ran before the tile crop
    const ffmpeg = (ctx.runner.run as Any).mock.calls.filter((c: Any[]) => c[0] === "ffmpeg");
    expect(ffmpeg.some((c: Any[]) => String(c[1].join(" ")).includes("scale=iw/2"))).toBe(true);
  });

  it("falls back to floor(full/df) when the downsampled image cannot be probed", async () => {
    proxyResult({ ok: true, text: '{"tile":1,"box_2d":[100,200,300,400]}' });
    const r = await runTool(
      "find_content",
      { media_ref: "shot.png", prompt: "x" },
      dsFallbackCtx(3000, 600),
    );
    expect(r.ok).toBe(true);
    expect(r.image_size).toEqual({ w: 3000, h: 600 });
  });

  it("reuses cached downsample + tile artifacts on a second call", async () => {
    proxyResult({ ok: true, text: '{"tile":1,"box_2d":[10,20,30,40]}' });
    const ctx = shotCtx(3000, 600);
    const r1 = await runTool("find_content", { media_ref: "shot.png", prompt: "x" }, ctx);
    const r2 = await runTool("find_content", { media_ref: "shot.png", prompt: "x" }, ctx);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // call 1: 1 scale + 1 crop; call 2: both cached => 2 ffmpeg runs total
    const ffmpeg = (ctx.runner.run as Any).mock.calls.filter((c: Any[]) => c[0] === "ffmpeg");
    expect(ffmpeg).toHaveLength(2);
  });

  it("tiles a tall screenshot into multiple slices", async () => {
    proxyResult({ ok: true, text: '{"tile":2,"box_2d":[0,0,500,500]}' });
    const r = await runTool(
      "find_content",
      { media_ref: "shot.png", prompt: "x" },
      shotCtx(800, 9000),
    );
    expect(r.ok).toBe(true);
    expect(r.n_tiles).toBe(3); // ceil(9000/3000)
    expect(r.tile).toBe(2);
  });

  it("caps a very tall screenshot at 8 tiles", async () => {
    proxyResult({ ok: true, text: '{"tile":1,"box_2d":[0,0,10,10]}' });
    const r = await runTool(
      "find_content",
      { media_ref: "shot.png", prompt: "x" },
      shotCtx(800, 40000),
    );
    expect(r.ok).toBe(true);
    expect(r.n_tiles).toBe(8);
  });

  it("errors when downsampling fails", async () => {
    proxyResult({ ok: true, text: '{"tile":1,"box_2d":[0,0,10,10]}' });
    const r = await runTool(
      "find_content",
      { media_ref: "shot.png", prompt: "x" },
      shotCtx(3000, 600, 1),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("downsample failed");
  });

  it("errors when a tile crop fails", async () => {
    proxyResult({ ok: true, text: '{"tile":1,"box_2d":[0,0,10,10]}' });
    const r = await runTool(
      "find_content",
      { media_ref: "shot.png", prompt: "x" },
      shotCtx(800, 600, 1),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("tile crop failed");
  });

  it("errors when downsampling exits 0 but writes no file", async () => {
    proxyResult({ ok: true, text: '{"tile":1,"box_2d":[0,0,10,10]}' });
    const r = await runTool(
      "find_content",
      { media_ref: "shot.png", prompt: "x" },
      noOutputCtx(3000, 600),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("downsample failed");
  });

  it("errors when a tile crop exits 0 but writes no file", async () => {
    proxyResult({ ok: true, text: '{"tile":1,"box_2d":[0,0,10,10]}' });
    const r = await runTool(
      "find_content",
      { media_ref: "shot.png", prompt: "x" },
      noOutputCtx(800, 600),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("tile crop failed");
  });

  it("errors when tiling produces no tiles (zero-height working image)", async () => {
    proxyResult({ ok: true, text: '{"tile":1,"box_2d":[0,0,10,10]}' });
    // width 3000 => df 2; ds probe fails => dsH = floor(1/2) = 0 => no tiles
    const r = await runTool(
      "find_content",
      { media_ref: "shot.png", prompt: "x" },
      dsFallbackCtx(3000, 1),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("tiling produced no tiles");
  });
});

describe("find_content — model call failures", () => {
  it("surfaces a model-side failure with its error", async () => {
    proxyResult({ ok: false, error: "no bbox" });
    const r = await runTool("find_content", { media_ref: "shot.png", prompt: "x" }, shotCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("vision model failed: no bbox");
  });

  it("surfaces a bare model-side failure", async () => {
    proxyResult({ ok: false });
    const r = await runTool("find_content", { media_ref: "shot.png", prompt: "x" }, shotCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("vision model failed");
  });

  it("catches a proxy transport failure (Error)", async () => {
    proxy.mockRejectedValue(new Error("net down"));
    const r = await runTool("find_content", { media_ref: "shot.png", prompt: "x" }, shotCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("vision model failed: net down");
  });

  it("catches a proxy transport failure (non-Error)", async () => {
    proxy.mockRejectedValue("rate_limited");
    const r = await runTool("find_content", { media_ref: "shot.png", prompt: "x" }, shotCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("vision model failed: rate_limited");
  });
});

describe("find_content — response parsing (parseTileBbox)", () => {
  it("parses a fenced ```json block", async () => {
    const r = await runFind(
      '```json\n{"tile":1,"box_2d":[10,20,30,40],"label":"a","contents":"b"}\n```',
    );
    expect(r.ok).toBe(true);
    expect(r.label).toBe("a");
    expect(r.contents).toBe("b");
  });

  it("parses a bare fenced ``` block (no json tag)", async () => {
    const r = await runFind('```\n{"tile":1,"box_2d":[10,20,30,40]}\n```');
    expect(r.ok).toBe(true);
  });

  it("extracts a JSON object embedded in surrounding prose", async () => {
    const r = await runFind('here you go: {"tile":1,"box_2d":[10,20,30,40]} thanks');
    expect(r.ok).toBe(true);
  });

  it("reads box_2d from the `bbox` alias", async () => {
    const r = await runFind('{"tile":1,"bbox":[10,20,30,40]}');
    expect(r.ok).toBe(true);
  });

  it("reads box_2d from the `box` alias", async () => {
    const r = await runFind('{"tile":1,"box":[10,20,30,40]}');
    expect(r.ok).toBe(true);
  });

  it("unwraps a single-element array response", async () => {
    const r = await runFind('[{"tile":1,"box_2d":[10,20,30,40]}]');
    expect(r.ok).toBe(true);
  });

  it("truncates a float tile index and a long label", async () => {
    const label = "L".repeat(130);
    const r = await runFind(`{"tile":1.9,"box_2d":[10,20,30,40],"label":"${label}"}`);
    expect(r.ok).toBe(true);
    expect(r.tile).toBe(1);
    expect((r.label as string).length).toBe(120);
  });

  it("coerces non-string label/contents to empty strings", async () => {
    const r = await runFind('{"tile":1,"box_2d":[10,20,30,40],"label":99,"contents":123}');
    expect(r.ok).toBe(true);
    expect(r.label).toBe("");
    expect(r.contents).toBe("");
  });

  it("fails on an empty model response", async () => {
    const r = await runFind(undefined);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no parseable tile/bbox");
    expect(r.raw_response).toBe("");
  });

  it("fails when there is no JSON object at all", async () => {
    const r = await runFind("sorry, nothing here");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no parseable tile/bbox");
    expect(r.raw_response).toBe("sorry, nothing here");
  });

  it("fails when the embedded braces are not valid JSON", async () => {
    const r = await runFind("prefix {not: valid, json} suffix");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no parseable tile/bbox");
  });

  it("fails on an empty array response", async () => {
    const r = await runFind("[]");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no parseable tile/bbox");
  });

  it("fails when the parsed value is not an object (number)", async () => {
    const r = await runFind("123");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no parseable tile/bbox");
  });

  it("fails when the parsed value is a JSON null", async () => {
    const r = await runFind("null");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no parseable tile/bbox");
  });

  it("fails when tile is missing", async () => {
    const r = await runFind('{"box_2d":[10,20,30,40]}');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no parseable tile/bbox");
  });

  it("fails when box is not an array", async () => {
    const r = await runFind('{"tile":1,"box_2d":"nope"}');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no parseable tile/bbox");
  });

  it("fails when box has the wrong length", async () => {
    const r = await runFind('{"tile":1,"box_2d":[10,20,30]}');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no parseable tile/bbox");
  });

  it("fails when a box coordinate is not numeric", async () => {
    const r = await runFind('{"tile":1,"box_2d":[10,20,"z",40]}');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no parseable tile/bbox");
  });

  it("fails when tile is a non-numeric string", async () => {
    const r = await runFind('{"tile":"abc","box_2d":[10,20,30,40]}');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no parseable tile/bbox");
  });

  it("treats a missing result payload as unparseable", async () => {
    proxy.mockResolvedValue({} as Any);
    const r = await runTool("find_content", { media_ref: "shot.png", prompt: "x" }, shotCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no parseable tile/bbox");
  });

  it("rejects a tile index above the tile count", async () => {
    const r = await runFind('{"tile":5,"box_2d":[10,20,30,40]}');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("picked tile=5 but only 1 tiles exist");
    expect(r.raw_response).toContain("tile");
  });

  it("rejects a tile index below 1", async () => {
    const r = await runFind('{"tile":0,"box_2d":[10,20,30,40]}');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("picked tile=0");
  });
});
