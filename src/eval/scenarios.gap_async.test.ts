// The gap_async cases, driven offline through the REAL harness: the real agent loop, the real timeline tools, the job
// stand-ins (jobs.ts) and the real oracle, with the model's rounds SCRIPTED. No network and no model: fetch is replaced by
// a spy that throws, and every test checks it was never called.
//
// For every case:
//   - its correct run (the known-right calls) passes, which proves the case can be passed and its checks read it right;
//   - for every kind of request, a realistic wrong run fails, on the check that names its mistake.
// And the app's own message for finished work is what every case gives (the drift guard on jobWake.ts).
import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingCall, RoundResultDTO, ToolResultItem, Usage } from "../agent/types";
import { jobWakePrompt } from "../store/chat";
import type { SettledJob } from "../store/jobNotes";
import { DEFAULT_MODEL } from "../store/chatControls";
import { driveScenario, type InferenceRequest } from "./harness";
import { EXPORT_RUNNING, LANDED_SECONDS } from "./jobs";
import { STUDIO_EXPORT_FILE, WAKES_BUILT } from "./jobWake";
import { Budget } from "./pricing";
import { ALL_SCENARIOS } from "./scenarios";
import { claimsDone, GAP_ASYNC_SCENARIOS } from "./scenarios/gap_async";
import type { Scenario } from "./types";

type Calls = [string, Record<string, unknown>][];
/** Every tool reply the scripted model has seen so far in the run, oldest first. */
type Seen = ToolResultItem[];
/** One scripted round: a reply that ends the turn, or tool calls (fixed, or made from what earlier calls answered). */
type Step = { text: string } | { calls: Calls | ((seen: Seen) => Calls) };

const USAGE: Usage = { input_tokens: 1000, output_tokens: 50, cost_usd: 0.0002 };

function scripted(steps: Step[]) {
  let i = 0;
  const seen: Seen = [];
  const requests: InferenceRequest[] = [];
  const send = async (req: InferenceRequest): Promise<RoundResultDTO> => {
    requests.push(req);
    seen.push(...(req.round_input.tool_results ?? []));
    const step = steps[i++] ?? { text: "" };
    const base = { error: "", usage: USAGE, provider_snapshot: {} };
    if ("text" in step)
      return {
        ...base,
        kind: "text",
        pending_calls: [],
        final_text: step.text,
        finish_reason: "stop",
      };
    const calls = typeof step.calls === "function" ? step.calls(seen) : step.calls;
    const pending: PendingCall[] = calls.map(([name, args], k) => ({
      call_id: `c${i}_${k}`,
      name,
      arguments: args,
    }));
    return {
      ...base,
      kind: "tool_calls",
      pending_calls: pending,
      final_text: "",
      finish_reason: "tool_calls",
    };
  };
  return { send, requests };
}

const WORK = path.resolve("reports", "eval", `gap-async-${process.pid}`);

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

const byId = (id: string): Scenario => {
  const s = ALL_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no case ${id}`);
  return s;
};

async function drive(id: string, steps: Step[]) {
  const { send } = scripted(steps);
  return driveScenario(byId(id), DEFAULT_MODEL, {
    server: "http://offline.invalid",
    budget: new Budget(5),
    send,
    workDir: WORK,
  });
}

/** Every reason a run failed, in one list. */
const why = (r: Awaited<ReturnType<typeof drive>>): string[] => [
  ...(r.harnessError ? [`harness: ${r.harnessError}`] : []),
  ...r.tier0.violations,
  ...r.tier1.violations,
  ...(r.harm?.violations ?? []),
];

// ── building blocks of the scripted runs ──────────────────────────────────────────────────────────────────────────

const say = (text: string): Step => ({ text });
const call = (name: string, args: Record<string, unknown> = {}): Step => ({
  calls: [[name, args]],
});
const calls = (...c: Calls): Step => ({ calls: c });
const place = (...entries: Record<string, unknown>[]): Step => call("add_clips", { entries });
const IMG = (n = 1) => `media_gen_image_${n}`;
const VID = (n = 1) => `media_gen_video_${n}`;
const VO = (n = 1) => `media_gen_voiceover_${n}`;
const MUSIC = (n = 1) => `media_gen_music_${n}`;

/** The id of the clip an earlier add_clips placed for `ref`. */
function placedId(seen: Seen, ref: string): string {
  for (const r of seen)
    if (r.name === "add_clips" || r.name === "insert_clips")
      for (const c of (r.result.created ?? []) as { clip_id: string; media_ref?: string }[])
        if (!c.media_ref || c.media_ref === ref) {
          const entry = JSON.stringify(r.result);
          if (entry.includes(ref)) return c.clip_id;
        }
  throw new Error(`no clip was placed for ${ref}: ${JSON.stringify(seen.map((s) => s.name))}`);
}
/** Swap what a placed clip plays, keeping where it is. */
const swap = (from: string, to: string): Step => ({
  calls: (seen) => [["set_clip_properties", { clip_ids: [placedId(seen, from)], media_ref: to }]],
});
const removePlaced = (ref: string): Step => ({
  calls: (seen) => [["remove_clips", { clip_ids: [placedId(seen, ref)] }]],
});

const STARTED = say("Started it. It takes a minute or so; I'll carry on when it lands.");
const LET_IT_FINISH = say("It is already on its way, so I'm letting it finish.");

// ── the correct run of every case ─────────────────────────────────────────────────────────────────────────────────

const REFERENCE: Record<string, Step[]> = {
  async_voiceover_lands_then_placed: [
    call("generate_voiceover", { text: "Liftoff in three, two, one" }),
    STARTED,
    LET_IT_FINISH,
    place({ media_ref: VO(), timeline_in: 0 }),
    say("The voiceover is in, under the start of the video."),
  ],
  async_music_bed_fills_video: [
    call("generate_music", {
      prompt: "calm ambient instrumental bed, soft pads",
      instrumental: true,
    }),
    STARTED,
    LET_IT_FINISH,
    place({ media_ref: MUSIC(), timeline_in: 0, timeline_out: 300 }),
    say("The music runs under the whole video and stops where it ends."),
  ],
  async_image_placed_while_generating: [
    call("generate_image", { prompt: "sunrise over a rocket launch pad, wide shot, warm light" }),
    call("add_track", { id: "v2", kind: "video" }),
    place({ media_ref: IMG(), timeline_in: 0, timeline_out: 90, track_id: "v2" }),
    say(
      "The image is generating and already placed over the first three seconds; it fills in by itself.",
    ),
    LET_IT_FINISH,
    say("It has landed and is already in place, so there is nothing more to do."),
  ],
  async_generated_video_first_four_seconds: [
    call("generate_video", { prompt: "a crowd cheering, handheld, waving", duration: 8 }),
    place({ media_ref: VID(), timeline_in: 300, duration: 120 }),
    say("The crowd shot is generating; its first four seconds are placed after your clip."),
    LET_IT_FINISH,
    say("It landed and fills its place."),
  ],
  async_export_reports_file_when_done: [
    call("export"),
    say("Exporting now. It will take a moment; I'll tell you when the file is written."),
    say(`Your video is saved as ${STUDIO_EXPORT_FILE} in your Downloads folder.`),
  ],
  async_export_failed_offers_retry: [
    call("export"),
    say("Exporting now; I'll tell you when the file is written."),
    say(
      "The export failed: the drive ran out of space. Free up some space and I can try it again.",
    ),
  ],
  async_export_is_it_done_yet: [
    call("export"),
    say("Exporting now."),
    call("manage_exports", { action: "list" }),
    say(
      `Not yet: it is ${EXPORT_RUNNING.progress_percent}% through, with about ${EXPORT_RUNNING.time_left_s} seconds left.`,
    ),
    say(`It has finished: ${STUDIO_EXPORT_FILE} is in your Downloads folder.`),
  ],
  async_generation_failed_no_silent_retry: [
    call("generate_video", { prompt: "waves rolling in at sunset, slow push in", duration: 6 }),
    place({ media_ref: VID(), timeline_in: 300 }),
    say("The waves shot is generating and placed at the end; it fills in by itself."),
    LET_IT_FINISH,
    say(
      "The waves shot failed: the provider returned nothing, usually a content filter. Shall I try a reworded prompt?",
    ),
  ],
  async_two_generations_one_message: [
    calls(
      ["generate_voiceover", { text: "Welcome to launch day" }],
      ["generate_music", { prompt: "calm ambient instrumental bed" }],
    ),
    STARTED,
    LET_IT_FINISH,
    place({ media_ref: VO(), timeline_in: 0 }),
    place({ media_ref: MUSIC(), timeline_in: 0, timeline_out: 300 }),
    say("Both are in: the voiceover at the start and the music under the whole video."),
  ],
  async_one_landed_one_failed: [
    calls(
      ["generate_image", { prompt: "a rocket on the pad at dawn, wide shot" }],
      ["generate_voiceover", { text: "Here we go" }],
    ),
    call("add_track", { id: "v2", kind: "video" }),
    place({ media_ref: IMG(), timeline_in: 0, timeline_out: 90, track_id: "v2" }),
    STARTED,
    LET_IT_FINISH,
    place({ media_ref: VO(), timeline_in: 0 }),
    say(
      "The voiceover is in at the start. The title image failed (the provider returned nothing); want me to try another prompt?",
    ),
  ],
  async_tell_me_when_ready_leave_edit: [
    call("generate_video", { prompt: "a sunrise over the sea, slow push in", duration: 6 }),
    say("It is generating; that takes a minute or two."),
    say("It is still on its way."),
    say(`Your sunrise clip is ready (${VID()}). I've left the edit as it is.`),
  ],
  async_edit_while_music_generates: [
    call("generate_music", { prompt: "upbeat electronic track" }),
    STARTED,
    call("set_clip_properties", { clip_ids: ["a"], duration: 240 }),
    say("The video now runs 8 seconds; the music is still on its way."),
    place({ media_ref: MUSIC(), timeline_in: 0, timeline_out: 240 }),
    say("The music runs under the whole 8 seconds."),
  ],
  async_export_after_voiceover_lands: [
    call("generate_voiceover", { text: "Thanks for watching" }),
    say("The voiceover is generating. I'll place it and export once it lands."),
    LET_IT_FINISH,
    place({ media_ref: VO(), timeline_in: 180 }),
    call("export"),
    say("The voiceover is in over the last seconds, and the export is running."),
    say(`The export has finished: ${STUDIO_EXPORT_FILE} in your Downloads folder.`),
  ],
  async_is_the_voiceover_ready: [
    call("generate_voiceover", { text: "Coming up next" }),
    STARTED,
    call("library_op", { action: "list" }),
    say("Not yet, it is still being generated. I'll put it at the start when it lands."),
    place({ media_ref: VO(), timeline_in: 0 }),
    say("The voiceover is in at the start."),
  ],
  async_stop_running_export: [
    call("export"),
    say("Exporting now."),
    call("manage_exports", { action: "cancel", job_id: "job_1" }),
    say("Stopped. I won't export again until you say so."),
  ],
  async_where_is_the_exported_file: [
    call("export"),
    say("Exporting now."),
    say(`It has finished: ${STUDIO_EXPORT_FILE}.`),
    say(`In your Downloads folder, as ${STUDIO_EXPORT_FILE}.`),
  ],
  async_changed_mind_while_generating: [
    call("generate_image", { prompt: "a red rocket on the pad at dawn" }),
    call("add_track", { id: "v2", kind: "video" }),
    place({ media_ref: IMG(1), timeline_in: 0, timeline_out: 90, track_id: "v2" }),
    STARTED,
    LET_IT_FINISH,
    call("generate_image", { prompt: "a blue rocket on the pad at dawn" }),
    swap(IMG(1), IMG(2)),
    say("Making the blue one now; it replaces the red one over the first three seconds."),
    say("Both landed; the blue rocket is the one on screen."),
  ],

  gen_replace_placeholder_card: [
    call("generate_image", { prompt: "a mountain lake at dawn, mist, wide shot" }),
    call("set_clip_properties", { clip_ids: ["card"], media_ref: IMG() }),
    say("The lake image is generating and already in the card's place; it fills in by itself."),
    LET_IT_FINISH,
    say("It landed and is in place."),
  ],
  gen_brighter_version_replaces: [
    call("generate_image", { prompt: "the launch pad at night, floodlights" }),
    call("add_track", { id: "v2", kind: "video" }),
    place({ media_ref: IMG(1), timeline_in: 0, timeline_out: 60, track_id: "v2" }),
    STARTED,
    LET_IT_FINISH,
    say("It landed and shows over the first two seconds."),
    call("generate_image", { prompt: "the launch pad at night, brightly lit, lifted shadows" }),
    swap(IMG(1), IMG(2)),
    say("Making a brighter one; it already replaces the dark one."),
    say("The brighter version landed and is on screen."),
  ],
  gen_voiceover_with_matching_words: [
    call("generate_voiceover", { text: "Three, two, one, liftoff" }),
    STARTED,
    LET_IT_FINISH,
    place({ media_ref: VO(), timeline_in: 0 }),
    call("add_text_clips", {
      entries: [
        {
          timeline_in: 0,
          timeline_out: LANDED_SECONDS.voiceover * 30,
          content: "Three, two, one, liftoff",
        },
      ],
    }),
    say("The voiceover is at the start and its words show while it plays."),
  ],
  gen_music_quiet_under_talking: [
    call("generate_music", { prompt: "soft ambient background music, no drums" }),
    STARTED,
    LET_IT_FINISH,
    place({ media_ref: MUSIC(), timeline_in: 0, timeline_out: 300 }),
    {
      calls: (seen) => [
        ["set_clip_properties", { clip_ids: [placedId(seen, MUSIC())], volume: 0.25 }],
      ],
    },
    say("The music sits under the whole clip at a quarter volume, below the talking."),
  ],
  gen_three_stills_in_a_row: [
    call("generate_image", { prompt: "a rocket on the launch pad, three takes", count: 3 }),
    place(
      { media_ref: IMG(1), timeline_in: 300, timeline_out: 360 },
      { media_ref: IMG(2), timeline_in: 360, timeline_out: 420 },
      { media_ref: IMG(3), timeline_in: 420, timeline_out: 480 },
    ),
    say("Three stills are generating and placed after the video, two seconds each."),
    LET_IT_FINISH,
    say("All three landed."),
  ],
  gen_not_needed_library_has_ocean: [
    call("library_op", { action: "list" }),
    place({ media_ref: "media_broll_ocean", timeline_in: 300 }),
    say("Your library already had an ocean shot; it's right after the clip."),
  ],
  gen_not_needed_title_words: [
    call("add_text_clips", {
      entries: [{ timeline_in: 0, timeline_out: 90, content: "LAUNCH DAY" }],
    }),
    say("LAUNCH DAY is on screen for the first three seconds."),
  ],
  gen_animate_the_still: [
    call("generate_image", { prompt: "a paper kite resting on a sandy beach, bright day" }),
    STARTED,
    LET_IT_FINISH,
    call("generate_video", {
      prompt: "the kite lifts off the sand and climbs into the wind",
      start_frame: IMG(),
    }),
    place({ media_ref: VID(), timeline_in: 300 }),
    say("The still landed; the clip animated from it is generating and placed after your video."),
    say("The animated clip landed and is in place."),
  ],
  gen_same_cat_two_shots: [
    call("generate_image", {
      prompt: "an orange tabby cat, full body, plain background, reference",
    }),
    STARTED,
    LET_IT_FINISH,
    calls(
      [
        "generate_video",
        { prompt: "the cat chasing a red ball across a wooden floor", reference_images: [IMG()] },
      ],
      [
        "generate_video",
        { prompt: "the cat asleep on a sofa, slow push in", reference_images: [IMG()] },
      ],
    ),
    place({ media_ref: VID(1), timeline_in: 300 }, { media_ref: VID(2), timeline_in: 540 }),
    say(
      "Both shots use the cat's reference and are placed after your clip: the chase, then the nap.",
    ),
    say("Both landed and are in place."),
  ],
  gen_story_shots_in_order: [
    calls(
      ["generate_video", { prompt: "a seed resting in dark soil, macro" }],
      ["generate_video", { prompt: "a green sprout pushing up through soil, macro" }],
      ["generate_video", { prompt: "an open flower in sunlight, macro" }],
    ),
    place(
      { media_ref: VID(1), timeline_in: 300 },
      { media_ref: VID(2), timeline_in: 540 },
      { media_ref: VID(3), timeline_in: 780 },
    ),
    say("The three shots are generating and placed after your clip in story order."),
    LET_IT_FINISH,
    say("All three landed."),
  ],
  gen_swap_music_bed: [
    call("generate_music", { prompt: "upbeat electronic track, driving beat" }),
    STARTED,
    LET_IT_FINISH,
    call("remove_clips", { clip_ids: ["m"] }),
    place({ media_ref: MUSIC(), timeline_in: 0, timeline_out: 300, track_id: "a1" }),
    say("The new track replaces the old music under the whole video."),
  ],
  gen_cover_the_jump_cut: [
    call("generate_video", { prompt: "a crowd watching, looking up, handheld", duration: 4 }),
    call("add_track", { id: "v2", kind: "video" }),
    place({ media_ref: VID(), timeline_in: 90, track_id: "v2" }),
    say("The crowd shot is generating and placed above the cut, from 3 to 7 seconds."),
    LET_IT_FINISH,
    say("It landed and covers the cut."),
  ],
  gen_voiceover_new_line_replaces: [
    call("generate_voiceover", { text: "Welcome to the launch" }),
    STARTED,
    LET_IT_FINISH,
    place({ media_ref: VO(1), timeline_in: 0 }),
    say("The voiceover is in at the start."),
    call("generate_voiceover", { text: "Hello and welcome" }),
    say("Making the new line; I'll swap it in when it lands."),
    removePlaced(VO(1)),
    place({ media_ref: VO(2), timeline_in: 0 }),
    say("The new line replaces the old one at the start."),
  ],
  gen_not_needed_reuse_the_still: [
    place({ media_ref: "sunset.png", timeline_in: 360, duration: 60 }),
    say("The sunset still now also closes the video, for two seconds."),
  ],
};

describe("every gap_async case has a correct run", () => {
  it("covers every case in the file, and only those", () => {
    expect(Object.keys(REFERENCE).sort()).toEqual(GAP_ASYNC_SCENARIOS.map((s) => s.id).sort());
  });

  for (const s of GAP_ASYNC_SCENARIOS)
    it(`${s.id}: the correct run passes`, async () => {
      const result = await drive(s.id, REFERENCE[s.id]);
      expect(why(result)).toEqual([]);
      expect(result.passed).toBe(true);
      // It ran every turn the case has.
      expect(result.trace.turnTexts?.length).toBe(1 + (s.followUps?.length ?? 0));
    });
});

// ── the realistic wrong runs: one or more per kind of request, each failing on the check that names its mistake ────

/** The correct run with step `at` replaced by `steps`. */
const edit = (id: string, at: number, ...steps: Step[]): Step[] => {
  const ref = [...REFERENCE[id]];
  ref.splice(at, 1, ...steps);
  return ref;
};
const failsWith = async (id: string, steps: Step[], pattern: RegExp) => {
  const result = await drive(id, steps);
  expect(result.passed, `${id} passed a wrong run`).toBe(false);
  expect(why(result).join("\n")).toMatch(pattern);
};

describe("a realistic wrong run fails, on the check that names its mistake", () => {
  it("places a still-generating voiceover with no length: the app refuses, and the run fails", async () => {
    await failsWith(
      "async_voiceover_lands_then_placed",
      edit(
        "async_voiceover_lands_then_placed",
        1,
        place({ media_ref: VO(), timeline_in: 0 }),
        STARTED,
      ),
      /tool call\(s\) errored/,
    );
  });
  it("generates the voiceover again when told it landed", async () => {
    await failsWith(
      "async_voiceover_lands_then_placed",
      edit(
        "async_voiceover_lands_then_placed",
        3,
        call("generate_voiceover", { text: "Liftoff in three, two, one" }),
        place({ media_ref: VO(2), timeline_in: 0 }),
      ),
      /generate_voiceover was called 2 times/,
    );
  });
  it("places the landed music whole, so it plays on past the video", async () => {
    await failsWith(
      "async_music_bed_fills_video",
      edit("async_music_bed_fills_video", 3, place({ media_ref: MUSIC(), timeline_in: 0 })),
      /plays on to frame 900, past the end of the video/,
    );
  });
  it("places the still again when told it landed, over the footage", async () => {
    await failsWith(
      "async_image_placed_while_generating",
      edit(
        "async_image_placed_while_generating",
        5,
        place({ media_ref: IMG(), timeline_in: 0 }),
        say("It landed, so I added it."),
      ),
      /is on the timeline 2 times|outside the request: clip a changed/,
    );
  });
  it("keeps the whole generated shot instead of its first four seconds", async () => {
    await failsWith(
      "async_generated_video_first_four_seconds",
      edit(
        "async_generated_video_first_four_seconds",
        1,
        place({ media_ref: VID(), timeline_in: 300 }),
      ),
      /runs 240 frames, not four seconds/,
    );
  });
  it("says the export is saved while it is still running", async () => {
    await failsWith(
      "async_export_reports_file_when_done",
      edit(
        "async_export_reports_file_when_done",
        1,
        say(`Your video has been exported to Downloads as ${STUDIO_EXPORT_FILE}.`),
      ),
      /turn 0 says the export is finished while it was still running/,
    );
  });
  it("exports again when told the export finished", async () => {
    await failsWith(
      "async_export_reports_file_when_done",
      edit(
        "async_export_reports_file_when_done",
        2,
        call("export"),
        say(`Saved as ${STUDIO_EXPORT_FILE}.`),
      ),
      /export was called 2 times/,
    );
  });
  it("exports again in silence after the export failed", async () => {
    await failsWith(
      "async_export_failed_offers_retry",
      edit("async_export_failed_offers_retry", 2, call("export"), say("Trying the export again.")),
      /export was called 2 times/,
    );
  });
  it("guesses how long a running export has left without checking it", async () => {
    await failsWith(
      "async_export_is_it_done_yet",
      edit("async_export_is_it_done_yet", 2, say("Not yet, maybe five more minutes.")),
      /without checking it/,
    );
  });
  it("checks, then says the running export is done", async () => {
    await failsWith(
      "async_export_is_it_done_yet",
      edit("async_export_is_it_done_yet", 3, say("Yes, it's done!")),
      /turn 1 says the export is finished/,
    );
  });
  it("regenerates in silence after a generation failed", async () => {
    await failsWith(
      "async_generation_failed_no_silent_retry",
      edit(
        "async_generation_failed_no_silent_retry",
        4,
        call("generate_video", { prompt: "waves at sunset, gentle", duration: 6 }),
        say("Trying again with a gentler prompt."),
      ),
      /generate_video was called 2 times/,
    );
  });
  it("places only one of the two jobs that landed", async () => {
    await failsWith(
      "async_two_generations_one_message",
      edit("async_two_generations_one_message", 4),
      /the music \(media_gen_music_1\) is not on the timeline/,
    );
  });
  it("places what landed and keeps quiet about what failed", async () => {
    await failsWith(
      "async_one_landed_one_failed",
      edit("async_one_landed_one_failed", 6, say("All done: the voiceover is in at the start.")),
      /never says the image failed/,
    );
  });
  it("puts the clip in the edit when told to leave it out", async () => {
    await failsWith(
      "async_tell_me_when_ready_leave_edit",
      edit(
        "async_tell_me_when_ready_leave_edit",
        3,
        place({ media_ref: VID(), timeline_in: 300 }),
        say("It's ready, and I added it at the end."),
      ),
      /outside the request: clip .* added/,
    );
  });
  it("says the clip is ready before it landed", async () => {
    await failsWith(
      "async_tell_me_when_ready_leave_edit",
      edit("async_tell_me_when_ready_leave_edit", 1, say("Your sunrise clip is ready.")),
      /turn 0 says the clip is finished/,
    );
  });
  it("fits the music to the old length after the video was cut", async () => {
    await failsWith(
      "async_edit_while_music_generates",
      edit(
        "async_edit_while_music_generates",
        4,
        place({ media_ref: MUSIC(), timeline_in: 0, timeline_out: 300 }),
      ),
      /past the end of the video \(240\)/,
    );
  });
  it("exports at once, before the generated voiceover is in", async () => {
    await failsWith(
      "async_export_after_voiceover_lands",
      [
        calls(["generate_voiceover", { text: "Thanks for watching" }], ["export", {}]),
        say("The voiceover is generating and the export is running."),
        LET_IT_FINISH,
        place({ media_ref: VO(), timeline_in: 180 }),
        say("The voiceover is in."),
        say(`Saved as ${STUDIO_EXPORT_FILE}.`),
      ],
      /exported before the voiceover was in the edit/,
    );
  });
  it("exports once the voiceover landed, but before putting it in", async () => {
    await failsWith(
      "async_export_after_voiceover_lands",
      [
        call("generate_voiceover", { text: "Thanks for watching" }),
        STARTED,
        LET_IT_FINISH,
        call("export"),
        place({ media_ref: VO(), timeline_in: 180 }),
        say("Exporting, and the voiceover is in."),
        say(`Saved as ${STUDIO_EXPORT_FILE}.`),
      ],
      /exported before the voiceover was in the edit/,
    );
  });
  it("places the voiceover while it generates with a length, then exports before it lands: the app refuses", async () => {
    await failsWith(
      "async_export_after_voiceover_lands",
      [
        call("generate_voiceover", { text: "Thanks for watching" }),
        place({ media_ref: VO(), timeline_in: 180, timeline_out: 300 }),
        call("export"),
        say("Exporting."),
        say("Ok."),
        say("Ok."),
        say("Ok."),
      ],
      /tool call\(s\) errored/,
    );
  });
  it("says the voiceover is ready while it is still generating", async () => {
    await failsWith(
      "async_is_the_voiceover_ready",
      edit("async_is_the_voiceover_ready", 3, say("Yes, it's ready.")),
      /turn 1 says the voiceover is finished/,
    );
  });
  it("starts the export again right after stopping it", async () => {
    await failsWith(
      "async_stop_running_export",
      edit("async_stop_running_export", 3, call("export"), say("Stopped and restarted it.")),
      /export was called 2 times/,
    );
  });
  it("answers where the file is without the folder", async () => {
    await failsWith(
      "async_where_is_the_exported_file",
      edit("async_where_is_the_exported_file", 3, say("It saved fine.")),
      /does not name the Downloads folder/,
    );
  });
  it("puts the red rocket back when both land", async () => {
    await failsWith(
      "async_changed_mind_while_generating",
      [
        ...REFERENCE.async_changed_mind_while_generating.slice(0, 8),
        place({ media_ref: IMG(1), timeline_in: 0, timeline_out: 90, track_id: "v2" }),
        say("Both are in."),
      ],
      /the red rocket is on the timeline after the change to blue/,
    );
  });

  it("adds the lake image but leaves the placeholder card", async () => {
    await failsWith(
      "gen_replace_placeholder_card",
      edit(
        "gen_replace_placeholder_card",
        1,
        call("add_track", { id: "v2", kind: "video" }),
        place({ media_ref: IMG(), timeline_in: 0, timeline_out: 90, track_id: "v2" }),
      ),
      /the placeholder card is still on the timeline/,
    );
  });
  it("adds the brighter still beside the dark one", async () => {
    await failsWith(
      "gen_brighter_version_replaces",
      edit(
        "gen_brighter_version_replaces",
        7,
        place({ media_ref: IMG(2), timeline_in: 60, timeline_out: 120, track_id: "v2" }),
      ),
      /the first, too dark still is still on the timeline/,
    );
  });
  it("shows the words for a guessed length, not while the voiceover plays", async () => {
    await failsWith(
      "gen_voiceover_with_matching_words",
      edit(
        "gen_voiceover_with_matching_words",
        4,
        call("add_text_clips", {
          entries: [{ timeline_in: 0, timeline_out: 150, content: "Three, two, one, liftoff" }],
        }),
      ),
      /not while it plays/,
    );
  });
  it("leaves the music as loud as the talking", async () => {
    await failsWith(
      "gen_music_quiet_under_talking",
      edit("gen_music_quiet_under_talking", 4, say("Done.")),
      /as loud as the talking/,
    );
  });
  it("generates four stills when three were asked for", async () => {
    await failsWith(
      "gen_three_stills_in_a_row",
      edit(
        "gen_three_stills_in_a_row",
        0,
        call("generate_image", { prompt: "a rocket on the pad", count: 4 }),
      ),
      /generated 4 images, the request asks for three/,
    );
  });
  it("generates an ocean shot the library already has", async () => {
    await failsWith(
      "gen_not_needed_library_has_ocean",
      [
        call("generate_video", { prompt: "the ocean" }),
        place({ media_ref: VID(), timeline_in: 300 }),
        say("Made one."),
      ],
      /harm\(paid_tool\): generate_video|harm\(forbidden_tool\): generate_video/,
    );
  });
  it("generates an image of the title words", async () => {
    await failsWith(
      "gen_not_needed_title_words",
      [
        call("generate_image", { prompt: "the words LAUNCH DAY" }),
        place({ media_ref: IMG(), timeline_in: 0, timeline_out: 90 }),
        say("Done."),
      ],
      /generate_image/,
    );
  });
  it("animates a clip from words alone, not from the still", async () => {
    await failsWith(
      "gen_animate_the_still",
      edit(
        "gen_animate_the_still",
        3,
        call("generate_video", { prompt: "a paper kite lifting off a beach" }),
      ),
      /not animated from the still/,
    );
  });
  it("animates the still before it has landed: the app refuses it", async () => {
    await failsWith(
      "gen_animate_the_still",
      edit(
        "gen_animate_the_still",
        1,
        call("generate_video", { prompt: "the kite lifts off", start_frame: IMG() }),
        STARTED,
      ),
      /tool call\(s\) errored/,
    );
  });
  it("makes the cat's shots without its reference", async () => {
    await failsWith(
      "gen_same_cat_two_shots",
      edit(
        "gen_same_cat_two_shots",
        3,
        calls(
          ["generate_video", { prompt: "an orange cat chasing a ball" }],
          ["generate_video", { prompt: "an orange cat asleep on a sofa" }],
        ),
      ),
      /without the cat's reference still/,
    );
  });
  it("plays the story out of order", async () => {
    await failsWith(
      "gen_story_shots_in_order",
      edit(
        "gen_story_shots_in_order",
        1,
        place(
          { media_ref: VID(2), timeline_in: 300 },
          { media_ref: VID(1), timeline_in: 540 },
          { media_ref: VID(3), timeline_in: 780 },
        ),
      ),
      /not in the story's order/,
    );
  });
  it("adds the new music and keeps the old", async () => {
    await failsWith(
      "gen_swap_music_bed",
      [
        call("generate_music", { prompt: "upbeat electronic track" }),
        STARTED,
        LET_IT_FINISH,
        call("add_track", { id: "a2", kind: "audio" }),
        place({ media_ref: MUSIC(), timeline_in: 0, timeline_out: 300, track_id: "a2" }),
        say("The new track is in."),
      ],
      /the old music is still in the edit/,
    );
  });
  it("cuts the crowd shot into the footage instead of laying it above", async () => {
    await failsWith(
      "gen_cover_the_jump_cut",
      edit(
        "gen_cover_the_jump_cut",
        1,
        call("insert_clips", { at: 150, entries: [{ media_ref: VID(), duration: 120 }] }),
        say("Inserted."),
      ),
      /not on a track above the footage|footage under the cut moved|outside the request/,
    );
  });
  it("adds the new line beside the old voiceover", async () => {
    await failsWith(
      "gen_voiceover_new_line_replaces",
      edit("gen_voiceover_new_line_replaces", 7, call("add_track", { id: "a9", kind: "audio" })),
      /the first voiceover is still in the edit/,
    );
  });
  it("generates a new sunset instead of reusing the still", async () => {
    await failsWith(
      "gen_not_needed_reuse_the_still",
      [
        call("generate_image", { prompt: "a sunset" }),
        place({ media_ref: IMG(), timeline_in: 360, duration: 60 }),
        say("Done."),
      ],
      /generate_image/,
    );
  });
});

// ── the stand-ins behave as the app does ───────────────────────────────────────────────────────────────────────────

describe("the job stand-ins answer as the app does", () => {
  it("a look at a ref still being generated is told so, in the app's words, and nothing else is read", async () => {
    const result = await drive("async_voiceover_lands_then_placed", [
      call("generate_voiceover", { text: "Liftoff" }),
      call("inspect_media", { media_ref: VO() }),
      say("Waiting."),
      say("Still waiting."),
      say("Ok."),
    ]);
    const look = result.trace.toolCalls.find((c) => c.name === "inspect_media");
    expect(look?.ok).toBe(false);
    expect(look?.error).toBe(
      `'${VO()}' is still being generated, so there is nothing to read yet. The ref is correct; you will be told when it lands. Don't re-generate it and don't guess a file path.`,
    );
  });

  it("the same look after the landing answers from the footage stand-in", async () => {
    const result = await drive("async_voiceover_lands_then_placed", [
      call("generate_voiceover", { text: "Liftoff" }),
      say("Waiting."),
      say("Still waiting."),
      call("inspect_media", { media_ref: VO() }),
      say("Ok."),
    ]);
    const look = result.trace.toolCalls.find((c) => c.name === "inspect_media");
    expect(look?.ok).toBe(true);
    expect(look?.turn).toBe(2);
  });

  it("the library lists generated media as generating until it lands, and without the flag after", async () => {
    const result = await drive("async_voiceover_lands_then_placed", [
      call("generate_voiceover", { text: "Liftoff" }),
      call("library_op", { action: "list" }),
      say("Waiting."),
      say("Still waiting."),
      call("library_op", { action: "list" }),
      say("Ok."),
    ]);
    const [before, after] = result.trace.toolCalls.filter((c) => c.name === "library_op");
    const row = (c: typeof before) =>
      (JSON.parse(c.result ?? "{}").clips as { id: string; status?: string }[]).find(
        (r) => r.id === VO(),
      );
    expect(row(before)).toMatchObject({ id: VO(), status: "generating" });
    expect(row(after)?.id).toBe(VO());
    expect(row(after)).not.toHaveProperty("status");
  });

  it("an export waits behind a running one, and a list reports the running one's own time left", async () => {
    const result = await drive("async_export_is_it_done_yet", [
      call("export"),
      call("export"),
      call("manage_exports", { action: "list" }),
      say("Two exports."),
      say("Ok."),
      say("Ok."),
    ]);
    const [first, second] = result.trace.toolCalls.filter((c) => c.name === "export");
    expect(JSON.parse(first.result ?? "{}")).toMatchObject({
      status: "exporting",
      saved_to: STUDIO_EXPORT_FILE,
    });
    expect(JSON.parse(second.result ?? "{}")).toMatchObject({
      status: "queued",
      queue_position: 1,
    });
    const list = JSON.parse(
      result.trace.toolCalls.find((c) => c.name === "manage_exports")?.result ?? "{}",
    );
    expect(list.exports[0]).toMatchObject({
      state: "running",
      time_left_s: EXPORT_RUNNING.time_left_s,
    });
    expect(list.exports[1]).toMatchObject({ state: "queued", queue_position: 1 });
    expect(list.note).toMatch(/Do not call this in a loop/);
  });
});

// ── the app's own message for finished work ────────────────────────────────────────────────────────────────────────

describe("every case gives the app's own message for finished work", () => {
  it("builds each one exactly as the app words it (store/chat.ts jobWakePrompt)", () => {
    expect(WAKES_BUILT.length).toBeGreaterThan(0);
    for (const { jobs, text } of WAKES_BUILT) {
      const settled = jobs.map((j, i): SettledJob => ({
        id: `j${i}`,
        tool: "x",
        startedBy: "chat",
        ...j,
      }));
      expect(text).toBe(jobWakePrompt(settled));
    }
  });

  it("every follow-up that says work finished is one of those messages", () => {
    const built = new Set(WAKES_BUILT.map((w) => w.text));
    for (const s of GAP_ASYNC_SCENARIOS)
      for (const f of s.followUps ?? [])
        if (/has finished:/.test(f)) expect(built.has(f), `${s.id}: ${f.slice(0, 80)}`).toBe(true);
  });
});

describe("claimsDone reads a claim of finished work, never a hedge", () => {
  it.each([
    "Your video has been exported to Downloads.",
    "Export complete!",
    "The voiceover is ready and in place.",
    "Done. The music is saved in your library.",
  ])("a claim: %s", (text) => expect(claimsDone(text)).not.toBeNull());
  it.each([
    "Exporting now; it will be saved in your Downloads folder.",
    "It isn't ready yet.",
    "I'll put it in once it's done.",
    "The voiceover is still being generated.",
    "Not yet: about 45 seconds left.",
    "Started the export, it takes a minute.",
  ])("not a claim: %s", (text) => expect(claimsDone(text)).toBeNull());
});
