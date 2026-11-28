// The whole-video cases (scenarios/gap_wholevideo.ts), offline: a realistic wrong run of each kind fails
// for the reason a person would give, and the footage stand-ins (footage.ts) answer as the cases rely on
// them to. Each case's correct run (its `reference`) is replayed by scenarios.reference.test.ts.
//
// No network and no model: every round is scripted, and fetch is replaced by a spy that throws (each test
// checks it was never called).
import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientToolRegistry } from "../tools/registry";
import type { ClientToolContext } from "../tools/context";
import { emptyStudioState, registerStudioStubs } from "./studio";
import { footageClip, footageRunner, footageWordRows, useFootage, type Footage } from "./footage";
import { harnessProbeRunner } from "./harness";
import { gradeRun } from "./oracle";
import { Budget } from "./pricing";
import { driveScripted, type ReferenceStep } from "./reference";
import { ALL_SCENARIOS } from "./scenarios";
import { GAP_WHOLEVIDEO } from "./scenarios/gap_wholevideo";
import {
  BAKE,
  BAKE_REF as V,
  CAFE_REF as K,
  EVENT_REF as E,
  HOME_REF as H,
  LESSON,
  LESSON_REF as P,
  PARTY_REF as B,
  TRIP,
  TRIP_REF as T,
  newProject,
  placedProject,
} from "./scenarios/gap_wholevideo_footage";
import type { Scenario, Trace } from "./types";
import { ensureTimeline, loadTimeline } from "../timeline/engine";
import { INTERNAL_DIR, ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import { registerTimelineTools } from "../timeline/ops";
import { ProjectDocument } from "../project/ProjectDocument";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { asProjectId } from "../project/types";

type Step = ReferenceStep;

const WORK = path.resolve("reports", "eval", `wholevideo-${process.pid}`);
const byId = (id: string): Scenario => {
  const s = GAP_WHOLEVIDEO.find((x) => x.id === id);
  if (!s) throw new Error(`no case ${id}`);
  return s;
};
const correct = (id: string): Step[] => byId(id).reference ?? [];

async function drive(scenario: Scenario, steps: readonly Step[]) {
  return (await driveScripted(scenario, steps, { workDir: WORK, budget: new Budget(5) })).result;
}
const why = (r: Awaited<ReturnType<typeof drive>>): string =>
  [...r.tier0.violations, ...r.tier1.violations, ...(r.harm?.violations ?? [])].join("\n");

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("network blocked in the whole-video eval test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy, "the scripted harness reached the network").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(() => fsp.rm(WORK, { recursive: true, force: true }));

// ── what every case declares ─────────────────────────────────────────────────────────

describe("the whole-video cases are declared for the lanes that run them", () => {
  it("are registered in the main lane, 35 of them", () => {
    const ids = new Set(ALL_SCENARIOS.map((s) => s.id));
    expect(GAP_WHOLEVIDEO.length).toBe(35);
    for (const s of GAP_WHOLEVIDEO) expect(ids.has(s.id), s.id).toBe(true);
  });

  for (const s of GAP_WHOLEVIDEO)
    it(`${s.id}: studio surface, own footage, tags, nothing paid`, () => {
      expect(s.surface).toBe("studio");
      expect(s.reference?.length, "the case carries its correct run").toBeGreaterThan(0);
      expect(s.footage?.clips.length).toBeGreaterThanOrEqual(6);
      const t = s.tags ?? [];
      for (const prefix of ["gap:wholevideo", "lang:en", "turns:", "clips:", "kind:"])
        expect(
          t.some((x) => x.startsWith(prefix)),
          prefix,
        ).toBe(true);
      expect(t).toContain(`turns:${1 + (s.followUps?.length ?? 0)}`);
      expect(s.paidTools ?? []).toEqual([]);
      // The request is in the person's words: no library id or camera filename tells the agent which clip is which.
      for (const c of s.footage!.clips) {
        expect(s.prompt).not.toContain(c.media_ref);
        expect(s.prompt).not.toContain(c.filename);
      }
      // Everything the seed holds plays footage the case knows.
      for (const tr of s.seed().tracks ?? [])
        for (const c of tr.clips ?? [])
          expect(footageClip(s.footage!, c.media_ref), String(c.media_ref)).toBeDefined();
    });
});

// ── a realistic wrong run of each kind fails, for the reason the person would give ────

/** The correct run with the step that places the clips (the first add_clips round) replaced. */
function withPlacement(id: string, entries: Record<string, unknown>[]): Step[] {
  const steps = [...correct(id)];
  const i = steps.findIndex(
    (s) => "calls" in s && Array.isArray(s.calls) && s.calls[0]?.[0] === "add_clips",
  );
  steps[i] = { calls: [["add_clips", { entries }]] };
  return steps;
}
const seq = (parts: [string, number, number][], at = 0, extra: Record<string, unknown> = {}) => {
  let f = at;
  return parts.map(([ref, a, b]) => {
    const len = Math.round(b * 30) - Math.round(a * 30);
    const e = ref.includes(".")
      ? { media_ref: ref, timeline_in: f, timeline_out: f + len, ...extra }
      : { media_ref: ref, timeline_in: f, source_span: [a, b], ...extra };
    f += len;
    return e;
  });
};
/** The correct run with step `i` (counted from the end when negative) replaced or removed. */
function replaced(id: string, i: number, step: Step | null): Step[] {
  const steps = [...correct(id)];
  const at = i < 0 ? steps.length + i : i;
  if (step) steps[at] = step;
  else steps.splice(at, 1);
  return steps;
}

const WRONG: { id: string; what: string; steps: () => Step[]; fails: RegExp }[] = [
  {
    id: "wv_trailer_30s",
    what: "a 30 s 'trailer' of two long shots",
    steps: () =>
      withPlacement(
        "wv_trailer_30s",
        seq([
          [T.sunset, 0, 16],
          [T.bay, 0, 14],
        ]),
      ),
    fails: /shows 2 of the person's clips/,
  },
  {
    id: "wv_vague_post_it",
    what: "one clip and nothing else",
    steps: () => withPlacement("wv_vague_post_it", seq([[E.keynote, 0, 15]])),
    fails: /shows 1 of the person's clips/,
  },
  {
    id: "wv_highlight_open_close_must",
    what: "the trophy moment last instead of the volunteers",
    steps: () =>
      withPlacement(
        "wv_highlight_open_close_must",
        seq([
          [E.hall, 0, 8],
          [E.banner, 0, 6],
          [E.keynote, 0, 11],
          [E.printer, 0, 7],
          [E.handshake, 0, 8],
          [E.kids, 0, 8],
          [E.interview, 0, 10],
          [E.volunteers, 0, 9],
          [E.trophy, 0, 10],
        ]),
      ),
    fails: /ends on A7S_0231\.MP4.*asked to end on A7S_0234\.MP4/,
  },
  {
    id: "wv_travel_skip_food_and_shaky",
    what: "the market stall left in (food the agent did not spot)",
    steps: () =>
      withPlacement(
        "wv_travel_skip_food_and_shaky",
        seq([
          [T.bay, 0, 6],
          [T.lane, 0, 6],
          [T.boats, 0, 5],
          [T.jump, 3, 11],
          [T.cave, 0, 7],
          [T.market, 0, 6],
          [T.sunset, 6, 13],
        ]),
      ),
    fails: /leave it out: IMG_3375\.MOV/,
  },
  {
    id: "wv_missing_shot_honest",
    what: "the reply claims a fireworks ending the footage does not have",
    steps: () =>
      replaced("wv_missing_shot_honest", -1, {
        text: "Done! Your 30-second recap ends on the fireworks.",
      }),
    fails: /does not tell the person/,
  },
  {
    id: "wv_listing_room_order",
    what: "the rooms in filename order",
    steps: () =>
      withPlacement(
        "wv_listing_room_order",
        seq([
          [H.kitchen, 0, 10],
          [H.outside, 0, 9],
          [H.bedroom, 0, 11],
          [H.balcony, 0, 8],
          [H.living, 0, 12],
          [H.hallway, 0, 9],
          [H.bathroom, 0, 9],
        ]),
      ),
    fails: /opens on H_0101\.MP4/,
  },
  {
    id: "wv_use_every_clip_under_45",
    what: "seven of the eight party clips",
    steps: () =>
      withPlacement(
        "wv_use_every_clip_under_45",
        seq(
          [B.candles, B.toast, B.balloons, B.present, B.dancing, B.cakeCut, B.hug].map((r) => [
            r,
            0,
            5,
          ]),
        ),
      ),
    fails: /not in the video, though the request asked for it: MVI_0417\.MP4/,
  },
  {
    id: "wv_slowmo_named_moment",
    what: "the jump at normal speed",
    steps: () => [
      ...correct("wv_slowmo_named_moment").slice(0, 2),
      {
        calls: [
          [
            "add_clips",
            {
              entries: seq([
                [T.jump, 3, 15],
                [T.cave, 0, 9],
                [T.snorkel, 0, 9],
              ]),
            },
          ],
        ],
      },
      { text: "Done." },
    ],
    fails: /plays at 1 speed; the request asked for slow motion/,
  },
  {
    id: "wv_rough_cut_to_a_minute",
    what: "trimmed to a minute, the pocket clip still in",
    steps: () =>
      replaced("wv_rough_cut_to_a_minute", 2, {
        calls: [
          [
            "ripple_delete",
            {
              track_id: "v1",
              ranges: [
                [150, 270],
                [480, 630],
                [780, 870],
                [1020, 1170],
                [1320, 1500],
                [1650, 1710],
                [1860, 2190],
                [2520, 2640],
                [2790, 2880],
                [3030, 3180],
                [3360, 3540],
              ].map(([start, end]) => ({ start, end })),
            },
          ],
        ],
      }),
    fails: /leave it out: IMG_3372\.MOV/,
  },
  {
    id: "wv_reorder_event_timeline",
    what: "the trophy moved to the front in place, over the opening shot",
    steps: () =>
      replaced("wv_reorder_event_timeline", 2, {
        calls: [
          [
            "move_clips",
            {
              moves: [
                { clip_id: "c11", to_timeline_in: 0 },
                { clip_id: "c03", to_timeline_in: 360 },
              ],
            },
          ],
        ],
      }),
    fails: /lost part of its picture/,
  },
  {
    id: "wv_polish_title_crossfades_fade",
    what: "crossfades on two cuts only",
    steps: () =>
      replaced("wv_polish_title_crossfades_fade", 1, {
        calls: [
          [
            "add_text_clips",
            { entries: [{ content: "Maple Court, Flat 4", timeline_in: 0, timeline_out: 90 }] },
          ],
          [
            "set_transition",
            { clip_id: "c02", transition_in: { kind: "crossfade", duration: 15 } },
          ],
          [
            "set_transition",
            { clip_id: "c03", transition_in: { kind: "crossfade", duration: 15 } },
          ],
          ["set_clip_properties", { clip_ids: ["c07"], fade: { out: 30 } }],
        ],
      }),
    fails: /4 of 6 cuts have no crossfade/,
  },
  {
    id: "wv_same_warm_look_all",
    what: "the warm grade on half the shots",
    steps: () =>
      replaced("wv_same_warm_look_all", 2, {
        calls: [["apply_color", { clip_ids: ["c01", "c02", "c03"], temperature: 7200 }]],
      }),
    fails: /3 of 6 shots have no warm grade/,
  },
  {
    id: "wv_same_warm_look_all",
    what: "one grade on every shot, but it cools them (white balance below neutral)",
    steps: () =>
      replaced("wv_same_warm_look_all", 2, {
        calls: [
          [
            "apply_color",
            { clip_ids: ["c01", "c02", "c03", "c04", "c05", "c06"], temperature: 5200 },
          ],
        ],
      }),
    fails: /6 of 6 shots have no warm grade/,
  },
  {
    id: "wv_dead_air_chip",
    what: "the pauses cut, the filler words left in",
    steps: () =>
      replaced("wv_dead_air_chip", 1, {
        calls: [
          [
            "ripple_delete",
            {
              track_id: "v1",
              ranges: [
                [0, 12],
                [150, 222],
                [288, 369],
                [594, 678],
                [828, 1062],
                [1194, 1275],
                [1386, 1461],
                [1530, 1569],
                [1683, 1800],
              ].map(([start, end]) => ({ start, end })),
            },
          ],
        ],
      }),
    fails: /the filler "um," in MVI_1001\.MP4 is still heard/,
  },
  {
    id: "wv_dead_air_chip",
    what: "a pause cut that eats the next word",
    steps: () =>
      replaced("wv_dead_air_chip", 1, {
        calls: [
          [
            "ripple_delete",
            {
              track_id: "v1",
              ranges: [
                [0, 12],
                [39, 49],
                [150, 222],
                [288, 369],
                [435, 545],
                [594, 678],
                [828, 1062],
                [1134, 1149],
                [1194, 1275],
                [1386, 1461],
                [1530, 1569],
                [1610, 1621],
                [1683, 1800],
              ].map(([start, end]) => ({ start, end })),
            },
          ],
        ],
      }),
    fails: /"just" in MVI_1002\.MP4 is cut or missing/,
  },
  {
    id: "wv_dead_air_chip",
    what: "the longest pause only half cut",
    steps: () =>
      replaced("wv_dead_air_chip", 1, {
        calls: [
          [
            "ripple_delete",
            {
              track_id: "v1",
              ranges: [
                [0, 12],
                [39, 49],
                [150, 192],
                [288, 369],
                [435, 533],
                [594, 678],
                [828, 1062],
                [1134, 1149],
                [1194, 1275],
                [1386, 1461],
                [1530, 1569],
                [1610, 1621],
                [1683, 1800],
              ].map(([start, end]) => ({ start, end })),
            },
          ],
        ],
      }),
    fails: /1\.40 s of silence between "puncture\." and "It"/,
  },
  {
    id: "wv_reel_vertical_under_30",
    what: "the frame left landscape",
    steps: () => replaced("wv_reel_vertical_under_30", 2, null),
    fails: /the frame is 3840x2160; the request asked for vertical/,
  },
  {
    id: "wv_reel_vertical_under_30",
    what: "a hole between two shots",
    steps: () =>
      withPlacement("wv_reel_vertical_under_30", [
        ...seq([
          [T.bay, 0, 5],
          [T.jump, 4, 10],
        ]),
        ...seq(
          [
            [T.cave, 6, 11],
            [T.sunset, 6, 12],
          ],
          360,
        ),
      ]),
    fails: /black with nothing on screen at 11\.00-12\.00 s/,
  },
  {
    id: "wv_drone_only_vertical_filled",
    what: "the drone shots letterboxed in the vertical frame",
    steps: () => replaced("wv_drone_only_vertical_filled", -2, null),
    fails: /does not fill the 1080x1920 frame/,
  },
  {
    id: "wv_square_teaser_end_balcony",
    what: "the frame left widescreen",
    steps: () => replaced("wv_square_teaser_end_balcony", 2, null),
    fails: /the request asked for square/,
  },
  {
    id: "wv_mixed_aspect_fill_landscape",
    what: "the upright clips left with bars down the sides",
    steps: () => replaced("wv_mixed_aspect_fill_landscape", -2, null),
    fails: /MVI_0414\.MP4.*does not fill the 1920x1080 frame/,
  },
  {
    id: "wv_product_title_logo",
    what: "the logo first, not last",
    steps: () =>
      withPlacement(
        "wv_product_title_logo",
        seq([
          [K.logo, 0, 4],
          [K.beans, 0, 5],
          [K.bag, 0, 5],
          [K.espresso, 2, 8],
        ]),
      ),
    fails: /the request asked to end on logo_freshbeans\.png/,
  },
  {
    id: "wv_ad_15s_end_card",
    what: "the order line on top of the logo, not under it",
    steps: () =>
      replaced("wv_ad_15s_end_card", -2, {
        calls: [
          [
            "add_text_clips",
            {
              entries: [
                { content: "Order at freshbeans.example", timeline_in: 360, timeline_out: 450 },
              ],
            },
          ],
        ],
      }),
    fails: /not under the logo/,
  },
  {
    id: "wv_recipe_step_titles",
    what: "all four titles bunched at the start",
    steps: () =>
      replaced("wv_recipe_step_titles", -2, {
        calls: [
          [
            "add_text_clips",
            {
              entries: ["Mix", "Knead", "Shape", "Bake"].map((content, i) => ({
                content,
                timeline_in: i * 40,
                timeline_out: i * 40 + 40,
              })),
            },
          ],
        ],
      }),
    fails: /no "Knead" title on screen while PXL_20261103_083012\.mp4/,
  },
  {
    id: "wv_logo_corner_watermark",
    what: "the logo full size in the middle",
    steps: () => replaced("wv_logo_corner_watermark", -2, null),
    fails: /the request asked for it small/,
  },
  {
    id: "wv_tiktok_captions_vlog",
    what: "one hand-typed caption for the first sentence only",
    steps: () =>
      replaced("wv_tiktok_captions_vlog", -2, {
        calls: [
          [
            "add_text_clips",
            {
              entries: [
                {
                  content:
                    "Okay so today I'm finally making the sourdough everyone keeps asking about.",
                  timeline_in: 15,
                  timeline_out: 168,
                },
              ],
            },
          ],
        ],
      }),
    fails: /spoken words have a caption/,
  },
  {
    id: "wv_event_caption_speakers",
    what: "captions on the keynote only",
    steps: () =>
      replaced("wv_event_caption_speakers", -2, {
        calls: [
          [
            "add_text_clips",
            {
              entries: [
                { content: "Thank you all for coming.", timeline_in: 204, timeline_out: 258 },
                {
                  content: "This year we doubled the number of local makers in this room.",
                  timeline_in: 276,
                  timeline_out: 402,
                },
                { content: "Let's build something together.", timeline_in: 438, timeline_out: 504 },
              ],
            },
          ],
        ],
      }),
    fails: /21 of 42 spoken words have a caption/,
  },
  {
    id: "wv_only_talking_parts",
    what: "the last talking clip cut before its second sentence",
    steps: () =>
      withPlacement(
        "wv_only_talking_parts",
        seq([
          [V.intro, 0, 10.5],
          [V.restTalk, 0, 5.5],
          [V.crustTalk, 0, 3],
        ]),
      ),
    fails: /words of PXL_20261103_132015\.mp4.*are cut or missing/,
  },
  {
    id: "wv_interview_broll_cover",
    what: "the b-roll after the interview instead of over it",
    steps: () =>
      replaced("wv_interview_broll_cover", -2, {
        calls: [
          [
            "add_clips",
            {
              entries: seq(
                [
                  [E.printer, 0, 3],
                  [E.kids, 0, 4],
                  [E.handshake, 0, 2],
                ],
                300,
                { with_audio: false },
              ),
            },
          ],
        ],
      }),
    fails: /only 0 of 21 of his words play over the booths/,
  },
  {
    id: "wv_party_montage_some_music",
    what: "the whole 140 s song under a 42 s montage",
    steps: () =>
      replaced("wv_party_montage_some_music", -2, {
        calls: [["add_clips", { entries: [{ media_ref: B.song, timeline_in: 0 }] }]],
      }),
    fails: /the music runs 98\.00 s past the last picture/,
  },
  {
    id: "wv_music_quiet_under_voice",
    what: "the music left at full volume",
    steps: () => replaced("wv_music_quiet_under_voice", -2, null),
    fails: /the music is above 0\.5 while/,
  },
  {
    id: "wv_followup_shorter_retitle",
    what: "a second title added over the old one",
    steps: () =>
      replaced("wv_followup_shorter_retitle", -2, {
        calls: [
          ["ripple_delete", { track_id: "v1", start: 900, end: 1350 }],
          [
            "add_text_clips",
            { entries: [{ content: "Coast Days 2026", timeline_in: 0, timeline_out: 90 }] },
          ],
        ],
      }),
    fails: /the old title "Coast Days" is still on screen/,
  },
  {
    id: "wv_followup_add_music_fade",
    what: "the music added, the fade forgotten",
    steps: () => replaced("wv_followup_add_music_fade", -2, null),
    fails: /does not fade out/,
  },
  {
    id: "wv_then_and_now_photos",
    what: "the photos placed with no length (five seconds each)",
    steps: () =>
      withPlacement("wv_then_and_now_photos", [
        { media_ref: B.photo1986, timeline_in: 0 },
        { media_ref: B.photo1994, timeline_in: 150 },
        ...seq(
          [
            [B.candles, 0, 6],
            [B.present, 0, 6],
            [B.dancing, 0, 8],
            [B.hug, 0, 8],
          ],
          300,
        ),
      ]),
    fails: /is on screen 5\.00 s; the request asked for 4 s/,
  },
  {
    id: "wv_long_brief_travel_film",
    what: "everything right but the title over the second shot",
    steps: () =>
      replaced("wv_long_brief_travel_film", 3, {
        calls: [
          [
            "add_text_clips",
            { entries: [{ content: "Summer on the Coast", timeline_in: 180, timeline_out: 300 }] },
          ],
        ],
      }),
    fails: /no title "Summer on the Coast" on screen at the start/,
  },
  {
    id: "wv_long_brief_travel_film",
    what: "everything right but the song left loud over the talking",
    steps: () => replaced("wv_long_brief_travel_film", -2, null),
    fails: /the music is above 0\.5 while/,
  },
  {
    id: "wv_long_brief_brand_film",
    what: "everything right but the founder cut short",
    steps: () =>
      withPlacement(
        "wv_long_brief_brand_film",
        seq([
          [K.beans, 0, 6],
          [K.roaster, 0, 6],
          [K.founder, 0, 5],
          [K.espresso, 2, 8],
          [K.latte, 0, 7],
          [K.bag, 0, 5],
          [K.sip, 2, 9],
          [K.roaster, 6, 10],
          [K.logo, 0, 5],
        ]),
      ),
    fails: /words of C0014\.MP4.*are cut or missing/,
  },
  {
    id: "wv_long_brief_birthday",
    what: "everything right but the music not brought down for the toast",
    steps: () => replaced("wv_long_brief_birthday", -2, null),
    fails: /the music is above 0\.35 while/,
  },
  {
    id: "wv_long_brief_event_recap",
    what: "everything right but it opens on the hall",
    steps: () =>
      withPlacement(
        "wv_long_brief_event_recap",
        seq([
          [E.hall, 0, 10],
          [E.banner, 0, 8],
          [E.keynote, 0, 12],
          [E.applause, 0, 7],
          [E.printer, 0, 8],
          [E.handshake, 0, 9],
          [E.panel, 0, 8],
          [E.kids, 0, 9],
          [E.interview, 0, 10],
          [E.coffee, 0, 6],
          [E.trophy, 0, 10],
          [E.volunteers, 0, 9],
        ]),
      ),
    fails: /the video opens on A7S_0201\.MP4/,
  },
  {
    id: "wv_listing_export",
    what: "exported before the music went on",
    steps: () => {
      const steps = correct("wv_listing_export");
      return [...steps.slice(0, 3), steps[4], steps[3], steps[5]];
    },
    fails: /exported before the edit was finished/,
  },
];

describe("a realistic wrong run of each kind fails, for the reason the person would give", () => {
  for (const w of WRONG)
    it(`${w.id}: ${w.what}`, async () => {
      const r = await drive(byId(w.id), w.steps());
      expect(r.harnessError).toBeUndefined();
      expect(r.passed).toBe(false);
      expect(why(r)).toMatch(w.fails);
    });

  it("every case has a wrong run", () => {
    const covered = new Set(WRONG.map((w) => w.id));
    expect(GAP_WHOLEVIDEO.filter((s) => !covered.has(s.id)).map((s) => s.id)).toEqual([]);
  });
});

// ── the footage stand-ins ─────────────────────────────────────────────────────────────

const nodeFs: FsLike = {
  async exists(p) {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  readTextFile: (p) => fsp.readFile(p, "utf8"),
  async writeTextFile(p, c) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, c);
  },
  async mkdir(p) {
    await fsp.mkdir(p, { recursive: true });
  },
};

/** A project on disk with `footage` wired in, as the harness wires it, for calling tools directly. */
async function footageProject(footage: Footage, seed = newProject()) {
  const dir = path.join(WORK, `stand-ins-${Math.random().toString(16).slice(2, 8)}`);
  await fsp.mkdir(dir, { recursive: true });
  const store = new ProjectStoreAccess(dir, nodeFs);
  await ensureTimeline(store);
  await store.writeTextAtomic(
    joinPath(store.projectDir, INTERNAL_DIR, "timeline.json"),
    JSON.stringify(seed),
  );
  const id = asProjectId(path.basename(dir));
  const doc = new ProjectDocument(id, { open: async () => "loaded", dispose: async () => {} });
  await doc.open();
  setOpenDocumentResolver((x) => (String(x) === String(id) ? doc : undefined));
  const ctx = { store, runner: harnessProbeRunner } as ClientToolContext;
  const registry = new ClientToolRegistry();
  registerTimelineTools(registry, () => ctx);
  registerStudioStubs(registry, emptyStudioState(), 30, () => loadTimeline(store));
  useFootage(registry, ctx, footage);
  const run = async (name: string, args: Record<string, unknown> = {}) =>
    (await registry.run(name, args)) as Record<string, unknown>;
  const close = async () => {
    setOpenDocumentResolver(() => undefined);
    await doc.close().catch(() => undefined);
  };
  return { run, store, close, timeline: () => loadTimeline(store) };
}

describe("the footage stand-ins answer from the case's footage, in the real tools' shapes", () => {
  it("a look at a clip says what its pictures show at the times it samples, and what is said", async () => {
    const p = await footageProject(TRIP);
    try {
      const r = await p.run("inspect_media", { media_ref: T.jump, word_timestamps: true });
      expect(r).toMatchObject({
        ok: true,
        kind: "video",
        media_ref: T.jump,
        duration_s: 15,
        timing: "source_seconds",
      });
      // The jump's shots: counting down until 5 s, jumping until 8 s, the splash until 11 s. Each shot
      // is said once, with the sampled times that show it.
      expect(r.note).toMatch(/at 1\.25 s, 3\.75 s, a man standing on a high rock/);
      expect(r.note).toMatch(/at 6\.25 s, the man jumping feet first/);
      expect(r.note).toMatch(/at 8\.75 s, a huge splash/);
      expect(r.note).toMatch(/at 11\.25 s, 13\.75 s, an underwater view/);
      const transcript = r.transcript as { segments: unknown[]; words: unknown[] };
      expect(transcript.segments).toEqual([["Three, two, one!", 1.5, 4]]);
      expect(transcript.words).toEqual([
        ["Three,", 1.5, 2.333],
        ["two,", 2.333, 3.167],
        ["one!", 3.167, 4],
      ]);
      // A drone shot has no sound: no loudness, no transcript, as the real look answers a silent file.
      const drone = await p.run("inspect_media", { media_ref: "DJI_0142.MP4" });
      expect(drone).toMatchObject({ ok: true, media_ref: T.bay, loudness: null, transcript: null });
    } finally {
      await p.close();
    }
  });

  it("a look at a placed clip answers in project frames, over the part the clip plays", async () => {
    const seed = placedProject(TRIP, [T.lane, T.harbourTalk]);
    // The second clip plays source 2-9 s from frame 270, its sound with it.
    for (const tr of seed.tracks)
      tr.clips = (tr.clips ?? []).map((c) =>
        c.media_ref === T.harbourTalk
          ? { ...c, source_in: 60, source_out: 270, timeline_out: 480 }
          : c,
      );
    const p = await footageProject(TRIP, seed);
    try {
      const r = await p.run("inspect_media", { clip_id: "c02" });
      expect(r).toMatchObject({ ok: true, timing: "project_frames", window_s: [2, 9] });
      const segments = (r.transcript as { segments: [string, number, number][] }).segments;
      // The clip plays source 2-9 s from frame 270: the second sentence (2.9-6.6 s) lands at 297-408.
      expect(segments).toContainEqual([
        "We only got here last night and the water is unreal.",
        297,
        408,
      ]);
      expect(segments.every(([, a]) => a >= 270)).toBe(true);
    } finally {
      await p.close();
    }
  });

  it("a look at the timeline says what each frame shows: the top shot at that moment, text over it, or black", async () => {
    const seed = placedProject(TRIP, [T.lane, T.jump]);
    // The jump plays from 4 s of its source, at frame 270; a title sits over its first second.
    for (const tr of seed.tracks)
      tr.clips = (tr.clips ?? []).map((c) =>
        c.media_ref === T.jump ? { ...c, source_in: 120, source_out: 450, timeline_out: 600 } : c,
      );
    seed.tracks.push({
      id: "t1",
      kind: "text",
      z: 2,
      clips: [{ id: "title", kind: "text", content: "Jump!", timeline_in: 270, timeline_out: 300 }],
    });
    const p = await footageProject(TRIP, seed);
    try {
      const at = async (f: number) =>
        ((await p.run("inspect_timeline", { start_frame: f })).frames as { shows: string }[])[0]
          .shows;
      expect(await at(100)).toMatch(/^a walking shot through a narrow old-town lane/);
      // Frame 280 is 4.33 s into the jump: still the countdown on the rock, under the title.
      expect(await at(280)).toMatch(/the text "Jump!", with a man standing on a high rock/);
      // Frame 330 is 6 s into the jump.
      expect(await at(330)).toMatch(/^the man jumping feet first/);
      expect((await p.run("inspect_timeline", { start_frame: 5000 })).ok).toBe(false);
    } finally {
      await p.close();
    }
  });

  it("refuses an absolute path or a parent escape as a look's subject, as the app does", async () => {
    const p = await footageProject(TRIP);
    try {
      for (const ref of [
        "C:/Users/me/Videos/IMG_3307.MOV",
        "../IMG_3307.MOV",
        "/home/me/IMG_3307.MOV",
      ]) {
        const r = await p.run("inspect_media", { media_ref: ref });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/media not found/);
      }
    } finally {
      await p.close();
    }
  });

  it("lists the library as the real tools do, and a clip on disk joins it once imported", async () => {
    const onDisk: Footage = {
      clips: [
        ...LESSON.clips.slice(0, 2),
        { ...LESSON.clips[2], path: "D:/Lessons/take3.mp4", inLibrary: false },
      ],
    };
    const p = await footageProject(onDisk);
    try {
      const list = await p.run("library_op", { action: "list" });
      expect((list.clips as { id: string }[]).map((c) => c.id)).toEqual([P.intro, P.wheel]);
      const state = await p.run("get_project_state");
      expect(state.library_count).toBe(2);
      expect((state.library as Record<string, unknown>[])[0]).toEqual({
        media_ref: P.intro,
        filename: "MVI_1001.MP4",
        kind: "video",
        folder: null,
      });
      expect((await p.run("inspect_media", { media_ref: P.tyre })).ok).toBe(false);
      const imported = await p.run("import_media", { source: { path: "d:\\lessons\\" } });
      expect(imported).toMatchObject({
        ok: true,
        count: 1,
        imported: [{ media_ref: P.tyre, existed: false }],
      });
      expect(((await p.run("library_op", { action: "list" })).clips as unknown[]).length).toBe(3);
      expect(
        (await p.run("import_media", { source: { path: "D:/Lessons/take3.mp4" } })).existed,
      ).toBe(true);
      expect((await p.run("import_media", { source: { path: "D:/Elsewhere" } })).error).toMatch(
        /no file or directory/,
      );
    } finally {
      await p.close();
    }
  });

  it("the probe gives each file its own length and sound: placed whole, a clip runs its length, with linked audio only if it has sound", async () => {
    const p = await footageProject(TRIP);
    try {
      const r = await p.run("add_clips", {
        entries: [
          { media_ref: T.bay, timeline_in: 0 },
          { media_ref: T.cat, timeline_in: 420 },
        ],
      });
      expect(r.ok).toBe(true);
      const tl = await p.timeline();
      const clips = tl.tracks.flatMap((t) =>
        (t.clips ?? []).map((c) => ({
          ref: c.media_ref,
          kind: c.kind,
          len: c.timeline_out - c.timeline_in,
        })),
      );
      expect(clips).toEqual(
        expect.arrayContaining([
          { ref: T.bay, kind: "video", len: 420 },
          { ref: T.cat, kind: "video", len: 240 },
          { ref: T.cat, kind: "audio", len: 240 },
        ]),
      );
      // The drone shot has no sound, so no linked audio; and the first video set the frame to its own 4K size.
      expect(clips.filter((c) => c.ref === T.bay)).toHaveLength(1);
      expect(tl.canvas).toMatchObject({ width: 3840, height: 2160 });
    } finally {
      await p.close();
    }
  });

  it("get_transcript reads the words through each clip's trim and position; add_captions captions them", async () => {
    const seed = placedProject(BAKE, [V.mix, V.crustTalk]);
    const p = await footageProject(BAKE, seed);
    try {
      const t = await p.run("get_transcript");
      const rows = (t.clips as { words: [number, string, number, number][] }[]).flatMap(
        (c) => c.words,
      );
      // crustTalk starts at frame 240: "Look at that crust!" (0.7-2.1 s) is four words from frame 261.
      expect(rows.slice(0, 2)).toEqual([
        [0, "Look", 261, 272],
        [1, "at", 272, 282],
      ]);
      expect(t.word_count).toBe(
        footageWordRows(BAKE.clips.find((c) => c.media_ref === V.crustTalk)!).length,
      );
      const cap = await p.run("add_captions");
      expect(cap.ok).toBe(true);
      const tl = await p.timeline();
      const captions = tl.tracks.flatMap((tr) => (tr.clips ?? []).filter((c) => c.kind === "text"));
      expect(captions.length).toBeGreaterThanOrEqual(2);
      // Each caption sits over its words: none starts before the speech or after the clip.
      for (const c of captions) {
        expect(c.timeline_in).toBeGreaterThanOrEqual(255);
        expect(c.timeline_out).toBeLessThanOrEqual(240 + 13 * 30);
      }
      // A clip with no speech gives no words.
      const none = await p.run("get_transcript", { clip_id: "c01" });
      expect(none.word_count).toBe(0);
    } finally {
      await p.close();
    }
  });

  it("the paid looks keep their 30-minute limits", async () => {
    const long: Footage = {
      clips: [
        {
          media_ref: "media_0123456789ab",
          filename: "talk.mp4",
          kind: "video",
          duration_s: 5400,
          audio: true,
          shots: [{ from: 0, to: 5400, shows: "a talk" }],
        },
      ],
    };
    const p = await footageProject(long);
    try {
      expect(
        (await p.run("video_find_moment", { media_ref: "talk.mp4", query: "the talk" })).error,
      ).toMatch(/video too long for video_find_moment \(5400s/);
      expect(
        (await p.run("video_ask", { media_ref: "talk.mp4", prompt: "what happens?" })).error,
      ).toMatch(/too long for video_ask/);
      const windowed = await p.run("video_ask", {
        media_ref: "talk.mp4",
        prompt: "what happens?",
        start_seconds: 60,
        end_seconds: 120,
      });
      expect(windowed).toMatchObject({ ok: true, window_s: [60, 120] });
    } finally {
      await p.close();
    }
  });

  it("footageRunner answers only for the footage, and leaves every other file to the probe it wraps", async () => {
    const runner = footageRunner(TRIP, harnessProbeRunner);
    expect(
      (
        await runner.run("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "csv=p=0",
          T.sunset,
        ])
      ).stdout,
    ).toBe("16");
    expect(
      (
        await runner.run("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "a",
          "-show_entries",
          "stream=index",
          "-of",
          "csv=p=0",
          T.waves,
        ])
      ).stdout,
    ).toBe("");
    expect(
      (
        await runner.run("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "v",
          "-show_entries",
          "stream=index",
          "-of",
          "csv=p=0",
          T.song,
        ])
      ).stdout,
    ).toBe("");
    const other = await runner.run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      "outro.mp4",
    ]);
    expect(other).toEqual(
      await harnessProbeRunner.run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        "outro.mp4",
      ]),
    );
  });
});

// ── the checks are about the outcome, not the route ────────────────────────────────────

describe("the checks read the final project, whichever tools made it", () => {
  it("captions typed by hand over the right words pass the caption check as add_captions does", async () => {
    // The same 42 s vlog, captioned with get_transcript + add_text_clips instead of add_captions.
    const steps = correct("wv_tiktok_captions_vlog");
    const byHand: Step[] = [
      ...steps.slice(0, 3),
      { calls: [["get_transcript", {}]] },
      {
        calls: (req) => {
          const words = (
            (req.round_input.tool_results?.[0]?.result.clips ?? []) as {
              words: [number, string, number, number][];
            }[]
          ).flatMap((c) => c.words);
          return [
            [
              "add_text_clips",
              {
                entries: words.map(([, text, a, b]) => ({
                  content: text,
                  timeline_in: a,
                  timeline_out: Math.max(b, a + 1),
                })),
              },
            ],
          ];
        },
      },
      { text: "Captioned every word." },
    ];
    const r = await drive(byId("wv_tiktok_captions_vlog"), byHand);
    expect(why(r)).toBe("");
    expect(r.passed).toBe(true);
  });

  it("a do-nothing run fails each case on what it asked for, not on a crash", () => {
    const nothing: Trace = {
      toolCalls: [],
      reasoning: [],
      rounds: 1,
      finalText: "Done.",
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
    };
    for (const s of GAP_WHOLEVIDEO) {
      const g = gradeRun(s, s.seed(), s.seed(), nothing);
      expect(g.passed, s.id).toBe(false);
      expect(g.tier1.violations.join(), s.id).not.toMatch(/TypeError|undefined|NaN/);
    }
  });
});
