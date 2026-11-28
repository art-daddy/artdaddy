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
import {
  exportDone,
  exportFailed,
  failedJob,
  LABEL,
  landed,
  providerReturnedNothing,
  STUDIO_EXPORT_FILE,
  wakeMessage,
} from "../jobWake";
import type { Scenario, ToolCall, Trace } from "../types";
import { aclip, allClips, atrack, timeline, vclip, vtrack } from "./helpers";

const FPS = 30;

/** The yes to a proposed paid call, in the person's words. To an agent that already started the work it says to let
 *  that work finish. */
export const GO_AHEAD =
  "Yes, go ahead and use the credits. If it's already on its way, just let it finish.";

/** The refs the job stand-ins mint, in order per kind (jobs.ts). */
const IMG = (n = 1) => `media_gen_image_${n}`;
const VID = (n = 1) => `media_gen_video_${n}`;
const VO = (n = 1) => `media_gen_voiceover_${n}`;
const MUSIC = (n = 1) => `media_gen_music_${n}`;

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
const HEDGE =
  /\b(not|no|yet|still|once|when|whenever|until|will|going to|soon|after|being|progress|queued|running|started|starting|underway|generating|rendering|exporting|processing|minute|minutes|moment|seconds|wait|waiting|let you know|tell you)\b|n't\b|'ll\b/i;

/** The sentence of `text` that says work is finished, with nothing in it that says it is still to come; or null. A
 *  pointer to a false claim, not a judge of wording: a hedged or future sentence never counts. */
export function claimsDone(text: string): string | null {
  for (const s of text.split(/(?<=[.!?])\s+|\n+/))
    if (DONE.test(s) && !HEDGE.test(s)) return s.trim();
  return null;
}
function noClaimInTurn(t: Trace, turn: number, what: string): void {
  const said = claimsDone(textOfTurn(t, turn));
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

/** The video tracks' stacking: `upper` draws over `lower`. */
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
      if (!/\b45\b|under a minute|less than a minute|under one minute/i.test(textOfTurn(t, 1)))
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
      const volume = Number((bed as Record<string, unknown>).volume ?? 1);
      if (!(volume < 0.7))
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
];

export const GAP_ASYNC_SCENARIOS: Scenario[] = [...ASYNC_CASES, ...GEN_CASES];
