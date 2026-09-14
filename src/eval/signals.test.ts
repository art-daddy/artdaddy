import { describe, expect, it } from "vitest";

import { analyzeTrace, hasFriction } from "./signals";
import type { Scenario, Trace } from "./types";

const HARNESS_MARK = "(eval) not available in the timeline-only harness";

function scn(extra: Partial<Scenario> = {}): Scenario {
  return { id: "s", title: "t", seed: () => ({}) as never, prompt: "p", ...extra };
}
function trace(extra: Partial<Trace> = {}): Trace {
  return {
    toolCalls: [],
    reasoning: [],
    rounds: 1,
    finalText: "",
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
    ...extra,
  };
}

describe("analyzeTrace", () => {
  // A turn that says "Done." while nothing changed is the worst outcome we ship: the
  // user only discovers it by looking at the timeline, and every other signal is green.
  describe("claimed an edit that never landed", () => {
    it("fires when the model reports an edit with no successful mutating call", () => {
      const t = trace({
        finalText: "Done — I set the frame rate to 24 fps.",
        toolCalls: [{ round: 1, name: "set_project_settings", args: {}, ok: false, error: "nope" }],
      });
      expect(analyzeTrace(scn(), t, []).claimedSuccessWithoutEdit?.claim).toContain("24 fps");
    });

    it("does NOT fire when a mutating call actually succeeded", () => {
      const t = trace({
        finalText: "Done — I set the frame rate to 24 fps.",
        toolCalls: [{ round: 1, name: "set_project_settings", args: {}, ok: true }],
      });
      expect(analyzeTrace(scn(), t, []).claimedSuccessWithoutEdit).toBeUndefined();
    });

    it("does NOT fire on a READ-only turn that reports what it found", () => {
      // The read tools are not mutations, so a factual answer must not look like a bluff.
      const t = trace({
        finalText: "There are two clips on the timeline, a.mp4 and b.mp4.",
        toolCalls: [{ round: 1, name: "get_timeline", args: {}, ok: true }],
      });
      expect(analyzeTrace(scn(), t, []).claimedSuccessWithoutEdit).toBeUndefined();
    });

    it("does NOT fire on an honest refusal or a correct no-op", () => {
      for (const finalText of [
        "I couldn't change the canvas — the size you gave is out of range.",
        "No changes were needed: the project is already at 24 fps.",
        "Nothing to change — that clip is already muted.",
        "Should I trim the last clip instead?",
      ]) {
        expect(
          analyzeTrace(scn(), trace({ finalText }), []).claimedSuccessWithoutEdit,
        ).toBeUndefined();
      }
    });

    it("does NOT fire on a plan the model has not carried out yet", () => {
      const t = trace({ finalText: "I will trim the last clip once you confirm." });
      expect(analyzeTrace(scn(), t, []).claimedSuccessWithoutEdit).toBeUndefined();
    });

    it("counts as friction", () => {
      const t = trace({ finalText: "Done, I removed the silence." });
      expect(hasFriction(analyzeTrace(scn(), t, []))).toBe(true);
    });
  });

  it("collects real tool errors but not harness-unavailable calls", () => {
    const t = trace({
      toolCalls: [
        { round: 1, name: "set_clip_properties", args: {}, ok: false, error: "bad speed" },
        { round: 1, name: "inspect_media", args: {}, ok: false, error: HARNESS_MARK },
        { round: 1, name: "add_clips", args: {}, ok: true },
      ],
    });
    const s = analyzeTrace(scn(), t, []);
    expect(s.toolErrors.map((e) => e.name)).toEqual(["set_clip_properties"]);
    expect(s.notRunInHarness).toEqual(["inspect_media"]);
  });

  it("parses undeclared params from an unknown-param rejection (missing-feature backlog)", () => {
    const t = trace({
      toolCalls: [
        {
          round: 1,
          name: "set_clip_properties",
          args: {},
          ok: false,
          error: "set_clip_properties: unknown param(s) rounding, easing. Allowed: speed, opacity.",
        },
      ],
    });
    const s = analyzeTrace(scn(), t, []);
    expect(s.expectedButUndeclared).toEqual([
      { name: "set_clip_properties", params: ["rounding", "easing"] },
    ]);
  });

  it("flags retry loops (same tool, ≥2 calls, ≥1 failure)", () => {
    const t = trace({
      toolCalls: [
        { round: 1, name: "split_clips", args: {}, ok: false, error: "x" },
        { round: 2, name: "split_clips", args: {}, ok: true },
      ],
    });
    expect(analyzeTrace(scn(), t, []).retryLoops).toEqual([{ name: "split_clips", attempts: 2 }]);
  });

  it("detects workaround smells in reasoning", () => {
    const t = trace({
      reasoning: ["There is no tool to place b-roll, so I'll add_clips manually.", "Looks good."],
    });
    expect(analyzeTrace(scn(), t, []).workaroundSuspected.length).toBe(1);
  });

  it("flags escape-hatch use and wrong-tool-for-intent", () => {
    const t = trace({ toolCalls: [{ round: 1, name: "run_ffmpeg", args: {}, ok: true }] });
    const s = analyzeTrace(scn({ expectTools: ["ripple_delete"] }), t, []);
    expect(s.escapeHatchUsed).toContain("run_ffmpeg");
    expect(s.wrongToolForIntent).toEqual({ expected: ["ripple_delete"], used: ["run_ffmpeg"] });
  });

  it("reports silent corruption only when NO tool errored", () => {
    const clean = trace({ toolCalls: [{ round: 1, name: "x", args: {}, ok: true }] });
    expect(analyzeTrace(scn(), clean, ["validate: a.clips[0] desync"]).silentCorruption).toEqual([
      "validate: a.clips[0] desync",
    ]);
    const errored = trace({
      toolCalls: [{ round: 1, name: "x", args: {}, ok: false, error: "e" }],
    });
    expect(analyzeTrace(scn(), errored, ["validate: a.clips[0] desync"]).silentCorruption).toEqual(
      [],
    );
  });

  it("flags inefficiency past the scenario's maxRounds", () => {
    expect(analyzeTrace(scn({ maxRounds: 3 }), trace({ rounds: 7 }), []).inefficiency).toEqual({
      rounds: 7,
      maxRounds: 3,
    });
    expect(
      analyzeTrace(scn({ maxRounds: 10 }), trace({ rounds: 7 }), []).inefficiency,
    ).toBeUndefined();
  });

  it("hasFriction is true when any signal fires", () => {
    expect(
      hasFriction(analyzeTrace(scn(), trace({ reasoning: ["there is no tool for this"] }), [])),
    ).toBe(true);
    expect(hasFriction(analyzeTrace(scn(), trace(), []))).toBe(false);
  });
});
