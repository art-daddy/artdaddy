// The real harness, offline: the real agent loop, real timeline tools and stand-ins, the real
// oracle and records, with the model's rounds SCRIPTED. No network and no model is reached (fetch
// is replaced by a spy that throws, and every test checks it was never called), so this runs in
// the unit lane and costs nothing.
import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingCall, RoundResultDTO, Usage } from "../agent/types";
import { catalogIdentity } from "../contract";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "../store/chatControls";
import { driveScenario, type InferenceRequest } from "./harness";
import { runStatus } from "./oracle";
import { Budget } from "./pricing";
import { ALL_SCENARIOS } from "./scenarios";
import type { CampaignSetup } from "./setup";
import type { Scenario } from "./types";

type Step =
  { text: string; usage?: Usage } | { calls: [string, Record<string, unknown>][]; usage?: Usage };

const USAGE: Usage & { cached_tokens: number } = {
  input_tokens: 1000,
  output_tokens: 50,
  cost_usd: 0.0002,
  cached_tokens: 800,
};

/** A model that answers from a script, one step per round, after `delayMs` of "thinking". */
function scripted(steps: Step[], delayMs = 0) {
  let i = 0;
  const requests: InferenceRequest[] = [];
  const send = async (req: InferenceRequest): Promise<RoundResultDTO> => {
    requests.push(req);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const step = steps[i++] ?? { text: "" };
    const usage = step.usage ?? USAGE;
    if ("text" in step)
      return {
        kind: "text",
        pending_calls: [],
        final_text: step.text,
        error: "",
        finish_reason: "stop",
        usage,
        provider_snapshot: {},
      };
    const pending: PendingCall[] = step.calls.map(([name, args], k) => ({
      call_id: `c${i}_${k}`,
      name,
      arguments: args,
    }));
    return {
      kind: "tool_calls",
      pending_calls: pending,
      final_text: "",
      error: "",
      finish_reason: "tool_calls",
      usage,
      provider_snapshot: {},
    };
  };
  return { send, requests };
}

const WORK = path.resolve("reports", "eval", `scripted-${process.pid}`);
const SETUP: CampaignSetup = {
  appGitSha: "0".repeat(40),
  appGitDirty: false,
  server: "http://offline.invalid",
  serverVersion: "1.2.3",
  serverBuild: "abc123",
  promptSha256: "f".repeat(64),
};
const byId = (id: string): Scenario => ALL_SCENARIOS.find((s) => s.id === id)!;

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("network blocked in the scripted eval test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy, "the scripted harness reached the network").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(() => fsp.rm(WORK, { recursive: true, force: true }));

async function drive(scenario: Scenario, steps: Step[], budget = new Budget(2), delayMs = 0) {
  const { send, requests } = scripted(steps, delayMs);
  const result = await driveScenario(scenario, DEFAULT_MODEL, {
    server: "http://offline.invalid",
    budget,
    send,
    setup: SETUP,
    workDir: WORK,
  });
  return { result, requests };
}

describe("a run records its setup and its clocks", () => {
  it("names the model, effort, catalog and builds, and splits model time from tool time", async () => {
    const { result, requests } = await drive(
      byId("export_once"),
      [{ calls: [["export", {}]] }, { text: "Your export is running." }],
      new Budget(2),
      25,
    );
    expect(result.harnessError).toBeUndefined();
    expect(result.trace.setup).toEqual({
      model: DEFAULT_MODEL,
      effort: DEFAULT_EFFORT,
      mode: "autopilot",
      catalogId: catalogIdentity(),
      appVersion: expect.any(String),
      ...SETUP,
      preload: false,
    });
    // What was recorded is what was sent.
    for (const r of requests) {
      expect([r.model, r.effort, r.mode, r.catalog_id]).toEqual([
        DEFAULT_MODEL,
        DEFAULT_EFFORT,
        "autopilot",
        catalogIdentity(),
      ]);
    }
    const clocks = result.trace.clocks!;
    expect(clocks.rounds.map((r) => [r.round, r.turn, r.tools, r.costKnown])).toEqual([
      [1, 0, 1, true],
      [2, 0, 0, true],
    ]);
    for (const r of clocks.rounds) {
      expect(r.modelMs).toBeGreaterThanOrEqual(20);
      expect(r.firstTokenMs).toBeNull();
    }
    expect(clocks.modelMs).toBe(clocks.rounds[0].modelMs + clocks.rounds[1].modelMs);
    expect(clocks.firstTokenNote).toMatch(/inference\/stream/);
    expect(result.trace.toolCalls[0]).toMatchObject({ name: "export", turn: 0, round: 1 });
    expect(result.trace.toolCalls[0].ms).toBeGreaterThanOrEqual(0);
    expect(result.trace.usage).toMatchObject({
      cachedTokens: 1600,
      credits: null,
      costUnknownRounds: 0,
    });
    expect(result.trace.usage.costUsd).toBeCloseTo(0.0004, 9);
  });

  it("stores the diff and every check's verdict on the trace, for a reader of the trace", async () => {
    const { result } = await drive(byId("remove_last"), [
      { calls: [["remove_clips", { clip_ids: ["c"] }]] },
      { text: "Removed the last clip." },
    ]);
    expect(result.passed).toBe(true);
    expect(result.trace.diff?.clipsRemoved.map((c) => c.id)).toEqual(["c"]);
    expect(result.trace.checks?.map((c) => [c.id, c.verdict])).toEqual([
      ["paid_tool", "pass"],
      ["forbidden_tool", "skip"],
      ["mass_destructive", "pass"],
      ["collateral", "pass"],
      ["craft_main_track_gap", "pass"],
      ["craft_tiny_clip", "pass"],
      ["craft_cut_in_word", "skip"],
      ["craft_caption_drift", "skip"],
    ]);
  });

  it("tags each call with the user turn that issued it", async () => {
    const { result } = await drive(byId("undo_followup"), [
      { calls: [["set_clip_properties", { clip_ids: ["a"], opacity: 0.5 }]] },
      { text: "It is 50% transparent." },
      { calls: [["undo", {}]] },
      { text: "Undone." },
    ]);
    expect(result.passed).toBe(true);
    expect(result.trace.toolCalls.map((c) => [c.name, c.turn])).toEqual([
      ["set_clip_properties", 0],
      ["undo", 1],
    ]);
    expect(result.trace.clocks!.rounds.map((r) => r.turn)).toEqual([0, 0, 1, 1]);
  });
});

describe("the cases that could never pass now run to a verdict", () => {
  const plans: Record<string, Step[]> = {
    export_once: [{ calls: [["export", {}]] }, { text: "Exporting." }],
    export_no_verify_loop: [
      { calls: [["export", {}]] },
      { calls: [["manage_exports", { action: "list" }]] },
      { text: "It is exporting; I'll let it finish." },
    ],
    export_after_edit: [
      { calls: [["remove_clips", { clip_ids: ["b"] }]] },
      { calls: [["export", {}]] },
      { text: "Done." },
    ],
    export_settings_not_guessed: [{ calls: [["export", { resolution: "720p" }]] }, { text: "Ok." }],
    export_default_destination: [{ calls: [["export", {}]] }, { text: "Ok." }],
    export_named_destination: [
      { calls: [["export", { output_path: "C:/Users/eval/Videos/promo.mp4" }]] },
      { text: "Ok." },
    ],
    export_redo_with_new_settings: [
      { calls: [["export", {}]] },
      { text: "Exporting." },
      { calls: [["manage_exports", { action: "cancel", job_id: "job_1" }]] },
      { calls: [["export", { resolution: "720p" }]] },
      { text: "Restarted at 720p." },
    ],
    journey_transcript_captions: [
      { calls: [["get_transcript", {}]] },
      {
        calls: [
          [
            "add_text_clips",
            {
              entries: [
                { timeline_in: 30, timeline_out: 69, content: "Welcome to the show" },
                { timeline_in: 95, timeline_out: 141, content: "today we are" },
                { timeline_in: 145, timeline_out: 221, content: "building something new" },
              ],
            },
          ],
        ],
      },
      { calls: [["set_clip_properties", { clip_ids: ["narration"], duration: 225 }]] },
      { text: "Captioned and trimmed." },
    ],
  };
  for (const [id, steps] of Object.entries(plans))
    it(id, async () => {
      const { result } = await drive(byId(id), steps);
      expect(result.harnessError).toBeUndefined();
      expect(result.tier0.violations).toEqual([]);
      expect([...result.tier1.violations, ...(result.harm?.violations ?? [])]).toEqual([]);
      expect(result.passed).toBe(true);
    });

  it("journey_transcript_captions warns on a trim that cuts the last word", async () => {
    const steps = plans.journey_transcript_captions.map((s) =>
      "calls" in s && s.calls[0][0] === "set_clip_properties"
        ? {
            calls: [["set_clip_properties", { clip_ids: ["narration"], duration: 210 }]] as [
              string,
              Record<string, unknown>,
            ][],
          }
        : s,
    );
    const { result } = await drive(byId("journey_transcript_captions"), steps);
    const cut = result.trace.checks?.find((c) => c.id === "craft_cut_in_word");
    expect(cut?.verdict).toBe("warn");
    expect(cut?.details.join()).toMatch(/cuts "new"/);
    expect(result.passed).toBe(true); // a warning is a pointer, never a verdict
  });
});

describe("harm fails a run through the harness", () => {
  it("a paid call nobody asked for", async () => {
    const { result } = await drive(byId("list_models_before_generating"), [
      { calls: [["list_models", {}]] },
      { calls: [["generate_video", { prompt: "a rocket", model: "veo" }]] },
      { text: "Here is a sample." },
    ]);
    expect(result.tier1.passed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.harm?.violations.join()).toMatch(/harm\(paid_tool\): generate_video/);
  });

  it("deleting the clip a look was asked for", async () => {
    const { result } = await drive(byId("make_it_pop"), [
      { calls: [["remove_clips", { clip_ids: ["a"] }]] },
      { text: "Done." },
    ]);
    expect(result.passed).toBe(false);
    const harm = result.harm?.violations.join("\n") ?? "";
    expect(harm).toMatch(/mass_destructive.*1 of 1 clips removed/);
    expect(harm).toMatch(/collateral.*clip a removed/);
  });
});

describe("the budget cannot be blinded", () => {
  it("stops the campaign on a round that spent tokens and named no cost", async () => {
    const budget = new Budget(2);
    const { result } = await drive(
      byId("trim_to_2s"),
      [{ calls: [["get_timeline", {}]], usage: { input_tokens: 500, output_tokens: 20 } }],
      budget,
    );
    expect(result.harnessError).toMatch(/eval stopped/);
    expect(result.trace.usage.costUnknownRounds).toBe(1);
    expect(result.trace.clocks?.rounds[0].costKnown).toBe(false);
    expect(budget.stopped).toMatch(/no cost/);
    expect(budget.exceeded()).toBe(true);
    // The next case never sends a round.
    const next = await drive(byId("trim_to_2s"), [{ text: "x" }], budget);
    expect(next.requests).toEqual([]);
    expect(next.result.harnessError).toMatch(/eval stopped before a model round/);
  });
});

describe("a known failure is carried onto its result", () => {
  const known = (s: Scenario): Scenario => ({ ...s, knownFailure: "art-daddy/backlog#93" });

  it("reads as a known failure while it fails, and as fixed once it passes", async () => {
    const s = known(byId("trim_to_2s"));
    const failing = await drive(s, [{ text: "Done." }]);
    expect(failing.result.knownFailure).toBe("art-daddy/backlog#93");
    expect(runStatus(failing.result)).toBe("known_failure");
    const passing = await drive(s, [
      { calls: [["set_clip_properties", { clip_ids: ["intro"], duration: 60 }]] },
      { text: "Done." },
    ]);
    expect(runStatus(passing.result)).toBe("fixed");
    expect(runStatus((await drive(byId("trim_to_2s"), [{ text: "Done." }])).result)).toBe("fail");
  });
});
