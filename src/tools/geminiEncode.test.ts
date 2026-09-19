// Guards the Gemini encode helpers: the CACHE KEY (a stale reuse ships the wrong
// pixels to a paid vision call), the ffmpeg ARGUMENT ORDER (`-ss` before `-i` is a
// fast seek; after `-i` it decodes the whole file), and the two OPPOSITE failure
// policies — video encode THROWS, image encode falls back to the original.
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import type { ClientToolContext } from "./context";
import { encodeImageForGemini, encodeVideoForGemini } from "./geminiEncode";

type Run = { program: string; args: string[] };

function makeCtx(opts: { code?: number; producesOutput?: boolean; outputBytes?: number } = {}) {
  const runs: Run[] = [];
  const written = new Set<string>();
  const code = opts.code ?? 0;
  const produces = opts.producesOutput ?? true;
  const ctx = {
    store: {
      prepareArtifact: (rel: string) => Promise.resolve(`/proj/artifacts/${rel}`),
      exists: (p: string) => Promise.resolve(written.has(p)),
      // The real store has this; a fixture without it would let a size check pass by never running.
      byteSize: () => Promise.resolve(opts.outputBytes ?? 1024),
    },
    runner: {
      run: (program: string, args: string[]) => {
        runs.push({ program, args });
        if (code === 0 && produces) written.add(args[args.length - 1]);
        return Promise.resolve({ code, stdout: "", stderr: code === 0 ? "" : "boom" });
      },
    },
  } as unknown as ClientToolContext;
  return { ctx, runs, written };
}

const VIDEO = { fps: 1, maxDim: 512, keepAudio: false };

describe("encodeVideoForGemini", () => {
  it("runs ffmpeg once and reuses the cached output on the second call", async () => {
    const { ctx, runs } = makeCtx();
    const a = await encodeVideoForGemini(ctx, "/src/a.mp4", VIDEO);
    const b = await encodeVideoForGemini(ctx, "/src/a.mp4", VIDEO);
    expect(a).toBe(b);
    expect(runs).toHaveLength(1);
  });

  it("seeks BEFORE the input (a fast seek), and gives -t a duration not an end time", async () => {
    const { ctx, runs } = makeCtx();
    await encodeVideoForGemini(ctx, "/src/a.mp4", { ...VIDEO, start: 10, end: 14 });
    const args = runs[0].args;
    const ss = args.indexOf("-ss");
    const i = args.indexOf("-i");
    expect(ss).toBeGreaterThanOrEqual(0);
    expect(ss).toBeLessThan(i); // after -i this would decode from frame 0 every time
    expect(args[ss + 1]).toBe("10.000");
    expect(args[args.indexOf("-t") + 1]).toBe("4.000"); // duration, not the end timestamp
  });

  it("omits the seek entirely when no window is asked for", async () => {
    const { ctx, runs } = makeCtx();
    await encodeVideoForGemini(ctx, "/src/a.mp4", VIDEO);
    expect(runs[0].args).not.toContain("-ss");
    expect(runs[0].args).not.toContain("-t");
  });

  it("strips audio by default and keeps an AAC track when asked", async () => {
    const muted = makeCtx();
    await encodeVideoForGemini(muted.ctx, "/src/a.mp4", VIDEO);
    expect(muted.runs[0].args).toContain("-an");
    expect(muted.runs[0].args).not.toContain("aac");

    const withAudio = makeCtx();
    await encodeVideoForGemini(withAudio.ctx, "/src/a.mp4", { ...VIDEO, keepAudio: true });
    expect(withAudio.runs[0].args).toContain("aac");
    expect(withAudio.runs[0].args).not.toContain("-an");
  });

  it("throws when ffmpeg fails", async () => {
    const { ctx } = makeCtx({ code: 1 });
    await expect(encodeVideoForGemini(ctx, "/src/a.mp4", VIDEO)).rejects.toThrow(
      /encode for gemini/,
    );
  });

  it("throws when ffmpeg claims success but wrote nothing (a silent empty attachment)", async () => {
    const { ctx } = makeCtx({ code: 0, producesOutput: false });
    await expect(encodeVideoForGemini(ctx, "/src/a.mp4", VIDEO)).rejects.toThrow(
      /encode for gemini/,
    );
  });

  it("never seeks to a negative time even when handed one", async () => {
    const { ctx, runs } = makeCtx();
    await encodeVideoForGemini(ctx, "/src/a.mp4", { ...VIDEO, start: -5, end: 2 });
    expect(runs[0].args[runs[0].args.indexOf("-ss") + 1]).toBe("0.000");
  });

  it("never asks for a non-positive duration when end <= start", async () => {
    const { ctx, runs } = makeCtx();
    await encodeVideoForGemini(ctx, "/src/a.mp4", { ...VIDEO, start: 10, end: 10 });
    expect(Number(runs[0].args[runs[0].args.indexOf("-t") + 1])).toBeGreaterThan(0);
  });

  it("separates the cache by tag so inspect and gemini can't collide", async () => {
    const { ctx } = makeCtx();
    const a = await encodeVideoForGemini(ctx, "/src/a.mp4", { ...VIDEO, tag: "inspect" });
    const b = await encodeVideoForGemini(ctx, "/src/a.mp4", { ...VIDEO, tag: "gemini" });
    expect(a).not.toBe(b);
  });
});

// The duration cap and the reader's byte ceiling were set independently, so there was a band that
// video_find_moment ACCEPTED and then could not read: a 12-minute film cleared the 30-minute cap and
// encoded to 77.6 MB against a 64 MB ceiling — ten failures in one session, reported to the model as
// a refusal to read a cache filename it had never heard of.
describe("the analysis encode is bounded by what the caller can read", () => {
  it("caps the rate so the stated budget divided by the span is not exceeded", async () => {
    const { ctx, runs } = makeCtx();
    await encodeVideoForGemini(ctx, "/src/long.mp4", {
      ...VIDEO,
      budget: { maxBytes: 64 * 1024 * 1024, durationS: 720 },
    });
    const args = runs[0].args;
    const kbps = Number(String(args[args.indexOf("-maxrate") + 1]).replace("k", ""));
    // The rule, not the arithmetic: whatever the cap is, 720s at that rate must fit in 64 MB.
    expect((kbps * 1000 * 720) / 8).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(args[args.indexOf("-bufsize") + 1]).toBe(`${kbps * 2}k`);
  });

  it("a longer span gets a tighter cap", async () => {
    const short = makeCtx();
    await encodeVideoForGemini(short.ctx, "/src/a.mp4", {
      ...VIDEO,
      budget: { maxBytes: 64 * 1024 * 1024, durationS: 60 },
    });
    const long = makeCtx();
    await encodeVideoForGemini(long.ctx, "/src/a.mp4", {
      ...VIDEO,
      budget: { maxBytes: 64 * 1024 * 1024, durationS: 1800 },
    });
    const rateOf = (r: Run) =>
      Number(String(r.args[r.args.indexOf("-maxrate") + 1]).replace("k", ""));
    expect(rateOf(long.runs[0])).toBeLessThan(rateOf(short.runs[0]));
  });

  // The failure direction: a cap applied unconditionally would degrade every short clip.
  it("adds no cap at all when no budget is given", async () => {
    const { ctx, runs } = makeCtx();
    await encodeVideoForGemini(ctx, "/src/a.mp4", VIDEO);
    expect(runs[0].args).not.toContain("-maxrate");
  });

  it("two budgets that differ produce different cache entries", async () => {
    const { ctx } = makeCtx();
    const a = await encodeVideoForGemini(ctx, "/src/a.mp4", {
      ...VIDEO,
      budget: { maxBytes: 64 * 1024 * 1024, durationS: 60 },
    });
    const b = await encodeVideoForGemini(ctx, "/src/a.mp4", {
      ...VIDEO,
      budget: { maxBytes: 64 * 1024 * 1024, durationS: 1800 },
    });
    expect(a).not.toBe(b); // else the second call ships the first call's pixels
  });

  // ffmpeg can still overshoot a -maxrate. When it does the model must be told something it can
  // act on, in its own vocabulary — not handed an internal cache path.
  it("refuses in the caller's vocabulary when the output still overshoots", async () => {
    const { ctx } = makeCtx({ outputBytes: 80 * 1024 * 1024 });
    await expect(
      encodeVideoForGemini(ctx, "/src/a.mp4", {
        ...VIDEO,
        budget: { maxBytes: 64 * 1024 * 1024, durationS: 720 },
      }),
    ).rejects.toThrow(/shorter start_seconds\/end_seconds window/);
  });
});

// The cache key is the whole safety property: any input that changes the PIXELS
// must change the path, or a later call silently reuses the wrong encode.
describe("encodeVideoForGemini cache key (property)", () => {
  const optsArb = fc.record({
    fps: fc.double({ min: 0.5, max: 30, noNaN: true }),
    maxDim: fc.integer({ min: 64, max: 1080 }),
    keepAudio: fc.boolean(),
    start: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
    end: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
  });

  it("two different encode recipes never share a cache path", async () => {
    await fc.assert(
      fc.asyncProperty(optsArb, optsArb, fc.string(), async (x, y, src) => {
        fc.pre(JSON.stringify(x) !== JSON.stringify(y));
        const a = makeCtx();
        const b = makeCtx();
        await encodeVideoForGemini(a.ctx, src, x).catch(() => undefined);
        await encodeVideoForGemini(b.ctx, src, y).catch(() => undefined);
        expect(a.runs[0].args.at(-1)).not.toBe(b.runs[0].args.at(-1));
      }),
      { numRuns: 200 },
    );
  });

  it("the same recipe on a different source never shares a cache path", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), optsArb, async (s1, s2, o) => {
        fc.pre(s1 !== s2);
        const a = makeCtx();
        const b = makeCtx();
        await encodeVideoForGemini(a.ctx, s1, o).catch(() => undefined);
        await encodeVideoForGemini(b.ctx, s2, o).catch(() => undefined);
        expect(a.runs[0].args.at(-1)).not.toBe(b.runs[0].args.at(-1));
      }),
      { numRuns: 200 },
    );
  });
});

describe("encodeImageForGemini", () => {
  it("returns the encoded path on success and caches it", async () => {
    const { ctx, runs } = makeCtx();
    const a = await encodeImageForGemini(ctx, "/src/a.png");
    const b = await encodeImageForGemini(ctx, "/src/a.png");
    expect(a).toBe(b);
    expect(a).toMatch(/gem_img_[0-9a-f]{8}\.jpg$/);
    expect(runs).toHaveLength(1);
  });

  it("FAILS OPEN — a failed encode returns the original so the model still sees it", async () => {
    const { ctx } = makeCtx({ code: 1 });
    await expect(encodeImageForGemini(ctx, "/src/a.png")).resolves.toBe("/src/a.png");
  });

  it("fails open when ffmpeg reports success but produced no file", async () => {
    const { ctx } = makeCtx({ code: 0, producesOutput: false });
    await expect(encodeImageForGemini(ctx, "/src/a.png")).resolves.toBe("/src/a.png");
  });

  it("never upscales — the scale filter only ever decreases", async () => {
    const { ctx, runs } = makeCtx();
    await encodeImageForGemini(ctx, "/src/a.png", { maxDim: 256 });
    const vf = runs[0].args[runs[0].args.indexOf("-vf") + 1];
    expect(vf).toBe("scale=256:256:force_original_aspect_ratio=decrease");
  });

  it("maps any quality onto mjpeg's legal 2..31 band", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -1000, max: 1000 }), async (quality) => {
        const { ctx, runs } = makeCtx();
        await encodeImageForGemini(ctx, "/src/a.png", { quality });
        const qv = Number(runs[0].args[runs[0].args.indexOf("-q:v") + 1]);
        expect(Number.isInteger(qv)).toBe(true);
        expect(qv).toBeGreaterThanOrEqual(2);
        expect(qv).toBeLessThanOrEqual(31);
      }),
      { numRuns: 200 },
    );
  });

  it("a higher quality number never produces a worse mjpeg q:v", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        async (q1, q2) => {
          fc.pre(q1 < q2);
          const a = makeCtx();
          const b = makeCtx();
          await encodeImageForGemini(a.ctx, "/src/a.png", { quality: q1 });
          await encodeImageForGemini(b.ctx, "/src/a.png", { quality: q2 });
          const qa = Number(a.runs[0].args[a.runs[0].args.indexOf("-q:v") + 1]);
          const qb = Number(b.runs[0].args[b.runs[0].args.indexOf("-q:v") + 1]);
          expect(qb).toBeLessThanOrEqual(qa); // lower q:v == better
        },
      ),
      { numRuns: 200 },
    );
  });

  it("takes exactly one frame (a video input must not become a movie)", async () => {
    const { ctx, runs } = makeCtx();
    await encodeImageForGemini(ctx, "/src/a.mp4");
    expect(runs[0].args[runs[0].args.indexOf("-frames:v") + 1]).toBe("1");
  });

  it("does not run ffmpeg at all when the artifact already exists", async () => {
    const { ctx, runs, written } = makeCtx();
    written.add("/proj/artifacts/gemini/gem_img_" + "0".repeat(0)); // placeholder, replaced below
    written.clear();
    const first = await encodeImageForGemini(ctx, "/src/a.png");
    written.add(first);
    const spy = vi.spyOn(ctx.runner, "run");
    await encodeImageForGemini(ctx, "/src/a.png");
    expect(spy).not.toHaveBeenCalled();
    expect(runs).toHaveLength(1);
  });
});
