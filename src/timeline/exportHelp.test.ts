import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  MAX_SLOW_BANNERS,
  SLOW_AFTER_SECONDS,
  SLOW_MIN_PRODUCED,
  exportHelp,
  type ActivityVerdict,
  type HelpInput,
  type HelpView,
} from "./exportHelp";
import { QUIET_SECONDS } from "./exportWords";
import { HELP_WORDS } from "./exportTypes3c";

const base: HelpInput = {
  elapsedSeconds: 600,
  producedFraction: 0.15,
  renderEtaSeconds: 3360,
  expectedSeconds: 1260,
  expectedBasis: "pc_check",
  quickSeconds: 540,
  quietSeconds: 0,
  verdict: "busy",
  canSwitch: true,
  shown: { slowShown: 0, silencedAtProjection: null, quietShown: false },
  flagOn: true,
};
const help = (over: Partial<HelpInput> = {}): HelpView => exportHelp({ ...base, ...over });
const shown = (over: Partial<HelpInput["shown"]>): HelpInput["shown"] => ({
  ...base.shown,
  ...over,
});

describe("the slow banner: when it shows", () => {
  it("shows the words of the copy, with the times of the facts, for an export going much slower than said", () => {
    // Expected 21 min; 10 min in with 56 min left: 66 min projected, over three times 21 min.
    expect(help()).toEqual({
      kind: "slow",
      lines: [
        "This PC is slower than expected: about 56 min left",
        "It was expected to take about 21 min.",
        "Quick export would take about 9 min, starting over.",
      ],
      buttons: ["switch_to_quick", "keep_going", "cancel"],
      quickAvailable: true,
      quickSeconds: 540,
      projectedTotalSeconds: 3960,
    });
  });

  it("says Quick would not help, and what to lower, when Quick is not at least 40 % sooner than what is left", () => {
    const view = help({ renderEtaSeconds: 6120, quickSeconds: 4000 });
    expect(view).toEqual({
      kind: "slow",
      lines: [
        "This PC is slower than expected: about 1 h 42 min left",
        "It was expected to take about 21 min.",
        "Quick export would not be much faster than what is left. To go faster, cancel, use fewer layers or clips, and export again.",
      ],
      buttons: ["keep_going", "cancel"],
      quickAvailable: false,
      quickSeconds: null,
      projectedTotalSeconds: 6720,
    });
  });

  it("offers Switch to Quick exactly when Quick finishes at least 40 % sooner than what is left", () => {
    // 100 s in, 900 s left: Quick must take 540 s or less.
    const at = (quickSeconds: number) =>
      help({
        elapsedSeconds: 100,
        renderEtaSeconds: 900,
        producedFraction: 0.1,
        expectedSeconds: 200,
        quickSeconds,
      });
    expect(at(540).quickAvailable).toBe(true);
    expect(at(540).buttons).toContain("switch_to_quick");
    expect(at(541).quickAvailable).toBe(false);
    expect(at(541).buttons).not.toContain("switch_to_quick");
    expect(at(541).kind).toBe("slow");
  });

  it("does not offer Switch to Quick where there is nothing to switch, and then says nothing of Quick but how to go faster", () => {
    for (const over of [{ canSwitch: false }, { quickSeconds: null }]) {
      const view = help(over);
      expect(view.kind).toBe("slow");
      expect(view.buttons).toEqual(["keep_going", "cancel"]);
      expect(view.quickAvailable).toBe(false);
      expect(view.lines.join(" ")).not.toContain("Quick export would take");
      expect(view.lines).toContain(
        "To go faster, cancel, use fewer layers or clips, and export again.",
      );
    }
  });

  it("needs a projection over three times the estimate that was shown: exactly three times is not enough", () => {
    // 600 s in with an estimate of 300 s: projected 900 is exactly three times.
    const at = (renderEtaSeconds: number) =>
      help({ elapsedSeconds: 600, renderEtaSeconds, expectedSeconds: 300, producedFraction: 0.5 });
    expect(at(300).kind).toBe("none");
    expect(at(301).kind).toBe("slow");
    expect(at(0).kind).toBe("none");
  });

  it("waits for 90 s of running and 2 % produced, however far over the estimate the projection is", () => {
    const hot = { renderEtaSeconds: 100_000, expectedSeconds: 300 };
    expect(help({ ...hot, elapsedSeconds: SLOW_AFTER_SECONDS - 1 }).kind).toBe("none");
    expect(help({ ...hot, elapsedSeconds: SLOW_AFTER_SECONDS }).kind).toBe("slow");
    expect(help({ ...hot, producedFraction: SLOW_MIN_PRODUCED - 0.0001 }).kind).toBe("none");
    expect(help({ ...hot, producedFraction: SLOW_MIN_PRODUCED }).kind).toBe("slow");
    expect(help({ ...hot, elapsedSeconds: 0, producedFraction: 0 }).kind).toBe("none");
  });

  it("projects from the share produced where the render has no time left of its own (a streamed or a sequence export)", () => {
    // 200 s in with 10 % produced is 2000 s in all; the estimate was 300 s.
    const view = help({
      renderEtaSeconds: null,
      elapsedSeconds: 200,
      producedFraction: 0.1,
      expectedSeconds: 300,
    });
    expect(view.kind).toBe("slow");
    expect(view.projectedTotalSeconds).toBe(2000);
    // Under 2 % there is nothing to project from.
    expect(
      help({ renderEtaSeconds: null, elapsedSeconds: 200, producedFraction: 0.019 }).kind,
    ).toBe("none");
    // Not over three times: 200 s in with 40 % produced is 500 s in all.
    expect(
      help({
        renderEtaSeconds: null,
        elapsedSeconds: 200,
        producedFraction: 0.4,
        expectedSeconds: 300,
      }).kind,
    ).toBe("none");
  });

  it("with no measured estimate shown (a rough guess, or none) it waits for a projection over 30 minutes instead", () => {
    for (const [expectedSeconds, expectedBasis] of [
      [100, "guess"],
      [null, null],
      [100, null],
    ] as const) {
      const at = (renderEtaSeconds: number) =>
        help({ expectedSeconds, expectedBasis, elapsedSeconds: 600, renderEtaSeconds });
      expect(at(1199).kind).toBe("none"); // projected 1799 s
      expect(at(1200).kind).toBe("none"); // exactly 30 minutes
      expect(at(1201).kind).toBe("slow");
    }
    // A measured estimate that was shown decides: an hour projected against a two-hour estimate is nowhere near three times it,
    // though it is over 30 minutes.
    expect(
      help({ expectedSeconds: 7200, expectedBasis: "history", renderEtaSeconds: 3000 }).kind,
    ).toBe("none");
  });

  it("says nothing of an estimate that was never shown, and keeps the rest", () => {
    const view = help({ expectedSeconds: null, expectedBasis: null, renderEtaSeconds: 3000 });
    expect(view.kind).toBe("slow");
    expect(view.lines.join(" ")).not.toContain("expected to take");
    expect(view.lines[0]).toBe("This PC is slower than expected: about 50 min left");
  });

  it("is nothing at all when the flag is off, and when the render is over", () => {
    const nothing = {
      kind: "none",
      lines: [],
      buttons: [],
      quickAvailable: false,
      quickSeconds: null,
      projectedTotalSeconds: null,
    };
    expect(help({ flagOn: false })).toEqual(nothing);
    expect(help({ flagOn: false, quietSeconds: 500, verdict: "idle" })).toEqual(nothing);
    expect(help({ producedFraction: 1 })).toEqual(nothing);
    expect(help({ producedFraction: 1, quietSeconds: 500, verdict: "idle" })).toEqual(nothing);
  });
});

describe("the slow banner: Keep going and the limit of two", () => {
  it("is silenced by Keep going until the projection doubles again", () => {
    // Silenced at a projection of 4000 s: it stays quiet below 8000 s and comes back at 8000 s.
    const silenced = shown({ slowShown: 1, silencedAtProjection: 4000 });
    const at = (renderEtaSeconds: number) =>
      help({ elapsedSeconds: 600, renderEtaSeconds, shown: silenced }).kind;
    expect(at(3400)).toBe("none"); // projected 4000
    expect(at(7399)).toBe("none"); // projected 7999
    expect(at(7400)).toBe("slow"); // projected 8000
    expect(at(20_000)).toBe("slow");
  });

  it("shows at most two banners for one export, whatever the projection does", () => {
    const twice = shown({ slowShown: MAX_SLOW_BANNERS, silencedAtProjection: 4000 });
    for (const renderEtaSeconds of [8000, 80_000, 8_000_000])
      expect(help({ elapsedSeconds: 600, renderEtaSeconds, shown: twice }).kind).toBe("none");
    // Even with nothing recorded about when it was silenced.
    expect(
      help({ shown: shown({ slowShown: 2, silencedAtProjection: null }), renderEtaSeconds: 1e7 })
        .kind,
    ).toBe("none");
    // One banner answered, and the projection has doubled: the second one shows.
    expect(
      help({
        elapsedSeconds: 600,
        renderEtaSeconds: 7400,
        shown: shown({ slowShown: 1, silencedAtProjection: 4000 }),
      }).kind,
    ).toBe("slow");
  });
});

describe("the stopped-moving banner and the stall rule's verdict", () => {
  const stopped = (over: Partial<HelpInput> = {}) =>
    help({
      quietSeconds: 75,
      renderEtaSeconds: null,
      elapsedSeconds: 600,
      producedFraction: 0.3,
      ...over,
    });

  it("shows after 60 s with no progress when the processor is idle, with the words of the copy and the stall rule's promise", () => {
    expect(stopped({ verdict: "idle" })).toEqual({
      kind: "quiet",
      lines: [
        "This export has stopped moving",
        "No progress for 75 s.",
        "Quick export would take about 9 min, starting over.",
        "ArtDaddy stops it if nothing moves for 3 minutes.",
      ],
      buttons: ["switch_to_quick", "keep_going", "cancel"],
      quickAvailable: true,
      quickSeconds: 540,
      projectedTotalSeconds: 2000,
    });
  });

  it("shows for a verdict that is not known, without the promise that ArtDaddy will stop it", () => {
    const view = stopped({ verdict: "unknown" });
    expect(view.kind).toBe("quiet");
    expect(view.lines).toEqual([
      "This export has stopped moving",
      "No progress for 75 s.",
      "Quick export would take about 9 min, starting over.",
    ]);
  });

  it("adds no text of its own while the processor is busy: the card's own 'Still working' stands", () => {
    for (const quietSeconds of [60, 75, 400, 100_000])
      expect(stopped({ verdict: "busy", quietSeconds })).toEqual({
        kind: "none",
        lines: [],
        buttons: [],
        quickAvailable: false,
        quickSeconds: null,
        projectedTotalSeconds: null,
      });
  });

  it("starts at 60 s of no progress, not before, and counts minutes after two", () => {
    expect(stopped({ verdict: "idle", quietSeconds: QUIET_SECONDS - 1 }).kind).not.toBe("quiet");
    expect(stopped({ verdict: "idle", quietSeconds: QUIET_SECONDS }).kind).toBe("quiet");
    expect(stopped({ verdict: "idle", quietSeconds: 119 }).lines[1]).toBe("No progress for 119 s.");
    expect(stopped({ verdict: "idle", quietSeconds: 125 }).lines[1]).toBe("No progress for 2 min.");
  });

  it("never shows a slow banner on top of a stopped one, however far over the estimate the projection is", () => {
    for (const verdict of ["busy", "idle", "unknown"] as ActivityVerdict[]) {
      const view = help({ verdict, quietSeconds: 90, renderEtaSeconds: 1e6 });
      expect(view.kind).not.toBe("slow");
    }
  });

  it("is shown once: after it was answered it does not come back", () => {
    expect(stopped({ verdict: "idle", shown: shown({ quietShown: true }) }).kind).toBe("none");
  });

  it("needs neither the 90 s nor the 2 %: an export that stops at the start is stopped", () => {
    const view = help({
      verdict: "idle",
      quietSeconds: 70,
      elapsedSeconds: 75,
      producedFraction: 0.004,
      renderEtaSeconds: null,
    });
    expect(view.kind).toBe("quiet");
    // With little produced, what is left is nearly all of the estimate: Quick (9 min) is well under 60 % of 21 min.
    expect(view.quickAvailable).toBe(true);
    expect(view.projectedTotalSeconds).toBeNull();
  });

  it("offers Switch to Quick for a stopped export only where Quick would be 40 % sooner than what is left", () => {
    // 600 s in with 30 % produced: 1400 s left by the average pace; Quick must take 840 s or less.
    expect(stopped({ verdict: "idle", quickSeconds: 840 }).quickAvailable).toBe(true);
    const view = stopped({ verdict: "idle", quickSeconds: 841 });
    expect(view.kind).toBe("quiet");
    expect(view.quickAvailable).toBe(false);
    expect(view.buttons).toEqual(["keep_going", "cancel"]);
    expect(view.lines.join(" ")).not.toContain("Quick export would take");
  });
});

describe("the view is a plain function of its input, and fails soft", () => {
  it("shows only kinds the report's list of what help was shown has a word for, and shows both of them", () => {
    const kinds = new Set<string>();
    for (const quietSeconds of [0, 75])
      for (const verdict of ["busy", "idle", "unknown"] as ActivityVerdict[])
        for (const renderEtaSeconds of [null, 3360])
          kinds.add(help({ quietSeconds, verdict, renderEtaSeconds }).kind);
    expect([...kinds].sort()).toEqual(["none", "quiet", "slow"]);
    for (const kind of kinds) if (kind !== "none") expect(HELP_WORDS).toContain(kind);
  });

  it("answers the same twice, leaves the input alone, and hands out arrays nobody else holds", () => {
    const input = structuredClone(base);
    const once = exportHelp(input);
    expect(exportHelp(input)).toEqual(once);
    expect(input).toEqual(base);
    once.lines.push("x");
    once.buttons.length = 0;
    expect(exportHelp(input).lines).toHaveLength(3);
    expect(exportHelp(input).buttons).toHaveLength(3);
    const nothing = help({ flagOn: false });
    nothing.lines.push("x");
    expect(help({ flagOn: false }).lines).toEqual([]);
  });

  it("shows nothing, and does not throw, for numbers that are not numbers or input that is not input", () => {
    const bad = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -5,
      null,
      undefined,
      "9",
      {},
    ];
    for (const value of bad)
      for (const key of [
        "elapsedSeconds",
        "producedFraction",
        "renderEtaSeconds",
        "expectedSeconds",
        "quickSeconds",
        "quietSeconds",
      ] as const) {
        const view = help({ [key]: value } as Partial<HelpInput>);
        expect(["none", "slow", "quiet"]).toContain(view.kind);
        for (const line of view.lines)
          expect(line).not.toMatch(/NaN|Infinity|undefined|null|\[object/);
      }
    for (const junk of [undefined, null, 0, "x", [], {}]) {
      expect(() => exportHelp(junk as unknown as HelpInput)).not.toThrow();
      expect(exportHelp(junk as unknown as HelpInput).kind).toBe("none");
    }
    // A verdict, a shown record or a basis that is not one reads as the cautious thing.
    expect(help({ verdict: "weird" as never, quietSeconds: 90, renderEtaSeconds: null }).kind).toBe(
      "quiet",
    );
    expect(help({ shown: undefined as never }).kind).toBe("slow");
    // An unknown basis is not a measured estimate: only the 30-minute bound applies, so 25 minutes projected is not slow
    // although it is far over a 100 s estimate.
    expect(
      help({
        expectedBasis: "weird" as never,
        expectedSeconds: 100,
        elapsedSeconds: 600,
        renderEtaSeconds: 900,
      }).kind,
    ).toBe("none");
  });
});

// Replays: a run's progress over time, fed to the banner a few seconds apart as the card would see it.
interface Run {
  /** Seconds before the render produces anything (preparing). */
  prep: number;
  /** The whole run, in seconds. */
  total: number;
  /** Production rate over the run, as (seconds, relative speed) pieces after the preparing. */
  pieces: [seconds: number, speed: number][];
}

/** The run's progress after `t` seconds: the share of the project produced. */
function producedAt(run: Run, t: number): number {
  const weight = run.pieces.reduce((sum, [seconds, speed]) => sum + seconds * speed, 0);
  let left = t - run.prep;
  let made = 0;
  for (const [seconds, speed] of run.pieces) {
    if (left <= 0) break;
    const used = Math.min(left, seconds);
    made += used * speed;
    left -= used;
  }
  return Math.min(1, Math.max(0, made / weight));
}

/** The render's own time left as ffmpeg gives it: what remains over the average speed since the render began. */
function ffmpegEta(run: Run, t: number): number | null {
  const p = producedAt(run, t);
  const since = t - run.prep;
  return p > 0 && since > 0 ? ((1 - p) * since) / p : null;
}

/** A run that makes steady headway: a warm-up, then pieces within `jitter` of one speed. */
function steadyRun(args: {
  prep: number;
  total: number;
  warm: number;
  warmSpeed: number;
  jitter: number[];
}): Run {
  const body = Math.max(1, args.total - args.prep - args.warm);
  const pieces: Run["pieces"] = [];
  if (args.warm > 0) pieces.push([args.warm, args.warmSpeed]);
  for (const speed of args.jitter) pieces.push([body / args.jitter.length, speed]);
  return { prep: args.prep, total: args.prep + args.warm + body, pieces };
}

interface ReplayOptions {
  expectedSeconds: number | null;
  expectedBasis: HelpInput["expectedBasis"];
  quickSeconds: number | null;
  /** Feed the render's own time left (ffmpeg's), or not (a streamed export: the projection is from the share produced). */
  eta: boolean;
  canSwitch?: boolean;
  /** The person clicks Keep going on every slow banner as soon as it shows. */
  keepGoing?: boolean;
  step?: number;
}

interface Replay {
  /** Every moment the banner was on screen, with its kind. */
  views: { t: number; view: HelpView }[];
  /** Slow banners the person was shown (a banner that stays on screen is one). */
  slowBanners: number[];
}

function replay(run: Run, options: ReplayOptions): Replay {
  let state: HelpInput["shown"] = { slowShown: 0, silencedAtProjection: null, quietShown: false };
  const views: Replay["views"] = [];
  const slowBanners: number[] = [];
  for (let t = options.step ?? 5; t <= run.total + 30; t += options.step ?? 5) {
    const view = exportHelp({
      elapsedSeconds: t,
      producedFraction: producedAt(run, t),
      renderEtaSeconds: options.eta ? ffmpegEta(run, t) : null,
      expectedSeconds: options.expectedSeconds,
      expectedBasis: options.expectedBasis,
      quickSeconds: options.quickSeconds,
      quietSeconds: 0,
      verdict: "busy",
      canSwitch: options.canSwitch ?? true,
      shown: state,
      flagOn: true,
    });
    views.push({ t, view });
    if (view.kind === "slow") {
      slowBanners.push(t);
      if (options.keepGoing)
        state = {
          ...state,
          slowShown: state.slowShown + 1,
          silencedAtProjection: view.projectedTotalSeconds,
        };
    }
  }
  return { views, slowBanners };
}

describe("replays of progress: never a banner on a healthy export", () => {
  const healthyA = fc.record({
    ratio: fc.double({ min: 0.1, max: 2, noNaN: true }),
    total: fc.oneof(fc.integer({ min: 70, max: 400 }), fc.integer({ min: 70, max: 20_000 })),
    prep: fc.integer({ min: 0, max: 60 }),
    warm: fc.integer({ min: 0, max: 5 }),
    warmSpeed: fc.double({ min: 0.2, max: 1, noNaN: true }),
    jitter: fc.array(fc.double({ min: 0.95, max: 1.05, noNaN: true }), {
      minLength: 4,
      maxLength: 24,
    }),
    basis: fc.constantFrom("pc_check" as const, "history" as const),
    quick: fc.option(fc.integer({ min: 1, max: 5000 }), { nil: null }),
    canSwitch: fc.boolean(),
  });

  it("an export that finishes within twice its estimate never shows a slow banner, at any moment of its run (the render's own time left)", () => {
    fc.assert(
      fc.property(healthyA, (r) => {
        const run = steadyRun(r);
        // The run ends at `run.total`, which is at most twice the estimate: the estimate is at least half of it.
        const expectedSeconds = run.total / r.ratio;
        const { views } = replay(run, {
          expectedSeconds,
          expectedBasis: r.basis,
          quickSeconds: r.quick,
          eta: true,
          canSwitch: r.canSwitch,
        });
        expect(views.filter(({ view }) => view.kind !== "none").map(({ t }) => t)).toEqual([]);
      }),
      { numRuns: 400 },
    );
  }, 120_000);

  it("the same holds where the projection comes from the share produced (a streamed export), with a smaller delay before the first picture", () => {
    fc.assert(
      fc.property(
        fc.record({
          ratio: fc.double({ min: 0.1, max: 2, noNaN: true }),
          total: fc.integer({ min: 100, max: 20_000 }),
          early: fc.double({ min: 0, max: 1, noNaN: true }),
          jitter: fc.array(fc.double({ min: 0.97, max: 1.03, noNaN: true }), {
            minLength: 4,
            maxLength: 24,
          }),
          basis: fc.constantFrom("pc_check" as const, "history" as const),
        }),
        (r) => {
          const run = steadyRun({
            prep: Math.floor((r.early * r.total) / 300),
            total: r.total,
            warm: 0,
            warmSpeed: 1,
            jitter: r.jitter,
          });
          const { views } = replay(run, {
            expectedSeconds: run.total / r.ratio,
            expectedBasis: r.basis,
            quickSeconds: 60,
            eta: false,
          });
          expect(views.filter(({ view }) => view.kind !== "none")).toEqual([]);
        },
      ),
      { numRuns: 400 },
    );
  }, 120_000);

  it("a slow banner never shows before 90 s or before 2 % is produced, on any run", () => {
    fc.assert(
      fc.property(
        fc.record({
          ratio: fc.double({ min: 2.5, max: 20, noNaN: true }),
          total: fc.integer({ min: 100, max: 3000 }),
          prep: fc.integer({ min: 0, max: 120 }),
          jitter: fc.array(fc.double({ min: 0.5, max: 1.5, noNaN: true }), {
            minLength: 2,
            maxLength: 12,
          }),
          eta: fc.boolean(),
        }),
        (r) => {
          const run = steadyRun({
            prep: r.prep,
            total: r.total,
            warm: 0,
            warmSpeed: 1,
            jitter: r.jitter,
          });
          const { views } = replay(run, {
            expectedSeconds: run.total / r.ratio,
            expectedBasis: "pc_check",
            quickSeconds: 100,
            eta: r.eta,
            step: 10,
          });
          const early = views.filter(
            ({ t, view }) =>
              view.kind === "slow" &&
              (t < SLOW_AFTER_SECONDS || producedAt(run, t) < SLOW_MIN_PRODUCED),
          );
          expect(early.map(({ t }) => t)).toEqual([]);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("replays of progress: a render running at four times its estimate", () => {
  const slowRun = (over: { total?: number; prep?: number; jitter?: number[] } = {}) =>
    steadyRun({
      prep: over.prep ?? 10,
      total: over.total ?? 1200,
      warm: 3,
      warmSpeed: 0.4,
      jitter: over.jitter ?? [1, 1, 1, 1, 1, 1],
    });

  it("shows the banner as soon as the conditions hold, which is within three minutes, and once after Keep going", () => {
    const run = slowRun(); // 1200 s for an estimate of 300 s
    const result = replay(run, {
      expectedSeconds: 300,
      expectedBasis: "pc_check",
      quickSeconds: 90,
      eta: true,
      keepGoing: true,
    });
    expect(result.slowBanners).toHaveLength(1);
    // The first moment the run is 90 s in, 2 % produced and projected over 900 s, found from the run itself.
    const crossed = result.views.find(
      ({ t }) => t >= 90 && producedAt(run, t) >= 0.02 && t + (ffmpegEta(run, t) ?? 0) > 900,
    );
    expect(crossed).toBeDefined();
    expect(result.slowBanners[0]).toBeGreaterThanOrEqual(crossed!.t);
    expect(result.slowBanners[0] - crossed!.t).toBeLessThanOrEqual(180);
    // ... and the one banner it showed offers Quick.
    expect(result.views.find(({ t }) => t === result.slowBanners[0])!.view.buttons).toContain(
      "switch_to_quick",
    );
  });

  it("keeps showing the same banner until the person answers, then stays silent while the pace holds", () => {
    const run = slowRun();
    const waiting = replay(run, {
      expectedSeconds: 300,
      expectedBasis: "history",
      quickSeconds: 90,
      eta: true,
      keepGoing: false,
    });
    expect(waiting.slowBanners.length).toBeGreaterThan(10);
    expect(waiting.slowBanners[0]).toBeLessThanOrEqual(120);
    const answered = replay(run, {
      expectedSeconds: 300,
      expectedBasis: "history",
      quickSeconds: 90,
      eta: true,
      keepGoing: true,
    });
    expect(answered.slowBanners).toHaveLength(1);
  });

  it("can return once more when the pace falls away again, and never a third time", () => {
    // Four times the estimate for the first 400 s (a projection of 1200 s against 300 s), then a tenth of that speed: the
    // projection passes twice what it was when the person said Keep going.
    const run: Run = {
      prep: 10,
      total: 10 + 400 + 7900,
      pieces: [
        [400, 1],
        [7900, 0.1],
      ],
    };
    const result = replay(run, {
      expectedSeconds: 300,
      expectedBasis: "pc_check",
      quickSeconds: 90,
      eta: true,
      keepGoing: true,
    });
    expect(result.slowBanners).toHaveLength(MAX_SLOW_BANNERS);
    const [first, second] = result.slowBanners;
    expect(first).toBeLessThanOrEqual(120);
    expect(second).toBeGreaterThan(400);
    // Nothing after the second, to the end of the run, however slow it gets.
    expect(result.views.filter(({ t, view }) => t > second && view.kind !== "none")).toEqual([]);
  });

  it("is slower than expected for a streamed export too, from the share produced", () => {
    const run = slowRun({ prep: 5 });
    const result = replay(run, {
      expectedSeconds: 300,
      expectedBasis: "pc_check",
      quickSeconds: 90,
      eta: false,
      keepGoing: true,
    });
    expect(result.slowBanners).toHaveLength(1);
    expect(result.slowBanners[0]).toBeLessThanOrEqual(270);
  });

  it("shows for a render at four times its estimate across generated runs, once, within three minutes of the conditions", () => {
    fc.assert(
      fc.property(
        fc.record({
          ratio: fc.double({ min: 3.5, max: 8, noNaN: true }),
          expected: fc.integer({ min: 100, max: 3000 }),
          prep: fc.integer({ min: 0, max: 60 }),
          jitter: fc.array(fc.double({ min: 0.95, max: 1.05, noNaN: true }), {
            minLength: 4,
            maxLength: 12,
          }),
        }),
        (r) => {
          const run = steadyRun({
            prep: r.prep,
            total: r.expected * r.ratio,
            warm: 2,
            warmSpeed: 0.5,
            jitter: r.jitter,
          });
          const result = replay(run, {
            expectedSeconds: r.expected,
            expectedBasis: "pc_check",
            quickSeconds: r.expected / 3,
            eta: true,
            keepGoing: true,
          });
          expect(result.slowBanners).toHaveLength(1);
          const crossed = result.views.find(
            ({ t }) =>
              t >= 90 &&
              producedAt(run, t) >= 0.02 &&
              t + (ffmpegEta(run, t) ?? 0) > 3 * r.expected,
          );
          expect(crossed).toBeDefined();
          expect(result.slowBanners[0] - crossed!.t).toBeGreaterThanOrEqual(0);
          expect(result.slowBanners[0] - crossed!.t).toBeLessThanOrEqual(180);
        },
      ),
      { numRuns: 500 },
    );
  });
});

const number = fc.oneof(
  { weight: 6, arbitrary: fc.double({ min: 0, max: 50_000, noNaN: true }) },
  { weight: 1, arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -1, 0) },
);
const maybe = fc.option(number, { nil: null });
const input: fc.Arbitrary<HelpInput> = fc.record({
  elapsedSeconds: number,
  producedFraction: fc.oneof(
    fc.double({ min: 0, max: 1, noNaN: true }),
    fc.constantFrom(0, 0.02, 1, Number.NaN),
  ),
  renderEtaSeconds: maybe,
  expectedSeconds: maybe,
  expectedBasis: fc.constantFrom("pc_check" as const, "history" as const, "guess" as const, null),
  quickSeconds: maybe,
  quietSeconds: number,
  verdict: fc.constantFrom("busy" as const, "idle" as const, "unknown" as const),
  canSwitch: fc.boolean(),
  shown: fc.record({
    slowShown: fc.integer({ min: 0, max: 3 }),
    silencedAtProjection: maybe,
    quietShown: fc.boolean(),
  }),
  flagOn: fc.boolean(),
});

describe("exportHelp: over every combination of facts", () => {
  it("is well formed: the buttons are the ones the facts allow, Switch to Quick is a button exactly when it is available, and every number is a number", () => {
    fc.assert(
      fc.property(input, (facts) => {
        const view = exportHelp(facts);
        expect(view.buttons.includes("switch_to_quick")).toBe(view.quickAvailable);
        if (view.kind === "none") {
          expect(view).toEqual(exportHelp({ ...facts, flagOn: false }));
          return;
        }
        expect(view.buttons).toContain("keep_going");
        expect(view.buttons).toContain("cancel");
        expect(view.lines.length).toBeGreaterThan(0);
        for (const line of view.lines)
          expect(line).not.toMatch(/NaN|Infinity|undefined|null|\[object/);
        for (const n of [view.quickSeconds, view.projectedTotalSeconds])
          if (n !== null) {
            expect(Number.isInteger(n)).toBe(true);
            expect(n).toBeGreaterThanOrEqual(0);
          }
        if (view.quickAvailable) {
          expect(facts.canSwitch).toBe(true);
          expect(view.quickSeconds).not.toBeNull();
        } else expect(view.quickSeconds).toBeNull();
      }),
      { numRuns: 3000 },
    );
  });

  it("shows a slow banner only for a rendering export that is 90 s in, 2 % produced, not stopped, and over its bound", () => {
    fc.assert(
      fc.property(input, (facts) => {
        const view = exportHelp(facts);
        if (view.kind !== "slow") return;
        expect(facts.flagOn).toBe(true);
        expect(facts.elapsedSeconds).toBeGreaterThanOrEqual(SLOW_AFTER_SECONDS);
        expect(facts.producedFraction).toBeGreaterThanOrEqual(SLOW_MIN_PRODUCED);
        expect(facts.producedFraction).toBeLessThan(1);
        // Not a time (NaN, infinite, negative) is no silence at all.
        expect(Number.isFinite(facts.quietSeconds) ? facts.quietSeconds : 0).toBeLessThan(
          QUIET_SECONDS,
        );
        expect(facts.shown.slowShown).toBeLessThan(MAX_SLOW_BANNERS);
        const projected = view.projectedTotalSeconds as number;
        const expected = facts.expectedSeconds;
        const measured =
          (facts.expectedBasis === "pc_check" || facts.expectedBasis === "history") &&
          expected !== null &&
          Number.isFinite(expected) &&
          expected > 0;
        // The projection is rounded to a whole second in the view, so allow that second.
        if (measured) expect(projected).toBeGreaterThanOrEqual(3 * expected - 1);
        else expect(projected).toBeGreaterThanOrEqual(30 * 60 - 1);
      }),
      { numRuns: 3000 },
    );
  });

  it("is quiet exactly when the render has stood still for 60 s on an idle or unknown processor, and is never anything else then", () => {
    fc.assert(
      fc.property(input, (facts) => {
        const view = exportHelp(facts);
        const stood = Number.isFinite(facts.quietSeconds) && facts.quietSeconds >= QUIET_SECONDS;
        const over = facts.producedFraction >= 1;
        if (stood && facts.flagOn && !over && !facts.shown.quietShown && facts.verdict !== "busy")
          expect(view.kind).toBe("quiet");
        if (stood && facts.verdict === "busy") expect(view.kind).toBe("none");
        if (stood) expect(view.kind).not.toBe("slow");
        if (view.kind === "quiet") expect(stood).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });

  it("is monotone in the projection: a slower projection never takes a slow banner away", () => {
    fc.assert(
      fc.property(input, fc.double({ min: 0, max: 100_000, noNaN: true }), (facts, more) => {
        const eta = facts.renderEtaSeconds;
        if (eta === null || !Number.isFinite(eta) || eta < 0) return;
        const before = exportHelp(facts);
        const after = exportHelp({ ...facts, renderEtaSeconds: eta + more });
        if (before.kind === "slow") expect(after.kind).toBe("slow");
      }),
      { numRuns: 3000 },
    );
  });

  it("is a function of its input alone", () => {
    fc.assert(
      fc.property(input, (facts) => {
        const frozen = structuredClone(facts);
        expect(exportHelp(facts)).toEqual(exportHelp(structuredClone(facts)));
        expect(facts).toEqual(frozen);
      }),
      { numRuns: 1000 },
    );
  });

  it("never throws, and shows nothing for input that is not input", () => {
    fc.assert(
      fc.property(fc.anything(), (junk) => {
        expect(() => exportHelp(junk as HelpInput)).not.toThrow();
        expect(exportHelp(junk as HelpInput).kind).toBe("none");
      }),
      { numRuns: 500 },
    );
  });
});
