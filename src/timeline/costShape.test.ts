import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  COST_FEATURES,
  UNKNOWN_COVER_FACTOR,
  UNKNOWN_STILL_MEGAPIXELS,
  featureTotals,
  summarizeCostShape,
  type CostFeature,
  type CostSourceFacts,
  type SourceFactsLookup,
} from "./costShape";
import { emptyTimeline, type Clip, type Timeline, type Track } from "./model";
import { summarizeRenderWorkload } from "./renderPlan";

const timeline = (tracks: Track[], width = 1080, height = 1920, fps = 30): Timeline => {
  const raw = emptyTimeline(width, height, fps);
  raw.tracks = tracks;
  return raw;
};
const video = (
  id: string,
  ref: string,
  from: number,
  to: number,
  extra: Partial<Clip> = {},
): Clip => ({
  id,
  kind: "video",
  media_ref: ref,
  source_in: 0,
  source_out: to - from,
  timeline_in: from,
  timeline_out: to,
  ...extra,
});
const picture = (
  id: string,
  ref: string,
  from: number,
  to: number,
  extra: Partial<Clip> = {},
): Clip => ({
  id,
  kind: "image",
  media_ref: ref,
  timeline_in: from,
  timeline_out: to,
  ...extra,
});
const track = (clips: Clip[], z = 0, id = `v${z}`, kind: Track["kind"] = "video"): Track => ({
  id,
  kind,
  z,
  clips,
});
const knowing =
  (known: Record<string, CostSourceFacts>): SourceFactsLookup =>
  (id) =>
    known[id] ?? null;
const facts = (
  width: number,
  height: number,
  extra: Partial<CostSourceFacts> = {},
): CostSourceFacts => ({
  width,
  height,
  fps: 30,
  codec: "h264",
  pixFmt: "yuv420p",
  hasAlpha: false,
  ...extra,
});

const zoom = (to = 1.1, frames = 60) => ({
  scale: [
    { t: 0, v: 1 },
    { t: frames, v: to },
  ],
});

/** Every priced feature, as a timeline that has it (`on`) and the same timeline without it. Typed over COST_FEATURES, so a feature added to the
 *  list does not compile until it has a case here, and the walk below checks each case from the outside: the feature is counted when it is
 *  there, not counted when it is not, and nothing else lights up. */
const CASES: Record<CostFeature, (on: boolean) => Timeline> = {
  cover_zoom: (on) =>
    timeline([track([video("a", "a.mp4", 0, 60, { fit: "cover", transform: on ? zoom() : {} })])]),
  contain_zoom: (on) =>
    timeline([track([video("a", "a.mp4", 0, 60, { transform: on ? zoom() : { scale: 1.1 } })])]),
  crossfade: (on) => twoClips(on ? { kind: "crossfade", duration: 12 } : undefined),
  whip: (on) => twoClips(on ? { kind: "whip", duration: 12 } : undefined),
  wipe: (on) => twoClips(on ? { kind: "wipe-l", duration: 12 } : undefined),
  dip: (on) => twoClips(on ? { kind: "dip-to-black", duration: 12 } : undefined),
  fade: (on) => one(on ? { fade: { in: 6, out: 9 } } : {}),
  opacity_animated: (on) =>
    one({
      opacity: on
        ? [
            { t: 0, v: 0 },
            { t: 30, v: 1 },
          ]
        : 1,
    }),
  opacity_constant: (on) => one({ opacity: on ? 0.5 : 1 }),
  blend: (on) => one({ blend: on ? "screen" : "normal" }),
  rotate: (on) => one(on ? { rotate: 7 } : {}),
  glow: (on) => one({ glow: on ? 30 : 0 }),
  blur: (on) => one(effect(on, "blur", { radius: 8 })),
  vignette: (on) => one(effect(on, "vignette", { vignette: 0.3 })),
  grain: (on) => one(effect(on, "grain", { grain: 15 })),
  denoise: (on) => one(effect(on, "denoise", { strength: 4 })),
  sharpen: (on) => one(effect(on, "sharpen", { sharpness: 1 })),
  clarity: (on) => one(effect(on, "clarity", { clarity: 0.5 })),
  motion: (on) => one(effect(on, "motion", { frames: 3 })),
  chroma: (on) => one(effect(on, "chroma", { color: "#00FF00" })),
  grade_basic: (on) => one({ color: { contrast: on ? 1.1 : 1 } }),
  grade_rgb: (on) => one({ color: on ? { exposure: 0.1 } : {} }),
  grade_wheels: (on) => one({ color: on ? { tint: 0.1 } : {} }),
  still_decode: (on) =>
    timeline([track([{ ...video("a", "a.png", 0, 60), kind: on ? "image" : "video" }])]),
  speed_change: (on) => one({ speed: on ? 2 : 1 }),
  crop_flip: (on) => one(on ? { crop: { left: 0.1 } } : { crop: {} }),
  loudness: (on) =>
    timeline([
      track([video("a", "a.mp4", 0, 60)]),
      track(
        [
          {
            id: "m",
            kind: "audio",
            media_ref: "m.wav",
            timeline_in: 0,
            timeline_out: 60,
            effects: on ? [{ type: "loudnorm", params: { target: -14 } }] : [],
          },
        ],
        0,
        "a1",
        "audio",
      ),
    ]),
  captions: (on) =>
    timeline([
      track([video("a", "a.mp4", 0, 60)]),
      ...(on
        ? [
            track(
              [{ id: "t", kind: "text", text: "hello", timeline_in: 10, timeline_out: 40 }],
              1,
              "caps",
              "text",
            ),
          ]
        : []),
    ]),
};

function one(extra: Partial<Clip>): Timeline {
  return timeline([track([video("a", "a.mp4", 0, 60, extra)])]);
}
function effect(on: boolean, type: string, params: Record<string, unknown>): Partial<Clip> {
  return { effects: on ? [{ type, params }] : [] };
}
function twoClips(transition: Clip["transition_in"] | undefined): Timeline {
  return timeline([
    track([
      video("a", "a.mp4", 0, 60),
      video("b", "b.mp4", 60, 120, transition ? { transition_in: transition } : {}),
    ]),
  ]);
}

const shapeOf = (raw: Timeline, options?: Parameters<typeof summarizeCostShape>[1]) => {
  const shape = summarizeCostShape(raw, options);
  expect(shape).not.toBeNull();
  return shape!;
};

describe("summarizeCostShape: what the shape counts", () => {
  it("has a case for every priced feature, and counts exactly that feature when it is there", () => {
    expect(Object.keys(CASES).sort()).toEqual([...COST_FEATURES].sort());
    for (const feature of COST_FEATURES) {
      const on = featureTotals(shapeOf(CASES[feature](true)));
      expect(Object.keys(on), `${feature} on`).toEqual([feature]);
      const load = on[feature]!;
      expect(load.frames, feature).toBeGreaterThan(0);
      expect(load.windowFrames, feature).toBeLessThanOrEqual(load.frames);
      expect(load.windowFrames, feature).toBeGreaterThanOrEqual(0);
      expect(load.mp, feature).toBeGreaterThanOrEqual(0);
      expect(featureTotals(shapeOf(CASES[feature](false))), `${feature} off`).toEqual({});
    }
  });

  it("counts a plain clip once, with no feature, and agrees with 0.27.0's own workload summary", () => {
    const raw = timeline([track([video("a", "a.mp4", 0, 60)])]);
    const shape = shapeOf(raw);
    const workload = summarizeRenderWorkload(raw);
    expect(shape.canvasFrames).toBe(Math.round(workload.durationSeconds * workload.fps));
    expect(shape.frames).toEqual({ video: 60, still: 0, caption: 0, audio: 0 });
    expect(shape.clips).toHaveLength(workload.visualClips);
    expect(shape.peakLayers).toBe(workload.peakMediaLayers);
    expect(shape.meanLayers).toBe(1);
    expect(shape.inputs).toEqual({ video: 1, still: 0, audio: 0 });
    expect(shape.clips[0].loads).toEqual({});
    expect(shape.captionBands).toBe(0);
  });

  it("an empty project is a zero shape, not an error", () => {
    const shape = shapeOf(emptyTimeline());
    expect(shape.canvasFrames).toBe(0);
    expect(shape.clips).toEqual([]);
    expect(shape.common).toEqual({});
    expect(shape.layerFrames).toBe(0);
    expect(shape.meanLayers).toBe(0);
    expect(shape.peakLayers).toBe(0);
    expect(shape.unknownSources).toBe(0);
    expect(shape.unpricedFeatures).toBe(0);
  });

  it("a transition's mask runs on every frame of the incoming clip, lead-in included, but works only in its window", () => {
    const shape = shapeOf(twoClips({ kind: "crossfade", duration: 12 }));
    const [outgoing, incoming] = shape.clips;
    // The cut sits at frame 60: the incoming clip starts 6 frames early (its lead-in) and the outgoing one holds 6 frames past it.
    expect(incoming.frames).toBe(66);
    expect(outgoing.frames).toBe(66);
    expect(incoming.loads.crossfade).toEqual({
      frames: 66,
      windowFrames: 12,
      mp: (1080 * 1920) / 1e6,
    });
    expect(outgoing.loads).toEqual({});
    expect(shape.peakLayers).toBe(2);
  });

  it("a dip's colour flash is as long as the project, not the clip", () => {
    const shape = shapeOf(twoClips({ kind: "dip-to-white", duration: 12 }));
    expect(shape.clips[1].loads.dip).toEqual({
      frames: shape.canvasFrames,
      windowFrames: 12,
      mp: (1080 * 1920) / 1e6,
    });
  });

  it("every kind of transition lands on its own feature, and a custom one is priced as a crossfade", () => {
    const featureOf = (kind: string) =>
      Object.keys(featureTotals(shapeOf(twoClips({ kind, duration: 12, expr: "x" }))));
    expect(featureOf("crossfade")).toEqual(["crossfade"]);
    expect(featureOf("custom")).toEqual(["crossfade"]);
    expect(featureOf("whip")).toEqual(["whip"]);
    expect(featureOf("wipe-l")).toEqual(["wipe"]);
    expect(featureOf("wipe-r")).toEqual(["wipe"]);
    expect(featureOf("dip-to-black")).toEqual(["dip"]);
    expect(featureOf("dip-to-white")).toEqual(["dip"]);
  });

  it("a fade works only on its two ramps and a blend's layer runs for the whole project", () => {
    const raw = timeline([
      track([
        video("a", "a.mp4", 0, 90, { fade: { in: 6, out: 9 } }),
        video("b", "b.mp4", 90, 180, { blend: "multiply" }),
      ]),
    ]);
    const [faded, blended] = shapeOf(raw).clips;
    expect(faded.loads.fade).toMatchObject({ frames: 90, windowFrames: 15 });
    expect(blended.loads.blend).toMatchObject({ frames: 180, windowFrames: 90 });
  });

  it("prices a cover zoom at the size of the picture scaled to cover its box, the way the audit measured it", () => {
    // FILTER-MAP.md 8.5 and 8.8: a 16:9 clip on the vertical canvas is pre-scaled to 3756 x 2112, a canvas-shaped one to 1188 x 2112.
    const cover = (ref: string) =>
      timeline([track([video("a", ref, 0, 60, { fit: "cover", transform: zoom(1.1) })])]);
    const wide = shapeOf(cover("wide.mp4"), { facts: knowing({ "wide.mp4": facts(1920, 1080) }) });
    const tall = shapeOf(cover("tall.mp4"), { facts: knowing({ "tall.mp4": facts(1080, 1920) }) });
    expect(wide.clips[0].loads.cover_zoom!.mp).toBeCloseTo((3756 * 2112) / 1e6, 1);
    expect(tall.clips[0].loads.cover_zoom!.mp).toBeCloseTo((1188 * 2112) / 1e6, 2);
    // A contain zoom has no mask: the box is all it ever draws, whatever the source.
    const contain = shapeOf(
      timeline([track([video("a", "wide.mp4", 0, 60, { transform: zoom(1.1) })])]),
      {
        facts: knowing({ "wide.mp4": facts(1920, 1080) }),
      },
    );
    expect(contain.clips[0].loads.contain_zoom!.mp).toBeCloseTo((1188 * 2112) / 1e6, 2);
    // Without the source's facts the shape says so and prices on a prior, never on a lower figure than the box.
    const unknown = shapeOf(cover("wide.mp4"));
    expect(unknown.clips[0].known).toBe(false);
    expect(unknown.clips[0].loads.cover_zoom!.mp).toBeCloseTo(
      ((1188 * 2112) / 1e6) * UNKNOWN_COVER_FACTOR,
      5,
    );
  });

  it("prices a still by its own pixels, and the same photo costs more than a small picture", () => {
    const stills = (ref: string) => timeline([track([picture("p", ref, 0, 90)])]);
    const photo = shapeOf(stills("photo.jpg"), {
      facts: knowing({ "photo.jpg": facts(4000, 3000) }),
    });
    const small = shapeOf(stills("small.png"), {
      facts: knowing({ "small.png": facts(1080, 1920) }),
    });
    expect(photo.clips[0].loads.still_decode!.mp).toBeCloseTo(12, 5);
    expect(small.clips[0].loads.still_decode!.mp).toBeCloseTo(2.0736, 4);
    expect(photo.clips[0].kind).toBe("still");
    expect(photo.frames.still).toBe(90);
    expect(shapeOf(stills("photo.jpg")).clips[0].loads.still_decode!.mp).toBe(
      UNKNOWN_STILL_MEGAPIXELS,
    );
  });

  it("counts distinct unknown sources, and treats a lookup that fails or answers nonsense as unknown", () => {
    const raw = timeline([
      track([
        video("a", "a.mp4", 0, 30),
        video("b", "a.mp4", 30, 60),
        picture("c", "b.png", 60, 90),
        video("d", "c.mp4", 90, 120),
      ]),
    ]);
    expect(shapeOf(raw).unknownSources).toBe(3);
    expect(shapeOf(raw, { facts: null }).unknownSources).toBe(3);
    expect(shapeOf(raw, { facts: knowing({ "a.mp4": facts(1920, 1080) }) }).unknownSources).toBe(2);
    const odd: SourceFactsLookup = (id) =>
      id === "a.mp4"
        ? facts(Number.NaN, 1080)
        : id === "b.png"
          ? facts(0, 0)
          : (() => {
              throw new Error("probe failed");
            })();
    const shape = shapeOf(raw, { facts: odd });
    expect(shape.unknownSources).toBe(3);
    expect(shape.clips.every((clip) => !clip.known)).toBe(true);
    const known = shapeOf(raw, {
      facts: (id) => facts(1920, 1080, { pixFmt: id === "c.mp4" ? "yuv420p10le" : "yuv420p" }),
    });
    expect(known.unknownSources).toBe(0);
    expect(known.clips.map((clip) => clip.tenBit)).toEqual([false, false, false, true]);
    expect(known.clips.map((clip) => clip.bytesPerPixel)).toEqual([1.5, 1.5, 1.5, 3]);
    expect(shapeOf(raw).clips.map((clip) => clip.bytesPerPixel)).toEqual([null, null, null, null]);
  });

  it("reads the bytes a decoded pixel takes from the pixel format's name, and nothing from a name it does not know", () => {
    const bytes = (pixFmt: string) =>
      shapeOf(timeline([track([picture("p", "p.png", 0, 30)])]), {
        facts: knowing({ "p.png": facts(100, 100, { pixFmt }) }),
      }).clips[0].bytesPerPixel;
    expect(bytes("yuv420p")).toBe(1.5);
    expect(bytes("yuvj420p")).toBe(1.5);
    expect(bytes("yuv422p")).toBe(2);
    expect(bytes("yuv444p")).toBe(3);
    expect(bytes("yuv420p10le")).toBe(3);
    expect(bytes("rgb24")).toBe(3);
    expect(bytes("rgba")).toBe(4);
    expect(bytes("rgb48be")).toBe(6);
    expect(bytes("rgba64le")).toBe(8);
    expect(bytes("gbrp")).toBe(3);
    expect(bytes("gray")).toBe(1);
    expect(bytes("pal8")).toBe(1);
    expect(bytes("no_such_format")).toBeNull();
  });

  it("reads a range of frames: clips outside it are gone, the rest are cut to it", () => {
    const raw = timeline([
      track([
        video("a", "a.mp4", 0, 120, { fade: { in: 6, out: 9 } }),
        video("b", "b.mp4", 120, 240),
      ]),
    ]);
    const shape = shapeOf(raw, { range: { fromFrame: 30, toFrame: 90 } });
    expect(shape.canvasFrames).toBe(60);
    expect(shape.clips.map((clip) => [clip.id, clip.frames])).toEqual([["a", 60]]);
    const workload = summarizeRenderWorkload(raw, { from: 30, to: 90 });
    expect(shape.clips).toHaveLength(workload.visualClips);
    expect(shape.canvasFrames).toBe(Math.round(workload.durationSeconds * workload.fps));
    expect(shape.clips[0].loads.fade!.frames).toBe(60);
    expect(shapeOf(raw, { range: null }).canvasFrames).toBe(240);
  });

  it("does not count a disabled clip, a hidden track or a muted sound", () => {
    const raw = timeline([
      track([video("a", "a.mp4", 0, 60), video("off", "b.mp4", 0, 60, { disabled: true })]),
      { ...track([video("hid", "c.mp4", 0, 60)], 1, "hidden"), hidden: true },
      {
        ...track(
          [
            {
              id: "m",
              kind: "audio",
              media_ref: "m.wav",
              timeline_in: 0,
              timeline_out: 60,
              effects: [{ type: "loudnorm" }],
            },
          ],
          0,
          "a1",
          "audio",
        ),
        mute: true,
      },
    ]);
    const shape = shapeOf(raw);
    expect(shape.clips.map((clip) => clip.id)).toEqual(["a"]);
    expect(shape.inputs.audio).toBe(0);
    expect(shape.common).toEqual({});
  });

  it("counts a caption band once however many captions it holds, and a second one when a picture sits between", () => {
    const text = (id: string, from: number, to: number): Clip => ({
      id,
      kind: "text",
      text: id,
      timeline_in: from,
      timeline_out: to,
    });
    const together = timeline([
      track([video("a", "a.mp4", 0, 90)], 0),
      track([text("t1", 0, 30), text("t2", 20, 50)], 1, "caps", "text"),
    ]);
    const one = shapeOf(together);
    expect(one.captionBands).toBe(1);
    // The two captions overlap on frames 20 to 30: the text pass does useful work on 50 frames, not 60.
    expect(one.common.captions).toEqual({ frames: 90, windowFrames: 50, mp: (1080 * 1920) / 1e6 });
    const apart = timeline([
      track([text("t1", 0, 30)], 0, "low", "text"),
      track([video("a", "a.mp4", 0, 90)], 1),
      track([text("t2", 40, 70)], 2, "high", "text"),
    ]);
    expect(shapeOf(apart).captionBands).toBe(2);
  });

  it("reads a grade as the filters the exporter emits for it", () => {
    // The audit's lab recipe (FILTER-MAP.md 3.3): exposure, eq, colortemperature, vibrance, curves: four RGB filters and one eq.
    const lab = shapeOf(
      one({
        color: {
          contrast: 1.06,
          exposure: 0.05,
          highlights: -0.06,
          saturation: 1.04,
          shadows: 0.04,
          temperature: 6900,
          vibrance: 0.1,
        },
      }),
    );
    expect(featureTotals(lab)).toMatchObject({
      grade_basic: { frames: 60 },
      grade_rgb: { frames: 240 },
    });
    expect(featureTotals(lab).grade_wheels).toBeUndefined();
    const wheels = featureTotals(
      shapeOf(one({ color: { tint: 0.2, shadowsAmount: 0.3, midsAmount: 0.2, highsHue: 40 } })),
    );
    expect(wheels.grade_wheels!.frames).toBe(120);
    // A knob left at its neutral value, or a grade that is not an object, emits nothing.
    expect(
      featureTotals(
        shapeOf(one({ color: { contrast: 1, saturation: 1, brightness: 0, gamma: 1 } })),
      ),
    ).toEqual({});
    expect(featureTotals(shapeOf(one({ color: "warm" as never })))).toEqual({});
  });

  it("reads the effect stack the way the exporter does: disabled and unknown effects emit nothing, a custom filter cannot be priced", () => {
    const stack = (effects: Clip["effects"]) => shapeOf(one({ effects }));
    expect(
      featureTotals(
        stack([
          { type: "blur", enabled: false },
          { type: "wobble", params: {} },
          { type: "clarity", params: { clarity: 0 } },
        ]),
      ),
    ).toEqual({});
    const custom = stack([
      { type: "custom", params: { expr: "geq=r=1" } },
      { type: "custom", params: {} },
    ]);
    expect(custom.unpricedFeatures).toBe(1);
    expect(featureTotals(custom)).toEqual({});
    // A glow authored as an effect blooms like the clip's own glow, with the registry's default strength.
    expect(featureTotals(stack([{ type: "glow" }])).glow).toMatchObject({ frames: 60 });
    expect(featureTotals(stack([{ type: "glow", enabled: false }])).glow).toBeUndefined();
    expect(featureTotals(shapeOf(one({ glow: { amount: 0 } }))).glow).toBeUndefined();
  });

  it("counts the source frames a speed change decodes", () => {
    expect(featureTotals(shapeOf(one({ speed: 2 }))).speed_change).toMatchObject({ frames: 120 });
    expect(featureTotals(shapeOf(one({ speed: 0.5 }))).speed_change).toMatchObject({ frames: 60 });
    expect(featureTotals(shapeOf(one({ speed: 1 }))).speed_change).toBeUndefined();
  });

  it("runs every filter of a zooming clip at its largest size, a position drift alone is no zoom", () => {
    const zoomed = shapeOf(one({ transform: zoom(1.5), fade: { in: 6 } }));
    expect(zoomed.clips[0].loads.fade!.mp).toBeCloseTo((1.5 * 1080 * (1.5 * 1920)) / 1e6, 4);
    const drift = shapeOf(
      one({
        transform: {
          position: {
            x: [
              { t: 0, v: 0.4 },
              { t: 60, v: 0.6 },
            ],
            y: 0.5,
          },
        },
      }),
    );
    expect(featureTotals(drift)).toEqual({});
    // A picture-in-picture is cheaper than a full-canvas clip, not dearer.
    const small = shapeOf(one({ transform: { scale: 0.5 }, fade: { in: 6 } }));
    expect(small.clips[0].loads.fade!.mp).toBeCloseTo((540 * 960) / 1e6, 4);
  });

  it("the project with every feature at once has every feature", () => {
    const raw = timeline([
      track(
        [
          picture("still", "photo.jpg", 0, 120, {
            fit: "cover",
            transform: zoom(1.2, 120),
            fade: { in: 6, out: 9 },
            speed: 2,
          }),
          video("v1", "v1.mp4", 120, 240, {
            transition_in: { kind: "whip", duration: 12 },
            color: { exposure: 0.1, contrast: 1.1, tint: 0.1 },
            effects: [
              { type: "blur" },
              { type: "vignette" },
              { type: "grain" },
              { type: "denoise" },
              { type: "sharpen" },
              { type: "clarity", params: { clarity: 1 } },
              { type: "motion" },
              { type: "chroma" },
            ],
            glow: 20,
            rotate: 5,
            crop: { top: 0.1 },
            opacity: 0.8,
          }),
          video("v2", "v2.mp4", 240, 360, {
            transition_in: { kind: "dip-to-black", duration: 12 },
            opacity: [
              { t: 0, v: 0 },
              { t: 30, v: 1 },
            ],
            blend: "screen",
            transform: zoom(1.1, 120),
          }),
          video("v3", "v3.mp4", 360, 480, { transition_in: { kind: "wipe-r", duration: 12 } }),
          video("v4", "v4.mp4", 480, 600, { transition_in: { kind: "crossfade", duration: 12 } }),
        ],
        0,
      ),
      track(
        [
          {
            id: "m",
            kind: "audio",
            media_ref: "m.wav",
            timeline_in: 0,
            timeline_out: 600,
            effects: [{ type: "loudnorm" }],
          },
        ],
        0,
        "a1",
        "audio",
      ),
      track(
        [{ id: "t", kind: "text", text: "hi", timeline_in: 0, timeline_out: 90 }],
        2,
        "caps",
        "text",
      ),
    ]);
    const totals = featureTotals(shapeOf(raw));
    const missing = COST_FEATURES.filter((feature) => !totals[feature]);
    // The still carries the cover zoom and the video the contain zoom; every other feature appears once in this project.
    expect(missing).toEqual([]);
  });

  it("never throws, and gives null only for what it cannot read", () => {
    expect(summarizeCostShape(null as never)).toBeNull();
    expect(summarizeCostShape({} as never)).toBeNull();
    expect(
      summarizeCostShape({
        canvas: { width: Number.NaN, height: 10, fps: 30 },
        tracks: [],
      } as never),
    ).toBeNull();
    expect(
      summarizeCostShape({ canvas: { width: 10, height: 10, fps: 30 }, tracks: "x" } as never),
    ).toBeNull();
    const reading = summarizeCostShape(timeline([track([video("a", "a.mp4", 0, 60)])]), {
      facts: () => {
        throw new Error("no probe");
      },
      range: { fromFrame: Number.NaN, toFrame: Number.POSITIVE_INFINITY },
    });
    expect(reading?.canvasFrames).toBe(60);
  });
});

describe("summarizeCostShape: invariants over random projects", () => {
  const clipArb = fc.record({
    kind: fc.constantFrom("video", "image", "text", "audio"),
    from: fc.integer({ min: 0, max: 300 }),
    length: fc.integer({ min: 1, max: 200 }),
    z: fc.integer({ min: 0, max: 3 }),
  });

  it("agrees with 0.27.0's workload summary on frames, clips and layers, for any range", () => {
    fc.assert(
      fc.property(
        fc.array(clipArb, { minLength: 0, maxLength: 7 }),
        fc.option(
          fc.record({
            from: fc.integer({ min: 0, max: 300 }),
            length: fc.integer({ min: 0, max: 300 }),
          }),
        ),
        (clips, window) => {
          const raw = timeline(
            clips.map((clip, index) =>
              track(
                [
                  {
                    id: `c${index}`,
                    kind: clip.kind as Clip["kind"],
                    ...(clip.kind === "text" ? { text: "x" } : { media_ref: `m${index}` }),
                    timeline_in: clip.from,
                    timeline_out: clip.from + clip.length,
                  },
                ],
                clip.z,
                `t${index}`,
                clip.kind === "text" ? "text" : clip.kind === "audio" ? "audio" : "video",
              ),
            ),
          );
          const range = window ? { from: window.from, to: window.from + window.length } : undefined;
          const shape = summarizeCostShape(
            raw,
            range ? { range: { fromFrame: range.from, toFrame: range.to } } : undefined,
          );
          const workload = summarizeRenderWorkload(raw, range);
          expect(shape).not.toBeNull();
          expect(shape!.canvasFrames).toBe(Math.round(workload.durationSeconds * workload.fps));
          expect(shape!.clips).toHaveLength(workload.visualClips);
          expect(shape!.peakLayers).toBe(workload.peakMediaLayers);
          expect(shape!.inputs.audio).toBe(workload.audioClips);
        },
      ),
    );
  });

  it("every load is finite, non-negative and inside its own frames, whatever the clip says", () => {
    const anything = fc.anything();
    const number = fc.oneof(
      fc.double(),
      fc.integer({ min: -5, max: 500 }),
      fc.string(),
      fc.constant(undefined),
      fc.constant(null),
    );
    const keyframes = fc.array(fc.record({ t: number, v: number }), { maxLength: 4 });
    const animatable = fc.oneof(number, keyframes);
    const loose = <T>(structured: fc.Arbitrary<T>) => fc.oneof(structured, anything);
    const params = loose(
      fc.record(
        {
          radius: number,
          strength: number,
          clarity: number,
          dehaze: number,
          expr: fc.string(),
          intensity: number,
        },
        { requiredKeys: [] },
      ),
    );
    const effect = fc.record(
      {
        type: fc.constantFrom(
          "blur",
          "vignette",
          "grain",
          "denoise",
          "sharpen",
          "clarity",
          "motion",
          "chroma",
          "glow",
          "custom",
          "zzz",
        ),
        enabled: fc.boolean(),
        params,
      },
      { requiredKeys: ["type"] },
    );
    const clipFields = fc.record({
      transform: loose(
        fc.record(
          {
            scale: animatable,
            scale_x: animatable,
            scale_y: animatable,
            position: loose(fc.record({ x: animatable, y: animatable }, { requiredKeys: [] })),
          },
          { requiredKeys: [] },
        ),
      ),
      fade: loose(fc.record({ in: number, out: number }, { requiredKeys: [] })),
      opacity: animatable,
      rotate: animatable,
      glow: loose(fc.oneof(number, fc.record({ amount: number }, { requiredKeys: [] }))),
      blend: fc.oneof(fc.constantFrom("normal", "screen", "multiply"), anything),
      effects: loose(fc.array(effect, { maxLength: 4 })),
      color: loose(
        fc.record(
          {
            exposure: number,
            contrast: number,
            temperature: number,
            tint: number,
            shadowsAmount: number,
            lut: fc.string(),
            masterCurve: fc.array(fc.array(number, { maxLength: 3 }), { maxLength: 3 }),
          },
          { requiredKeys: [] },
        ),
      ),
      crop: loose(fc.record({ left: number, top: number }, { requiredKeys: [] })),
      flip: loose(fc.record({ h: fc.boolean(), v: fc.boolean() }, { requiredKeys: [] })),
      speed: number,
      fit: fc.oneof(fc.constantFrom("contain", "cover", "stretch"), anything),
      transition_in: loose(
        fc.record(
          {
            kind: fc.constantFrom("crossfade", "whip", "wipe-l", "dip-to-black", "zzz"),
            duration: number,
          },
          { requiredKeys: [] },
        ),
      ),
    });
    fc.assert(
      fc.property(clipFields, fc.constantFrom("video", "image"), (fields, kind) => {
        const raw = timeline([
          track([
            { ...video("a", "a.mp4", 0, 90), kind, ...fields } as unknown as Clip,
            video("b", "b.mp4", 90, 150, { transition_in: fields.transition_in as never }),
          ]),
        ]);
        const shape = summarizeCostShape(raw);
        if (shape === null) return;
        for (const loads of [shape.common, ...shape.clips.map((clip) => clip.loads)])
          for (const load of Object.values(loads)) {
            expect(Number.isFinite(load.frames) && load.frames > 0).toBe(true);
            expect(Number.isFinite(load.mp) && load.mp >= 0).toBe(true);
            expect(load.windowFrames).toBeGreaterThanOrEqual(0);
            expect(load.windowFrames).toBeLessThanOrEqual(load.frames);
          }
        expect(Number.isFinite(shape.meanLayers) && shape.meanLayers >= 0).toBe(true);
        expect(Number.isInteger(shape.unpricedFeatures) && shape.unpricedFeatures >= 0).toBe(true);
      }),
      { numRuns: 400 },
    );
  });
});
