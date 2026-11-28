// The complaint cases (scenarios/gap_complaints.ts), offline. scenarios.reference.test.ts replays
// each case's correct run; this file shows, for each kind of complaint, the plausible wrong answers
// that must fail through the same real harness (agent loop, tools, stand-ins, oracle), with the
// model's rounds scripted: the "fix" that is only a claim, the fix aimed at the cause the person
// blamed, the workaround that loses something, and the doubled or repeated edit. It also shows
// other right answers passing, so no check holds a case to one route. No network and no model is
// reached: fetch is a spy that throws, and every test checks it was never called.
import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InferenceRequest } from "./harness";
import { driveScripted, type ReferenceCalls, type ReferenceStep } from "./reference";
import { ALL_SCENARIOS } from "./scenarios";
import { COMPLAINT_SCENARIOS } from "./scenarios/gap_complaints";
import type { Scenario, ScenarioResult } from "./types";

type Calls = ReferenceCalls;
type Step = ReferenceStep;

const WORK = path.resolve("reports", "eval", `complaints-${process.pid}`);

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

/** A complaint case, with the correct run every one of them carries. */
const byId = (id: string): Scenario & { reference: ReferenceStep[] } => {
  const s = COMPLAINT_SCENARIOS.find((c) => c.id === id);
  if (!s?.reference) throw new Error(`no complaint case ${id} with a reference`);
  return s as Scenario & { reference: ReferenceStep[] };
};

async function drive(id: string, steps: readonly Step[]): Promise<ScenarioResult> {
  return (await driveScripted(byId(id), steps, { workDir: WORK })).result;
}

/** Why the run failed: every tier's and every check's violations. */
const violations = (r: ScenarioResult): string[] => [
  ...(r.harnessError ? [`harness: ${r.harnessError}`] : []),
  ...r.tier0.violations,
  ...r.tier1.violations,
  ...(r.harm?.violations ?? []),
];

/** The violations, and what each refused call was told. */
const why = (r: ScenarioResult): string[] => [
  ...violations(r),
  ...r.trace.toolCalls.filter((c) => !c.ok).map((c) => `refused ${c.name}: ${c.error}`),
];

/** The case's correct run up to the end of its first turn (the request), and its follow-up. */
function firstTurn(id: string): Step[] {
  const ref = byId(id).reference;
  const end = ref.findIndex((s) => "text" in s);
  return ref.slice(0, end + 1);
}

/** The case's correct first turn, then `second` as the answer to the complaint. */
const withAnswer = (id: string, second: Step[]): Promise<ScenarioResult> =>
  drive(id, [...firstTurn(id), ...second]);

/** A run must fail, for the reason named. */
async function rejects(run: Promise<ScenarioResult>, reason: RegExp): Promise<void> {
  const r = await run;
  expect(r.harnessError).toBeUndefined();
  expect(r.passed).toBe(false);
  expect(why(r).join("\n")).toMatch(reason);
}

/** A run must pass. */
async function accepts(run: Promise<ScenarioResult>): Promise<void> {
  const r = await run;
  expect(violations(r)).toEqual([]);
  expect(r.passed).toBe(true);
}

const call = (name: string, args: Record<string, unknown> = {}): Step => ({
  calls: [[name, args]],
});
const say = (text: string): Step => ({ text });
const READ = call("get_timeline");

/** A call made with the id of the first text clip a get_timeline in the round before found. */
const onTitle =
  (make: (id: string) => Calls) =>
  (req: InferenceRequest): Calls => {
    const read = (req.round_input.tool_results ?? []).find((r) => r.name === "get_timeline");
    const tracks = ((read?.result as { timeline?: { tracks?: unknown[] } })?.timeline?.tracks ??
      []) as { clips?: { id: string; kind?: string }[] }[];
    const title = tracks.flatMap((t) => t.clips ?? []).find((c) => c.kind === "text");
    return make(String(title?.id));
  };

describe("the complaint cases are registered and well formed", () => {
  it("are all in the main lane, each with its tags and a correct run that spans both turns", () => {
    const ids = new Set(ALL_SCENARIOS.map((s) => s.id));
    expect(COMPLAINT_SCENARIOS.length).toBeGreaterThanOrEqual(15);
    for (const s of COMPLAINT_SCENARIOS) {
      expect(ids.has(s.id), s.id).toBe(true);
      expect(s.tags).toEqual(
        expect.arrayContaining([
          "gap:complaints",
          "lang:en",
          "turns:2",
          expect.stringMatching(/^clips:\d+$/),
        ]),
      );
      expect(s.followUps, s.id).toHaveLength(1);
      const reference = byId(s.id).reference;
      const replies = reference.filter((x) => "text" in x).length;
      expect(replies, `${s.id}: one reply per turn`).toBe(2);
      expect("text" in reference[reference.length - 1], s.id).toBe(true);
    }
  });
});

describe("a right complaint is answered only by removing its real cause", () => {
  it("no sound after a trim: undoing the blamed trim, boosting the voice or just saying so fail", async () => {
    const id = "complaint_silent_after_trim";
    await rejects(withAnswer(id, [call("undo"), say("Undid the trim.")]), /ends \(8 s\)/);
    await rejects(
      withAnswer(id, [
        call("set_clip_properties", { clip_ids: ["talkAud"], volume: 2 }),
        say("Turned the voice up."),
      ]),
      /voice still makes no sound/,
    );
    await rejects(
      withAnswer(id, [say("Fixed the audio, it plays now.")]),
      /voice still makes no sound/,
    );
    // Unmuting is the fix; turning the voice up on top of it changes what nobody asked to change.
    await rejects(
      withAnswer(id, [
        call("set_track", { track_id: "a1", mute: false }),
        call("set_clip_properties", { clip_ids: ["talkAud"], volume: 2 }),
        say("Unmuted it and turned the voice up."),
      ]),
      /the voice, apart from its end, was changed/,
    );
  });

  it("black picture: blaming the title, brightening the footage or placing it again fail", async () => {
    const id = "complaint_black_hidden_track";
    await rejects(
      withAnswer(id, [
        READ,
        { calls: onTitle((t) => [["remove_clips", { clip_ids: [t] }]]) },
        say("Removed the title."),
      ]),
      /expected one title, found 0/,
    );
    await rejects(
      withAnswer(id, [
        call("apply_color", { clip_ids: ["a"], exposure: 1 }),
        say("Brightened it."),
      ]),
      /the footage was changed/,
    );
    // A second copy of the footage on a new track shows a picture and leaves the hidden track.
    const placedAgain = await withAnswer(id, [
      call("add_track", { kind: "video", id: "v2" }),
      call("add_clips", {
        entries: [{ media_ref: "a.mp4", track_id: "v2", timeline_in: 0, with_audio: false }],
      }),
      say("Put the footage back."),
    ]);
    expect(placedAgain.passed).toBe(false);
    expect(why(placedAgain).join("\n")).toMatch(/still not drawn/);
    expect(why(placedAgain).join("\n")).toMatch(/outside the request: clip .* added \(video/);
  });

  it("black picture: moving the footage to a track that draws is as good as unhiding its own", async () => {
    await accepts(
      withAnswer("complaint_black_hidden_track", [
        call("move_clips", { moves: [{ clip_id: "a", to_track: "v2" }] }),
        say("Its track was hidden; I moved the footage onto a visible track."),
      ]),
    );
  });

  it("an unseen logo: making it bigger still, see-through footage or hiding the footage fail", async () => {
    const id = "complaint_logo_under_footage";
    const bigger = call("set_clip_properties", {
      clip_ids: ["logo"],
      transform: { position: { x: 0.82, y: 0.1 }, scale: 0.5 },
    });
    await rejects(withAnswer(id, [bigger, say("Made it bigger still.")]), /still drawn underneath/);
    await rejects(
      withAnswer(id, [
        call("set_clip_properties", { clip_ids: ["a"], opacity: 0.4 }),
        say("Done."),
      ]),
      /the footage was changed/,
    );
    await rejects(
      withAnswer(id, [call("set_track", { track_id: "v1", hidden: true }), say("Done.")]),
      /footage no longer shows/,
    );
  });

  it("an unseen logo: moving the logo to a new track on top is as good as restacking", async () => {
    await accepts(
      withAnswer("complaint_logo_under_footage", [
        call("move_clips", { moves: [{ clip_id: "logo", to_track: "v3" }] }),
        call("set_track", { track_id: "v3", z: 5 }),
        say("The logo was under the footage; it is on its own top track now."),
      ]),
    );
  });

  it("a sideways picture: half a turn, a vertical canvas or a mirror fail", async () => {
    const id = "complaint_video_sideways";
    await rejects(
      withAnswer(id, [call("set_clip_properties", { clip_ids: ["a"], rotate: 180 }), say("Done.")]),
      /still turned \(rotate 180\)/,
    );
    const canvas = await withAnswer(id, [
      call("set_project_settings", { size: { width: 1080, height: 1920 }, fps: null }),
      say("Made the frame vertical to fit it."),
    ]);
    expect(canvas.passed).toBe(false);
    expect(why(canvas).join("\n")).toMatch(/still turned \(rotate 90\)/);
    expect(why(canvas).join("\n")).toMatch(/outside the request: canvas/);
    await rejects(
      withAnswer(id, [
        call("set_clip_properties", { clip_ids: ["a"], flip: { h: true } }),
        say("Done."),
      ]),
      /still turned/,
    );
  });

  it("a sideways picture: a fade-in drawn as an opacity ramp counts as the fade-in", async () => {
    await accepts(
      drive("complaint_video_sideways", [
        READ,
        call("set_keyframes", {
          clip_id: "a",
          property: "opacity",
          keyframes: [
            { t: 0, v: 0 },
            { t: 30, v: 1 },
          ],
        }),
        say("It fades in over the first second."),
        call("set_clip_properties", { clip_ids: ["a"], rotate: 0 }),
        say("It had an extra quarter turn set on it; it is upright now."),
      ]),
    );
  });

  it("a late voice: moving the picture, moving the sound the wrong way or saying so fail", async () => {
    const id = "complaint_voice_late";
    await rejects(
      withAnswer(id, [
        call("move_clips", { moves: [{ clip_id: "talk", to_timeline_in: 9 }] }),
        say("Done."),
      ]),
      /where the picture starts/,
    );
    await rejects(
      withAnswer(id, [
        call("move_clips", { moves: [{ clip_id: "talkAud", to_timeline_in: 18 }] }),
        say("Done."),
      ]),
      /offset from its picture/,
    );
    await rejects(withAnswer(id, [say("They are in sync now.")]), /offset from its picture/);
  });

  it("an intro twice: a gap left, the crossfade blamed, or a bare claim fail", async () => {
    const id = "complaint_intro_plays_twice";
    await rejects(
      withAnswer(id, [call("remove_clips", { clip_ids: ["intro2"] }), say("Removed the copy.")]),
      /gap is left/,
    );
    await rejects(
      withAnswer(id, [
        call("set_transition", { clip_id: "main", transition_in: null }),
        say("Removed the crossfade."),
      ]),
      /on the timeline 2 times/,
    );
    await rejects(withAnswer(id, [say("Removed the second intro.")]), /on the timeline 2 times/);
  });

  it("an intro twice: dropping the first copy and closing up passes too", async () => {
    await accepts(
      withAnswer("complaint_intro_plays_twice", [
        call("ripple_delete", { track_id: "v1", start: 0, end: 90 }),
        say("The intro was in twice; I removed one copy and closed the gap."),
      ]),
    );
  });

  it("a misspelled title: a second title, or the fix at the old size, fail", async () => {
    const id = "complaint_title_misspelled";
    await rejects(
      withAnswer(id, [
        call("add_text_clips", {
          entries: [
            { timeline_in: 0, timeline_out: 90, content: "Summer Trip 2026", style: { size: "l" } },
          ],
        }),
        say("Added the right spelling."),
      ]),
      /expected one title, found 2/,
    );
    await rejects(
      withAnswer(id, [
        call("update_text", {
          clip_ids: ["title"],
          content: "Summer Trip 2026",
          style: { size: "m" },
        }),
        say("Fixed the spelling."),
      ]),
      /no bigger than before/,
    );
    await rejects(withAnswer(id, [say("Fixed the spelling.")]), /reads "Sumer Trip 2026"/);
  });
});

describe("a complaint about the agent's own first turn is checked, then fixed or explained", () => {
  it("a gap after a delete: claiming it closed, slowing a neighbour to fill it or deleting more fail", async () => {
    const id = "complaint_gap_after_delete";
    await rejects(withAnswer(id, [say("Closed the gap.")]), /still a gap/);
    await rejects(
      withAnswer(id, [
        call("set_clip_properties", { clip_ids: ["a"], speed: 0.5 }),
        say("Filled it."),
      ]),
      /outside the request: clip a changed/,
    );
    await rejects(
      withAnswer(id, [call("remove_clips", { clip_ids: ["c"] }), say("Done.")]),
      /found \["a"\]/,
    );
  });

  it("a gap after a delete: a first turn that closed up, and a reply that says so, passes", async () => {
    await accepts(
      drive("complaint_gap_after_delete", [
        READ,
        call("ripple_delete", { track_id: "v1", start: 120, end: 240 }),
        say("Deleted the second clip and closed up behind it."),
        READ,
        say("There is no gap: the third clip starts right where the first ends, at 4 seconds."),
      ]),
    );
  });

  it("the wrong shot graded: leaving the first grey, or grading every shot, fail", async () => {
    const id = "complaint_wrong_clip_graded";
    await rejects(
      withAnswer(id, [call("apply_color", { clip_ids: ["forest"], saturation: 0 }), say("Done.")]),
      /city shot is not back in colour \(saturation 0\)/,
    );
    await rejects(
      withAnswer(id, [
        call("apply_color", { clip_ids: ["beach", "forest"], saturation: 0 }),
        call("apply_color", { clip_ids: ["city"], saturation: 1 }),
        say("Done."),
      ]),
      /outside the request: clip beach changed: color/,
    );
    await rejects(withAnswer(id, [say("Switched them.")]), /forest shot is not black and white/);
  });

  it("a disliked look: taking back only part of it, or never making one, fail", async () => {
    const id = "complaint_undo_the_look";
    await rejects(
      withAnswer(id, [call("undo"), say("Put it back.")]),
      /not back the way it was: clip a changed: color; clip b changed: color/,
    );
    await rejects(
      withAnswer(id, [
        call("apply_color", { clip_ids: ["a", "b"], reset: true }),
        say("Put it back."),
      ]),
      /not back the way it was: clip b changed: transition_in/,
    );
    await rejects(
      drive(id, [READ, say("What do you mean by cinematic?"), say("There was nothing to undo.")]),
      /no look was ever applied/,
    );
  });

  it("a disliked look: taken back by hand, leaving only an empty track, passes", async () => {
    await accepts(
      drive("complaint_undo_the_look", [
        READ,
        call("add_track", { kind: "video", id: "bars" }),
        call("apply_color", { clip_ids: ["a", "b"], contrast: 1.3, saturation: 0.8 }),
        say("Graded both shots for a filmic look."),
        call("apply_color", { clip_ids: ["a", "b"], reset: true }),
        say("Removed the grade; the shots are as they were."),
      ]),
    );
  });

  it("a disliked look: a revert that keeps a title the look added fails", async () => {
    await rejects(
      drive("complaint_undo_the_look", [
        READ,
        call("apply_color", { clip_ids: ["a", "b"], contrast: 1.3, saturation: 0.8 }),
        call("add_text_clips", {
          entries: [{ timeline_in: 0, timeline_out: 60, content: "A FILM" }],
        }),
        say("Graded both shots and opened on a title card."),
        call("apply_color", { clip_ids: ["a", "b"], reset: true }),
        say("Put it back the way it was."),
      ]),
      /not back the way it was: .*clip \S+ added \(text/,
    );
  });
});

describe("a mistaken complaint changes nothing that was right", () => {
  it("'nothing happened': cutting again, undoing, or rewriting the file fail", async () => {
    const id = "complaint_library_still_long";
    await rejects(
      withAnswer(id, [
        call("set_clip_properties", { clip_ids: ["a"], source_in: 120, duration: 120 }),
        say("Cut the first four seconds."),
      ]),
      /first frame/,
    );
    await rejects(
      withAnswer(id, [call("undo"), say("Let me redo that.")]),
      /length \(four seconds\)/,
    );
    await rejects(
      withAnswer(id, [
        call("run_ffmpeg", { command: "-i a.mp4 -t 4 -c copy a_cut.mp4" }),
        say("Cut the file itself."),
      ]),
      /run_ffmpeg called 1x: this case must not call it/,
    );
    await rejects(
      withAnswer(id, [call("export", {}), say("Exported the 4 second version.")]),
      /export called 1x: this case must not call it/,
    );
  });

  it("'the export failed': exporting again, answering unchecked, or calling it done fail", async () => {
    const id = "complaint_export_not_failed";
    await rejects(
      withAnswer(id, [call("export", {}), say("Exporting it again.")]),
      /exported 2 times/,
    );
    await rejects(
      withAnswer(id, [say("It is still exporting, give it a minute.")]),
      /without checking the export/,
    );
    await rejects(
      withAnswer(id, [
        call("manage_exports", { action: "list" }),
        say("I checked: your export finished and is saved in Downloads as My project.mp4."),
      ]),
      /does not say the export is still running/,
    );
    await rejects(
      withAnswer(id, [
        call("manage_exports", { action: "cancel", job_id: "job_1" }),
        call("export", {}),
        say("Restarted it."),
      ]),
      /exported 2 times|cancelled the export/,
    );
  });

  it("'the export failed': any wording that says it has not finished passes", async () => {
    for (const reply of [
      "It hasn't finished yet, which is why Downloads is empty.",
      "Nothing failed. The render is not done yet; the file shows up when it is.",
      "It's still going. I'll leave it running.",
      "It's in the queue and hasn\u2019t completed, so there is no file yet.",
    ])
      await accepts(
        withAnswer("complaint_export_not_failed", [
          call("manage_exports", { action: "list" }),
          say(reply),
        ]),
      );
  });

  it("'no sound at all': boosting the voice, undoing the music change or adding a filter fail", async () => {
    const id = "complaint_no_sound_but_there_is";
    await rejects(
      withAnswer(id, [
        call("set_clip_properties", { clip_ids: ["talkAud"], volume: 2 }),
        say("Louder now."),
      ]),
      /outside the request: clip talkAud changed: volume/,
    );
    await rejects(withAnswer(id, [call("undo"), say("Put the music back.")]), /not turned down/);
    await rejects(
      withAnswer(id, [
        call("apply_effects", { clip_ids: ["talkAud"], add: [{ type: "loudnorm" }] }),
        say("Normalised the voice."),
      ]),
      /outside the request: clip talkAud changed: audio_effects/,
    );
  });

  it("'no sound at all': re-stating both tracks as unmuted changes nothing and passes", async () => {
    await accepts(
      withAnswer("complaint_no_sound_but_there_is", [
        call("set_tracks", {
          tracks: [
            { track_id: "a1", mute: false },
            { track_id: "a2", mute: false },
          ],
        }),
        say("Nothing was muted; both tracks play. Check your speaker volume."),
      ]),
    );
  });

  it("'you didn't add the title': a second title, a removed title, or one left past the cut fail", async () => {
    const id = "complaint_title_not_added";
    await rejects(
      withAnswer(id, [
        call("add_text_clips", {
          entries: [{ timeline_in: 0, timeline_out: 150, content: "Ocean" }],
        }),
        say("Added the title."),
      ]),
      /expected one title, found 2/,
    );
    await rejects(
      withAnswer(id, [
        READ,
        { calls: onTitle((t) => [["remove_clips", { clip_ids: [t] }]]) },
        say("Done."),
      ]),
      /expected one title, found 0/,
    );
    await rejects(
      drive(id, [
        READ,
        call("add_text_clips", {
          entries: [{ timeline_in: 0, timeline_out: 300, content: "Ocean" }],
        }),
        call("set_clip_properties", { clip_ids: ["a"], duration: 150 }),
        say("Done."),
        READ,
        say("The title is there."),
      ]),
      /runs on past the clip/,
    );
  });

  it("'you didn't add the title': a first turn that forgot it, put right on the complaint, passes", async () => {
    await accepts(
      drive("complaint_title_not_added", [
        READ,
        call("set_clip_properties", { clip_ids: ["a"], duration: 150 }),
        say("Cut it to five seconds."),
        READ,
        call("add_text_clips", {
          entries: [{ timeline_in: 0, timeline_out: 150, content: "Ocean" }],
        }),
        say("You're right, I missed it. 'Ocean' is on the clip now."),
      ]),
    );
  });
});

describe("what the agent cannot change is explained, not worked around", () => {
  const id = "complaint_voice_drowned_by_solo";

  it("muting the music, rebuilding its track, boosting the voice or a reply with no cause fail", async () => {
    await rejects(
      withAnswer(id, [
        call("set_track", { track_id: "a2", mute: true }),
        say("Muted the music so you hear the voice."),
      ]),
      /music no longer plays/,
    );
    await rejects(
      withAnswer(id, [
        call("remove_tracks", { track_ids: ["a2"] }),
        call("add_clips", {
          entries: [{ media_ref: "music.mp3", timeline_in: 0, timeline_out: 300 }],
        }),
        say("Rebuilt the music track."),
      ]),
      /outside the request: clip music removed/,
    );
    await rejects(
      withAnswer(id, [
        call("set_clip_properties", { clip_ids: ["talkAud"], volume: 2 }),
        say("Turned the voice up."),
      ]),
      /outside the request: clip talkAud changed: volume/,
    );
    await rejects(
      withAnswer(id, [READ, say("Fixed the audio balance.")]),
      /does not say the music track is soloed/,
    );
    // Moving the music off the soloed track makes both heard by dodging the person's own switch.
    await rejects(
      withAnswer(id, [
        call("move_clips", { moves: [{ clip_id: "music", to_track: "a3" }] }),
        say("The music track was soloed, so I moved the music to a new track; you hear both now."),
      ]),
      /outside the request: track a3 added/,
    );
  });

  it("one refused try at switching solo off, then the explanation, passes; a second refusal fails", async () => {
    const tried = call("set_track", { track_id: "a2", solo: false });
    await accepts(
      withAnswer(id, [
        tried,
        say("The music track is soloed and I can't switch solo off: click its solo button."),
      ]),
    );
    await rejects(
      withAnswer(id, [tried, tried, say("The music track is soloed; click its solo button.")]),
      /2 tool call\(s\) errored \(budget 1\)/,
    );
  });
});
