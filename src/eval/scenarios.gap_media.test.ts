// The gap_media cases (highlights from long footage, bringing media in and laying it out), offline:
//   - what the footage stand-ins show the agent is enough to do each task: the facts a check grades
//     (a goal's second, who is on screen, a question's words, a folder's order) are in the replies;
//   - each case's checks REJECT a plausible wrong run, not only a run that does nothing: every case
//     has at least one realistic wrong run here, driven through the real harness, loop, tools,
//     stand-ins and oracle with the model's rounds scripted. No network and no model is reached.
// The correct runs are each case's `reference`, replayed by scenarios.reference.test.ts.
import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORT_NOTE_MARK } from "../agent/importNote";
import type { ToolResultItem } from "../agent/types";
import { driveScripted, type ReferenceCalls, type ReferenceStep } from "./reference";
import { GAP_MEDIA_SCENARIOS, keepOnly, placeImported, placeSpans } from "./scenarios/gap_media";
import {
  BROLL,
  CEREMONY,
  DAY2,
  DRONE,
  GARDEN,
  GIG,
  HARBOUR,
  LECTURE,
  LIGHTHOUSE,
  LISBON,
  MATCH,
  PANEL,
  PANEL_CLIP,
  PIANO,
  PODCAST,
  QUAY,
  SCENES,
  SHOOT,
  SKATE,
  SMALL_LIBRARY,
  STREAM,
  TAKES,
  TRIP,
  TUTORIAL,
  VOICE,
  ANGLES,
  type Span,
} from "./scenarios/gap_media_footage";
import type { Scenario } from "./types";

const WORK = path.resolve("reports", "eval", `gap-media-${process.pid}`);
const FPS = 30;
const fr = (s: number) => Math.round(s * FPS);

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("network blocked in the gap_media eval test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy, "a scripted run reached the network").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(() => fsp.rm(WORK, { recursive: true, force: true }));

const byId = (id: string): Scenario => {
  const s = GAP_MEDIA_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no gap_media case ${id}`);
  return s;
};
const step = (...calls: ReferenceCalls): ReferenceStep => ({ calls });
const say = (text: string): ReferenceStep => ({ text });

/** Every violation a run collected, one per line (empty when it passed). */
async function run(id: string, steps: ReferenceStep[]) {
  const { result, requests } = await driveScripted(byId(id), steps, { workDir: WORK });
  const why = [
    ...(result.harnessError ? [`harness: ${result.harnessError}`] : []),
    ...result.tier0.violations,
    ...result.tier1.violations,
    ...(result.harm?.violations ?? []),
  ].join("\n");
  return { passed: result.passed, why, requests, result };
}
/** The replies the model was sent in round `round` (0-based), by tool. */
const repliesIn = (
  requests: { round_input: { tool_results?: ToolResultItem[] } }[],
  round: number,
) => requests[round]?.round_input.tool_results ?? [];

// ── the facts are in what the agent is shown ──────────────────────────────────────────────────

describe("what a look shows is enough to do the task", () => {
  it("the match's overview shows every goal at the second its shot starts", async () => {
    const { requests } = await run("hl_our_goals_only", [
      step(["inspect_media", { media_ref: MATCH.ref, overview: true }]),
      say("Looked."),
    ]);
    const look = repliesIn(requests, 1)[0].result;
    const times = (look.overview as { tile_times: number[] }).tile_times;
    for (const g of MATCH.goals) expect(times).toContain(g.shot[0]);
    const note = String(look.note);
    expect(note).toMatch(/at 785 s, the blue number 9 .*into the top corner/);
    expect(note).toMatch(/at 2320 s, a corner for red: a red player heads the ball in/);
    expect(note).toMatch(/at 4280 s, a penalty for blue/);
    expect(note).toMatch(/at 5290 s, the blue number 7 shoots/);
  });

  it("the panel names Mara once, on a lower third, then shows her by her blazer, in frames for a clip", async () => {
    const { requests } = await run("hl_named_speaker", [
      step(["inspect_media", { clip_id: "full", overview: true }]),
      say("Looked."),
    ]);
    const look = repliesIn(requests, 1)[0].result;
    const tiles = (look.overview as { tile_frames: number[] }).tile_frames;
    for (const [a] of PANEL.mara) expect(tiles).toContain(fr(a));
    const note = String(look.note);
    expect(note).toMatch(
      /frame 7200, close-up of the woman on the left of the stage in a grey blazer, speaking; the lower third reads 'Mara Lindqvist/,
    );
    expect(note).toMatch(
      /frame 38100, close-up of the woman on the left in the grey blazer, speaking/,
    );
    expect(note).toMatch(/frame 93600, a member of the audience at the microphone/);
  });

  it("the panel's transcript has each question from the floor, in source seconds", async () => {
    const { requests } = await run("hl_qa_questions_only", [
      step(["inspect_media", { media_ref: PANEL.ref, start_seconds: 2800, end_seconds: 4000 }]),
      say("Read it."),
    ]);
    const segs = (
      repliesIn(requests, 1)[0].result.transcript as { segments: [string, number, number][] }
    ).segments;
    for (const [a] of PANEL.asked) {
      const q = segs.find(([, s]) => s === a);
      expect(q?.[0], `a question starts at ${a} s`).toMatch(/\?$/);
    }
  });

  it("the podcast's words say where bread pricing is, and a long video is too long for the paid search", async () => {
    const pricing = await run("hl_topic_30s", [
      step(["inspect_media", { media_ref: PODCAST.ref, start_seconds: 1200, end_seconds: 2700 }]),
      say("Read it."),
    ]);
    const segs = (
      repliesIn(pricing.requests, 1)[0].result.transcript as {
        segments: [string, number, number][];
      }
    ).segments;
    expect(segs).toContainEqual([
      "For bread it's simple: we price by the weight of the loaf.",
      1832,
      1839,
    ]);
    const stream = await run("hl_finder_too_long", [
      step(["video_find_moment", { clip_id: "full", query: "the dragon dies" }]),
      step(["inspect_media", { clip_id: "full", overview: true }]),
      say("Looked."),
    ]);
    expect(String(repliesIn(stream.requests, 1)[0].result.error)).toMatch(
      /video too long for video_find_moment/,
    );
    expect(String(repliesIn(stream.requests, 2)[0].result.note)).toMatch(
      new RegExp(`frame ${fr(STREAM.dragonFalls)}, the dragon collapses, a 'VICTORY' banner`),
    );
  });

  it("the drone footage has no words, and only its pictures tell the red sailing boat from another boat", async () => {
    const { requests } = await run("hl_boat_shots", [
      step(["inspect_media", { media_ref: DRONE.ref, overview: true }]),
      say("Looked."),
    ]);
    const look = repliesIn(requests, 1)[0].result;
    expect(look.transcript).toBeNull();
    const note = String(look.note);
    for (const [a] of DRONE.boat) expect(note).toContain(`at ${a} s, `);
    expect(note.match(/red sailing boat/g)).toHaveLength(3);
    expect(note).toMatch(/at 900 s, a white motorboat/);
  });

  it("a folder imports in plain name order, so take 10 comes before take 2", async () => {
    const { requests } = await run("lay_takes_number_order", [
      step(["import_media", { source: { path: "E:\\Shoot\\takes\\" } }]),
      say("Imported."),
    ]);
    const files = (repliesIn(requests, 1)[0].result.imported as { filename: string }[]).map(
      (f) => f.filename,
    );
    expect(files.slice(0, 4)).toEqual(["take 1.mp4", "take 10.mp4", "take 11.mp4", "take 2.mp4"]);
    expect(files).toHaveLength(TAKES.length);
  });

  it("re-importing a folder says which files were already in the library", async () => {
    const { requests } = await run("imp_new_files_only", [
      step(["import_media", { source: { path: "d:/footage/HARBOUR" } }]),
      say("Imported."),
    ]);
    const imported = repliesIn(requests, 1)[0].result.imported as {
      media_ref: string;
      existed: boolean;
    }[];
    expect(imported.map((f) => [f.media_ref, f.existed])).toEqual(
      HARBOUR.map(([ref], i) => [ref, i < 4]),
    );
  });

  it("the import-note case carries the app's own note, naming the two files still coming in", () => {
    const prompt = byId("imp_note_still_importing").prompt;
    expect(prompt.startsWith("Put all my garden clips on the timeline in order.\n\n")).toBe(true);
    expect(prompt).toContain(IMPORT_NOTE_MARK);
    for (const name of GARDEN.importing) expect(prompt).toContain(name);
    expect(prompt).toMatch(/Do not import these files again/);
  });

  it("the narration's words give each sentence's frames, and the song's look gives its length", async () => {
    const words = await run("lay_photos_to_narration", [
      step(["get_transcript", {}]),
      say("Read it."),
    ]);
    const rows = (
      repliesIn(words.requests, 1)[0].result.clips as {
        words: [number, string, number, number][];
      }[]
    )[0].words;
    const starts = LIGHTHOUSE.sentences.map(([a]) => fr(a));
    for (const s of starts)
      expect(
        rows.some(([, , f]) => f === s),
        `a word starts at frame ${s}`,
      ).toBe(true);
    const song = await run("lay_slideshow_to_song", [
      step(["inspect_media", { media_ref: QUAY.song.ref }]),
      say("Looked."),
    ]);
    expect(repliesIn(song.requests, 1)[0].result.duration_s).toBe(QUAY.song.seconds);
  });
});

// ── a plausible wrong run fails each case ─────────────────────────────────────────────────────

const overviewClip = step(["inspect_media", { clip_id: "full", overview: true }]);
const overviewOf = (ref: string) => step(["inspect_media", { media_ref: ref, overview: true }]);
const listLibrary = step(["library_op", { action: "list" }]);
const goalsAround = (
  before: number,
  after: number,
  goals: readonly (typeof MATCH.goals)[number][] = MATCH.goals,
): Span[] => goals.map((g): Span => [g.at - before, g.at + after]);

/** Each case's wrong runs: what a plausible agent gets wrong, and the violation that must catch it. */
const WRONG: Record<string, { what: string; why: RegExp; steps: ReferenceStep[] }[]> = {
  hl_every_goal: [
    {
      what: "misses the last goal",
      why: /goal 4 .* is not all kept/,
      steps: [
        overviewClip,
        keepOnly(goalsAround(12, 8, MATCH.goals.slice(0, 3)), MATCH.seconds),
        say("Done."),
      ],
    },
    {
      what: "keeps a minute around each goal",
      why: /runs 60\.0 s on screen/,
      steps: [overviewClip, keepOnly(goalsAround(40, 20), MATCH.seconds), say("Done.")],
    },
  ],
  hl_our_goals_only: [
    {
      what: "keeps the other team's goal too",
      why: /from outside what was asked for/,
      steps: [
        overviewOf(MATCH.ref),
        placeSpans(goalsAround(12, 8).map(([a, b]) => [MATCH.ref, a, b] as const)),
        say("Done."),
      ],
    },
  ],
  hl_best_of_45s: [
    {
      what: "runs a minute",
      why: /runs 60\.0 s; the request asks for 10-45 s/,
      steps: [
        overviewOf(MATCH.ref),
        placeSpans(
          goalsAround(10, 10)
            .slice(0, 3)
            .map(([a, b]) => [MATCH.ref, a, b] as const),
        ),
        say("Done."),
      ],
    },
    {
      what: "fills it with open play",
      why: /from outside what was asked for/,
      steps: [
        overviewOf(MATCH.ref),
        placeSpans([
          [MATCH.ref, 300, 315],
          [MATCH.ref, 1500, 1515],
        ]),
        say("Done."),
      ],
    },
  ],
  hl_cut_halftime: [
    {
      what: "cuts fifteen minutes from the wrong place",
      why: /the first half .* is not all kept/,
      steps: [
        overviewClip,
        keepOnly(
          [
            [0, 2400],
            [3300, MATCH.seconds],
          ],
          MATCH.seconds,
        ),
        say("Done."),
      ],
    },
  ],
  hl_named_speaker: [
    {
      what: "keeps only her opening statement",
      why: /Mara's turn 2 .* is not all kept/,
      steps: [overviewClip, keepOnly([PANEL.mara[0] as Span], PANEL.seconds), say("Done.")],
    },
    {
      what: "keeps a minute of whoever speaks after her each time",
      why: /from outside what was asked for/,
      steps: [
        overviewClip,
        keepOnly(
          PANEL.mara.map(([a, b]): Span => [a, b + 60]),
          PANEL.seconds,
        ),
        say("Done."),
      ],
    },
  ],
  hl_qa_questions_only: [
    {
      what: "keeps the questions with their answers",
      why: /from outside what was asked for/,
      steps: [overviewOf(PANEL.ref), placeSpans([[PANEL.ref, 3120, 3990]]), say("Done.")],
    },
  ],
  hl_find_one_demo: [
    {
      what: "keeps the other prop, the model of the Moon",
      why: /the water-tank demonstration .* is not all kept/,
      steps: [overviewClip, keepOnly([[2880, 2960]], LECTURE.seconds), say("Done.")],
    },
  ],
  hl_ceremony_moments: [
    {
      what: "puts the kiss before the rings",
      why: /the kiss plays before the rings/,
      steps: [
        overviewOf(CEREMONY.ref),
        placeSpans([
          [CEREMONY.ref, 440, 480],
          [CEREMONY.ref, 1500, 1680],
          [CEREMONY.ref, 1798, 1815],
          [CEREMONY.ref, 1700, 1745],
        ]),
        say("Done."),
      ],
    },
    {
      what: "keeps the readings as well",
      why: /from outside what was asked for/,
      steps: [
        overviewOf(CEREMONY.ref),
        placeSpans([
          [CEREMONY.ref, 440, 480],
          [CEREMONY.ref, 900, 1680],
          [CEREMONY.ref, 1700, 1745],
          [CEREMONY.ref, 1798, 1815],
        ]),
        say("Done."),
      ],
    },
  ],
  hl_teaser_followup: [
    {
      what: "adds the kiss at the end, not first",
      why: /the vows plays before the kiss/,
      steps: [
        overviewClip,
        keepOnly([CEREMONY.vows as Span, CEREMONY.rings as Span], CEREMONY.seconds),
        say("Done."),
        step([
          "add_clips",
          {
            entries: [{ media_ref: CEREMONY.ref, timeline_in: fr(270), source_span: [1798, 1815] }],
          },
        ]),
        say("Added the kiss."),
      ],
    },
  ],
  hl_finder_too_long: [
    {
      what: "keeps the first, lost try at the dragon",
      why: /the fight that was won .* is not all kept/,
      steps: [
        step(["video_find_moment", { clip_id: "full", query: "dragon fight" }]),
        overviewClip,
        keepOnly([STREAM.lost[0] as Span], STREAM.seconds),
        say(
          "The AI search can't take a video over 30 minutes, so I looked through it myself and kept the dragon fight.",
        ),
      ],
    },
    {
      what: "cuts right but says the search found it",
      why: /does not tell the person the moment search cannot take a video this long/,
      steps: [
        step(["video_find_moment", { clip_id: "full", query: "dragon fight" }]),
        overviewClip,
        keepOnly([STREAM.win as Span], STREAM.seconds),
        say(
          "The moment search found where you beat the dragon, and the stream is cut down to that fight.",
        ),
      ],
    },
    {
      what: "asks the search again after it refused",
      why: /2 tool call\(s\) errored \(budget 1\)/,
      steps: [
        step(["video_find_moment", { clip_id: "full", query: "dragon fight" }]),
        step(["video_find_moment", { clip_id: "full", query: "VICTORY banner" }]),
        overviewClip,
        keepOnly([STREAM.win as Span], STREAM.seconds),
        say("The AI search can't take a video over 30 minutes, so I found the fight myself."),
      ],
    },
  ],
  hl_topic_30s: [
    {
      what: "takes the coffee pricing instead",
      why: /how she prices her bread: only 0\.0 s/,
      steps: [placeSpans([[PODCAST.ref, 1300, 1330]]), say("Done.")],
    },
    {
      what: "gives a minute instead of thirty seconds",
      why: /runs 60\.0 s; the request asks for 27-33 s/,
      steps: [placeSpans([[PODCAST.ref, 1830, 1890]]), say("Done.")],
    },
  ],
  hl_topic_recap: [
    {
      what: "takes two bits from the first part and none from the last",
      why: /part 4: only 0\.0 s/,
      steps: [
        overviewClip,
        keepOnly(
          [
            [30, 60],
            [100, 130],
            [1832, 1862],
            [2712, 2742],
          ],
          PODCAST.seconds,
        ),
        say("Done."),
      ],
    },
  ],
  hl_songs_only: [
    {
      what: "drops the encore",
      why: /song 7 .* is not all kept/,
      steps: [
        overviewClip,
        keepOnly(
          GIG.songs.slice(0, 6).map(([a, b]): Span => [a, b]),
          GIG.seconds,
        ),
        say("Done."),
      ],
    },
  ],
  hl_boat_shots: [
    {
      what: "takes the white motorboat for the third boat shot",
      why: /boat shot 3 .* is not all kept/,
      steps: [
        overviewClip,
        keepOnly(
          [
            [410, 470],
            [900, 960],
            [1220, 1300],
          ],
          DRONE.seconds,
        ),
        say("Done."),
      ],
    },
  ],
  hl_three_days_reel: [
    {
      what: "opens with the last day's fireworks",
      why: /the fireworks plays before the whale/,
      steps: [
        placeSpans([
          [TRIP.days[2].ref, 1705, 1720],
          [TRIP.days[0].ref, 1530, 1555],
          [TRIP.days[1].ref, 980, 1000],
        ]),
        say("Done."),
      ],
    },
  ],
  hl_vertical_short_chip: [
    {
      what: "cuts the moments but leaves the canvas wide",
      why: /not 9:16/,
      steps: [
        overviewClip,
        keepOnly(
          [
            [212, 220],
            [640, 650],
            [1590, 1602],
          ],
          SKATE.seconds,
        ),
        say("Done."),
      ],
    },
    {
      what: "goes 9:16 but leaves the picture letterboxed",
      why: /letterboxed/,
      steps: [
        step(["set_project_settings", { size: { aspect_ratio: "9:16" } }]),
        keepOnly(
          [
            [212, 220],
            [640, 650],
            [1590, 1602],
          ],
          SKATE.seconds,
        ),
        say("Done."),
      ],
    },
    {
      what: "pads the short with the waiting between tricks",
      why: /from outside what was asked for/,
      steps: [
        step(["set_project_settings", { size: { aspect_ratio: "9:16" } }]),
        keepOnly(
          [
            [200, 240],
            [640, 650],
            [1590, 1602],
          ],
          SKATE.seconds,
        ),
        step(["get_timeline", {}]),
        {
          calls: (req) => {
            const tl = repliesIn([req], 0)[0].result.timeline as {
              tracks: { kind: string; clips?: { id: string; media_ref?: string }[] }[];
            };
            const ids = tl.tracks
              .filter((t) => t.kind === "video")
              .flatMap((t) => t.clips ?? [])
              .filter((c) => c.media_ref === SKATE.ref)
              .map((c) => c.id);
            return [["set_clip_properties", { clip_ids: ids, fit: "cover" }]];
          },
        },
        say("Done."),
      ],
    },
  ],
  hl_given_timestamps: [
    {
      what: "puts the spans in the order they come in the episode",
      why: /plays before/,
      steps: [
        step(["remove_clips", { clip_ids: ["full"] }]),
        placeSpans([
          [PODCAST.ref, 725, 780],
          [PODCAST.ref, 2490, 2535],
          [PODCAST.ref, 3730, 3820],
        ]),
        say("Done."),
      ],
    },
  ],
  lay_named_order: [
    {
      what: "lays them out in the order the paths were listed",
      why: /the order on the timeline is/,
      steps: [
        step(
          ...[SHOOT.interview, SHOOT.sunset, SHOOT.drone, SHOOT.market].map(
            (s): [string, Record<string, unknown>] => [
              "import_media",
              { source: { path: `D:\\Shoot\\${s.file}` } },
            ],
          ),
        ),
        placeImported([
          SHOOT.interview.file,
          SHOOT.sunset.file,
          SHOOT.drone.file,
          SHOOT.market.file,
        ]),
        say("Done."),
      ],
    },
  ],
  lay_folder_all: [
    {
      what: "places all but the last file",
      why: /media_harbour_06 is on the timeline 0 times/,
      steps: [
        step(["import_media", { source: { path: "D:\\Footage\\harbour" } }]),
        placeImported(HARBOUR.slice(0, 5).map(([, file]) => file)),
        say("Done."),
      ],
    },
  ],
  lay_photos_and_videos: [
    {
      what: "leaves each photo at the default five seconds",
      why: /runs 150 frames; it should run 90/,
      steps: [
        step(["import_media", { source: { path: "D:\\Trip\\lisbon" } }]),
        placeImported(
          LISBON.map((m) => m.file),
          (file) => (file.endsWith(".jpg") ? fr(5) : undefined),
        ),
        say("Done."),
      ],
    },
  ],
  lay_slideshow_to_song: [
    {
      what: "gives each photo five seconds without reading the song's length",
      why: /runs 150 frames; it should run 180/,
      steps: [
        listLibrary,
        step([
          "add_clips",
          {
            entries: [
              ...QUAY.photos.map((ref, i) => ({ media_ref: ref, timeline_in: i * 150 })),
              { media_ref: QUAY.song.ref, timeline_in: 0 },
            ],
          },
        ]),
        say("Done."),
      ],
    },
  ],
  lay_pip_webcam: [
    {
      what: "drops the webcam on the screen recording's own track",
      why: /the screen recording was moved, cut or removed/,
      steps: [
        listLibrary,
        step(["add_clips", { entries: [{ media_ref: TUTORIAL.webcam.ref, timeline_in: 0 }] }]),
        say("Done."),
      ],
    },
    {
      what: "puts it on a track above but full size",
      why: /scaled 1x1/,
      steps: [
        listLibrary,
        step(["add_track", { kind: "video", z: 1 }]),
        {
          calls: (req) => [
            [
              "add_clips",
              {
                entries: [
                  {
                    media_ref: TUTORIAL.webcam.ref,
                    timeline_in: 0,
                    track_id: String(repliesIn([req], 0)[0].result.track_id),
                  },
                ],
              },
            ],
          ],
        },
        say("Done."),
      ],
    },
  ],
  lay_broll_cutaways: [
    {
      what: "keeps the cutaways' own sound",
      why: /a cutaway's own sound plays/,
      steps: [
        step(["import_media", { source: { path: "D:\\Footage\\broll" } }]),
        step(["add_track", { kind: "video", z: 1 }]),
        {
          calls: (req) => [
            [
              "add_clips",
              {
                entries: Object.values(BROLL).map((b) => ({
                  media_ref: b.ref,
                  timeline_in: fr(b.at),
                  duration: fr(5),
                  track_id: String(repliesIn([req], 0)[0].result.track_id),
                })),
              },
            ],
          ],
        },
        say("Done."),
      ],
    },
    {
      what: "splices them into the interview's own track, pushing the rest of it later",
      why: /the interview's (sound no longer plays whole|picture at frame \d+ is out of step)/,
      steps: [
        step(["import_media", { source: { path: "D:\\Footage\\broll" } }]),
        step(
          ...Object.values(BROLL).map((b): [string, Record<string, unknown>] => [
            "insert_clips",
            { at: fr(b.at), entries: [{ media_ref: b.ref, duration: fr(5) }] },
          ]),
        ),
        say("Done."),
      ],
    },
    {
      what: "reads the times as frames",
      why: /bakery_oven\.mp4 starts at frame 10, not at 300/,
      steps: [
        step(["import_media", { source: { path: "D:\\Footage\\broll" } }]),
        step(["add_track", { kind: "video", z: 1 }]),
        {
          calls: (req) => [
            [
              "add_clips",
              {
                entries: Object.values(BROLL).map((b) => ({
                  media_ref: b.ref,
                  timeline_in: b.at,
                  duration: fr(5),
                  track_id: String(repliesIn([req], 0)[0].result.track_id),
                  with_audio: false,
                })),
              },
            ],
          ],
        },
        say("Done."),
      ],
    },
  ],
  lay_black_gaps: [
    {
      what: "lays them back to back",
      why: /starts at frame 300; it should start at 360/,
      steps: [
        listLibrary,
        step([
          "add_clips",
          {
            entries: [
              { media_ref: SCENES[0].ref, timeline_in: 0 },
              { media_ref: SCENES[1].ref, timeline_in: 300 },
              { media_ref: SCENES[2].ref, timeline_in: 540 },
            ],
          },
        ]),
        say("Done."),
      ],
    },
  ],
  lay_day2_by_time: [
    {
      what: "places them in the order the library lists them",
      why: /the order on the timeline is/,
      steps: [
        step(["library_op", { action: "list", folder: "Day 2" }]),
        (() => {
          let at = 0;
          const entries = DAY2.map((d) => {
            const e = { media_ref: d.ref, timeline_in: at };
            at += fr(d.seconds);
            return e;
          });
          return step(["add_clips", { entries }]);
        })(),
        say("Done."),
      ],
    },
  ],
  lay_takes_number_order: [
    {
      what: "places them in the order the folder lists them (take 10 before take 2)",
      why: /the order on the timeline is/,
      steps: [
        step(["import_media", { source: { path: "E:\\Shoot\\takes" } }]),
        placeImported([...TAKES.map((t) => t.filename)].sort((a, b) => a.localeCompare(b))),
        say("Done."),
      ],
    },
  ],
  imp_did_it_import: [
    {
      what: "imports again to answer the question",
      why: /imported again when asked whether the import worked/,
      steps: [
        step(["import_media", { source: { path: "D:\\Footage\\market" } }]),
        say("Done."),
        step(["import_media", { source: { path: "D:\\Footage\\market" } }]),
        say("Yes, all five are in."),
      ],
    },
    {
      what: "puts them on the timeline although asked not to",
      why: /the timeline was changed/,
      steps: [
        step(["import_media", { source: { path: "D:\\Footage\\market" } }]),
        step(["add_clips", { entries: [{ media_ref: "media_market_1", timeline_in: 0 }] }]),
        say("Done."),
        say("Yes, all five are in."),
      ],
    },
    {
      what: "gives the wrong count",
      why: /does not say how many clips came in/,
      steps: [
        step(["import_media", { source: { path: "D:\\Footage\\market" } }]),
        say("Done."),
        say("Yes, all six came in."),
      ],
    },
  ],
  imp_new_files_only: [
    {
      what: "puts the whole folder on again at the end",
      why: /media_harbour_01 is on the timeline 2 times/,
      steps: [
        step(["import_media", { source: { path: "D:\\Footage\\harbour" } }]),
        placeImported(
          HARBOUR.map(([, file]) => file),
          () => undefined,
          HARBOUR.slice(0, 4).reduce((n, [, , s]) => n + fr(s), 0),
        ),
        say("Done."),
      ],
    },
  ],
  imp_note_still_importing: [
    {
      what: "imports the two files that are still importing",
      why: /forbidden_tool/,
      steps: [
        listLibrary,
        step([
          "add_clips",
          {
            entries: GARDEN.inLibrary.map((ref, i) => ({
              media_ref: ref,
              timeline_in: GARDEN.inLibrary.slice(0, i).reduce((n, _, k) => n + fr(6 + k), 0),
            })),
          },
        ]),
        step(["import_media", { source: { path: "D:\\Videos\\garden\\garden_5.mp4" } }]),
        say("Garden 1 to 4 are on; garden_5 and garden_6 are still importing."),
      ],
    },
    {
      what: "places the four and says nothing of the two still coming in",
      why: /does not tell the person that two clips are still coming in/,
      steps: [
        listLibrary,
        step([
          "add_clips",
          {
            entries: GARDEN.inLibrary.map((ref, i) => ({
              media_ref: ref,
              timeline_in: GARDEN.inLibrary.slice(0, i).reduce((n, _, k) => n + fr(6 + k), 0),
            })),
          },
        ]),
        say("Done, all your garden clips are on the timeline in order."),
      ],
    },
  ],
  imp_missing_file: [
    {
      what: "claims the import worked",
      why: /does not say the file could not be found/,
      steps: [
        step(["import_media", { source: { path: "D:\\Exports\\final_cut_v3.mov" } }]),
        say("Imported final_cut_v3 and put it at the start of your timeline."),
      ],
    },
  ],
  lay_everything_in_library: [
    {
      what: "leaves the photos out",
      why: /media_lib_p1\.jpg is on the timeline 0 times/,
      steps: [
        listLibrary,
        (() => {
          let at = 0;
          const entries: Record<string, unknown>[] = SMALL_LIBRARY.videos.map((ref) => {
            const e = { media_ref: ref, timeline_in: at };
            at += fr(
              {
                media_lib_v1: 11,
                media_lib_v2: 15,
                media_lib_v3: 8,
                media_lib_v4: 13,
                media_lib_v5: 10,
              }[ref],
            );
            return e;
          });
          entries.push({ media_ref: SMALL_LIBRARY.song, timeline_in: 0 });
          return step(["add_clips", { entries }]);
        })(),
        say("Done."),
      ],
    },
  ],
  lay_two_angles_stacked: [
    {
      what: "puts the close-up on the lower track",
      why: /the close-up is not on the upper track/,
      steps: [
        listLibrary,
        step(["add_clips", { entries: [{ media_ref: ANGLES.close.ref, timeline_in: 0 }] }]),
        step(["add_track", { kind: "video", z: 5 }]),
        {
          calls: (req) => [
            [
              "add_clips",
              {
                entries: [
                  {
                    media_ref: ANGLES.wide.ref,
                    timeline_in: 0,
                    track_id: String(repliesIn([req], 0)[0].result.track_id),
                  },
                ],
              },
            ],
          ],
        },
        say("Done."),
      ],
    },
  ],
  lay_voice_and_music: [
    {
      what: "leaves the piano running past the end of the voice",
      why: /the piano ends at frame 5400/,
      steps: [
        step(
          ["import_media", { source: { path: "D:\\Audio\\voiceover_final.wav" } }],
          ["import_media", { source: { path: "D:\\Audio\\calm_piano.mp3" } }],
        ),
        step(["add_clips", { entries: [{ media_ref: VOICE.ref, timeline_in: 0 }] }]),
        step(["add_track", { kind: "audio" }]),
        {
          calls: (req) => [
            [
              "add_clips",
              {
                entries: [
                  {
                    media_ref: PIANO.ref,
                    timeline_in: 0,
                    track_id: String(repliesIn([req], 0)[0].result.track_id),
                  },
                ],
              },
            ],
          ],
        },
        {
          calls: (req) => [
            [
              "set_clip_properties",
              {
                clip_ids: (repliesIn([req], 0)[0].result.created as { clip_id: string }[]).map(
                  (c) => c.clip_id,
                ),
                volume: 0.3,
              },
            ],
          ],
        },
        say("Done."),
      ],
    },
    {
      what: "leaves the piano as loud as the voice",
      why: /not quieter/,
      steps: [
        step(
          ["import_media", { source: { path: "D:\\Audio\\voiceover_final.wav" } }],
          ["import_media", { source: { path: "D:\\Audio\\calm_piano.mp3" } }],
        ),
        step(["add_clips", { entries: [{ media_ref: VOICE.ref, timeline_in: 0 }] }]),
        step(["add_track", { kind: "audio" }]),
        {
          calls: (req) => [
            [
              "add_clips",
              {
                entries: [
                  {
                    media_ref: PIANO.ref,
                    timeline_in: 0,
                    timeline_out: fr(VOICE.seconds),
                    track_id: String(repliesIn([req], 0)[0].result.track_id),
                  },
                ],
              },
            ],
          ],
        },
        say("Done."),
      ],
    },
  ],
  lay_photos_to_narration: [
    {
      what: "splits the narration into five equal slots without reading it",
      why: /photo 2 .* is on screen for only/,
      steps: [
        step([
          "add_clips",
          {
            entries: LIGHTHOUSE.photos.map((ref, i) => ({
              media_ref: ref,
              timeline_in: i * 240,
              timeline_out: (i + 1) * 240,
            })),
          },
        ]),
        say("Done."),
      ],
    },
  ],
};

describe("a plausible wrong run fails each case", () => {
  it("every case has at least one wrong run here", () => {
    const missing = GAP_MEDIA_SCENARIOS.map((s) => s.id).filter((id) => !WRONG[id]?.length);
    expect(missing).toEqual([]);
    expect(
      Object.keys(WRONG).filter((id) => !GAP_MEDIA_SCENARIOS.some((s) => s.id === id)),
    ).toEqual([]);
  });

  for (const [id, wrongs] of Object.entries(WRONG))
    for (const w of wrongs)
      it(`${id}: ${w.what}`, async () => {
        const { passed, why } = await run(id, w.steps);
        expect(passed, `${id} passed a run that ${w.what}`).toBe(false);
        expect(why).toMatch(w.why);
      });
});

// The checks grade the outcome, not one route to it: other right ways of doing a task pass too.
describe("another right way to do the task passes", () => {
  const maraWords: Span[] = PANEL.mara.map(([a, b]) => {
    const rows = (PANEL_CLIP.words ?? []).filter(([, s, e]) => s >= a && e <= b);
    return [Math.min(...rows.map((r) => r[1])), Math.max(...rows.map((r) => r[2]))];
  });
  const RIGHT: Record<string, { what: string; steps: ReferenceStep[] }> = {
    hl_every_goal: {
      what: "keeps each goal's whole shot, as the overview shows it",
      steps: [
        overviewClip,
        keepOnly(
          MATCH.goals.map((g) => g.shot as Span),
          MATCH.seconds,
        ),
        say("Done."),
      ],
    },
    hl_named_speaker: {
      what: "cuts from her first word to her last in each turn, as the transcript shows them",
      steps: [step(["get_transcript", {}]), keepOnly(maraWords, PANEL.seconds), say("Done.")],
    },
    hl_songs_only: {
      what: "cuts by the sung lines",
      steps: [
        step(["get_transcript", {}]),
        keepOnly(
          GIG.songs.map(([a, b]): Span => [a + 2, b - 1]),
          GIG.seconds,
        ),
        say("Done."),
      ],
    },
    hl_ceremony_moments: {
      what: "keeps the vows from the first word to the last",
      steps: [
        placeSpans([
          [CEREMONY.ref, 430, 470],
          [CEREMONY.ref, 1505, 1679],
          [CEREMONY.ref, 1710, 1760],
          [CEREMONY.ref, 1791, 1815],
        ]),
        say("Done."),
      ],
    },
    lay_broll_cutaways: {
      what: "overwrites the interview's picture on its own track, keeping its sound",
      steps: [
        step(["import_media", { source: { path: "D:\\Footage\\broll" } }]),
        step([
          "add_clips",
          {
            entries: Object.values(BROLL).map((b) => ({
              media_ref: b.ref,
              timeline_in: fr(b.at),
              duration: fr(5),
              with_audio: false,
            })),
          },
        ]),
        say("Done."),
      ],
    },
  };
  for (const [id, r] of Object.entries(RIGHT))
    it(`${id}: ${r.what}`, async () => {
      const { passed, why } = await run(id, r.steps);
      expect(why).toBe("");
      expect(passed).toBe(true);
    });
});

describe("each case is tagged and declared as the gap set needs", () => {
  for (const s of GAP_MEDIA_SCENARIOS)
    it(s.id, () => {
      const tags = s.tags ?? [];
      expect(tags.filter((t) => t === "gap:highlights" || t === "gap:import-layout")).toHaveLength(
        1,
      );
      expect(tags).toContain("lang:en");
      expect(tags).toContain(`turns:${1 + (s.followUps?.length ?? 0)}`);
      const clips = tags.find((t) => t.startsWith("clips:"));
      const placed = (s.seed().tracks ?? []).flatMap((t) => t.clips ?? []);
      const onTimeline = new Set(placed.map((c) => c.media_ref));
      const libraryOnly = (s.footage?.clips ?? []).filter(
        (c) => c.inLibrary !== false && !onTimeline.has(c.media_ref),
      );
      expect(clips, "clips:N counts the seed's clips plus the library media not on it").toBe(
        `clips:${placed.length + libraryOnly.length}`,
      );
      expect(s.surface).toBe("studio");
      expect(s.footage?.clips.length).toBeGreaterThan(0);
    });
});
