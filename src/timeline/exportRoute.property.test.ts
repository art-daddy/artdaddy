// Properties of the Fast choice's rules over generated inputs: what the owner decided (Fast never overrides a size, a rate or a quality that was set, never
// enlarges, is on offer whenever its switch is on and selected only by a pick, and Quality is always there) must hold for every combination, for any figures in the
// bundle, and not only for the examples somebody remembered. The picture a setting makes is read from the exporter's own functions and its own plan, never restated.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { outputFps, outputSize, type ExportResolution } from "./exportOptions";
import {
  QUICK_BUNDLE,
  SIZE_PRESETS,
  chooseRoute,
  explicitOfCall,
  fastSpeedupLabel,
  needsSlowConfirm,
  quickDefaultSize,
  quickRate,
  quickSettings,
  quickSizeChoices,
  routeQuestionDue,
  type ChoiceSettings,
  type FastSpeedupRow,
  type QuickBundle,
  type QuickSettingsInput,
  type RouteInput,
  type SizePreset,
} from "./exportRoute";
import { QUICK_OFFERS, ROUTE_KINDS } from "./exportTypes3c";
import type { Timeline } from "./model";
import { buildRenderCommand, canvasPx } from "./render";

const RESOLUTIONS: ExportResolution[] = ["source", ...SIZE_PRESETS];

/** The short side of a size preset, asked of the exporter's own `outputSize`. */
const SIDE: Record<SizePreset, number> = Object.fromEntries(
  SIZE_PRESETS.map((preset) => [preset, outputSize(100_000, 100_000, preset)?.w ?? 0]),
) as Record<SizePreset, number>;

/** The size the render composites a canvas at, by the render's own function. */
const compositeOf = (c: { width: number; height: number; fps: number }) =>
  canvasPx({ canvas: c } as unknown as Timeline);
const shortOf = (size: { w: number; h: number }) => Math.min(size.w, size.h);

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

/** The lines of the ladder: each rung, and one either side of it, odd and even. */
const EDGES = [
  479, 480, 481, 482, 719, 720, 721, 722, 1079, 1080, 1081, 1082, 1439, 1440, 1441, 2159, 2160,
  2161, 2162, 4319, 4320,
];
/** Sides with weight on those lines. */
const side = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 2, max: 9000 }) },
  { weight: 2, arbitrary: fc.constantFrom(...EDGES) },
);
const rate = fc.oneof(
  fc.constantFrom(23.976, 24, 25, 29.97, 30, 31, 48, 50, 59.94, 60, 72, 90, 100, 120),
  fc.integer({ min: 1, max: 240 }),
  fc.double({ min: 1, max: 240, noNaN: true }),
);
const canvas = fc.record({ width: side, height: side, fps: rate });
const requested = fc.record(
  {
    resolution: fc.constantFrom(...RESOLUTIONS),
    fps: fc.oneof(fc.integer({ min: 1, max: 144 }), fc.double({ min: 1, max: 144, noNaN: true })),
    quality: fc.constantFrom("high" as const, "medium" as const, "low" as const),
  },
  { requiredKeys: [] },
);
const explicit = fc.record({ size: fc.boolean(), fps: fc.boolean(), quality: fc.boolean() });
const bundle: fc.Arbitrary<QuickBundle> = fc.record({
  ladder: fc.shuffledSubarray([...SIZE_PRESETS], { minLength: 0 }),
  maxFps: fc.integer({ min: 5, max: 120 }),
  quality: fc.constantFrom("high" as const, "medium" as const, "low" as const),
  confirm: fc.record({
    shortSide: fc.integer({ min: 240, max: 4320 }),
    fps: fc.integer({ min: 12, max: 120 }),
    durationSeconds: fc.integer({ min: 1, max: 7200 }),
  }),
  speedup: fc.constant([] as FastSpeedupRow[]),
});
const anyBundle = fc.oneof(fc.constant(QUICK_BUNDLE), bundle);
const settingsInput: fc.Arbitrary<QuickSettingsInput> = fc.record({
  canvas,
  requested,
  explicit,
  bundle: anyBundle,
});

describe("quickDefaultSize: over every canvas and every ladder", () => {
  it("is a rung of the ladder strictly below the short side the render works at, and the largest such rung", () => {
    fc.assert(
      fc.property(canvas, anyBundle, (c, data) => {
        const result = quickDefaultSize(c, data);
        const short = shortOf(compositeOf(c));
        const below = data.ladder.filter((rung) => SIDE[rung] < short);
        if (below.length === 0) {
          expect(result).toBeNull();
          return;
        }
        expect(result).not.toBeNull();
        expect(data.ladder).toContain(result);
        expect(SIDE[result as SizePreset]).toBeLessThan(short);
        // no rung is both below the canvas and above the answer
        for (const rung of below)
          expect(SIDE[rung]).toBeLessThanOrEqual(SIDE[result as SizePreset]);
      }),
      { numRuns: 3000 },
    );
  });

  it("is a size that really makes the picture smaller, by the exporter's own never-upscale rule", () => {
    fc.assert(
      fc.property(canvas, (c) => {
        const result = quickDefaultSize(c);
        if (result === null) return;
        const own = compositeOf(c);
        const sized = outputSize(own.w, own.h, result);
        expect(sized).not.toBeNull();
        expect(shortOf({ w: (sized as { w: number }).w, h: (sized as { h: number }).h })).toBe(
          SIDE[result],
        );
        expect(
          shortOf({ w: (sized as { w: number }).w, h: (sized as { h: number }).h }),
        ).toBeLessThan(shortOf(own));
      }),
      { numRuns: 2000 },
    );
  });

  it("gives a larger canvas a default no smaller than a smaller one's, and none to a canvas with nothing below it", () => {
    fc.assert(
      fc.property(canvas, canvas, (a, b) => {
        const sa = shortOf(compositeOf(a));
        const sb = shortOf(compositeOf(b));
        const [small, large] = sa <= sb ? [a, b] : [b, a];
        const ds = quickDefaultSize(small);
        const dl = quickDefaultSize(large);
        if (ds !== null) {
          expect(dl).not.toBeNull();
          expect(SIDE[dl as SizePreset]).toBeGreaterThanOrEqual(SIDE[ds]);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe("quickSizeChoices: the same as the project and every smaller size, never one that is larger", () => {
  it("offers exactly the sizes that make the picture smaller, largest first, after the project's own", () => {
    fc.assert(
      fc.property(canvas, (c) => {
        const choices = quickSizeChoices(c);
        const own = compositeOf(c);
        expect(choices[0]).toBe("source");
        const sizes = choices.slice(1) as SizePreset[];
        for (const preset of SIZE_PRESETS)
          expect(sizes.includes(preset)).toBe(outputSize(own.w, own.h, preset) !== null);
        for (const preset of sizes) expect(SIDE[preset]).toBeLessThan(shortOf(own));
        expect(sizes.map((p) => SIDE[p])).toEqual(
          [...sizes.map((p) => SIDE[p])].sort((x, y) => y - x),
        );
      }),
      { numRuns: 2000 },
    );
  });

  it("offers the default size wherever there is one", () => {
    fc.assert(
      fc.property(canvas, (c) => {
        const def = quickDefaultSize(c);
        if (def !== null) expect(quickSizeChoices(c)).toContain(def);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("quickRate", () => {
  it("never raises a rate, never exceeds the cap unless the source is under it, and is settled after one application", () => {
    fc.assert(
      fc.property(rate, fc.integer({ min: 5, max: 120 }), (r, cap) => {
        const once = quickRate(r, cap) as number;
        expect(once).toBeLessThanOrEqual(r);
        expect(once).toBeLessThanOrEqual(cap);
        if (r <= cap) expect(once).toBe(r);
        expect(quickRate(once, cap)).toBe(once);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("quickSettings: over every canvas, request, set and unset, and every bundle", () => {
  it("never enlarges the picture and never raises the rate, by what the exporter itself would deliver", () => {
    fc.assert(
      fc.property(settingsInput, (input) => {
        const result = quickSettings(input);
        const own = compositeOf(input.canvas);
        const asked = outputSize(own.w, own.h, input.requested.resolution ?? "source") ?? own;
        const delivered = result.delivered as NonNullable<typeof result.delivered>;
        expect(Math.min(delivered.width, delivered.height)).toBeLessThanOrEqual(shortOf(asked));
        expect(delivered.width).toBeLessThanOrEqual(own.w);
        expect(delivered.height).toBeLessThanOrEqual(own.h);
        expect(delivered.fps).toBeLessThanOrEqual(
          outputFps(Math.trunc(input.canvas.fps), input.requested.fps),
        );
      }),
      { numRuns: 3000 },
    );
  });

  it("never overrides a size, a rate or a quality that was set: each is returned as it was asked for", () => {
    fc.assert(
      fc.property(settingsInput, (input) => {
        const result = quickSettings(input);
        if (input.explicit.size) {
          expect(result.resolution).toBe(input.requested.resolution ?? "source");
          expect(result.changedSize).toBe(false);
        }
        if (input.explicit.fps) {
          expect(result.fps).toBe(input.requested.fps);
          expect(result.changedFps).toBe(false);
        }
        if (input.explicit.quality) {
          expect(result.quality).toBe(input.requested.quality);
          expect(result.changedQuality).toBe(false);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it("composes what was not set: the default size, the rate at the cap at most, and the bundle's quality", () => {
    fc.assert(
      fc.property(settingsInput, (input) => {
        const result = quickSettings(input);
        const data = input.bundle ?? QUICK_BUNDLE;
        const own = compositeOf(input.canvas);
        const delivered = result.delivered as NonNullable<typeof result.delivered>;
        if (!input.explicit.size) {
          const def = quickDefaultSize(input.canvas, data);
          if (def !== null) {
            const target = outputSize(own.w, own.h, def) ?? own;
            expect(Math.min(delivered.width, delivered.height)).toBeLessThanOrEqual(
              shortOf(target),
            );
          }
        }
        if (!input.explicit.fps) expect(delivered.fps).toBeLessThanOrEqual(data.maxFps);
        if (!input.explicit.quality) expect(result.quality).toBe(data.quality);
      }),
      { numRuns: 3000 },
    );
  });

  it("reports a change if and only if it made one", () => {
    fc.assert(
      fc.property(settingsInput, (input) => {
        const result = quickSettings(input);
        expect(result.changedSize).toBe(
          result.resolution !== (input.requested.resolution ?? "source"),
        );
        expect(result.changedFps).toBe(result.fps !== input.requested.fps);
        expect(result.changedQuality).toBe(result.quality !== input.requested.quality);
      }),
      { numRuns: 2000 },
    );
  });

  it("is settled after one application: giving it its own answer changes nothing more", () => {
    fc.assert(
      fc.property(settingsInput, (input) => {
        const first = quickSettings(input);
        const second = quickSettings({
          ...input,
          requested: { resolution: first.resolution, fps: first.fps, quality: first.quality },
        });
        expect(second).toEqual({
          ...first,
          changedSize: false,
          changedFps: false,
          changedQuality: false,
        });
      }),
      { numRuns: 2000 },
    );
  });

  it("delivers a picture of even sides that the render itself reports as its output, odd canvases and fractional rates included", () => {
    fc.assert(
      fc.property(settingsInput, (input) => {
        const result = quickSettings(input);
        const delivered = result.delivered as NonNullable<typeof result.delivered>;
        expect(delivered.width % 2).toBe(0);
        expect(delivered.height % 2).toBe(0);
      }),
      { numRuns: 2000 },
    );
    fc.assert(
      fc.property(settingsInput, (input) => {
        const result = quickSettings(input);
        const plan = buildRenderCommand(projectOf(input.canvas), "/out.mp4", {
          resolution: result.resolution,
          fps: result.fps,
          quality: result.quality,
        });
        expect(result.delivered).toEqual(plan.output);
      }),
      { numRuns: 250 },
    );
  });

  it("is a function of its input alone, and leaves the input as it found it", () => {
    fc.assert(
      fc.property(settingsInput, (input) => {
        const frozen = structuredClone(input);
        const once = quickSettings(input);
        expect(quickSettings(input)).toEqual(once);
        expect(input).toEqual(frozen);
      }),
      { numRuns: 500 },
    );
  });

  it("never throws, and never gives a size that is not one, a rate that is not a number or a quality that is not one, whatever it is given", () => {
    const sane = (result: ReturnType<typeof quickSettings>) => {
      expect(RESOLUTIONS).toContain(result.resolution);
      if (result.fps !== undefined) expect(Number.isFinite(result.fps)).toBe(true);
      if (result.quality !== undefined) expect(["high", "medium", "low"]).toContain(result.quality);
    };
    fc.assert(
      fc.property(fc.anything(), (junk) => sane(quickSettings(junk as QuickSettingsInput))),
      { numRuns: 1000 },
    );
    fc.assert(
      fc.property(
        fc.record({
          canvas: fc.record({ width: fc.double(), height: fc.double(), fps: fc.double() }),
          requested: fc.record({ fps: fc.double() }, { requiredKeys: [] }),
          explicit,
          bundle: fc.anything(),
        }),
        (input) => sane(quickSettings(input as unknown as QuickSettingsInput)),
      ),
      { numRuns: 1500 },
    );
  });
});

describe("explicitOfCall", () => {
  it("never reads a default as a setting, and always reads a named size, rate or quality as one", () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            resolution: fc.oneof(
              fc.constantFrom("source", "SOURCE", " source ", ""),
              fc.string(),
              fc.integer(),
            ),
            fps: fc.oneof(fc.double(), fc.integer(), fc.constant(null), fc.string()),
            quality: fc.oneof(
              fc.constantFrom("high", "medium", "low", ""),
              fc.string(),
              fc.integer(),
            ),
          },
          { requiredKeys: [] },
        ),
        (args) => {
          const set = explicitOfCall(args);
          const named = (value: unknown) => typeof value === "string" && value.trim() !== "";
          expect(set.size).toBe(
            named(args.resolution) && String(args.resolution).trim().toLowerCase() !== "source",
          );
          expect(set.fps).toBe(typeof args.fps === "number" && Number.isFinite(args.fps));
          expect(set.quality).toBe(named(args.quality));
        },
      ),
      { numRuns: 1500 },
    );
  });
});

describe("chooseRoute: the owner's rules, over every combination", () => {
  const input = fc.record({
    quickRouteOn: fc.boolean(),
    picked: fc.constantFrom(null, "quick" as const, "standard" as const),
  });

  it("is always on offer when the switch is on, and never when it is off", () => {
    fc.assert(
      fc.property(input, (i) => {
        const decision = chooseRoute(i);
        expect(decision.offered).toBe(i.quickRouteOn);
        expect(decision.reason).toBe(i.quickRouteOn ? "offered" : "off");
      }),
      { numRuns: 200 },
    );
  });

  it("selects Fast only where it is on offer and was picked: never preselected, never without the switch", () => {
    fc.assert(
      fc.property(input, (i) => {
        const decision = chooseRoute(i);
        expect(decision.selected === "quick").toBe(i.quickRouteOn && i.picked === "quick");
      }),
      { numRuns: 200 },
    );
  });

  it("keeps Quality always available: whatever is not Fast is Quality, and a pick of Quality is kept", () => {
    fc.assert(
      fc.property(input, (i) => {
        const decision = chooseRoute(i);
        if (!decision.offered) expect(decision.selected).toBe("standard");
        if (i.picked === "standard") expect(decision.selected).toBe("standard");
        expect(ROUTE_KINDS).toContain(decision.selected);
        expect(QUICK_OFFERS).toContain(decision.reason);
      }),
      { numRuns: 200 },
    );
  });

  it("is a function of its input alone, and answers Quality for anything it cannot read", () => {
    fc.assert(
      fc.property(fc.anything(), (junk) => {
        const decision = chooseRoute(junk as RouteInput);
        expect(chooseRoute(junk as RouteInput)).toEqual(decision);
        if (!decision.offered)
          expect(decision).toEqual({ offered: false, selected: "standard", reason: "off" });
        // junk cannot select Fast unless it really is the two fields
        if (decision.selected === "quick") expect((junk as RouteInput).picked).toBe("quick");
      }),
      { numRuns: 1000 },
    );
  });
});

describe("routeQuestionDue", () => {
  const seconds = fc.oneof(
    fc.constantFrom(0, 1, 59, 60, 599, 600, 601, 3600, null, Number.NaN, Infinity, -1),
    fc.integer({ min: 0, max: 20_000 }),
  );

  it("asks exactly where Fast is on offer and the guess is a number over ten minutes", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom(null, "quick" as const, "standard" as const),
        seconds,
        (on, picked, full) => {
          const decision = chooseRoute({ quickRouteOn: on, picked });
          const due = routeQuestionDue({ decision, fullSeconds: full });
          expect(due).toBe(on && typeof full === "number" && Number.isFinite(full) && full > 600);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

const facts = fc.record({
  width: side,
  height: side,
  fps: rate,
  durationSeconds: fc.oneof(
    fc.constantFrom(1, 60, 599, 600, 601, 720, 3600),
    fc.integer({ min: 1, max: 20_000 }),
  ),
});
const settingsOf: fc.Arbitrary<ChoiceSettings> = fc.record({
  route: fc.constantFrom("standard" as const, "quick" as const),
  resolution: fc.constantFrom(...RESOLUTIONS),
  fps: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 120 })),
  explicit,
});
const row: fc.Arbitrary<FastSpeedupRow> = fc.record(
  {
    shortSide: fc.record({ min: fc.integer({ min: 200, max: 4500 }) }, { requiredKeys: [] }),
    fps: fc.record({ min: fc.integer({ min: 10, max: 120 }) }, { requiredKeys: [] }),
    durationSeconds: fc.record({ max: fc.integer({ min: 1, max: 7200 }) }, { requiredKeys: [] }),
    figure: fc.double({ min: 1.01, max: 20, noNaN: true }),
  },
  { requiredKeys: ["figure"] },
);
const labBundle = fc.record({
  ladder: fc.constant(QUICK_BUNDLE.ladder),
  maxFps: fc.constant(30),
  quality: fc.constant("medium" as const),
  confirm: fc.constant(QUICK_BUNDLE.confirm),
  speedup: fc.array(row, { maxLength: 4 }),
}) as fc.Arbitrary<QuickBundle>;

describe("needsSlowConfirm: over every project, choice and lab table", () => {
  it("never asks without a figure for the project: no figure, no question", () => {
    fc.assert(
      fc.property(settingsOf, facts, labBundle, (settings, project, data) => {
        if (fastSpeedupLabel(project, data) === null)
          expect(needsSlowConfirm(settings, project, data)).toBe(false);
        // and the shipped table has no figure, so the shipped bundle never asks
        expect(needsSlowConfirm(settings, project)).toBe(false);
      }),
      { numRuns: 3000 },
    );
  });

  it("never asks about a project that is small by its own facts", () => {
    fc.assert(
      fc.property(settingsOf, facts, (settings, project) => {
        const every: QuickBundle = { ...QUICK_BUNDLE, speedup: [{ figure: 4 }] };
        const short = shortOf(compositeOf(project));
        const big =
          short >= every.confirm.shortSide ||
          Math.trunc(project.fps) >= every.confirm.fps ||
          project.durationSeconds > every.confirm.durationSeconds;
        if (!big) expect(needsSlowConfirm(settings, project, every)).toBe(false);
      }),
      { numRuns: 3000 },
    );
  });

  it("never asks about Fast with its own settings, or with only a quality of its own, on any project and with any figure", () => {
    fc.assert(
      fc.property(facts, fc.boolean(), (project, qualitySet) => {
        const every: QuickBundle = { ...QUICK_BUNDLE, speedup: [{ figure: 4 }] };
        expect(
          needsSlowConfirm(
            {
              route: "quick",
              resolution: "source",
              fps: null,
              explicit: { size: false, fps: false, quality: qualitySet },
            },
            project,
            every,
          ),
        ).toBe(false);
      }),
      { numRuns: 2000 },
    );
  });

  it("only gains the question as the table gains a row: adding a row never takes a question away", () => {
    fc.assert(
      fc.property(settingsOf, facts, labBundle, row, (settings, project, data, extra) => {
        const before = needsSlowConfirm(settings, project, data);
        const after = needsSlowConfirm(settings, project, {
          ...data,
          speedup: [...data.speedup, extra],
        });
        if (before) expect(after).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it("asks exactly when the project is big, the choice is heavier than Fast's own and a figure exists, by what the render would deliver", () => {
    const every: QuickBundle = { ...QUICK_BUNDLE, speedup: [{ figure: 4 }] };
    fc.assert(
      fc.property(settingsOf, facts, (settings, project) => {
        const own = compositeOf(project);
        const bigProject =
          shortOf(own) >= every.confirm.shortSide ||
          Math.trunc(project.fps) >= every.confirm.fps ||
          project.durationSeconds > every.confirm.durationSeconds;
        // what the choice delivers: Fast composes what was not set (the default size, the rate cap), Quality delivers what the settings say
        const composed =
          settings.route === "quick"
            ? quickSettings({
                canvas: project,
                requested: { resolution: settings.resolution, fps: settings.fps ?? undefined },
                explicit: settings.explicit,
              })
            : { resolution: settings.resolution, fps: settings.fps ?? undefined };
        const plan = buildRenderCommand(projectOf(project), "/out.mp4", {
          resolution: composed.resolution,
          fps: composed.fps,
        });
        const fastSize = quickDefaultSize(project);
        const fastShort = fastSize === null ? shortOf(own) : SIDE[fastSize];
        const heavier =
          Math.min(plan.output.width, plan.output.height) > fastShort ||
          plan.output.fps > every.maxFps;
        expect(needsSlowConfirm(settings, project, every)).toBe(bigProject && heavier);
      }),
      { numRuns: 300 },
    );
  });

  it("is a function of its input alone, and never throws", () => {
    fc.assert(
      fc.property(settingsOf, facts, labBundle, (settings, project, data) => {
        const frozen = structuredClone({ settings, project });
        const once = needsSlowConfirm(settings, project, data);
        expect(needsSlowConfirm(settings, project, data)).toBe(once);
        expect({ settings, project }).toEqual(frozen);
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (settings, project) => {
        expect(() => needsSlowConfirm(settings as ChoiceSettings, project as never)).not.toThrow();
        expect(needsSlowConfirm(settings as ChoiceSettings, project as never)).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});
