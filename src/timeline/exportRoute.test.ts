import { describe, expect, it } from "vitest";

import { outputFps, outputSize } from "./exportOptions";
import {
  QUICK_MAX_FPS,
  ROUTE_QUESTION_SECONDS,
  chooseRoute,
  isWeakPc,
  quickRate,
  quickSettings,
  routeQuestionDue,
  type QuickSettingsInput,
  type RouteDecision,
  type RouteInput,
} from "./exportRoute";
import { PC_CLASSES, type PcClass } from "./exportTypes3c";

const base: RouteInput = {
  pcClass: "ok",
  via: "dialog",
  full: { seconds: 300, basis: "pc_check" },
  quick: { seconds: 100, basis: "pc_check" },
  explicit: { size: false, fps: false },
  quickFlagOn: true,
  picked: null,
};
const route = (over: Partial<RouteInput> = {}): RouteDecision => chooseRoute({ ...base, ...over });
const times = (full: number | null, quick: number | null): Partial<RouteInput> => ({
  full: { seconds: full, basis: "pc_check" },
  quick: { seconds: quick, basis: "pc_check" },
});

describe("chooseRoute: who gets Quick, and which way starts selected", () => {
  it("preselects Quick only on a weak PC or one whose check could not finish; everywhere else Full quality stays selected", () => {
    const want: Record<PcClass, RouteDecision["selected"]> = {
      weak: "quick",
      unfinished: "quick",
      ok: "standard",
      fast: "standard",
      unknown: "standard",
    };
    for (const pcClass of PC_CLASSES) {
      const decision = route({ pcClass });
      expect(decision.offered).toBe(true);
      expect(decision.selected).toBe(want[pcClass]);
      expect(decision.reason).toBe(want[pcClass] === "quick" ? "selected" : "offered");
    }
  });

  it("is a table of savings and lengths: not offered under a quarter or under a minute, offered at exactly a quarter", () => {
    // [Full quality seconds, Quick seconds, offered, reason]
    const rows: [number, number, boolean, RouteDecision["reason"]][] = [
      [300, 270, false, "small_gain"], // saves 10 %
      [300, 226, false, "small_gain"], // just under a quarter
      [300, 225, true, "offered"], // exactly a quarter
      [300, 120, true, "offered"], // 60 %
      [400, 300, true, "offered"],
      [400, 301, false, "small_gain"],
      [300, 300, false, "small_gain"], // no saving
      [300, 400, false, "small_gain"], // Quick slower than Full quality
      [40, 10, false, "short"],
      [60, 10, false, "short"], // a minute is not over a minute
      [61, 10, true, "offered"],
    ];
    for (const [full, quick, offered, reason] of rows) {
      const decision = route(times(full, quick));
      expect({ full, quick, offered: decision.offered, reason: decision.reason }).toEqual({
        full,
        quick,
        offered,
        reason,
      });
      if (!offered) expect(decision.selected).toBe("standard");
    }
  });

  it("never selects Quick for a weak PC under a minute, nor when Quick saves under a quarter, whatever was picked", () => {
    for (const pcClass of ["weak", "unfinished"] as const)
      for (const picked of [null, "quick", "standard"] as const) {
        for (const [full, quick] of [
          [40, 10],
          [60, 1],
          [300, 280],
        ] as const)
          expect(route({ pcClass, picked, ...times(full, quick) })).toMatchObject({
            offered: false,
            selected: "standard",
          });
      }
  });

  it("is not offered, and says why, when the remote switch is off", () => {
    for (const pcClass of PC_CLASSES)
      expect(route({ pcClass, quickFlagOn: false })).toEqual({
        offered: false,
        selected: "standard",
        reason: "off",
        savedFraction: null,
      });
  });

  it("reads a missing or unreadable estimate as nothing to offer: Full quality's, and Quick's", () => {
    for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, -5])
      expect(route(times(bad, 10))).toMatchObject({ offered: false, reason: "short" });
    // Quick's own estimate failed: nothing can be claimed about it, so there is no Quick and no "would not help" line.
    for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, -1])
      expect(route(times(300, bad))).toMatchObject({
        offered: false,
        selected: "standard",
        reason: "short",
      });
  });

  it("keeps Full quality where the person picked it, and Quick where they picked Quick", () => {
    expect(route({ pcClass: "weak", picked: "standard" })).toMatchObject({
      offered: true,
      selected: "standard",
      reason: "offered",
    });
    expect(route({ pcClass: "ok", picked: "quick" })).toMatchObject({
      offered: true,
      selected: "quick",
      reason: "offered",
    });
    expect(route({ pcClass: "weak", picked: "quick" })).toMatchObject({
      offered: true,
      selected: "quick",
      reason: "selected",
    });
    // A pick cannot bring Quick back where it is not offered.
    expect(route({ picked: "quick", ...times(40, 10) })).toMatchObject({
      offered: false,
      selected: "standard",
    });
  });

  it("with the size and the rate both set, offers Quick only if its encoder alone saves a quarter", () => {
    const set = { explicit: { size: true, fps: true } };
    for (const [fraction, offered] of [
      [0.6, true],
      [0.25, true],
      [0.2499, false],
      [0, false],
    ] as const)
      expect(route({ ...set, encoderOnlySavingFraction: fraction })).toMatchObject({
        offered,
        reason: offered ? "offered" : "explicit",
      });
    for (const unknown of [null, undefined, Number.NaN])
      expect(route({ ...set, encoderOnlySavingFraction: unknown })).toMatchObject({
        offered: false,
        selected: "standard",
        reason: "explicit",
      });
    // What decides is the encoder alone, not the saving a typical Quick would have had.
    expect(route({ ...set, ...times(300, 60), encoderOnlySavingFraction: 0.1 })).toMatchObject({
      offered: false,
      reason: "explicit",
    });
    // ... and a short export is short whatever is set.
    expect(route({ ...set, ...times(40, 10), encoderOnlySavingFraction: 0.9 })).toMatchObject({
      reason: "short",
    });
  });

  it("with only the size set, or only the rate, judges Quick's own estimate as usual", () => {
    for (const explicit of [
      { size: true, fps: false },
      { size: false, fps: true },
    ]) {
      expect(
        route({ explicit, ...times(300, 100), encoderOnlySavingFraction: 0.01 }),
      ).toMatchObject({
        offered: true,
      });
      expect(route({ explicit, ...times(300, 290) })).toMatchObject({ reason: "small_gain" });
    }
  });

  it("says how much Quick saves, as a share of Full quality's time, when it can", () => {
    expect(route().savedFraction).toBeCloseTo(2 / 3, 10);
    expect(route(times(300, 290)).savedFraction).toBeCloseTo(10 / 300, 10);
    expect(route(times(300, 400)).savedFraction).toBe(0);
    expect(route(times(40, 10)).savedFraction).toBeNull();
    expect(route({ quickFlagOn: false }).savedFraction).toBeNull();
    expect(
      route({ explicit: { size: true, fps: true }, encoderOnlySavingFraction: 0.4 }).savedFraction,
    ).toBe(0.4);
  });

  it("answers the same wherever the person is asked", () => {
    for (const pcClass of PC_CLASSES)
      for (const picked of [null, "quick", "standard"] as const)
        for (const q of [10, 225, 226, 400])
          expect(route({ pcClass, picked, via: "chat", ...times(300, q) })).toEqual(
            route({ pcClass, picked, via: "dialog", ...times(300, q) }),
          );
  });

  it("does not throw, and offers nothing, for input that is not an input", () => {
    for (const junk of [undefined, null, 0, "x", [], {}, { quickFlagOn: true }]) {
      expect(() => chooseRoute(junk as unknown as RouteInput)).not.toThrow();
      expect(chooseRoute(junk as unknown as RouteInput)).toMatchObject({
        offered: false,
        selected: "standard",
      });
    }
  });
});

describe("routeQuestionDue: when the chat card asks", () => {
  const offered = (over: Partial<RouteInput> = {}) => route(over);
  it("asks on a weak PC whenever Quick is on offer", () => {
    for (const pcClass of ["weak", "unfinished"] as const)
      for (const fullSeconds of [90, 600, 7200, null])
        expect(routeQuestionDue({ pcClass, decision: offered({ pcClass }), fullSeconds })).toBe(
          true,
        );
  });

  it("asks elsewhere only for an export expected over ten minutes", () => {
    for (const pcClass of ["ok", "fast", "unknown"] as const) {
      const decision = offered({ pcClass });
      expect(routeQuestionDue({ pcClass, decision, fullSeconds: 120 })).toBe(false);
      expect(routeQuestionDue({ pcClass, decision, fullSeconds: ROUTE_QUESTION_SECONDS })).toBe(
        false,
      );
      expect(routeQuestionDue({ pcClass, decision, fullSeconds: ROUTE_QUESTION_SECONDS + 1 })).toBe(
        true,
      );
      expect(routeQuestionDue({ pcClass, decision, fullSeconds: null })).toBe(false);
    }
  });

  it("never asks when Quick is not on offer, however long the export or weak the PC", () => {
    for (const pcClass of PC_CLASSES)
      for (const over of [
        { quickFlagOn: false },
        times(40, 10),
        times(7200, 7000),
        { explicit: { size: true, fps: true } },
      ])
        for (const fullSeconds of [10, 7200, null])
          expect(
            routeQuestionDue({
              pcClass,
              decision: route({ pcClass, ...over }),
              fullSeconds,
            }),
          ).toBe(false);
  });

  it("does not throw on input that is not an input", () => {
    for (const junk of [undefined, null, {}, { decision: null }])
      expect(routeQuestionDue(junk as never)).toBe(false);
  });
});

describe("quickRate: the rate Quick delivers", () => {
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
      // Not a whole half, so 30: a rate that does not halve cleanly is not cut to a half.
      [90, 30],
      [59.94, 30],
      [31, 30],
      [75, 30],
      // The half is kept while it stays whole and above 30, so these end below 30 (the decided function; see the report).
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
});

const canvas = (width: number, height: number, fps = 30) => ({ width, height, fps });
const settings = (over: Partial<QuickSettingsInput> = {}): ReturnType<typeof quickSettings> =>
  quickSettings({
    canvas: canvas(1920, 1080),
    requested: {},
    pcClass: "ok",
    explicit: { size: false, fps: false },
    ...over,
  });

describe("quickSettings: a smaller picture and at most 30 frames a second, where they were not set", () => {
  it("caps the picture at 1080p, and at 720p on a weak PC or one whose check did not finish", () => {
    const rows: [number, number, PcClass, string, boolean][] = [
      [3840, 2160, "ok", "1080p", true],
      [3840, 2160, "fast", "1080p", true],
      [3840, 2160, "unknown", "1080p", true],
      [3840, 2160, "weak", "720p", true],
      [3840, 2160, "unfinished", "720p", true],
      [2560, 1440, "ok", "1080p", true],
      [1920, 1080, "ok", "source", false],
      [1920, 1080, "weak", "720p", true],
      [1280, 720, "weak", "source", false],
      [1280, 720, "ok", "source", false],
      [854, 480, "weak", "source", false],
      [1080, 1920, "ok", "source", false], // a vertical project is capped by its short side too
      [1080, 1920, "weak", "720p", true],
      [2160, 3840, "ok", "1080p", true],
      [1366, 768, "weak", "720p", true],
    ];
    for (const [width, height, pcClass, resolution, changedSize] of rows)
      expect({
        canvas: [width, height, pcClass],
        ...settings({ canvas: canvas(width, height), pcClass }),
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

  it("never enlarges: a smaller size or a lower rate that was asked for is kept", () => {
    expect(settings({ requested: { resolution: "480p" } })).toMatchObject({
      resolution: "480p",
      changedSize: false,
    });
    expect(
      settings({ canvas: canvas(3840, 2160), requested: { resolution: "720p" }, pcClass: "ok" }),
    ).toMatchObject({ resolution: "720p", changedSize: false });
    expect(
      settings({ canvas: canvas(3840, 2160), requested: { resolution: "1080p" }, pcClass: "ok" }),
    ).toMatchObject({ resolution: "1080p", changedSize: false });
    expect(settings({ canvas: canvas(1920, 1080, 60), requested: { fps: 24 } })).toMatchObject({
      fps: 24,
      changedFps: false,
    });
    expect(settings({ canvas: canvas(1920, 1080, 60), requested: { fps: 60 } })).toMatchObject({
      fps: 30,
      changedFps: true,
    });
  });

  it("leaves a size the person or the assistant set alone, and caps only the rate", () => {
    for (const pcClass of PC_CLASSES)
      expect(
        settings({
          canvas: canvas(3840, 2160, 60),
          requested: { resolution: "1440p" },
          pcClass,
          explicit: { size: true, fps: false },
        }),
      ).toEqual({ resolution: "1440p", fps: 30, changedSize: false, changedFps: true });
  });

  it("leaves a rate that was set alone, and caps only the picture", () => {
    for (const pcClass of PC_CLASSES)
      expect(
        settings({
          canvas: canvas(3840, 2160, 60),
          requested: { fps: 24 },
          pcClass,
          explicit: { size: false, fps: true },
        }),
      ).toMatchObject({ fps: 24, changedFps: false, changedSize: true });
    // A rate above the cap that was set stays: Quick does not cap what was asked for.
    expect(
      settings({
        canvas: canvas(1920, 1080, 60),
        requested: { fps: 60 },
        explicit: { size: false, fps: true },
      }),
    ).toMatchObject({ fps: 60, changedFps: false });
  });

  it("with both set, changes nothing: Quick is only the encoder", () => {
    expect(
      settings({
        canvas: canvas(3840, 2160, 60),
        requested: { resolution: "2160p", fps: 60, quality: "high" },
        pcClass: "weak",
        explicit: { size: true, fps: true },
      }),
    ).toEqual({ resolution: "2160p", fps: 60, changedSize: false, changedFps: false });
  });

  it("returns exactly the four settings it is documented to, and no quality: the tier stays the request's own", () => {
    expect(Object.keys(settings({ requested: { quality: "high" } })).sort()).toEqual([
      "changedFps",
      "changedSize",
      "fps",
      "resolution",
    ]);
  });

  it("delivers what it says: the resolution it names, given to the exporter, makes the size and the rate it reports", () => {
    // The exporter's own size and rate functions, not a restatement of the cap.
    const result = settings({ canvas: canvas(3840, 2160, 60), pcClass: "weak" });
    const sized = outputSize(3840, 2160, result.resolution);
    expect(sized).toEqual({ w: 1280, h: 720 });
    expect(outputFps(60, result.fps)).toBe(30);
  });

  it("does not throw, and changes nothing, for input that is not a picture", () => {
    for (const junk of [undefined, null, 5, {}, { canvas: null }, { canvas: {} }]) {
      expect(() => quickSettings(junk as never)).not.toThrow();
      expect(quickSettings(junk as never)).toMatchObject({
        resolution: "source",
        changedSize: false,
        changedFps: false,
      });
    }
    for (const bad of [Number.NaN, 0, -3, Number.POSITIVE_INFINITY]) {
      expect(settings({ canvas: canvas(bad, bad, bad) })).toMatchObject({
        changedSize: false,
        changedFps: false,
      });
    }
    // A request that is not a resolution or a rate is the project's own.
    expect(settings({ requested: { resolution: "8k" as never, fps: Number.NaN } })).toMatchObject({
      resolution: "source",
      fps: undefined,
    });
  });

  it("reads a set it cannot read as set, so that nothing is ever taken from the person", () => {
    for (const explicit of [undefined, null, {}, { size: "no", fps: 0 }, { size: undefined }])
      expect(
        settings({
          canvas: canvas(3840, 2160, 60),
          pcClass: "weak",
          explicit: explicit as never,
        }),
      ).toMatchObject({ resolution: "source", changedSize: false, changedFps: false });
  });
});

describe("isWeakPc", () => {
  it("is weak and unfinished, and nothing else", () => {
    expect(PC_CLASSES.filter(isWeakPc)).toEqual(["weak", "unfinished"]);
  });
});
