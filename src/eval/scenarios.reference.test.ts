// Every case has a correct run (ruling 22 of the agent-evals decision). A case's `reference`, the
// known-right calls with one step per model round across every turn, is replayed through the real
// harness, agent loop, tools, stand-ins and oracle with no model and no network, and must pass:
// tier 0, tier 1 and harm all clean, every step used and no round asked for past the end. A
// reference that passes proves the task can be done with the tools the case offers and that its
// checks accept the right result ("a reference solution ... proves that the task is solvable and
// verifies graders are correctly configured", Anthropic's eval guide). The other half, that a run
// doing nothing fails, is in scenarios.conformance.test.ts.
//
// The recovery lane and the disabled cases are not in ALL_SCENARIOS, so not in scope here.
import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { driveReference, type ReferenceStep } from "./reference";
import { ALL_SCENARIOS } from "./scenarios";
import type { Scenario } from "./types";

/** The cases written before references existed that still have none. Remove a case's id when its
 *  reference lands; never add one, because a new case carries its reference. */
const NO_REFERENCE_YET: ReadonlySet<string> = new Set([
  "trim_to_2s",
  "split_at_1s",
  "reorder_swap",
  "fade_in_1s",
  "opacity_50",
  "volume_30",
  "crossfade_half_sec",
  "add_clip_after",
  "insert_between",
  "remove_last",
  "canvas_landscape",
  "fps_24",
  "canvas_square_no_size",
  "read_whole_timeline",
  "color_warm",
  "title_text",
  "move_to_start",
  "mute_music",
  "compound_fade_crossfade",
  "caption_styled_bold",
  "caption_word_by_word",
  "caption_emphasis_word",
  "caption_kinetic_chunks",
  "caption_preset_punchy",
  "zoom_in_motion",
  "pip_corner",
  "fade_to_black",
  "duck_music",
  "split_music",
  "make_it_pop",
  "retrim_followup",
  "caption_retime_followup",
  "effect_blur",
  "effect_grain",
  "black_and_white",
  "boost_contrast",
  "crop_square",
  "flip_horizontal",
  "rotate_90",
  "add_glow",
  "blend_screen",
  "move_to_topleft",
  "music_fade_out",
  "trim_start",
  "slip_content_later",
  "clear_music_track",
  "split_screen",
  "speed_adjust_followup",
  "undo_followup",
  "effect_disable",
  "effect_remove",
  "effect_partial_update",
  "effect_copy_look",
  "audio_eq_boost",
  "effect_refusal_recovery",
  "t006_speed_1_2x",
  "ripple_both_ids",
  "linked_av_retime_sync",
  "synclock_ripple",
  "t009_property_thrash",
  "vertical_reframe_480p",
  "journey_import_edit_export",
  "journey_transcript_captions",
  "export_once",
  "export_no_verify_loop",
  "export_after_edit",
  "export_settings_not_guessed",
  "export_default_destination",
  "export_named_destination",
  "export_redo_with_new_settings",
  "add_track_for_overlay",
  "redo_after_undo",
  "inspect_color_then_warm",
  "inspect_timeline_check",
  "inspect_media_before_place",
  "download_and_place",
  "search_then_fetch",
  "metadata_before_download",
  "probe_before_trusting",
  "find_moment_and_trim",
  "video_ask_question",
  "crop_to_wordmark",
  "research_then_caption",
  "web_search_answer",
  "screenshot_page_and_place",
  "generate_image_and_place",
  "generate_video_broll",
  "generate_voiceover_and_place",
  "generate_music_bed",
  "list_models_before_generating",
  "project_rename",
  "project_new_for_side_idea",
  "project_duplicate_before_risk",
  "project_list_and_open",
  "project_state_question",
  "project_pack_for_handoff",
  "library_tag_broll",
  "library_place_from_catalog",
  "no_ffmpeg_for_speed",
]);

const WORK = path.resolve("reports", "eval", `reference-${process.pid}`);

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("network blocked in the reference eval test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy, "a reference run reached the network").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(() => fsp.rm(WORK, { recursive: true, force: true }));

/** Everything wrong with a case's reference when it is replayed; empty for a correct run. */
async function replayProblems(s: Scenario): Promise<string[]> {
  const steps = s.reference ?? [];
  if (steps.length === 0) return ["it has no reference"];
  const { result, requests } = await driveReference(s, { workDir: WORK });
  const problems = [
    ...(result.harnessError ? [`harness error: ${result.harnessError}`] : []),
    ...result.tier0.violations,
    ...result.tier1.violations,
    ...(result.harm?.violations ?? []),
  ];
  if (!result.passed && problems.length === 0) problems.push("the run did not pass");
  if (requests.length > steps.length)
    problems.push(
      `the run asked for ${requests.length} rounds and the reference has ${steps.length} steps: ` +
        "a turn did not end with a text step",
    );
  if (requests.length < steps.length)
    problems.push(
      `the reference has ${steps.length} steps and the run used ${requests.length}: ` +
        "a text step ended a turn early, or steps were left over",
    );
  return problems;
}

/** Why a case's inAppOnly reason is not one, or null when it is a sentence saying why. */
function inAppOnlyProblem(reason: unknown): string | null {
  if (reason === undefined) return null;
  if (typeof reason !== "string") return "inAppOnly is a reason, a sentence";
  if (reason.trim().split(/\s+/).filter(Boolean).length < 3)
    return `inAppOnly "${reason}" is not a sentence saying why the Copilot lane cannot run the case`;
  return null;
}

describe("every case has its correct run", () => {
  it("NO_REFERENCE_YET names only cases that exist and still have no reference", () => {
    const ids = new Set(ALL_SCENARIOS.map((s) => s.id));
    const gone = [...NO_REFERENCE_YET].filter((id) => !ids.has(id));
    expect(gone, "not a case any more: remove it from NO_REFERENCE_YET").toEqual([]);
    const done = ALL_SCENARIOS.filter((s) => NO_REFERENCE_YET.has(s.id) && s.reference);
    expect(
      done.map((s) => s.id),
      "has a reference now: remove it from NO_REFERENCE_YET",
    ).toEqual([]);
  });

  it("every other case has a reference", () => {
    const missing = ALL_SCENARIOS.filter(
      (s) => !NO_REFERENCE_YET.has(s.id) && !s.reference?.length,
    ).map((s) => s.id);
    expect(missing, "a case needs its correct run (ruling 22)").toEqual([]);
  });

  it("an inAppOnly reason is a sentence saying why", () => {
    const bad = ALL_SCENARIOS.flatMap((s) => {
      const problem = inAppOnlyProblem(s.inAppOnly);
      return problem ? [`${s.id}: ${problem}`] : [];
    });
    expect(bad).toEqual([]);
  });
});

describe("each case's correct run passes the real harness, offline", () => {
  for (const s of ALL_SCENARIOS) {
    if (NO_REFERENCE_YET.has(s.id)) {
      it.todo(`${s.id} (no reference yet)`);
      continue;
    }
    it(s.id, async () => {
      expect(await replayProblems(s)).toEqual([]);
    });
  }
});

// The checks above must be able to fail: each is shown failing on a broken reference or reason.
describe("the replay and the reason checks can fail", () => {
  const base = ALL_SCENARIOS.find((s) => s.id === "remove_last")!;
  const remove: ReferenceStep = { calls: [["remove_clips", { clip_ids: ["c"] }]] };
  const withRef = (reference: ReferenceStep[]): Scenario => ({ ...base, reference });

  it("passes the known-right run", async () => {
    expect(await replayProblems(withRef([remove, { text: "Removed the last clip." }]))).toEqual([]);
  });

  it("fails a run that does nothing", async () => {
    expect((await replayProblems(withRef([{ text: "Done." }]))).join("\n")).toMatch(/^tier1/m);
  });

  it("fails a run that removes the wrong clip", async () => {
    const wrong: ReferenceStep = { calls: [["remove_clips", { clip_ids: ["a"] }]] };
    const problems = await replayProblems(withRef([wrong, { text: "Removed it." }]));
    expect(problems.join("\n")).toMatch(/^tier1/m);
  });

  it("fails a reference whose turn does not end with a reply", async () => {
    expect((await replayProblems(withRef([remove]))).join("\n")).toMatch(
      /did not end with a text step/,
    );
  });

  it("fails a reference with steps left over", async () => {
    const extra = [remove, { text: "Removed." }, { text: "Anything else?" }];
    expect((await replayProblems(withRef(extra))).join("\n")).toMatch(/left over/);
  });

  it("refuses an inAppOnly reason that is empty or not a sentence", () => {
    for (const reason of ["", "   ", "yes", "copilot lane", 1])
      expect(inAppOnlyProblem(reason), String(reason)).not.toBeNull();
    expect(inAppOnlyProblem("The Copilot lane cannot stop a turn half-way.")).toBeNull();
    expect(inAppOnlyProblem(undefined)).toBeNull();
  });
});
