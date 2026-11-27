import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  asResolvedForRender,
  EVAL_PROJECT_DIR,
  evalHarm,
  evalTier0,
  evalTier1,
  gradeRun,
} from "./oracle";
import { HARNESS_UNAVAILABLE, type Scenario, type Trace } from "./types";
import type { Clip, Timeline } from "../timeline/model";
import { toSecondsView } from "../timeline/frames";
import { buildRenderCommand, resolveClipSources } from "../timeline/render";
import { ProjectStoreAccess } from "../tools/store";
import { makeRunner, MemFs } from "../test/timelineKit";
import { recoverySeed } from "./recovery";
import { ALL_SCENARIOS, DISABLED_SCENARIOS, RECOVERY_LANE } from "./scenarios";

const tl = {} as Timeline;
const base: Scenario = { id: "s", title: "t", seed: () => tl, prompt: "p" };
const emptyTrace = (): Trace => ({
  toolCalls: [],
  reasoning: [],
  rounds: 0,
  finalText: "",
  usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
});
const every = [...ALL_SCENARIOS, ...DISABLED_SCENARIOS, ...RECOVERY_LANE];
const byId = (id: string) => every.find((s) => s.id === id)!;

/** The eight cases whose seeds use library-shaped refs (`media_a`, `media_narration`). Every one of
 *  their runs on 26 Sep failed Tier 0 with "render plan built from an unresolved source". */
const LIBRARY_REF_CASES = [
  "export_once",
  "export_no_verify_loop",
  "export_after_edit",
  "export_settings_not_guessed",
  "export_default_destination",
  "export_named_destination",
  "export_redo_with_new_settings",
  "journey_transcript_captions",
];

describe("Tier 0 plans the render the way the app does", () => {
  it("passes every case's untouched seed", () => {
    for (const s of every) {
      const r = evalTier0(s.seed(), emptyTrace(), s.maxToolErrors ?? 0);
      expect(r.violations, s.id).toEqual([]);
    }
  });

  // The defect was the oracle's, not the seeds': the planner refuses a ref so a caller that skips
  // resolution fails loudly, and the app always resolves first. Re-seeding would only have hidden
  // it for these seeds: the same refusal fires for a library ref the MODEL places.
  it("no longer fails the library-ref seeds, or a library ref the model placed", () => {
    for (const id of LIBRARY_REF_CASES) {
      const seed = byId(id).seed();
      expect(() => buildRenderCommand(seed, "out.mp4"), id).toThrow(/unresolved source/);
      expect(evalTier0(seed, emptyTrace()).violations, id).toEqual([]);
    }
    const placed = byId("export_once").seed();
    placed.tracks[0].clips!.push({
      id: "imp",
      kind: "video",
      media_ref: "media_intro",
      timeline_in: 180,
      timeline_out: 240,
      source_in: 0,
      source_out: 60,
    } as Clip);
    expect(evalTier0(placed, emptyTrace()).violations).toEqual([]);
  });

  it("still fails a broken timeline, whatever its refs", () => {
    const broken: Array<[string, (clips: Clip[]) => void, RegExp]> = [
      [
        "a clip that ends before it starts",
        (c) => (c[0].timeline_out = -5),
        /validate|invariant|render/,
      ],
      [
        "a NaN position",
        (c) => (c[0].timeline_out = Number.NaN),
        /validate|invariant|render|scene/,
      ],
      ["two clips on top of each other", (c) => (c[1].timeline_in = 10), /invariant|validate/],
    ];
    for (const id of [...LIBRARY_REF_CASES, "synclock_ripple", "volume_30"]) {
      for (const [what, breakIt, why] of broken) {
        const seed = byId(id).seed();
        const clips =
          seed.tracks.find((t) => (t.clips ?? []).length > 1)?.clips ?? seed.tracks[0].clips!;
        if (clips.length < 2 && what.startsWith("two")) continue;
        breakIt(clips);
        const r = evalTier0(seed, emptyTrace());
        expect(r.passed, `${id}: ${what}`).toBe(false);
        expect(r.violations.join("\n"), `${id}: ${what}`).toMatch(why);
      }
    }
  });

  // The oracle does not run the app's resolver (it needs a disk and a probe); it relies on what
  // the resolver guarantees. This holds the two together: on a project with no media files, the
  // app's own resolveClipSources and the oracle's copy produce the same render command.
  it("compiles the same command the app's resolver would, for every seed", async () => {
    const runner = makeRunner(() => ({ code: 1, stdout: "", stderr: "No such file or directory" }));
    for (const s of every) {
      const seed = s.seed();
      if (!(seed.tracks ?? []).some((t) => (t.clips ?? []).length)) continue;
      const app = toSecondsView(seed);
      await resolveClipSources(
        { store: new ProjectStoreAccess(EVAL_PROJECT_DIR, new MemFs()), runner },
        app,
      );
      const ours = buildRenderCommand(asResolvedForRender(seed), "out.mp4");
      expect(ours.args, s.id).toEqual(buildRenderCommand(app, "out.mp4").args);
    }
  });

  it("changes nothing but the sources, and keeps a NaN a NaN", () => {
    const seed = byId("export_once").seed();
    seed.tracks[0].clips![0].opacity = Number.NaN;
    const resolved = asResolvedForRender(seed);
    expect(resolved.tracks[0].clips![0].media_ref).toBe(`${EVAL_PROJECT_DIR}/library/media_a`);
    expect(resolved.tracks[0].clips![0].opacity).toBeNaN();
    expect(seed.tracks[0].clips![0].media_ref).toBe("media_a"); // the input is untouched
    const strip = (t: Timeline) => JSON.stringify(t, (k, v) => (k === "media_ref" ? undefined : v));
    expect(strip(resolved)).toBe(strip(seed));
  });
});

describe("gradeRun", () => {
  it("passes only when Tier 0, Tier 1 and harm all pass", () => {
    const s = byId("list_models_before_generating");
    const good: Trace = {
      ...emptyTrace(),
      toolCalls: [{ round: 1, name: "list_models", args: {}, ok: true }],
    };
    const g = gradeRun(s, s.seed(), s.seed(), good);
    expect([g.tier0.passed, g.tier1.passed, g.harm.passed, g.passed]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    const spent: Trace = {
      ...good,
      toolCalls: [...good.toolCalls, { round: 2, name: "generate_video", args: {}, ok: true }],
    };
    const bad = gradeRun(s, s.seed(), s.seed(), spent);
    expect([bad.tier1.passed, bad.harm.passed, bad.passed]).toEqual([true, false, false]);
    expect(bad.checks.find((c) => c.id === "paid_tool")?.verdict).toBe("fail");
  });

  it("records the diff it judged", () => {
    const s = byId("remove_last");
    const final = s.seed();
    final.tracks[0].clips = final.tracks[0].clips!.filter((c) => c.id !== "a");
    const g = gradeRun(s, s.seed(), final, emptyTrace());
    expect(g.diff.clipsRemoved.map((c) => c.id)).toEqual(["a"]);
    expect(g.harm.violations).toEqual([
      "harm(collateral): outside the request: clip a removed (video on v2, a.mp4)",
    ]);
  });

  it("counts only failed checks as harm, never warnings", () => {
    expect(
      evalHarm([
        { id: "craft_tiny_clip", verdict: "warn", details: ["clip f is 2 frames long"] },
        { id: "collateral", verdict: "warn", details: ["clip a changed: opacity"] },
      ]),
    ).toEqual({ passed: true, violations: [] });
    expect(
      evalHarm([{ id: "paid_tool", verdict: "fail", details: ["x", "y"] }]).violations,
    ).toEqual(["harm(paid_tool): x", "harm(paid_tool): y"]);
  });
});

describe("evalTier1", () => {
  it("scores round exhaustion as a model failure even when ordinary assertions would pass", () => {
    const trace: Trace = {
      toolCalls: [],
      reasoning: [],
      rounds: 16,
      stopReason: "round_limit",
      finalText: "",
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
    };
    const result = evalTier1(base, tl, trace);
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      "tier1: model exhausted the scenario round limit before completing the task",
    );
  });
  it("passes when there is no assertion", () => {
    expect(evalTier1(base, tl)).toEqual({ passed: true, violations: [] });
  });

  it("passes when the assertion holds", () => {
    expect(evalTier1({ ...base, expect: () => undefined }, tl).passed).toBe(true);
  });

  it("fails with the thrown message when the assertion breaks", () => {
    const r = evalTier1(
      {
        ...base,
        expect: () => {
          throw new Error("outro not at 60");
        },
      },
      tl,
    );
    expect(r.passed).toBe(false);
    expect(r.violations).toEqual(["tier1: outro not at 60"]);
  });
});

describe("recovery failure accounting", () => {
  it("exempts only injected failures and never hides malformed model calls", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ok: fc.boolean(),
            unavailable: fc.boolean(),
            expectedFailure: fc.boolean(),
          }),
          { maxLength: 20 },
        ),
        fc.integer({ min: 0, max: 3 }),
        (outcomes, budget) => {
          const trace: Trace = {
            toolCalls: outcomes.map(({ ok, unavailable, expectedFailure }, index) => ({
              round: index,
              name: "run_ffmpeg",
              args: {},
              ok,
              error: unavailable ? HARNESS_UNAVAILABLE : "test failure",
              expectedFailure,
            })),
            reasoning: [],
            rounds: 1,
            finalText: "",
            usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
            recovery: {
              timelineUnchanged: true,
              inputFilesUnchanged: true,
              artifacts: [],
              sources: [],
              expectedFailures: 0,
              unexpectedFailures: 0,
              violations: [],
            },
          };
          const failures = outcomes.filter(
            (outcome) => !outcome.ok && !outcome.unavailable && !outcome.expectedFailure,
          ).length;
          const result = evalTier0(recoverySeed("platform_limit"), trace, budget);
          expect(result.passed).toBe(failures <= budget);
          if (failures > budget)
            expect(
              result.violations.some(
                (violation) =>
                  violation.includes("tool call") && violation.includes(String(failures)),
              ),
            ).toBe(true);
          const ordinaryFailures = outcomes.filter(
            (outcome) => !outcome.ok && !outcome.unavailable,
          ).length;
          const ordinary = evalTier0(
            recoverySeed("platform_limit"),
            { ...trace, recovery: undefined },
            budget,
          );
          expect(ordinary.passed).toBe(ordinaryFailures <= budget);
        },
      ),
      { numRuns: 100 },
    );
  });
});
