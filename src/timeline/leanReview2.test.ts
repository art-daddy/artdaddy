// Evidence tests of helper h5's review of fixes 2, 3, 4b and 5 (Phase 3a). Each `describe` names the finding in REVIEW2.md it belongs to. A test that FAILS on the current code is
// the evidence of a defect (the comment above it says which); a test that passes shows a risk is covered or records what was measured. Nothing here runs ffmpeg or reaches the network.
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { colorKnobs } from "./effectRegistry";
import type { ExportOptions } from "./exportOptions";
import { cRound } from "./leanExpr";
import * as leanGrade from "./leanGrade";
import { gradeStackIsFrameIndependent } from "./leanGrade";
import type { LeanOptions } from "./leanOptions";
import * as leanStills from "./leanStills";
import type { Timeline } from "./model";
import { buildAudioRenderCommand, buildLeanRenderCommand, buildRenderCommand } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const OUT = "/out.mp4";
const CANVAS = { width: 192, height: 108, fps: 30 };
const project = (tracks: Any[], canvas = CANVAS): Timeline => ({ canvas, tracks }) as Timeline;
const videoTrack = (clips: Any[]) => ({ id: "v", kind: "video", z: 0, clips });
const picture = (
  path: string,
  tin: number,
  tout: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  media_ref: path,
  source_in: 0,
  source_out: tout - tin,
  timeline_in: tin,
  timeline_out: tout,
  fit: "cover",
  ...extra,
});
const zoomOf = (seconds: number) => ({
  position: { x: 0.5, y: 0.5 },
  scale: [
    { t: 0, v: 1 },
    { t: seconds, v: 1.3 },
  ],
});
const argsOf = (plan: { args: string[] }): string => plan.args.join(" ");

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// F-A. A picture outside the export's range is not part of that command, but fix 3 still asks ffmpeg about it and still counts it on the record.
// render.ts builds the Input of every still (and so calls leanPictureLoop) BEFORE the `if (rng) ... continue` that drops a clip outside the span; fix 1 asks from inside the per-clip
// loop that runs after it, so it does not have the problem.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("F-A: a picture outside the exported range is asked about and counted although it is not in the command", () => {
  // 6 s timeline: a clip in the first second, a cover-zoom picture far to the right of the range, a static picture beyond that
  const t = project([
    videoTrack([
      { media_ref: "/in.mp4", source_in: 0, source_out: 1, timeline_in: 0, timeline_out: 1 },
      picture("/far-zoom.jpg", 3, 5, { transform: zoomOf(2) }),
      picture("/far-fixed.jpg", 5, 6),
    ]),
  ]);
  const range = { from: 0, to: 30 };

  it("(control) the pictures really are not inputs of the ranged command, in 0.27.0's graph and in the lean one", () => {
    const base = buildRenderCommand(t, OUT, { range });
    const lean = buildRenderCommand(t, OUT, { range, lean: { stills: true, requests: [] } });
    for (const plan of [base, lean]) {
      expect(argsOf(plan)).toContain("/in.mp4");
      expect(argsOf(plan)).not.toContain("far-zoom");
      expect(argsOf(plan)).not.toContain("far-fixed");
    }
  });

  it("(control) fix 1 asks nothing for a zooming clip outside the range", () => {
    const zoomVideo = project([
      videoTrack([
        { media_ref: "/in.mp4", source_in: 0, source_out: 1, timeline_in: 0, timeline_out: 1 },
        {
          media_ref: "/far.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 3,
          timeline_out: 5,
          fit: "cover",
          transform: zoomOf(2),
        },
      ]),
    ]);
    const asked: LeanOptions = { zoom: true, requests: [] };
    buildRenderCommand(zoomVideo, OUT, { range, lean: asked });
    expect(asked.requests).toEqual([]);
  });

  it("DEFECT: no question is put to ffmpeg for a cover-zoom picture that is not in the command (today: one probe per such picture in the whole timeline, for every clip exported)", () => {
    const asked: LeanOptions = { stills: true, requests: [] };
    buildRenderCommand(t, OUT, { range, lean: asked });
    expect(asked.requests).toEqual([]);
  });

  it("DEFECT: the record names only what the command contains (today: stills ran and a reason is kept for pictures that are not inputs)", () => {
    const plan = buildRenderCommand(t, OUT, { range, lean: { stills: true, requests: [] } });
    expect(plan.lean).toEqual({ ran: [], kept: [] });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// F-B. Fix 4b's allow-list refuses the text colorFilters writes for a LUT file whose path needs escaping, so a graded picture with a LUT silently keeps its grade per frame.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("F-B: the grade of a held picture with a LUT", () => {
  const heldWith = (color: Record<string, unknown>) =>
    buildRenderCommand(project([videoTrack([picture("/p0.jpg", 0, 2, { color })])]), OUT, {
      lean: { stills: true, grade: true },
    });

  it("(control) a LUT with a plain path is moved before the repeat", () => {
    const plan = heldWith({ lut: "/luts/a.cube", exposure: 0.1 });
    expect(plan.lean?.ran).toContain("grade");
  });

  it("DEFECT: a LUT whose path needs escaping (a Windows drive letter, a space) is moved as well (today: not_proven, the fix is silently off for it)", () => {
    for (const lut of [
      "C:\\Users\\me\\AppData\\Roaming\\app\\library\\a.cube",
      "/Users/me/Library/Application Support/app/a.cube",
    ]) {
      const plan = heldWith({ lut, exposure: 0.1 });
      expect(plan.lean?.ran, lut).toContain("grade");
    }
  });

  it("(evidence, was the finding) the quoted form the builder writes for a path that needs escaping is accepted now, and a separator or an expression in the path is not", () => {
    expect(gradeStackIsFrameIndependent(["lut3d=file=/luts/a.cube"])).toBe(true);
    expect(gradeStackIsFrameIndependent(["lut3d=file='C\\:/Users/me/a.cube'"])).toBe(true);
    expect(gradeStackIsFrameIndependent(["lut3d=file=a,b.cube"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Q7. Every colour knob of the registry, on its own and all together, is accepted by the allow-list (a knob that is not would silently disable fix 4b for the clips that use it).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("Q7: every colour knob of the registry keeps fix 4b's allow-list satisfied", () => {
  const knobs: Record<string, unknown> = {
    exposure: 0.3,
    brightness: 0.1,
    contrast: 1.2,
    saturation: 1.3,
    gamma: 1.1,
    vibrance: 0.3,
    temperature: 5000,
    tint: 0.2,
    highlights: -0.2,
    shadows: 0.2,
    blacks: 0.1,
    whites: -0.1,
    shadowsHue: 200,
    shadowsAmount: 0.3,
    shadowsLum: 0.1,
    midsHue: 30,
    midsAmount: 0.3,
    midsGamma: 1.2,
    highsHue: 50,
    highsAmount: 0.3,
    highsGain: 0.9,
    masterCurve: [
      [0, 0],
      [0.5, 0.6],
      [1, 1],
    ],
    redCurve: [
      [0, 0],
      [1, 0.9],
    ],
    greenCurve: [
      [0, 0],
      [1, 0.9],
    ],
    blueCurve: [
      [0, 0],
      [1, 0.9],
    ],
    lut: "/luts/a.cube",
  };
  const held = (color: Record<string, unknown>) =>
    buildRenderCommand(project([videoTrack([picture("/p0.jpg", 0, 2, { color })])]), OUT, {
      lean: { stills: true, grade: true },
    });

  /** The filters 0.27.0 writes after the clip's retiming stamps (a plain static picture has nothing after its grade): empty when the knob alone writes no filter (a hue without an amount). */
  const stackOf = (color: Record<string, unknown>): string[] => {
    const base = buildRenderCommand(
      project([videoTrack([picture("/p0.jpg", 0, 2, { color })])]),
      OUT,
    );
    const chain = base.filterComplex.split(";").find((c) => c.startsWith("[0:v]")) ?? "";
    const tokens = chain.replace(/\[[^\]]*\]/g, "").split(",");
    return tokens.slice(tokens.findIndex((t) => t.startsWith("setpts=PTS-STARTPTS")) + 1);
  };

  it("the list below is the registry's (a new knob fails here until it is listed)", () => {
    expect(colorKnobs().sort()).toEqual(Object.keys(knobs).sort());
  });

  it("each knob alone, and every knob together: whenever it writes a filter, the stack is moved before the repeat", () => {
    let moved = 0;
    for (const [name, value] of Object.entries(knobs)) {
      const stack = stackOf({ [name]: value });
      const plan = held({ [name]: value });
      expect(plan.lean?.kept, name).not.toContain("not_proven");
      if (stack.length > 0) {
        expect(plan.lean?.ran, name).toContain("grade");
        moved += 1;
      } else expect(plan.lean?.ran, name).not.toContain("grade");
    }
    // 27 knobs; the three hues and one amount-less wheel write nothing alone
    expect(moved).toBeGreaterThanOrEqual(22);
    expect(held(knobs).lean?.ran).toContain("grade");
  });

  it("negative values, zero-ish values and the extremes of every numeric knob, and curves that leave the unit square, are printed in a form the allow-list reads", () => {
    for (const [name, value] of Object.entries(knobs)) {
      if (typeof value !== "number") continue;
      for (const v of [-1, -0.0001, 0.00001, 1e-7, 3, 100, -100, 40000]) {
        // a knob at a value that writes no filter has nothing to move and counts nothing; one that does write a filter must be moved
        expect(held({ [name]: v }).lean?.kept, `${name}=${v}`).not.toContain("not_proven");
      }
    }
    for (const name of ["masterCurve", "redCurve", "greenCurve", "blueCurve"]) {
      const points = [
        [0, -0.2],
        [0.5, 1.5],
        [1, 0],
      ];
      const plan = held({ [name]: points });
      expect(plan.lean?.ran, name).toContain("grade");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// F-C. heldFrameOf (and the probe it asks) ignore the clip's crop: a cover zoom of a CROPPED picture is pre-scaled from the cropped picture, whose size ffmpeg was not asked about.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("F-C: a cover-zoom picture with a crop", () => {
  const cropped = (left: number) =>
    project([
      videoTrack([
        picture("/p0.jpg", 0, 2, {
          transform: zoomOf(2),
          crop: { left, right: left, top: 0, bottom: 0 },
        }),
      ]),
    ]);

  it("the answer to the finding: a cover zoom of a cropped picture is not held (the probe's question has no crop, so its answer is not the size that would be held): no question, today's read, named not_proven", () => {
    const asked: LeanOptions = { stills: true, requests: [] };
    const first = buildRenderCommand(cropped(0.45), OUT, { lean: asked });
    expect(asked.requests).toHaveLength(0);
    expect(first.lean?.kept).toContain("not_proven");
    expect(first.lean?.ran).not.toContain("stills");
    expect(argsOf(first)).toContain("-loop 1 -framerate");
  });

  it("(control) a cropped picture in a fixed box is fitted to exactly its box whatever the crop, so it is held, with the crop in front of the repeat in the graph", () => {
    const t = project([
      videoTrack([
        picture("/p0.jpg", 0, 2, { crop: { left: 0.2, right: 0.2, top: 0, bottom: 0 } }),
      ]),
    ]);
    const plan = buildRenderCommand(t, OUT, { lean: { stills: true } });
    expect(plan.lean?.ran).toContain("stills");
    const chain = plan.filterComplex.split(";").find((c) => c.startsWith("[0:v]")) ?? "";
    expect(chain.indexOf("crop=iw*")).toBeGreaterThan(-1);
    expect(chain.indexOf("crop=iw*")).toBeLessThan(chain.indexOf("loop=loop"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Q2. The frame count of the picture stream: 0.27.0's `-t D` on a `-loop 1 -framerate F` input against the lean `loop` + `settb=1/F,setpts=N` + `trim=duration=D`.
// A MODEL of two ways ffmpeg can apply the input's `-t` (nothing here knows which one the pinned binary uses):
//   (A) the demuxer cuts at the first packet whose dts, rescaled to microseconds with rounding to nearest, is at least D;
//   (B) a `trim` at the graph input compares the exact frame time with D (what `trim=duration` after `setpts=N` does in the lean graph).
// Under (B) the two builds agree for every D; under (A) the lean stream has ONE MORE frame whenever D, printed to 6 decimals, is a hair above a frame time.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("Q2: frame counts of a held picture against 0.27.0's, for fps 24 25 30 50 60, speeds 0.5 1 1.2 2 and clip lengths of 1 to 240 frames", () => {
  const countA = (fps: number, durationUs: number): number => {
    let n = 0;
    while (cRound((n * 1e6) / fps) < durationUs) n += 1;
    return n;
  };
  const countB = (fps: number, durationUs: number): number => {
    let n = 0;
    while (n * 1e6 < durationUs * fps) n += 1;
    return n;
  };
  const lengthOf = (fps: number, speed: number, frames: number): number => {
    const seconds = frames / fps;
    const t = project([videoTrack([picture("/p0.jpg", 0, seconds, { speed, fit: "cover" })])], {
      width: 192,
      height: 108,
      fps,
    });
    const plan = buildRenderCommand(t, OUT, { lean: { stills: true } });
    const given = /-t (\d+\.\d+) -i \/p0\.jpg/.exec(argsOf(plan))?.[1];
    const held = /setpts=N,trim=duration=(\d+\.\d+)/.exec(plan.filterComplex)?.[1];
    expect(given).toBe(held);
    return Math.round(Number(given) * 1e6);
  };

  it("the exact count is never below 0.27.0's and exceeds it by at most one frame; where it does, the clip's frame time is within half a microsecond below D", () => {
    const byShape = new Map<string, number>();
    const first: string[] = [];
    let cases = 0;
    let extra = 0;
    for (const fps of [24, 25, 30, 50, 60]) {
      for (const speed of [0.5, 1, 1.2, 2]) {
        for (let frames = 1; frames <= 240; frames++) {
          const us = lengthOf(fps, speed, frames);
          const a = countA(fps, us);
          const b = countB(fps, us);
          cases += 1;
          expect(b - a === 0 || b - a === 1, `${fps} fps, speed ${speed}, ${frames} frames`).toBe(
            true,
          );
          if (b !== a) {
            extra += 1;
            byShape.set(`${fps}fps x${speed}`, (byShape.get(`${fps}fps x${speed}`) ?? 0) + 1);
            if (first.length < 6) first.push(`${fps}/${speed}/${frames}`);
          }
        }
      }
    }
    // measured, for the report: how many of the 4,800 (fps, speed, length) shapes would carry an extra trailing frame under model (A)
    console.info(
      `h5 Q2: ${extra} of ${cases} shapes differ under model (A): ${[...byShape].map(([k, n]) => `${k}: ${n}`).join("; ")}; first ${first.join(" ")}`,
    );
    expect(cases).toBe(4800);
  });

  it("the two models agree for every clip whose fps divides a million (25 and 50): no difference is possible there", () => {
    for (const fps of [25, 50]) {
      for (const speed of [0.5, 1, 1.2, 2]) {
        for (let frames = 1; frames <= 240; frames++) {
          const us = lengthOf(fps, speed, frames);
          expect(countA(fps, us), `${fps}/${speed}/${frames}`).toBe(countB(fps, us));
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Fix 2 (BRIEF-fix2 questions 1, 2, 7). A second evaluator, written here by translating the emitted ffmpeg expression text into JavaScript (NOT leanExpr.ts, which the windows use), runs every
// windowed `geq` the builder writes over a wide grid: all eight frame rates (the builder truncates 23.976, 29.97 and 59.94 to 23, 29 and 59), cuts on and between frames, transitions of
// 1 to 30 frames plus a hair either way, every kind, with a fade and an animated opacity on the same clip. A frame whose factor is not exactly 1 must have its window open.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
type Env = { T: number; X?: number; W?: number };
const FF = {
  lt: (a: number, b: number) => (a < b ? 1 : 0),
  lte: (a: number, b: number) => (a <= b ? 1 : 0),
  gt: (a: number, b: number) => (a > b ? 1 : 0),
  gte: (a: number, b: number) => (a >= b ? 1 : 0),
  between: (x: number, lo: number, hi: number) => (x >= lo && x <= hi ? 1 : 0),
  _if: (c: number, a: number, b: number) => (c !== 0 ? a : b),
  clip: (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x),
  min: (a: number, b: number) => (a > b ? b : a),
  max: (a: number, b: number) => (a > b ? a : b),
  pow: Math.pow,
  round: (x: number) => Math.sign(x) * Math.round(Math.abs(x)),
  floor: Math.floor,
  ceil: Math.ceil,
  abs: Math.abs,
};
/** ffmpeg expression text -> a function, by translation into JavaScript source (`alpha(X,Y)` is 1, `if` is renamed, `T--0.25` is T - -0.25). */
function translated(text: string): (env: Env) => number {
  const body = text
    .replace(/alpha\(X,Y\)/g, "1")
    .replace(/\bif\(/g, "_if(")
    .replace(/--/g, "- -");
  // Test-only: a translation of the emitted text into JavaScript, so that it is judged by an evaluator that is not leanExpr.ts.
  const fn = new Function(
    "e",
    "f",
    `const {T,X,W}=e; const t=T; const {lt,lte,gt,gte,between,_if,clip,min,max,pow,round,floor,ceil,abs}=f; return (${body});`,
  );
  return (env) => fn({ X: 0, W: 1, ...env }, FF) as number;
}

const GEQ_ALPHA =
  /geq=lum='lum\(X,Y\)':cb='cb\(X,Y\)':cr='cr\(X,Y\)':a='(alpha\(X,Y\)\*[^']*)'(?::enable='([^']*)')?/g;
const fpsOfGraph = (graph: string): number =>
  Number(/color=c=black:s=\d+x\d+:r=(\d+)/.exec(graph)?.[1]);

describe("fix 2: every window over a wide grid, judged by a second evaluator", () => {
  const KINDS = ["crossfade", "whip", "wipe-l", "wipe-r", "dip-to-black", "dip-to-white", "custom"];
  const RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  const grid = (rate: number, cut: number, frames: number, hair: number, kind: string) => {
    const fps = Math.trunc(rate);
    const tin = cut / fps;
    const clip = (path: string, a: number, b: number, extra: Record<string, unknown> = {}) => ({
      media_ref: path,
      source_in: 0,
      source_out: b - a,
      timeline_in: a,
      timeline_out: b,
      ...extra,
    });
    const second = clip("/c1.mp4", tin, tin + 3, {
      transition_in: { kind, duration: frames / fps + hair },
      fade: { in: 7, out: 9 },
      opacity: [
        { t: 0, v: 1 },
        { t: 0.5, v: 0.4, ease: "ease-in-out" },
        { t: 1.1, v: 1 },
        { t: 2, v: 0.7, ease: "ease-out" },
      ],
    });
    const clips = cut > 0 ? [clip("/c0.mp4", 0, tin), second] : [second];
    return {
      fps,
      tin,
      project: project([videoTrack(clips)], { width: 1920, height: 1080, fps: rate }),
    };
  };

  it("no frame whose factor differs from 1 has its window closed, for any rate, cut, length, hair and kind (wipe-right is judged on the columns that still change)", () => {
    let windows = 0;
    let evaluated = 0;
    for (const rate of RATES) {
      for (const cut of [0, 60, 60.5, 61, 90.25]) {
        for (const frames of [1, 2, 3, 4, 5, 8, 15, 30]) {
          for (const hair of [0, 1e-7]) {
            for (const kind of KINDS) {
              const g = grid(rate, cut, frames, hair, kind);
              const plan = buildRenderCommand(g.project, OUT, { lean: { fades: true } });
              const fps = fpsOfGraph(plan.filterComplex);
              expect(fps).toBe(g.fps);
              const total = Math.ceil((g.tin + 3) * fps);
              for (const m of plan.filterComplex.matchAll(GEQ_ALPHA)) {
                const factor = translated(m[1]);
                const window = m[2] === undefined ? null : translated(m[2]);
                const wipeRight = m[1].includes("gt(X,W*(1-");
                for (let k = -8; k <= total + 8; k++) {
                  const T = k / fps;
                  let changes = false;
                  for (const W of [2, 1920])
                    for (const X of wipeRight ? [1, W >> 1, W - 1] : [0, 1, W >> 1, W - 1])
                      if (factor({ T, W, X }) !== 1) changes = true;
                  evaluated += 1;
                  if (changes && window)
                    expect(
                      window({ T }),
                      `${kind} ${rate} fps cut ${cut} dur ${frames}+${hair}: ${m[1]} at frame ${k}, window ${m[2]}`,
                    ).not.toBe(0);
                }
                if (window) windows += 1;
              }
            }
          }
        }
      }
    }
    console.info(`h5 fix2 grid: ${windows} windowed geq filters, ${evaluated} frames judged`);
    expect(windows).toBeGreaterThan(8000);
  }, 170_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Fix 2 (BRIEF-fix2 question 3): the dip's short colour layer must exist on every frame the overlay's gate opens on, inside the command's base canvas, in the one-pass command and in every
// part of a streamed export; where it is dropped, the 0.27.0 gate must open on no frame of that command.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
interface Dip {
  layer: { from: number; count: number } | null;
  gate: { first: number; last: number };
}
interface Commandline {
  base: { from: number; count: number };
  dips: Map<number, Dip>;
}

function graphsOf(plan: ReturnType<typeof buildRenderCommand>): string[] {
  if (!plan.steps) return [plan.filterComplex];
  return plan.steps.map((step) => {
    const at = step.args.indexOf("-/filter_complex");
    const file = plan.assFiles.find((f) => f.name === step.args[at + 1]);
    return file?.content ?? "";
  });
}

function commandline(graph: string): Commandline {
  const fps = fpsOfGraph(graph);
  const base = /^color=c=black:s=\d+x\d+:r=\d+:d=([\d.]+)(?:,setpts=PTS\+(\d+))?\[base\]/.exec(
    graph,
  );
  if (!base) throw new Error(`no base canvas in ${graph.slice(0, 120)}`);
  const dips = new Map<number, Dip>();
  const gates = [
    ...graph.matchAll(
      /overlay=x=0:y=0:enable='between\(t,(-?[\d.]+),(-?[\d.]+)\)':eof_action=pass\[dipov(\d+)\]/g,
    ),
  ];
  const layers = new Map(
    [
      ...graph.matchAll(
        /color=c=black:s=\d+x\d+:r=\d+:d=([\d.]+)(?:,setpts=PTS\+(\d+))?,format=rgba,geq=r='(?:0|255)'[^;]*\[dip(\d+)\]/g,
      ),
    ].map((m) => [
      Number(m[3]),
      { from: Number(m[2] ?? 0), count: Math.ceil(Number(m[1]) * fps - 1e-9) },
    ]),
  );
  for (const g of gates)
    dips.set(Number(g[3]), {
      layer: layers.get(Number(g[3])) ?? null,
      gate: {
        first: Math.ceil(Number(g[1]) * fps - 1e-9),
        last: Math.floor(Number(g[2]) * fps + 1e-9),
      },
    });
  return {
    base: { from: Number(base[2] ?? 0), count: Math.ceil(Number(base[1]) * fps - 1e-9) },
    dips,
  };
}

describe("fix 2: the dip's colour layer covers the overlay gate (frame by frame, from the emitted text)", () => {
  const clip = (path: string, a: number, b: number, extra: Record<string, unknown> = {}) => ({
    media_ref: path,
    source_in: 0,
    source_out: b - a,
    timeline_in: a,
    timeline_out: b,
    ...extra,
  });
  const dip = (duration: number, kind = "dip-to-black") => ({ transition_in: { kind, duration } });
  const projects: Record<string, Timeline> = {
    "a dip on the very first clip": project([videoTrack([clip("/a.mp4", 0, 3, dip(1))])]),
    "a dip at the very end of the project": project([
      videoTrack([clip("/a.mp4", 0, 2), clip("/b.mp4", 2, 2.6, dip(1))]),
    ]),
    "two dips 0.3 s apart": project([
      videoTrack([
        clip("/a.mp4", 0, 2),
        clip("/b.mp4", 2, 2.3, dip(0.2, "dip-to-white")),
        clip("/c.mp4", 2.3, 4, dip(0.2)),
      ]),
    ]),
    "a dip ten times longer than the project": project([
      videoTrack([clip("/a.mp4", 0, 1), clip("/b.mp4", 1, 2, dip(10))]),
    ]),
    "a one-frame dip": project([
      videoTrack([clip("/a.mp4", 0, 1), clip("/b.mp4", 1, 2, dip(1 / 30))]),
    ]),
  };
  const long: Timeline = project([
    videoTrack([
      clip("/a.mp4", 0, 64),
      clip("/b.mp4", 64, 66, dip(2)),
      clip("/c.mp4", 66, 100),
      clip("/d.mp4", 100, 102, dip(1, "dip-to-white")),
      clip("/e.mp4", 102, 130),
    ]),
  ]);

  function covered(t: Timeline, engine: "partition-pipes-v1" | undefined, label: string) {
    const plain = buildRenderCommand(t, OUT, { ...(engine ? { engine } : {}) });
    const lean = buildRenderCommand(t, OUT, { ...(engine ? { engine } : {}), lean: { dip: true } });
    const was = graphsOf(plain).map(commandline);
    const now = graphsOf(lean).map(commandline);
    expect(now.length, label).toBe(was.length);
    let dips = 0;
    now.forEach((cmd, i) => {
      expect(cmd.base, `${label} part ${i} base canvas`).toEqual(was[i].base);
      for (const [n, old] of was[i].dips) {
        const have = cmd.dips.get(n);
        const frames: number[] = [];
        for (let k = old.gate.first; k <= old.gate.last; k++)
          if (k >= cmd.base.from && k < cmd.base.from + cmd.base.count) frames.push(k);
        if (!have) {
          // the layer and its overlay were dropped: the 0.27.0 gate must open on no frame of this command
          expect(
            frames,
            `${label} part ${i} dip ${n} dropped though its gate opens on ${frames}`,
          ).toEqual([]);
          continue;
        }
        dips += 1;
        expect(have.gate, `${label} part ${i} dip ${n}: the overlay's gate is 0.27.0's`).toEqual(
          old.gate,
        );
        expect(have.layer, `${label} part ${i} dip ${n} has a layer`).not.toBeNull();
        for (const k of frames) {
          expect(k, `${label} part ${i} dip ${n} frame ${k}`).toBeGreaterThanOrEqual(
            have.layer!.from,
          );
          expect(k, `${label} part ${i} dip ${n} frame ${k}`).toBeLessThan(
            have.layer!.from + have.layer!.count,
          );
        }
        // and the layer never leaves the base canvas
        expect(have.layer!.from).toBeGreaterThanOrEqual(cmd.base.from);
        expect(have.layer!.from + have.layer!.count).toBeLessThanOrEqual(
          cmd.base.from + cmd.base.count,
        );
      }
    });
    return dips;
  }

  it("one-pass and streamed, on the hand-made shapes", () => {
    for (const [name, t] of Object.entries(projects)) {
      expect(covered(t, undefined, `${name} (one-pass)`), name).toBeGreaterThan(0);
      covered(t, "partition-pipes-v1", `${name} (streamed)`);
    }
  });

  it("a 130 s project cut into parts: a dip straddling a cut (65 s), and a dip in the middle of one part, are covered in every part they touch", () => {
    const dips = covered(long, "partition-pipes-v1", "130 s streamed");
    expect(dips).toBeGreaterThanOrEqual(2);
    const parts = graphsOf(
      buildRenderCommand(long, OUT, { engine: "partition-pipes-v1", lean: { dip: true } }),
    ).map(commandline);
    expect(parts.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Q6 and Q11. Composition: with 0.27.0 (no lean option) as the reference, over random mixed projects (pictures, video, sound, transitions, fades, opacity, grades, effects, zoom, speed,
// rotation, branding, one-pass and streamed, a range or not):
//   every switch off  = the reference, byte for byte (only the record differs, and it holds nothing but flag_off);
//   each of fixes 2, 3 and 5 on alone = the reference plus exactly its own edit (the windows, the repeat and its option change, the thread caps), nothing else;
//   fix 4b on top of fix 3 = the same filters, only moved.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
type Plan = ReturnType<typeof buildRenderCommand>;
const ALL_OFF: LeanOptions = {
  zoom: false,
  fades: false,
  dip: false,
  stills: false,
  grade: false,
  decoders: false,
};
const stripWindows = (s: string): string =>
  s.replace(/(a='alpha\(X,Y\)\*[^']*')(:enable='[^']*')/g, "$1");
const TAIL = /loop=loop=-1:size=1:start=0,settb=1\/\d+,setpts=N,trim=duration=[\d.]+,/g;
function canon(plan: Plan, strip: { windows?: boolean; caps?: boolean; loops?: boolean }): string {
  let removedLoops = 0;
  const args = (list: readonly string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < list.length; i++) {
      if (strip.caps && list[i] === "-threads:v" && list[i + 1] === "1") {
        i += 1;
        continue;
      }
      if (
        strip.loops &&
        list[i] === "-loop" &&
        list[i + 1] === "1" &&
        list[i + 2] === "-framerate"
      ) {
        i += 3;
        removedLoops += 1;
        continue;
      }
      out.push(list[i]);
    }
    return out;
  };
  const text = (s: string): string => {
    let t = strip.windows ? stripWindows(s) : s;
    if (strip.loops) t = t.replace(TAIL, "");
    return t;
  };
  const { lean: _lean, args: a, steps, assFiles, filterComplex, ...rest } = plan;
  void _lean;
  return JSON.stringify({
    ...rest,
    filterComplex: text(filterComplex),
    args: args(a).map(text),
    steps: steps?.map((s) => ({ ...s, args: args(s.args).map(text) })),
    files: assFiles.map((f) => [f.name, text(f.content)]),
    removedLoops,
  });
}
const loopsOf = (plan: Plan): number =>
  Number(JSON.parse(canon(plan, { loops: true })).removedLoops);
const tailsOf = (plan: Plan): number =>
  [
    plan.filterComplex,
    ...plan.assFiles.map((f) => f.content),
    ...(plan.steps ?? []).flatMap((s) => s.args),
  ]
    .join("\n")
    .split("loop=loop=-1:size=1:start=0,settb=1/").length - 1;

const MIXED_KINDS = ["crossfade", "whip", "wipe-l", "wipe-r", "dip-to-black", "dip-to-white"];
const knob = fc.option(fc.double({ min: -0.5, max: 0.5, noNaN: true }), { nil: undefined });
const clipArb = fc.record({
  media: fc.constantFrom("video", "jpg", "png"),
  frames: fc.integer({ min: 5, max: 70 }),
  fit: fc.constantFrom("cover", "contain", "stretch"),
  zoom: fc.constantFrom(false, false, true),
  transition: fc.option(
    fc.record({ kind: fc.constantFrom(...MIXED_KINDS), frames: fc.integer({ min: 1, max: 12 }) }),
    { nil: undefined },
  ),
  fade: fc.option(
    fc.record({ in: fc.integer({ min: 0, max: 10 }), out: fc.integer({ min: 0, max: 10 }) }),
    { nil: undefined },
  ),
  opacity: fc.boolean(),
  grade: fc.option(
    fc.record({
      exposure: knob,
      contrast: fc.option(fc.double({ min: 0.5, max: 1.5, noNaN: true }), { nil: undefined }),
      vibrance: knob,
      temperature: fc.option(fc.integer({ min: 2500, max: 9000 }), { nil: undefined }),
    }),
    { nil: undefined },
  ),
  effect: fc.option(
    fc.constantFrom("blur", "sharpen", "vignette", "grain", "chroma", "denoise", "clarity", "glow"),
    { nil: undefined },
  ),
  speed: fc.constantFrom(1, 1, 0.5, 1.2, 2),
  rotate: fc.constantFrom(undefined, undefined, 12),
});
const mixedArb = fc.record({
  fps: fc.constantFrom(24, 25, 30, 60),
  clips: fc.array(clipArb, { minLength: 1, maxLength: 4 }),
  sounds: fc.integer({ min: 0, max: 2 }),
  streamed: fc.boolean(),
  branding: fc.boolean(),
  range: fc.option(fc.tuple(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 41, max: 200 })), {
    nil: undefined,
  }),
});
type ValueOf<A> = A extends fc.Arbitrary<infer T> ? T : never;
type Mixed = ValueOf<typeof mixedArb>;

function assemble(m: Mixed): { t: Timeline; options: ExportOptions } {
  let at = 0;
  const clips = m.clips.map((c, i) => {
    const seconds = c.frames / m.fps;
    const color = c.grade
      ? Object.fromEntries(Object.entries(c.grade).filter(([, v]) => v !== undefined))
      : undefined;
    const clip: Record<string, unknown> = {
      media_ref: c.media === "video" ? `/c${i}.mp4` : `/c${i}.${c.media}`,
      source_in: 0,
      source_out: seconds * c.speed,
      timeline_in: at,
      timeline_out: at + seconds,
      fit: c.fit,
      speed: c.speed,
      ...(c.zoom
        ? {
            transform: {
              position: { x: 0.5, y: 0.5 },
              scale: [
                { t: 0, v: 1 },
                { t: seconds, v: 1.3 },
              ],
            },
          }
        : {}),
      ...(c.transition
        ? { transition_in: { kind: c.transition.kind, duration: c.transition.frames / m.fps } }
        : {}),
      ...(c.fade ? { fade: c.fade } : {}),
      ...(c.opacity
        ? {
            opacity: [
              { t: 0, v: 1 },
              { t: seconds / 2, v: 0.5 },
              { t: seconds, v: 1 },
            ],
          }
        : {}),
      ...(color && Object.keys(color).length ? { color } : {}),
      ...(c.effect
        ? {
            effects: [
              { type: c.effect, params: c.effect === "chroma" ? { color: "#00FF00" } : {} },
            ],
          }
        : {}),
      ...(c.rotate ? { rotate: c.rotate } : {}),
    };
    at += seconds;
    return clip;
  });
  const sounds = Array.from({ length: m.sounds }, (_, i) => ({
    id: `s${i}`,
    kind: "audio",
    media_ref: `/s${i}.mp3`,
    source_in: 0,
    source_out: at,
    timeline_in: 0,
    timeline_out: at,
  }));
  const t = project(
    [
      videoTrack(clips),
      ...(sounds.length ? [{ id: "a", kind: "audio", z: 0, clips: sounds }] : []),
    ],
    { width: 192, height: 108, fps: m.fps },
  );
  const total = Math.ceil(at * m.fps);
  return {
    t,
    options: {
      ...(m.streamed ? { engine: "partition-pipes-v1" as const } : {}),
      ...(m.branding
        ? { branding: { watermark: "/wm.png", endcard: "/ec.mp4", endcardDuration: 2 } }
        : {}),
      ...(m.range && m.range[0] < total
        ? { range: { from: m.range[0], to: Math.min(total, m.range[1]) } }
        : {}),
    },
  };
}

function attempt<T>(f: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

describe("composition: each switch alone is the reference plus its own edit (random mixed projects)", () => {
  it("every switch off is 0.27.0 byte for byte, and its record holds only flag_off", () => {
    let built = 0;
    fc.assert(
      fc.property(mixedArb, (m) => {
        const { t, options } = assemble(m);
        const ref = attempt(() => buildRenderCommand(t, OUT, options));
        const off = attempt(() => buildRenderCommand(t, OUT, { ...options, lean: ALL_OFF }));
        expect(off.ok, ref.ok ? "" : `reference refused: ${ref.error}`).toBe(ref.ok);
        if (!ref.ok || !off.ok) return;
        built += 1;
        expect(canon(off.value, {})).toBe(canon(ref.value, {}));
        expect(off.value.lean?.ran).toEqual([]);
        for (const word of off.value.lean?.kept ?? []) expect(word).toBe("flag_off");
      }),
      { numRuns: 250, seed: 20261115 },
    );
    expect(built).toBeGreaterThan(100);
  }, 120_000);

  it("fix 5 alone changes nothing (no picture is held without fix 3) and with fix 3 adds `-threads:v 1` before each held picture and nothing else on the one-pass engine; fix 2 alone adds only enable windows and a shorter dip layer", () => {
    let capped = 0;
    let windowed = 0;
    const threadsV = (plan: Plan): number =>
      [plan.args, ...(plan.steps ?? []).map((s) => s.args)].reduce(
        (n, list) => n + list.filter((a, i) => a === "-threads:v" && list[i + 1] === "1").length,
        0,
      );
    fc.assert(
      fc.property(mixedArb, (m) => {
        const { t, options } = assemble(m);
        const ref = attempt(() => buildRenderCommand(t, OUT, options));
        const dec = attempt(() =>
          buildRenderCommand(t, OUT, { ...options, lean: { ...ALL_OFF, decoders: true } }),
        );
        const held = attempt(() =>
          buildRenderCommand(t, OUT, { ...options, lean: { ...ALL_OFF, stills: true } }),
        );
        const both = attempt(() =>
          buildRenderCommand(t, OUT, {
            ...options,
            lean: { ...ALL_OFF, stills: true, decoders: true },
          }),
        );
        const fades = attempt(() =>
          buildRenderCommand(t, OUT, { ...options, lean: { ...ALL_OFF, fades: true } }),
        );
        if (!ref.ok) return;
        expect(dec.ok && held.ok && both.ok && fades.ok).toBe(true);
        if (!dec.ok || !held.ok || !both.ok || !fades.ok) return;
        expect(canon(dec.value, {})).toBe(canon(ref.value, {}));
        expect(dec.value.lean?.ran).toEqual([]);
        expect(canon(both.value, { caps: true })).toBe(canon(held.value, { caps: true }));
        const streamed = (options as { engine?: string }).engine === "partition-pipes-v1";
        expect(threadsV(both.value) - threadsV(held.value)).toBe(
          streamed ? 0 : tailsOf(held.value),
        );
        expect(canon(fades.value, { windows: true })).toBe(canon(ref.value, {}));
        if (both.value.lean?.ran.includes("decoders")) capped += 1;
        if (fades.value.lean?.ran.includes("fades")) windowed += 1;
      }),
      { numRuns: 250, seed: 20261116 },
    );
    expect(capped).toBeGreaterThan(20);
    expect(windowed).toBeGreaterThan(40);
  }, 120_000);

  it("fix 3 alone replaces each held picture's `-loop 1 -framerate` by exactly one repeat in the graph (no probe answers: a cover zoom keeps today's read)", () => {
    let held = 0;
    fc.assert(
      fc.property(mixedArb, (m) => {
        const { t, options } = assemble(m);
        const ref = attempt(() => buildRenderCommand(t, OUT, options));
        const lean = attempt(() =>
          buildRenderCommand(t, OUT, { ...options, lean: { ...ALL_OFF, stills: true } }),
        );
        if (!ref.ok) return;
        expect(lean.ok).toBe(true);
        if (!lean.ok) return;
        expect(canon(lean.value, { loops: true }).replace(/"removedLoops":\d+/, "")).toBe(
          canon(ref.value, { loops: true }).replace(/"removedLoops":\d+/, ""),
        );
        // every `-loop 1 -framerate` that is gone has its repeat in a graph, and no repeat appears without one gone
        expect(loopsOf(ref.value) - loopsOf(lean.value)).toBe(tailsOf(lean.value));
        held += tailsOf(lean.value);
      }),
      { numRuns: 250, seed: 20261117 },
    );
    expect(held).toBeGreaterThan(40);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Q4. The probe path, traced through the production boundary (buildLeanRenderCommand) with a runner that answers the way ffmpeg's log does.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const showinfo = (source: string, scaled: string): string =>
  [
    `[Parsed_showinfo_1 @ 0000] n:   0 pts:      0 pts_time:0 fmt:yuvj420p cl:left sar:1/1 s:${source} i:P iskey:1`,
    `[Parsed_showinfo_3 @ 0000] n:   0 pts:      0 pts_time:0 fmt:yuvj420p cl:left sar:1/1 s:${scaled} i:P iskey:1`,
  ].join("\n");
type BoundaryContext = Parameters<typeof buildLeanRenderCommand>[0];
function runnerWith(answer: "ok" | "fail"): { calls: string[][]; ctx: BoundaryContext } {
  const calls: string[][] = [];
  const runner = {
    run: async (_program: string, args: string[]) => {
      calls.push(args);
      return answer === "ok"
        ? { code: 0, stdout: "", stderr: showinfo("4000x3000", "288x384") }
        : { code: 1, stdout: "", stderr: "Invalid data found when processing input" };
    },
  };
  return { calls, ctx: { runner, signal: undefined } as BoundaryContext };
}

describe("Q4: the probe path through buildLeanRenderCommand", () => {
  afterEach(() => __resetExportFlags());
  const zoomPicture = project([videoTrack([picture("/z.jpg", 0, 2, { transform: zoomOf(2) })])]);

  it("zoom OFF, stills ON: the picture still asks ffmpeg once, is held after the answer, and the zoom keeps its geq", async () => {
    __setExportFlag("lean_zoom", false);
    const run = runnerWith("ok");
    const plan = await buildLeanRenderCommand(run.ctx, zoomPicture, OUT, {});
    expect(run.calls).toHaveLength(1);
    expect(plan.lean?.ran).toEqual(["stills", "decoders"]);
    expect(plan.filterComplex).toContain("loop=loop=-1:size=1:start=0");
    expect(plan.filterComplex).toContain("gte(X,(W-");
  });

  it("zoom ON and stills ON: one probe serves both (one question per path and pre-scale), and the mask and the repeat are both taken", async () => {
    const run = runnerWith("ok");
    const plan = await buildLeanRenderCommand(run.ctx, zoomPicture, OUT, {});
    expect(run.calls).toHaveLength(1);
    expect(plan.lean?.ran).toEqual(["zoom", "stills", "decoders"]);
    expect(plan.filterComplex).toContain("alphamerge");
    expect(plan.filterComplex).toContain("loop=loop=-1:size=1:start=0");
  });

  it("the probe is unanswered: the first build is returned, the picture keeps 0.27.0's read, the record says unknown_source", async () => {
    const run = runnerWith("fail");
    const plan = await buildLeanRenderCommand(run.ctx, zoomPicture, OUT, {});
    expect(run.calls).toHaveLength(1);
    expect(argsOf(plan)).toContain("-loop 1 -framerate 30");
    expect(plan.filterComplex).not.toContain("loop=loop");
    expect(plan.filterComplex).toContain("gte(X,(W-");
    expect(plan.lean?.kept).toContain("unknown_source");
    expect(plan.lean?.ran).toEqual([]);
  });

  it("stills OFF with the zoom switch still ON: the mask is off with it (it needs the held pictures), so ffmpeg is not asked and the zoom keeps 0.27.0's geq; both OFF: the same", async () => {
    __setExportFlag("lean_stills", false);
    const run = runnerWith("ok");
    const plan = await buildLeanRenderCommand(run.ctx, zoomPicture, OUT, {});
    expect(run.calls).toHaveLength(0);
    expect(plan.lean?.ran ?? []).not.toContain("zoom");
    expect(plan.lean?.kept).toContain("flag_off");
    expect(plan.filterComplex).toContain("gte(X,(W-");
    expect(plan.filterComplex).not.toContain("alphamerge");
    __setExportFlag("lean_zoom", false);
    const none = runnerWith("ok");
    await buildLeanRenderCommand(none.ctx, zoomPicture, OUT, {});
    expect(none.calls).toHaveLength(0);
  });

  it("a streamed export asks once per distinct (path, pre-scale), not once per part; each part opens only the pictures of its own range", async () => {
    const clip = (path: string, a: number, b: number) =>
      picture(path, a, b, { transform: zoomOf(b - a) });
    const long = project([
      videoTrack([
        clip("/z1.jpg", 10, 12),
        clip("/z2.jpg", 50, 52),
        clip("/z1.jpg", 100, 102),
        picture("/s.jpg", 110, 130),
      ]),
    ]);
    const run = runnerWith("ok");
    const plan = await buildLeanRenderCommand(run.ctx, long, OUT, { engine: "partition-pipes-v1" });
    expect(run.calls).toHaveLength(2);
    expect(plan.steps?.length).toBeGreaterThanOrEqual(4);
    for (const step of plan.steps ?? []) {
      const pictures = step.args.filter((a) => /^\/(z1|z2|s)\.jpg$/.test(a));
      // every picture an input of a part is on that part's frames: the same file twice in different parts is never both in one
      expect(new Set(pictures).size).toBe(pictures.length);
    }
    expect(plan.lean?.ran).toContain("stills");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Q8. A picture whose grade runs before the repeat, under glow, rotation with a zoom and a blend mode: the stack is in the clip's own chain once, before the repeat, and no other chain moved.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("Q8: the stack's output feeds the glow, the rotated zoom and the blend path unchanged", () => {
  const stack = { exposure: 0.1, contrast: 1.1 };
  const shapes: Record<string, Record<string, unknown>> = {
    glow: { glow: 30 },
    "glow effect": { effects: [{ type: "glow", params: { intensity: 30 } }] },
    "rotation and a zoom": { rotate: 12, fit: "contain", transform: zoomOf(2) },
    blend: { blend: "screen" },
    "opacity, fade and a transition-less crossfade shape": {
      opacity: [
        { t: 0, v: 1 },
        { t: 1, v: 0.5 },
      ],
      fade: { in: 5, out: 5 },
    },
  };
  const tokens = (chain: string): string[] => chain.replace(/\[[^\]]*\]/g, "").split(",");

  for (const [name, extra] of Object.entries(shapes)) {
    it(name, () => {
      const t = project([videoTrack([picture("/p0.jpg", 0, 2, { color: stack, ...extra })])]);
      const held = buildRenderCommand(t, OUT, { lean: { stills: true } }).filterComplex.split(";");
      const plan = buildRenderCommand(t, OUT, { lean: { stills: true, grade: true } });
      const once = plan.filterComplex.split(";");
      expect(plan.lean?.ran).toContain("grade");
      expect(once).toHaveLength(held.length);
      const own = held.findIndex((c) => c.startsWith("[0:v]"));
      held.forEach((c, i) => {
        if (i !== own) expect(once[i], `chain ${i}`).toBe(c);
      });
      expect([...tokens(once[own])].sort()).toEqual([...tokens(held[own])].sort());
      const names = tokens(once[own]);
      expect(names.filter((x) => x.startsWith("exposure="))).toHaveLength(1);
      expect(names.findIndex((x) => x.startsWith("exposure="))).toBeLessThan(
        names.findIndex((x) => x.startsWith("loop=loop")),
      );
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Q9. Which inputs take fix 5's cap.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("Q9: the decoder cap", () => {
  const sound = (id: string, path: string, a: number, b: number) => ({
    id,
    kind: "audio",
    media_ref: path,
    source_in: 0,
    source_out: b - a,
    timeline_in: a,
    timeline_out: b,
  });

  it("a held picture carries one decoder thread on the one-pass engine; a sound-only input never carries a cap; a video clip and an audio clip of the SAME file keep 0.27.0's options", () => {
    const t = project([
      videoTrack([
        picture("/p.jpg", 0, 2),
        { media_ref: "/m.mp4", source_in: 0, source_out: 2, timeline_in: 2, timeline_out: 4 },
      ]),
      { id: "a", kind: "audio", z: 0, clips: [sound("a0", "/m.mp4", 0, 4)] },
    ]);
    const base = buildRenderCommand(t, OUT);
    const plan = buildRenderCommand(t, OUT, { lean: { stills: true, decoders: true } });
    expect(argsOf(plan)).toContain("-threads:v 1 -i /p.jpg");
    expect(argsOf(plan)).not.toContain("-threads:a");
    const mp4 = (a: string): string[] =>
      a.match(/-ss [\d.]+ -to [\d.]+(?: -threads:\w \d+)* -i \/m\.mp4/g) ?? [];
    expect(mp4(argsOf(plan))).toHaveLength(2);
    expect(mp4(argsOf(plan))).toEqual(mp4(argsOf(base)));
    expect(plan.sources).toHaveLength(3);
  });

  it("the one-pass engine's own fallback to parts (a command over the length line) caps nothing but held pictures; the streamed engine and the audio pass add nothing", () => {
    const audio = Array.from({ length: 220 }, (_, i) =>
      sound(`s${i}`, `/media/${"x".repeat(100)}_${i}.mp3`, i * 2, i * 2 + 2),
    );
    const t = project([
      videoTrack([
        { media_ref: "/v.mp4", source_in: 0, source_out: 440, timeline_in: 0, timeline_out: 440 },
      ]),
      { id: "a", kind: "audio", z: 0, clips: audio },
    ]);
    const everyCommand = (p: { args: string[]; steps?: Array<{ args: string[] }> }) => [
      p.args,
      ...(p.steps ?? []).map((s) => s.args),
    ];
    const fallback = buildRenderCommand(t, OUT, {
      engine: "file-sequence-v1",
      lean: { decoders: true },
    });
    expect(fallback.steps?.length).toBeGreaterThanOrEqual(1);
    for (const a of everyCommand(fallback)) expect(a).not.toContain("-threads:a");
    const streamed = buildRenderCommand(t, OUT, {
      engine: "partition-pipes-v1",
      lean: { decoders: true },
    });
    for (const a of everyCommand(streamed)) expect(a).not.toContain("-threads:a");
    const pass = buildAudioRenderCommand(t, "audio.nut", { lean: { decoders: true } });
    expect(pass.args).not.toContain("-threads:a");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Q10. The record: flag_off appears exactly when a construct the switch controls exists, and a second build with the same options object neither double counts nor leaks.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("Q10: the record", () => {
  const ON: LeanOptions = { fades: true, dip: true, stills: true, grade: true, decoders: true };
  const video = (extra: Record<string, unknown> = {}, path = "/v.mp4") => ({
    media_ref: path,
    source_in: 0,
    source_out: 2,
    timeline_in: 0,
    timeline_out: 2,
    ...extra,
  });
  const two = (second: Record<string, unknown>) =>
    project([
      videoTrack([
        video(),
        { ...video(second, "/w.mp4"), timeline_in: 2, timeline_out: 4, source_out: 2 },
      ]),
    ]);
  const cases: Array<{
    switch: "fades" | "dip" | "stills" | "grade" | "decoders";
    has: Timeline;
    hasNot: Timeline;
  }> = [
    {
      switch: "fades",
      has: two({ transition_in: { kind: "crossfade", duration: 0.5 } }),
      hasNot: two({}),
    },
    {
      switch: "dip",
      has: two({ transition_in: { kind: "dip-to-black", duration: 0.5 } }),
      hasNot: two({ transition_in: { kind: "crossfade", duration: 0.5 } }),
    },
    {
      switch: "stills",
      has: project([videoTrack([picture("/p.jpg", 0, 2)])]),
      hasNot: project([videoTrack([video()])]),
    },
    {
      switch: "grade",
      has: project([videoTrack([picture("/p.jpg", 0, 2, { color: { exposure: 0.1 } })])]),
      hasNot: project([videoTrack([picture("/p.jpg", 0, 2)])]),
    },
    {
      switch: "decoders",
      has: project([videoTrack([picture("/p.jpg", 0, 2)])]),
      hasNot: project([videoTrack([video()])]),
    },
  ];

  for (const c of cases)
    it(`${c.switch}: flag_off exactly when its construct exists`, () => {
      const off: LeanOptions = { ...ON };
      off[c.switch] = false;
      expect(
        buildRenderCommand(c.has, OUT, { lean: off }).lean?.kept,
        "construct present, switch off",
      ).toContain("flag_off");
      expect(
        buildRenderCommand(c.hasNot, OUT, { lean: off }).lean?.kept,
        "construct absent, switch off",
      ).not.toContain("flag_off");
      expect(buildRenderCommand(c.has, OUT, { lean: ON }).lean?.kept, "switch on").not.toContain(
        "flag_off",
      );
    });

  it("a second build with the same options object gives the same record, the same request list and the same text", () => {
    const sound = {
      id: "a",
      kind: "audio",
      z: 0,
      clips: [
        {
          id: "a0",
          kind: "audio",
          media_ref: "/a.mp3",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
        },
      ],
    };
    const t = project([
      videoTrack([picture("/z.jpg", 0, 2, { transform: zoomOf(2), color: { exposure: 0.1 } })]),
      sound,
    ]);
    const options: LeanOptions = { ...ON, zoom: true, requests: [] };
    const a = buildRenderCommand(t, OUT, { lean: options });
    const asked = JSON.stringify(options.requests);
    const b = buildRenderCommand(t, OUT, { lean: options });
    expect(b.lean).toEqual(a.lean);
    expect(b.filterComplex).toBe(a.filterComplex);
    expect(JSON.stringify(options.requests)).toBe(asked);
    expect(options.budget).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Q12. What the three unit-test files of fixes 3, 4b and 5 would still accept if the fix did the wrong thing. The product's own functions are broken with vi.spyOn and the SAME kind of
// assertion those files use is applied to the result.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("Q12: assertions of the existing unit tests against deliberately wrong products", () => {
  const stillTree = project([videoTrack([picture("/p0.jpg", 0, 2)])]);
  const gradeTree = project([
    videoTrack([picture("/p0.jpg", 0, 2, { color: { exposure: 0.05, contrast: 1.06 } })]),
  ]);
  const chainOf = (graph: string): string =>
    graph.split(";").find((c) => c.startsWith("[0:v]")) ?? "";
  const tokens = (chain: string): string[] => chain.replace(/\[[^\]]*\]/g, "").split(",");

  it("the repeat placed BEFORE the fit: the placement assertion sees it; the length property (given === held) does not", () => {
    const real = leanStills.leanPictureLoop;
    vi.spyOn(leanStills, "leanPictureLoop").mockImplementation((req) => {
      const loop = real(req);
      if (!loop) return loop;
      const { graphAfterFit: _after, ...beforeTheFit } = loop;
      void _after;
      return beforeTheFit;
    });
    const plan = buildRenderCommand(stillTree, OUT, { lean: { stills: true } });
    const graph = plan.filterComplex;
    // leanStills.test.ts "FITTED" assertion: the repeat is after the fit. It is violated by this product, so the test would go red.
    expect(graph.indexOf("loop=loop=-1:size=1:start=0") > graph.indexOf("crop=")).toBe(false);
    // leanStills.test.ts length property: the text of `-t` equals the text of the trim. It still holds for this product, so that test stays green.
    const given = /-t (\d+\.\d+) -i \/p0\.jpg/.exec(argsOf(plan))?.[1];
    const held = /setpts=N,trim=duration=(\d+\.\d+)/.exec(graph)?.[1];
    expect(given).toBe(held);
  });

  it("the stack left AFTER the repeat: the regex assertion sees it; the sorted-token property is blind to placement", () => {
    vi.spyOn(leanGrade, "leanGradeOnce").mockReturnValue(false);
    const moved = buildRenderCommand(gradeTree, OUT, { lean: { stills: true, grade: true } });
    const held = buildRenderCommand(gradeTree, OUT, { lean: { stills: true } });
    expect(moved.filterComplex).toBe(held.filterComplex);
    // leanGrade.test.ts property: the same tokens in both graphs. TRUE although nothing moved, so that test stays green.
    expect([...tokens(chainOf(moved.filterComplex))].sort()).toEqual(
      [...tokens(chainOf(held.filterComplex))].sort(),
    );
    // leanGrade.test.ts regex: the stack sits between the fit and the repeat. Violated here, so that test would go red.
    expect(chainOf(moved.filterComplex)).not.toMatch(
      /crop=192:108,exposure=exposure=[\d.]+,eq=[^,]*,loop=loop/,
    );
    expect(moved.lean?.ran).not.toContain("grade");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// RISK (low): the lean decoder cap is counted in the length of the command that decides the engine. An explicit one-pass export whose 0.27.0 command is just under the 28,000-character line
// is segmented by the lean build alone (a different command structure: steps), which no lean path may do.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("RISK: a lean option moves a project over the command-length line", () => {
  const build = (padding: number, lean?: LeanOptions) => {
    const audio = Array.from({ length: 150 }, (_, i) => ({
      id: `s${i}`,
      kind: "audio",
      media_ref: `/${"p".repeat(padding)}${i}.mp3`,
      source_in: 0,
      source_out: 2,
      timeline_in: i * 2,
      timeline_out: i * 2 + 2,
    }));
    const t = project([
      videoTrack([
        { media_ref: "/v.mp4", source_in: 0, source_out: 300, timeline_in: 0, timeline_out: 300 },
      ]),
      { id: "a", kind: "audio", z: 0, clips: audio },
    ]);
    return buildRenderCommand(t, OUT, { engine: "file-sequence-v1", ...(lean ? { lean } : {}) });
  };

  it("DEFECT (low): a project that stays one command under 0.27.0 stays one command with the decoder cap on", () => {
    // the largest path padding whose 0.27.0 command is still ONE command (the plain build is monotone in the padding)
    expect(build(40).steps).toBeUndefined();
    expect(build(200).steps).toBeDefined();
    let lo = 40;
    let hi = 200;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (build(mid).steps) hi = mid;
      else lo = mid;
    }
    // the cap adds 17 characters to each of the 150 inputs: every padding in the last 17 steps below the line flips
    const flips: number[] = [];
    for (let padding = lo; padding > lo - 25; padding--)
      if (build(padding, { decoders: true }).steps) flips.push(padding);
    expect(flips).toEqual([]);
  });
});
