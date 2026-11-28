// The follow-up cases, offline: each case's correct run (its `reference`) is replayed through the
// real harness (the real agent loop, timeline tools, stand-ins and oracle) with every model round
// answered from a script, and must pass; then realistic WRONG runs, the mistakes a model makes on
// a follow-up (the old clip left changed, an undo too many, "keep going" redoing the done part, a
// standing rule forgotten by the fifth turn), must each fail on the rule they break. No network
// and no model is reached: fetch is a spy that throws, and every test checks it was never called.
import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Timeline } from "../timeline/model";
import { ClientToolRegistry } from "../tools/registry";
import { stageFaults } from "./faults";
import { driveScripted, type ReferenceCalls, type ReferenceStep } from "./reference";
import { ALL_SCENARIOS } from "./scenarios";
import { GAP_FOLLOWUPS, timelineRead, type FollowupCase } from "./scenarios/gap_followups";

const WORK = path.resolve("reports", "eval", `followups-${process.pid}`);

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("network blocked in the follow-up eval test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy, "the scripted harness reached the network").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(() => fsp.rm(WORK, { recursive: true, force: true }));

const drive = (scenario: FollowupCase, steps: readonly ReferenceStep[]) =>
  driveScripted(scenario, steps, { workDir: WORK });

const byId = (id: string): FollowupCase => {
  const hit = GAP_FOLLOWUPS.find((s) => s.id === id);
  if (!hit) throw new Error(`no follow-up case ${id}`);
  return hit;
};
const turnsOf = (s: FollowupCase): number => 1 + (s.followUps?.length ?? 0);
/** Replies a run gives: one per turn, except a turn the person stopped. */
const repliesOf = (s: FollowupCase): number => turnsOf(s) - (s.stopAfter ? 1 : 0);
const say = (text: string): ReferenceStep => ({ text });
const call = (name: string, args: Record<string, unknown>): ReferenceStep => ({
  calls: [[name, args]],
});
const read: ReferenceStep = { calls: [["get_timeline", {}]] };
const onRead = (f: (tl: Timeline) => ReferenceCalls): ReferenceStep => ({
  calls: (req) => f(timelineRead(req)),
});
const idOf = (tl: Timeline, pick: (c: Record<string, unknown>) => boolean): string => {
  const hit = (tl.tracks ?? [])
    .flatMap((t) => t.clips ?? [])
    .find((c) => pick(c as unknown as Record<string, unknown>));
  if (!hit) throw new Error("no such clip in the project read");
  return String(hit.id);
};
const reads = (want: string) => (c: Record<string, unknown>) =>
  JSON.stringify(c.content ?? "")
    .toLowerCase()
    .includes(want.toLowerCase());

describe("every follow-up case is declared for the lanes that run it", () => {
  it("is registered in the main lane", () => {
    const main = new Set(ALL_SCENARIOS.map((s) => s.id));
    for (const s of GAP_FOLLOWUPS) expect(main.has(s.id), s.id).toBe(true);
    expect(new Set(GAP_FOLLOWUPS.map((s) => s.id)).size).toBe(GAP_FOLLOWUPS.length);
  });

  for (const s of GAP_FOLLOWUPS)
    it(`${s.id}: its tags match its seed and turns, and its correct run ends every turn`, () => {
      const tags = s.tags ?? [];
      const clips = (s.seed().tracks ?? []).reduce((n, t) => n + (t.clips ?? []).length, 0);
      expect(tags).toContain("gap:followups");
      expect(tags).toContain(`turns:${turnsOf(s)}`);
      expect(tags).toContain(`clips:${clips}`);
      expect(tags.some((t) => /^lang:[a-z]{2}$/.test(t))).toBe(true);
      expect(tags.some((t) => t.startsWith("followup:"))).toBe(true);
      // One reply per turn (a stopped turn has none), and the last step is the last turn's reply.
      expect(s.reference.filter((step) => "text" in step)).toHaveLength(repliesOf(s));
      expect("text" in s.reference[s.reference.length - 1]).toBe(true);
      // A case the Copilot lane cannot run says why; only a stop needs that here.
      expect(Boolean(s.inAppOnly)).toBe(Boolean(s.stopAfter));
    });
});

describe("every follow-up case's correct run passes through the real harness", () => {
  for (const s of GAP_FOLLOWUPS)
    it(s.id, async () => {
      const { result, requests } = await drive(s, s.reference);
      expect(result.harnessError).toBeUndefined();
      expect(result.tier0.violations).toEqual([]);
      expect([...result.tier1.violations, ...(result.harm?.violations ?? [])]).toEqual([]);
      expect(result.passed).toBe(true);
      // The script ran to its end, one round per step, and every turn got its reply.
      expect(requests).toHaveLength(s.reference.length);
      expect(result.trace.turnTexts).toHaveLength(turnsOf(s));
      const replies = (result.trace.turnTexts ?? []).filter((t) => t.trim().length > 0);
      expect(replies).toHaveLength(repliesOf(s));
    });
});

describe("a staged failure (Scenario.faults) answers for the tool, then lets it run", () => {
  const blocked = (a: Record<string, unknown>) => ({ ok: false, query: a.query, error: "blocked" });

  it("the first calls get the fault's reply without running the tool; later calls run it", async () => {
    const registry = new ClientToolRegistry();
    const ran: unknown[] = [];
    registry.register("web_search", async (a) => {
      ran.push(a.query);
      return { ok: true, query: a.query };
    });
    registry.register("get_timeline", async () => ({ ok: true, timeline: null }));
    stageFaults(registry, [{ tool: "web_search", times: 2, reply: blocked }]);
    // Two calls in one round take the two staged failures: counted as each call starts.
    const both = await Promise.all([
      registry.run("web_search", { query: "one" }),
      registry.run("web_search", { query: "two" }),
    ]);
    expect(both).toEqual([blocked({ query: "one" }), blocked({ query: "two" })]);
    expect(ran).toEqual([]);
    expect(await registry.run("web_search", { query: "three" })).toEqual({
      ok: true,
      query: "three",
    });
    expect(ran).toEqual(["three"]);
    expect(await registry.run("get_timeline", {})).toEqual({ ok: true, timeline: null });
  });

  it("leaves a registry alone when the case stages nothing", () => {
    const registry = new ClientToolRegistry();
    const run = registry.run;
    stageFaults(registry, undefined);
    stageFaults(registry, []);
    expect(registry.run).toBe(run);
  });

  it("puts the failure in the run's trace as the tool's own failed call", async () => {
    const s = byId("fu_retry_failed_import");
    const { result } = await drive(s, s.reference);
    const imports = result.trace.toolCalls.filter((c) => c.name === "import_media");
    expect(imports.map((c) => [c.turn, c.ok, c.error ?? null])).toEqual([
      [0, false, "download failed: HTTP 503"],
      [1, true, null],
    ]);
  });
});

describe("Stop part-way (Scenario.stopAfter) ends the turn and owes the calls it never ran", () => {
  it("runs two calls, then the next message carries every answer owed, as the app sends it", async () => {
    const s = byId("fu_stop_then_carry_on");
    const { result, requests } = await drive(s, s.reference);
    expect(result.trace.toolCalls.filter((c) => c.turn === 0).map((c) => c.args.clip_id)).toEqual([
      "s8",
      "s7",
    ]);
    // The first round of the next turn: the person's words, plus an answer for each of the eight
    // calls (two that ran, six that never did), the way store/chat.ts sends them after a Stop.
    const next = requests[1].round_input;
    expect(next.extra_texts).toEqual([s.followUps![0]]);
    const owed = (next.tool_results ?? []).map((r) => [
      r.name,
      r.result.ok,
      r.result.error ?? null,
    ]);
    expect(owed.slice(0, 2)).toEqual([
      ["ripple_delete", true, null],
      ["ripple_delete", true, null],
    ]);
    expect(owed.slice(2)).toEqual(
      Array(6).fill([
        "ripple_delete",
        false,
        "not run — the turn was stopped before this tool call",
      ]),
    );
  });

  it("a case with no stop point carries nothing into its follow-ups", async () => {
    const s = byId("fu_wrong_clip_bw");
    const { requests } = await drive(s, s.reference);
    for (const r of requests) expect(r.round_input.extra_texts ?? []).toEqual([]);
  });
});

/** A wrong run, and the rule it must be failed on. */
interface Wrong {
  why: string;
  steps: ReferenceStep[];
  fails: RegExp;
}

const WRONG: Record<string, Wrong[]> = {
  fu_wrong_clip_bw: [
    {
      why: "grades the right clip but leaves the wrong one black and white",
      steps: [
        call("apply_color", { clip_ids: ["market"], saturation: 0 }),
        say("Done."),
        call("apply_color", { clip_ids: ["sunset"], saturation: 0 }),
        say("The sunset clip is black and white now."),
      ],
      fails: /market clip should look as it did: saturation/,
    },
  ],
  fu_es_wrong_clip_deleted: [
    {
      why: "deletes the right clip but never brings the first one back",
      steps: [
        call("remove_clips", { clip_ids: ["mercado"] }),
        say("Hecho."),
        call("remove_clips", { clip_ids: ["puerto"] }),
        say("He borrado el del puerto."),
      ],
      fails: /one clip playing mercado\.mp4, got 0/,
    },
  ],
  fu_second_title_yellow: [
    {
      why: "colours the first title instead of the second",
      steps: [
        call("add_text_clips", {
          entries: [
            { timeline_in: 0, timeline_out: 60, content: "Day One" },
            { timeline_in: 180, timeline_out: 240, content: "Day Two" },
          ],
        }),
        say("Added both titles."),
        read,
        onRead((tl) => [
          ["update_text", { clip_ids: [idOf(tl, reads("Day One"))], style: { color: "#FFFF00" } }],
        ]),
        say("Made it yellow."),
      ],
      fails: /'Day Two' is not yellow/,
    },
  ],
  fu_fade_clip_just_added: [
    {
      why: "fades out the last clip on the timeline, not the one just added",
      steps: [
        call("library_op", { action: "list" }),
        call("insert_clips", { at: 240, entries: [{ media_ref: "media_broll_ocean" }] }),
        say("Added the ocean shot."),
        call("set_clip_properties", { clip_ids: ["b"], fade: { out: 30 } }),
        say("Faded it out."),
      ],
      fails: /ocean shot's fade-out/,
    },
    {
      why: "lays the b-roll over the next shot instead of making room for it",
      steps: [
        call("library_op", { action: "list" }),
        call("add_clips", {
          entries: [{ media_ref: "media_broll_ocean", timeline_in: 240, track_id: "v2" }],
        }),
        say("Added the ocean shot after the city shot."),
        read,
        onRead((tl) => [
          [
            "set_clip_properties",
            { clip_ids: [idOf(tl, (c) => c.media_ref === "media_broll_ocean")], fade: { out: 30 } },
          ],
        ]),
        say("Faded it out."),
      ],
      fails: /covers the start of the next shot/,
    },
  ],
  fu_split_then_drop_middle: [
    {
      why: "deletes the middle piece but leaves the gap open",
      steps: [
        call("split_clips", {
          splits: [
            { clip_id: "market", at: 150 },
            { clip_id: "market", at: 120 },
          ],
        }),
        say("Split it."),
        read,
        onRead((tl) => [
          [
            "remove_clips",
            { clip_ids: [idOf(tl, (c) => c.media_ref === "market.mp4" && c.source_in === 30)] },
          ],
        ]),
        say("Deleted the middle piece."),
      ],
      fails: /starts at \d+f, the clip before it ends at \d+f/,
    },
  ],
  fu_same_for_last_and_before: [
    {
      why: "reads 'the one before it' as two clips before the end",
      steps: [
        call("apply_color", { clip_ids: ["beach"], saturation: 0 }),
        say("Done."),
        call("apply_color", { clip_ids: ["night"], saturation: 0 }),
        say("Done."),
        call("apply_color", { clip_ids: ["sunset"], saturation: 0 }),
        say("Done."),
      ],
      fails: /clip harbour is not black and white/,
    },
  ],
  fu_question_then_that_one: [
    {
      why: "trims the first clip instead of the one it named as the longest",
      steps: [
        read,
        say("The hallway clip is the longest."),
        call("set_clip_properties", { clip_ids: ["kitchen"], duration: 90 }),
        say("Trimmed it to three seconds."),
      ],
      fails: /hallway clip's length/,
    },
    {
      why: "edits the project to answer a question",
      steps: [
        call("set_clip_properties", { clip_ids: ["hallway"], duration: 90 }),
        say("The hallway clip was the longest; I trimmed it."),
        say("It is already three seconds."),
      ],
      fails: /edited in answer to a question/,
    },
  ],
  fu_half_then_trim_end: [
    {
      why: "takes the half second off the start instead of the end",
      steps: [
        call("set_clip_properties", { clip_ids: ["harbour"], duration: 60 }),
        say("Halved it."),
        call("set_clip_properties", { clip_ids: ["harbour"], source_in: 15, duration: 45 }),
        say("Took another half second off."),
      ],
      fails: /first frame \(its start was kept\)/,
    },
  ],
  fu_music_down_down_up: [
    {
      why: "'up a little' puts the music straight back to full volume",
      steps: [
        call("set_clip_properties", { clip_ids: ["music"], volume: 0.5 }),
        say("Lowered it."),
        call("set_clip_properties", { clip_ids: ["music"], volume: 0.3 }),
        say("Lower still."),
        call("set_clip_properties", { clip_ids: ["music"], volume: 1 }),
        say("Raised it."),
      ],
      fails: /quieter than it started, but audible \(volume 1\)/,
    },
    {
      why: "'still too loud' does not lower it any further",
      steps: [
        call("set_clip_properties", { clip_ids: ["music"], volume: 0.5 }),
        say("Lowered it."),
        say("It is already at half volume, which should sit under the talking."),
        call("set_clip_properties", { clip_ids: ["music"], volume: 0.6 }),
        say("Raised it."),
      ],
      fails: /"still too loud" did not lower it further/,
    },
  ],
  fu_title_nudges: [
    {
      why: "'a little more' moves the title back down",
      steps: [
        call("add_text_clips", {
          entries: [
            {
              timeline_in: 0,
              timeline_out: 90,
              content: "Open House",
              transform: { position: { x: 0.5, y: 0.85 } },
            },
          ],
        }),
        say("Added it."),
        read,
        onRead((tl) => [
          [
            "update_text",
            {
              clip_ids: [idOf(tl, reads("Open House"))],
              transform: { position: { x: 0.5, y: 0.78 } },
            },
          ],
        ]),
        say("Moved it up."),
        read,
        onRead((tl) => [
          [
            "update_text",
            {
              clip_ids: [idOf(tl, reads("Open House"))],
              transform: { position: { x: 0.5, y: 0.82 } },
            },
          ],
        ]),
        say("Moved it."),
        read,
        onRead((tl) => [
          ["update_text", { clip_ids: [idOf(tl, reads("Open House"))], style: { bold: true } }],
        ]),
        say("Bold."),
        read,
        onRead((tl) => [
          [
            "update_text",
            { clip_ids: [idOf(tl, reads("Open House"))], content: "Open House Sunday" },
          ],
        ]),
        say("Reworded."),
      ],
      fails: /"a little more" did not move it up again/,
    },
    {
      why: "the new wording is a second title instead of the same one changed",
      steps: [
        call("add_text_clips", {
          entries: [
            {
              timeline_in: 0,
              timeline_out: 90,
              content: "Open House",
              transform: { position: { x: 0.5, y: 0.85 } },
            },
          ],
        }),
        say("Added it."),
        read,
        onRead((tl) => [
          [
            "update_text",
            {
              clip_ids: [idOf(tl, reads("Open House"))],
              transform: { position: { x: 0.5, y: 0.78 } },
            },
          ],
        ]),
        say("Moved it up."),
        read,
        onRead((tl) => [
          [
            "update_text",
            {
              clip_ids: [idOf(tl, reads("Open House"))],
              transform: { position: { x: 0.5, y: 0.7 } },
            },
          ],
        ]),
        say("Up again."),
        read,
        onRead((tl) => [
          ["update_text", { clip_ids: [idOf(tl, reads("Open House"))], style: { bold: true } }],
        ]),
        say("Bold."),
        call("add_text_clips", {
          entries: [
            {
              timeline_in: 0,
              timeline_out: 90,
              content: "Open House Sunday",
              style: { bold: true },
              transform: { position: { x: 0.5, y: 0.6 } },
            },
          ],
        }),
        say("Added the new words."),
      ],
      fails: /expected one title, got 2/,
    },
  ],
  fu_crossfade_try_again_longer: [
    {
      why: "'much longer' adds two frames",
      steps: [
        call("set_transition", {
          clip_id: "x2",
          transition_in: { kind: "crossfade", duration: 10 },
        }),
        say("Added a crossfade."),
        call("set_transition", {
          clip_id: "x2",
          transition_in: { kind: "crossfade", duration: 12 },
        }),
        say("Made it longer."),
      ],
      fails: /"much longer" went from 10 to 12 frames/,
    },
  ],
  fu_cool_tone_down_keep_trim: [
    {
      why: "'tone it down a bit' throws the whole look away",
      steps: [
        call("set_clip_properties", { clip_ids: ["lake"], duration: 90 }),
        say("Trimmed."),
        call("apply_color", { clip_ids: ["lake"], temperature: 5000 }),
        say("Colder."),
        call("undo", {}),
        say("Toned it down."),
      ],
      fails: /no longer cold at all/,
    },
  ],
  fu_undo_all_of_that: [
    {
      why: "one undo takes back only the last of the turn's edits",
      steps: [
        {
          calls: [
            ["set_clip_properties", { clip_ids: ["a", "b", "c", "d"], fade: { in: 15, out: 15 } }],
            [
              "add_text_clips",
              { entries: [{ timeline_in: 0, timeline_out: 60, content: "Summer" }] },
            ],
          ],
        },
        say("Done."),
        call("undo", {}),
        say("Undone."),
      ],
      fails: /clip a was changed/,
    },
  ],
  fu_undo_first_keep_second: [
    {
      why: "a plain undo takes back the slow motion instead",
      steps: [
        call("apply_color", { clip_ids: ["city"], saturation: 0 }),
        say("Done."),
        call("set_clip_properties", { clip_ids: ["night"], speed: 0.5 }),
        say("Done."),
        call("undo", {}),
        say("Undone."),
      ],
      fails: /city clip should look as it did: saturation/,
    },
  ],
  fu_back_to_before_title: [
    {
      why: "goes one step too far back and loses the trim",
      steps: [
        call("set_clip_properties", { clip_ids: ["a"], duration: 60 }),
        say("Trimmed."),
        call("add_text_clips", {
          entries: [{ timeline_in: 0, timeline_out: 60, content: "Road Trip" }],
        }),
        say("Added the title."),
        call("apply_color", { clip_ids: ["d"], temperature: 7500 }),
        say("Warmer."),
        {
          calls: [
            ["undo", {}],
            ["undo", {}],
            ["undo", {}],
          ],
        },
        say("Went back."),
      ],
      fails: /first clip's length \(the trim they kept\)/,
    },
  ],
  fu_bw_then_colour_warmer: [
    {
      why: "warms the picture but leaves it black and white",
      steps: [
        call("apply_color", { clip_ids: ["park1", "park2", "park3", "park4"], saturation: 0 }),
        say("Done."),
        call("apply_color", { clip_ids: ["park1", "park2", "park3", "park4"], temperature: 7200 }),
        say("Warmer now."),
      ],
      fails: /clip park1 is still drained of colour/,
    },
  ],
  fu_reorder_change_mind: [
    {
      why: "puts the sunset clip first but leaves the night clip near the start",
      steps: [
        call("move_clips", {
          moves: [
            { clip_id: "night", to_timeline_in: 0 },
            { clip_id: "beach", to_timeline_in: 90 },
            { clip_id: "city", to_timeline_in: 180 },
            { clip_id: "market", to_timeline_in: 270 },
            { clip_id: "sunset", to_timeline_in: 360 },
            { clip_id: "harbour", to_timeline_in: 450 },
          ],
        }),
        say("Moved."),
        call("move_clips", {
          moves: [
            { clip_id: "sunset", to_timeline_in: 0 },
            { clip_id: "night", to_timeline_in: 90 },
            { clip_id: "beach", to_timeline_in: 180 },
            { clip_id: "city", to_timeline_in: 270 },
            { clip_id: "market", to_timeline_in: 360 },
            { clip_id: "harbour", to_timeline_in: 450 },
          ],
        }),
        say("The sunset clip is first."),
      ],
      fails: /expected the clips in the order sunset\.mp4/,
    },
  ],
  fu_restore_deleted_shorter: [
    {
      why: "brings the clip back at the end instead of where it was",
      steps: [
        call("remove_clips", { clip_ids: ["market"] }),
        say("Deleted."),
        call("add_clips", {
          entries: [{ media_ref: "market.mp4", timeline_in: 540, duration: 60 }],
        }),
        say("It is back, two seconds of it."),
      ],
      fails: /expected the clips in the order beach\.mp4/,
    },
  ],
  fu_canvas_square_then_tall: [
    {
      why: "'tall, for stories' becomes a 4:5 feed shape",
      steps: [
        call("set_project_settings", { size: { aspect_ratio: "1:1" }, fps: null }),
        say("Square."),
        call("set_project_settings", { size: { width: 1080, height: 1350 }, fps: null }),
        say("Taller now."),
      ],
      fails: /canvas shape/,
    },
  ],
  fu_continue_staged_trims: [
    {
      why: "'keep going' cuts the first four again",
      steps: [
        call("ripple_delete", {
          track_id: "v1",
          ranges: [
            { start: 0, end: 15 },
            { start: 90, end: 105 },
            { start: 180, end: 195 },
            { start: 270, end: 285 },
          ],
        }),
        say("First four done."),
        call("ripple_delete", {
          track_id: "v1",
          ranges: [0, 75, 150, 225, 300, 390, 480, 570].map((s) => ({ start: s, end: s + 15 })),
        }),
        say("Did all of them."),
      ],
      fails: /take1's first source frame/,
    },
  ],
  fu_long_text_style_rule: [
    {
      why: "the last title, five turns later, forgets the style set in the first message",
      steps: [
        call("add_text_clips", {
          entries: [
            {
              timeline_in: 0,
              timeline_out: 60,
              content: "Lisbon",
              style: { color: "#FFFFFF", outline: { color: "#000000", width: 4 } },
            },
          ],
        }),
        say("Added."),
        call("add_text_clips", {
          entries: [
            {
              timeline_in: 90,
              timeline_out: 150,
              content: "Day 1",
              style: { color: "#FFFFFF", outline: { color: "#000000", width: 4 } },
            },
          ],
        }),
        say("Added."),
        call("apply_color", { clip_ids: ["lisbon2"], saturation: 0 }),
        say("Done."),
        call("add_text_clips", {
          entries: [
            {
              timeline_in: 180,
              timeline_out: 240,
              content: "Day 2",
              style: { color: "#FFFFFF", outline: { color: "#000000", width: 4 } },
            },
          ],
        }),
        say("Added."),
        read,
        onRead((tl) => [
          ["update_text", { clip_ids: [idOf(tl, reads("Day 1"))], content: "Day One" }],
        ]),
        say("Changed."),
        call("add_text_clips", {
          entries: [{ timeline_in: 300, timeline_out: 360, content: "See you soon" }],
        }),
        say("Added."),
      ],
      fails: /'See you soon' is not white/,
    },
  ],
  fu_long_hands_off_interview: [
    {
      why: "'make everything faster' speeds up the interview it was told to leave alone",
      steps: [
        call("apply_color", { clip_ids: ["b1"], brightness: 0.08 }),
        say("Done."),
        call("apply_color", { clip_ids: ["b2", "b3", "b4", "b5"], brightness: 0.08 }),
        say("Done."),
        call("set_clip_properties", {
          clip_ids: ["b1", "b2", "interview", "b3", "b4", "b5"],
          speed: 1.25,
        }),
        say("Everything is faster."),
        {
          calls: [
            ["set_clip_properties", { clip_ids: ["b1"], fade: { in: 15 } }],
            ["set_clip_properties", { clip_ids: ["b5"], fade: { out: 15 } }],
          ],
        },
        say("Faded."),
        call("set_clip_properties", { clip_ids: ["b1", "b2", "b3", "b4", "b5"], fit: "cover" }),
        say("Filled."),
      ],
      fails: /clip interview was changed/,
    },
  ],
  fu_long_promo_session: [
    {
      why: "'just make it quieter' unmutes the music at full volume",
      steps: promoUntil(6, [
        call("set_track", { track_id: "a1", mute: false }),
        say("Unmuted."),
        say("Glad you like it."),
      ]),
      fails: /quieter but not silent \(volume 1\)/,
    },
    {
      why: "'that's all for now' still edits the project",
      steps: promoUntil(6, [
        {
          calls: [
            ["set_track", { track_id: "a1", mute: false }],
            ["set_clip_properties", { clip_ids: ["music"], volume: 0.5 }],
          ],
        },
        say("Quieter."),
        call("set_clip_properties", { clip_ids: ["city"], fade: { out: 15 } }),
        say("Added a fade at the end to finish it off."),
      ]),
      fails: /"that's all for now" still edited the project/,
    },
  ],
  fu_ask_which_dog_clip: [
    {
      why: "guesses which dog clip to delete instead of asking (and happens to guess right)",
      steps: [
        call("ripple_delete", { track_id: "v1", start: 270, end: 360 }),
        say("Deleted the dog clip."),
        say("Yes, that was the one I deleted."),
      ],
      fails: /deleted before asking which dog clip/,
    },
  ],
  fu_vivid_except_interview: [
    {
      why: "takes the vivid look off everything, not just the interview",
      steps: [
        call("apply_color", {
          clip_ids: ["food1", "food2", "chef", "food3", "food4", "food5"],
          saturation: 1.3,
        }),
        say("Done."),
        call("undo", {}),
        say("Undone for the interview."),
      ],
      fails: /clip food1 is not more vivid/,
    },
  ],
  fu_same_zoom_on_all: [
    {
      why: "'all the other clips' misses the last one",
      steps: [
        call("set_keyframes", {
          clip_id: "hike1",
          property: "scale",
          keyframes: [
            { t: 0, v: 1 },
            { t: 89, v: 1.1 },
          ],
        }),
        say("Zoomed."),
        {
          calls: ["hike2", "hike3"].map((id) => [
            "set_keyframes",
            {
              clip_id: id,
              property: "scale",
              keyframes: [
                { t: 0, v: 1 },
                { t: 89, v: 1.1 },
              ],
            },
          ]) as ReferenceCalls,
        },
        say("Done on the others."),
      ],
      fails: /clip hike4 does not have the same zoom/,
    },
  ],
  fu_link_move_unlink: [
    {
      why: "nudges the voiceover while it is still linked, so the interview moves with it",
      steps: [
        call("link_clips", { clip_ids: ["interview", "vo"] }),
        say("Linked."),
        call("move_clips", { moves: [{ clip_id: "interview", to_timeline_in: 330 }] }),
        say("Moved."),
        call("move_clips", { moves: [{ clip_id: "vo", to_timeline_in: 360 }] }),
        say("Unlinked and moved the voiceover."),
      ],
      fails: /how far the voiceover sits after the interview's start/,
    },
  ],
  fu_tracks_mute_then_partial: [
    {
      why: "'bring back the sound effects' unmutes the music too",
      steps: [
        call("set_tracks", {
          tracks: [
            { track_id: "a1", mute: true },
            { track_id: "a2", mute: true },
          ],
        }),
        say("Muted."),
        call("set_tracks", {
          tracks: [
            { track_id: "a1", mute: false },
            { track_id: "a2", mute: false },
          ],
        }),
        say("Back."),
        call("set_track", { track_id: "v2", hidden: true }),
        say("Hidden."),
      ],
      fails: /the music is not muted/,
    },
  ],
  fu_music_runs_to_end: [
    {
      why: "makes the music run well past the end of the video",
      steps: [
        call("library_op", { action: "list" }),
        call("add_clips", { entries: [{ media_ref: "media_bed", timeline_in: 0 }] }),
        say("Added."),
        read,
        onRead((tl) => [
          [
            "set_clip_properties",
            { clip_ids: [idOf(tl, (c) => c.media_ref === "media_bed")], duration: 450, loop: true },
          ],
        ]),
        say("It runs to the end now."),
      ],
      fails: /where the music ends/,
    },
    {
      why: "says it already runs to the end without changing anything",
      steps: [
        call("library_op", { action: "list" }),
        call("add_clips", { entries: [{ media_ref: "media_bed", timeline_in: 0 }] }),
        say("Added."),
        say("The music already plays to the end."),
      ],
      fails: /where the music ends/,
    },
  ],
  fu_retry_blocked_search: [
    {
      why: "puts a guessed time on screen while the search is blocked",
      steps: [
        call("web_search", { query: "example.com launch window" }),
        call("add_text_clips", {
          entries: [{ timeline_in: 0, timeline_out: 60, content: "Launch window opens 10:00 UTC" }],
        }),
        say("The search was blocked, so I put the usual time on screen."),
        call("web_search", { query: "example.com launch window" }),
        read,
        onRead((tl) => [
          [
            "update_text",
            {
              clip_ids: [idOf(tl, reads("Launch window"))],
              content: "Launch window opens 09:40 UTC",
            },
          ],
        ]),
        say("Fixed the time."),
      ],
      fails: /put text on screen before the time was known/,
    },
    {
      why: "keeps searching after the block instead of telling the person",
      steps: [
        call("web_search", { query: "example.com launch window" }),
        call("web_search", { query: "launch window example.com opening time" }),
        call("add_text_clips", {
          entries: [{ timeline_in: 0, timeline_out: 60, content: "Launch window opens 09:40 UTC" }],
        }),
        say("The window opens at 09:40 UTC; it's on screen."),
        say("It's already on screen."),
      ],
      fails: /kept searching after the engine blocked it/,
    },
  ],
  fu_retry_failed_import: [
    {
      why: "repeats the failed download on its own, before the person said to",
      steps: [
        call("import_media", {
          source: { url: "https://example.com/media/drone.mp4" },
          name: "drone",
        }),
        call("import_media", {
          source: { url: "https://example.com/media/drone.mp4" },
          name: "drone",
        }),
        call("add_clips", { entries: [{ media_ref: "media_drone", timeline_in: 270 }] }),
        say("Imported it and put it at the end."),
        say("It's already there."),
      ],
      fails: /repeated the failed download on its own/,
    },
    {
      why: "says it will work now but never imports again",
      steps: [
        call("import_media", {
          source: { url: "https://example.com/media/drone.mp4" },
          name: "drone",
        }),
        say("The download failed."),
        say("Great, it should work now."),
      ],
      fails: /expected the drone shot placed once, got 0/,
    },
  ],
  fu_stop_then_carry_on: [
    {
      why: "'carry on' starts over and cuts the two clips done before Stop a second time",
      steps: [
        {
          calls: [8, 7, 6, 5, 4, 3, 2, 1].map((i) => [
            "ripple_delete",
            { clip_id: `s${i}`, start: (i - 1) * 90, end: (i - 1) * 90 + 15 },
          ]) as ReferenceCalls,
        },
        call("ripple_delete", {
          track_id: "v1",
          ranges: [0, 90, 180, 270, 360, 450, 540, 615].map((s) => ({ start: s, end: s + 15 })),
        }),
        say("Done all eight."),
      ],
      fails: /take7's first source frame/,
    },
  ],
};

/** The promo session's correct run up to turn `turn`, then `rest`. */
function promoUntil(turn: number, rest: ReferenceStep[]): ReferenceStep[] {
  const ref = byId("fu_long_promo_session").reference;
  const out: ReferenceStep[] = [];
  let turns = 0;
  for (const step of ref) {
    if (turns === turn) break;
    out.push(step);
    if ("text" in step) turns += 1;
  }
  return [...out, ...rest];
}

describe("realistic wrong runs fail on the rule they break", () => {
  it("covers every follow-up case", () => {
    expect(GAP_FOLLOWUPS.filter((s) => !WRONG[s.id]).map((s) => s.id)).toEqual([]);
  });

  for (const [id, wrongs] of Object.entries(WRONG))
    for (const w of wrongs)
      it(`${id}: ${w.why}`, async () => {
        const s = byId(id);
        // A wrong run is a whole conversation too: every turn gets its reply.
        expect(w.steps.filter((step) => "text" in step)).toHaveLength(repliesOf(s));
        const { result } = await drive(s, w.steps);
        expect(result.harnessError).toBeUndefined();
        expect(result.passed).toBe(false);
        const why = [
          ...result.tier0.violations,
          ...result.tier1.violations,
          ...(result.harm?.violations ?? []),
        ].join("\n");
        expect(why).toMatch(w.fails);
      });
});
