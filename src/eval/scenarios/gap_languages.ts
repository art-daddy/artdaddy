// Requests written in a language other than English. Each case is a kind of request people make (a
// single edit, text they want on screen, a whole-video brief, a correction on a later turn, a
// message mixing two languages, a request typed with slang or without its accents), written in one
// of the languages people write to the app in: Russian, Ukrainian, Turkish, Polish, Indonesian,
// Spanish, Portuguese, German and Greek.
//
// What is graded, besides the edit itself, is what only a request in another language can get
// wrong:
//  - the words: a number written as a word ("полторы"), a decimal comma ("1,5"), an ordinal that is
//    also a unit ("el segundo clip"), slang, a word typed without its accents;
//  - text the person asks for in their language comes out in it, neither translated nor
//    transliterated, and text they ask for in English stays English;
//  - the reply is in the person's language where they wrote only in it (src/eval/language.ts: the
//    script for Cyrillic and Greek, Ukrainian told from Russian by the letters only each has, and
//    frequent words for the languages written in Latin letters). The wording is never graded.
// Every request here was written for these cases; none is a real person's message.
import { textBox } from "../../timeline/renderPlan";
import type { Clip, Timeline } from "../../timeline/model";
import { clipText } from "../../timeline/shape";
import type { InferenceRequest } from "../harness";
import { JOURNEY_LAST_WORD_FRAME, JOURNEY_NARRATION_REF, JOURNEY_WORDS } from "../journey";
import { shows, writtenIn, type Lang } from "../language";
import type { ReferenceCalls, ReferenceStep } from "../reference";
import { STUDIO_MUSIC_REF, STUDIO_VOICEOVER_REF } from "../studio";
import type { Scenario, ToolCall, Trace } from "../types";
import {
  aclip,
  allClips,
  assert,
  atrack,
  clipById,
  clipsOf,
  contiguousFrom,
  near,
  span,
  timeline,
  ttrack,
  vclip,
  vtrack,
} from "./helpers";

const FPS = 30;

const LANGUAGE_NAMES: Record<Lang, string> = {
  ru: "Russian",
  uk: "Ukrainian",
  el: "Greek",
  tr: "Turkish",
  pl: "Polish",
  id: "Indonesian",
  es: "Spanish",
  pt: "Portuguese",
  de: "German",
};

// ── readers ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- graders read uncommon clip fields
type Any = any;

/** A scalar, or the last keyframe of an animated value. */
const numOf = (v: unknown): number =>
  typeof v === "number"
    ? v
    : Array.isArray(v) && v.length
      ? Number((v[v.length - 1] as { v?: unknown })?.v)
      : NaN;

const textClips = (tl: Timeline): Clip[] => allClips(tl).filter((c) => c.kind === "text");

/** The clips that draw a picture: everything on a video track that is not text. */
function picture(tl: Timeline): Clip[] {
  return (tl.tracks ?? [])
    .filter((t) => t.kind === "video")
    .flatMap((t) => t.clips ?? [])
    .filter((c) => c.kind !== "text" && c.kind !== "audio")
    .sort((a, b) => Number(a.timeline_in) - Number(b.timeline_in));
}
const pictureEnd = (tl: Timeline): number =>
  Math.max(0, ...picture(tl).map((c) => Number(c.timeline_out)));

/** The clips that play `ref`, in timeline order. */
const playing = (tl: Timeline, ref: string): Clip[] =>
  allClips(tl)
    .filter((c) => c.media_ref === ref)
    .sort((a, b) => Number(a.timeline_in) - Number(b.timeline_in));

/** The clips that play a library item, named by its id or by its file name (the studio's project
 *  state names the library's files, its library names their ids: either reaches the same file). */
const fromLibrary = (tl: Timeline, id: string, file: string): Clip[] =>
  allClips(tl)
    .filter((c) => {
      const ref = String(c.media_ref ?? "");
      return ref === id || ref.split(/[\\/]/).pop() === file;
    })
    .sort((a, b) => Number(a.timeline_in) - Number(b.timeline_in));

/** What the app tells the model when a generation it started lands (store/chat.ts wakeText, led by
 *  store/jobNotes.ts JOB_WAKE_LEAD; the label is the generation tool's, tools/audio.ts). The app
 *  sends it as the next message in the chat; the Copilot lane has no such wake, so a case whose
 *  request goes on after the media lands sends it as a follow-up, in the app's exact words. A test
 *  holds these to the app's own text. */
export function generationLandedNote(label: string, ref: string): string {
  return [
    "Background work you started earlier has finished:",
    `- ${label} is ready (${ref})`,
    "",
    "Continue what you were doing if there is more to do. If a job failed, say so and offer a",
    "way forward instead of silently retrying anything that costs money.",
  ].join("\n");
}
export const VOICEOVER_LANDED = generationLandedNote("a voiceover", STUDIO_VOICEOVER_REF);
export const MUSIC_LANDED = generationLandedNote("a music bed", STUDIO_MUSIC_REF);

function trackKindOf(tl: Timeline, clip: Clip): string {
  return String((tl.tracks ?? []).find((t) => (t.clips ?? []).includes(clip))?.kind ?? "?");
}

/** The one text clip that shows `words`, failing when none or several do. */
function titleShowing(
  tl: Timeline,
  words: string,
  lang: Lang | undefined,
  opts: { accents?: boolean } = {},
): Clip {
  const hits = textClips(tl).filter((c) => shows(clipText(c), words, lang, opts));
  const all = textClips(tl).map((c) => clipText(c));
  assert(hits.length > 0, `no text shows "${words}" (text on screen: ${JSON.stringify(all)})`);
  assert(hits.length === 1, `${hits.length} text clips show "${words}"; asked for one`);
  return hits[0];
}

/** Where a text clip's centre sits, top to bottom (0..1). Text with no position is centred. */
function heightOf(c: Clip): number {
  const y = numOf((c.transform as Any)?.position?.y);
  return Number.isFinite(y) ? y : 0.5;
}

/** A clip goes to black or transparent at its end: a fade out, an exit fade, or opacity keyed down. */
function fadesOut(c: Clip, atLeast: number): boolean {
  if (Number((c.fade as Any)?.out ?? 0) >= atLeast) return true;
  const exit = (c.animation as Any)?.exit;
  if (typeof exit === "string" && /fade/i.test(exit)) return true;
  const o = c.opacity;
  if (Array.isArray(o) && o.length >= 2) {
    const keys = [...o].sort((a, b) => Number(a.t) - Number(b.t));
    const last = keys[keys.length - 1];
    return Number(last.v) <= 0.15 && keys.some((k) => Number(k.v) >= 0.8);
  }
  return false;
}

/** A clip shown in black and white: no saturation, or an enabled effect that removes colour. */
function isMonochrome(c: Clip | undefined): boolean {
  if (!c) return false;
  const sat = numOf((c.color as Any)?.saturation);
  if (Number.isFinite(sat) && sat <= 0.15) return true;
  return (c.effects ?? []).some(
    (e) =>
      e.enabled !== false &&
      /gr[ae]y|mono|desat|black.?(and|&|_|-)?.?white|\bbw\b/i.test(String(e.type)),
  );
}

/** A colour a person calls yellow: red and green high, blue low. */
function isYellow(color: unknown): boolean {
  const s = String(color ?? "").trim();
  if (/^(yellow|gold)$/i.test(s)) return true;
  const hex = /^#?([0-9a-f]{6})$/i.exec(s)?.[1];
  if (!hex) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return r >= 0.75 && g >= 0.7 && b <= 0.5;
}

/** A text clip's type size in px, as the render draws it. */
const typeSize = (c: Clip, tl: Timeline): number =>
  textBox(c, Number(tl.canvas.width), Number(tl.canvas.height)).sizePx;

/** Bold, by a flag or a weight, its preset's included. */
const isBold = (c: Clip, tl: Timeline): boolean => {
  const st = textBox(c, Number(tl.canvas.width), Number(tl.canvas.height)).style as Any;
  return st.bold === true || Number(st.weight ?? 0) >= 600;
};

const succeeded = (t: Trace, name: string): ToolCall[] =>
  t.toolCalls.filter((c) => c.ok && c.name === name);

/** The tools that only read: a turn that asked a question and called nothing else changed nothing. */
const READS = new Set([
  "get_timeline",
  "get_project_state",
  "get_transcript",
  "inspect_timeline",
  "inspect_media",
  "inspect_color",
  "list_projects",
  "list_models",
  "video_get_metadata",
  "manage_exports",
]);

/** Every reply the person got (one per turn) is written in `lang`. */
function repliesIn(t: Trace, lang: Lang): void {
  const texts = t.turnTexts?.length ? t.turnTexts : [t.finalText];
  texts.forEach((text, i) => {
    const v = writtenIn(text, lang);
    if (!v.ok)
      throw new Error(
        `reply ${i + 1} of ${texts.length} is not in ${LANGUAGE_NAMES[lang]}: ${v.why} (${JSON.stringify(String(text).slice(0, 120))})`,
      );
  });
}

/** A read-only request must leave the project exactly as it was. */
function untouched(seed: () => Timeline) {
  return (final: Timeline) =>
    assert(
      JSON.stringify(final.tracks) === JSON.stringify(seed().tracks) &&
        JSON.stringify(final.canvas) === JSON.stringify(seed().canvas),
      "a question changed the project",
    );
}

function tags(lang: Lang | `${Lang}+en`, turns: number, clips: number, ...kind: string[]) {
  const langs = lang.endsWith("+en") ? [lang.slice(0, 2), "en"] : [lang];
  return [
    "gap:languages",
    ...langs.map((l) => `lang:${l}`),
    `turns:${turns}`,
    `clips:${clips}`,
    ...kind,
  ];
}

// ── correct runs: the steps a reference is written in ────────────────────────

/** A round that puts text on screen. */
const addText = (entries: Record<string, unknown>[]): ReferenceStep => ({
  calls: [["add_text_clips", { entries }]],
});

/** A call that crossfades into `clip` over `frames`. */
const crossfade = (clip: string, frames: number): ReferenceCalls[number] => [
  "set_transition",
  { clip_id: clip, transition_in: { kind: "crossfade", duration: frames } },
];

/** The clips the previous round's `tool` calls made, from the replies the model got. */
export function createdBy(req: InferenceRequest, tool: string): string[] {
  return (req.round_input.tool_results ?? [])
    .filter((r) => r.name === tool)
    .flatMap((r) => ((r.result as Any)?.created ?? []) as { clip_id: string }[])
    .map((c) => c.clip_id);
}

/** The text clips the timeline the model read in the previous round holds. */
export function textIdsRead(req: InferenceRequest): string[] {
  return (req.round_input.tool_results ?? [])
    .filter((r) => r.name === "get_timeline")
    .flatMap((r) => ((r.result as Any)?.timeline?.tracks ?? []) as Any[])
    .flatMap((t) => (t.clips ?? []) as Any[])
    .filter((c) => c.kind === "text")
    .map((c) => String(c.id));
}

// ── seeds ───────────────────────────────────────────────────────────────────

const one = (frames: number) => () => timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, frames)])]);
const row =
  (...lengths: number[]) =>
  () => {
    let at = 0;
    const ids = "abcdefgh";
    const clips = lengths.map((n, i) => {
      const c = vclip(ids[i], `${ids[i]}.mp4`, at, at + n);
      at += n;
      return c;
    });
    return timeline([vtrack("v1", 0, clips)]);
  };

const reelSeed = () =>
  timeline([
    vtrack(
      "v1",
      0,
      ["c1", "c2", "c3", "c4", "c5"].map((id, i) => vclip(id, `${id}.mp4`, i * 90, i * 90 + 90)),
    ),
    atrack("a1", 0, [aclip("m", "music.mp3", 0, 600)]),
  ]);

const titleSeed = () =>
  timeline([
    vtrack("v1", 0, [vclip("a", "a.mp4", 0, 150)]),
    ttrack("t1", 1, [
      {
        id: "title",
        kind: "text",
        timeline_in: 0,
        timeline_out: 90,
        content: [{ text: "Rebajas de verano" }],
        style: { size: "s" },
      },
    ]),
  ]);

const narrationSeed = () =>
  timeline([vtrack("v1", 0, [vclip("narration", JOURNEY_NARRATION_REF, 0, 300)])], {
    width: 1080,
    height: 1920,
    fps: FPS,
  });

const musicUnderClip = () =>
  timeline([
    vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
    atrack("a1", 0, [aclip("m", "music.mp3", 0, 300)]),
  ]);

const landscapeRow = () =>
  timeline(
    [
      vtrack("v1", 0, [
        vclip("a", "a.mp4", 0, 240),
        vclip("b", "b.mp4", 240, 480),
        vclip("c", "c.mp4", 480, 720),
      ]),
    ],
    { width: 1920, height: 1080, fps: FPS },
  );

const emptyStudio = () => timeline([vtrack("v1", 0, []), atrack("a1", 0, [])]);

/** The words the journey's transcript stand-in says are spoken (English). */
const SPOKEN_ENGLISH = JOURNEY_WORDS.map(([, w]) => w.toLowerCase()).filter((w) => w.length > 3);

// ── the cases ───────────────────────────────────────────────────────────────

const RUSSIAN: Scenario[] = [
  {
    id: "lang_ru_trim_number_word",
    title: "Trim to a length written as a word (Russian)",
    tags: tags("ru", 1, 1, "single-edit", "trim", "number-word"),
    scope: { change: ["a"], remove: ["a"], add: ["video"] },
    seed: one(90),
    // "полутора" is "one and a half", declined: no digit to copy.
    prompt: "Сделай этот клип покороче — до полутора секунд.",
    expectTools: ["set_clip_properties"],
    maxRounds: 5,
    reference: [
      { calls: [["set_clip_properties", { clip_ids: ["a"], duration: 45 }]] },
      { text: "Готово: укоротил клип до полутора секунд (45 кадров)." },
    ],
    expect: (tl) => {
      const kept = playing(tl, "a.mp4");
      assert(kept.length > 0, "the clip is gone");
      const total = kept.reduce((n, c) => n + span(c), 0);
      near(total, 45, 2, "the clip's length in frames (1.5 s at 30 fps)");
    },
    expectTrace: (t) => repliesIn(t, "ru"),
  },
  {
    id: "lang_ru_title_in_russian",
    title: "A title in the person's words (Russian)",
    tags: tags("ru", 1, 1, "text", "title"),
    scope: { add: ["text"], addTracks: true },
    seed: one(150),
    prompt: "Добавь в начало надпись «Наше лето», пусть висит первые три секунды.",
    expectTools: ["add_text_clips"],
    maxRounds: 5,
    reference: [
      addText([{ timeline_in: 0, timeline_out: 90, content: "Наше лето" }]),
      { text: "Добавил надпись «Наше лето» на первые три секунды." },
    ],
    expect: (tl) => {
      const title = titleShowing(tl, "Наше лето", "ru");
      near(Number(title.timeline_in), 0, 2, "the title's start");
      near(span(title), 90, 6, "the title's length (3 s)");
    },
    expectTrace: (t) => repliesIn(t, "ru"),
  },
  {
    id: "lang_ru_subtitles_translated",
    title: "Subtitles in the person's language for speech in another (Russian over English)",
    tags: tags("ru", 1, 1, "captions", "transcript", "translation"),
    surface: "journey",
    scope: { add: ["text"], addTracks: true },
    seed: narrationSeed,
    prompt: "Сделай русские субтитры к тому, что говорят в этом ролике.",
    expectTools: ["get_transcript", "add_text_clips"],
    transcript: {
      media_ref: JOURNEY_NARRATION_REF,
      words: JOURNEY_WORDS.map(([, text, s, e]) => [text, s / FPS, e / FPS] as const),
    },
    maxRounds: 10,
    reference: [
      { calls: [["get_transcript", {}]] },
      addText([
        { timeline_in: 30, timeline_out: 90, content: "Добро пожаловать на шоу" },
        { timeline_in: 95, timeline_out: 141, content: "Сегодня мы" },
        { timeline_in: 145, timeline_out: 225, content: "создаём кое-что новое" },
      ]),
      {
        text: "Готово: добавил русские субтитры к речи — три фразы, со второй по восьмую секунду.",
      },
    ],
    expect: (tl) => {
      const subs = textClips(tl);
      assert(subs.length > 0, "no subtitles were added");
      for (const c of subs)
        assert(
          Number(c.timeline_in) >= 0 && Number(c.timeline_out) <= 300,
          `subtitle ${c.id} sits outside the clip (${c.timeline_in}-${c.timeline_out})`,
        );
      const first = Math.min(...subs.map((c) => Number(c.timeline_in)));
      const last = Math.max(...subs.map((c) => Number(c.timeline_out)));
      // The speech runs from frame 30 to 220: the subtitles start with it and reach its last words.
      assert(first <= 60, `the subtitles start at frame ${first}; the speech starts at 30`);
      assert(
        last >= JOURNEY_LAST_WORD_FRAME,
        `the subtitles end at frame ${last}, before the last words (from ${JOURNEY_LAST_WORD_FRAME})`,
      );
      const words = subs.map((c) => clipText(c)).join(" ");
      const russian = writtenIn(words, "ru");
      assert(russian.ok, `the subtitles are not Russian: ${russian.ok ? "" : russian.why}`);
      const english = SPOKEN_ENGLISH.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(words));
      assert(!english.length, `the subtitles keep the English words: ${english.join(", ")}`);
      const count = words.split(/\s+/).filter((w) => /\p{Script=Cyrillic}/u.test(w)).length;
      assert(count >= 5, `the subtitles hold ${count} Russian words for a ten-word sentence`);
    },
    expectTrace: (t) => {
      const read = t.toolCalls.findIndex((c) => c.ok && c.name === "get_transcript");
      const wrote = t.toolCalls.findIndex((c) => c.ok && c.name === "add_text_clips");
      assert(read >= 0 && read < wrote, "the subtitles were written without reading what is said");
      repliesIn(t, "ru");
    },
  },
  {
    id: "lang_ru_reel_brief",
    title: "A whole-video brief: a 10-second reel to music with a fade at the end (Russian)",
    tags: tags("ru", 1, 6, "whole-video", "music", "fade"),
    scope: {
      change: ["c1", "c2", "c3", "c4", "c5", "m"],
      remove: ["c1", "c2", "c3", "c4", "c5", "m"],
      add: ["video", "audio"],
    },
    seed: reelSeed,
    prompt:
      "Собери из этих клипов динамичный ролик ровно на 10 секунд под музыку. Музыка должна " +
      "заканчиваться вместе с видео, а в конце сделай плавное затемнение.",
    expectTools: ["ripple_delete", "set_clip_properties"],
    maxRounds: 14,
    reference: [
      {
        calls: [
          [
            "ripple_delete",
            {
              track_id: "v1",
              ranges: [60, 150, 240, 330, 420].map((start) => ({ start, end: start + 30 })),
              ignore_sync_locked_tracks: ["a1"],
            },
          ],
        ],
      },
      {
        calls: [
          ["set_clip_properties", { clip_ids: ["m"], duration: 300 }],
          ["set_clip_properties", { clip_ids: ["c5"], fade: { out: 30 } }],
        ],
      },
      {
        text:
          "Собрал ролик ровно на 10 секунд: по две секунды от каждого клипа. Музыка обрезана по " +
          "концу видео, а в конце плавное затемнение.",
      },
    ],
    // Which shots and how they are cut is taste; the length, the music and the fade were asked for.
    expect: (tl) => {
      const end = pictureEnd(tl);
      near(end, 300, 6, "the video's length in frames (10 s)");
      assert(contiguousFrom(tl, "v1", 0, 2), "the 10 seconds have black holes between the clips");
      const music = playing(tl, "music.mp3");
      assert(music.length > 0, "the music is gone");
      const from = Math.min(...music.map((c) => Number(c.timeline_in)));
      const to = Math.max(...music.map((c) => Number(c.timeline_out)));
      assert(from <= 6, `the music starts at frame ${from}, not under the start of the video`);
      assert(
        Math.abs(to - end) <= 6,
        `the music ends at frame ${to} and the video at ${end}; asked to end together`,
      );
      const lastShot = picture(tl).find((c) => Number(c.timeline_out) === end);
      assert(lastShot && fadesOut(lastShot, 10), "the video does not fade to black at the end");
    },
    expectTrace: (t) => repliesIn(t, "ru"),
  },
  {
    id: "lang_ru_followup_wrong_clip",
    title: "A correction on the next turn: not that clip, the other one (Russian)",
    tags: tags("ru", 2, 2, "multi-turn", "correction", "trim"),
    scope: { change: ["a", "b"] },
    seed: row(150, 150),
    prompt: "Сделай первый клип короче на пару секунд.",
    followUps: ["Ой, не тот. Верни первый как было, а укороти второй."],
    expectTools: ["set_clip_properties", "undo"],
    maxRounds: 10,
    reference: [
      { calls: [["set_clip_properties", { clip_ids: ["a"], duration: 90 }]] },
      { text: "Укоротил первый клип на две секунды, теперь он длится три секунды." },
      { calls: [["undo", {}]] },
      { calls: [["set_clip_properties", { clip_ids: ["b"], duration: 90 }]] },
      { text: "Вернул первый клип как было и укоротил второй на две секунды." },
    ],
    expect: (tl) => {
      const a = clipById(tl, "a");
      assert(a, "the first clip is gone");
      near(Number(a.timeline_in), 0, 1, "the first clip's start");
      near(span(a), 150, 2, "the first clip's length, put back");
      near(Number(a.source_in ?? 0), 0, 2, "the first clip's first frame, put back");
      const b = playing(tl, "b.mp4");
      assert(b.length > 0, "the second clip is gone");
      near(Number(b[0].timeline_in), 150, 2, "the second clip's start, right after the first");
      const kept = b.reduce((n, c) => n + span(c), 0);
      // "A couple of seconds": about two, so 1.5 to 2.5 s shorter than its 5 s.
      assert(kept >= 75 && kept <= 105, `the second clip runs ${kept} frames; 150 less about 60`);
    },
    expectTrace: (t) => repliesIn(t, "ru"),
  },
  {
    id: "lang_ru_slang_library_music",
    title: "Slang: put the library's music under the video, quieter (Russian)",
    tags: tags("ru", 1, 1, "slang", "music", "library"),
    surface: "studio",
    scope: { add: ["audio"], addTracks: true },
    seed: one(150),
    // закинь = put in, музон = music, тока = только, норм = нормально.
    prompt:
      "закинь музон из библиотеки под весь ролик, тока потише сделай, чтоб голос норм было слышно",
    expectTools: ["library_op", "add_clips", "set_clip_properties"],
    // The library has a music bed: making new music is the paid path nobody asked for.
    mustNotCall: ["generate_music"],
    maxRounds: 10,
    reference: [
      { calls: [["library_op", { action: "list" }]] },
      {
        calls: [
          [
            "add_clips",
            { entries: [{ media_ref: "media_bed", timeline_in: 0, timeline_out: 150 }] },
          ],
        ],
      },
      {
        calls: (req) => [
          ["set_clip_properties", { clip_ids: createdBy(req, "add_clips"), volume: 0.35 }],
        ],
      },
      {
        text: "Закинул музыку из библиотеки под весь ролик и сделал её потише, чтобы голос было слышно.",
      },
    ],
    expect: (tl) => {
      const bed = fromLibrary(tl, "media_bed", "bed.mp3");
      assert(bed.length > 0, "the library's music is not on the timeline");
      for (const c of bed)
        assert(trackKindOf(tl, c) === "audio", `the music landed on a ${trackKindOf(tl, c)} track`);
      const from = Math.min(...bed.map((c) => Number(c.timeline_in)));
      const to = Math.max(...bed.map((c) => Number(c.timeline_out)));
      assert(from <= 3 && to >= 147, `the music plays ${from}-${to}, not under the whole video`);
      assert(to <= 156, `the music runs on to frame ${to}, past the end of the video (150)`);
      for (const c of bed) {
        const v = c.volume;
        const levels = Array.isArray(v) ? v.map((k) => Number(k.v)) : [Number(v ?? 1)];
        const quieter = levels.every((x) => x <= 0.7) || c.duck != null;
        assert(quieter, `the music plays at ${JSON.stringify(v ?? 1)}; asked for it quieter`);
      }
    },
    expectTrace: (t) => repliesIn(t, "ru"),
  },
  {
    id: "lang_ru_voiceover_words",
    title: "A voiceover that says the person's words in their language (Russian)",
    tags: tags("ru", 2, 1, "generation", "voiceover", "job-landed"),
    surface: "studio",
    scope: { add: ["audio"], addTracks: true },
    seed: one(300),
    prompt: "Озвучь фразу «Добро пожаловать на наш канал» и поставь её в самое начало видео.",
    // The voiceover's length is known once it lands, and the tool says to place it then: the app
    // wakes the chat when it does.
    followUps: [VOICEOVER_LANDED],
    expectTools: ["generate_voiceover", "add_clips"],
    paidTools: ["generate_voiceover"],
    maxRounds: 10,
    reference: [
      {
        calls: [["generate_voiceover", { text: "Добро пожаловать на наш канал", language: "ru" }]],
      },
      {
        text: "Озвучка генерируется; как только она будет готова, поставлю её в самое начало видео.",
      },
      {
        calls: [["add_clips", { entries: [{ media_ref: STUDIO_VOICEOVER_REF, timeline_in: 0 }] }]],
      },
      { text: "Озвучка «Добро пожаловать на наш канал» готова и стоит в самом начале видео." },
    ],
    expect: (tl) => {
      const vo = playing(tl, STUDIO_VOICEOVER_REF);
      assert(vo.length > 0, "the voiceover never reached the timeline");
      assert(vo.length === 1, `the voiceover is on the timeline ${vo.length} times`);
      assert(trackKindOf(tl, vo[0]) === "audio", "the voiceover is not on an audio track");
      near(Number(vo[0].timeline_in), 0, 3, "the voiceover's start");
    },
    // The stand-in speaks nothing, so what the voice would say is only in what it was asked to say.
    expectTrace: (t) => {
      const asks = succeeded(t, "generate_voiceover");
      assert(asks.length > 0, "no voiceover was made");
      for (const c of asks) {
        const text = String(c.args.text ?? c.args.script ?? "");
        assert(
          shows(text, "Добро пожаловать на наш канал", "ru"),
          `the voiceover was asked to say ${JSON.stringify(text)}, not the person's Russian words`,
        );
        const code = c.args.language;
        assert(
          code === undefined || code === null || /^ru\b/i.test(String(code)),
          `the voiceover was made as language ${String(code)}`,
        );
      }
      repliesIn(t, "ru");
    },
  },
  {
    id: "lang_ru_en_mixed_jargon",
    title: "Russian with English editing words: a fade in and a crossfade on every cut",
    tags: tags("ru+en", 1, 3, "mixed", "fade", "transition"),
    scope: { change: ["a", "b", "c"] },
    seed: row(90, 90, 90),
    // Mixed on purpose, so the reply's language is not graded.
    prompt: "сделай fade in на первом клипе и crossfade на всех склейках, по полсекунды",
    expectTools: ["set_clip_properties", "set_transition"],
    maxRounds: 6,
    reference: [
      {
        calls: [
          ["set_clip_properties", { clip_ids: ["a"], fade: { in: 15 } }],
          crossfade("b", 15),
          crossfade("c", 15),
        ],
      },
      { text: "Сделал fade in на первом клипе и crossfade по полсекунды на обеих склейках." },
    ],
    expect: (tl) => {
      const a = clipById(tl, "a") as Any;
      assert(a, "the first clip is gone");
      if (a.fade?.in != null) near(Number(a.fade.in), 15, 4, "the fade in on the first clip");
      else {
        const o = Array.isArray(a.opacity)
          ? [...a.opacity].sort((x: Any, y: Any) => x.t - y.t)
          : [];
        assert(o.length >= 2 && Number(o[0].v) <= 0.2, "the first clip does not fade in");
        const full = o.find((k: Any) => Number(k.v) >= 0.8);
        assert(full, "the first clip's fade never reaches full opacity");
        near(Number(full.t) - Number(o[0].t), 15, 4, "the fade in on the first clip");
      }
      for (const id of ["b", "c"]) {
        const tr = (clipById(tl, id) as Any)?.transition_in;
        assert(tr, `no crossfade into clip ${id}`);
        assert(/cross|dissolve/i.test(String(tr.kind)), `the cut into ${id} is a ${tr.kind}`);
        near(Number(tr.duration), 15, 3, `the crossfade into ${id}`);
      }
    },
  },
];

const UKRAINIAN: Scenario[] = [
  {
    id: "lang_uk_last_clip_first",
    title: "Move the last clip to the start, the rest after it (Ukrainian)",
    tags: tags("uk", 1, 3, "single-edit", "reorder"),
    scope: { change: ["a", "b", "c"] },
    seed: row(60, 60, 60),
    prompt: "Перестав останній кліп на самий початок, а решта хай іде за ним.",
    expectTools: ["move_clips"],
    maxRounds: 6,
    reference: [
      {
        calls: [
          [
            "move_clips",
            {
              moves: [
                { clip_id: "c", to_timeline_in: 0 },
                { clip_id: "a", to_timeline_in: 60 },
                { clip_id: "b", to_timeline_in: 120 },
              ],
            },
          ],
        ],
      },
      { text: "Переставив останній кліп на початок, решта йде за ним у тому ж порядку." },
    ],
    expect: (tl) => {
      const order = clipsOf(tl, "v1").map((c) => c.media_ref);
      assert(
        JSON.stringify(order) === JSON.stringify(["c.mp4", "a.mp4", "b.mp4"]),
        `the clips play ${order.join(", ")}; asked for c, a, b`,
      );
      assert(contiguousFrom(tl, "v1", 0, 2), "the clips no longer follow one another");
      for (const c of clipsOf(tl, "v1")) near(span(c), 60, 1, `${c.media_ref}'s length`);
    },
    expectTrace: (t) => repliesIn(t, "uk"),
  },
  {
    id: "lang_uk_lower_third",
    title: "A caption at the bottom of the frame between two timecodes (Ukrainian)",
    tags: tags("uk", 1, 1, "text", "lower-third", "position"),
    scope: { add: ["text"], addTracks: true },
    seed: one(240),
    prompt: "Додай унизу кадру підпис «Київ, весна 2026» з 0:02 до 0:06.",
    expectTools: ["add_text_clips"],
    maxRounds: 5,
    reference: [
      addText([
        {
          timeline_in: 60,
          timeline_out: 180,
          content: "Київ, весна 2026",
          transform: { position: { x: 0.5, y: 0.85 } },
        },
      ]),
      { text: "Додав унизу кадру підпис «Київ, весна 2026» з 0:02 до 0:06." },
    ],
    expect: (tl) => {
      const cap = titleShowing(tl, "Київ, весна 2026", "uk");
      near(Number(cap.timeline_in), 60, 3, "the caption's start (0:02)");
      near(Number(cap.timeline_out), 180, 3, "the caption's end (0:06)");
      const y = heightOf(cap);
      assert(y >= 0.6, `the caption's centre is at ${y} of the frame's height, not at the bottom`);
    },
    expectTrace: (t) => repliesIn(t, "uk"),
  },
  {
    id: "lang_uk_library_edit",
    title: "A whole video from the library, in a given order, nothing generated (Ukrainian)",
    tags: tags("uk", 1, 0, "whole-video", "library", "placement"),
    surface: "studio",
    scope: { add: ["video", "image", "audio"], addTracks: true },
    seed: emptyStudio,
    prompt:
      "Змонтуй мені коротке відео з того, що є в бібліотеці: спершу кадри міста, потім океан, " +
      "а в кінці на дві секунди логотип. Нічого не генеруй.",
    expectTools: ["library_op", "add_clips"],
    maxRounds: 10,
    reference: [
      { calls: [["library_op", { action: "list" }]] },
      {
        calls: [
          [
            "add_clips",
            {
              entries: [
                { media_ref: "media_broll_city", timeline_in: 0, timeline_out: 150 },
                { media_ref: "media_broll_ocean", timeline_in: 150, timeline_out: 300 },
                { media_ref: "logo.png", timeline_in: 300, timeline_out: 360 },
              ],
            },
          ],
        ],
      },
      {
        text:
          "Змонтував відео з бібліотеки: спершу місто, потім океан, а в кінці логотип на дві " +
          "секунди. Нічого не генерував.",
      },
    ],
    expect: (tl) => {
      const city = fromLibrary(tl, "media_broll_city", "city.mp4");
      const ocean = fromLibrary(tl, "media_broll_ocean", "ocean.mp4");
      const logo = fromLibrary(tl, "logo.png", "logo.png");
      assert(
        city.length && ocean.length && logo.length,
        "the city, the ocean or the logo is missing",
      );
      const end = (cs: Clip[]) => Math.max(...cs.map((c) => Number(c.timeline_out)));
      const start = (cs: Clip[]) => Math.min(...cs.map((c) => Number(c.timeline_in)));
      assert(start(city) <= 2, `the video does not open on the city (it starts at ${start(city)})`);
      assert(
        Math.abs(start(ocean) - end(city)) <= 6,
        `the ocean starts at ${start(ocean)}, not right after the city (${end(city)})`,
      );
      assert(
        Math.abs(start(logo) - end(ocean)) <= 6,
        `the logo starts at ${start(logo)}, not right after the ocean (${end(ocean)})`,
      );
      near(end(logo) - start(logo), 60, 4, "the logo's length (2 s)");
      assert(pictureEnd(tl) <= end(logo) + 2, "something plays after the logo");
    },
    expectTrace: (t) => repliesIn(t, "uk"),
  },
  {
    id: "lang_uk_music_confirm",
    title: "Generated music, confirmed on the next turn, made once (Ukrainian)",
    tags: tags("uk", 3, 1, "multi-turn", "confirm", "generation", "music", "job-landed"),
    surface: "studio",
    scope: { add: ["audio"], addTracks: true },
    seed: one(150),
    prompt: "Згенеруй спокійну музику без слів і постав її під усе відео.",
    // The person's yes, then the app's word that the music landed (it wakes the chat).
    followUps: ["Так, давай.", MUSIC_LANDED],
    expectTools: ["generate_music", "add_clips"],
    paidTools: ["generate_music"],
    maxRounds: 14,
    reference: [
      {
        text: "Генерація музики платна, тож уточню: згенерувати спокійну інструментальну музику під усе відео?",
      },
      {
        calls: [
          [
            "generate_music",
            { prompt: "calm ambient instrumental, soft piano", instrumental: true },
          ],
        ],
      },
      {
        calls: [
          [
            "add_clips",
            { entries: [{ media_ref: STUDIO_MUSIC_REF, timeline_in: 0, timeline_out: 150 }] },
          ],
        ],
      },
      { text: "Готово: згенерував спокійну музику без слів і поставив її під усе відео." },
      { text: "Музика вже готова й стоїть під усім відео, більше нічого робити не треба." },
    ],
    expect: (tl) => {
      const music = playing(tl, STUDIO_MUSIC_REF);
      assert(music.length > 0, "the music never reached the timeline");
      assert(music.length === 1, `the music is on the timeline ${music.length} times`);
      assert(trackKindOf(tl, music[0]) === "audio", "the music is not on an audio track");
      const from = Math.min(...music.map((c) => Number(c.timeline_in)));
      const to = Math.max(...music.map((c) => Number(c.timeline_out)));
      assert(from <= 3 && to >= 144, `the music plays ${from}-${to}, not under the whole video`);
      assert(to <= 156, `the music runs on to frame ${to}, past the end of the video (150)`);
    },
    // "Yes, go ahead" after the music was already made is no reason to pay for it twice.
    expectTrace: (t) => {
      const made = succeeded(t, "generate_music");
      assert(made.length === 1, `music was generated ${made.length} times`);
      assert(made[0].args.instrumental !== false, "asked for music without words, made with them");
      repliesIn(t, "uk");
    },
  },
  {
    id: "lang_uk_greeting",
    title: "A greeting is answered in the person's language, and nothing changes (Ukrainian)",
    tags: tags("uk", 1, 1, "chit-chat", "read-only"),
    scope: {},
    seed: one(150),
    prompt: "Привіт! Ти розумієш українську?",
    maxRounds: 3,
    reference: [{ text: "Привіт! Так, я розумію українську. Чим можу допомогти з відео?" }],
    expect: untouched(one(150)),
    expectTrace: (t) => repliesIn(t, "uk"),
  },
];

const TURKISH: Scenario[] = [
  {
    id: "lang_tr_title_letters",
    title: "A title keeps its Turkish letters (ş, ı)",
    tags: tags("tr", 1, 1, "text", "title"),
    scope: { add: ["text"], addTracks: true },
    seed: one(150),
    prompt: "Videonun başına 'Kış tatili başlıyor' yazısını ekle, iki saniye ekranda kalsın.",
    expectTools: ["add_text_clips"],
    maxRounds: 5,
    reference: [
      addText([{ timeline_in: 0, timeline_out: 60, content: "Kış tatili başlıyor" }]),
      {
        text: "Videonun başına 'Kış tatili başlıyor' yazısını ekledim, ilk iki saniye ekranda kalıyor.",
      },
    ],
    expect: (tl) => {
      const title = titleShowing(tl, "Kış tatili başlıyor", "tr");
      near(Number(title.timeline_in), 0, 2, "the title's start");
      near(span(title), 60, 6, "the title's length (2 s)");
    },
    expectTrace: (t) => repliesIn(t, "tr"),
  },
  {
    id: "lang_tr_vertical_short",
    title: "A brief: vertical for Instagram, at most 15 seconds, a big title (Turkish)",
    tags: tags("tr", 1, 3, "whole-video", "canvas", "text"),
    scope: {
      canvas: ["width", "height"],
      change: ["a", "b", "c"],
      remove: ["a", "b", "c"],
      add: ["video", "text"],
      addTracks: true,
    },
    seed: landscapeRow,
    prompt:
      "Bunu Instagram için dikey formata çevir, 15 saniyeyi de geçmesin. Başa büyük bir başlık " +
      "koy: 'Hafta sonu kaçamağı'.",
    expectTools: ["set_project_settings", "ripple_delete", "add_text_clips"],
    maxRounds: 12,
    reference: [
      { calls: [["set_project_settings", { size: { aspect_ratio: "9:16" } }]] },
      { calls: [["ripple_delete", { track_id: "v1", start: 450, end: 720 }]] },
      addText([
        { timeline_in: 0, timeline_out: 90, content: "Hafta sonu kaçamağı", style: { size: "xl" } },
      ]),
      {
        text:
          "Videoyu Instagram için dikey formata çevirdim, 15 saniyeye kısalttım ve başa büyük bir " +
          "başlık ekledim.",
      },
    ],
    expect: (tl) => {
      const { width, height, fps } = tl.canvas;
      assert(Number(height) > Number(width), `the canvas is ${width}x${height}, not vertical`);
      // Nothing asked about the frame rate: it stays as it is.
      assert(Number(fps) === FPS, `the frame rate changed to ${fps}`);
      assert(picture(tl).length > 0, "no footage is left");
      const end = pictureEnd(tl);
      assert(end <= 453, `the video runs ${end} frames, over 15 s (450)`);
      const title = titleShowing(tl, "Hafta sonu kaçamağı", "tr");
      near(Number(title.timeline_in), 0, 3, "the title's start");
      // How big "big" is was left open, so the title's size is not graded.
    },
    expectTrace: (t) => repliesIn(t, "tr"),
  },
  {
    id: "lang_tr_bw_undo_first_only",
    title: "Black and white on every clip, then: undo, only the first (Turkish)",
    tags: tags("tr", 2, 3, "multi-turn", "undo", "color"),
    scope: { change: ["a", "b", "c"] },
    seed: row(90, 90, 90),
    prompt: "Bütün kliplere siyah beyaz efekt ver.",
    followUps: ["Hmm, böyle olmadı. Geri al, sadece ilk klibe uygula."],
    expectTools: ["apply_color", "undo"],
    maxRounds: 10,
    reference: [
      { calls: [["apply_color", { clip_ids: ["a", "b", "c"], saturation: 0 }]] },
      { text: "Tamam, tüm kliplere siyah beyaz efekt uyguladım." },
      { calls: [["undo", {}]] },
      { calls: [["apply_color", { clip_ids: ["a"], saturation: 0 }]] },
      { text: "Geri aldım; siyah beyaz artık sadece ilk klipte." },
    ],
    expect: (tl) => {
      assert(isMonochrome(clipById(tl, "a")), "the first clip is not black and white");
      for (const id of ["b", "c"])
        assert(!isMonochrome(clipById(tl, id)), `clip ${id} is still black and white`);
    },
    expectTrace: (t) => repliesIn(t, "tr"),
  },
  {
    id: "lang_tr_typed_without_letters",
    title: "Typed without Turkish letters: shorten to 10 s from the end",
    tags: tags("tr", 1, 2, "typo", "trim"),
    scope: { change: ["b"], remove: ["b"], add: ["video"] },
    seed: row(240, 240),
    // "kısalt" typed as "kisalt", the way a keyboard without Turkish letters writes it.
    prompt: "videoyu 10 saniyeye kisalt, sondan kes",
    expectTools: ["ripple_delete", "set_clip_properties"],
    maxRounds: 6,
    reference: [
      { calls: [["ripple_delete", { track_id: "v1", start: 300, end: 480 }]] },
      { text: "Videoyu sondan kestim, şimdi tam 10 saniye." },
    ],
    expect: (tl) => {
      near(pictureEnd(tl), 300, 3, "the video's length in frames (10 s)");
      const a = clipById(tl, "a");
      assert(a, "the first clip is gone: the cut was not made at the end");
      near(Number(a.timeline_in), 0, 1, "the first clip's start");
      near(span(a), 240, 2, "the first clip's length");
      near(Number(a.source_in ?? 0), 0, 2, "the first clip's first frame");
      const b = playing(tl, "b.mp4");
      assert(b.length === 1, `the second clip is in ${b.length} pieces`);
      near(Number(b[0].timeline_in), 240, 2, "the second clip's start");
      near(Number(b[0].source_in ?? 0), 0, 2, "the second clip keeps its start");
    },
    expectTrace: (t) => repliesIn(t, "tr"),
  },
];

const POLISH: Scenario[] = [
  {
    id: "lang_pl_crossfade_every_cut",
    title: "Half-second crossfades on every cut (Polish)",
    tags: tags("pl", 1, 4, "single-edit", "transition", "number-word"),
    scope: { change: ["a", "b", "c", "d"] },
    seed: row(90, 90, 90, 90),
    prompt: "Dodaj przenikanie między wszystkimi klipami, każde po pół sekundy.",
    expectTools: ["set_transition"],
    maxRounds: 6,
    reference: [
      { calls: [crossfade("b", 15), crossfade("c", 15), crossfade("d", 15)] },
      { text: "Dodałem przenikanie po pół sekundy na wszystkich trzech cięciach między klipami." },
    ],
    expect: (tl) => {
      for (const id of ["b", "c", "d"]) {
        const tr = (clipById(tl, id) as Any)?.transition_in;
        assert(tr, `no crossfade into clip ${id}`);
        assert(/cross|dissolve/i.test(String(tr.kind)), `the cut into ${id} is a ${tr.kind}`);
        near(Number(tr.duration), 15, 3, `the crossfade into ${id} (half a second)`);
      }
    },
    expectTrace: (t) => repliesIn(t, "pl"),
  },
  {
    id: "lang_pl_end_text_no_accents",
    title: "Text typed without Polish letters, on the last two seconds",
    tags: tags("pl", 1, 2, "typo", "text"),
    scope: { add: ["text"], addTracks: true },
    seed: row(150, 150),
    // Typed without its accents: końcu, dzięki, oglądanie. Either spelling on screen is right.
    prompt: "dodaj na koncu napis 'dzieki za ogladanie' na ostatnie 2 sekundy",
    expectTools: ["add_text_clips"],
    maxRounds: 5,
    reference: [
      addText([{ timeline_in: 240, timeline_out: 300, content: "Dzięki za oglądanie" }]),
      { text: "Dodałem na końcu napis „Dzięki za oglądanie” na ostatnie 2 sekundy." },
    ],
    expect: (tl) => {
      const text = titleShowing(tl, "dzieki za ogladanie", "pl", { accents: false });
      near(Number(text.timeline_in), 240, 3, "the text's start (2 s before the end)");
      near(Number(text.timeline_out), 300, 3, "the text's end (the end of the video)");
    },
    expectTrace: (t) => repliesIn(t, "pl"),
  },
  {
    id: "lang_pl_title_up_and_yellow",
    title: "A title, then on the next turn: a bit higher and yellow (Polish)",
    tags: tags("pl", 2, 1, "multi-turn", "text", "restyle"),
    scope: { add: ["text"], addTracks: true },
    seed: one(150),
    prompt: "Dodaj na środku ekranu tytuł 'Nasza podróż' na pierwsze trzy sekundy.",
    followUps: ["Przesuń go trochę wyżej i zmień kolor na żółty."],
    expectTools: ["add_text_clips", "update_text"],
    maxRounds: 10,
    reference: [
      addText([{ timeline_in: 0, timeline_out: 90, content: "Nasza podróż" }]),
      { text: "Dodałem tytuł 'Nasza podróż' na środku ekranu na pierwsze trzy sekundy." },
      // A new turn: the title's id is in the timeline, read again here.
      { calls: [["get_timeline", {}]] },
      {
        calls: (req) => [
          [
            "update_text",
            {
              clip_ids: textIdsRead(req),
              transform: { position: { x: 0.5, y: 0.38 } },
              style: { color: "#FFD400" },
            },
          ],
        ],
      },
      { text: "Przesunąłem tytuł trochę wyżej i zmieniłem jego kolor na żółty." },
    ],
    expect: (tl) => {
      const title = titleShowing(tl, "Nasza podróż", "pl");
      near(Number(title.timeline_in), 0, 2, "the title's start");
      near(span(title), 90, 6, "the title's length (3 s)");
      const y = heightOf(title);
      assert(y < 0.48, `the title's centre is at ${y} of the height: not moved up from the middle`);
      assert(y >= 0.05, `the title's centre is at ${y} of the height: off the top of the frame`);
      // Yellow on the title, or on every run of its words.
      const runs = Array.isArray(title.content) ? title.content : [];
      const yellow =
        isYellow((title.style as Any)?.color) ||
        (runs.length > 0 && runs.every((r) => isYellow((r.style as Any)?.color)));
      assert(yellow, "the title is not yellow");
    },
    // Moved and recoloured, not deleted and made again (update_text): the same clip throughout.
    // Read only where the trace kept the first turn's reply, which names the clip it made.
    expectTrace: (t, final) => {
      const made = succeeded(t, "add_text_clips").find((c) => (c.turn ?? 0) === 0);
      const reply = made ? String(made.result ?? "") : "";
      if (final && reply) {
        const now = textClips(final).filter((c) => shows(clipText(c), "Nasza podróż", "pl"));
        assert(
          now.some((c) => typeof c.id === "string" && reply.includes(c.id)),
          "the first turn's title was deleted and made again, not moved and recoloured",
        );
      }
      repliesIn(t, "pl");
    },
  },
  {
    id: "lang_pl_teaser_structure",
    title: "A teaser brief: a black card with text, every clip in order, the logo last (Polish)",
    tags: tags("pl", 1, 3, "whole-video", "structure", "text", "library"),
    surface: "studio",
    scope: { change: ["a", "b", "c"], add: ["text", "image", "video"], addTracks: true },
    seed: row(90, 90, 90),
    prompt:
      "Zrób z tego zwiastun: najpierw dwie sekundy czarnego ekranu z napisem 'Wkrótce', potem " +
      "wszystkie klipy po kolei, a na sam koniec logo z biblioteki na trzy sekundy.",
    expectTools: ["move_clips", "add_text_clips", "add_clips"],
    maxRounds: 12,
    reference: [
      {
        calls: [
          [
            "move_clips",
            {
              moves: [
                { clip_id: "c", to_timeline_in: 240 },
                { clip_id: "b", to_timeline_in: 150 },
                { clip_id: "a", to_timeline_in: 60 },
              ],
            },
          ],
        ],
      },
      {
        calls: [
          [
            "add_text_clips",
            { entries: [{ timeline_in: 0, timeline_out: 60, content: "Wkrótce" }] },
          ],
          [
            "add_clips",
            { entries: [{ media_ref: "logo.png", timeline_in: 330, timeline_out: 420 }] },
          ],
        ],
      },
      {
        text:
          "Zrobiłem zwiastun: najpierw dwie sekundy czarnego ekranu z napisem 'Wkrótce', potem " +
          "wszystkie klipy po kolei, a na końcu logo z biblioteki na trzy sekundy.",
      },
    ],
    expect: (tl) => {
      const card = titleShowing(tl, "Wkrótce", "pl");
      near(Number(card.timeline_in), 0, 2, "the text's start");
      near(Number(card.timeline_out), 60, 3, "the text's end (2 s)");
      const under = picture(tl).filter(
        (c) => Number(c.timeline_in) < 57 && Number(c.timeline_out) > 3,
      );
      assert(
        !under.length,
        `the card is not black: ${under.map((c) => c.media_ref)} plays under it`,
      );
      let at = 60;
      for (const ref of ["a.mp4", "b.mp4", "c.mp4"]) {
        const shot = playing(tl, ref);
        assert(shot.length === 1, `${ref} is on the timeline ${shot.length} times`);
        near(Number(shot[0].timeline_in), at, 3, `${ref}'s start, in order after the card`);
        near(span(shot[0]), 90, 2, `${ref}'s length`);
        at += 90;
      }
      const logo = playing(tl, "logo.png");
      assert(logo.length === 1, "the logo is not at the end");
      near(Number(logo[0].timeline_in), at, 3, "the logo's start, after the last clip");
      near(span(logo[0]), 90, 4, "the logo's length (3 s)");
      assert(pictureEnd(tl) <= at + 92, "something plays after the logo");
    },
    expectTrace: (t) => repliesIn(t, "pl"),
  },
];

const INDONESIAN: Scenario[] = [
  {
    id: "lang_id_slang_music_half",
    title: "Slang: the music at half, the video's sound left alone (Indonesian)",
    tags: tags("id", 1, 2, "slang", "audio"),
    scope: { change: ["m"] },
    seed: musicUnderClip,
    // kegedean = too loud, kecilin = make it smaller, aja = just, biarin = leave it.
    prompt: "musiknya kegedean, kecilin jadi setengahnya aja. suara videonya biarin",
    expectTools: ["set_clip_properties"],
    maxRounds: 5,
    reference: [
      { calls: [["set_clip_properties", { clip_ids: ["m"], volume: 0.5 }]] },
      { text: "Oke, musiknya sudah saya kecilkan jadi setengah. Suara videonya tidak saya ubah." },
    ],
    expect: (tl) => near(numOf(clipById(tl, "m")?.volume ?? 1), 0.5, 0.07, "the music's volume"),
    expectTrace: (t) => repliesIn(t, "id"),
  },
  {
    id: "lang_id_three_timed_texts",
    title: "Three texts at the seconds the person names (Indonesian)",
    tags: tags("id", 1, 1, "text", "timing"),
    scope: { add: ["text"], addTracks: true },
    seed: one(450),
    prompt:
      "Tolong tambahkan teks 'Hari 1' di awal, 'Hari 2' mulai detik ke-5, dan 'Hari 3' mulai " +
      "detik ke-10. Masing-masing muncul 2 detik.",
    expectTools: ["add_text_clips"],
    maxRounds: 5,
    reference: [
      addText([
        { timeline_in: 0, timeline_out: 60, content: "Hari 1" },
        { timeline_in: 150, timeline_out: 210, content: "Hari 2" },
        { timeline_in: 300, timeline_out: 360, content: "Hari 3" },
      ]),
      {
        text:
          "Sudah saya tambahkan: 'Hari 1' di awal, 'Hari 2' mulai detik ke-5, dan 'Hari 3' mulai " +
          "detik ke-10, masing-masing 2 detik.",
      },
    ],
    expect: (tl) => {
      [0, 150, 300].forEach((at, i) => {
        const want = new RegExp(`\\bhari ${i + 1}\\b`, "iu");
        const hits = textClips(tl).filter((c) => want.test(clipText(c)));
        assert(hits.length === 1, `${hits.length} texts say "Hari ${i + 1}"`);
        near(Number(hits[0].timeline_in), at, 3, `"Hari ${i + 1}"'s start`);
        near(span(hits[0]), 60, 4, `"Hari ${i + 1}"'s length (2 s)`);
      });
    },
    expectTrace: (t) => repliesIn(t, "id"),
  },
  {
    id: "lang_id_question_then_delete",
    title: "A question, then: delete the shortest and close up (Indonesian)",
    tags: tags("id", 2, 3, "multi-turn", "question", "ripple"),
    scope: { remove: ["b"], change: ["c"] },
    seed: row(150, 60, 180),
    prompt: "Ada berapa klip di timeline sekarang?",
    followUps: ["Oke, hapus yang paling pendek, terus rapatkan sisanya."],
    expectTools: ["get_timeline", "ripple_delete"],
    maxRounds: 8,
    reference: [
      { calls: [["get_timeline", {}]] },
      {
        text: "Sekarang ada 3 klip di timeline: yang pertama 5 detik, yang kedua 2 detik, dan yang ketiga 6 detik.",
      },
      { calls: [["ripple_delete", { track_id: "v1", start: 150, end: 210 }]] },
      { text: "Oke, klip yang paling pendek sudah saya hapus dan sisanya sudah dirapatkan." },
    ],
    expect: (tl) => {
      assert(!playing(tl, "b.mp4").length, "the shortest clip (b, 2 s) is still there");
      const a = clipById(tl, "a");
      assert(a && Number(a.timeline_in) === 0 && span(a) === 150, "the first clip was changed");
      const c = playing(tl, "c.mp4");
      assert(c.length === 1, "the last clip is gone or cut");
      near(Number(c[0].timeline_in), 150, 2, "the last clip's start, closed up");
      near(span(c[0]), 180, 2, "the last clip's length");
    },
    // The first turn is judged where the trace tells the turns apart.
    expectTrace: (t) => {
      if ((t.turnTexts?.length ?? 0) >= 2) {
        const first = t.turnTexts![0];
        assert(
          /\b3\b|\btiga\b/i.test(first),
          `the answer to "how many" is not 3: ${first.slice(0, 120)}`,
        );
      }
      if (t.toolCalls.some((c) => typeof c.turn === "number")) {
        const edits = t.toolCalls.filter((c) => c.ok && c.turn === 0 && !READS.has(c.name));
        assert(!edits.length, `a question was answered with an edit (${edits.map((c) => c.name)})`);
      }
      repliesIn(t, "id");
    },
  },
];

const SPANISH: Scenario[] = [
  {
    id: "lang_es_second_clip_not_seconds",
    title: "'El segundo clip' is the second clip, not two seconds (Spanish)",
    tags: tags("es", 1, 3, "single-edit", "ripple", "ordinal"),
    scope: { remove: ["b"], change: ["c"] },
    seed: row(60, 90, 60),
    prompt: "Quita el segundo clip y que no quede ningún hueco.",
    expectTools: ["ripple_delete", "remove_clips"],
    maxRounds: 5,
    reference: [
      { calls: [["ripple_delete", { track_id: "v1", start: 60, end: 150 }]] },
      { text: "Listo: quité el segundo clip y moví el tercero para que no quede ningún hueco." },
    ],
    expect: (tl) => {
      assert(!playing(tl, "b.mp4").length, "the second clip is still there");
      const a = clipById(tl, "a");
      assert(a && Number(a.timeline_in) === 0 && span(a) === 60, "the first clip was changed");
      near(Number(a.source_in ?? 0), 0, 1, "the first clip's first frame");
      const c = playing(tl, "c.mp4");
      assert(c.length === 1, "the third clip is gone or cut");
      near(Number(c[0].timeline_in), 60, 2, "the third clip's start, with no gap");
      near(span(c[0]), 60, 2, "the third clip's length");
    },
    expectTrace: (t) => repliesIn(t, "es"),
  },
  {
    id: "lang_es_title_bigger_bold",
    title: "An existing title, made bigger and bold (Spanish)",
    tags: tags("es", 1, 2, "text", "restyle"),
    scope: { change: ["title"] },
    seed: titleSeed,
    prompt: "El título se ve muy pequeño. Ponlo más grande y en negrita.",
    expectTools: ["update_text"],
    maxRounds: 5,
    reference: [
      { calls: [["update_text", { clip_ids: ["title"], style: { size: "l", bold: true } }]] },
      { text: "Listo: puse el título más grande y en negrita." },
    ],
    expect: (tl) => {
      const title = clipById(tl, "title");
      assert(title, "the title was deleted");
      assert(shows(clipText(title), "Rebajas de verano", "es"), "the title's words changed");
      assert(
        Number(title.timeline_in) === 0 && Number(title.timeline_out) === 90,
        "the title moved",
      );
      const before = typeSize(titleSeed().tracks[1].clips![0], tl);
      const after = typeSize(title, tl);
      assert(after > before, `the title is ${after}px, not bigger than ${before}px`);
      assert(isBold(title, tl), "the title is not bold");
    },
    expectTrace: (t) => repliesIn(t, "es"),
  },
  {
    id: "lang_es_followup_same_at_end",
    title: "Cut the first 3 seconds, then 'now the same at the end' (Spanish)",
    tags: tags("es", 2, 1, "multi-turn", "trim"),
    scope: { change: ["a"], remove: ["a"], add: ["video"] },
    seed: one(450),
    prompt: "Corta los primeros 3 segundos del video.",
    followUps: ["Perfecto. Ahora haz lo mismo con el final."],
    expectTools: ["ripple_delete", "set_clip_properties"],
    maxRounds: 8,
    reference: [
      { calls: [["ripple_delete", { track_id: "v1", start: 0, end: 90 }]] },
      { text: "Listo, corté los primeros 3 segundos del video." },
      { calls: [["ripple_delete", { track_id: "v1", start: 270, end: 360 }]] },
      { text: "Hecho: también corté los últimos 3 segundos. Ahora el video dura 9 segundos." },
    ],
    expect: (tl) => {
      const shots = playing(tl, "a.mp4");
      assert(shots.length > 0, "the video is gone");
      near(Number(shots[0].timeline_in), 0, 2, "the video's start (no black where the cut was)");
      const total = shots.reduce((n, c) => n + span(c), 0);
      near(total, 270, 3, "the video's length (15 s less 3 at each end)");
      near(Number(shots[0].source_in ?? 0), 90, 3, "where the video now starts in the footage");
      const last = shots[shots.length - 1];
      near(Number(last.source_out ?? 0), 360, 3, "where the video now ends in the footage");
    },
    expectTrace: (t) => repliesIn(t, "es"),
  },
];

const PORTUGUESE: Scenario[] = [
  {
    id: "lang_pt_slow_motion_slang",
    title: "Slang: the last clip in slow motion at half speed (Portuguese)",
    tags: tags("pt", 1, 3, "slang", "speed"),
    scope: { change: ["c"] },
    seed: row(90, 90, 90),
    // vc = você, tá = está.
    prompt: "vc consegue deixar o último clipe em câmera lenta? metade da velocidade tá bom",
    expectTools: ["set_clip_properties"],
    maxRounds: 5,
    reference: [
      { calls: [["set_clip_properties", { clip_ids: ["c"], speed: 0.5 }]] },
      { text: "Pronto! Deixei o último clipe em câmera lenta, com metade da velocidade." },
    ],
    expect: (tl) => {
      near(Number((clipById(tl, "c") as Any)?.speed ?? 1), 0.5, 0.05, "the last clip's speed");
      for (const id of ["a", "b"])
        near(Number((clipById(tl, id) as Any)?.speed ?? 1), 1, 0.001, `clip ${id}'s speed`);
    },
    expectTrace: (t) => repliesIn(t, "pt"),
  },
  {
    id: "lang_pt_keep_english_text",
    title: "Text the person wants in English stays English (Portuguese)",
    tags: tags("pt", 1, 1, "mixed", "text"),
    scope: { add: ["text"], addTracks: true },
    seed: one(150),
    prompt: "Coloca no começo o texto 'Coming soon', assim mesmo, em inglês, por uns 2 segundos.",
    expectTools: ["add_text_clips"],
    maxRounds: 5,
    reference: [
      addText([{ timeline_in: 0, timeline_out: 60, content: "Coming soon" }]),
      {
        text: "Pronto: coloquei o texto 'Coming soon', em inglês mesmo, nos primeiros 2 segundos.",
      },
    ],
    expect: (tl) => {
      const text = titleShowing(tl, "Coming soon", undefined);
      near(Number(text.timeline_in), 0, 2, "the text's start");
      const n = span(text);
      assert(n >= 45 && n <= 75, `the text shows for ${n} frames; asked for about 2 s`);
    },
    expectTrace: (t) => repliesIn(t, "pt"),
  },
];

const GERMAN: Scenario[] = [
  {
    id: "lang_de_crossfade_decimal_comma",
    title: "A crossfade of 1,5 seconds: a decimal comma (German)",
    tags: tags("de", 1, 2, "single-edit", "transition", "decimal-comma"),
    scope: { change: ["b"] },
    seed: row(150, 150),
    prompt: "Mach zwischen den beiden Clips eine Überblendung von 1,5 Sekunden.",
    expectTools: ["set_transition"],
    maxRounds: 5,
    reference: [
      { calls: [crossfade("b", 45)] },
      { text: "Erledigt: Zwischen den beiden Clips ist jetzt eine Überblendung von 1,5 Sekunden." },
    ],
    expect: (tl) => {
      const tr = (clipById(tl, "b") as Any)?.transition_in;
      assert(tr, "no crossfade between the two clips");
      assert(/cross|dissolve/i.test(String(tr.kind)), `the cut is a ${tr.kind}`);
      near(Number(tr.duration), 45, 3, "the crossfade's length (1.5 s)");
    },
    expectTrace: (t) => repliesIn(t, "de"),
  },
  {
    id: "lang_de_question_length",
    title: "How long is the video: 7,5 seconds, nothing changed (German)",
    tags: tags("de", 1, 3, "question", "read-only"),
    scope: {},
    seed: row(90, 60, 75),
    prompt: "Wie lang ist das Video gerade insgesamt?",
    expectTools: ["get_timeline"],
    maxRounds: 4,
    reference: [
      { calls: [["get_timeline", {}]] },
      { text: "Das Video ist insgesamt 7,5 Sekunden lang (225 Frames bei 30 fps)." },
    ],
    expect: untouched(row(90, 60, 75)),
    expectTrace: (t) => {
      // 225 frames at 30 fps: 7,5 s however it is written (seconds, frames, or seconds and frames).
      assert(
        /\b7[,.]5\b|siebeneinhalb|7½|\b225\b|\b7\s*(s|sek\w*)?\s*(und\s*)?15\s*(frames?|bilder)\b|\b0?0:07[:;]15\b/i.test(
          t.finalText,
        ),
        `the answer does not give the video's length (7,5 s, 225 frames): ${t.finalText.slice(0, 120)}`,
      );
      repliesIn(t, "de");
    },
  },
];

const GREEK: Scenario[] = [
  {
    id: "lang_el_title_fade_out",
    title: "A Greek title for three seconds that fades out",
    tags: tags("el", 1, 1, "text", "fade"),
    scope: { add: ["text"], addTracks: true },
    seed: one(240),
    prompt:
      "Βάλε στην αρχή τον τίτλο «Καλοκαίρι στην Κρήτη» για τρία δευτερόλεπτα και κάνε τον να " +
      "σβήνει σιγά σιγά στο τέλος.",
    expectTools: ["add_text_clips", "set_clip_properties"],
    maxRounds: 6,
    reference: [
      addText([
        {
          timeline_in: 0,
          timeline_out: 90,
          content: "Καλοκαίρι στην Κρήτη",
          animation: { exit: "fade", exit_ms: 1000 },
        },
      ]),
      {
        text: "Έβαλα τον τίτλο «Καλοκαίρι στην Κρήτη» στην αρχή για τρία δευτερόλεπτα, και σβήνει σιγά σιγά στο τέλος.",
      },
    ],
    expect: (tl) => {
      // Greek in capitals drops its accents, so they are not compared.
      const title = titleShowing(tl, "Καλοκαίρι στην Κρήτη", "el", { accents: false });
      near(Number(title.timeline_in), 0, 2, "the title's start");
      near(span(title), 90, 6, "the title's length (3 s)");
      assert(fadesOut(title, 8), "the title does not fade out at its end");
    },
    expectTrace: (t) => repliesIn(t, "el"),
  },
  {
    id: "lang_el_question_mark",
    title: "A question ending in the Greek question mark (;) is answered, nothing changed",
    tags: tags("el", 1, 3, "question", "read-only"),
    scope: {},
    seed: row(60, 60, 60),
    prompt: "Πόσα κλιπ έχει τώρα το βίντεο;",
    expectTools: ["get_timeline"],
    maxRounds: 4,
    reference: [
      { calls: [["get_timeline", {}]] },
      { text: "Το βίντεο έχει τώρα 3 κλιπ, το ένα μετά το άλλο." },
    ],
    expect: untouched(row(60, 60, 60)),
    expectTrace: (t) => {
      assert(
        /\b3\b|τρία|τρια/iu.test(t.finalText),
        `the answer does not say 3 clips: ${t.finalText.slice(0, 120)}`,
      );
      repliesIn(t, "el");
    },
  },
];

export const GAP_LANGUAGES: Scenario[] = [
  ...RUSSIAN,
  ...UKRAINIAN,
  ...TURKISH,
  ...POLISH,
  ...INDONESIAN,
  ...SPANISH,
  ...PORTUGUESE,
  ...GERMAN,
  ...GREEK,
];
