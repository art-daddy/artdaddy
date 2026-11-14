// Properties of the route rules over generated inputs: the rules of the owner (Quick never overrides a set size or rate, is never
// selected for an export of a minute or less, is never offered under a quarter of the time, and Full quality is always there) must hold
// for every combination, not for the examples somebody remembered.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { outputFps, outputSize, type ExportResolution } from "./exportOptions";
import {
  QUICK_MAX_FPS,
  chooseRoute,
  isWeakPc,
  quickRate,
  quickSettings,
  routeQuestionDue,
  type QuickSettingsInput,
  type RouteInput,
} from "./exportRoute";
import { ESTIMATE_BASES, PC_CLASSES, QUICK_OFFERS, ROUTE_KINDS } from "./exportTypes3c";

const pcClass = fc.constantFrom(...PC_CLASSES);
const picked = fc.constantFrom(null, "quick" as const, "standard" as const);
const explicit = fc.record({ size: fc.boolean(), fps: fc.boolean() });
const basis = fc.constantFrom(...ESTIMATE_BASES, null);

/** Times with weight on the lines that matter (a minute, ten minutes) and a few that are not times at all. */
const seconds = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(0, 1, 59, 60, 61, 599, 600, 601, 3600) },
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 20_000 }) },
  { weight: 1, arbitrary: fc.constantFrom(null, Number.NaN, Number.POSITIVE_INFINITY, -1) },
);
/** A Quick time as a share of Full quality's, with weight on the quarter line. */
const share = fc.oneof(
  fc.constantFrom(0, 0.5, 0.74, 0.75, 0.76, 1, 1.5),
  fc.double({ min: 0, max: 2, noNaN: true }),
);
const fraction = fc.option(
  fc.oneof(fc.constantFrom(0, 0.2499, 0.25, 0.3, 1), fc.double({ min: -1, max: 2, noNaN: true })),
  { nil: undefined },
);

const routeInput: fc.Arbitrary<RouteInput> = fc
  .record({
    pcClass,
    via: fc.constantFrom("dialog" as const, "chat" as const),
    fullSeconds: seconds,
    quickSeconds: seconds,
    share,
    aligned: fc.boolean(),
    fullBasis: basis,
    quickBasis: basis,
    explicit,
    quickFlagOn: fc.boolean(),
    picked,
    encoderOnly: fraction,
  })
  .map((r) => ({
    pcClass: r.pcClass,
    via: r.via,
    full: { seconds: r.fullSeconds, basis: r.fullBasis },
    // Half the time Quick's estimate is built from Full quality's, so the quarter line is reached often.
    quick: {
      seconds:
        r.aligned && typeof r.fullSeconds === "number" && Number.isFinite(r.fullSeconds)
          ? Math.round(r.fullSeconds * r.share)
          : r.quickSeconds,
      basis: r.quickBasis,
    },
    explicit: r.explicit,
    quickFlagOn: r.quickFlagOn,
    picked: r.picked,
    encoderOnlySavingFraction: r.encoderOnly,
  }));

const usable = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0;

describe("chooseRoute: the owner's rules, over every combination", () => {
  it("is never offered, so never selected, for an export of a minute or less or with no estimate", () => {
    fc.assert(
      fc.property(routeInput, (input) => {
        const full = input.full.seconds;
        if (usable(full) && full > 60) return;
        const decision = chooseRoute(input);
        expect(decision.offered).toBe(false);
        expect(decision.selected).toBe("standard");
      }),
      { numRuns: 2000 },
    );
  });

  it("never preselects Quick for a PC that is not weak: Quick selected without a pick means a weak or unfinished class", () => {
    fc.assert(
      fc.property(routeInput, (input) => {
        const decision = chooseRoute({ ...input, picked: null });
        if (decision.selected === "quick") expect(isWeakPc(input.pcClass)).toBe(true);
        if (decision.reason === "selected") {
          expect(decision.selected).toBe("quick");
          expect(isWeakPc(input.pcClass)).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("is never offered where Quick would save under a quarter (judged by its own estimate, or by its encoder alone when both are set)", () => {
    fc.assert(
      fc.property(routeInput, (input) => {
        const decision = chooseRoute(input);
        if (!decision.offered) return;
        if (input.explicit.size && input.explicit.fps) {
          expect(input.encoderOnlySavingFraction).toBeGreaterThanOrEqual(0.25);
        } else {
          const full = input.full.seconds as number;
          expect((input.quick.seconds as number) * 4).toBeLessThanOrEqual(full * 3);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it("puts the quarter line exactly where it belongs: whole seconds, offered if and only if Quick takes at most three quarters", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 61, max: 200_000 }),
        fc.integer({ min: 0, max: 300_000 }),
        pcClass,
        (full, quick, klass) => {
          const decision = chooseRoute({
            pcClass: klass,
            via: "dialog",
            full: { seconds: full, basis: "pc_check" },
            quick: { seconds: quick, basis: "pc_check" },
            explicit: { size: false, fps: false },
            quickFlagOn: true,
            picked: null,
          });
          expect(decision.offered).toBe(quick * 4 <= full * 3);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("keeps Full quality always available: not offered means Full quality is selected, and a pick of it is kept", () => {
    fc.assert(
      fc.property(routeInput, (input) => {
        const decision = chooseRoute(input);
        if (!decision.offered) expect(decision.selected).toBe("standard");
        expect(decision.offered).toBe(
          decision.reason === "selected" || decision.reason === "offered",
        );
        if (input.picked === "standard") expect(chooseRoute(input).selected).toBe("standard");
        if (decision.offered && input.picked === "quick") expect(decision.selected).toBe("quick");
      }),
      { numRuns: 2000 },
    );
  });

  it("offers nothing and says it is off whenever the remote switch is off", () => {
    fc.assert(
      fc.property(routeInput, (input) => {
        expect(chooseRoute({ ...input, quickFlagOn: false })).toEqual({
          offered: false,
          selected: "standard",
          reason: "off",
          savedFraction: null,
        });
      }),
      { numRuns: 500 },
    );
  });

  it("with both a size and a rate set, offers Quick exactly when the encoder alone saves a quarter of an export over a minute", () => {
    fc.assert(
      fc.property(routeInput, (input) => {
        const set = { ...input, explicit: { size: true, fps: true }, quickFlagOn: true };
        const full = set.full.seconds;
        const encoder = set.encoderOnlySavingFraction;
        const want =
          usable(full) &&
          full > 60 &&
          typeof encoder === "number" &&
          Number.isFinite(encoder) &&
          encoder >= 0.25;
        expect(chooseRoute(set).offered).toBe(want);
      }),
      { numRuns: 1500 },
    );
  });

  it("is a function of its input alone: the same twice, the input untouched, and the same wherever the person is asked", () => {
    fc.assert(
      fc.property(routeInput, (input) => {
        const frozen = structuredClone(input);
        const once = chooseRoute(input);
        expect(chooseRoute(input)).toEqual(once);
        expect(input).toEqual(frozen);
        expect(chooseRoute({ ...input, via: input.via === "chat" ? "dialog" : "chat" })).toEqual(
          once,
        );
      }),
      { numRuns: 1000 },
    );
  });

  it("answers in the closed vocabulary with a share between nothing and all, or none", () => {
    fc.assert(
      fc.property(routeInput, (input) => {
        const decision = chooseRoute(input);
        expect(ROUTE_KINDS).toContain(decision.selected);
        expect(QUICK_OFFERS).toContain(decision.reason);
        if (decision.savedFraction !== null) {
          expect(Number.isFinite(decision.savedFraction)).toBe(true);
          expect(decision.savedFraction).toBeGreaterThanOrEqual(0);
          expect(decision.savedFraction).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("only gains the offer as Quick gets faster: a lower Quick time never takes the offer away", () => {
    fc.assert(
      fc.property(routeInput, fc.integer({ min: 0, max: 5000 }), (input, drop) => {
        const quick = input.quick.seconds;
        if (!usable(quick)) return;
        const faster = { ...input, quick: { ...input.quick, seconds: Math.max(0, quick - drop) } };
        if (chooseRoute(input).offered) expect(chooseRoute(faster).offered).toBe(true);
      }),
      { numRuns: 1500 },
    );
  });

  it("never throws, whatever it is given, and still answers in the vocabulary", () => {
    fc.assert(
      fc.property(fc.anything(), (junk) => {
        const decision = chooseRoute(junk as RouteInput);
        expect(ROUTE_KINDS).toContain(decision.selected);
        expect(QUICK_OFFERS).toContain(decision.reason);
        if (!decision.offered) expect(decision.selected).toBe("standard");
      }),
      { numRuns: 1000 },
    );
  });
});

describe("routeQuestionDue: over every combination", () => {
  it("never asks where Quick is not on offer, and always asks where it is on a weak PC", () => {
    fc.assert(
      fc.property(routeInput, seconds, (input, fullSeconds) => {
        const decision = chooseRoute(input);
        const due = routeQuestionDue({
          pcClass: input.pcClass,
          decision,
          fullSeconds: typeof fullSeconds === "number" ? fullSeconds : null,
        });
        if (!decision.offered) expect(due).toBe(false);
        if (decision.offered && isWeakPc(input.pcClass)) expect(due).toBe(true);
        if (decision.offered && !isWeakPc(input.pcClass))
          expect(due).toBe(
            typeof fullSeconds === "number" && Number.isFinite(fullSeconds) && fullSeconds > 600,
          );
      }),
      { numRuns: 1500 },
    );
  });
});

const RESOLUTIONS: ExportResolution[] = ["source", "2160p", "1440p", "1080p", "720p", "480p"];
const canvas = fc.record({
  width: fc.integer({ min: 2, max: 8192 }),
  height: fc.integer({ min: 2, max: 8192 }),
  fps: fc.oneof(
    fc.constantFrom(23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 72, 90, 100, 120),
    fc.integer({ min: 1, max: 240 }),
    fc.double({ min: 1, max: 240, noNaN: true }),
  ),
});
const requested = fc.record(
  {
    resolution: fc.constantFrom(...RESOLUTIONS),
    fps: fc.oneof(fc.integer({ min: 1, max: 144 }), fc.double({ min: 1, max: 144, noNaN: true })),
    quality: fc.constantFrom("high" as const, "medium" as const, "low" as const),
  },
  { requiredKeys: [] },
);
const settingsInput: fc.Arbitrary<QuickSettingsInput> = fc.record({
  canvas,
  requested,
  pcClass,
  explicit,
});

/** What an export delivers for a resolution on a canvas, by the exporter's own size function. */
const shortSide = (c: { width: number; height: number }, resolution: ExportResolution): number => {
  const sized = outputSize(c.width, c.height, resolution);
  return sized ? Math.min(sized.w, sized.h) : Math.min(c.width, c.height);
};

describe("quickSettings: over every combination of set and unset size and rate, canvases, rates and classes", () => {
  it("never enlarges the picture and never raises the rate, by what the exporter would deliver", () => {
    fc.assert(
      fc.property(settingsInput, (input) => {
        const result = quickSettings(input);
        const before = input.requested.resolution ?? "source";
        expect(shortSide(input.canvas, result.resolution)).toBeLessThanOrEqual(
          shortSide(input.canvas, before),
        );
        expect(outputFps(input.canvas.fps, result.fps)).toBeLessThanOrEqual(
          outputFps(input.canvas.fps, input.requested.fps),
        );
      }),
      { numRuns: 3000 },
    );
  });

  it("never overrides a size or a rate that was set: each is returned as it was asked for", () => {
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
      }),
      { numRuns: 3000 },
    );
  });

  it("caps what is not set: the short side at 1080 (720 on a weak or unfinished PC) and the rate at 30", () => {
    fc.assert(
      fc.property(settingsInput, (input) => {
        const result = quickSettings(input);
        if (!input.explicit.size)
          expect(shortSide(input.canvas, result.resolution)).toBeLessThanOrEqual(
            isWeakPc(input.pcClass) ? 720 : 1080,
          );
        if (!input.explicit.fps)
          expect(outputFps(input.canvas.fps, result.fps)).toBeLessThanOrEqual(QUICK_MAX_FPS);
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
          requested: { ...input.requested, resolution: first.resolution, fps: first.fps },
        });
        expect(second).toEqual({ ...first, changedSize: false, changedFps: false });
      }),
      { numRuns: 2000 },
    );
  });

  it("gives a weak PC a picture no larger than any other class gets, from the same request", () => {
    fc.assert(
      fc.property(settingsInput, (input) => {
        const weak = quickSettings({ ...input, pcClass: "weak" });
        const ok = quickSettings({ ...input, pcClass: "ok" });
        expect(shortSide(input.canvas, weak.resolution)).toBeLessThanOrEqual(
          shortSide(input.canvas, ok.resolution),
        );
      }),
      { numRuns: 1500 },
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

  it("never throws, and never gives a size that is not one or a rate that is not a number, whatever it is given", () => {
    fc.assert(
      fc.property(fc.anything(), (junk) => {
        const result = quickSettings(junk as QuickSettingsInput);
        expect(RESOLUTIONS).toContain(result.resolution);
        if (result.fps !== undefined) expect(Number.isFinite(result.fps)).toBe(true);
      }),
      { numRuns: 1000 },
    );
    fc.assert(
      fc.property(
        fc.record({
          canvas: fc.record({
            width: fc.double(),
            height: fc.double(),
            fps: fc.double(),
          }),
          requested: fc.record({ fps: fc.double() }, { requiredKeys: [] }),
          pcClass,
          explicit,
        }),
        (input) => {
          const result = quickSettings(input);
          expect(RESOLUTIONS).toContain(result.resolution);
          if (result.fps !== undefined) expect(Number.isFinite(result.fps)).toBe(true);
        },
      ),
      { numRuns: 1500 },
    );
  });
});

describe("quickRate: over every rate", () => {
  it("never raises a rate, never passes the cap, keeps what is at or under it, and settles", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 1000, noNaN: true }), (rate) => {
        const capped = quickRate(rate) as number;
        expect(capped).toBeLessThanOrEqual(rate);
        expect(capped).toBeLessThanOrEqual(QUICK_MAX_FPS);
        if (rate <= QUICK_MAX_FPS) expect(capped).toBe(rate);
        expect(quickRate(capped)).toBe(capped);
      }),
      { numRuns: 2000 },
    );
  });

  it("above the cap, is 30 or a whole half of a half of the rate (whole at every step)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 31, max: 1000 }), (rate) => {
        const capped = quickRate(rate) as number;
        if (capped === QUICK_MAX_FPS) return;
        expect(Number.isInteger(capped)).toBe(true);
        const steps = Math.log2(rate / capped);
        expect(Number.isInteger(steps)).toBe(true);
        expect(steps).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 1000 },
    );
  });
});
