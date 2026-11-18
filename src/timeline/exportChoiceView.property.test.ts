// Properties of the Quality / Fast view's pure model over generated projects (T15 of the UI spec): whatever the canvas, the rate, the length, the bundle and the picks, the lists never offer more
// than the project has, what is shown is what is sent, and the figure and the question are claimed only where the lab's table backs them. The oracles are written out here from the spec (the ladder,
// the presets' short sides, the render's even sides, the cut-offs); where the export tool's own composition is the authority (`quickSettings`, `fastSpeedupLabel`) it is called as the real thing.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  clampOverrides,
  explicitOf,
  figureFor,
  leversShown,
  ownLevers,
  payloadFor,
  rateEntries,
  rateOptions,
  resolveChoice,
  sizeEntries,
  sizeOptions,
  summaryFor,
  type Choice,
  type Levers,
  type Overrides,
} from "./exportChoiceView";
import { describeFigure, figureBrackets, figureNumber } from "./exportChoiceWords";
import type { ExportQuality, ExportResolution } from "./exportOptions";
import {
  QUICK_BUNDLE,
  SIZE_PRESETS,
  fastSpeedupLabel,
  quickSettings,
  type FastSpeedupRow,
  type ProjectFacts,
  type QuickBundle,
  type SizePreset,
} from "./exportRoute";

// ---- the oracles, written out from the spec ----

const PRESETS_LARGEST_FIRST: SizePreset[] = ["2160p", "1440p", "1080p", "720p", "480p"];
const PRESET_SHORT_SIDE: Record<SizePreset, number> = {
  "2160p": 2160,
  "1440p": 1440,
  "1080p": 1080,
  "720p": 720,
  "480p": 480,
};
const PRESET_NAME: Record<SizePreset, string> = {
  "2160p": "2160p (4K)",
  "1440p": "1440p",
  "1080p": "1080p",
  "720p": "720p",
  "480p": "480p",
};
const RATE_LADDER = [60, 50, 30, 25, 24];
const QUALITY_NAME: Record<ExportQuality, string> = { high: "High", medium: "Medium", low: "Low" };
const QUALITY_OWN: Levers = { resolution: "source", fps: null, quality: "medium" };

/** The side the render makes of an authored side: cut to a whole number, made even, never under 2. */
const evenSide = (side: number): number => Math.max(2, Math.round(Math.trunc(side) / 2) * 2);
const shortSideOf = (f: { width: number; height: number }): number =>
  Math.min(evenSide(f.width), evenSide(f.height));
const isPreset = (value: string): value is SizePreset => value in PRESET_SHORT_SIDE;

/** Fast's own values: what the export tool composes for a request that sets nothing (the spec's table 3.1, "Fast shows"). */
const fastOwn = (f: ProjectFacts | null, bundle: QuickBundle = QUICK_BUNDLE): Levers => {
  if (f === null) return { resolution: "source", fps: null, quality: bundle.quality };
  const composed = quickSettings({
    canvas: f,
    requested: {},
    explicit: { size: false, fps: false, quality: false },
    bundle,
  });
  return {
    resolution: composed.resolution,
    fps: composed.fps ?? null,
    quality: composed.quality ?? bundle.quality,
  };
};
const ownOf = (choice: Choice, f: ProjectFacts | null, bundle: QuickBundle = QUICK_BUNDLE): Levers =>
  choice === "quality" ? QUALITY_OWN : fastOwn(f, bundle);

/** What a pick must hold to survive: a size in the list, a rate that is null or from 1 up to and excluding the project's, a quality of the three. */
const sizeInRange = (r: ExportResolution, f: ProjectFacts | null): boolean =>
  r === "source" ||
  (f !== null && isPreset(r) && PRESET_SHORT_SIDE[r] < shortSideOf(f));
const rateInRange = (v: unknown, f: ProjectFacts | null): boolean =>
  v === null || (f !== null && typeof v === "number" && Number.isFinite(v) && v >= 1 && v < f.fps);
const qualityInRange = (q: unknown): boolean => q === "high" || q === "medium" || q === "low";

/** The picks that survive the clamp, worked out from the rules above. */
const keptOracle = (o: Overrides, f: ProjectFacts | null): Overrides => {
  const kept: Overrides = {};
  if (o.resolution !== undefined && sizeInRange(o.resolution, f)) kept.resolution = o.resolution;
  if (o.fps !== undefined && rateInRange(o.fps, f)) kept.fps = o.fps;
  if (o.quality !== undefined && qualityInRange(o.quality)) kept.quality = o.quality;
  return kept;
};

// ---- the generators ----

/** Sides with weight on the lines of the ladder (each rung and one either side of it, odd and even), and very small ones. */
const EDGES = [
  479, 480, 481, 482, 719, 720, 721, 722, 1079, 1080, 1081, 1082, 1439, 1440, 1441, 2159, 2160, 2161,
  2162, 4319, 4320,
];
const side = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 2, max: 9000 }) },
  { weight: 3, arbitrary: fc.constantFrom(...EDGES) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 16 }) },
);
/** The canvases of the spec's table 3.1, vertical and odd ones among them. */
const SPEC_CANVASES: [number, number][] = [
  [1080, 1920],
  [3840, 2160],
  [2560, 1440],
  [1280, 720],
  [854, 480],
  [1920, 1080],
  [7680, 4320],
  [2160, 3840],
  [1081, 1921],
];
const canvasSize = fc.oneof(
  { weight: 4, arbitrary: fc.record({ width: side, height: side }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(...SPEC_CANVASES).map(([width, height]) => ({ width, height })),
  },
);
const rate = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 120 }) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 72, 120),
  },
  { weight: 1, arbitrary: fc.double({ min: 1, max: 120, noNaN: true }) },
);
const duration = fc.oneof(
  fc.constantFrom(0, 1, 360, 600, 601, 720, 7200),
  fc.integer({ min: 0, max: 7200 }),
);
const project: fc.Arbitrary<ProjectFacts> = fc
  .tuple(canvasSize, rate, duration)
  .map(([canvas, fps, durationSeconds]) => ({ ...canvas, fps, durationSeconds }));
/** Mostly a project, now and then none (the dialog before a project is open). */
const maybeProject: fc.Arbitrary<ProjectFacts | null> = fc.oneof(
  { weight: 12, arbitrary: project },
  { weight: 1, arbitrary: fc.constant(null) },
);
const choice = fc.constantFrom("quality" as const, "fast" as const);
const qualityValue = fc.constantFrom("high" as const, "medium" as const, "low" as const);
const resolutionValue = fc.constantFrom(
  "source" as const,
  "2160p" as const,
  "1440p" as const,
  "1080p" as const,
  "720p" as const,
  "480p" as const,
);

/** Every sort of rate a pick could carry: from the list, off it, below 1, negative, not a number. */
const anyRate = fc.oneof(
  fc.constant(null),
  fc.constantFrom(24, 25, 30, 50, 60, 29.97, 59.94, 1, 0, 0.99, -5, 120, 144),
  fc.integer({ min: -3, max: 130 }),
  fc.double({ min: 0, max: 130, noNaN: true }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);
const overrides: fc.Arbitrary<Overrides> = fc.record(
  { resolution: resolutionValue, fps: anyRate, quality: qualityValue },
  { requiredKeys: [] },
);
/** The same, and now and then a quality that is not one of the three. */
const overridesOrGarbage: fc.Arbitrary<Overrides> = fc
  .tuple(overrides, fc.option(fc.constantFrom("ultra", "", "HIGH"), { nil: undefined }))
  .map(([o, garbage]) =>
    garbage === undefined ? o : { ...o, quality: garbage as unknown as ExportQuality },
  );
/** The picks a person can make in the lists: a size, Same as project or a whole rate, a quality. */
const listLikeOverrides: fc.Arbitrary<Overrides> = fc.record(
  {
    resolution: resolutionValue,
    fps: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 130 })),
    quality: qualityValue,
  },
  { requiredKeys: [] },
);
const shownLevers: fc.Arbitrary<Levers> = fc.record({
  resolution: resolutionValue,
  fps: fc.oneof(fc.constant(null), fc.constantFrom(60, 50, 30, 25, 24)),
  quality: qualityValue,
});

const randomBundle: fc.Arbitrary<QuickBundle> = fc.record({
  ladder: fc.shuffledSubarray([...SIZE_PRESETS], { minLength: 0 }),
  maxFps: fc.integer({ min: 5, max: 120 }),
  quality: qualityValue,
  confirm: fc.record({
    shortSide: fc.integer({ min: 240, max: 4320 }),
    fps: fc.integer({ min: 12, max: 120 }),
    durationSeconds: fc.integer({ min: 1, max: 7200 }),
  }),
  speedup: fc.constant([] as FastSpeedupRow[]),
});
/** The real bundle, or any bundle: the lab's table is empty in both. */
const anyBundle = fc.oneof(fc.constant(QUICK_BUNDLE), randomBundle);

const figure = fc.oneof(
  fc.constantFrom(0.5, 1, 1.04, 1.049, 1.06, 2, 2.5, 3.96, 4, 10),
  fc.double({ min: 0, max: 20, noNaN: true }),
);
const range = fc.record(
  { min: fc.integer({ min: 0, max: 5000 }), max: fc.integer({ min: 0, max: 9000 }) },
  { requiredKeys: [] },
);
const tableRow: fc.Arbitrary<FastSpeedupRow> = fc.record(
  { shortSide: range, fps: range, durationSeconds: range, figure },
  { requiredKeys: ["figure"] },
);
/** The real bundle's other figures, with rows of the lab's table put in. */
const tableBundle: fc.Arbitrary<QuickBundle> = fc
  .array(tableRow, { maxLength: 4 })
  .map((speedup) => ({ ...QUICK_BUNDLE, speedup }));

const RUNS = 2500;

describe("T15 (a) sizeOptions: Same as project, then only presets below the short side the render works at", () => {
  it("lists exactly the presets whose short side is below the project's, largest first, once each", () => {
    fc.assert(
      fc.property(project, (f) => {
        const list = sizeOptions(f);
        const short = shortSideOf(f);
        expect(list[0]).toBe("source");
        expect(list.slice(1)).toEqual(PRESETS_LARGEST_FIRST.filter((p) => PRESET_SHORT_SIDE[p] < short));
        expect(new Set(list).size).toBe(list.length);
        for (const entry of list.slice(1))
          expect(PRESET_SHORT_SIDE[entry as SizePreset]).toBeLessThan(short);
      }),
      { numRuns: RUNS },
    );
    expect(sizeOptions(null)).toEqual(["source"]);
  });

  it("names the first entry as the picture the render makes of the project, the others by their preset", () => {
    fc.assert(
      fc.property(project, (f) => {
        const entries = sizeEntries(f);
        expect(entries.map((e) => e.value)).toEqual(sizeOptions(f));
        expect(entries[0]?.label).toBe(
          `Same as project (${evenSide(f.width)} x ${evenSide(f.height)})`,
        );
        for (const entry of entries.slice(1))
          expect(entry.label).toBe(PRESET_NAME[entry.value as SizePreset]);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("T15 (b) Fast's own size and rate are always in the lists", () => {
  it("has Fast's own size among the entries, for any ladder", () => {
    fc.assert(
      fc.property(maybeProject, anyBundle, (f, b) => {
        expect(sizeOptions(f)).toContain(ownLevers("fast", f, b).resolution);
      }),
      { numRuns: RUNS },
    );
  });

  it("has Fast's own rate among the entries once the view passes it as the extra", () => {
    fc.assert(
      fc.property(project, anyBundle, (f, b) => {
        const own = ownLevers("fast", f, b).fps;
        if (own === null) return;
        expect(rateOptions(f, own)).toContain(own);
        expect(own).toBeLessThan(f.fps);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("T15 (c) rateOptions: below the project's rate, highest first, once each", () => {
  const extra = fc.option(
    fc.oneof(
      fc.integer({ min: -2, max: 130 }),
      fc.constantFrom(18, 16, 24, 25, 0.5, 1, 17.5, Number.NaN, Number.POSITIVE_INFINITY),
      fc.double({ min: 0, max: 130, noNaN: true }),
    ),
    { nil: null },
  );

  it("starts with Same as project and holds only the ladder's rates below the project's, and the extra where it fits", () => {
    fc.assert(
      fc.property(maybeProject, extra, (f, e) => {
        const list = rateOptions(f, e);
        expect(list[0]).toBeNull();
        const rest = list.slice(1) as number[];
        if (f === null) {
          expect(rest).toEqual([]);
          return;
        }
        for (const entry of rest) {
          expect(typeof entry).toBe("number");
          expect(entry).toBeLessThan(f.fps);
        }
        for (let i = 1; i < rest.length; i += 1) expect(rest[i]).toBeLessThan(rest[i - 1] as number);
        const wanted = new Set(RATE_LADDER.filter((r) => r < f.fps));
        if (e !== null && e < f.fps && e >= 1) wanted.add(e);
        expect(rest).toEqual([...wanted].sort((a, b) => b - a));
      }),
      { numRuns: RUNS },
    );
  });

  it("names every entry, the first as the project's own rate", () => {
    fc.assert(
      fc.property(project, (f) => {
        const entries = rateEntries(f);
        expect(entries.map((e) => e.value)).toEqual(rateOptions(f));
        expect(entries[0]?.label).toMatch(/^Same as project \(\d+(\.\d{1,2})? fps\)$/);
        for (const entry of entries.slice(1)) expect(entry.label).toBe(`${entry.value} fps`);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("T15 (d) clampOverrides", () => {
  it("is idempotent, and keeps exactly the picks that are in range", () => {
    fc.assert(
      fc.property(maybeProject, overridesOrGarbage, (f, o) => {
        const before = { ...o };
        const result = clampOverrides(o, f);
        expect(o).toEqual(before);
        expect(result).toEqual(keptOracle(o, f));
        // a second pass changes nothing and hands back the very same object
        expect(clampOverrides(result, f)).toBe(result);
      }),
      { numRuns: RUNS },
    );
  });

  it("returns the SAME object when nothing was out of range, and a new one when something was", () => {
    fc.assert(
      fc.property(maybeProject, overridesOrGarbage, (f, o) => {
        const nothingOut = Object.keys(keptOracle(o, f)).length === Object.keys(o).length;
        const result = clampOverrides(o, f);
        if (nothingOut) expect(result).toBe(o);
        else expect(result).not.toBe(o);
      }),
      { numRuns: RUNS },
    );
  });

  it("never keeps a size outside sizeOptions, a rate at or above the project's, or a number that is not finite", () => {
    fc.assert(
      fc.property(maybeProject, overridesOrGarbage, (f, o) => {
        const result = clampOverrides(o, f);
        if (result.resolution !== undefined) expect(sizeOptions(f)).toContain(result.resolution);
        if (typeof result.fps === "number") {
          expect(Number.isFinite(result.fps)).toBe(true);
          expect(f).not.toBeNull();
          expect(result.fps).toBeGreaterThanOrEqual(1);
          expect(result.fps).toBeLessThan((f as ProjectFacts).fps);
        }
        if (result.quality !== undefined) expect(["high", "medium", "low"]).toContain(result.quality);
      }),
      { numRuns: RUNS },
    );
  });

  it("with unreadable facts drops every numeric rate and every size but Same as project, and keeps null and a valid quality", () => {
    fc.assert(
      fc.property(overridesOrGarbage, (o) => {
        const result = clampOverrides(o, null);
        expect(result.fps === undefined || result.fps === null).toBe(true);
        expect(result.resolution === undefined || result.resolution === "source").toBe(true);
        if (o.fps === null) expect(result.fps).toBeNull();
        if (o.resolution === "source") expect(result.resolution).toBe("source");
        if (o.quality !== undefined && qualityInRange(o.quality))
          expect(result.quality).toBe(o.quality);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("T15 (e) leversShown: never above the project, and the choice's own where nothing was picked", () => {
  it("shows a size in the list and a rate that is Same as project or below the project's", () => {
    fc.assert(
      fc.property(choice, maybeProject, overridesOrGarbage, anyBundle, (c, f, o, b) => {
        const shown = leversShown(c, o, f, b);
        expect(sizeOptions(f)).toContain(shown.resolution);
        if (shown.fps !== null) {
          expect(f).not.toBeNull();
          expect(shown.fps).toBeLessThan((f as ProjectFacts).fps);
        }
        expect(["high", "medium", "low"]).toContain(shown.quality);
      }),
      { numRuns: RUNS },
    );
  });

  it("is the choice's own value for every lever without a pick, and the pick for every lever with one", () => {
    fc.assert(
      fc.property(choice, maybeProject, overridesOrGarbage, anyBundle, (c, f, o, b) => {
        const shown = leversShown(c, o, f, b);
        const kept = keptOracle(o, f);
        const own = ownOf(c, f, b);
        expect(shown.resolution).toBe(kept.resolution ?? own.resolution);
        expect(shown.fps).toBe(kept.fps !== undefined ? kept.fps : own.fps);
        expect(shown.quality).toBe(kept.quality ?? own.quality);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("T15 (f) the sent picture is the shown one", () => {
  it("Fast: the export tool's composition over the shown values, with the explicit flags that are sent, delivers the picture the shown values give directly", () => {
    fc.assert(
      fc.property(project, listLikeOverrides, anyBundle, (f, o, b) => {
        const resolved = resolveChoice("fast", o, f, b);
        const sent = payloadFor("fast", resolved.shown, resolved.kept, null);
        const explicit = sent.route?.explicit;
        expect(explicit).toEqual(explicitOf(resolved.kept));
        const viaTool = quickSettings({
          canvas: f,
          requested: {
            resolution: sent.resolution,
            fps: sent.fps ?? undefined,
            quality: sent.quality,
          },
          explicit: explicit as { size: boolean; fps: boolean; quality: boolean },
          bundle: b,
        });
        const direct = quickSettings({
          canvas: f,
          requested: {
            resolution: resolved.shown.resolution,
            fps: resolved.shown.fps ?? undefined,
            quality: resolved.shown.quality,
          },
          explicit: { size: true, fps: true, quality: true },
          bundle: b,
        });
        expect(viaTool.delivered).toEqual(direct.delivered);
        expect(viaTool.quality).toBe(resolved.shown.quality);
        // and the picture is never larger or faster than the project's
        expect(viaTool.delivered?.width).toBeLessThanOrEqual(evenSide(f.width));
        expect(viaTool.delivered?.height).toBeLessThanOrEqual(evenSide(f.height));
        expect(viaTool.delivered?.fps).toBeLessThanOrEqual(Math.trunc(f.fps));
      }),
      { numRuns: RUNS },
    );
  });

  it("Quality: sends the shown values as they are, with the app's own mode", () => {
    fc.assert(
      fc.property(
        maybeProject,
        listLikeOverrides,
        fc.constantFrom("quality" as const, null),
        (f, o, mode) => {
          const resolved = resolveChoice("quality", o, f);
          expect(payloadFor("quality", resolved.shown, resolved.kept, mode)).toStrictEqual({
            resolution: resolved.shown.resolution,
            quality: resolved.shown.quality,
            fps: resolved.shown.fps,
            mode,
          });
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("T15 (g) payloadFor", () => {
  it("never gives Quality a route, and gives it exactly resolution, quality, fps and mode", () => {
    fc.assert(
      fc.property(
        maybeProject,
        overridesOrGarbage,
        shownLevers,
        fc.constantFrom("quality" as const, null),
        (f, o, shown, mode) => {
          const sent = payloadFor("quality", shown, clampOverrides(o, f), mode);
          expect("route" in sent).toBe(false);
          expect(Object.keys(sent).sort()).toEqual(["fps", "mode", "quality", "resolution"]);
          expect(sent.mode).toBe(mode);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("gives Fast a quick route that names the picks, and leaves the mode to the app", () => {
    fc.assert(
      fc.property(
        maybeProject,
        overridesOrGarbage,
        shownLevers,
        fc.constantFrom("quality" as const, null),
        (f, o, shown, mode) => {
          const kept = clampOverrides(o, f);
          const sent = payloadFor("fast", shown, kept, mode);
          expect(sent.mode).toBeNull();
          expect(sent.route).toEqual({ route: "quick", explicit: explicitOf(kept) });
          expect(sent.resolution).toBe(shown.resolution);
          expect(sent.fps).toBe(shown.fps);
          expect(sent.quality).toBe(shown.quality);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("T15 (h) summaryFor is built from the bundle", () => {
  it("writes the bundle's cap, its quality and whether its ladder has a size below the project's", () => {
    fc.assert(
      fc.property(maybeProject, anyBundle, (f, b) => {
        const smaller =
          f !== null && b.ladder.some((rung) => PRESET_SHORT_SIDE[rung] < shortSideOf(f));
        expect(summaryFor("fast", f, b)).toBe(
          `${smaller ? "One size smaller, up to" : "Up to"} ${b.maxFps} frames a second, ${QUALITY_NAME[b.quality]} quality, faster compression.`,
        );
        expect(summaryFor("quality", f, b)).toBe("Project size and frame rate, Medium quality.");
      }),
      { numRuns: RUNS },
    );
  });

  it("gives another line for another bundle: another cap or another quality is another sentence", () => {
    fc.assert(
      fc.property(maybeProject, randomBundle, randomBundle, (f, one, other) => {
        if (one.maxFps === other.maxFps && one.quality === other.quality) return;
        expect(summaryFor("fast", f, one)).not.toBe(summaryFor("fast", f, other));
      }),
      { numRuns: RUNS },
    );
  });
});

describe("T15 (i) figureFor: only the lab's number, only on the choice's own size and rate", () => {
  it("is null for every project, choice and shown value while the table is empty", () => {
    fc.assert(
      fc.property(maybeProject, choice, shownLevers, anyBundle, (f, c, shown, b) => {
        expect(figureFor(c, shown, f, b)).toBeNull();
        expect(figureFor(c, ownOf(c, f, b), f, b)).toBeNull();
      }),
      { numRuns: RUNS },
    );
  });

  it("with a table gives the row's number only while the shown size and rate are the choice's own, and never one that rounds to 1 or less", () => {
    fc.assert(
      fc.property(
        project,
        choice,
        tableBundle,
        shownLevers,
        qualityValue,
        fc.boolean(),
        (f, c, table, other, quality, useOwn) => {
          const own = ownOf(c, f, table);
          const shown: Levers = useOwn ? { ...own, quality } : other;
          const label = fastSpeedupLabel(f, table);
          const claimable = label !== null && Math.round(label * 10) / 10 > 1;
          const onOwn = shown.resolution === own.resolution && shown.fps === own.fps;
          const result = figureFor(c, shown, f, table);
          expect(result).toBe(claimable && onOwn ? label : null);
          if (result !== null) {
            expect(describeFigure(result)).not.toBe("1x");
            expect(Number(figureNumber(result))).toBeGreaterThan(1);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("T15 (i) the question: never for an ordinary project, an empty table or Fast on its own settings", () => {
  it("never asks while the table is empty", () => {
    fc.assert(
      fc.property(maybeProject, choice, overridesOrGarbage, anyBundle, (f, c, o, b) => {
        expect(resolveChoice(c, o, f, b).ask).toBeNull();
      }),
      { numRuns: RUNS },
    );
  });

  it("never asks of Fast on its own settings, whatever the table says", () => {
    fc.assert(
      fc.property(maybeProject, tableBundle, (f, table) => {
        expect(resolveChoice("fast", {}, f, table).ask).toBeNull();
      }),
      { numRuns: RUNS },
    );
  });

  it("never asks for a project that is not big: short side under 2160, under 50 frames a second, 600 seconds or less", () => {
    const ordinary = project.filter(
      (f) => shortSideOf(f) < 2160 && Math.trunc(f.fps) < 50 && f.durationSeconds <= 600,
    );
    fc.assert(
      fc.property(ordinary, choice, overridesOrGarbage, tableBundle, (f, c, o, table) => {
        expect(resolveChoice(c, o, f, table).ask).toBeNull();
      }),
      { numRuns: RUNS },
    );
  });

  it("asks (a) of Quality and (b) of Fast, and (b) never states a figure", () => {
    fc.assert(
      fc.property(project, choice, overridesOrGarbage, tableBundle, (f, c, o, table) => {
        const resolved = resolveChoice(c, o, f, table);
        if (resolved.ask === null) return;
        expect(resolved.ask.kind).toBe(c === "quality" ? "a" : "b");
        if (resolved.ask.kind === "b") expect(resolved.ask.figure).toBeNull();
        else expect(resolved.ask.figure).toBe(resolved.figure);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("T15 (j) describeFigure and figureNumber", () => {
  it("writes a whole number without a decimal, anything else with one decimal, to the nearest tenth", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1000, noNaN: true }), (n) => {
        const text = describeFigure(n);
        expect(text).toMatch(/^\d+(\.\d)?x$/);
        expect(text).not.toMatch(/\.0x$/);
        expect(Math.abs(Number(text.slice(0, -1)) - n)).toBeLessThanOrEqual(0.05 + 1e-9);
        expect(figureBrackets(n)).toBe(`(${text})`);
        expect(figureNumber(n)).toBe(text.slice(0, -1));
      }),
      { numRuns: RUNS },
    );
  });

  it("writes a whole figure as itself and reads 3.96 as 4, 2.5 as 2.5", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (k) => {
        expect(describeFigure(k)).toBe(`${k}x`);
        expect(describeFigure(k + 0.5)).toBe(`${k + 0.5}x`);
      }),
      { numRuns: 1000 },
    );
    expect(describeFigure(3.96)).toBe("4x");
    expect(describeFigure(2.5)).toBe("2.5x");
  });

  it("never writes a smaller figure as a bigger one", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        (a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          expect(Number(figureNumber(low))).toBeLessThanOrEqual(Number(figureNumber(high)));
        },
      ),
      { numRuns: RUNS },
    );
  });
});

it("is written for projects of every shape: the generators reach the lines of the ladder", () => {
  // a guard against a generator that stopped producing the cases the properties are about
  const seen = new Set<string>();
  fc.assert(
    fc.property(project, (f) => {
      seen.add(`${shortSideOf(f) >= 2160 ? "big" : "small"}|${f.fps >= 50 ? "fast" : "slow"}|${sizeOptions(f).length}`);
    }),
    { numRuns: 2000 },
  );
  expect(seen.size).toBeGreaterThan(8);
});
