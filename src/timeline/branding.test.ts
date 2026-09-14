// The PLAN a branded export produces. The pixels are proved separately, by
// `branding.smoke.e2e.ts` against real ffmpeg output — a filtergraph that merely mentions
// `overlay` is the exact assertion that passed while captions composited nothing.
import { describe, expect, it } from "vitest";

import { brandRatio, endcardFile, watermarkFile } from "./branding";
import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";

const BRAND = {
  watermark: "/res/brand/watermark-16x9.png",
  endcard: "/res/brand/endcard-16x9.mp4",
  endcardDuration: 2,
};

function timeline(canvas = { width: 1920, height: 1080, fps: 30 }, withAudio = false): Timeline {
  return {
    canvas,
    tracks: [
      {
        id: "v0",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "a",
            media_ref: "/m/a.mp4",
            source_in: 0,
            source_out: 2,
            timeline_in: 0,
            timeline_out: 2,
          },
        ],
      },
      ...(withAudio
        ? [
            {
              id: "a0",
              kind: "audio",
              z: 1,
              clips: [
                {
                  id: "b",
                  // The CLIP carries the kind the builder reads; a track marked audio with an
                  // unmarked clip inside it compiled as a silent video overlay, and the first
                  // version of this fixture proved nothing at all.
                  kind: "audio",
                  media_ref: "/m/b.mp3",
                  source_in: 0,
                  source_out: 2,
                  timeline_in: 0,
                  timeline_out: 2,
                },
              ],
            },
          ]
        : []),
    ],
  } as unknown as Timeline;
}

describe("brandRatio", () => {
  // A conformance walk rather than one hand-picked canvas: the map drives which asset every
  // export gets, and checking 1920x1080 alone says nothing about the vertical cut.
  it.each([
    [1920, 1080, "16x9"],
    [3840, 2160, "16x9"],
    [1280, 720, "16x9"],
    [1080, 1080, "1x1"],
    [512, 512, "1x1"],
    [1080, 1920, "9x16"],
    [720, 1280, "9x16"],
  ])("%ix%i takes the %s assets", (w, h, want) => {
    expect(brandRatio(w, h)).toBe(want);
  });

  it("takes the nearer of two ratios rather than the first that fits", () => {
    expect(brandRatio(1400, 1000)).toBe("16x9"); // 1.40 — nearer 1.78 than 1.00 in log-aspect
    expect(brandRatio(1200, 1000)).toBe("1x1"); // 1.20 — nearer 1.00
  });

  it("breaks an exact tie the same way every time", () => {
    // 4:3 is the geometric mean of 1:1 and 16:9. Left to float rounding this flipped to the
    // square bug, which would stretch across a landscape project on some machines and not
    // others — the worst kind of bug to reproduce.
    expect(brandRatio(1024, 768)).toBe("16x9");
    expect(brandRatio(800, 600)).toBe("16x9");
  });

  it("never returns an asset name for a ratio it did not choose", () => {
    expect(watermarkFile(brandRatio(1080, 1920))).toBe("watermark-9x16.png");
    expect(endcardFile(brandRatio(1080, 1920))).toBe("endcard-9x16.mp4");
  });

  it("falls back rather than throwing on a degenerate canvas", () => {
    expect(brandRatio(0, 0)).toBe("16x9");
  });
});

describe("branded render plan", () => {
  it("adds both assets as inputs without disturbing the clips' input indices", () => {
    const plain = buildRenderCommand(timeline(), "/o.mp4");
    const branded = buildRenderCommand(timeline(), "/o.mp4", { branding: BRAND });
    const inputsOf = (a: string[]) => a.filter((_, i) => a[i - 1] === "-i");
    expect(inputsOf(plain.args)).toEqual(["/m/a.mp4"]);
    // The clip stays input 0 — an asset inserted first would silently renumber every
    // `[N:v]` label in the graph.
    expect(inputsOf(branded.args)).toEqual(["/m/a.mp4", BRAND.watermark, BRAND.endcard]);
    expect(branded.filterComplex).toContain("[0:v]");
  });

  it("composites the watermark over the delivery-sized picture, not the canvas", () => {
    const branded = buildRenderCommand(timeline(), "/o.mp4", {
      branding: BRAND,
      resolution: "720p",
    });
    // The bug is inset for the frame it was authored at, so it must be scaled to whatever the
    // export actually delivers. Overlaying a 1920-wide asset onto a 1280-wide frame would push
    // the bug off the right edge — invisible, and the string assertion would still pass.
    expect(branded.filterComplex).toContain("[1:v]scale=1280:720[wm]");
    expect(branded.filterComplex).toMatch(/\[scaled]\[wm]overlay=0:0/);
  });

  it("concatenates the end card after the watermarked picture, not before", () => {
    const fc = buildRenderCommand(timeline(), "/o.mp4", { branding: BRAND }).filterComplex;
    expect(fc).toContain("[mainv][ecv]concat=n=2:v=1:a=0[outv]");
    expect(fc).not.toContain("[ecv][mainv]concat");
  });

  it("normalises BOTH concat branches, not only the card", () => {
    const fc = buildRenderCommand(timeline(), "/o.mp4", { branding: BRAND }).filterComplex;
    // concat refuses inputs that disagree on size/format/SAR. Normalising only the card is the
    // version that works on the project you tested and dies on the next one.
    expect(fc).toContain("[branded]fps=30,format=yuv420p,setsar=1,setpts=PTS-STARTPTS[mainv]");
    expect(fc).toMatch(
      /\[2:v]scale=1920:1080:flags=lanczos,fps=30,format=yuv420p,setsar=1,setpts=PTS-STARTPTS\[ecv]/,
    );
  });

  it("lets the concat decide the length instead of capping it with -t", () => {
    const branded = buildRenderCommand(timeline(), "/o.mp4", { branding: BRAND });
    const plain = buildRenderCommand(timeline(), "/o.mp4");
    // The OUTPUT `-t` specifically: per-input `-t` still bounds the looped watermark. A `-t`
    // computed from a constant would cut a re-authored card off mid-animation while the export
    // still reported success.
    expect(plain.args.slice(-3)).toEqual(["-t", "2.000000", "/o.mp4"]);
    expect(branded.args.slice(-2)).toEqual(["-shortest", "/o.mp4"]);
  });

  it("pads the audio so the card is not silent-by-truncation", () => {
    const fc = buildRenderCommand(timeline(undefined, true), "/o.mp4", {
      branding: BRAND,
    }).filterComplex;
    expect(fc, "the fixture produced no audio branch at all").toMatch(/\[\d+:a]/);
    expect(fc).toMatch(/asetpts=N\/SR\/TB,apad=whole_dur=4\.000000\[abrand]/);
  });

  it("maps the branded video, never the pre-branding label", () => {
    const args = buildRenderCommand(timeline(), "/o.mp4", { branding: BRAND }).args;
    const mapped = args[args.indexOf("-map") + 1];
    // The failure this catches emits the whole branding chain and then maps around it: every
    // filter present, zero branding in the file.
    expect(mapped).toBe("[outv]");
  });

  it("reports a longer duration so the progress bar is not stuck at 100%", () => {
    const plain = buildRenderCommand(timeline(), "/o.mp4");
    const branded = buildRenderCommand(timeline(), "/o.mp4", { branding: BRAND });
    expect(branded.duration).toBeGreaterThan(plain.duration);
  });

  it("leaves an unbranded plan byte-identical", () => {
    // The working render and the model's preview frames go through the same builder.
    const a = buildRenderCommand(timeline(), "/o.mp4");
    const b = buildRenderCommand(timeline(), "/o.mp4", { branding: undefined });
    expect(b.args).toEqual(a.args);
    expect(a.filterComplex).not.toContain("overlay=0:0");
    expect(a.args).toContain("-t");
    expect(a.args).not.toContain("-shortest");
  });
});
