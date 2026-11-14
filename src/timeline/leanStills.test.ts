import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { LeanOptions, LeanProbed } from "./leanOptions";
import { LeanTally } from "./leanRecord";
import {
  LEAN_STILL_BYTES_PER_PIXEL,
  LEAN_STILL_BYTES_PER_PIXEL_GRADED,
  LEAN_STILL_MAX_HELD_BYTES,
  LEAN_STILLS_MAX_TOTAL_BYTES,
  leanPictureLoop,
  type PictureLoopRequest,
} from "./leanStills";
import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const OUT = "/out.mp4";
const PRE_SCALE = "scale=w=216:h=384:force_original_aspect_ratio=increase:force_divisible_by=2";
/** The most pixels one held frame may have by the bytes estimate (8 bytes a pixel as decoded). */
const MAX_PIXELS = Math.floor(LEAN_STILL_MAX_HELD_BYTES / LEAN_STILL_BYTES_PER_PIXEL);

function request(over: Partial<PictureLoopRequest> = {}, lean: LeanOptions = { stills: true }) {
  const tally = new LeanTally();
  const req: PictureLoopRequest = {
    lean,
    tally,
    reader: "picture",
    fps: 30,
    path: "/p0.jpg",
    heldPixels: 108 * 192,
    preScale: null,
    graded: false,
    cropped: false,
    budget: { bytes: 0 },
    ...over,
  };
  return { req, tally };
}

describe("leanPictureLoop: one still picture, decoded once or left on today's read", () => {
  it("a picture of a known size is decoded once: no input loop, the held frame repeated and restamped after the fit, and the record says stills ran", () => {
    const { req, tally } = request();
    const loop = leanPictureLoop(req);
    expect(loop).toEqual({
      input: [],
      graph: "loop=loop=-1:size=1:start=0,settb=1/30,setpts=N",
      graphAfterFit: true,
      passes: Infinity,
      hold: false,
    });
    expect(tally.record()).toEqual({ ran: ["stills"], kept: [] });
  });

  it("every refusal is today's recipe with one closed word, and what is not a picture is not counted at all", () => {
    const off = request({}, { stills: false });
    expect(leanPictureLoop(off.req)).toBeNull();
    expect(off.tally.record()).toEqual({ ran: [], kept: ["flag_off"] });

    const plain = request({}, { stills: true, plain: true });
    expect(leanPictureLoop(plain.req)).toBeNull();
    expect(plain.tally.record()).toEqual({ ran: [], kept: [] });

    for (const reader of ["gif", "apng", "webp_anim", "mov"] as const) {
      const animated = request({ reader });
      expect(leanPictureLoop(animated.req)).toBeNull();
      expect(animated.tally.record()).toEqual({ ran: [], kept: [] });
    }

    for (const fps of [0, -30, NaN, Infinity]) {
      const bad = request({ fps });
      expect(leanPictureLoop(bad.req)).toBeNull();
      expect(bad.tally.record()).toEqual({ ran: [], kept: ["error"] });
    }

    const big = request({ heldPixels: MAX_PIXELS + 2 });
    expect(leanPictureLoop(big.req)).toBeNull();
    expect(big.tally.record()).toEqual({ ran: [], kept: ["over_budget"] });
    const edge = request({ heldPixels: MAX_PIXELS });
    expect(leanPictureLoop(edge.req)).not.toBeNull();

    for (const heldPixels of [0, -5, NaN, Infinity]) {
      const unknown = request({ heldPixels });
      expect(leanPictureLoop(unknown.req)).toBeNull();
      expect(unknown.tally.record()).toEqual({ ran: [], kept: ["unknown_source"] });
    }
    const nothing = request({ heldPixels: null, preScale: null });
    expect(leanPictureLoop(nothing.req)).toBeNull();
    expect(nothing.tally.record()).toEqual({ ran: [], kept: ["unknown_source"] });
  });

  it("a cover zoom asks ffmpeg for the size of its pre-scale once, keeps today's read until it is answered, then takes the loop at the size ffmpeg reported", () => {
    const requests: NonNullable<LeanOptions["requests"]> = [];
    const asked = request({ heldPixels: null, preScale: PRE_SCALE }, { stills: true, requests });
    expect(leanPictureLoop(asked.req)).toBeNull();
    expect(leanPictureLoop(asked.req)).toBeNull();
    expect(asked.tally.record()).toEqual({ ran: [], kept: ["unknown_source"] });
    expect(requests).toEqual([
      {
        key: `/p0.jpg\n${PRE_SCALE}`,
        path: "/p0.jpg",
        filters: `setsar=1,showinfo,${PRE_SCALE},showinfo`,
      },
    ]);

    const answer = (scaled: readonly [number, number]): LeanOptions => ({
      stills: true,
      probed: new Map<string, LeanProbed>([
        [`/p0.jpg\n${PRE_SCALE}`, { fmt: "yuvj420p", source: [4000, 3000], scaled }],
      ]),
    });
    const ok = request({ heldPixels: null, preScale: PRE_SCALE }, answer([512, 384]));
    expect(leanPictureLoop(ok.req)).not.toBeNull();
    expect(ok.tally.record()).toEqual({ ran: ["stills"], kept: [] });
    const huge = request({ heldPixels: null, preScale: PRE_SCALE }, answer([20000, 8000]));
    expect(leanPictureLoop(huge.req)).toBeNull();
    expect(huge.tally.record()).toEqual({ ran: [], kept: ["over_budget"] });
  });

  it("the held frame's memory is decided in BYTES by a conservative estimate: a graded picture is a float stack (16 bytes a pixel), and one command's held frames may not add up past 1.5 GiB", () => {
    const px = Math.floor(LEAN_STILL_MAX_HELD_BYTES / LEAN_STILL_BYTES_PER_PIXEL_GRADED);
    const graded = request({ heldPixels: px, graded: true });
    expect(leanPictureLoop(graded.req)).not.toBeNull();
    const tooBig = request({ heldPixels: px + 1, graded: true });
    expect(leanPictureLoop(tooBig.req)).toBeNull();
    expect(tooBig.tally.record()).toEqual({ ran: [], kept: ["over_budget"] });
    // the same pixels ungraded are within the limit
    expect(leanPictureLoop(request({ heldPixels: px + 1 }).req)).not.toBeNull();

    const budget = { bytes: 0 };
    const each = LEAN_STILL_MAX_HELD_BYTES / LEAN_STILL_BYTES_PER_PIXEL;
    let held = 0;
    for (let i = 0; i < 10; i += 1) {
      const next = request({ heldPixels: each, budget });
      if (leanPictureLoop(next.req) !== null) held += 1;
    }
    expect(held).toBe(Math.floor(LEAN_STILLS_MAX_TOTAL_BYTES / LEAN_STILL_MAX_HELD_BYTES));
    expect(budget.bytes).toBeLessThanOrEqual(LEAN_STILLS_MAX_TOTAL_BYTES);
  });

  it("a cropped cover zoom is not held: the probe's question does not include the crop, so its answer is not the size that would be held", () => {
    const cropped = request(
      { heldPixels: null, preScale: PRE_SCALE, cropped: true },
      {
        stills: true,
        probed: new Map<string, LeanProbed>([
          [`/p0.jpg\n${PRE_SCALE}`, { fmt: "yuvj420p", source: [4000, 3000], scaled: [512, 384] }],
        ]),
      },
    );
    expect(leanPictureLoop(cropped.req)).toBeNull();
    expect(cropped.tally.record()).toEqual({ ran: [], kept: ["not_proven"] });
    // a fixed box is fitted to exactly its size whatever the crop, so it is held
    expect(leanPictureLoop(request({ cropped: true }).req)).not.toBeNull();
  });

  it("the loop's text is a rule of the frame rate and nothing else (property), and it never throws whatever it is given", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ min: 1, max: 240 }), fc.double({ noNaN: true })),
        fc.oneof(fc.double({ noNaN: false }), fc.integer({ min: -10, max: 100_000_000 })),
        fc.constantFrom("picture", "gif", "apng", "webp_anim", "mov"),
        (fps, heldPixels, reader) => {
          const { req, tally } = request({ fps, heldPixels, reader });
          const loop = leanPictureLoop(req);
          const grounded =
            Number.isFinite(fps) &&
            fps > 0 &&
            reader === "picture" &&
            heldPixels > 0 &&
            heldPixels * LEAN_STILL_BYTES_PER_PIXEL <= LEAN_STILL_MAX_HELD_BYTES;
          if (!grounded) return loop === null && !tally.record().ran.length;
          return (
            loop !== null &&
            loop.graph === `loop=loop=-1:size=1:start=0,settb=1/${fps},setpts=N` &&
            loop.input.length === 0 &&
            tally.record().ran.join() === "stills"
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The builder: where the loop sits in the chain and what the command says. Nothing here runs ffmpeg.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const CANVAS = { width: 108, height: 192, fps: 30 };
const project = (clips: Any[], canvas = CANVAS): Timeline =>
  ({ canvas, tracks: [{ id: "v", kind: "video", z: 0, clips }] }) as Timeline;
const picture = (extra: Record<string, unknown> = {}, seconds = 2, path = "/p0.jpg") => ({
  media_ref: path,
  source_in: 0,
  source_out: seconds,
  timeline_in: 0,
  timeline_out: seconds,
  fit: "cover",
  ...extra,
});
const zooming = (fit: string, seconds = 2, extra: Record<string, unknown> = {}) =>
  picture(
    {
      fit,
      transform: {
        position: { x: 0.5, y: 0.5 },
        scale: [
          { t: 0, v: 1 },
          { t: seconds, v: 1.2 },
        ],
      },
      ...extra,
    },
    seconds,
  );
const argsOf = (plan: { args: string[] }): string => plan.args.join(" ");

describe("the builder: a picture is read once and its fitted frame is repeated", () => {
  it("a fixed picture: 0.27.0 loops the input, the lean build reads the file once and repeats the frame right after the fit, before the clip's own frame rate step", () => {
    const t = project([picture()]);
    const base = buildRenderCommand(t, OUT);
    const lean = buildRenderCommand(t, OUT, { lean: { stills: true } } as Any);
    expect(argsOf(base)).toContain("-loop 1 -framerate 30 -t 2.000000 -i /p0.jpg");
    expect(argsOf(lean)).not.toContain("-loop");
    expect(argsOf(lean)).not.toContain("-framerate");
    expect(argsOf(lean)).toContain("-t 2.000000 -i /p0.jpg");
    expect(lean.filterComplex).toContain(
      "crop=108:192,loop=loop=-1:size=1:start=0,settb=1/30,setpts=N,trim=duration=2.000000,fps=fps=30:start_time=0",
    );
    expect(base.filterComplex).not.toContain("loop=loop");
    // the decoder cap's switch is not given here, so a picture read once also counts that as kept
    expect(lean.lean).toEqual({ ran: ["stills"], kept: ["flag_off"] });
    // The guard that refuses an image ffmpeg would loop on forever still sees this file.
    expect(lean.stillImages).toEqual(base.stillImages);
  });

  it("the held frame is the FITTED one for every fit (contain pads first, stretch scales first): the loop never sits before the fit", () => {
    for (const [fit, fitText] of [
      ["cover", "crop=108:192"],
      ["contain", "pad=108:192:(ow-iw)/2:(oh-ih)/2:color=black@0"],
      ["stretch", "scale=108:192"],
    ] as const) {
      const plan = buildRenderCommand(project([picture({ fit })]), OUT, {
        lean: { stills: true },
      } as Any);
      const graph = plan.filterComplex;
      const fitAt = graph.indexOf(fitText);
      const loopAt = graph.indexOf("loop=loop=-1:size=1:start=0");
      expect(fitAt, fit).toBeGreaterThan(-1);
      expect(loopAt, fit).toBeGreaterThan(fitAt);
      expect(graph.indexOf("fps=fps=30:start_time=0"), fit).toBeGreaterThan(loopAt);
    }
  });

  it("with the switch off, with the plain retry, or with no lean option at all, the command is 0.27.0's byte for byte", () => {
    const t = project([picture(), picture({ fit: "contain" }, 3, "/p1.png")]);
    const base = buildRenderCommand(t, OUT);
    for (const lean of [{ stills: false }, { stills: true, plain: true }] as const) {
      const plan = buildRenderCommand(t, OUT, { lean } as Any);
      expect(plan.args).toEqual(base.args);
      expect(plan.filterComplex).toBe(base.filterComplex);
    }
    expect(buildRenderCommand(t, OUT, { lean: { stills: false } } as Any).lean).toEqual({
      ran: [],
      kept: ["flag_off"],
    });
    expect(buildRenderCommand(t, OUT, { lean: { plain: true } } as Any).lean).toEqual({
      ran: [],
      kept: [],
    });
    expect(base.lean).toBeUndefined();
  });

  it("a video clip and an animated reader are not touched, and nothing is counted for them", () => {
    const video = {
      media_ref: "/v.mp4",
      source_in: 0,
      source_out: 2,
      timeline_in: 0,
      timeline_out: 2,
      fit: "cover",
    };
    const apng = picture({ still_reader: "apng" }, 2, "/anim.png");
    for (const clip of [video, apng]) {
      const t = project([clip]);
      const base = buildRenderCommand(t, OUT);
      const lean = buildRenderCommand(t, OUT, { lean: { stills: true } } as Any);
      expect(lean.args).toEqual(base.args);
      expect(lean.filterComplex).toBe(base.filterComplex);
      expect(lean.lean).toEqual({ ran: [], kept: [] });
    }
  });

  it("a zoom that contains its picture is bounded by its largest box and loops at once; a cover zoom asks ffmpeg first and loops after the pre-scale at the size it reports", () => {
    const contain = buildRenderCommand(project([zooming("contain")]), OUT, {
      lean: { stills: true, requests: [] },
    } as Any);
    expect(contain.lean).toEqual({ ran: ["stills"], kept: ["flag_off"] });
    expect(contain.filterComplex).toMatch(
      /force_original_aspect_ratio=decrease:force_divisible_by=2,loop=loop=-1:size=1:start=0,settb=1\/30,setpts=N,trim=duration=2\.000000,fps=fps=30/,
    );

    const t = project([zooming("cover")]);
    const asked: LeanOptions = { stills: true, requests: [] };
    const first = buildRenderCommand(t, OUT, { lean: asked } as Any);
    // (the zoom switch is off here, so the clip's aperture also counts as kept for that reason)
    expect(first.lean?.ran).toEqual([]);
    expect(first.lean?.kept).toContain("unknown_source");
    expect(first.filterComplex).not.toContain("loop=loop");
    expect(argsOf(first)).toContain("-loop 1 -framerate 30");
    expect(asked.requests).toHaveLength(1);
    const key = asked.requests?.[0].key ?? "";
    const probed = new Map<string, LeanProbed>([
      [key, { fmt: "yuvj420p", source: [4000, 3000], scaled: [288, 384] }],
    ]);
    const second = buildRenderCommand(t, OUT, { lean: { stills: true, probed } } as Any);
    expect(second.lean?.ran).toEqual(["stills"]);
    expect(second.lean?.kept).not.toContain("unknown_source");
    expect(second.filterComplex).toMatch(
      /force_original_aspect_ratio=increase:force_divisible_by=2,loop=loop=-1:size=1:start=0,settb=1\/30,setpts=N,trim=duration=2\.000000,fps=fps=30/,
    );
    expect(argsOf(second)).not.toContain("-loop");
  });

  it("zoom and stills together: the mask still takes the zoomed picture (a picture's own repeat is not an animated reader's loop), and both are on the record", () => {
    const t = project([zooming("cover")]);
    const asked: LeanOptions = { zoom: true, stills: true, requests: [] };
    buildRenderCommand(t, OUT, { lean: asked } as Any);
    expect(asked.requests).toHaveLength(1);
    const probed = new Map<string, LeanProbed>(
      (asked.requests ?? []).map((r) => [
        r.key,
        { fmt: "yuvj420p", source: [4000, 3000], scaled: [288, 384] },
      ]),
    );
    const plan = buildRenderCommand(t, OUT, { lean: { zoom: true, stills: true, probed } } as Any);
    expect(plan.lean).toEqual({ ran: ["zoom", "stills"], kept: ["flag_off"] });
    expect(plan.filterComplex).toContain("alphamerge");
    expect(plan.filterComplex).not.toContain("gte(X,(W-");
    expect(plan.filterComplex).toContain("loop=loop=-1:size=1:start=0");

    const apng = project([zooming("cover", 2, { still_reader: "apng" })]);
    const keep: LeanOptions = { zoom: true, stills: true, requests: [] };
    const held = buildRenderCommand(apng, OUT, { lean: keep } as Any);
    expect(held.lean?.ran).not.toContain("stills");
    expect(held.filterComplex).not.toContain("alphamerge");
  });

  it("a picture outside the exported range asks ffmpeg nothing and is not counted (a clip export of a longer project): the review's BUG-1", () => {
    const second = {
      ...zooming("cover", 2),
      timeline_in: 2,
      timeline_out: 4,
      media_ref: "/p1.jpg",
    };
    const t = project([zooming("cover"), second]);
    const asked: LeanOptions = { zoom: true, stills: true, requests: [] };
    buildRenderCommand(t, OUT, { range: { from: 0, to: 60 }, lean: asked } as Any);
    expect((asked.requests ?? []).map((r) => r.path)).toEqual(["/p0.jpg"]);

    const probed = new Map<string, LeanProbed>(
      (asked.requests ?? []).map((r) => [
        r.key,
        { fmt: "yuvj420p", source: [4000, 3000], scaled: [288, 384] },
      ]),
    );
    const inRange = buildRenderCommand(t, OUT, {
      range: { from: 0, to: 60 },
      lean: { zoom: true, stills: true, probed },
    } as Any);
    expect(inRange.args.join(" ")).not.toContain("/p1.jpg");
    expect(inRange.lean?.ran).toEqual(["zoom", "stills"]);
    expect(inRange.lean?.kept).not.toContain("unknown_source");
  });

  it("the loop's length is the input's length, for every frame rate and every length (property): the same frames as 0.27.0's `-t`", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(24, 25, 30, 50, 60),
        fc.integer({ min: 1, max: 400 }),
        fc.constantFrom(0.5, 1, 1.2, 2),
        (fps, frames, speed) => {
          const seconds = frames / fps;
          const clip = picture(
            { speed, timeline_out: seconds, source_out: seconds * speed },
            seconds,
          );
          const t = project([clip], { width: 108, height: 192, fps });
          const plan = buildRenderCommand(t, OUT, { lean: { stills: true } } as Any);
          const given = /-t (\d+\.\d+) -i \/p0\.jpg/.exec(argsOf(plan))?.[1];
          const held =
            /loop=loop=-1:size=1:start=0,settb=1\/\d+,setpts=N,trim=duration=(\d+\.\d+)/.exec(
              plan.filterComplex,
            )?.[1];
          return given !== undefined && given === held && plan.lean?.ran.join() === "stills";
        },
      ),
      { numRuns: 120 },
    );
  });
});
