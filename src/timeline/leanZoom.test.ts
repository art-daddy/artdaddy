// Fix 1 in the real builder (Phase 3a): which clips take the exact mask stream, which keep 0.27.0's per-pixel geq and why, and that "off" is 0.27.0 byte for byte.
// The pixels themselves are proved against real ffmpeg by the sweep harness (framemd5 of the picture before the encoder, flag off against on); these tests pin the
// decision and the graph.
import { describe, expect, it } from "vitest";
import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";
import { LEAN_FIXES, LEAN_KEPT_REASONS, LeanTally, mergeLeanRecords } from "./leanRecord";
import { LEAN_MAX_MASK_BOXES, leanZoomMask } from "./leanZoom";
import type { LeanOptions, LeanProbed } from "./leanOptions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const timeline = (tracks: Any[], canvas = { width: 1920, height: 1080, fps: 30 }): Timeline =>
  ({ canvas, tracks }) as Timeline;

/** A Ken-Burns cover zoom, the shape the corpus test freezes: 1.0 to 1.2 over the clip. */
function zoomClip(seconds: number, extra: Record<string, unknown> = {}) {
  return {
    media_ref: "/a.mp4",
    source_in: 0,
    source_out: seconds,
    timeline_in: 0,
    timeline_out: seconds,
    fit: "cover",
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: [
        { t: 0, v: 1 },
        { t: seconds, v: 1.2 },
      ],
    },
    ...extra,
  };
}
const oneClip = (seconds = 2, extra: Record<string, unknown> = {}) =>
  timeline([{ id: "v", kind: "video", z: 0, clips: [zoomClip(seconds, extra)] }]);

const OUT = "/out.mp4";
const PRESCALE = "scale=w=2304:h=1296:force_original_aspect_ratio=increase:force_divisible_by=2";
const probed = (fmt = "yuv420p"): LeanProbed => ({
  fmt,
  source: [1920, 1080],
  scaled: [2304, 1296],
});
const key = `/a.mp4\n${PRESCALE}`;
const withProbe = (fmt?: string, zoom = true): LeanOptions => ({
  zoom,
  probed: new Map([[key, probed(fmt)]]),
});

describe("leanRecord", () => {
  it("lists are distinct, in list order, and only closed words", () => {
    const tally = new LeanTally();
    tally.kept("error");
    tally.kept("see_through");
    tally.kept("see_through");
    tally.ran("zoom");
    tally.ran("zoom");
    expect(tally.record()).toEqual({ ran: ["zoom"], kept: ["see_through", "error"] });
    expect(tally.counts().kept.see_through).toBe(2);
    const merged = mergeLeanRecords([
      tally.record(),
      undefined,
      { ran: ["decoders", "zoom"], kept: ["flag_off"] },
    ]);
    expect(merged).toEqual({
      ran: ["zoom", "decoders"],
      kept: ["see_through", "flag_off", "error"],
    });
    for (const w of merged.ran) expect(LEAN_FIXES).toContain(w);
    for (const w of merged.kept) expect(LEAN_KEPT_REASONS).toContain(w);
  });
});

describe("fix 1: the builder", () => {
  it("without the lean option the plan is 0.27.0's and carries no lean record", () => {
    const plan = buildRenderCommand(oneClip(), OUT);
    expect(plan.lean).toBeUndefined();
    expect(plan.filterComplex).toContain("gte(X,(W-");
    expect(plan.filterComplex).not.toContain("alphamerge");
  });

  it("with the switch off the graph and the command are byte-identical, and the clip is counted as kept: flag_off", () => {
    const base = buildRenderCommand(oneClip(), OUT);
    const off = buildRenderCommand(oneClip(), OUT, { lean: { zoom: false } });
    expect(off.filterComplex).toBe(base.filterComplex);
    expect(off.args).toEqual(base.args);
    expect(off.lean).toEqual({ ran: [], kept: ["flag_off"] });
  });

  it("with the switch on it first asks ffmpeg what size the picture is, and meanwhile keeps today's graph (counted as unknown)", () => {
    const base = buildRenderCommand(oneClip(), OUT);
    const lean: LeanOptions = { zoom: true, requests: [] };
    const asked = buildRenderCommand(oneClip(), OUT, { lean });
    expect(asked.filterComplex).toBe(base.filterComplex);
    expect(lean.requests).toHaveLength(1);
    expect(lean.requests![0]).toEqual({
      key,
      path: "/a.mp4",
      filters: `setsar=1,showinfo,${PRESCALE},showinfo`,
    });
    expect(asked.lean).toEqual({ ran: [], kept: ["unknown_source"] });
  });

  it("with the answer it takes the mask: alphamerge right after the picture's alpha plane exists, no per-pixel geq, nothing else in the graph moved", () => {
    const base = buildRenderCommand(oneClip(), OUT);
    const plan = buildRenderCommand(oneClip(), OUT, { lean: withProbe() });
    const fc = plan.filterComplex;
    expect(plan.lean).toEqual({ ran: ["zoom"], kept: [] });
    expect(fc).not.toContain("gte(X,(W-");
    expect(fc).toMatch(
      /,format=yuva420p\[leanpic0\];color=c=white:s=2304x1296:r=30:d=[\d.]+,format=gray/,
    );
    expect(fc).toMatch(
      /,setpts=PTS\+0\[leanmask0\];\[leanpic0\]\[leanmask0\]alphamerge,scale=w='max\(2,round\(/,
    );
    // everything that is not the aperture is the same text: put today's geq back where the mask was and the two graphs are equal
    const aperture =
      /geq=lum='lum\(X,Y\)':cb='cb\(X,Y\)':cr='cr\(X,Y\)':a='alpha\(X,Y\)\*gte\(X,\(W-[^']*'/.exec(
        base.filterComplex,
      )![0];
    const rebuilt = fc
      .replace(
        /;color=c=white:[^[]*\[leanmask0\];\[leanpic0\]\[leanmask0\]alphamerge,/,
        `,${aperture},`,
      )
      .replace("[leanpic0]", "");
    expect(rebuilt).toBe(base.filterComplex);
  });

  it("a see-through source (alpha) keeps today's graph, counted as see_through; an unknown format as unknown_source", () => {
    const base = buildRenderCommand(oneClip(), OUT);
    const alpha = buildRenderCommand(oneClip(), OUT, { lean: withProbe("rgba") });
    expect(alpha.filterComplex).toBe(base.filterComplex);
    expect(alpha.lean).toEqual({ ran: [], kept: ["see_through"] });
    const palette = buildRenderCommand(oneClip(), OUT, { lean: withProbe("pal8") });
    expect(palette.filterComplex).toBe(base.filterComplex);
    expect(palette.lean).toEqual({ ran: [], kept: ["unknown_source"] });
  });

  it("shapes the proof does not cover keep today's graph, counted as not_proven", () => {
    for (const extra of [
      { speed: 2 },
      { rotate: 10 },
      { flip: { h: true } },
      { glow: { amount: 0.5 } },
    ]) {
      const t = oneClip(2, extra);
      const base = buildRenderCommand(t, OUT);
      const plan = buildRenderCommand(t, OUT, { lean: withProbe() });
      expect(plan.filterComplex, JSON.stringify(extra)).toBe(base.filterComplex);
      expect(plan.lean?.ran, JSON.stringify(extra)).toEqual([]);
    }
  });

  it("a plain build (the person's Try again after a failure) keeps today's graph whatever the switches say, and counts nothing", () => {
    const base = buildRenderCommand(oneClip(), OUT);
    const plan = buildRenderCommand(oneClip(), OUT, { lean: { ...withProbe(), plain: true } });
    expect(plan.filterComplex).toBe(base.filterComplex);
    expect(plan.args).toEqual(base.args);
    expect(plan.lean).toEqual({ ran: [], kept: [] });
  });

  it("a look (frame window) and the audio pass never take a lean path", () => {
    const plan = buildRenderCommand(oneClip(), OUT, { lean: withProbe() }, { frame: 10 });
    expect(plan.filterComplex).toContain("gte(X,(W-");
    expect(plan.lean).toBeUndefined();
  });

  it("a clip with a crossfade keeps its alpha steps AFTER the mask, in the order 0.27.0 ran them", () => {
    const t = timeline([
      {
        id: "v",
        kind: "video",
        z: 0,
        clips: [
          { media_ref: "/b.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 },
          zoomClip(2, {
            media_ref: "/a.mp4",
            timeline_in: 2,
            timeline_out: 4,
            transition_in: { kind: "crossfade", duration: 0.5 },
          }),
        ],
      },
    ]);
    const plan = buildRenderCommand(t, OUT, { lean: withProbe() });
    const fc = plan.filterComplex;
    expect(plan.lean?.ran).toEqual(["zoom"]);
    const after = fc.split("alphamerge,")[1];
    expect(after.indexOf("geq=")).toBeGreaterThan(-1);
    expect(after.indexOf("geq=")).toBeLessThan(after.indexOf("scale=w='max(2"));
  });

  it("a long, slowly changing zoom stays inside the budget or keeps today's graph, never an enormous graph", () => {
    const plan = buildRenderCommand(oneClip(600), OUT, { lean: withProbe() });
    const drawboxes = (plan.filterComplex.match(/drawbox=/g) ?? []).length;
    expect(drawboxes).toBeLessThanOrEqual(LEAN_MAX_MASK_BOXES);
    if (plan.lean?.ran.length === 0) expect(plan.lean.kept).toContain("over_budget");
  });

  it("on the streamed engine each part is built with the lean paths, the mask is stamped in project time, and the plan's record is their union", () => {
    const t = oneClip(70);
    const plan = buildRenderCommand(t, OUT, { engine: "partition-pipes-v1", lean: withProbe() });
    const graphs = plan.assFiles.filter((f) => f.name.endsWith(".ffgraph")).map((f) => f.content);
    const text = [plan.filterComplex, ...graphs].join("\n");
    if (plan.lean?.ran.includes("zoom")) {
      expect(text.match(/alphamerge/g)!.length).toBeGreaterThanOrEqual(2);
      expect(text).toContain(",setpts=PTS+0[leanmask0]");
      expect(text).toContain(",setpts=PTS+1050[leanmask0]");
    } else {
      expect(plan.lean?.kept).toContain("over_budget");
    }
    expect(plan.steps).toHaveLength(2);
  });
});

describe("fix 1: the decision, one clip at a time", () => {
  const base = {
    path: "/a.mp4",
    preScale: PRESCALE,
    widthExpr:
      "((max(2,round(1000/2)*2))/(max((max(2,round(1000/2)*2))/W,(max(2,round(300/2)*2))/H)))",
    heightExpr:
      "((max(2,round(300/2)*2))/(max((max(2,round(1000/2)*2))/W,(max(2,round(300/2)*2))/H)))",
    fps: 30,
    from: 0,
    to: 30,
    unproven: false,
  };
  const run = (lean: LeanOptions, over: Partial<typeof base> & { unproven?: boolean } = {}) => {
    const tally = new LeanTally();
    const budget = { chars: 0, boxes: 0 };
    const mask = leanZoomMask({ lean, tally, budget, ...base, ...over });
    return { mask, record: tally.record(), budget };
  };

  it("only ever answers with a mask or null, and every refusal is a closed word", () => {
    const cases: Array<[LeanOptions, Partial<typeof base>]> = [
      [{ zoom: false }, {}],
      [{ zoom: true }, { unproven: true }],
      [{ zoom: true }, {}],
      [withProbe("rgba"), {}],
      [withProbe("pal8"), {}],
      [withProbe(), { widthExpr: "sin(T)" }],
      [withProbe(), { to: 0 }],
      [withProbe(), {}],
    ];
    for (const [lean, over] of cases) {
      const { mask, record } = run(lean, over);
      for (const w of record.kept) expect(LEAN_KEPT_REASONS).toContain(w);
      expect(mask === null || record.ran.includes("zoom")).toBe(true);
      expect(mask !== null && record.kept.length > 0).toBe(false);
    }
  });

  it("counts an expression it cannot read as error, and a spent budget as over_budget", () => {
    expect(run(withProbe(), { widthExpr: "sin(T)" }).record.kept).toEqual(["error"]);
    const tally = new LeanTally();
    const budget = { chars: 0, boxes: LEAN_MAX_MASK_BOXES };
    const mask = leanZoomMask({ lean: withProbe(), tally, budget, ...base });
    expect(mask).toBeNull();
    expect(tally.record().kept).toEqual(["over_budget"]);
  });

  it("charges the budget for what it emits", () => {
    const { mask, budget } = run(withProbe());
    expect(mask).not.toBeNull();
    expect(budget.chars).toBe(mask!.text.length);
    expect(budget.boxes).toBe(mask!.boxes);
  });
});
