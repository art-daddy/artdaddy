import { describe, expect, it } from "vitest";

import { outputFps, outputSize, type ExportResolution } from "./exportOptions";
import {
  QUICK_BUNDLE,
  QUICK_MAX_FPS,
  QUICK_QUALITY,
  ROUTE_QUESTION_SECONDS,
  SIZE_PRESETS,
  chooseRoute,
  explicitOfCall,
  fastSpeedupLabel,
  isWeakPc,
  needsSlowConfirm,
  quickDefaultSize,
  quickRate,
  quickSettings,
  quickSizeChoices,
  routeQuestionDue,
  type ChoiceSettings,
  type QuickBundle,
  type QuickSettingsInput,
  type RouteDecision,
  type RouteInput,
} from "./exportRoute";
import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";
import { PC_CLASSES, QUICK_OFFERS, ROUTE_KINDS } from "./exportTypes3c";

const canvas = (width: number, height: number, fps = 30) => ({ width, height, fps });
const NONE_SET = { size: false, fps: false, quality: false };

/** A project of one clip on a canvas: what the render builds its command from. */
const projectOf = (c: { width: number; height: number; fps: number }): Timeline =>
  ({
    canvas: c,
    tracks: [
      {
        id: "v",
        kind: "video",
        z: 0,
        clips: [
          { media_ref: "/a.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 },
        ],
      },
    ],
  }) as unknown as Timeline;

describe("the bundle: every figure of Fast export in one frozen place", () => {
  it("holds the owner's figures", () => {
    expect(QUICK_BUNDLE.ladder).toEqual(["2160p", "1080p", "720p", "480p"]);
    expect(QUICK_BUNDLE.maxFps).toBe(30);
    expect(QUICK_BUNDLE.quality).toBe("medium");
    expect(QUICK_BUNDLE.confirm).toEqual({ shortSide: 2160, fps: 50, durationSeconds: 600 });
    // Until the lab has measured, no figure may be claimed.
    expect(QUICK_BUNDLE.speedup).toEqual([]);
    expect(QUICK_MAX_FPS).toBe(QUICK_BUNDLE.maxFps);
    expect(QUICK_QUALITY).toBe("medium");
  });

  it("cannot be changed by accident: the constant, its ladder, its cut-offs and its table are frozen", () => {
    expect(Object.isFrozen(QUICK_BUNDLE)).toBe(true);
    expect(Object.isFrozen(QUICK_BUNDLE.ladder)).toBe(true);
    expect(Object.isFrozen(QUICK_BUNDLE.confirm)).toBe(true);
    expect(Object.isFrozen(QUICK_BUNDLE.speedup)).toBe(true);
    expect(Object.isFrozen(SIZE_PRESETS)).toBe(true);
  });

  it("names only sizes the exporter makes, and its table of short sides is the exporter's own (walked over every preset, with a canvas just above and at each)", () => {
    // The short side of a preset, asked of `outputSize` on a canvas far larger than any preset.
    const side = (preset: ExportResolution) => outputSize(100_000, 100_000, preset)?.w;
    const sides = SIZE_PRESETS.map((preset) => side(preset));
    expect(sides).toEqual([2160, 1440, 1080, 720, 480]);
    expect(SIZE_PRESETS).toEqual(["2160p", "1440p", "1080p", "720p", "480p"]);
    for (const [i, preset] of SIZE_PRESETS.entries()) {
      const px = sides[i] as number;
      // A canvas whose short side is exactly the preset's is not made smaller by it, and one a little over is.
      expect(outputSize(px, px, preset)).toBeNull();
      expect(outputSize(px + 2, px + 2, preset)).not.toBeNull();
      expect(quickSizeChoices(canvas(px, px))).not.toContain(preset);
      expect(quickSizeChoices(canvas(px + 2, px + 2))).toContain(preset);
    }
    for (const rung of QUICK_BUNDLE.ladder) expect(SIZE_PRESETS).toContain(rung);
    const ladderSides = QUICK_BUNDLE.ladder.map((rung) => side(rung) as number);
    expect([...ladderSides].sort((a, b) => b - a)).toEqual(ladderSides);
  });
});

describe("quickDefaultSize: one rung below the project's size, by its short side", () => {
  it("is the owner's table", () => {
    const rows: [number, number, string | null][] = [
      [1080, 1920, "720p"], // a vertical project is read by its short side
      [1920, 1080, "720p"],
      [3840, 2160, "1080p"],
      [2160, 3840, "1080p"],
      [2560, 1440, "1080p"], // 1440 is not a rung: the largest rung strictly below it
      [1440, 2560, "1080p"],
      [1280, 720, "480p"],
      [720, 1280, "480p"],
      [854, 480, null], // 480 or smaller keeps its size
      [640, 360, null],
      [480, 480, null],
      [2, 2, null],
      [1366, 768, "720p"],
      [7680, 4320, "2160p"], // above the top rung: the top rung is the one below
      [1081, 1921, "1080p"], // just over a rung: that rung
      [1079, 1919, "720p"],
      [1001, 563, "480p"], // odd canvases
      [853, 481, "480p"],
    ];
    for (const [w, h, expected] of rows)
      expect({ canvas: [w, h], size: quickDefaultSize(canvas(w, h)) }).toEqual({
        canvas: [w, h],
        size: expected,
      });
  });

  it("answers null, and does not throw, for a canvas that is not one", () => {
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY])
      expect(quickDefaultSize({ width: bad, height: 1080 })).toBeNull();
    for (const junk of [undefined, null, 5, {}]) expect(quickDefaultSize(junk as never)).toBeNull();
  });

  it("reads its ladder from the data: another ladder gives another size, with nothing else changed", () => {
    const other: QuickBundle = { ...QUICK_BUNDLE, ladder: ["1440p", "480p"] };
    expect(quickDefaultSize(canvas(3840, 2160), other)).toBe("1440p");
    expect(quickDefaultSize(canvas(1920, 1080), other)).toBe("480p");
    expect(quickDefaultSize(canvas(854, 480), other)).toBeNull();
    // the order of the data does not matter, and an entry that is not a size is passed over
    const shuffled = { ...QUICK_BUNDLE, ladder: ["480p", "nonsense", "2160p", "720p", "1080p"] };
    expect(quickDefaultSize(canvas(1920, 1080), shuffled as never)).toBe("720p");
    expect(quickDefaultSize(canvas(1920, 1080), { ...QUICK_BUNDLE, ladder: [] })).toBeNull();
  });
});

describe("quickSizeChoices: the same as the project and every smaller size, never one that is larger", () => {
  it("is a table", () => {
    const rows: [number, number, ExportResolution[]][] = [
      [3840, 2160, ["source", "1440p", "1080p", "720p", "480p"]],
      [2560, 1440, ["source", "1080p", "720p", "480p"]],
      [1920, 1080, ["source", "720p", "480p"]],
      [1080, 1920, ["source", "720p", "480p"]],
      [1366, 768, ["source", "720p", "480p"]],
      [1280, 720, ["source", "480p"]],
      [854, 480, ["source"]],
      [640, 360, ["source"]],
      [7680, 4320, ["source", "2160p", "1440p", "1080p", "720p", "480p"]],
    ];
    for (const [w, h, choices] of rows) expect(quickSizeChoices(canvas(w, h))).toEqual(choices);
  });

  it("offers the default size as one of them wherever there is a default", () => {
    for (const [w, h] of [
      [3840, 2160],
      [1920, 1080],
      [1080, 1920],
      [1280, 720],
      [1366, 768],
      [7680, 4320],
    ] as const)
      expect(quickSizeChoices(canvas(w, h))).toContain(quickDefaultSize(canvas(w, h)));
  });

  it("is only the same as the project for a canvas that is not one", () => {
    for (const junk of [
      undefined,
      null,
      {},
      { width: 0, height: 5 },
      { width: Number.NaN, height: 4 },
    ])
      expect(quickSizeChoices(junk as never)).toEqual(["source"]);
  });
});

describe("quickRate: the rate Fast delivers", () => {
  it("is the table of the decision: 60 gives 30, 50 gives 25, 48 gives 24, lower rates stay", () => {
    const table: [number, number][] = [
      [120, 30],
      [100, 25],
      [60, 30],
      [50, 25],
      [48, 24],
      [30, 30],
      [29.97, 29.97],
      [25, 25],
      [24, 24],
      [23.976, 23.976],
      [12, 12],
      [1, 1],
      // Not a whole half, so the cap: a rate that does not halve cleanly is not cut to a half.
      [90, 30],
      [59.94, 30],
      [31, 30],
      [75, 30],
      // The half is kept while it stays whole and above the cap, so these end below it (the decided function).
      [72, 18],
      [32, 16],
    ];
    for (const [rate, expected] of table) expect(quickRate(rate)).toBe(expected);
  });

  it("is no rate for anything that is not a positive number", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(quickRate(bad)).toBeNull();
    for (const bad of [undefined, null, "60", {}]) expect(quickRate(bad as never)).toBeNull();
  });

  it("never raises a rate and never delivers more than the cap unless the source is under it", () => {
    for (let rate = 1; rate <= 240; rate += 0.5) {
      const capped = quickRate(rate) as number;
      expect(capped).toBeLessThanOrEqual(rate);
      expect(capped).toBeLessThanOrEqual(QUICK_MAX_FPS);
      if (rate <= QUICK_MAX_FPS) expect(capped).toBe(rate);
    }
  });

  it("reads its cap from the data", () => {
    expect(quickRate(60, 24)).toBe(15);
    expect(quickRate(50, 25)).toBe(25);
    expect(quickRate(60, 60)).toBe(60);
  });
});

const settings = (over: Partial<QuickSettingsInput> = {}): ReturnType<typeof quickSettings> =>
  quickSettings({
    canvas: canvas(1920, 1080),
    requested: {},
    explicit: NONE_SET,
    ...over,
  });

describe("quickSettings: a smaller picture, at most 30 frames a second and Medium, where they were not set", () => {
  it("sets the size one rung below the project's, whatever the PC", () => {
    const rows: [number, number, string, boolean][] = [
      [3840, 2160, "1080p", true],
      [2560, 1440, "1080p", true],
      [1920, 1080, "720p", true],
      [1080, 1920, "720p", true], // a vertical project is read by its short side
      [2160, 3840, "1080p", true],
      [1366, 768, "720p", true],
      [1280, 720, "480p", true],
      [854, 480, "source", false],
      [640, 360, "source", false],
    ];
    for (const [width, height, resolution, changedSize] of rows)
      expect({
        canvas: [width, height],
        ...settings({ canvas: canvas(width, height) }),
      }).toMatchObject({ resolution, changedSize, changedFps: false });
  });

  it("caps the rate at 30 by the decided function, and keeps a lower one", () => {
    const rows: [number, number | undefined, boolean][] = [
      [60, 30, true],
      [50, 25, true],
      [48, 24, true],
      [120, 30, true],
      [30, undefined, false],
      [24, undefined, false],
      [29.97, undefined, false],
    ];
    for (const [fps, expected, changedFps] of rows)
      expect(settings({ canvas: canvas(1920, 1080, fps) })).toMatchObject({
        fps: expected,
        changedFps,
      });
  });

  it("sets Medium where no quality was set, and keeps any quality that was", () => {
    expect(settings()).toMatchObject({ quality: "medium", changedQuality: true });
    expect(settings({ requested: { quality: "medium" } })).toMatchObject({
      quality: "medium",
      changedQuality: false,
    });
    // a quality that was not set is replaced by Medium, whatever the request carried (the dialog's own start is Medium and is not a pick)
    expect(settings({ requested: { quality: "high" } })).toMatchObject({
      quality: "medium",
      changedQuality: true,
    });
    for (const quality of ["high", "medium", "low"] as const)
      expect(
        settings({ requested: { quality }, explicit: { ...NONE_SET, quality: true } }),
      ).toMatchObject({ quality, changedQuality: false });
    expect(settings({ requested: {}, explicit: { ...NONE_SET, quality: true } })).toMatchObject({
      quality: undefined,
      changedQuality: false,
    });
  });

  it("never enlarges: a smaller size or a lower rate that was asked for is kept, even if it was not set", () => {
    expect(settings({ requested: { resolution: "480p" } })).toMatchObject({
      resolution: "480p",
      changedSize: false,
    });
    expect(
      settings({ canvas: canvas(3840, 2160), requested: { resolution: "720p" } }),
    ).toMatchObject({ resolution: "720p", changedSize: false });
    expect(settings({ canvas: canvas(1920, 1080, 60), requested: { fps: 24 } })).toMatchObject({
      fps: 24,
      changedFps: false,
    });
    expect(settings({ canvas: canvas(1920, 1080, 60), requested: { fps: 60 } })).toMatchObject({
      fps: 30,
      changedFps: true,
    });
  });

  it("leaves a size that was set alone, and composes the rate and the quality", () => {
    expect(
      settings({
        canvas: canvas(3840, 2160, 60),
        requested: { resolution: "1440p" },
        explicit: { size: true, fps: false, quality: false },
      }),
    ).toMatchObject({
      resolution: "1440p",
      fps: 30,
      quality: "medium",
      changedSize: false,
      changedFps: true,
      changedQuality: true,
    });
  });

  it("leaves a rate that was set alone, even one above the cap, and composes the size", () => {
    expect(
      settings({
        canvas: canvas(3840, 2160, 60),
        requested: { fps: 24 },
        explicit: { size: false, fps: true, quality: false },
      }),
    ).toMatchObject({ resolution: "1080p", fps: 24, changedSize: true, changedFps: false });
    expect(
      settings({
        canvas: canvas(1920, 1080, 60),
        requested: { fps: 60 },
        explicit: { size: false, fps: true, quality: false },
      }),
    ).toMatchObject({ fps: 60, changedFps: false });
  });

  it("with all three set changes nothing: Fast is then only the encoder", () => {
    const result = settings({
      canvas: canvas(3840, 2160, 60),
      requested: { resolution: "2160p", fps: 60, quality: "high" },
      explicit: { size: true, fps: true, quality: true },
    });
    expect(result).toMatchObject({
      resolution: "2160p",
      fps: 60,
      quality: "high",
      changedSize: false,
      changedFps: false,
      changedQuality: false,
    });
    expect(result.delivered).toEqual({ width: 3840, height: 2160, fps: 60 });
  });

  it("says what it delivers: the size and the rate the exporter's own functions make of the three settings", () => {
    const result = settings({ canvas: canvas(3840, 2160, 60) });
    expect(result.delivered).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(outputSize(3840, 2160, result.resolution)).toEqual({ w: 1920, h: 1080 });
    expect(outputFps(60, result.fps)).toBe(30);
    expect(settings({ canvas: canvas(1080, 1920) }).delivered).toEqual({
      width: 720,
      height: 1280,
      fps: 30,
    });
    expect(settings({ canvas: canvas(854, 480) }).delivered).toEqual({
      width: 854,
      height: 480,
      fps: 30,
    });
    expect(settings({ canvas: canvas(Number.NaN, 5) }).delivered).toBeNull();
  });

  it("makes the picture the render says it makes (its own plan's output), on canvases of every kind, odd ones and fractional rates included", () => {
    const canvases = [
      canvas(1920, 1080, 30),
      canvas(1080, 1920, 30),
      canvas(3840, 2160, 60),
      canvas(2560, 1440, 50),
      canvas(1366, 768, 30),
      canvas(1280, 720, 24),
      canvas(854, 480, 25),
      canvas(1001, 563, 30), // odd
      canvas(1081, 1921, 30),
      canvas(1919, 1079, 60),
      canvas(3841, 2161, 48),
      canvas(1920, 1080, 29.97),
      canvas(1920, 1080, 59.94),
      canvas(7680, 4320, 120),
    ];
    const asked: Partial<QuickSettingsInput>[] = [
      { requested: {}, explicit: NONE_SET },
      { requested: { resolution: "720p" }, explicit: { size: true, fps: false, quality: false } },
      { requested: { fps: 24 }, explicit: { size: false, fps: true, quality: false } },
      { requested: { resolution: "1440p", fps: 25 }, explicit: { size: true, fps: true } },
      { requested: { resolution: "source" }, explicit: { size: true, fps: false } },
    ];
    for (const c of canvases)
      for (const ask of asked) {
        const made = settings({ canvas: c, ...ask });
        const plan = buildRenderCommand(projectOf(c), "/out.mp4", {
          resolution: made.resolution,
          fps: made.fps,
          quality: made.quality,
        });
        expect({ canvas: c, ask, delivered: made.delivered }).toEqual({
          canvas: c,
          ask,
          delivered: plan.output,
        });
        // and every side of what is made is even, so that it can be encoded
        expect((made.delivered?.width ?? 0) % 2).toBe(0);
        expect((made.delivered?.height ?? 0) % 2).toBe(0);
      }
  });

  it("reads its data from the bundle it is given: with another ladder and cap it makes another picture", () => {
    const light: QuickBundle = { ...QUICK_BUNDLE, ladder: ["480p"], maxFps: 24, quality: "low" };
    expect(settings({ canvas: canvas(3840, 2160, 60), bundle: light })).toMatchObject({
      resolution: "480p",
      fps: 15,
      quality: "low",
    });
  });

  it("does not throw, and changes nothing, for input that is not a picture", () => {
    for (const junk of [undefined, null, 5, {}, { canvas: null }, { canvas: {} }]) {
      expect(() => quickSettings(junk as never)).not.toThrow();
      expect(quickSettings(junk as never)).toMatchObject({
        resolution: "source",
        changedSize: false,
        changedFps: false,
        changedQuality: false,
      });
    }
    for (const bad of [Number.NaN, 0, -3, Number.POSITIVE_INFINITY]) {
      expect(settings({ canvas: canvas(bad, bad, bad) })).toMatchObject({
        changedSize: false,
        changedFps: false,
        delivered: null,
      });
    }
    // A request that is not a resolution, a rate or a quality is the project's own.
    expect(
      settings({
        requested: { resolution: "8k" as never, fps: Number.NaN, quality: "ultra" as never },
        explicit: { size: true, fps: true, quality: true },
      }),
    ).toMatchObject({ resolution: "source", fps: undefined, quality: undefined });
  });

  it("reads a set it cannot read as set, so that nothing is ever taken from the person", () => {
    for (const explicit of [undefined, null, {}, { size: "no", fps: 0 }, { size: undefined }])
      expect(
        settings({
          canvas: canvas(3840, 2160, 60),
          requested: { quality: "high" },
          explicit: explicit as never,
        }),
      ).toMatchObject({
        resolution: "source",
        quality: "high",
        changedSize: false,
        changedFps: false,
        changedQuality: false,
      });
    // a quality the caller does not know about (the old two-flag form) is read as set, so it is kept
    expect(
      settings({ requested: { quality: "high" }, explicit: { size: false, fps: false } }),
    ).toMatchObject({ quality: "high", changedQuality: false });
  });
});

describe("explicitOfCall: what a call to the export tool set", () => {
  it("is a table", () => {
    const rows: [Record<string, unknown> | null | undefined, boolean, boolean, boolean][] = [
      [{}, false, false, false],
      [undefined, false, false, false],
      [null, false, false, false],
      [{ resolution: "source" }, false, false, false], // the Export menu sends it every time
      [{ resolution: " SOURCE " }, false, false, false],
      [{ resolution: "" }, false, false, false],
      [{ resolution: 720 }, false, false, false],
      [{ resolution: "720p" }, true, false, false],
      [{ resolution: "1080p", fps: 30, quality: "low" }, true, true, true],
      [{ fps: 24 }, false, true, false],
      [{ fps: "24" }, false, false, false],
      [{ fps: Number.NaN }, false, false, false],
      [{ fps: null }, false, false, false],
      [{ quality: "high" }, false, false, true],
      [{ quality: "" }, false, false, false],
      [{ quality: 3 }, false, false, false],
    ];
    for (const [args, size, fps, quality] of rows)
      expect({ args, set: explicitOfCall(args) }).toEqual({
        args,
        set: { size, fps, quality },
      });
  });
});

describe("chooseRoute: Fast is on offer whenever its switch is on, and is selected only by a pick of it", () => {
  const route = (over: Partial<RouteInput> = {}): RouteDecision =>
    chooseRoute({ quickRouteOn: true, picked: null, ...over });

  it("offers Fast when the switch is on, with nothing preselected", () => {
    expect(route()).toEqual({ offered: true, selected: "standard", reason: "offered" });
  });

  it("selects Fast only where it was picked", () => {
    expect(route({ picked: "quick" })).toEqual({
      offered: true,
      selected: "quick",
      reason: "offered",
    });
    expect(route({ picked: "standard" })).toEqual({
      offered: true,
      selected: "standard",
      reason: "offered",
    });
  });

  it("offers nothing, and says it is off, when the switch is off, whatever was picked", () => {
    for (const picked of [null, "quick", "standard"] as const)
      expect(route({ quickRouteOn: false, picked })).toEqual({
        offered: false,
        selected: "standard",
        reason: "off",
      });
  });

  it("answers in the report's vocabulary, with only the two reasons it can have", () => {
    const reasons = new Set<string>();
    for (const quickRouteOn of [true, false])
      for (const picked of [null, "quick", "standard"] as const) {
        const decision = route({ quickRouteOn, picked });
        reasons.add(decision.reason);
        expect(QUICK_OFFERS).toContain(decision.reason);
        expect(ROUTE_KINDS).toContain(decision.selected);
      }
    expect([...reasons].sort()).toEqual(["off", "offered"]);
  });

  it("is not moved by anything but the switch and the pick: the same decision for every PC, project and length the caller might hold", () => {
    // It takes no such input, so a caller cannot push one in; extra fields from the estimate design are not read.
    for (const extra of [
      { pcClass: "weak" },
      { pcClass: "fast" },
      { full: { seconds: 40 } },
      { explicit: { size: true, fps: true } },
    ])
      expect(chooseRoute({ quickRouteOn: true, picked: null, ...extra } as RouteInput)).toEqual(
        route(),
      );
  });

  it("does not throw, offers nothing, and keeps Quality for input that is not an input", () => {
    for (const junk of [
      undefined,
      null,
      0,
      "x",
      [],
      {},
      { quickRouteOn: 1 },
      { quickRouteOn: "yes" },
    ]) {
      expect(() => chooseRoute(junk as unknown as RouteInput)).not.toThrow();
      expect(chooseRoute(junk as unknown as RouteInput)).toEqual({
        offered: false,
        selected: "standard",
        reason: "off",
      });
    }
    // a pick that is not a route is no pick
    expect(route({ picked: "turbo" as never })).toMatchObject({
      offered: true,
      selected: "standard",
    });
  });
});

describe("routeQuestionDue: when the chat card would ask", () => {
  const offered = chooseRoute({ quickRouteOn: true, picked: null });
  const off = chooseRoute({ quickRouteOn: false, picked: null });

  it("asks where Fast is on offer and the app's rough guess for Quality is over ten minutes, and not at ten minutes", () => {
    expect(routeQuestionDue({ decision: offered, fullSeconds: ROUTE_QUESTION_SECONDS + 1 })).toBe(
      true,
    );
    expect(routeQuestionDue({ decision: offered, fullSeconds: ROUTE_QUESTION_SECONDS })).toBe(
      false,
    );
    expect(routeQuestionDue({ decision: offered, fullSeconds: 120 })).toBe(false);
    expect(routeQuestionDue({ decision: offered, fullSeconds: 7200 })).toBe(true);
    expect(ROUTE_QUESTION_SECONDS).toBe(600);
  });

  it("has no weak-PC clause: a PC class is not an input, so a short export on any PC is never asked about", () => {
    for (const pcClass of PC_CLASSES)
      expect(routeQuestionDue({ pcClass, decision: offered, fullSeconds: 90 } as never)).toBe(
        false,
      );
  });

  it("never asks where Fast is not on offer, however long the export", () => {
    for (const fullSeconds of [10, 7200, null])
      expect(routeQuestionDue({ decision: off, fullSeconds })).toBe(false);
  });

  it("asks nothing without a guess it can read", () => {
    for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, -5, "900" as never])
      expect(routeQuestionDue({ decision: offered, fullSeconds: bad })).toBe(false);
    for (const junk of [undefined, null, {}, { decision: null }])
      expect(routeQuestionDue(junk as never)).toBe(false);
  });
});

/** The lab's table, as a test gives it: every project has a figure. */
const WITH_LAB: QuickBundle = { ...QUICK_BUNDLE, speedup: [{ figure: 4 }] };

describe("fastSpeedupLabel: the figure in brackets on the Fast choice", () => {
  const project = (width: number, height: number, fps: number, durationSeconds: number) => ({
    width,
    height,
    fps,
    durationSeconds,
  });

  it("claims nothing in this build, whatever the project: the lab's table is empty", () => {
    for (const facts of [
      project(3840, 2160, 60, 3600),
      project(1920, 1080, 30, 60),
      project(854, 480, 24, 10),
    ])
      expect(fastSpeedupLabel(facts)).toBeNull();
  });

  it("gives the figure of the first row that covers the project, and none where no row does", () => {
    const table: QuickBundle = {
      ...QUICK_BUNDLE,
      speedup: [
        { shortSide: { min: 2160 }, fps: { min: 50 }, figure: 6 },
        { shortSide: { min: 2160 }, figure: 4 },
        { fps: { min: 50 }, durationSeconds: { max: 600 }, figure: 3 },
        { durationSeconds: { min: 601 }, figure: 2.5 },
      ],
    };
    const rows: [ReturnType<typeof project>, number | null][] = [
      [project(3840, 2160, 60, 100), 6], // the first row, not the second
      [project(3840, 2160, 30, 100), 4],
      [project(1920, 1080, 60, 100), 3],
      [project(1920, 1080, 60, 700), 2.5], // too long for the third, which is open below
      [project(1920, 1080, 30, 700), 2.5],
      [project(1920, 1080, 30, 100), null],
    ];
    for (const [facts, figure] of rows)
      expect({ facts, figure: fastSpeedupLabel(facts, table) }).toEqual({ facts, figure });
  });

  it("holds both ends of a range, and reads an open end as open", () => {
    const table: QuickBundle = {
      ...QUICK_BUNDLE,
      speedup: [{ durationSeconds: { min: 100, max: 200 }, figure: 3 }],
    };
    for (const [seconds, figure] of [
      [99, null],
      [100, 3],
      [150, 3],
      [200, 3],
      [201, null],
    ] as const)
      expect(fastSpeedupLabel(project(1920, 1080, 30, seconds), table)).toBe(figure);
  });

  it("reads the project as the render does: the short side it composites at and its rate cut to a whole number", () => {
    const table: QuickBundle = {
      ...QUICK_BUNDLE,
      speedup: [{ shortSide: { min: 2160 }, fps: { min: 50, max: 50 }, figure: 5 }],
    };
    expect(fastSpeedupLabel(project(3840, 2160, 50, 10), table)).toBe(5);
    expect(fastSpeedupLabel(project(3840, 2160, 50.4, 10), table)).toBe(5);
    expect(fastSpeedupLabel(project(3840, 2160, 49.9, 10), table)).toBeNull();
    expect(fastSpeedupLabel(project(2160, 3840, 50, 10), table)).toBe(5);
    expect(fastSpeedupLabel(project(3838, 2158, 50, 10), table)).toBeNull();
  });

  it("never claims a figure that is not a speed-up, nor one from a row it cannot read", () => {
    for (const figure of [1, 0.5, 0, -2, Number.NaN, Number.POSITIVE_INFINITY, "4" as never])
      expect(
        fastSpeedupLabel(project(3840, 2160, 60, 700), { ...QUICK_BUNDLE, speedup: [{ figure }] }),
      ).toBeNull();
    // a row that cannot be read is passed over, and the next one is looked at
    expect(
      fastSpeedupLabel(project(3840, 2160, 60, 700), {
        ...QUICK_BUNDLE,
        speedup: [{ shortSide: { min: "big" as never }, figure: 9 }, { figure: 3 }],
      }),
    ).toBe(3);
  });

  it("never states a time: its answer is a figure or nothing", () => {
    for (const facts of [project(3840, 2160, 60, 3600), project(1920, 1080, 30, 60)]) {
      const answer = fastSpeedupLabel(facts, WITH_LAB);
      expect(answer === null || (typeof answer === "number" && answer > 1)).toBe(true);
    }
  });

  it("says nothing for a project it cannot read, and does not throw", () => {
    for (const junk of [
      undefined,
      null,
      {},
      project(Number.NaN, 5, 30, 60),
      project(1920, 1080, 0, 60),
      project(1920, 1080, 30, -1),
      project(1920, 1080, 30, Number.NaN),
    ]) {
      expect(() => fastSpeedupLabel(junk as never, WITH_LAB)).not.toThrow();
      expect(fastSpeedupLabel(junk as never, WITH_LAB)).toBeNull();
    }
  });
});

describe('needsSlowConfirm: when pressing Export asks "Are you sure?"', () => {
  const facts = (width: number, height: number, fps: number, durationSeconds: number) => ({
    width,
    height,
    fps,
    durationSeconds,
  });
  const quality = (over: Partial<ChoiceSettings> = {}): ChoiceSettings => ({
    route: "standard",
    resolution: "source",
    fps: null,
    explicit: NONE_SET,
    ...over,
  });
  const fast = (over: Partial<ChoiceSettings> = {}): ChoiceSettings =>
    quality({ route: "quick", ...over });
  const asks = (settings: ChoiceSettings, project: ReturnType<typeof facts>, bundle = WITH_LAB) =>
    needsSlowConfirm(settings, project, bundle);

  const FOUR_K = facts(3840, 2160, 30, 300);
  const SIXTY = facts(1920, 1080, 60, 300);
  const TWELVE_MINUTES = facts(1920, 1080, 30, 12 * 60);

  it("asks about a Quality choice on 4K, on 60 fps and on a 12-minute 1080p project, when a figure exists", () => {
    expect(asks(quality(), FOUR_K)).toBe(true);
    expect(asks(quality(), SIXTY)).toBe(true);
    expect(asks(quality(), TWELVE_MINUTES)).toBe(true);
  });

  it("never asks, in this build, because the lab has no figure: the shipped table is empty", () => {
    for (const settings of [
      quality(),
      fast(),
      fast({ resolution: "source", explicit: { size: true, fps: true } }),
    ])
      for (const project of [FOUR_K, SIXTY, TWELVE_MINUTES, facts(7680, 4320, 120, 7200)])
        expect(needsSlowConfirm(settings, project)).toBe(false);
  });

  it("is a conjunction of the three conditions: each, on its own, flips the answer", () => {
    // all three hold: a Quality choice on a 4K project, with a figure
    expect(asks(quality(), FOUR_K)).toBe(true);
    // (1) alone fails: the project is not big by its own facts (1080p, 30 fps, 5 minutes), though Fast would make it lighter and a figure exists
    const small = facts(1920, 1080, 30, 300);
    expect(asks(quality(), small)).toBe(false);
    for (const bigger of [
      facts(3840, 2160, 30, 300),
      facts(1920, 1080, 50, 300),
      facts(1920, 1080, 30, 601),
    ])
      expect(asks(quality(), bigger)).toBe(true);
    // (2) alone fails: Fast with its own settings keeps nothing heavier than Fast's, on the same 4K project with a figure
    expect(asks(fast(), FOUR_K)).toBe(false);
    expect(
      asks(
        fast({ resolution: "source", explicit: { size: true, fps: false, quality: false } }),
        FOUR_K,
      ),
    ).toBe(true);
    // (3) alone fails: no figure for the project
    expect(needsSlowConfirm(quality(), FOUR_K, QUICK_BUNDLE)).toBe(false);
    const forBigOnly: QuickBundle = {
      ...QUICK_BUNDLE,
      speedup: [{ shortSide: { min: 2160 }, figure: 4 }],
    };
    expect(needsSlowConfirm(quality(), FOUR_K, forBigOnly)).toBe(true);
    expect(needsSlowConfirm(quality(), SIXTY, forBigOnly)).toBe(false);
  });

  it("puts the cut-offs where the owner put them, each inclusive or not as said", () => {
    // short side 2160 or more
    expect(asks(quality(), facts(3840, 2160, 30, 60))).toBe(true);
    expect(asks(quality(), facts(3840, 2158, 30, 60))).toBe(false); // an even 2158 is under 2160
    expect(asks(quality(), facts(3839, 2159, 30, 60))).toBe(true); // an odd canvas composites at 3840 by 2160: the size the render works at
    expect(asks(quality(), facts(2560, 1440, 30, 60))).toBe(false);
    // fps 50 or more
    expect(asks(quality(), facts(1920, 1080, 50, 60))).toBe(true);
    expect(asks(quality(), facts(1920, 1080, 49, 60))).toBe(false);
    // longer than 600 s: 600 is not longer
    expect(asks(quality(), facts(1920, 1080, 30, 600))).toBe(false);
    expect(asks(quality(), facts(1920, 1080, 30, 601))).toBe(true);
    // and the cut-offs are the data's
    const strict: QuickBundle = {
      ...WITH_LAB,
      confirm: { shortSide: 1440, fps: 25, durationSeconds: 60 },
    };
    expect(asks(quality(), facts(2560, 1440, 30, 10), strict)).toBe(true);
    expect(asks(quality(), facts(1920, 1080, 24, 10), strict)).toBe(false);
    expect(asks(quality(), facts(1920, 1080, 24, 61), strict)).toBe(true);
  });

  it("never asks about Fast with its own settings, on any project, with any figure", () => {
    for (const project of [
      FOUR_K,
      SIXTY,
      TWELVE_MINUTES,
      facts(7680, 4320, 120, 7200),
      facts(1080, 1920, 60, 3600),
      facts(1366, 768, 50, 900),
      facts(854, 480, 60, 900),
    ]) {
      expect(asks(fast(), project)).toBe(false);
      // a quality override alone does not count
      expect(asks(fast({ explicit: { size: false, fps: false, quality: true } }), project)).toBe(
        false,
      );
    }
  });

  it("asks about a Fast choice only where an override puts the size above Fast's default or the rate above 30", () => {
    const project = facts(3840, 2160, 60, 300);
    const set = (size: boolean, fps: boolean) => ({ size, fps, quality: false });
    // size: the default is 1080p; the same size or smaller does not count, a larger one does
    expect(asks(fast({ resolution: "1080p", explicit: set(true, false) }), project)).toBe(false);
    expect(asks(fast({ resolution: "720p", explicit: set(true, false) }), project)).toBe(false);
    expect(asks(fast({ resolution: "1440p", explicit: set(true, false) }), project)).toBe(true);
    expect(asks(fast({ resolution: "2160p", explicit: set(true, false) }), project)).toBe(true);
    // "the same as the project", picked on purpose, is such an override
    expect(asks(fast({ resolution: "source", explicit: set(true, false) }), project)).toBe(true);
    // rate: Fast's own is 30; 30 or lower does not count, a higher one does
    expect(asks(fast({ fps: 30, explicit: set(false, true) }), project)).toBe(false);
    expect(asks(fast({ fps: 24, explicit: set(false, true) }), project)).toBe(false);
    expect(asks(fast({ fps: 60, explicit: set(false, true) }), project)).toBe(true);
    expect(asks(fast({ fps: 50, explicit: set(false, true) }), project)).toBe(true);
  });

  it("asks about a Quality choice unless the project is already at or below Fast's default size and rate", () => {
    // 480p at 30 fps: nothing below 480p, nothing above 30 fps: Fast would change nothing, however long the project
    for (const seconds of [1, 300, 601, 7200]) {
      expect(asks(quality(), facts(854, 480, 30, seconds))).toBe(false);
      expect(asks(quality(), facts(640, 360, 24, seconds))).toBe(false);
    }
    // a 480p project at 60 fps is big by its rate and Fast would halve it: it asks (the one way a 480p project can)
    expect(asks(quality(), facts(854, 480, 60, 300))).toBe(true);
    // 720p at 30 fps for 12 minutes: Fast would make it 480p
    expect(asks(quality(), facts(1280, 720, 30, 720))).toBe(true);
  });

  it("never asks about a 480p project at 30 fps or less, whatever it is told, and never about a 1080p 30 fps project under ten minutes", () => {
    for (const settings of [
      quality(),
      fast(),
      quality({ resolution: "source", fps: 30 }),
      fast({ resolution: "480p", explicit: { size: true, fps: true, quality: true } }),
    ])
      for (const seconds of [1, 599, 600, 601, 7200])
        for (const fps of [24, 25, 30])
          expect(asks(settings, facts(854, 480, fps, seconds))).toBe(false);
    for (const settings of [
      quality(),
      fast(),
      quality({ resolution: "720p" }),
      fast({ resolution: "source", explicit: { size: true, fps: false } }),
    ])
      for (const seconds of [1, 300, 599, 600])
        expect(asks(settings, facts(1920, 1080, 30, seconds))).toBe(false);
  });

  it("reads a Quality choice by what the settings would deliver: a smaller size or a lower rate chosen in the dialog is not heavier than Fast's", () => {
    // 4K, Quality, but the person chose 720p: lighter than Fast's own 1080p, so Fast would not help
    expect(asks(quality({ resolution: "720p" }), FOUR_K)).toBe(false);
    expect(asks(quality({ resolution: "1080p" }), FOUR_K)).toBe(false);
    expect(asks(quality({ resolution: "1440p" }), FOUR_K)).toBe(true);
    // 60 fps, Quality, but the person chose 30 only: the size is still heavier than Fast's own 720p
    expect(asks(quality({ fps: 30 }), facts(3840, 2160, 60, 60))).toBe(true); // still 4K
    expect(asks(quality({ fps: 30 }), SIXTY)).toBe(true);
    // ... and with a size at Fast's own as well, the choice is no heavier
    expect(asks(quality({ fps: 30, resolution: "720p" }), SIXTY)).toBe(false);
    expect(asks(quality({ fps: 24, resolution: "720p" }), facts(1920, 1080, 60, 60))).toBe(false);
  });

  it("says nothing it cannot back: unreadable settings or facts give no question, and nothing throws", () => {
    for (const bad of [
      undefined,
      null,
      {},
      { route: "standard" },
      { route: "quick", explicit: null },
    ])
      expect(needsSlowConfirm(bad as never, FOUR_K, WITH_LAB)).toBe(false);
    for (const bad of [
      undefined,
      null,
      {},
      facts(Number.NaN, 2160, 30, 300),
      facts(3840, 2160, 0, 300),
      facts(3840, 2160, 30, Number.NaN),
    ])
      expect(needsSlowConfirm(quality(), bad as never, WITH_LAB)).toBe(false);
    // a resolution or a rate that is not one is the project's own
    expect(asks(quality({ resolution: "8k" as never, fps: Number.NaN }), FOUR_K)).toBe(true);
  });
});

describe("isWeakPc", () => {
  it("is weak and unfinished, and nothing else (kept for the estimate design's wording; no rule of Fast reads it)", () => {
    expect(PC_CLASSES.filter(isWeakPc)).toEqual(["weak", "unfinished"]);
  });
});
