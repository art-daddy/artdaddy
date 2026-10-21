// The PLAN a branded export produces. The pixels are proved separately, by
// `branding.smoke.e2e.ts` against real ffmpeg output — a filtergraph that merely mentions
// `overlay` is the exact assertion that passed while captions composited nothing.
import { afterEach, describe, expect, it, vi } from "vitest";

import { brandRatio, endcardFile, watermarkFile } from "./branding";
import type { Timeline } from "./model";
import { buildRenderCommand, exportBranding } from "./render";
import { recoverBrandAsset } from "./brandRecovery";
import { fetchExportPolicy } from "../api/auth";
import { useAuth } from "../store/auth";

vi.mock("@tauri-apps/api/path", () => ({ resolveResource: async () => "/res/brand" }));
vi.mock("./brandRecovery", () => ({ recoverBrandAsset: vi.fn(async () => null) }));
vi.mock("../api/auth", async (original) => ({
  ...(await original<typeof import("../api/auth")>()),
  fetchExportPolicy: vi.fn(async () => null),
}));
afterEach(() => {
  vi.mocked(recoverBrandAsset).mockReset().mockResolvedValue(null);
  vi.mocked(fetchExportPolicy).mockReset().mockResolvedValue(null);
  useAuth.setState({ status: "checking", profile: null });
});

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

describe("missing branding recovery", () => {
  it("uses verified backend replacements before planning a branded export", async () => {
    vi.mocked(recoverBrandAsset).mockImplementation(async (name) => `/verified/${name}`);
    const result = await exportBranding(
      { exists: async () => false },
      {
        run: async () => ({ code: 0, stdout: "2", stderr: "" }),
      },
      { width: 1920, height: 1080 },
    );
    expect(result.branding).toEqual({
      watermark: "/verified/watermark-16x9.png",
      endcard: "/verified/endcard-16x9.mp4",
      endcardDuration: 2,
    });
    expect(result.warning).toBeUndefined();
    expect(vi.mocked(recoverBrandAsset).mock.calls.map(([name]) => name)).toEqual([
      "endcard-16x9.mp4",
      "watermark-16x9.png",
    ]);
  });

  it("continues unbranded with a warning when recovery is unavailable", async () => {
    const result = await exportBranding(
      { exists: async () => false },
      {
        run: async () => ({ code: 0, stdout: "2", stderr: "" }),
      },
      { width: 1080, height: 1920 },
    );
    expect(result.branding).toBeNull();
    expect(result.warning).toContain("exported unbranded");
    expect(recoverBrandAsset).toHaveBeenCalledWith("endcard-9x16.mp4");
  });

  it("retains the end card without recovering a verified exempt account's missing watermark", async () => {
    useAuth.setState({
      status: "unlocked",
      profile: { user_id: "exempt", email: "", display_name: "", image_url: "", metered: true },
    });
    vi.mocked(fetchExportPolicy).mockResolvedValue({
      user_id: "exempt",
      watermark: false,
      end_card: true,
    });
    const result = await exportBranding(
      { exists: async (file) => file.endsWith(".mp4") },
      {
        run: async () => ({ code: 0, stdout: "2", stderr: "" }),
      },
      { width: 1920, height: 1080 },
    );
    expect(result.branding).toEqual({
      watermark: null,
      endcard: "/res/brand/endcard-16x9.mp4",
      endcardDuration: 2,
    });
    expect(result.warning).toBeUndefined();
    expect(recoverBrandAsset).not.toHaveBeenCalled();
  });

  it("recovers a bundled end card that cannot be measured before falling back", async () => {
    vi.mocked(recoverBrandAsset).mockImplementation(async (name) => `/verified/${name}`);
    const result = await exportBranding(
      { exists: async () => true },
      {
        run: async (_program, args) =>
          args.at(-1)?.startsWith("/verified/")
            ? { code: 0, stdout: "2", stderr: "" }
            : { code: 1, stdout: "", stderr: "corrupt asset" },
      },
      { width: 1920, height: 1080 },
    );
    expect(result.branding?.endcard).toBe("/verified/endcard-16x9.mp4");
    expect(result.warning).toBeUndefined();
  });

  it("recovers only the required end card for a verified exempt account", async () => {
    useAuth.setState({
      status: "unlocked",
      profile: { user_id: "exempt", email: "", display_name: "", image_url: "", metered: true },
    });
    vi.mocked(fetchExportPolicy).mockResolvedValue({
      user_id: "exempt",
      watermark: false,
      end_card: true,
    });
    vi.mocked(recoverBrandAsset).mockImplementation(async (name) =>
      name === "endcard-16x9.mp4" ? `/verified/${name}` : null,
    );
    const result = await exportBranding(
      { exists: async () => false },
      {
        run: async () => ({ code: 0, stdout: "2", stderr: "" }),
      },
      { width: 1920, height: 1080 },
    );
    expect(result.branding).toEqual({
      watermark: null,
      endcard: "/verified/endcard-16x9.mp4",
      endcardDuration: 2,
    });
    expect(result.warning).toBeUndefined();
    expect(vi.mocked(recoverBrandAsset).mock.calls.map(([name]) => name)).toEqual([
      "endcard-16x9.mp4",
    ]);
  });

  it("does not reuse an old account exemption after recovery changes accounts", async () => {
    useAuth.setState({
      status: "unlocked",
      profile: { user_id: "exempt", email: "", display_name: "", image_url: "", metered: true },
    });
    vi.mocked(fetchExportPolicy).mockImplementation(async () => {
      useAuth.setState({
        profile: {
          user_id: "different",
          email: "",
          display_name: "",
          image_url: "",
          metered: true,
        },
      });
      return { user_id: "exempt", watermark: false, end_card: true };
    });
    vi.mocked(recoverBrandAsset).mockImplementation(async (name) =>
      name === "endcard-16x9.mp4" ? `/verified/${name}` : null,
    );
    const result = await exportBranding(
      { exists: async () => false },
      {
        run: async () => ({ code: 0, stdout: "2", stderr: "" }),
      },
      { width: 1920, height: 1080 },
    );
    expect(result.branding).toBeNull();
    expect(result.warning).toContain("exported unbranded");
    expect(vi.mocked(recoverBrandAsset).mock.calls.map(([name]) => name)).toEqual([
      "endcard-16x9.mp4",
      "watermark-16x9.png",
    ]);
  });
});

describe("branded render plan", () => {
  it("omits only the corner watermark while retaining the end card and audio span", () => {
    const plan = buildRenderCommand(timeline(undefined, true), "/o.mp4", {
      branding: { ...BRAND, watermark: null },
    });
    const inputs = plan.args.filter((_, index) => plan.args[index - 1] === "-i");
    expect(inputs).toEqual(["/m/a.mp4", "/m/b.mp3", BRAND.endcard]);
    expect(plan.duration).toBe(4);
    expect(plan.audioMustSpanVideo).toBe(true);
    expect(plan.args[plan.args.indexOf("-map") + 1]).toBe("[outv]");
  });

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
    expect(branded.filterComplex).toContain("[1:v]scale=1280:720:out_range=tv,format=yuva420p[wm]");
    expect(branded.filterComplex).toContain("[scaled]scale=out_range=tv,format=yuv420p[tv]");
    expect(branded.filterComplex).toContain("[tv][wm]overlay=0:0:format=yuv420[branded]");
  });

  it("concatenates the end card after the watermarked picture, not before", () => {
    const fc = buildRenderCommand(timeline(), "/o.mp4", { branding: BRAND }).filterComplex;
    expect(fc).toContain("[mainv][ecv]concat=n=2:v=1:a=0[brandjoined]");
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

  it("ends a branded render on its planned video-frame budget", () => {
    const branded = buildRenderCommand(timeline(), "/o.mp4", { branding: BRAND });
    const plain = buildRenderCommand(timeline(), "/o.mp4");
    expect(plain.args.slice(-3)).toEqual(["-t", "2.000000", "/o.mp4"]);
    const frames = Number(branded.args[branded.args.indexOf("-frames:v") + 1]);
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeCloseTo(branded.duration * branded.output.fps, 9);
    expect(branded.args).not.toContain("-shortest");
  });

  it("pads the audio so the card is not silent-by-truncation", () => {
    const fc = buildRenderCommand(timeline(undefined, true), "/o.mp4", {
      branding: BRAND,
    }).filterComplex;
    expect(fc, "the fixture produced no audio branch at all").toMatch(/\[\d+:a]/);
    expect(fc).toMatch(
      /asetpts=N\/SR\/TB,apad=whole_dur=4\.000000000,atrim=duration=4\.000000000\[abrand]/,
    );
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

  it("checks the audio length only where it is padded: branded, with audio", () => {
    // An unbranded export pads nothing, so sound that ends early is the timeline, not a fault.
    expect(buildRenderCommand(timeline(undefined, true), "/o.mp4").audioMustSpanVideo).toBe(false);
    expect(
      buildRenderCommand(timeline(undefined, true), "/o.mp4", { branding: BRAND })
        .audioMustSpanVideo,
    ).toBe(true);
    expect(buildRenderCommand(timeline(), "/o.mp4", { branding: BRAND }).audioMustSpanVideo).toBe(
      false,
    );
  });
});
