// The cases in other languages (scenarios/gap_languages.ts), proven offline. Each case's correct run
// (its `reference`) is replayed by scenarios.reference.test.ts with every other case's; here a
// realistic wrong run of each case is driven through the same real harness (reference.ts
// driveScripted: real agent loop, real timeline tools and stand-ins, real oracle, the model's rounds
// scripted) and must fail for the reason named, so every check is shown to reject a plausible wrong
// result and not only a run that does nothing. No network and no model is reached: fetch is a spy
// that throws, checked after every test.
//
// The reply-language module (language.ts) is tested here too, in both directions: a reply in the
// person's language passes, and an English reply, a reply in a neighbouring language, or an English
// reply that only quotes the person's words fails.
import { promises as fsp } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LANGS,
  markerScores,
  prose,
  readable,
  shows,
  unaccented,
  writtenIn,
  type Lang,
} from "./language";
import { driveScripted, type ReferenceCalls, type ReferenceStep } from "./reference";
import { ALL_SCENARIOS } from "./scenarios";
import {
  GAP_LANGUAGES,
  MUSIC_LANDED,
  textIdsRead,
  VOICEOVER_LANDED,
} from "./scenarios/gap_languages";
import { STUDIO_MUSIC_REF, STUDIO_VOICEOVER_REF } from "./studio";
import type { Scenario } from "./types";

const WORK = path.resolve("reports", "eval", `gap-languages-${process.pid}`);
const byId = (id: string): Scenario => {
  const s = GAP_LANGUAGES.find((c) => c.id === id);
  if (!s) throw new Error(`no case ${id}`);
  return s;
};
/** A case's correct run (its reference). */
const refOf = (id: string): ReferenceStep[] => byId(id).reference ?? [];

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

/** Drive a case with a scripted run through the real harness, and say everything the grade found. */
async function drive(scenario: Scenario, steps: readonly ReferenceStep[]) {
  const { result } = await driveScripted(scenario, steps, { workDir: WORK });
  const why = [
    ...(result.harnessError ? [`harness: ${result.harnessError}`] : []),
    ...result.tier0.violations,
    ...result.tier1.violations,
    ...(result.harm?.violations ?? []),
  ];
  return { result, why };
}

const crossfade = (clip: string, frames: number): ReferenceCalls[number] => [
  "set_transition",
  { clip_id: clip, transition_in: { kind: "crossfade", duration: frames } },
];

const addText = (entries: Record<string, unknown>[]): ReferenceStep => ({
  calls: [["add_text_clips", { entries }]],
});

/** A step list with one step replaced: the correct run, done wrong in one way. */
const but = (id: string, at: number, step: ReferenceStep): ReferenceStep[] =>
  refOf(id).map((s, i) => (i === at ? step : s));

// ── realistic wrong runs: each must fail, for the reason named ──────────────

interface Wrong {
  id: string;
  /** What the run did wrong, as a person would put it. */
  did: string;
  steps: ReferenceStep[];
  /** What the grade must say. */
  says: RegExp;
}

const WRONG: Wrong[] = [
  // single edits
  {
    id: "lang_ru_trim_number_word",
    did: "read 'полутора' as one second",
    steps: but("lang_ru_trim_number_word", 0, {
      calls: [["set_clip_properties", { clip_ids: ["a"], duration: 30 }]],
    }),
    says: /length in frames/,
  },
  {
    id: "lang_ru_trim_number_word",
    did: "made the edit and answered in English",
    steps: but("lang_ru_trim_number_word", 1, { text: "Done: the clip is now 1.5 seconds long." }),
    says: /not in Russian/,
  },
  {
    id: "lang_uk_last_clip_first",
    did: "answered in Russian",
    steps: but("lang_uk_last_clip_first", 1, {
      text: "Переставил последний клип в начало, остальные идут за ним.",
    }),
    says: /not in Ukrainian.*Russian/,
  },
  {
    id: "lang_uk_last_clip_first",
    did: "swapped the first and the last clip",
    steps: but("lang_uk_last_clip_first", 0, {
      calls: [
        [
          "move_clips",
          {
            moves: [
              { clip_id: "c", to_timeline_in: 0 },
              { clip_id: "a", to_timeline_in: 120 },
            ],
          },
        ],
      ],
    }),
    says: /asked for c, a, b/,
  },
  {
    id: "lang_tr_typed_without_letters",
    did: "cut the start instead of the end",
    steps: but("lang_tr_typed_without_letters", 0, {
      calls: [["ripple_delete", { track_id: "v1", start: 0, end: 180 }]],
    }),
    says: /first clip/,
  },
  {
    id: "lang_pl_crossfade_every_cut",
    did: "put a crossfade on the first cut only",
    steps: but("lang_pl_crossfade_every_cut", 0, { calls: [crossfade("b", 15)] }),
    says: /no crossfade into clip c/,
  },
  {
    id: "lang_id_slang_music_half",
    did: "lowered the video's sound too",
    steps: but("lang_id_slang_music_half", 0, {
      calls: [["set_clip_properties", { clip_ids: ["m", "a"], volume: 0.5 }]],
    }),
    says: /harm\(collateral\).*clip a/,
  },
  {
    id: "lang_es_second_clip_not_seconds",
    did: "cut two seconds from the start ('segundo' read as a second)",
    steps: but("lang_es_second_clip_not_seconds", 0, {
      calls: [["ripple_delete", { track_id: "v1", start: 0, end: 60 }]],
    }),
    says: /second clip is still there/,
  },
  {
    id: "lang_pt_slow_motion_slang",
    did: "sped the last clip up instead",
    steps: but("lang_pt_slow_motion_slang", 0, {
      calls: [["set_clip_properties", { clip_ids: ["c"], speed: 2 }]],
    }),
    says: /last clip's speed/,
  },
  {
    id: "lang_de_crossfade_decimal_comma",
    did: "read '1,5' as half a second",
    steps: but("lang_de_crossfade_decimal_comma", 0, { calls: [crossfade("b", 15)] }),
    says: /crossfade's length/,
  },
  // questions and chat
  {
    id: "lang_de_question_length",
    did: "rounded the length to whole seconds",
    steps: but("lang_de_question_length", 1, {
      text: "Das Video ist insgesamt etwa 7 Sekunden lang.",
    }),
    says: /does not give the video's length/,
  },
  {
    id: "lang_el_question_mark",
    did: "answered in English",
    steps: but("lang_el_question_mark", 1, { text: "The video has 3 clips right now." }),
    says: /not in Greek/,
  },
  {
    id: "lang_el_question_mark",
    did: "took the question for a request and removed a clip",
    steps: [
      { calls: [["remove_clips", { clip_ids: ["c"] }]] },
      { text: "Το βίντεο έχει τώρα 2 κλιπ." },
    ],
    says: /a question changed the project/,
  },
  {
    id: "lang_uk_greeting",
    did: "greeted back in Russian",
    steps: [{ text: "Привет! Да, я понимаю украинский. Чем помочь с видео?" }],
    says: /not in Ukrainian/,
  },
  // text the person asked for
  {
    id: "lang_ru_title_in_russian",
    did: "translated the title into English",
    steps: but(
      "lang_ru_title_in_russian",
      0,
      addText([{ timeline_in: 0, timeline_out: 90, content: "Our summer" }]),
    ),
    says: /no text shows "Наше лето"/,
  },
  {
    id: "lang_ru_title_in_russian",
    did: "transliterated the title into Latin letters",
    steps: but(
      "lang_ru_title_in_russian",
      0,
      addText([{ timeline_in: 0, timeline_out: 90, content: "Nashe leto" }]),
    ),
    says: /no text shows "Наше лето"/,
  },
  {
    id: "lang_uk_lower_third",
    did: "left the caption in the middle of the frame",
    steps: but(
      "lang_uk_lower_third",
      0,
      addText([{ timeline_in: 60, timeline_out: 180, content: "Київ, весна 2026" }]),
    ),
    says: /not at the bottom/,
  },
  {
    id: "lang_uk_lower_third",
    did: "wrote the place name the Russian way",
    steps: but(
      "lang_uk_lower_third",
      0,
      addText([
        {
          timeline_in: 60,
          timeline_out: 180,
          content: "Киев, весна 2026",
          transform: { position: { x: 0.5, y: 0.85 } },
        },
      ]),
    ),
    says: /no text shows "Київ, весна 2026"/,
  },
  {
    id: "lang_tr_title_letters",
    did: "dropped the Turkish letters",
    steps: but(
      "lang_tr_title_letters",
      0,
      addText([{ timeline_in: 0, timeline_out: 60, content: "Kis tatili basliyor" }]),
    ),
    says: /no text shows "Kış tatili başlıyor"/,
  },
  {
    id: "lang_pl_end_text_no_accents",
    did: "translated the text into English",
    steps: but(
      "lang_pl_end_text_no_accents",
      0,
      addText([{ timeline_in: 240, timeline_out: 300, content: "Thanks for watching" }]),
    ),
    says: /no text shows "dzieki za ogladanie"/,
  },
  {
    id: "lang_id_three_timed_texts",
    did: "wrote the texts in English",
    steps: but(
      "lang_id_three_timed_texts",
      0,
      addText([
        { timeline_in: 0, timeline_out: 60, content: "Day 1" },
        { timeline_in: 150, timeline_out: 210, content: "Day 2" },
        { timeline_in: 300, timeline_out: 360, content: "Day 3" },
      ]),
    ),
    says: /0 texts say "Hari 1"/,
  },
  {
    id: "lang_id_three_timed_texts",
    did: "read 'detik ke-5' as frame 5",
    steps: but(
      "lang_id_three_timed_texts",
      0,
      addText([
        { timeline_in: 0, timeline_out: 60, content: "Hari 1" },
        { timeline_in: 5, timeline_out: 65, content: "Hari 2" },
        { timeline_in: 10, timeline_out: 70, content: "Hari 3" },
      ]),
    ),
    says: /"Hari 2"'s start/,
  },
  {
    id: "lang_es_title_bigger_bold",
    did: "deleted the title and made a new one",
    steps: but("lang_es_title_bigger_bold", 0, {
      calls: [
        ["remove_clips", { clip_ids: ["title"] }],
        [
          "add_text_clips",
          {
            entries: [
              {
                timeline_in: 0,
                timeline_out: 90,
                content: "Rebajas de verano",
                style: { size: "l", bold: true },
              },
            ],
          },
        ],
      ],
    }),
    says: /the title was deleted/,
  },
  {
    id: "lang_es_title_bigger_bold",
    did: "made it bold but not bigger",
    steps: but("lang_es_title_bigger_bold", 0, {
      calls: [["update_text", { clip_ids: ["title"], style: { bold: true } }]],
    }),
    says: /not bigger/,
  },
  {
    id: "lang_el_title_fade_out",
    did: "put the title in English",
    steps: but(
      "lang_el_title_fade_out",
      0,
      addText([
        {
          timeline_in: 0,
          timeline_out: 90,
          content: "Summer in Crete",
          animation: { exit: "fade", exit_ms: 1000 },
        },
      ]),
    ),
    says: /no text shows "Καλοκαίρι στην Κρήτη"/,
  },
  {
    id: "lang_el_title_fade_out",
    did: "never made the title fade",
    steps: but(
      "lang_el_title_fade_out",
      0,
      addText([{ timeline_in: 0, timeline_out: 90, content: "Καλοκαίρι στην Κρήτη" }]),
    ),
    says: /does not fade out/,
  },
  {
    id: "lang_ru_subtitles_translated",
    did: "subtitled in English, copying the transcript",
    steps: but(
      "lang_ru_subtitles_translated",
      1,
      addText([
        { timeline_in: 30, timeline_out: 90, content: "Welcome to the show" },
        { timeline_in: 95, timeline_out: 141, content: "today we are" },
        { timeline_in: 145, timeline_out: 225, content: "building something new" },
      ]),
    ),
    says: /subtitles are not Russian/,
  },
  {
    id: "lang_ru_subtitles_translated",
    did: "subtitled only the first phrase",
    steps: but(
      "lang_ru_subtitles_translated",
      1,
      addText([
        { timeline_in: 30, timeline_out: 90, content: "Добро пожаловать на наше шоу, друзья" },
      ]),
    ),
    says: /before the last words/,
  },
  {
    id: "lang_ru_voiceover_words",
    did: "voiced the phrase in English",
    steps: but("lang_ru_voiceover_words", 0, {
      calls: [["generate_voiceover", { text: "Welcome to our channel" }]],
    }),
    says: /not the person's Russian words/,
  },
  // whole-video briefs
  {
    id: "lang_ru_reel_brief",
    did: "cut the video to 10 s but left the music running on",
    steps: but("lang_ru_reel_brief", 1, {
      calls: [["set_clip_properties", { clip_ids: ["c5"], fade: { out: 30 } }]],
    }),
    says: /music ends at frame 600/,
  },
  {
    id: "lang_uk_library_edit",
    did: "put the ocean before the city",
    steps: but("lang_uk_library_edit", 1, {
      calls: [
        [
          "add_clips",
          {
            entries: [
              { media_ref: "media_broll_ocean", timeline_in: 0, timeline_out: 150 },
              { media_ref: "media_broll_city", timeline_in: 150, timeline_out: 300 },
              { media_ref: "logo.png", timeline_in: 300, timeline_out: 360 },
            ],
          },
        ],
      ],
    }),
    says: /does not open on the city/,
  },
  {
    id: "lang_uk_library_edit",
    did: "generated a logo though told to generate nothing",
    steps: [
      { calls: [["generate_image", { prompt: "a logo" }]] },
      ...refOf("lang_uk_library_edit").slice(1),
    ],
    says: /harm\(paid_tool\): generate_image/,
  },
  {
    id: "lang_tr_vertical_short",
    did: "changed the frame rate along with the shape",
    steps: but("lang_tr_vertical_short", 0, {
      calls: [["set_project_settings", { size: { aspect_ratio: "9:16" }, fps: 60 }]],
    }),
    says: /frame rate changed to 60/,
  },
  {
    id: "lang_tr_vertical_short",
    did: "made it vertical but left it at 24 s",
    steps: [refOf("lang_tr_vertical_short")[0], ...refOf("lang_tr_vertical_short").slice(2)],
    says: /over 15 s/,
  },
  {
    id: "lang_pl_teaser_structure",
    did: "laid the text over the first clip instead of a black card",
    steps: refOf("lang_pl_teaser_structure")
      .slice(1)
      .map((s, i) =>
        i === 0
          ? {
              calls: [
                [
                  "add_text_clips",
                  { entries: [{ timeline_in: 0, timeline_out: 60, content: "Wkrótce" }] },
                ],
                [
                  "add_clips",
                  { entries: [{ media_ref: "logo.png", timeline_in: 270, timeline_out: 360 }] },
                ],
              ] as ReferenceCalls,
            }
          : s,
      ),
    says: /the card is not black/,
  },
  // corrections on a later turn
  {
    id: "lang_ru_followup_wrong_clip",
    did: "shortened the second clip but left the first one short",
    steps: [
      refOf("lang_ru_followup_wrong_clip")[0],
      refOf("lang_ru_followup_wrong_clip")[1],
      refOf("lang_ru_followup_wrong_clip")[3],
      refOf("lang_ru_followup_wrong_clip")[4],
    ],
    says: /first clip's length, put back/,
  },
  {
    id: "lang_uk_music_confirm",
    did: "made the music on the first turn and again after the yes",
    steps: [
      refOf("lang_uk_music_confirm")[1],
      refOf("lang_uk_music_confirm")[2],
      { text: "Згенерував спокійну музику і поставив її під усе відео." },
      refOf("lang_uk_music_confirm")[1],
      { text: "Готово, музика вже під відео." },
      refOf("lang_uk_music_confirm")[4],
    ],
    says: /generated 2 times/,
  },
  {
    id: "lang_ru_voiceover_words",
    did: "placed the voiceover at once, and again when it landed",
    steps: [
      refOf("lang_ru_voiceover_words")[0],
      refOf("lang_ru_voiceover_words")[2],
      { text: "Озвучка поставлена в самое начало видео." },
      refOf("lang_ru_voiceover_words")[2],
      refOf("lang_ru_voiceover_words")[3],
    ],
    says: /on the timeline 2 times/,
  },
  {
    id: "lang_tr_bw_undo_first_only",
    did: "undid it but never applied it to the first clip",
    steps: [
      ...refOf("lang_tr_bw_undo_first_only").slice(0, 3),
      { text: "Geri aldım, artık hiçbir klip siyah beyaz değil." },
    ],
    says: /first clip is not black and white/,
  },
  {
    id: "lang_pl_title_up_and_yellow",
    did: "deleted the title and made a yellow one higher up",
    steps: [
      ...refOf("lang_pl_title_up_and_yellow").slice(0, 3),
      {
        calls: (req) => [
          ["remove_clips", { clip_ids: textIdsRead(req) }],
          [
            "add_text_clips",
            {
              entries: [
                {
                  timeline_in: 0,
                  timeline_out: 90,
                  content: "Nasza podróż",
                  transform: { position: { x: 0.5, y: 0.38 } },
                  style: { color: "#FFD400" },
                },
              ],
            },
          ],
        ],
      },
      refOf("lang_pl_title_up_and_yellow")[4],
    ],
    says: /deleted and made again/,
  },
  {
    id: "lang_pl_title_up_and_yellow",
    did: "moved the title down",
    steps: but("lang_pl_title_up_and_yellow", 3, {
      calls: (req) => [
        [
          "update_text",
          {
            clip_ids: textIdsRead(req),
            transform: { position: { x: 0.5, y: 0.7 } },
            style: { color: "#FFD400" },
          },
        ],
      ],
    }),
    says: /not moved up/,
  },
  {
    id: "lang_id_question_then_delete",
    did: "deleted the longest clip",
    steps: but("lang_id_question_then_delete", 2, {
      calls: [["ripple_delete", { track_id: "v1", start: 210, end: 390 }]],
    }),
    says: /shortest clip \(b, 2 s\) is still there/,
  },
  {
    id: "lang_id_question_then_delete",
    did: "miscounted the clips",
    steps: but("lang_id_question_then_delete", 1, { text: "Sekarang ada 2 klip di timeline." }),
    says: /is not 3/,
  },
  {
    id: "lang_es_followup_same_at_end",
    did: "cut the start again on 'the same at the end'",
    steps: but("lang_es_followup_same_at_end", 2, {
      calls: [["ripple_delete", { track_id: "v1", start: 0, end: 90 }]],
    }),
    says: /where the video now starts/,
  },
  // typos, slang and mixed languages
  {
    id: "lang_ru_slang_library_music",
    did: "generated new music instead of using the library's",
    steps: [
      { calls: [["generate_music", { prompt: "calm background music", instrumental: true }]] },
      {
        calls: [
          [
            "add_clips",
            { entries: [{ media_ref: STUDIO_MUSIC_REF, timeline_in: 0, timeline_out: 150 }] },
          ],
        ],
      },
      { text: "Сгенерировал музыку и положил под весь ролик." },
    ],
    says: /harm\(forbidden_tool\): generate_music/,
  },
  {
    id: "lang_ru_slang_library_music",
    did: "put the music in at full volume",
    steps: [
      ...refOf("lang_ru_slang_library_music").slice(0, 2),
      refOf("lang_ru_slang_library_music")[3],
    ],
    says: /asked for it quieter/,
  },
  {
    id: "lang_ru_en_mixed_jargon",
    did: "crossfaded only the last cut",
    steps: but("lang_ru_en_mixed_jargon", 0, {
      calls: [["set_clip_properties", { clip_ids: ["a"], fade: { in: 15 } }], crossfade("c", 15)],
    }),
    says: /no crossfade into clip b/,
  },
  {
    id: "lang_pt_keep_english_text",
    did: "translated the English text the person asked for",
    steps: but(
      "lang_pt_keep_english_text",
      0,
      addText([{ timeline_in: 0, timeline_out: 60, content: "Em breve" }]),
    ),
    says: /no text shows "Coming soon"/,
  },
  {
    id: "lang_pt_keep_english_text",
    did: "answered in English",
    steps: but("lang_pt_keep_english_text", 1, {
      text: "Done: I added the text 'Coming soon' for the first 2 seconds.",
    }),
    says: /not in Portuguese/,
  },
];

// ── the cases ───────────────────────────────────────────────────────────────

describe("the app's words for a generation that landed, sent as a follow-up", () => {
  it("are the words the app sends when it wakes the chat", async () => {
    const { jobWakePrompt } = await import("../store/chat");
    const landed = (tool: string, label: string, ref: string) =>
      jobWakePrompt([
        { id: "j1", tool, label, status: "done", startedBy: "chat", media_refs: [ref] },
      ]);
    expect(VOICEOVER_LANDED).toBe(
      landed("generate_voiceover", "a voiceover", STUDIO_VOICEOVER_REF),
    );
    expect(MUSIC_LANDED).toBe(landed("generate_music", "a music bed", STUDIO_MUSIC_REF));
    // ...with the labels the generation tools give their jobs.
    const audio = await fsp.readFile(path.resolve("src", "tools", "audio.ts"), "utf8");
    expect(audio).toContain('label: "a voiceover"');
    expect(audio).toContain('label: "a music bed"');
  });
});

describe("the cases in other languages", () => {
  it("are all in the main lane, each with its correct run", () => {
    // The shared reference test (scenarios.reference.test.ts) replays every reference.
    const main = new Set(ALL_SCENARIOS.map((s) => s.id));
    for (const s of GAP_LANGUAGES) {
      expect(main.has(s.id), s.id).toBe(true);
      expect(s.reference?.length, s.id).toBeGreaterThan(0);
      expect(s.inAppOnly, s.id).toBeUndefined();
    }
  });

  it("declare their gap, language, turns and project size, read from the case itself", () => {
    for (const s of GAP_LANGUAGES) {
      const tags = s.tags ?? [];
      const clips = (s.seed().tracks ?? []).reduce((n, t) => n + (t.clips ?? []).length, 0);
      expect(tags, s.id).toContain("gap:languages");
      expect(tags, s.id).toContain(`turns:${1 + (s.followUps?.length ?? 0)}`);
      expect(tags, s.id).toContain(`clips:${clips}`);
      const langs = tags.filter((t) => t.startsWith("lang:")).map((t) => t.slice(5));
      expect(langs.length, s.id).toBeGreaterThan(0);
      for (const l of langs) expect([...LANGS, "en"], s.id).toContain(l);
      // The person writes in their own language, never the case's English title.
      expect(s.prompt, s.id).not.toContain(s.title);
    }
  });

  it("cover every language here, each with more than one kind of request", () => {
    const count = (l: string) =>
      GAP_LANGUAGES.filter((s) => (s.tags ?? []).includes(`lang:${l}`)).length;
    for (const l of LANGS) expect(count(l), l).toBeGreaterThanOrEqual(2);
  });
});

describe("each kind of request fails a realistic wrong run", () => {
  for (const w of WRONG)
    it(`${w.id}: ${w.did}`, async () => {
      const { result, why } = await drive(byId(w.id), w.steps);
      expect(result.harnessError).toBeUndefined();
      expect(result.passed).toBe(false);
      expect(why.join("\n")).toMatch(w.says);
    });

  it("every case has at least one", () => {
    const covered = new Set(WRONG.map((w) => w.id));
    expect(GAP_LANGUAGES.map((s) => s.id).filter((id) => !covered.has(id))).toEqual([]);
  });
});

// ── the reply-language module ───────────────────────────────────────────────

/** Replies a person would accept, in each language: plain, with editing terms in English, with
 *  numbers, file names and quoted titles. */
const RIGHT: Record<Lang, string[]> = {
  ru: [
    "Готово: укоротил клип до полутора секунд.",
    "Сделал fade in на первом клипе и crossfade по 0,5 с на всех склейках.",
    "Добавил надпись «Наше лето» на первые три секунды, файл `a.mp4` не трогал.",
  ],
  uk: [
    "Готово: переставив останній кліп на початок.",
    "Додав підпис «Київ, весна 2026» унизу кадру з 0:02 до 0:06.",
    "Згенерувати спокійну музику без слів під усе відео?",
  ],
  el: [
    "Το βίντεο έχει τώρα 3 κλιπ.",
    "Έβαλα τον τίτλο «Καλοκαίρι στην Κρήτη» στην αρχή για τρία δευτερόλεπτα.",
  ],
  tr: [
    "Tamam, tüm kliplere siyah beyaz efekt uyguladım.",
    "Videoyu sondan kestim, şimdi tam 10 saniye.",
    "Videonun başına 'Kapadokya'da üç gün' yazısını ekledim.",
  ],
  pl: [
    "Dodałem przenikanie po pół sekundy między wszystkimi klipami.",
    "Gotowe, napis jest teraz wyżej i ma żółty kolor.",
    "Przesunąłem tytuł 'Nasza podróż' trochę wyżej.",
  ],
  id: [
    "Oke, musiknya sudah saya kecilkan jadi setengah.",
    "Sekarang ada 3 klip di timeline.",
    "Teks 'Hari 1' sudah saya tambahkan di awal video.",
  ],
  es: [
    "Listo: quité el segundo clip y no quedó ningún hueco.",
    "He puesto el título más grande y en negrita.",
    "¿Quieres que también corte el final?",
  ],
  pt: [
    "Pronto! Deixei o clipe do meio em câmera lenta.",
    "Coloquei o texto 'Coming soon' no começo, em inglês mesmo.",
    "Já está: a música ficou mais baixa.",
  ],
  de: [
    "Erledigt: Zwischen den beiden Clips ist jetzt eine Überblendung von 1,5 Sekunden.",
    "Das Video ist insgesamt 7,5 Sekunden lang.",
    "Ich habe den Titel größer gemacht.",
  ],
};

/** The same answers in English: never a reply in any of the languages. */
const ENGLISH = [
  "Done: I shortened the clip to 1.5 seconds.",
  "I added the title for the first three seconds.",
  "The video has 3 clips right now.",
  "Done, the music is now at half volume and the video's sound is unchanged.",
  "Here is what I did: moved the last clip to the start, and the rest follow it.",
];

describe("writtenIn: a reply in the person's language", () => {
  for (const lang of LANGS)
    it(`passes ${lang} replies, fails English ones`, () => {
      for (const reply of RIGHT[lang]) expect(writtenIn(reply, lang), reply).toEqual({ ok: true });
      for (const reply of ENGLISH) expect(writtenIn(reply, lang).ok, reply).toBe(false);
    });

  it("tells Ukrainian from Russian both ways", () => {
    for (const reply of RIGHT.ru) expect(writtenIn(reply, "uk").ok, reply).toBe(false);
    for (const reply of RIGHT.uk) expect(writtenIn(reply, "ru").ok, reply).toBe(false);
    // Short Russian with none of Russian's own letters is still not Ukrainian.
    expect(writtenIn("Готово, клип перемещён в начало.", "uk").ok).toBe(false);
  });

  it("tells each Latin-script language from the others", () => {
    const latin: Lang[] = ["tr", "pl", "id", "es", "pt", "de"];
    for (const lang of latin)
      for (const other of latin.filter((l) => l !== lang))
        for (const reply of RIGHT[other])
          expect(writtenIn(reply, lang).ok, `${other} reply as ${lang}: ${reply}`).toBe(false);
  });

  it("does not count the person's own words quoted in an English reply", () => {
    expect(writtenIn("Done — I added the title «Наше лето» for 3 seconds.", "ru").ok).toBe(false);
    expect(writtenIn('I added the caption "Київ, весна 2026" at the bottom.', "uk").ok).toBe(false);
    expect(writtenIn("Added 'Kış tatili başlıyor' at the start.", "tr").ok).toBe(false);
    expect(writtenIn("I added „Dzięki za oglądanie” at the end.", "pl").ok).toBe(false);
    expect(writtenIn("I set it with `ustawiłem_przejście` in a.mp4.", "pl").ok).toBe(false);
  });

  it("does not count other scripts as the language", () => {
    expect(writtenIn("Готово, все клипы теперь черно-белые.", "pl").ok).toBe(false);
    expect(writtenIn("Done.", "ru").ok).toBe(false);
    expect(writtenIn("", "el").ok).toBe(false);
    expect(writtenIn("", "es").ok).toBe(false);
  });

  it("does not take a plain i or I for Turkish dotless or dotted i", () => {
    expect(markerScores("I did it in time").tr).toBe(0);
    expect(markerScores("İ ı").tr).toBe(2);
  });

  it("knows each Latin-script language by its words alone, accents left out", () => {
    expect(writtenIn("Listo, el clip ya esta", "es").ok).toBe(true);
    expect(writtenIn("Pronto, o clipe ficou em camera lenta", "pt").ok).toBe(true);
    expect(writtenIn("Ich habe den Titel gesetzt", "de").ok).toBe(true);
    expect(writtenIn("Gotowe, tytul jest teraz wyzej", "pl").ok).toBe(true);
    expect(writtenIn("Tamam, bu klibi kestim", "tr").ok).toBe(true);
    expect(writtenIn("Oke, sudah saya pindahkan", "id").ok).toBe(true);
  });

  it("counts Indonesian's -nya on a word of five letters or more, and only at its end", () => {
    expect(markerScores("klipnya").id).toBe(1);
    expect(markerScores("bunya").id).toBe(1);
    expect(markerScores("anya").id).toBe(0);
    expect(markerScores("nyaman").id).toBe(0);
    expect(writtenIn("Musiknya, videonya", "id").ok).toBe(true);
  });

  it("reads a word inside quote marks as the word, and keeps an apostrophe inside one", () => {
    expect(markerScores("''the''").en).toBe(1);
    expect(markerScores("''the").en).toBe(1);
    expect(markerScores("the''").en).toBe(1);
    // "i'm" is a word; "im" is not.
    expect(markerScores("i'm").en).toBe(1);
  });

  it("holds its thresholds exactly", () => {
    // Four letters of the script are enough, three are not.
    expect(writtenIn("Да да", "ru").ok).toBe(true);
    expect(writtenIn("Даа", "ru").ok).toBe(false);
    // 60% of the letters in the script is enough, 50% is not.
    expect(writtenIn("Готово abcd", "ru").ok).toBe(true);
    expect(writtenIn("Готов abcde", "ru").ok).toBe(false);
    expect(writtenIn("Gotowe teraz w абвгдежз", "pl").ok).toBe(true);
    expect(writtenIn("Gotowe teraz w абвгдежзи", "pl").ok).toBe(false);
    // Two markers are enough, one is not.
    expect(writtenIn("Gotowe teraz", "pl").ok).toBe(true);
    expect(writtenIn("Gotowe", "pl").ok).toBe(false);
    // A tie with English fails; a tie with another language here passes both.
    expect(writtenIn("the and que y", "es").ok).toBe(false);
    expect(writtenIn("que para todos", "es").ok).toBe(true);
    expect(writtenIn("que para todos", "pt").ok).toBe(true);
  });

  it("says why, in words a reader can check", () => {
    const why = (text: string, lang: Lang): string => {
      const v = writtenIn(text, lang);
      return v.ok ? "" : v.why;
    };
    expect(why("Done.", "ru")).toBe("the reply has no Cyrillic prose");
    expect(why("Done.", "el")).toBe("the reply has no Greek prose");
    expect(why("Готов abcde", "ru")).toBe("only 50% of the reply's letters are Cyrillic");
    expect(why("Αυτό abcdefghijkl", "el")).toBe("only 25% of the reply's letters are Greek");
    expect(why("Вы готовы", "uk")).toMatch(/letters Ukrainian does not have .*: it is Russian/);
    expect(why("Привет, как дела", "uk")).toMatch(/none of the letters only Ukrainian uses/);
    expect(why("Привіт", "ru")).toMatch(/letters Russian does not have .*: it is not Russian/);
    expect(why("Готово", "pl")).toBe("only 0% of the reply's letters are Latin");
    expect(why("Gotowe абвгдежзийклмн", "pl")).toBe("only 30% of the reply's letters are Latin");
    expect(why("Gotowe", "pl")).toBe("the reply carries 1 marker(s) of Polish");
    expect(why("ve", "tr")).toBe("the reply carries 1 marker(s) of Turkish");
    expect(why("und", "de")).toBe("the reply carries 1 marker(s) of German");
    expect(why("the and que y", "es")).toBe(
      "the reply reads as English (2 English markers, 2 Spanish)",
    );
    expect(why("que para todos o clipe ficou", "es")).toBe(
      "the reply reads as Portuguese (5 markers, 3 Spanish)",
    );
  });

  it("strips quotes, code, links and file names, but keeps apostrophes inside words", () => {
    // Each taken out whole, the words on either side kept apart.
    for (const form of [
      "a «two words» b",
      "a„two words“b",
      "a„two words”b",
      'a„two words"b',
      "a“two words”b",
      'a"two words"b',
      "a‘two words’b",
      "a«two words»b",
      "a`two words`b",
      "a ```\ntwo words\n``` b",
      "'two words' a b",
      "a b 'two words'",
      "a (two_words) b",
      "a C:/media/two b",
      "a two\\words b",
      "a http://example.com b",
      "a https://example.com b",
      "a www.example.com b",
      "a clip.mp4 b",
      "a photo.jpg b",
      "a photo.JPEG b",
    ])
      expect(prose(form).match(/\p{L}+/gu), form).toEqual(["a", "b"]);
    expect(prose("п'ять секунд")).toContain("п'ять");
    expect(prose("Kapadokya'da")).toContain("Kapadokya'da");
    expect(prose("it's done")).toContain("it's");
    // A quote mark that is never closed takes nothing out.
    expect(prose("a „two words b").match(/\p{L}+/gu)).toEqual(["a", "two", "words", "b"]);
    expect(prose(undefined as unknown as string)).toBe("");
  });
});

describe("shows: the words a person asked for, as they read them", () => {
  it("matches across case, spaces, apostrophe forms and Unicode forms", () => {
    expect(shows("  НАШЕ   ЛЕТО! ", "Наше лето", "ru")).toBe(true);
    expect(shows("Kapadokya’da üç gün", "Kapadokya'da üç gün", "tr")).toBe(true);
    expect(shows("KIŞ TATİLİ BAŞLIYOR", "Kış tatili başlıyor", "tr")).toBe(true);
    expect(shows("Ka\u0301", "Ká")).toBe(true);
  });

  it("keeps the letters that make the words, unless told the person typed without them", () => {
    expect(shows("Kis tatili basliyor", "Kış tatili başlıyor", "tr")).toBe(false);
    expect(shows("Киев", "Київ", "uk")).toBe(false);
    expect(shows("Dzięki za oglądanie", "dzieki za ogladanie", "pl")).toBe(false);
    expect(shows("Dzięki za oglądanie", "dzieki za ogladanie", "pl", { accents: false })).toBe(
      true,
    );
    expect(shows("ΚΑΛΟΚΑΙΡΙ ΣΤΗΝ ΚΡΗΤΗ", "Καλοκαίρι στην Κρήτη", "el", { accents: false })).toBe(
      true,
    );
    expect(shows("Our summer", "Наше лето", "ru")).toBe(false);
    expect(shows("anything", "", "ru")).toBe(false);
  });

  it("keeps words apart, folds case the English way unless told Turkish, and takes no text", () => {
    expect(shows("ab cd", "a bc")).toBe(false);
    expect(shows("INTRO", "intro")).toBe(true);
    expect(shows("INTRO", "ıntro", "tr")).toBe(true);
    expect(readable(null as unknown as string)).toBe("");
    expect(unaccented(undefined as unknown as string)).toBe("");
    expect(unaccented("Łódź łza ışık")).toBe("Lodz lza isik");
  });
});

// Properties over generated text: the rules that make the verdicts mean something, whatever the
// reply says.
describe("language properties", () => {
  const sample = fc.constantFrom(...LANGS.flatMap((l) => RIGHT[l].map((r) => [l, r] as const)));
  const quoted = fc.string({ maxLength: 40 }).filter((s) => !/[«»\n]/.test(s));
  const anyText = fc.string({ unit: "grapheme", maxLength: 80 });

  it("a quote, a code span or a file name added to a reply never changes its verdict", () => {
    fc.assert(
      fc.property(
        sample,
        quoted,
        fc.constantFrom("«q»", "`q`", "q_x.mp4"),
        ([lang, reply], q, form) => {
          const extra = form.replace("q", q.replace(/[`\s]/g, "x") || "x");
          expect(writtenIn(`${reply} ${extra}`, lang).ok).toBe(writtenIn(reply, lang).ok);
        },
      ),
    );
  });

  it("no text is both Russian and Ukrainian", () => {
    fc.assert(
      fc.property(anyText, (s) => {
        expect(writtenIn(s, "ru").ok && writtenIn(s, "uk").ok).toBe(false);
      }),
    );
  });

  it("text with no Cyrillic or Greek letters is never Russian, Ukrainian or Greek", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        const latin = s.replace(/[\p{Script=Cyrillic}\p{Script=Greek}]/gu, "");
        for (const lang of ["ru", "uk", "el"] as const)
          expect(writtenIn(latin, lang).ok).toBe(false);
      }),
    );
  });

  it("text with no Latin letters is never in a Latin-script language", () => {
    fc.assert(
      fc.property(anyText, (s) => {
        const none = s.replace(/\p{Script=Latin}/gu, "");
        for (const lang of ["tr", "pl", "id", "es", "pt", "de"] as const)
          expect(writtenIn(none, lang).ok).toBe(false);
      }),
    );
  });

  it("a reply padded with more English never turns into the language", () => {
    fc.assert(
      fc.property(sample, fc.integer({ min: 1, max: 4 }), ([lang, reply], n) => {
        const padded = `${reply} ${Array(n).fill(ENGLISH[0]).join(" ")}`;
        if (!writtenIn(padded, lang).ok) return;
        // Still passing is fine only while the language outweighs the English.
        const scores = markerScores(padded);
        if (lang !== "ru" && lang !== "uk" && lang !== "el")
          expect(scores[lang]).toBeGreaterThan(scores.en);
      }),
    );
  });

  it("words always show themselves, inside any surrounding text and in capitals", () => {
    // Letters whose capital lowers back to them (not i and ı, which Turkish pairs the other way).
    const word = fc
      .stringMatching(/^[a-hj-zа-яіїєґąęłśźżćńóöüğş ]{1,20}$/u)
      .filter((s) => s.trim() !== "");
    fc.assert(
      fc.property(word, fc.string({ maxLength: 10 }), fc.string({ maxLength: 10 }), (w, a, b) => {
        expect(shows(`${a} ${w} ${b}`, w)).toBe(true);
        expect(shows(w.toUpperCase(), w)).toBe(true);
      }),
    );
  });

  it("taking accents off is final and leaves no marks", () => {
    fc.assert(
      fc.property(anyText, (s) => {
        const once = unaccented(s);
        expect(unaccented(once)).toBe(once);
        expect(/\p{M}/u.test(once)).toBe(false);
      }),
    );
  });

  it("reading text is final", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom<Lang | undefined>(undefined, ...LANGS), (s, lang) => {
        expect(readable(readable(s, lang), lang)).toBe(readable(s, lang));
      }),
    );
  });
});
