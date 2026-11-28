// The gap_context cases (files attached to a message, the timeline changed by hand between turns,
// and @mentions), offline: the real harness, agent loop, tools, stand-ins and oracle, with the
// model's rounds scripted. No network and no model is reached (fetch is a spy that throws).
//
// It holds three things the reference replay (scenarios.reference.test.ts) does not:
//   - each message reaches the model as the APP builds it: the words, plus the attachment list,
//     the editor-context block or the changed-timeline note, from the app's own code;
//   - the person's edit between two turns is made before the turn and is not counted against the
//     agent, while the agent's own collateral still is;
//   - for every kind of request, a plausible WRONG run fails, and for the reason the case names.
import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composeModelText, TIMELINE_CHANGED_NOTE } from "../agent/compose";
import { attachmentsFromUploads } from "../components/chatMedia";
import { buildClipMention } from "../timeline/mentions";
import type { Timeline } from "../timeline/model";
import { validateTimeline } from "../timeline/validate";
import type { InferenceRequest } from "./harness";
import { gradeRun } from "./oracle";
import { driveScripted, type ReferenceCalls, type ReferenceStep } from "./reference";
import { ALL_SCENARIOS } from "./scenarios";
import { GAP_CONTEXT_SCENARIOS } from "./scenarios/gap_context";
import { attachedFiles, composeTurn, gradingBaseline } from "./turns";
import type { Scenario, Trace } from "./types";

const WORK = path.resolve("reports", "eval", `gap-context-${process.pid}`);

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("network blocked in the gap_context eval test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy, "a scripted run reached the network").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(() => fsp.rm(WORK, { recursive: true, force: true }));

const byId = (id: string): Scenario => {
  const s = GAP_CONTEXT_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no case ${id}`);
  return s;
};
const step = (...calls: ReferenceCalls): ReferenceStep => ({ calls });
const say = (text: string): ReferenceStep => ({ text });
const read: ReferenceStep = step(["get_timeline", {}]);
const drive = (id: string, steps: ReferenceStep[]) =>
  driveScripted(byId(id), steps, { workDir: WORK });
const problems = (r: Awaited<ReturnType<typeof drive>>["result"]) => [
  ...(r.harnessError ? [`harness: ${r.harnessError}`] : []),
  ...r.tier0.violations,
  ...r.tier1.violations,
  ...(r.harm?.violations ?? []),
];
/** The user message that started each turn, in order. */
const userTexts = (requests: InferenceRequest[]) =>
  requests.map((r) => r.round_input.user_text).filter((t): t is string => typeof t === "string");
/** A wrong run: it must fail, and say why in words that match `why`. */
async function failsFor(id: string, steps: ReferenceStep[], why: RegExp): Promise<void> {
  const { result } = await drive(id, steps);
  expect(result.harnessError, "a wrong run must reach a verdict").toBeUndefined();
  expect(result.passed, `${id} passed a wrong run`).toBe(false);
  expect(problems(result).join("\n")).toMatch(why);
}

// ── the messages are the app's ──────────────────────────────────────────────

describe("each message reaches the model as the app builds it", () => {
  it("a file linked by the attach button is named by its full path, under its own name", async () => {
    const s = byId("attach_clip_to_end");
    const { requests } = await driveScripted(s, s.reference!, { workDir: WORK });
    // What the composer sends for a desktop attach (lib/upload.ts importFileByReference returns
    // the path as `rel`; components/chatMedia.ts carries it), built here from the app's functions.
    const app = composeModelText(
      s.prompt,
      attachmentsFromUploads([{ rel: "D:/Footage/sunset_drone.mp4", name: "sunset_drone.mp4" }]),
      [],
    );
    expect(userTexts(requests)).toEqual([app]);
    expect(app).toContain("video (sunset_drone.mp4): D:/Footage/sunset_drone.mp4");
  });

  it("a pasted file is named by the library path the library itself reports", async () => {
    const s = byId("attach_logo_top_right");
    const { requests } = await driveScripted(
      s,
      [step(["library_op", { action: "list" }]), say("ok")],
      { workDir: WORK },
    );
    const [sent] = userTexts(requests);
    const rows = requests[1].round_input.tool_results![0].result.clips as {
      filename: string;
      path: string;
    }[];
    const logo = rows.find((r) => r.filename === "brand_logo.png")!;
    expect(logo.path).toBe("library/media_e93b0d5a7c21.png");
    expect(sent).toContain(`image (brand_logo.png): ${logo.path}`);
  });

  it("an attachment rides only the message it was attached to", async () => {
    const s = byId("attach_in_follow_up");
    const { requests } = await driveScripted(s, s.reference!, { workDir: WORK });
    const [first, second] = userTexts(requests);
    expect(first).toBe(s.prompt);
    expect(second).toBe(
      composeModelText(
        s.followUps![0],
        attachmentsFromUploads([
          { rel: "library/media_f0a3e7c2d856.mp4", name: "street_food.mp4" },
        ]),
        [],
      ),
    );
  });

  it("several attachments go in the order they were attached", () => {
    const s = byId("attach_photos_slideshow_in_order");
    const sent = composeTurn(s, 0, s.prompt);
    const names = ["harbour.jpg", "castle.jpg", "market.jpg", "bridge.jpg"];
    const at = names.map((n) => sent.indexOf(`(${n})`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("an @mention is the composer's editor-context block", async () => {
    const s = byId("mention_clip_trim");
    const { requests } = await driveScripted(s, s.reference!, { workDir: WORK });
    const beach = s.seed().tracks[0].clips!.find((c) => c.id === "beach")!;
    expect(userTexts(requests)).toEqual([
      composeModelText(s.prompt, [], [buildClipMention(beach, "v1")]),
    ]);
    expect(userTexts(requests)[0]).toContain("clip beach on track v1: frames [150, 450)");
  });

  it("the message after an edit by hand says so, and the edit is there before the turn", async () => {
    const s = byId("outside_delete_then_close_gaps");
    const { requests, result } = await driveScripted(s, s.reference!, { workDir: WORK });
    expect(result.passed).toBe(true);
    const [first, second] = userTexts(requests);
    expect(first).toBe(s.prompt);
    expect(second).toBe(`${s.followUps![0]}\n\n${TIMELINE_CHANGED_NOTE}`);
    // The read in the first turn saw the kitchen clip; the read that opens the second does not.
    const reads = requests
      .flatMap((r) => r.round_input.tool_results ?? [])
      .filter((r) => r.name === "get_timeline")
      .map((r) => JSON.stringify(r.result));
    expect(reads).toHaveLength(2);
    expect(reads[0]).toContain("kitchen");
    expect(reads[1]).not.toContain("kitchen");
  });

  it("with the app's project read on, that message carries the read instead of the note", async () => {
    vi.stubEnv("ARTDADDY_EVAL_PRELOAD", "1");
    try {
      const s = byId("outside_delete_then_close_gaps");
      const { requests } = await driveScripted(s, s.reference!, { workDir: WORK });
      const second = userTexts(requests)[1];
      expect(second.startsWith(s.followUps![0])).toBe(true);
      expect(second).not.toContain(TIMELINE_CHANGED_NOTE);
      expect(second).toContain("garden");
      expect(second).not.toContain("kitchen");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a case with nothing besides its words sends exactly its words", async () => {
    const s = ALL_SCENARIOS.find((x) => x.id === "remove_last")!;
    const { requests } = await driveScripted(
      s,
      [step(["remove_clips", { clip_ids: ["c"] }]), say("Removed.")],
      { workDir: WORK },
    );
    expect(userTexts(requests)).toEqual([s.prompt]);
  });
});

// ── the person's edit is theirs, the agent's edits are its own ────────────────

describe("an edit by hand between turns", () => {
  it("is not counted against the agent", async () => {
    // Turn 1 does nothing: the gaps stay (a task failure), but the person's deletion is no harm.
    const { result } = await drive("outside_delete_then_close_gaps", [
      read,
      step(["set_clip_properties", { clip_ids: ["ending"], duration: 90 }]),
      say("Done."),
      say("There are no gaps."),
    ]);
    expect(result.tier1.passed).toBe(false);
    expect(result.harm?.violations).toEqual([]);
  });

  it("does not hide the agent's own collateral", async () => {
    const { result } = await drive("outside_delete_then_close_gaps", [
      read,
      step(["set_clip_properties", { clip_ids: ["ending"], duration: 90 }]),
      say("Done."),
      read,
      step(["remove_clips", { clip_ids: ["opening"] }]),
      step(["ripple_delete", { track_id: "v1", start: 0, end: 300 }]),
      say("Closed the gaps."),
    ]);
    expect(result.passed).toBe(false);
    expect((result.harm?.violations ?? []).join("\n")).toMatch(/opening removed/);
  });

  it("that the app refuses stops the run with a harness error, not a verdict", async () => {
    const base = byId("outside_delete_then_close_gaps");
    const broken: Scenario = {
      ...base,
      turnContext: [
        {
          turn: 1,
          editedBefore: {
            what: "dragged a clip on top of another",
            apply: (tl) => {
              tl.tracks[0].clips![1].timeline_in = 0;
              tl.tracks[0].clips![1].timeline_out = 150;
            },
          },
        },
      ],
    };
    const { result } = await driveScripted(broken, base.reference!, { workDir: WORK });
    expect(result.harnessError).toMatch(
      /the person's edit \(dragged a clip on top of another\) failed/,
    );
  });
});

// ── what each case declares holds together ─────────────────────────────────────

describe("each gap_context case is well formed", () => {
  for (const s of GAP_CONTEXT_SCENARIOS) {
    it(s.id, () => {
      const turns = 1 + (s.followUps?.length ?? 0);
      const clips = (s.seed().tracks ?? []).reduce((n, t) => n + (t.clips ?? []).length, 0);
      const tags = s.tags ?? [];
      expect(tags.filter((t) => t.startsWith("gap:")).length, "one gap tag").toBe(1);
      expect(tags).toContain("lang:en");
      expect(tags).toContain(`turns:${turns}`);
      expect(tags).toContain(`clips:${clips}`);
      expect(s.reference?.length, "a correct run").toBeGreaterThan(0);
      for (const c of s.turnContext ?? []) {
        expect(c.turn).toBeGreaterThanOrEqual(0);
        expect(c.turn).toBeLessThan(turns);
        // An edit by hand needs an earlier look for the agent to be wrong about.
        if (c.editedBefore)
          expect(c.turn, "an edit by hand before the first message").toBeGreaterThan(0);
        for (const f of attachedFiles(s, c.turn))
          expect(f.inLibrary, `${f.filename} is attached, so it is in the library`).not.toBe(false);
      }
      // The baseline the agent is graded against is a project the app would accept.
      const baseline: Timeline = gradingBaseline(s, s.seed());
      expect(validateTimeline(baseline)).toEqual([]);
    });
  }

  it("covers both gaps with the kinds the brief names", () => {
    const tagged = (t: string) => GAP_CONTEXT_SCENARIOS.filter((s) => s.tags?.includes(t)).length;
    expect(tagged("gap:attachments")).toBeGreaterThanOrEqual(10);
    expect(tagged("gap:outside-change-mentions")).toBeGreaterThanOrEqual(12);
    expect(GAP_CONTEXT_SCENARIOS.every((s) => ALL_SCENARIOS.includes(s))).toBe(true);
  });
});

// ── a do-nothing run that only TALKS fails the cases whose answer is the job ─────

describe("the reply checks read meaning, not wording", () => {
  const trace = (finalText: string, calls: string[] = []): Trace => ({
    toolCalls: calls.map((name, i) => ({ round: i + 1, name, args: {}, ok: true })),
    reasoning: [],
    rounds: calls.length + 1,
    finalText,
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
  });
  const grade = (id: string, text: string) => {
    const s = byId(id);
    return gradeRun(s, s.seed(), s.seed(), trace(text)).passed;
  };

  it("attach_never_arrived accepts the plain words, in several phrasings, and nothing else", () => {
    for (const ok of [
      "I don't see any attached file in your message. Could you attach it again?",
      "No file came through with that message, so I left the timeline as it is.",
      "Nothing was attached to your message: please try attaching the clip again.",
    ])
      expect(grade("attach_never_arrived", ok), ok).toBe(true);
    for (const bad of ["Done.", "I've put the clip between the two.", "Added it for you."])
      expect(grade("attach_never_arrived", bad), bad).toBe(false);
  });

  it("attach_picture_asked_for_sound needs both: it is a picture, and it has no sound", () => {
    expect(
      grade(
        "attach_picture_asked_for_sound",
        "That file is an image, so it doesn't have any audio.",
      ),
    ).toBe(true);
    expect(grade("attach_picture_asked_for_sound", "The poster is a picture.")).toBe(false);
    expect(grade("attach_picture_asked_for_sound", "Done, the music is in.")).toBe(false);
  });

  it("mention_disagrees_with_words takes a question naming both, and nothing silent", () => {
    expect(
      grade("mention_disagrees_with_words", "Did you mean the drone shot or the city clip?"),
    ).toBe(true);
    expect(grade("mention_disagrees_with_words", "Which one?")).toBe(false);
    expect(grade("mention_disagrees_with_words", "Done.")).toBe(false);
  });

  it("mention_clip_no_longer_exists takes 'it is gone' and refuses a claim", () => {
    expect(
      grade("mention_clip_no_longer_exists", "That clip isn't on the timeline any more."),
    ).toBe(true);
    expect(grade("mention_clip_no_longer_exists", "Sped it up to 2x.")).toBe(false);
  });
});

// ── a plausible wrong run fails every kind ─────────────────────────────────────

describe("a plausible wrong run fails, for the case's own reason", () => {
  const add = (entries: Record<string, unknown>[]) => step(["add_clips", { entries }]);

  it("attach_clip_to_end: the full path the message shows, and the clip put first", async () => {
    await failsFor(
      "attach_clip_to_end",
      [read, add([{ media_ref: "D:/Footage/sunset_drone.mp4", timeline_in: 450 }]), say("Added.")],
      /tool call\(s\) errored/,
    );
    await failsFor(
      "attach_clip_to_end",
      [
        step(["insert_clips", { at: 0, entries: [{ media_ref: "sunset_drone.mp4" }] }]),
        say("Added."),
      ],
      /starts where the video ended/,
    );
  });

  it("attach_photo_as_opener: laid over the video's start, which overwrites it", async () => {
    await failsFor(
      "attach_photo_as_opener",
      [add([{ media_ref: "title_card.png", timeline_in: 0, duration: 90 }]), say("Done.")],
      /a clip of the video is gone|the video starts after the picture/,
    );
    // On a track of its own above the video: the video's first 3 s play hidden under the picture.
    await failsFor(
      "attach_photo_as_opener",
      [
        step(["add_track", { kind: "video" }]),
        {
          calls: (req) => [
            [
              "add_clips",
              {
                entries: [
                  {
                    media_ref: "title_card.png",
                    track_id: String(
                      (req.round_input.tool_results![0].result as { track_id?: string }).track_id,
                    ),
                    timeline_in: 0,
                    duration: 90,
                  },
                ],
              },
            ],
          ],
        },
        say("Done."),
      ],
      /the video starts after the picture/,
    );
  });

  it("attach_logo_top_right: full frame, and over the first clip only", async () => {
    await failsFor(
      "attach_logo_top_right",
      [
        step(["add_track", { kind: "video" }]),
        {
          calls: (req) => [
            [
              "add_clips",
              {
                entries: [
                  {
                    media_ref: "brand_logo.png",
                    track_id: String(
                      (req.round_input.tool_results![0].result as { track_id?: string }).track_id,
                    ),
                    timeline_in: 0,
                    timeline_out: 450,
                  },
                ],
              },
            ],
          ],
        },
        say("Done."),
      ],
      /the logo is not small/,
    );
    await failsFor(
      "attach_logo_top_right",
      [
        step(["add_track", { kind: "video" }]),
        {
          calls: (req) => [
            [
              "add_clips",
              {
                entries: [
                  {
                    media_ref: "brand_logo.png",
                    track_id: String(
                      (req.round_input.tool_results![0].result as { track_id?: string }).track_id,
                    ),
                    timeline_in: 0,
                    timeline_out: 300,
                  },
                ],
              },
            ],
          ],
        },
        say("Done."),
      ],
      /stays to the end of the video/,
    );
  });

  it("attach_song_under_video: the whole 60 s song left running past the video", async () => {
    await failsFor(
      "attach_song_under_video",
      [add([{ media_ref: "calm_piano.mp3", timeline_in: 0 }]), say("Done.")],
      /the song ends with the video/,
    );
  });

  it("attach_photos_slideshow_in_order: the photos sorted by name", async () => {
    const names = ["bridge.jpg", "castle.jpg", "harbour.jpg", "market.jpg"];
    await failsFor(
      "attach_photos_slideshow_in_order",
      [
        add(names.map((n, i) => ({ media_ref: n, timeline_in: i * 60, duration: 60 }))),
        say("Done."),
      ],
      /not in the order attached/,
    );
  });

  it("attach_clip_and_song_together: the song ends where the video ended before the clip", async () => {
    await failsFor(
      "attach_clip_and_song_together",
      [
        add([
          { media_ref: "behind_the_scenes.mp4", timeline_in: 300 },
          { media_ref: "upbeat_loop.mp3", timeline_in: 0, timeline_out: 300 },
        ]),
        say("Done."),
      ],
      /added clip included/,
    );
  });

  it("attach_in_follow_up: the attachment put at the very end", async () => {
    await failsFor(
      "attach_in_follow_up",
      [
        step(["apply_color", { clip_ids: ["beach"], saturation: 0 }]),
        say("Done."),
        add([{ media_ref: "street_food.mp4", timeline_in: 450 }]),
        say("Done."),
      ],
      /right after the first clip/,
    );
  });

  it("attach_never_arrived: another library clip put in, and a claim with no edit", async () => {
    await failsFor(
      "attach_never_arrived",
      [
        step(["insert_clips", { at: 300, entries: [{ media_ref: "old_take.mp4" }] }]),
        say("I put the clip between the two."),
      ],
      /nothing should have been edited/,
    );
    await failsFor(
      "attach_never_arrived",
      [say("Done, it's between the two clips now.")],
      /no attached file came through/,
    );
  });

  it("attach_picture_asked_for_sound: music generated instead, and the poster placed", async () => {
    await failsFor(
      "attach_picture_asked_for_sound",
      [step(["generate_music", { prompt: "jazz with saxophone" }]), say("I made a jazz bed.")],
      /harm\(paid_tool\)|harm\(forbidden_tool\)/,
    );
    await failsFor(
      "attach_picture_asked_for_sound",
      [add([{ media_ref: "concert_poster.jpg", timeline_in: 0, duration: 90 }]), say("Done.")],
      /nothing should have been edited/,
    );
  });

  it("attach_match_picture_shape: a portrait preset guessed without looking", async () => {
    await failsFor(
      "attach_match_picture_shape",
      [step(["set_project_settings", { size: { aspect_ratio: "9:16" } }]), say("Done.")],
      /the picture is 4:5/,
    );
  });

  it("attach_swap_second_clip: the new take added at the end, the old one kept", async () => {
    await failsFor(
      "attach_swap_second_clip",
      [add([{ media_ref: "interview_take2.mp4", timeline_in: 450 }]), say("Done.")],
      /the old take is still on the timeline/,
    );
  });

  it("outside_reorder_then_fade_first: the fade put on the clip that USED to be first", async () => {
    await failsFor(
      "outside_reorder_then_fade_first",
      [
        read,
        step(["apply_color", { clip_ids: ["city"], saturation: 0 }]),
        say("Done."),
        step(["set_clip_properties", { clip_ids: ["intro"], fade: { in: 30 } }]),
        say("Faded in the first clip."),
      ],
      /has no fade-in|old first clip/,
    );
  });

  it("outside_delete_then_close_gaps: the clip the person deleted, removed again from memory", async () => {
    await failsFor(
      "outside_delete_then_close_gaps",
      [
        read,
        step(["set_clip_properties", { clip_ids: ["ending"], duration: 90 }]),
        say("Done."),
        step(["remove_clips", { clip_ids: ["kitchen"] }]),
        say("Closed the gaps."),
      ],
      /tool call\(s\) errored/,
    );
  });

  it("outside_trim_then_music_to_end: the music stretched to the end the video USED to have", async () => {
    await failsFor(
      "outside_trim_then_music_to_end",
      [
        read,
        step(["set_clip_properties", { clip_ids: ["music"], volume: 0.5 }]),
        say("Done."),
        step(["set_clip_properties", { clip_ids: ["music"], duration: 600 }]),
        say("The music ends with the video."),
      ],
      /ends where the video now ends/,
    );
  });

  it("outside_add_then_title_last: the words over the clip that USED to be last", async () => {
    await failsFor(
      "outside_add_then_title_last",
      [
        read,
        step(["set_clip_properties", { clip_ids: ["intro"], flip: { h: true } }]),
        say("Done."),
        step([
          "add_text_clips",
          { entries: [{ timeline_in: 150, timeline_out: 300, content: "Thanks for watching" }] },
        ]),
        say("Done."),
      ],
      /the words start with the last clip/,
    );
  });

  it("outside_split_then_remove_piece: the whole first clip deleted, as it was before the split", async () => {
    await failsFor(
      "outside_split_then_remove_piece",
      [
        read,
        step(["apply_color", { clip_ids: ["beach"], exposure: 0.3 }]),
        say("Done."),
        step(["ripple_delete", { track_id: "v1", start: 0, end: 300 }]),
        say("Deleted the piece."),
      ],
      /the first clip itself was deleted|talk removed/,
    );
  });

  it("mention_clip_trim: the first clip trimmed instead of the mentioned one", async () => {
    await failsFor(
      "mention_clip_trim",
      [step(["set_clip_properties", { clip_ids: ["intro"], duration: 120 }]), say("Done.")],
      /the mentioned clip is 4 s/,
    );
  });

  it("mention_range_cut_across_clips: only the part inside the first clip cut", async () => {
    await failsFor(
      "mention_range_cut_across_clips",
      [step(["ripple_delete", { track_id: "v1", start: 240, end: 300 }]), say("Done.")],
      /lost its first 2 s/,
    );
  });

  it("mention_gap_close_one: every gap closed, not the one pointed at", async () => {
    await failsFor(
      "mention_gap_close_one",
      [
        step([
          "ripple_delete",
          {
            track_id: "v1",
            ranges: [
              { start: 150, end: 240 },
              { start: 390, end: 450 },
            ],
          },
        ]),
        say("Done."),
      ],
      /the other gap/,
    );
  });

  it("mention_playhead_split: split in the middle instead of at the playhead", async () => {
    await failsFor(
      "mention_playhead_split",
      [step(["split_clips", { splits: [{ clip_id: "talk", at: 150 }] }]), say("Done.")],
      /the cut is at the playhead/,
    );
  });

  it("mention_library_item_add: another library clip added", async () => {
    await failsFor(
      "mention_library_item_add",
      [add([{ media_ref: "city_night.mp4", timeline_in: 300 }]), say("Done.")],
      /a different library clip was added/,
    );
  });

  it("mention_disagrees_with_words: one deleted silently, and both deleted", async () => {
    await failsFor(
      "mention_disagrees_with_words",
      [step(["remove_clips", { clip_ids: ["drone"] }]), say("Deleted the drone shot.")],
      /without saying that the city clip/,
    );
    await failsFor(
      "mention_disagrees_with_words",
      [step(["remove_clips", { clip_ids: ["drone", "city"] }]), say("Deleted them.")],
      /deleted both/,
    );
  });

  it("mention_stale_position: split where the mention said the clip was", async () => {
    await failsFor(
      "mention_stale_position",
      [step(["split_clips", { splits: [{ clip_id: "talk", at: 150 }] }]), say("Done.")],
      /tool call\(s\) errored|in 2 pieces/,
    );
  });

  it("mention_clip_no_longer_exists: the clip now at those frames sped up instead", async () => {
    await failsFor(
      "mention_clip_no_longer_exists",
      [step(["set_clip_properties", { clip_ids: ["city"], speed: 2 }]), say("Sped it up.")],
      /nothing should have been edited/,
    );
  });
});
