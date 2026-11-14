import fc from "fast-check";
import { describe, expect, it } from "vitest";
import catalog from "../contract/catalog.json";
import type { LeanOptions } from "./leanOptions";
import { gradeStackIsFrameIndependent, leanGradeOnce, type GradeOnceRequest } from "./leanGrade";
import { LeanTally } from "./leanRecord";
import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const GRADE = [
  "exposure=exposure=0.0500",
  "eq=brightness=0.0000:contrast=1.0600:saturation=1.0400:gamma=1.0000",
  "colortemperature=temperature=6123.2",
  "vibrance=intensity=0.1000:threads=1",
  "curves=master='0/0 0.25/0.2560 0.75/0.7410 1/1'",
];

function request(over: Partial<GradeOnceRequest> = {}, lean: LeanOptions = { grade: true }) {
  const tally = new LeanTally();
  const req: GradeOnceRequest = { lean, tally, preAlpha: GRADE, heldOnce: true, ...over };
  return { req, tally };
}

describe("leanGradeOnce: a picture's grade and spatial effects on its one frame", () => {
  it("a stack of frame-independent filters on a picture held once runs before the repeat, and the record says grade ran", () => {
    const { req, tally } = request();
    expect(leanGradeOnce(req)).toBe(true);
    expect(tally.record()).toEqual({ ran: ["grade"], kept: [] });
  });

  it("one filter with memory, a clock, a frame count or random numbers keeps the whole stack where it is, named not_proven", () => {
    for (const bad of [
      "hqdn3d=4.0000",
      "noise=alls=15.0000:allf=t",
      "vignette=angle=0.4712",
      "tmix=frames=3",
      "chromakey=0x00FF00:0.3000:0.1000:threads=1",
      "geq=lum='lum(X,Y)'",
      "eq=brightness=T",
      "unsharp=a,b",
      "somefuturefilter=x=1",
    ]) {
      const { req, tally } = request({ preAlpha: [...GRADE, bad] });
      expect(leanGradeOnce(req), bad).toBe(false);
      expect(tally.record(), bad).toEqual({ ran: [], kept: ["not_proven"] });
    }
  });

  it("nothing to move, nothing held once, the switch off and the plain retry: today's place, counted only where a speed-up was really declined", () => {
    const none = request({ preAlpha: [] });
    expect(leanGradeOnce(none.req)).toBe(false);
    expect(none.tally.record()).toEqual({ ran: [], kept: [] });
    const notHeld = request({ heldOnce: false });
    expect(leanGradeOnce(notHeld.req)).toBe(false);
    expect(notHeld.tally.record()).toEqual({ ran: [], kept: [] });
    const off = request({}, { grade: false });
    expect(leanGradeOnce(off.req)).toBe(false);
    expect(off.tally.record()).toEqual({ ran: [], kept: ["flag_off"] });
    const plain = request({}, { grade: true, plain: true });
    expect(leanGradeOnce(plain.req)).toBe(false);
    expect(plain.tally.record()).toEqual({ ran: [], kept: [] });
  });

  it("a LUT path in the quoted form the builder writes for a path that needs escaping is accepted; an unquoted path with a separator or an expression is not", () => {
    expect(
      gradeStackIsFrameIndependent([
        "lut3d=file='C\\:/Users/a\\ b/look.cube'",
        "lut3d=file=/a/b.cube",
      ]),
    ).toBe(true);
    for (const bad of [
      "lut3d=file=a,b.cube",
      "lut3d=file='x'y'",
      "lut3d=file=a;b",
      "lut3d=interp=sin(t)",
    ])
      expect(gradeStackIsFrameIndependent([bad]), bad).toBe(false);
  });

  it("the allow-list is exact: every grade filter passes, and a name that merely starts like one does not (property)", () => {
    for (const filter of GRADE) expect(gradeStackIsFrameIndependent([filter])).toBe(true);
    fc.assert(
      fc.property(
        fc.constantFrom(
          "exposure",
          "eq",
          "colortemperature",
          "colorbalance",
          "vibrance",
          "colorlevels",
          "curves",
          "lut3d",
          "gblur",
          "unsharp",
        ),
        fc.string({ maxLength: 8 }).filter((s) => /^[a-z]+$/.test(s) && s.length > 0),
        (name, suffix) => {
          const params = name === "lut3d" ? "file=/x.cube" : "a=1";
          const ok = gradeStackIsFrameIndependent([`${name}=${params}`]);
          const lookalike = gradeStackIsFrameIndependent([`${name}${suffix}=${params}`]);
          return ok && !lookalike;
        },
      ),
      { numRuns: 120 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The builder: the stack moves in front of the repeat and nothing else changes. Nothing here runs ffmpeg.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const OUT = "/out.mp4";
const CANVAS = { width: 108, height: 192, fps: 30 };
const project = (clips: Any[]): Timeline =>
  ({ canvas: CANVAS, tracks: [{ id: "v", kind: "video", z: 0, clips }] }) as Timeline;
const picture = (extra: Record<string, unknown> = {}, seconds = 2) => ({
  media_ref: "/p0.jpg",
  source_in: 0,
  source_out: seconds,
  timeline_in: 0,
  timeline_out: seconds,
  fit: "cover",
  ...extra,
});
const LOOK = { exposure: 0.05, contrast: 1.06, saturation: 1.04, temperature: 6000, vibrance: 0.1 };
const chainOf = (graph: string): string =>
  graph.split(";").find((c) => c.startsWith("[0:v]")) ?? "";
const tokens = (chain: string): string[] => chain.replace(/\[[^\]]*\]/g, "").split(",");

describe("the builder: the grade of a held picture runs on its one frame", () => {
  it("the grade and the spatial effects come right after the fit and before the repeat; none is left behind after the clip's retiming stamps", () => {
    const t = project([
      picture({ color: LOOK, effects: [{ type: "blur", params: { radius: 6 } }] }),
    ]);
    const lean = buildRenderCommand(t, OUT, { lean: { stills: true, grade: true } } as Any);
    const chain = chainOf(lean.filterComplex);
    expect(chain).toMatch(
      /crop=108:192,exposure=exposure=0\.0500,eq=[^,]*,colortemperature=[^,]*,vibrance=intensity=0\.1000:threads=1,gblur=sigma=6\.0000,loop=loop=-1:size=1:start=0,settb=1\/30,setpts=N,trim=duration=2\.000000,fps=fps=30/,
    );
    const afterStamps = chain.slice(chain.indexOf("setpts=PTS-STARTPTS"));
    for (const name of ["exposure=", "eq=", "colortemperature=", "vibrance=", "gblur="])
      expect(afterStamps, name).not.toContain(name);
    expect(lean.lean).toEqual({ ran: ["stills", "grade"], kept: ["flag_off"] });
  });

  it("the switch off leaves the stack where 0.27.0 has it, and a stack with one per-frame filter stays whole: the graph is the picture-held-once graph, byte for byte", () => {
    const grade = project([picture({ color: LOOK })]);
    const heldOnly = buildRenderCommand(grade, OUT, { lean: { stills: true } } as Any);
    const off = buildRenderCommand(grade, OUT, { lean: { stills: true, grade: false } } as Any);
    expect(off.filterComplex).toBe(heldOnly.filterComplex);
    expect(off.lean?.kept).toContain("flag_off");
    expect(chainOf(off.filterComplex)).toMatch(/setpts=PTS-STARTPTS\+0,exposure=/);

    const vignette = project([
      picture({ color: LOOK, effects: [{ type: "vignette", params: {} }] }),
    ]);
    const kept = buildRenderCommand(vignette, OUT, { lean: { stills: true, grade: true } } as Any);
    const heldVignette = buildRenderCommand(vignette, OUT, { lean: { stills: true } } as Any);
    expect(kept.filterComplex).toBe(heldVignette.filterComplex);
    expect(kept.lean?.kept).toContain("not_proven");
    expect(kept.lean?.ran).not.toContain("grade");
  });

  it("a video clip and a picture that is read for every frame (fix 3 off) keep today's order", () => {
    const video = project([
      {
        media_ref: "/v.mp4",
        source_in: 0,
        source_out: 2,
        timeline_in: 0,
        timeline_out: 2,
        fit: "cover",
        color: LOOK,
      },
    ]);
    const base = buildRenderCommand(video, OUT);
    const lean = buildRenderCommand(video, OUT, { lean: { stills: true, grade: true } } as Any);
    expect(lean.filterComplex).toBe(base.filterComplex);
    expect(lean.lean).toEqual({ ran: [], kept: [] });

    const still = project([picture({ color: LOOK })]);
    const noHold = buildRenderCommand(still, OUT, { lean: { stills: false, grade: true } } as Any);
    expect(noHold.filterComplex).toBe(buildRenderCommand(still, OUT).filterComplex);
    expect(noHold.lean?.ran).toEqual([]);
  });

  it("moving the stack only moves it: the same filters, in the same order, for any look, speed and fade (property)", () => {
    const knob = fc.option(fc.double({ min: -0.5, max: 0.5, noNaN: true }), { nil: undefined });
    fc.assert(
      fc.property(
        fc.record({
          exposure: knob,
          brightness: knob,
          saturation: fc.option(fc.double({ min: 0.2, max: 1.8, noNaN: true }), { nil: undefined }),
          vibrance: knob,
          temperature: fc.option(fc.integer({ min: 2500, max: 9000 }), { nil: undefined }),
          blacks: knob,
          highlights: knob,
        }),
        fc.constantFrom(0.5, 1, 1.2, 2),
        fc.boolean(),
        (look, speed, fade) => {
          const color = Object.fromEntries(Object.entries(look).filter(([, v]) => v !== undefined));
          const t = project([
            picture({ color, speed, ...(fade ? { fade: { in: 0.2, out: 0.2 } } : {}) }),
          ]);
          const held = buildRenderCommand(t, OUT, { lean: { stills: true } } as Any);
          const once = buildRenderCommand(t, OUT, { lean: { stills: true, grade: true } } as Any);
          const a = tokens(chainOf(held.filterComplex));
          const b = tokens(chainOf(once.filterComplex));
          return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
        },
      ),
      { numRuns: 80 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The conformance walk: every video effect of the catalog is either moved (frame-independent) or kept per frame; a new effect fails here until somebody classifies it.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const MOVED = ["blur", "sharpen", "clarity"];
const PER_FRAME = ["denoise", "grain", "vignette", "motion", "chroma", "custom"];
/** Not a filter of the stack: the bloom is a sub-graph of its own that stays per frame after the repeat, so it neither blocks the move nor joins it. */
const OUTSIDE_THE_STACK = ["glow"];

describe("every video effect of the catalog is classified", () => {
  const effects = (catalog as { effects: Array<{ id: string; kind: string }> }).effects
    .filter((e) => e.kind === "video")
    .map((e) => e.id);

  it("no video effect is missing from the lists", () => {
    const unknown = effects.filter(
      (id) =>
        !MOVED.includes(id) &&
        !PER_FRAME.includes(id) &&
        !OUTSIDE_THE_STACK.includes(id) &&
        !["primaries", "levels", "wheels", "curves", "lut"].includes(id),
    );
    expect(unknown).toEqual([]);
  });

  it("each effect behaves as its list says on a held picture", () => {
    const params: Record<string, Record<string, unknown>> = {
      custom: { expr: "negate" },
      chroma: {},
    };
    for (const id of [...MOVED, ...PER_FRAME, ...OUTSIDE_THE_STACK]) {
      if (!effects.includes(id)) continue;
      const t = project([
        picture({ color: LOOK, effects: [{ type: id, params: params[id] ?? {} }] }),
      ]);
      const plan = buildRenderCommand(t, OUT, { lean: { stills: true, grade: true } } as Any);
      const moved = plan.lean?.ran.includes("grade") === true;
      expect(moved, id).toBe(!PER_FRAME.includes(id));
      if (!moved) expect(plan.lean?.kept, id).toContain("not_proven");
    }
  });

  it("an effect whose parameter is an expression is never moved, whatever its name (a custom effect's raw text)", () => {
    for (const expr of ["eq=brightness=sin(t)", "eq=brightness=T", "exposure=exposure=n/100"]) {
      const t = project([
        picture({ color: LOOK, effects: [{ type: "custom", params: { expr } }] }),
      ]);
      const plan = buildRenderCommand(t, OUT, { lean: { stills: true, grade: true } } as Any);
      expect(plan.lean?.ran, expr).not.toContain("grade");
      expect(plan.lean?.kept, expr).toContain("not_proven");
    }
  });
});
