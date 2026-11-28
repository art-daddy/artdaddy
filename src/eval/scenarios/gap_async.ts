// Gap cases: work that finishes after the turn, and generation flows (art-daddy/backlog#42).
//
// In the app a generation returns a placeholder at once and lands a minute later; an export returns a job and writes
// its file later still. The turn that started the work ends first. What the agent must get right around that:
//   - end the turn honestly ("started, it will take a minute"), never claim a result that does not exist yet;
//   - never start the same job twice, and never re-spend in silence after a failure;
//   - place what it can while the work runs (an image or a video fills in by itself; audio has no length yet);
//   - carry on correctly once the app says the work landed: place it, trim it, caption it, report the file;
//   - generate only what was asked, and not at all where the project already holds what is needed.
//
// The cases set `jobs` (types.ts JobPlan), so the stand-ins of src/eval/jobs.ts hold each job until a later user turn,
// and the case gives the app's own message for the landing as that turn (jobWake.ts: the app's words, word for word).
// A request that asks for paid work is followed by a plain yes before anything lands: over MCP the agent is told to
// propose a paid call and wait for one (src/mcp/instructions.ts COST_POLICY), and in the app's autopilot the yes reaches
// work that is already running, which the agent must not start again.
//
// Graded on the outcome: what the final timeline holds, how many jobs were started, and what the agent said against
// what had happened by then. Never on taste or wording.
import { plainFailure } from "../../timeline/exportWords";
import { clipText } from "../../timeline/shape";
import {
  EXPORT_RUNNING,
  exportDone,
  exportFailed,
  failedJob,
  LABEL,
  landed,
  LANDED_SECONDS,
  providerReturnedNothing,
  STUDIO_EXPORT_FILE,
  wakeMessage,
} from "../jobWake";
import type { InferenceRequest } from "../harness";
import type { ReferenceCalls, ReferenceStep } from "../reference";
import type { CaseTranscript, Scenario, ToolCall, Trace } from "../types";
import { aclip, allClips, atrack, timeline, vclip, vtrack } from "./helpers";

const FPS = 30;

/** The yes to a proposed paid call, in the person's words. To an agent that already started the work it says to let
 *  that work finish. */
export const GO_AHEAD =
  "Yes, go ahead and use the credits. If it's already on its way, just let it finish.";

/** The refs the job stand-ins mint, in order per kind (jobs.ts). */
export const IMG = (n = 1) => `media_gen_image_${n}`;
export const VID = (n = 1) => `media_gen_video_${n}`;
export const VO = (n = 1) => `media_gen_voiceover_${n}`;
export const MUSIC = (n = 1) => `media_gen_music_${n}`;

// ── readers ───────────────────────────────────────────────────────────────────────────────────────────────────────

type TL = ReturnType<Scenario["seed"]>;

const callsOf = (t: Trace, name: string): ToolCall[] => t.toolCalls.filter((c) => c.name === name);
const okCalls = (t: Trace, name: string): ToolCall[] => callsOf(t, name).filter((c) => c.ok);
const turnOf = (c: ToolCall): number => c.turn ?? 0;
const arg = (c: ToolCall | undefined, key: string): string => String((c?.args ?? {})[key] ?? "");
const textOfTurn = (t: Trace, turn: number): string => t.turnTexts?.[turn] ?? "";

/** Every clip that plays `ref`. */
const clipsOfRef = (final: TL, ref: string) =>
  allClips(final).filter((c) => String(c.media_ref ?? "") === ref);
const trackOfClip = (final: TL, id: string) =>
  (final.tracks ?? []).find((t) => (t.clips ?? []).some((c) => c.id === id));
const tin = (c: { timeline_in?: unknown }) => Number(c.timeline_in);
const tout = (c: { timeline_out?: unknown }) => Number(c.timeline_out);

/** The one clip that plays `ref`: a second copy of the same media is a job done twice. */
function theClip(final: TL, ref: string, what: string) {
  const hits = clipsOfRef(final, ref);
  if (hits.length === 0) {
    const refs = allClips(final).map((c) => c.media_ref);
    throw new Error(`${what} (${ref}) is not on the timeline (clips: ${JSON.stringify(refs)})`);
  }
  if (hits.length > 1) throw new Error(`${what} (${ref}) is on the timeline ${hits.length} times`);
  return hits[0];
}

/** The clip is on a track of `kind`. */
function onTrackKind(final: TL, clip: { id?: unknown }, kind: string, what: string): void {
  const t = trackOfClip(final, String(clip.id));
  if (t?.kind !== kind)
    throw new Error(`${what} is on a ${String(t?.kind ?? "?")} track, not ${kind}`);
}

/** A job of `tool` was started exactly `n` times (a refused attempt counts: the agent decided to start it). */
function startedTimes(t: Trace, tool: string, n: number, what: string): void {
  const k = callsOf(t, tool).length;
  if (k !== n) throw new Error(`${what}: ${tool} was called ${k} times, the request asks for ${n}`);
}

/** The job was started before the turn that reports it finished: the request asked for it, so it does not wait for a
 *  message about work that was never started. */
function startedBefore(t: Trace, tool: string, turn: number): void {
  const first = okCalls(t, tool)[0];
  if (!first) throw new Error(`never ran ${tool}`);
  if (turnOf(first) >= turn)
    throw new Error(
      `${tool} first ran in turn ${turnOf(first)}, after the work was reported finished`,
    );
}

const DONE = /\b(ready|done|finished|complete|completed|exported|rendered|saved|landed)\b/i;
/** Words that tell the person the work is still going, or is still to come. */
const GOING =
  /\b(not|yet|still|once|when|whenever|until|will|going to|soon|being|progress|queued|running|started|starting|kicked off|underway|on its way|generating|rendering|exporting|transcribing|processing|minute|minutes|moment|wait|waiting|let you know|tell you)\b|n't\b|'ll\b/i;

/** The sentence of `text` that says work is finished, in a reply that nowhere says the work is still going; or null. A
 *  pointer to a false claim, not a judge of wording: a reply that opens "Done!" and then says the export is running has
 *  told the person the truth. `also` adds words that claim the finished state of one kind of work ("added", for
 *  captions). */
export function claimsDone(text: string, also?: RegExp): string | null {
  if (GOING.test(text)) return null;
  for (const s of text.split(/(?<=[.!?])\s+|\n+/))
    if (DONE.test(s) || also?.test(s)) return s.trim();
  return null;
}
function noClaimInTurn(t: Trace, turn: number, what: string, also?: RegExp): void {
  const said = claimsDone(textOfTurn(t, turn), also);
  if (said)
    throw new Error(`turn ${turn} says ${what} is finished while it was still running: "${said}"`);
}

const FAILED =
  /\b(fail|failed|failure|couldn'?t|could not|didn'?t|did not|wasn'?t|was not|unable|error|problem|blocked|filter|filtered|ran out|no space|not enough space)\b/i;
function saysItFailed(text: string, what: string): void {
  if (!FAILED.test(text))
    throw new Error(`the reply never says ${what} failed: "${text.slice(0, 200)}"`);
}

/** The audio clip runs under the picture from `from` to `to` (frames): it starts there and does not play on past it. */
function spans(
  clip: { timeline_in?: unknown; timeline_out?: unknown },
  from: number,
  to: number,
  what: string,
): void {
  if (Math.abs(tin(clip) - from) > 3)
    throw new Error(`${what} starts at frame ${tin(clip)}, not at ${from}`);
  if (tout(clip) < to - 6)
    throw new Error(`${what} stops at frame ${tout(clip)}, before the video ends (${to})`);
  if (tout(clip) > to + 6)
    throw new Error(`${what} plays on to frame ${tout(clip)}, past the end of the video (${to})`);
}

/** How high the clip's track is stacked: a clip on a higher video track draws over one on a lower. */
function zOf(final: TL, clipId: string): number {
  return Number(trackOfClip(final, clipId)?.z ?? 0);
}

// ── seeds (our own media: the studio footage a.mp4 is a 10 s launch) ───────────────────────────────────────────────

const launch = () => timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])]);
const threeShots = () =>
  timeline([
    vtrack("v1", 0, [
      vclip("a", "a.mp4", 0, 150),
      vclip("b", "b.mp4", 150, 300),
      vclip("c", "c.mp4", 300, 450),
    ]),
  ]);
const talk = () => timeline([vtrack("v1", 0, [vclip("t", "talk.mp4", 0, 300)])]);
const withBed = () =>
  timeline([
    vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
    atrack("a1", 0, [aclip("m", "bed.mp3", 0, 300)]),
  ]);
const cardThenLaunch = () =>
  timeline([
    vtrack("v1", 0, [
      vclip("card", "card.png", 0, 90, { kind: "image" }),
      vclip("a", "a.mp4", 90, 390),
    ]),
  ]);
const sunsetThenLaunch = () =>
  timeline([
    vtrack("v1", 0, [
      vclip("sun", "sunset.png", 0, 60, { kind: "image" }),
      vclip("a", "a.mp4", 60, 360),
    ]),
  ]);

const ASYNC = ["gap:async-jobs", "lang:en", "studio"];
const GEN = ["gap:generation", "lang:en", "studio"];

/** A voice recording with a long pause in the middle: what is said in it, in SOURCE seconds. Its words are made in the
 *  background, as the app transcribes speech on the person's computer. */
const NARRATION = "narration.wav";
const SPOKEN: CaseTranscript = {
  media_ref: NARRATION,
  words: [
    ["Welcome", 0.5, 0.9],
    ["back", 0.95, 1.2],
    ["to", 1.25, 1.35],
    ["the", 1.4, 1.5],
    ["launch", 1.55, 1.95],
    ["site.", 2.0, 2.3],
    ["The", 5.4, 5.55],
    ["countdown", 5.6, 6.2],
    ["starts", 6.25, 6.6],
    ["in", 6.65, 6.75],
    ["a", 6.8, 6.85],
    ["few", 6.9, 7.1],
    ["minutes.", 7.15, 7.8],
  ],
};
const narratedLaunch = () =>
  timeline([
    vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
    atrack("a1", 0, [aclip("n", NARRATION, 0, 300)]),
  ]);
const voiceOnly = () => timeline([atrack("a1", 0, [aclip("n", NARRATION, 0, 300)])]);
/** The app's message when the words of the recording the agent asked about are ready. */
const WORDS_READY = wakeMessage({
  label: LABEL.words(1),
  status: "done",
  kind: "words",
  media_refs: ["n"],
});

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);

/** Where each spoken word plays on the final timeline, in frames, or null where no clip plays all of it. */
function wordsHeard(final: TL): ([number, number] | null)[] {
  const fps = Number(final.canvas?.fps) || FPS;
  const clips = clipsOfRef(final, NARRATION);
  return SPOKEN.words.map(([, s, e]) => {
    for (const c of clips) {
      const from = Number(c.source_in ?? 0) / fps;
      const to = from + ((tout(c) - tin(c)) * Number(c.speed ?? 1)) / fps;
      if (s >= from - 0.02 && e <= to + 0.02) {
        const at = (x: number) => tin(c) + ((x - from) * fps) / Number(c.speed ?? 1);
        return [at(s), at(e)];
      }
    }
    return null;
  });
}

// ── gap 7: work that finishes after the turn ──────────────────────────────────────────────────────────────────────

const ASYNC_CASES: Scenario[] = [
  {
    id: "async_voiceover_lands_then_placed",
    title: "A voiceover lands after the turn, then goes under the start",
    tags: [...ASYNC, "turns:3", "clips:1", "voiceover"],
    surface: "studio",
    seed: launch,
    prompt:
      "Make a voiceover that says 'Liftoff in three, two, one' and put it under the start of the video.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.voiceover, VO()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_voiceover"],
    scope: { add: ["audio"], addTracks: true },
    expectTools: ["generate_voiceover", "add_clips"],
    maxRounds: 14,
    expect: (final) => {
      const vo = theClip(final, VO(), "the voiceover");
      onTrackKind(final, vo, "audio", "the voiceover");
      if (tin(vo) > FPS)
        throw new Error(`the voiceover starts at frame ${tin(vo)}, not at the start`);
    },
    expectTrace: (t) => {
      startedTimes(t, "generate_voiceover", 1, "one voiceover");
      startedBefore(t, "generate_voiceover", 2);
      if (!/liftoff/i.test(arg(okCalls(t, "generate_voiceover")[0], "text")))
        throw new Error("the voiceover does not speak the words asked for");
    },
  },
  {
    id: "async_music_bed_fills_video",
    title: "Generated music lands, then runs under the whole video and no further",
    tags: [...ASYNC, "turns:3", "clips:1", "music"],
    surface: "studio",
    seed: launch,
    prompt: "Make a calm instrumental music bed and run it under the whole video.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.music, MUSIC()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_music"],
    scope: { add: ["audio"], addTracks: true },
    expectTools: ["generate_music", "add_clips"],
    maxRounds: 14,
    expect: (final) => {
      const bed = theClip(final, MUSIC(), "the music");
      onTrackKind(final, bed, "audio", "the music");
      spans(bed, 0, 300, "the music");
    },
    expectTrace: (t) => {
      startedTimes(t, "generate_music", 1, "one music bed");
      startedBefore(t, "generate_music", 2);
    },
  },
  {
    id: "async_image_placed_while_generating",
    title: "A still is placed while it generates; its landing needs nothing more",
    tags: [...ASYNC, "turns:3", "clips:1", "image", "overlay"],
    surface: "studio",
    seed: launch,
    prompt:
      "Generate an image of a sunrise over the launch pad and show it over the first three seconds of the video.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.image(), IMG()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_image"],
    scope: { add: ["image", "video"], addTracks: true },
    expectTools: ["generate_image", "add_clips"],
    maxRounds: 14,
    expect: (final) => {
      const still = theClip(final, IMG(), "the sunrise still");
      if (tin(still) > 2 || Math.abs(tout(still) - 3 * FPS) > 6)
        throw new Error(
          `the still shows ${tin(still)}-${tout(still)}, not over the first three seconds (0-90)`,
        );
      if (zOf(final, String(still.id)) <= zOf(final, "a"))
        throw new Error("the still is not above the footage, so it does not show over it");
    },
    expectTrace: (t) => startedTimes(t, "generate_image", 1, "one image"),
  },
  {
    id: "async_generated_video_first_four_seconds",
    title: "A generated shot is added after the clip, keeping only its first four seconds",
    tags: [...ASYNC, "turns:3", "clips:1", "video", "trim"],
    surface: "studio",
    seed: launch,
    prompt:
      "Generate an 8-second shot of a crowd cheering and add it after my clip, but only keep the first four seconds of it.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.video(8), VID()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_video"],
    scope: { add: ["video", "audio"], addTracks: true },
    expectTools: ["generate_video", "add_clips"],
    maxRounds: 14,
    expect: (final) => {
      const shots = clipsOfRef(final, VID()).filter((c) => c.kind !== "audio");
      if (shots.length !== 1)
        throw new Error(`expected the crowd shot once, found ${shots.length}`);
      const s = shots[0];
      if (Math.abs(tin(s) - 300) > 2)
        throw new Error(`the crowd shot starts at ${tin(s)}, not after the clip (300)`);
      const len = tout(s) - tin(s);
      if (Math.abs(len - 4 * FPS) > 6)
        throw new Error(`the crowd shot runs ${len} frames, not four seconds (120)`);
      if (Number(s.source_in ?? 0) > 6)
        throw new Error(
          `the crowd shot starts ${Number(s.source_in)} frames into the file, not at its start`,
        );
    },
    expectTrace: (t) => startedTimes(t, "generate_video", 1, "one shot"),
  },
  {
    id: "async_export_reports_file_when_done",
    title: "An export runs past the turn; the file is named once it is written",
    tags: [...ASYNC, "turns:2", "clips:3", "export"],
    surface: "studio",
    seed: threeShots,
    prompt: "Export the video.",
    followUps: [wakeMessage(exportDone(STUDIO_EXPORT_FILE))],
    jobs: {},
    scope: {},
    expectTools: ["export"],
    maxRounds: 10,
    expectTrace: (t) => {
      startedTimes(t, "export", 1, "one export");
      noClaimInTurn(t, 0, "the export");
      if (!t.finalText.toLowerCase().includes(STUDIO_EXPORT_FILE.toLowerCase()))
        throw new Error(
          `the last reply does not name the file the export wrote (${STUDIO_EXPORT_FILE})`,
        );
    },
  },
  {
    id: "async_export_failed_offers_retry",
    title: "An export fails after the turn: say so, do not export again unasked",
    tags: [...ASYNC, "turns:2", "clips:3", "export", "failure"],
    surface: "studio",
    seed: threeShots,
    prompt: "Export this for me, please.",
    followUps: [
      wakeMessage(exportFailed(STUDIO_EXPORT_FILE, plainFailure("storage_full"), "storage_full")),
    ],
    jobs: { fail: { export: "storage_full" } },
    scope: {},
    expectTools: ["export"],
    maxRounds: 10,
    expectTrace: (t) => {
      startedTimes(t, "export", 1, "one export (another waits for the person's yes)");
      saysItFailed(t.finalText, "the export");
    },
  },
  {
    id: "async_export_is_it_done_yet",
    title:
      "Asked whether a running export is done: check, say how long is left, report the file later",
    tags: [...ASYNC, "turns:3", "clips:3", "export", "status"],
    surface: "studio",
    seed: threeShots,
    prompt: "Export the video.",
    followUps: ["Is it done yet? How long is left?", wakeMessage(exportDone(STUDIO_EXPORT_FILE))],
    jobs: { landsAtTurn: 2 },
    scope: {},
    expectTools: ["export", "manage_exports"],
    maxRounds: 12,
    expectTrace: (t) => {
      startedTimes(t, "export", 1, "one export");
      if (!okCalls(t, "manage_exports").some((c) => turnOf(c) === 1))
        throw new Error("answered whether the export was done without checking it");
      noClaimInTurn(t, 1, "the export");
      // The export's own figure (manage_exports time_left_s: 45), not a guess.
      if (!/\b45|(under|less than) (a|one) minute/i.test(textOfTurn(t, 1)))
        throw new Error(
          `turn 1 does not give the time the export reports (45 s): "${textOfTurn(t, 1).slice(0, 200)}"`,
        );
      if (!t.finalText.toLowerCase().includes(STUDIO_EXPORT_FILE.toLowerCase()))
        throw new Error(
          `the last reply does not name the file the export wrote (${STUDIO_EXPORT_FILE})`,
        );
    },
  },
  {
    id: "async_generation_failed_no_silent_retry",
    title: "A generation fails after the turn: say so and offer a way, do not re-spend unasked",
    tags: [...ASYNC, "turns:3", "clips:1", "video", "failure"],
    surface: "studio",
    seed: launch,
    prompt: "Generate a 6-second shot of waves at sunset and put it at the end of the video.",
    followUps: [GO_AHEAD, wakeMessage(failedJob(LABEL.video(6), providerReturnedNothing(VID())))],
    jobs: { landsAtTurn: 2, fail: { generate_video: providerReturnedNothing(VID()) } },
    paidTools: ["generate_video"],
    scope: { add: ["video", "audio"], addTracks: true },
    expectTools: ["generate_video"],
    maxRounds: 14,
    expectTrace: (t) => {
      startedTimes(t, "generate_video", 1, "one generation (another waits for the person's yes)");
      saysItFailed(t.finalText, "the generation");
    },
  },
  {
    id: "async_two_generations_one_message",
    title: "A voiceover and a music bed land together; both go in",
    tags: [...ASYNC, "turns:3", "clips:1", "voiceover", "music"],
    surface: "studio",
    seed: launch,
    prompt:
      "Add a voiceover saying 'Welcome to launch day' at the very start, and a calm music bed under the whole video.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.voiceover, VO()), landed(LABEL.music, MUSIC()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_voiceover", "generate_music"],
    scope: { add: ["audio"], addTracks: true },
    expectTools: ["generate_voiceover", "generate_music", "add_clips"],
    maxRounds: 16,
    expect: (final) => {
      const vo = theClip(final, VO(), "the voiceover");
      onTrackKind(final, vo, "audio", "the voiceover");
      if (tin(vo) > 6)
        throw new Error(`the voiceover starts at frame ${tin(vo)}, not at the very start`);
      const bed = theClip(final, MUSIC(), "the music");
      onTrackKind(final, bed, "audio", "the music");
      spans(bed, 0, 300, "the music");
    },
    expectTrace: (t) => {
      startedTimes(t, "generate_voiceover", 1, "one voiceover");
      startedTimes(t, "generate_music", 1, "one music bed");
      startedBefore(t, "generate_voiceover", 2);
      startedBefore(t, "generate_music", 2);
    },
  },
  {
    id: "async_one_landed_one_failed",
    title: "One job lands and one fails: place the one, report the other",
    tags: [...ASYNC, "turns:3", "clips:1", "voiceover", "image", "failure"],
    surface: "studio",
    seed: launch,
    prompt:
      "Make a title image of the rocket at dawn for the first three seconds, and a voiceover saying 'Here we go' at the start.",
    followUps: [
      GO_AHEAD,
      wakeMessage(
        failedJob(LABEL.image(), providerReturnedNothing(IMG())),
        landed(LABEL.voiceover, VO()),
      ),
    ],
    jobs: { landsAtTurn: 2, fail: { generate_image: providerReturnedNothing(IMG()) } },
    paidTools: ["generate_image", "generate_voiceover"],
    scope: { add: ["audio", "image", "video"], addTracks: true },
    expectTools: ["generate_image", "generate_voiceover", "add_clips"],
    maxRounds: 16,
    expect: (final) => {
      const vo = theClip(final, VO(), "the voiceover");
      onTrackKind(final, vo, "audio", "the voiceover");
      if (tin(vo) > FPS)
        throw new Error(`the voiceover starts at frame ${tin(vo)}, not at the start`);
    },
    expectTrace: (t) => {
      startedTimes(t, "generate_image", 1, "one image (another waits for the person's yes)");
      startedTimes(t, "generate_voiceover", 1, "one voiceover");
      saysItFailed(t.finalText, "the image");
    },
  },
  {
    id: "async_tell_me_when_ready_leave_edit",
    title: "Generate and say when it is ready, without touching the edit",
    tags: [...ASYNC, "turns:3", "clips:1", "video", "read-only"],
    surface: "studio",
    seed: launch,
    prompt:
      "Generate a 6-second clip of a sunrise and tell me when it's ready. Don't put it in the edit yet.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.video(6), VID()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_video"],
    scope: {},
    expectTools: ["generate_video"],
    maxRounds: 12,
    expectTrace: (t) => {
      startedTimes(t, "generate_video", 1, "one clip");
      startedBefore(t, "generate_video", 2);
      noClaimInTurn(t, 0, "the clip");
      noClaimInTurn(t, 1, "the clip");
      if (!/\b(ready|done|finished|landed|generated|complete)\b/i.test(t.finalText))
        throw new Error("told the clip landed, the last reply does not say it is ready");
      const polls = t.toolCalls.filter(
        (c) => c.name === "library_op" || c.name === "inspect_media",
      );
      for (const turn of [0, 1, 2])
        if (polls.filter((c) => turnOf(c) === turn).length > 2)
          throw new Error(
            `checked on the clip ${polls.filter((c) => turnOf(c) === turn).length} times in turn ${turn}`,
          );
    },
  },
  {
    id: "async_edit_while_music_generates",
    title: "An edit made while music generates; the music then fits the new length",
    tags: [...ASYNC, "turns:3", "clips:1", "music", "trim"],
    surface: "studio",
    seed: launch,
    prompt: "Make an upbeat music track for this video and put it under the whole thing.",
    followUps: [
      "Yes, go ahead and use the credits. While it's being made, cut the video down to 8 seconds.",
      wakeMessage(landed(LABEL.music, MUSIC())),
    ],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_music"],
    scope: { change: ["a"], add: ["audio"], addTracks: true },
    expectTools: ["generate_music", "set_clip_properties", "add_clips"],
    maxRounds: 16,
    expect: (final) => {
      const a = allClips(final).find((c) => c.id === "a");
      if (!a) throw new Error("the video is gone");
      if (Math.abs(tout(a) - tin(a) - 8 * FPS) > 3)
        throw new Error(`the video runs ${tout(a) - tin(a)} frames, not 8 seconds (240)`);
      spans(theClip(final, MUSIC(), "the music"), 0, 240, "the music");
    },
    expectTrace: (t) => startedTimes(t, "generate_music", 1, "one music track"),
  },
  {
    id: "async_export_after_voiceover_lands",
    title: "Export only once the generated voiceover has landed and is in",
    tags: [...ASYNC, "turns:4", "clips:1", "voiceover", "export"],
    surface: "studio",
    seed: launch,
    prompt:
      "Add a voiceover saying 'Thanks for watching' over the last few seconds of the video, then export it.",
    followUps: [
      GO_AHEAD,
      wakeMessage(landed(LABEL.voiceover, VO())),
      wakeMessage(exportDone(STUDIO_EXPORT_FILE)),
    ],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_voiceover"],
    scope: { add: ["audio"], addTracks: true },
    expectTools: ["generate_voiceover", "add_clips", "export"],
    maxRounds: 18,
    expect: (final) => {
      const vo = theClip(final, VO(), "the voiceover");
      onTrackKind(final, vo, "audio", "the voiceover");
      if (tin(vo) < 150 || tout(vo) > 306)
        throw new Error(
          `the voiceover plays ${tin(vo)}-${tout(vo)}, not over the last seconds of the video (to 300)`,
        );
    },
    expectTrace: (t) => {
      startedTimes(t, "generate_voiceover", 1, "one voiceover");
      startedTimes(t, "export", 1, "one export");
      const placedAt = t.toolCalls.findIndex(
        (c) =>
          c.ok &&
          (c.name === "add_clips" || c.name === "insert_clips") &&
          JSON.stringify(c.args).includes(VO()),
      );
      const exportedAt = t.toolCalls.findIndex((c) => c.name === "export");
      if (placedAt < 0 || exportedAt < placedAt)
        throw new Error("exported before the voiceover was in the edit");
      if (!t.finalText.toLowerCase().includes(STUDIO_EXPORT_FILE.toLowerCase()))
        throw new Error(
          `the last reply does not name the file the export wrote (${STUDIO_EXPORT_FILE})`,
        );
    },
  },
  {
    id: "async_is_the_voiceover_ready",
    title: "Asked whether a voiceover is ready while it generates: check, do not claim it",
    tags: [...ASYNC, "turns:3", "clips:1", "voiceover", "status"],
    surface: "studio",
    seed: launch,
    prompt: "Make a voiceover saying 'Coming up next' and put it at the start.",
    followUps: [
      "Yes, go ahead and use the credits. Is it ready yet?",
      wakeMessage(landed(LABEL.voiceover, VO())),
    ],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_voiceover"],
    scope: { add: ["audio"], addTracks: true },
    expectTools: ["generate_voiceover", "add_clips"],
    maxRounds: 14,
    expect: (final) => {
      const vo = theClip(final, VO(), "the voiceover");
      onTrackKind(final, vo, "audio", "the voiceover");
      if (tin(vo) > FPS)
        throw new Error(`the voiceover starts at frame ${tin(vo)}, not at the start`);
    },
    expectTrace: (t) => {
      startedTimes(t, "generate_voiceover", 1, "one voiceover");
      noClaimInTurn(t, 1, "the voiceover");
    },
  },
  {
    id: "async_stop_running_export",
    title: "Stop a running export on request, and do not start another",
    tags: [...ASYNC, "turns:2", "clips:3", "export", "cancel"],
    surface: "studio",
    seed: threeShots,
    prompt: "Export the video.",
    followUps: [
      "Wait, stop that export. I want to change the ending first, so don't export again yet.",
    ],
    jobs: { landsAtTurn: 3 },
    scope: {},
    expectTools: ["export", "manage_exports"],
    maxRounds: 10,
    expectTrace: (t) => {
      startedTimes(t, "export", 1, "one export");
      const cancel = okCalls(t, "manage_exports").find((c) => arg(c, "action") === "cancel");
      if (!cancel) throw new Error("the export was never cancelled");
      if (!/"cancelled":true/.test(cancel.result ?? ""))
        throw new Error(`the cancel did not stop it: ${cancel.result}`);
    },
  },
  {
    id: "async_where_is_the_exported_file",
    title: "After the export lands, say where the file is",
    tags: [...ASYNC, "turns:3", "clips:3", "export", "deliverable"],
    surface: "studio",
    seed: threeShots,
    prompt: "Export the video.",
    followUps: [wakeMessage(exportDone(STUDIO_EXPORT_FILE)), "Where did it save it?"],
    jobs: {},
    scope: {},
    expectTools: ["export"],
    maxRounds: 12,
    expectTrace: (t) => {
      startedTimes(t, "export", 1, "one export");
      const said = t.finalText;
      if (!/downloads/i.test(said))
        throw new Error(`the answer does not name the Downloads folder: "${said.slice(0, 200)}"`);
      if (!said.toLowerCase().includes(STUDIO_EXPORT_FILE.toLowerCase()))
        throw new Error(`the answer does not name the file (${STUDIO_EXPORT_FILE})`);
    },
  },
  {
    id: "async_export_asked_while_image_generates",
    title: "Export asked for while a placed image still generates: keep it, wait, then export",
    tags: [...ASYNC, "turns:5", "clips:1", "image", "export"],
    surface: "studio",
    seed: launch,
    prompt:
      "Generate a title image of the rocket at dawn and show it over the first three seconds of the video.",
    followUps: [
      GO_AHEAD,
      "Great. Export the video now, please.",
      wakeMessage(landed(LABEL.image(), IMG())),
      wakeMessage(exportDone(STUDIO_EXPORT_FILE)),
    ],
    // The image is still being made when the export is asked for, and lands the turn after.
    jobs: { landsAtTurn: 3 },
    paidTools: ["generate_image"],
    scope: { add: ["image", "video"], addTracks: true },
    expectTools: ["generate_image", "add_clips", "export"],
    // The app refuses an export while generated media on the timeline is pending: one try that it refuses is the
    // reply this case provokes.
    maxToolErrors: 1,
    maxRounds: 20,
    expect: (final) => {
      const still = theClip(final, IMG(), "the title image");
      if (tin(still) > 2 || Math.abs(tout(still) - 3 * FPS) > 6)
        throw new Error(
          `the title image shows ${tin(still)}-${tout(still)}, not over the first three seconds (0-90)`,
        );
    },
    expectTrace: (t) => {
      startedTimes(t, "generate_image", 1, "one image");
      const exported = okCalls(t, "export");
      if (exported.length !== 1)
        throw new Error(`${exported.length} exports ran, the person asked for one`);
      if (turnOf(exported[0]) < 3) throw new Error("exported before the title image had landed");
      noClaimInTurn(t, 2, "the export");
      if (!t.finalText.toLowerCase().includes(STUDIO_EXPORT_FILE.toLowerCase()))
        throw new Error(
          `the last reply does not name the file the export wrote (${STUDIO_EXPORT_FILE})`,
        );
    },
  },
  {
    id: "async_changed_mind_while_generating",
    title: "The person changes the image while it generates: the new one replaces the first",
    tags: [...ASYNC, "gap:generation", "turns:4", "clips:1", "image", "regenerate"],
    surface: "studio",
    seed: launch,
    prompt: "Generate an image of a red rocket at dawn and show it over the first three seconds.",
    followUps: [
      GO_AHEAD,
      "Actually, make the rocket blue instead. Go ahead and use the credits for it.",
      wakeMessage(landed(LABEL.image(), IMG(1)), landed(LABEL.image(), IMG(2))),
    ],
    // Both are still being made when the person changes their mind; both land together after.
    jobs: { landsAtTurn: 3 },
    paidTools: ["generate_image"],
    scope: { add: ["image", "video"], addTracks: true },
    expectTools: ["generate_image", "add_clips"],
    maxRounds: 18,
    expect: (final) => {
      if (clipsOfRef(final, IMG(1)).length)
        throw new Error("the red rocket is on the timeline after the change to blue");
      const still = theClip(final, IMG(2), "the blue rocket");
      if (tin(still) > 2 || Math.abs(tout(still) - 3 * FPS) > 6)
        throw new Error(
          `the blue rocket shows ${tin(still)}-${tout(still)}, not over the first three seconds (0-90)`,
        );
    },
    expectTrace: (t) => {
      startedTimes(t, "generate_image", 2, "the red rocket, then the blue one asked for");
      const calls = callsOf(t, "generate_image");
      if (turnOf(calls[1]) < 2)
        throw new Error("made a second image before the person changed their mind");
      if (!/blue/i.test(arg(calls[1], "prompt")))
        throw new Error("the second image is not the blue rocket asked for");
    },
  },
  {
    id: "async_captions_wait_for_the_words",
    title:
      "Captions asked for while the speech is still being transcribed: say so, then caption it",
    tags: [...ASYNC, "turns:2", "clips:2", "captions", "transcript"],
    surface: "studio",
    seed: narratedLaunch,
    prompt: "Put captions on what's being said.",
    followUps: [WORDS_READY],
    jobs: { words: SPOKEN },
    transcript: SPOKEN,
    scope: { add: ["text"], addTracks: true },
    expectTools: ["add_captions"],
    // The app answers a caption request it cannot do yet with a refusal that says to ask again later: the one this
    // case provokes. A second one in the same turn is a poll.
    maxToolErrors: 1,
    maxRounds: 10,
    expect: (final) => {
      const said = tokens(SPOKEN.words.map((w) => w[0]).join(" "));
      const captions = allClips(final)
        .filter((c) => c.kind === "text")
        .sort((x, y) => tin(x) - tin(y));
      const shown = tokens(captions.map((c) => clipText(c)).join(" "));
      if (!shown.length) throw new Error("no captions were added");
      const extra = shown.filter((w) => !said.includes(w));
      if (extra.length) throw new Error(`the captions show words nobody said: ${extra.join(", ")}`);
      const missing = said.filter((w) => !shown.includes(w));
      if (missing.length)
        throw new Error(`the captions leave out words that were said: ${missing.join(", ")}`);
    },
    expectTrace: (t) =>
      noClaimInTurn(t, 0, "the captions", /\b(added|placed|in place|on screen)\b/i),
  },
  {
    id: "async_cut_the_pause_once_words_land",
    title: "A pause to cut needs the words, which are still being made: wait, then cut it cleanly",
    tags: [...ASYNC, "turns:2", "clips:1", "transcript", "cut"],
    surface: "studio",
    seed: voiceOnly,
    prompt:
      "There's a long pause in the middle of this recording. Cut it out so it runs straight on.",
    followUps: [WORDS_READY],
    jobs: { words: SPOKEN },
    transcript: SPOKEN,
    scope: { change: ["n"], remove: ["n"], add: ["audio"] },
    expectTools: ["get_transcript", "ripple_delete"],
    maxRounds: 10,
    expect: (final) => {
      const heard = wordsHeard(final);
      const lost = SPOKEN.words.filter((_, i) => !heard[i]).map((w) => w[0]);
      if (lost.length) throw new Error(`words were cut: ${lost.join(" ")}`);
      const [, endOfFirst] = heard[5]!;
      const [startOfNext] = heard[6]!;
      const gap = startOfNext - endOfFirst;
      if (gap > 0.6 * FPS)
        throw new Error(`a ${Math.round(gap)}-frame pause is left between the sentences`);
      if (gap < 0) throw new Error("the sentences now overlap");
      const end = Math.max(...clipsOfRef(final, NARRATION).map(tout));
      if (end > 300 - 2 * FPS)
        throw new Error(`the recording still runs to frame ${end}: the pause was not taken out`);
    },
  },
];

// ── gap 8: generation flows ──────────────────────────────────────────────────────────────────────────────────────────

const GEN_CASES: Scenario[] = [
  {
    id: "gen_replace_placeholder_card",
    title: "A generated still replaces the placeholder card at the start",
    tags: [...GEN, "turns:3", "clips:2", "image", "replace"],
    surface: "studio",
    seed: cardThenLaunch,
    prompt:
      "Swap the grey placeholder card at the start for a generated image of a mountain lake at dawn.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.image(), IMG()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_image"],
    scope: { change: ["card"], remove: ["card"], add: ["image", "video"], addTracks: true },
    expectTools: ["generate_image"],
    maxRounds: 14,
    expect: (final) => {
      if (allClips(final).some((c) => c.media_ref === "card.png"))
        throw new Error("the placeholder card is still on the timeline");
      const still = theClip(final, IMG(), "the lake still");
      if (tin(still) > 2 || Math.abs(tout(still) - 90) > 3)
        throw new Error(
          `the lake still shows ${tin(still)}-${tout(still)}, not where the card was (0-90)`,
        );
      const a = allClips(final).find((c) => c.id === "a");
      if (!a || tin(a) !== 90 || tout(a) !== 390) throw new Error("the footage moved");
    },
    expectTrace: (t) => startedTimes(t, "generate_image", 1, "one image"),
  },
  {
    id: "gen_brighter_version_replaces",
    title: "On feedback, a new still is made and replaces the first",
    tags: [...GEN, "turns:5", "clips:1", "image", "regenerate"],
    surface: "studio",
    seed: launch,
    prompt:
      "Generate an image of the launch pad at night and show it over the first two seconds of the video.",
    followUps: [
      GO_AHEAD,
      wakeMessage(landed(LABEL.image(), IMG(1))),
      "It's too dark. Make a brighter version and use that instead. Go ahead and use the credits.",
      wakeMessage(landed(LABEL.image(), IMG(2))),
    ],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_image"],
    scope: { add: ["image", "video"], addTracks: true },
    expectTools: ["generate_image"],
    maxRounds: 20,
    expect: (final) => {
      if (clipsOfRef(final, IMG(1)).length)
        throw new Error("the first, too dark still is still on the timeline");
      const still = theClip(final, IMG(2), "the brighter still");
      if (tin(still) > 2 || Math.abs(tout(still) - 2 * FPS) > 6)
        throw new Error(
          `the brighter still shows ${tin(still)}-${tout(still)}, not over the first two seconds (0-60)`,
        );
    },
    expectTrace: (t) => {
      startedTimes(t, "generate_image", 2, "the first still, then the brighter one asked for");
      if (turnOf(callsOf(t, "generate_image")[1]) < 3)
        throw new Error("made a second still before anyone asked for one");
    },
  },
  {
    id: "gen_voiceover_with_matching_words",
    title: "A voiceover at the start with its words on screen while it plays",
    tags: [...GEN, "turns:3", "clips:1", "voiceover", "captions"],
    surface: "studio",
    seed: launch,
    prompt:
      "Add a voiceover saying 'Three, two, one, liftoff' at the start, and show the same words on screen while it plays.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.voiceover, VO()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_voiceover"],
    scope: { add: ["audio", "text"], addTracks: true },
    expectTools: ["generate_voiceover", "add_clips", "add_text_clips"],
    maxRounds: 16,
    expect: (final) => {
      const vo = theClip(final, VO(), "the voiceover");
      onTrackKind(final, vo, "audio", "the voiceover");
      if (tin(vo) > FPS)
        throw new Error(`the voiceover starts at frame ${tin(vo)}, not at the start`);
      const words = allClips(final).filter((c) => c.kind === "text");
      const text = words
        .map((c) => JSON.stringify(c))
        .join(" ")
        .toLowerCase();
      if (!/liftoff/.test(text) || !/three/.test(text))
        throw new Error("the words of the voiceover are not on screen");
      const from = Math.min(...words.map(tin));
      const to = Math.max(...words.map(tout));
      if (Math.abs(from - tin(vo)) > 6 || Math.abs(to - tout(vo)) > 10)
        throw new Error(
          `the words show ${from}-${to}, the voiceover plays ${tin(vo)}-${tout(vo)}: not while it plays`,
        );
    },
    expectTrace: (t) => startedTimes(t, "generate_voiceover", 1, "one voiceover"),
  },
  {
    id: "gen_music_quiet_under_talking",
    title: "Generated music under a talking clip, low enough to hear the voice",
    tags: [...GEN, "turns:3", "clips:1", "music", "levels"],
    surface: "studio",
    seed: talk,
    prompt:
      "Make some soft background music and put it under the whole clip, quiet enough that the talking stays clear.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.music, MUSIC()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_music"],
    scope: { add: ["audio"], addTracks: true },
    expectTools: ["generate_music", "add_clips", "set_clip_properties"],
    maxRounds: 16,
    expect: (final) => {
      const bed = theClip(final, MUSIC(), "the music");
      spans(bed, 0, 300, "the music");
      // Lowered, or ducked under the talking: either keeps the voice clear.
      const rec = bed as Record<string, unknown>;
      const volume = Number(rec.volume ?? 1);
      const ducked = !!rec.duck && typeof rec.duck === "object";
      if (!(volume < 0.7) && !ducked)
        throw new Error(`the music plays at volume ${volume}, as loud as the talking`);
      const t = allClips(final).find((c) => c.id === "t");
      if (Number((t as Record<string, unknown> | undefined)?.volume ?? 1) < 1)
        throw new Error("the talking was turned down instead of the music");
    },
    expectTrace: (t) => startedTimes(t, "generate_music", 1, "one music bed"),
  },
  {
    id: "gen_three_stills_in_a_row",
    title: "Three generated stills, two seconds each, after the video",
    tags: [...GEN, "turns:3", "clips:1", "image", "count"],
    surface: "studio",
    seed: launch,
    prompt:
      "Generate three different stills of the rocket on the pad and show them one after another after the video, two seconds each.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.image(3), IMG(1), IMG(2), IMG(3)))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_image"],
    scope: { add: ["image", "video"], addTracks: true },
    expectTools: ["generate_image", "add_clips"],
    maxRounds: 16,
    expect: (final) => {
      const stills = allClips(final)
        .filter((c) => /^media_gen_image_/.test(String(c.media_ref ?? "")))
        .sort((x, y) => tin(x) - tin(y));
      if (stills.length !== 3)
        throw new Error(`expected three stills on the timeline, found ${stills.length}`);
      if (new Set(stills.map((c) => c.media_ref)).size !== 3)
        throw new Error("the same still is shown twice");
      let at = 300;
      for (const s of stills) {
        if (Math.abs(tin(s) - at) > 2)
          throw new Error(`a still starts at ${tin(s)}, expected ${at}`);
        if (Math.abs(tout(s) - tin(s) - 2 * FPS) > 4)
          throw new Error(`a still shows for ${tout(s) - tin(s)} frames, not two seconds (60)`);
        at = tout(s);
      }
    },
    expectTrace: (t) => {
      const made = okCalls(t, "generate_image").reduce(
        (n, c) => n + (Number(c.args.count ?? 1) || 1),
        0,
      );
      if (made !== 3) throw new Error(`generated ${made} images, the request asks for three`);
    },
  },
  {
    id: "gen_not_needed_library_has_ocean",
    title: "An ocean shot is asked for and the library has one: use it, generate nothing",
    tags: ["gap:generation", "lang:en", "studio", "turns:1", "clips:1", "library", "no-spend"],
    surface: "studio",
    seed: launch,
    prompt: "I need an ocean shot right after this clip.",
    mustNotCall: ["generate_video", "generate_image"],
    scope: { add: ["video", "audio"], addTracks: true },
    expectTools: ["library_op", "add_clips"],
    maxRounds: 10,
    expect: (final) => {
      const ocean = theClip(final, "media_broll_ocean", "the library's ocean shot");
      if (Math.abs(tin(ocean) - 300) > 2)
        throw new Error(`the ocean shot starts at ${tin(ocean)}, not after the clip (300)`);
    },
  },
  {
    id: "gen_not_needed_title_words",
    title: "Words on screen are a title, not a generated image",
    tags: ["gap:generation", "lang:en", "studio", "turns:1", "clips:1", "title", "no-spend"],
    surface: "studio",
    seed: launch,
    prompt: "Put the words LAUNCH DAY on screen over the first three seconds, big and centred.",
    mustNotCall: ["generate_image", "generate_video"],
    scope: { add: ["text"], addTracks: true },
    expectTools: ["add_text_clips"],
    maxRounds: 8,
    expect: (final) => {
      const titles = allClips(final).filter(
        (c) => c.kind === "text" && /launch day/i.test(JSON.stringify(c)),
      );
      if (titles.length === 0) throw new Error("the words LAUNCH DAY are not on screen");
      const t = titles[0];
      if (tin(t) > 2 || Math.abs(tout(t) - 3 * FPS) > 6)
        throw new Error(
          `the title shows ${tin(t)}-${tout(t)}, not over the first three seconds (0-90)`,
        );
    },
  },
  {
    id: "gen_animate_the_still",
    title: "A still is made, then animated from that still, and only the clip is placed",
    tags: [...GEN, "turns:4", "clips:1", "image", "video", "start-frame"],
    surface: "studio",
    seed: launch,
    prompt:
      "Make a still of a paper kite on a beach, then animate that still so the kite lifts off, and put the animated clip after my video.",
    followUps: [
      GO_AHEAD,
      wakeMessage(landed(LABEL.image(), IMG())),
      wakeMessage(landed(LABEL.video(8), VID())),
    ],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_image", "generate_video"],
    scope: { add: ["video", "audio"], addTracks: true },
    expectTools: ["generate_image", "generate_video", "add_clips"],
    maxRounds: 18,
    expect: (final) => {
      const clip = clipsOfRef(final, VID()).filter((c) => c.kind !== "audio");
      if (clip.length !== 1)
        throw new Error(`expected the animated clip once, found ${clip.length}`);
      if (tin(clip[0]) < 298)
        throw new Error(`the animated clip starts at ${tin(clip[0])}, not after the video`);
      if (clipsOfRef(final, IMG()).length)
        throw new Error("the still was placed too; only the animated clip was asked for");
    },
    expectTrace: (t) => {
      startedTimes(t, "generate_image", 1, "one still");
      const video = okCalls(t, "generate_video");
      if (video.length !== 1)
        throw new Error(`generate_video ran ${video.length} times, the request asks for one clip`);
      const from = [
        arg(video[0], "start_frame"),
        ...((video[0].args.reference_images as string[]) ?? []),
      ];
      if (!from.includes(IMG()))
        throw new Error("the clip was not animated from the still that was made");
    },
  },
  {
    id: "gen_same_cat_two_shots",
    title: "One reference still keeps a subject the same across two generated shots",
    tags: [...GEN, "turns:4", "clips:1", "video", "reference"],
    surface: "studio",
    seed: launch,
    prompt:
      "Make two short shots of the same orange cat: first chasing a ball, then asleep on a sofa. Keep the cat looking the same in both, and put them after my clip in that order.",
    followUps: [
      GO_AHEAD,
      wakeMessage(landed(LABEL.image(), IMG())),
      wakeMessage(landed(LABEL.video(8), VID(1)), landed(LABEL.video(8), VID(2))),
    ],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_image", "generate_video"],
    scope: { add: ["video", "audio", "image"], addTracks: true },
    expectTools: ["generate_image", "generate_video", "add_clips"],
    maxRounds: 20,
    expect: (final) => {
      for (const ref of [VID(1), VID(2)])
        if (!clipsOfRef(final, ref).some((c) => c.kind !== "audio" && tin(c) >= 298))
          throw new Error(`${ref} is not on the timeline after the clip`);
    },
    expectTrace: (t, final) => {
      const videos = okCalls(t, "generate_video");
      if (videos.length !== 2)
        throw new Error(
          `generate_video ran ${videos.length} times, the request asks for two shots`,
        );
      for (const v of videos) {
        const refs = [arg(v, "start_frame"), ...((v.args.reference_images as string[]) ?? [])];
        if (!refs.includes(IMG()))
          throw new Error("a shot was made without the cat's reference still");
      }
      // Each shot's ref, from what its call answered, in the story's order.
      const refOf = (c: ToolCall) =>
        (JSON.parse(c.result ?? "{}") as { media_ref?: string }).media_ref ?? "";
      const chase = videos.find((v) => /ball|chas/i.test(arg(v, "prompt")));
      const sleep = videos.find((v) => /sleep|asleep|sofa/i.test(arg(v, "prompt")));
      if (!chase || !sleep)
        throw new Error("the two shots are not the chase and the nap asked for");
      if (final) {
        const at = (ref: string) => Math.min(...clipsOfRef(final, ref).map(tin));
        if (!(at(refOf(chase)) < at(refOf(sleep))))
          throw new Error("the nap plays before the chase");
      }
    },
  },
  {
    id: "gen_story_shots_in_order",
    title: "Three generated shots of a little story, played in the story's order",
    tags: [...GEN, "turns:3", "clips:1", "video", "sequence"],
    surface: "studio",
    seed: launch,
    prompt:
      "Make three short shots for a tiny story: a seed in soil, then a green sprout, then an open flower. Play them in that order after my clip.",
    followUps: [
      GO_AHEAD,
      wakeMessage(
        landed(LABEL.video(8), VID(1)),
        landed(LABEL.video(8), VID(2)),
        landed(LABEL.video(8), VID(3)),
      ),
    ],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_video"],
    scope: { add: ["video", "audio"], addTracks: true },
    expectTools: ["generate_video", "add_clips"],
    maxRounds: 16,
    expectTrace: (t, final) => {
      const videos = okCalls(t, "generate_video");
      if (videos.length !== 3)
        throw new Error(`generate_video ran ${videos.length} times, the story has three shots`);
      const refOf = (c: ToolCall) =>
        (JSON.parse(c.result ?? "{}") as { media_ref?: string }).media_ref ?? "";
      const order = [/seed/i, /sprout/i, /flower/i].map((re) =>
        videos.find((v) => re.test(arg(v, "prompt"))),
      );
      if (order.some((v) => !v))
        throw new Error("the shots are not the seed, the sprout and the flower asked for");
      if (!final) return;
      const starts = order.map((v) => {
        const hits = clipsOfRef(final, refOf(v!)).filter((c) => c.kind !== "audio");
        if (!hits.length) throw new Error(`${refOf(v!)} is not on the timeline`);
        return Math.min(...hits.map(tin));
      });
      if (starts[0] < 298) throw new Error("the story does not start after the clip");
      if (!(starts[0] < starts[1] && starts[1] < starts[2]))
        throw new Error("the shots are not in the story's order");
    },
  },
  {
    id: "gen_swap_music_bed",
    title: "The music bed is swapped for a generated one over the same span",
    tags: [...GEN, "turns:3", "clips:2", "music", "replace"],
    surface: "studio",
    seed: withBed,
    prompt: "Swap the music for a new upbeat electronic track you generate.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.music, MUSIC()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_music"],
    scope: { change: ["m"], remove: ["m"], add: ["audio"], tracks: ["a1"], addTracks: true },
    expectTools: ["generate_music", "add_clips"],
    maxRounds: 16,
    expect: (final) => {
      if (allClips(final).some((c) => c.media_ref === "bed.mp3"))
        throw new Error("the old music is still in the edit");
      spans(theClip(final, MUSIC(), "the new music"), 0, 300, "the new music");
    },
    expectTrace: (t) => startedTimes(t, "generate_music", 1, "one music track"),
  },
  {
    id: "gen_cover_the_jump_cut",
    title: "A generated shot laid on a track above, over the jump cut",
    tags: [...GEN, "turns:3", "clips:2", "video", "overlay"],
    surface: "studio",
    seed: () =>
      timeline([
        vtrack("v1", 0, [
          vclip("a", "a.mp4", 0, 150),
          vclip("a2", "a.mp4", 150, 300, { source_in: 210, source_out: 360 }),
        ]),
      ]),
    prompt:
      "There's a jump cut at the five-second mark. Generate a 4-second shot of the crowd watching and lay it over the cut on a track above, so it hides it.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.video(4), VID()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_video"],
    scope: { add: ["video", "audio"], addTracks: true },
    expectTools: ["generate_video", "add_clips"],
    maxRounds: 14,
    expect: (final) => {
      const shots = clipsOfRef(final, VID()).filter((c) => c.kind !== "audio");
      if (shots.length !== 1)
        throw new Error(`expected the crowd shot once, found ${shots.length}`);
      const s = shots[0];
      if (!(tin(s) < 150 && tout(s) > 150))
        throw new Error(`the crowd shot plays ${tin(s)}-${tout(s)}, not over the cut at 150`);
      if (zOf(final, String(s.id)) <= zOf(final, "a"))
        throw new Error("the crowd shot is not on a track above the footage");
      const a = allClips(final).find((c) => c.id === "a");
      const a2 = allClips(final).find((c) => c.id === "a2");
      if (!a || !a2 || tout(a) !== 150 || tin(a2) !== 150)
        throw new Error("the footage under the cut moved");
    },
    expectTrace: (t) => startedTimes(t, "generate_video", 1, "one shot"),
  },
  {
    id: "gen_voiceover_new_line_replaces",
    title: "A voiceover is remade with a new line and replaces the first",
    tags: [...GEN, "turns:5", "clips:1", "voiceover", "regenerate"],
    surface: "studio",
    seed: launch,
    prompt: "Make a voiceover saying 'Welcome to the launch' and put it at the start.",
    followUps: [
      GO_AHEAD,
      wakeMessage(landed(LABEL.voiceover, VO(1))),
      "Change it to say 'Hello and welcome' instead. Go ahead and use the credits.",
      wakeMessage(landed(LABEL.voiceover, VO(2))),
    ],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_voiceover"],
    scope: { add: ["audio"], addTracks: true },
    expectTools: ["generate_voiceover", "add_clips"],
    maxRounds: 20,
    expect: (final) => {
      if (clipsOfRef(final, VO(1)).length)
        throw new Error("the first voiceover is still in the edit");
      const vo = theClip(final, VO(2), "the new voiceover");
      onTrackKind(final, vo, "audio", "the new voiceover");
      if (tin(vo) > FPS)
        throw new Error(`the new voiceover starts at frame ${tin(vo)}, not at the start`);
    },
    expectTrace: (t) => {
      startedTimes(t, "generate_voiceover", 2, "the first line, then the new one asked for");
      if (!/hello and welcome/i.test(arg(okCalls(t, "generate_voiceover")[1], "text")))
        throw new Error("the second voiceover does not say the new line");
    },
  },
  {
    id: "gen_not_needed_reuse_the_still",
    title: "The still already in the edit is reused, not generated again",
    tags: ["gap:generation", "lang:en", "studio", "turns:1", "clips:2", "image", "no-spend"],
    surface: "studio",
    seed: sunsetThenLaunch,
    prompt: "Use the sunset still from the start again at the very end, for two seconds.",
    mustNotCall: ["generate_image"],
    scope: { add: ["image", "video"], addTracks: true },
    expectTools: ["add_clips"],
    maxRounds: 8,
    expect: (final) => {
      const suns = clipsOfRef(final, "sunset.png").sort((x, y) => tin(x) - tin(y));
      if (suns.length !== 2)
        throw new Error(`expected the sunset still twice, found ${suns.length}`);
      const end = suns[1];
      if (Math.abs(tin(end) - 360) > 2 || Math.abs(tout(end) - tin(end) - 2 * FPS) > 4)
        throw new Error(
          `the second sunset shows ${tin(end)}-${tout(end)}, not two seconds at the end (360-420)`,
        );
    },
  },
  {
    id: "gen_widescreen_shot_matches_canvas",
    title: "A generated shot for a widescreen project is made widescreen",
    tags: [...GEN, "turns:3", "clips:1", "video", "aspect"],
    surface: "studio",
    seed: () =>
      timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])], { width: 1920, height: 1080 }),
    prompt: "Generate a 6-second shot of storm clouds rolling in and put it after my clip.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.video(6), VID()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_video"],
    scope: { add: ["video", "audio"], addTracks: true },
    expectTools: ["list_models", "generate_video", "add_clips"],
    maxRounds: 14,
    expect: (final) => {
      const shots = clipsOfRef(final, VID()).filter((c) => c.kind !== "audio");
      if (shots.length !== 1)
        throw new Error(`expected the storm shot once, found ${shots.length}`);
      if (Math.abs(tin(shots[0]) - 300) > 2)
        throw new Error(`the storm shot starts at ${tin(shots[0])}, not after the clip (300)`);
    },
    expectTrace: (t) => {
      startedTimes(t, "generate_video", 1, "one shot");
      // The generator makes a vertical clip unless told otherwise; in a 16:9 project that is a strip with black sides.
      const shape = arg(callsOf(t, "generate_video")[0], "aspect_ratio");
      if (shape !== "16:9")
        throw new Error(
          `the shot was made ${shape || "9:16 (the default)"}, not 16:9 like the project`,
        );
    },
  },
  {
    id: "gen_intro_shot_crossfades_in",
    title: "A generated intro before the clip, crossfading into it",
    tags: [...GEN, "turns:3", "clips:1", "video", "transition"],
    surface: "studio",
    seed: launch,
    prompt:
      "Make a 4-second shot of a starry night sky as an intro before my clip, and crossfade from it into my clip.",
    followUps: [GO_AHEAD, wakeMessage(landed(LABEL.video(4), VID()))],
    jobs: { landsAtTurn: 2 },
    paidTools: ["generate_video"],
    scope: { change: ["a"], add: ["video", "audio"], addTracks: true },
    expectTools: ["generate_video", "insert_clips", "set_transition"],
    maxRounds: 16,
    expect: (final) => {
      const intro = clipsOfRef(final, VID()).filter((c) => c.kind !== "audio");
      if (intro.length !== 1) throw new Error(`expected the intro once, found ${intro.length}`);
      if (tin(intro[0]) > 2 || Math.abs(tout(intro[0]) - 4 * FPS) > 6)
        throw new Error(
          `the intro plays ${tin(intro[0])}-${tout(intro[0])}, not the first four seconds`,
        );
      const a = allClips(final).find((c) => c.id === "a");
      if (!a) throw new Error("the clip is gone");
      if (Math.abs(tin(a) - tout(intro[0])) > 2 || tout(a) - tin(a) !== 300)
        throw new Error(`the clip plays ${tin(a)}-${tout(a)}: not whole, straight after the intro`);
      if (trackOfClip(final, "a") !== trackOfClip(final, String(intro[0].id)))
        throw new Error("the intro is not on the clip's track, so nothing crossfades between them");
      if ((a.transition_in as { kind?: string } | undefined)?.kind !== "crossfade")
        throw new Error("there is no crossfade from the intro into the clip");
    },
    expectTrace: (t) => startedTimes(t, "generate_video", 1, "one intro"),
  },
];

// ── the correct run of every case (ruling 22): one step per model round, every turn ending in a reply ─────────────

/** One model round of a correct run (src/eval/reference.ts): a reply, which ends the turn, or tool calls, fixed or made
 *  from the request the model got (its `round_input.tool_results` are the previous round's replies), for an id an
 *  earlier tool minted. */
export type Step = ReferenceStep;

export const say = (text: string): Step => ({ text });
export const call = (name: string, args: Record<string, unknown> = {}): Step => ({
  calls: [[name, args]],
});
export const calls = (...c: ReferenceCalls): Step => ({ calls: c });
export const place = (...entries: Record<string, unknown>[]): Step =>
  call("add_clips", { entries });

/** The id of the clip that plays `ref`, from what the previous round's tools answered (a get_timeline read). */
export function clipIdOf(req: InferenceRequest, ref: string): string {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.media_ref === ref && typeof (o.id ?? o.clip_id) === "string")
      found.push(String(o.id ?? o.clip_id));
    Object.values(o).forEach(walk);
  };
  walk((req.round_input.tool_results ?? []).map((r) => r.result));
  if (found.length !== 1)
    throw new Error(`expected one clip playing ${ref}, found ${found.length}`);
  return found[0];
}

/** The id of the one clip the previous round's add_clips placed. */
export function placedNow(req: InferenceRequest): string {
  const placed = (req.round_input.tool_results ?? [])
    .filter((r) => r.name === "add_clips")
    .flatMap((r) => (r.result.created ?? []) as { clip_id: string }[]);
  if (placed.length !== 1) throw new Error(`expected one clip placed, found ${placed.length}`);
  return placed[0].clip_id;
}

/** Read the timeline, then point the clip that plays `from` at `to`, where it is. */
const swapMedia = (from: string, to: string): Step[] => [
  call("get_timeline"),
  { calls: (req) => [["set_clip_properties", { clip_ids: [clipIdOf(req, from)], media_ref: to }]] },
];

export const STARTED = say("Started it. It takes a minute or so; I'll carry on when it lands.");
export const LET_IT_FINISH = say("It is already on its way, so I'm letting it finish.");

// ── the correct run of every case ─────────────────────────────────────────────────────────────────────────────────

export const GAP_ASYNC_REFERENCES: Record<string, Step[]> = {
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
  async_export_asked_while_image_generates: [
    call("generate_image", { prompt: "a rocket on the pad at dawn, title card framing" }),
    call("add_track", { id: "v2", kind: "video" }),
    place({ media_ref: IMG(), timeline_in: 0, timeline_out: 90, track_id: "v2" }),
    STARTED,
    LET_IT_FINISH,
    call("library_op", { action: "list" }),
    say(
      "The title image is still being generated, and an export would leave it out. I'll export as soon as it lands.",
    ),
    call("export"),
    say("The image landed, so the export is running now."),
    say(`The export has finished: ${STUDIO_EXPORT_FILE} in your Downloads folder.`),
  ],
  async_changed_mind_while_generating: [
    call("generate_image", { prompt: "a red rocket on the pad at dawn" }),
    call("add_track", { id: "v2", kind: "video" }),
    place({ media_ref: IMG(1), timeline_in: 0, timeline_out: 90, track_id: "v2" }),
    STARTED,
    LET_IT_FINISH,
    call("generate_image", { prompt: "a blue rocket on the pad at dawn" }),
    ...swapMedia(IMG(1), IMG(2)),
    say("Making the blue one now; it replaces the red one over the first three seconds."),
    say("Both landed; the blue rocket is the one on screen."),
  ],
  async_captions_wait_for_the_words: [
    call("add_captions"),
    say(
      "The speech is still being transcribed, about 40 seconds more. I'll add the captions as soon as the words are ready.",
    ),
    call("add_captions"),
    say("The captions are on, following what's said."),
  ],
  async_cut_the_pause_once_words_land: [
    call("get_transcript"),
    say("The words are still being transcribed; I'll cut the pause once they're ready."),
    call("get_transcript"),
    call("ripple_delete", { track_id: "a1", ranges: [{ start: 72, end: 159 }] }),
    say("The pause between the two sentences is cut; it runs straight on."),
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
    ...swapMedia(IMG(1), IMG(2)),
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
      calls: (req) => [["set_clip_properties", { clip_ids: [placedNow(req)], volume: 0.25 }]],
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
    call("get_timeline"),
    { calls: (req) => [["remove_clips", { clip_ids: [clipIdOf(req, VO(1))] }]] },
    place({ media_ref: VO(2), timeline_in: 0 }),
    say("The new line replaces the old one at the start."),
  ],
  gen_not_needed_reuse_the_still: [
    place({ media_ref: "sunset.png", timeline_in: 360, duration: 60 }),
    say("The sunset still now also closes the video, for two seconds."),
  ],
  gen_widescreen_shot_matches_canvas: [
    call("get_project_state"),
    call("generate_video", {
      prompt: "storm clouds rolling in over a plain, time-lapse",
      duration: 6,
      aspect_ratio: "16:9",
    }),
    place({ media_ref: VID(), timeline_in: 300 }),
    say("The storm shot is generating in 16:9 like your project, placed after your clip."),
    LET_IT_FINISH,
    say("It landed and is in place."),
  ],
  gen_intro_shot_crossfades_in: [
    call("generate_video", { prompt: "a starry night sky, slow drift", duration: 4 }),
    call("insert_clips", { at: 0, track_id: "v1", entries: [{ media_ref: VID(), duration: 120 }] }),
    call("set_transition", { clip_id: "a", transition_in: { kind: "crossfade", duration: 15 } }),
    say("The starry intro is generating and placed before your clip, with a crossfade into it."),
    LET_IT_FINISH,
    say("It landed and is in place."),
  ],
};

/** Every case with its correct run (ruling 22): scenarios.reference.test.ts replays each through the real harness with
 *  no model and requires it to pass. */
export const GAP_ASYNC_SCENARIOS: Scenario[] = [...ASYNC_CASES, ...GEN_CASES].map((s) => ({
  ...s,
  reference: GAP_ASYNC_REFERENCES[s.id],
}));
