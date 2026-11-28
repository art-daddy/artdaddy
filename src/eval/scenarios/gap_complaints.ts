// Complaints, answered honestly.
//
// After an edit the person complains: nothing happened, the picture is black, there is no sound,
// the export failed, the wrong clip changed, something plays twice, a word is misspelled. Some
// complaints are right (the seed or the agent's own first turn really left the problem), some are
// mistaken (the edit is fine and the person is looking at something else), and one asks about
// something only the person can change. Each case is two turns, an ordinary request and then the
// complaint, and every case is graded on where the two turns leave the project:
//
//   - a RIGHT complaint is answered only when the problem is gone. A reply that says "fixed" with
//     no fix, a fix aimed at the wrong cause, or undoing the person's own request because it was
//     blamed, all leave the project wrong, so the end state catches them;
//   - a MISTAKEN complaint must not "fix" anything: the asked edit stays exactly as asked, with
//     nothing doubled, undone, boosted or rendered again;
//   - where the honest reply rests on a fact only a look can give (an export still running, a
//     soloed track), the reply must carry that fact. That is the content of the answer, never its
//     wording: any phrasing that states the fact passes.
//
// The seeds blame the latest edit for a problem that was already there (a muted or hidden track,
// a track stacked under the footage, a turned clip, a late sound, a doubled intro, a typo), as
// people do. Prose claims beyond those facts are the judge's: the regex signals
// (claimedSuccessWithoutEdit) are recorded on every run and gate nothing (signals.ts).
//
// Each case carries its correct run (`reference`), which scenarios.reference.test.ts replays with
// no model; scenarios.gap_complaints.test.ts shows each check rejecting plausible wrong runs.
import type { Clip, Timeline, Track } from "../../timeline/model";
import { resolveSizePx } from "../../timeline/renderPlan";
import { clipText, compactClip } from "../../timeline/shape";
import { audibleTracks, clipPlays, visibleTracks } from "../../timeline/visibility";
import { isMutationEffect, toolEffect } from "../../contract/effects";
import { describeDiff, timelineDiff } from "../checks";
import type { ReferenceStep } from "../reference";
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
const LANDSCAPE = { width: 1920, height: 1080, fps: FPS };

/** Every case here is a complaint in English: one request, then one follow-up. */
const TAGS = ["gap:complaints", "lang:en", "turns:2"];

// ── readers ──────────────────────────────────────────────────────────────────

/** The track a clip sits on in the final timeline. */
function trackHolding(tl: Timeline, clipId: string): Track | undefined {
  return (tl.tracks ?? []).find((t) => (t.clips ?? []).some((c) => c.id === clipId));
}

/** A level as one number: a constant, or the loudest point of its keyframes. */
function peakOf(v: unknown, fallback = 1): number {
  if (typeof v === "number") return v;
  if (Array.isArray(v) && v.length)
    return Math.max(...v.map((k) => Number((k as { v?: unknown })?.v ?? NaN)));
  return fallback;
}

/** The clip is heard in playback and in the export: its track sounds and the clip is on. */
function heard(tl: Timeline, clipId: string): boolean {
  const clip = clipById(tl, clipId);
  const track = trackHolding(tl, clipId);
  return (
    !!clip &&
    !!track &&
    clipPlays(clip) &&
    peakOf(clip.volume) > 0.05 &&
    audibleTracks(tl).includes(track)
  );
}

/** The clip is drawn: its track draws and the clip is on and not see-through. */
function drawn(tl: Timeline, clipId: string): boolean {
  const clip = clipById(tl, clipId);
  const track = trackHolding(tl, clipId);
  return (
    !!clip &&
    !!track &&
    clipPlays(clip) &&
    peakOf(clip.opacity) > 0.05 &&
    visibleTracks(tl).includes(track)
  );
}

/** Text as a person reads it: case, spacing, quote marks around it and a closing stop aside. */
const words = (s: string): string =>
  s
    .toLowerCase()
    .replace(/["'`\u2018\u2019\u201c\u201d]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "");
const textClips = (tl: Timeline): Clip[] => allClips(tl).filter((c) => c.kind === "text");

/** The one title the request asked for: exactly one text clip, reading `wanted`. */
function theTitle(tl: Timeline, wanted: string): Clip {
  const texts = textClips(tl);
  assert(
    texts.length === 1,
    `expected one title, found ${texts.length}: ${JSON.stringify(texts.map(clipText))}`,
  );
  const t = texts[0];
  assert(words(clipText(t)) === words(wanted), `the title reads "${clipText(t)}", not "${wanted}"`);
  return t;
}

/** A title placed at the start for about `frames` frames. */
function titleAtStart(tl: Timeline, wanted: string, frames: number): void {
  const t = theTitle(tl, wanted);
  assert(Number(t.timeline_in) <= 3, `the title starts at frame ${t.timeline_in}, not the start`);
  near(Number(t.timeline_out), frames, 8, "where the title ends");
}

/** How big a text clip's type is drawn, in px on a canvas `ch` high: its size (or its runs'
 *  biggest) times its scale. */
function typeSize(c: Clip, ch: number): number {
  const style = (c.style ?? {}) as Record<string, unknown>;
  const base = resolveSizePx(style, ch, ch * 0.06);
  const runs = Array.isArray(c.content) ? c.content : [];
  const sizes = runs.map((r) =>
    resolveSizePx((r?.style ?? {}) as Record<string, unknown>, ch, base),
  );
  const scale = c.transform?.scale;
  return Math.max(base, ...sizes) * (typeof scale === "number" ? scale : 1);
}

/** How big a clip is drawn relative to the canvas: its uniform scale, or the smaller of its two
 *  axis scales (keyframes count by their largest value). */
function scaleOf(c: Clip): number {
  const t = c.transform ?? {};
  if (t.scale !== undefined) return peakOf(t.scale);
  if (t.scale_x !== undefined || t.scale_y !== undefined)
    return Math.min(peakOf(t.scale_x), peakOf(t.scale_y));
  return 1;
}

/** The clip fades in over its first `frames` frames: a fade-in of about that length, or an
 *  opacity ramp from nothing at its start to full about there. */
function fadesIn(c: Clip, frames: number): boolean {
  if (Math.abs(Number(c.fade?.in ?? 0) - frames) <= 3) return true;
  const kf = Array.isArray(c.opacity) ? c.opacity : [];
  if (kf.length < 2) return false;
  const full = kf.find((k) => Number(k.v) >= 0.95);
  return (
    Number(kf[0].t) <= 1 &&
    Number(kf[0].v) <= 0.05 &&
    !!full &&
    Math.abs(Number(full.t) - frames) <= 3
  );
}

/** A seed clip is exactly as it was, whichever track holds it now: same place, length, source and
 *  look (a move between tracks is a change of track, not of the clip). `except` names the fields
 *  the request itself changes. */
function clipAsSeeded(
  final: Timeline,
  seed: () => Timeline,
  id: string,
  what: string,
  except: readonly string[] = [],
): void {
  const now = clipById(final, id);
  assert(now, `${what} is gone`);
  const was = clipById(seed(), id)!;
  const shown = (c: Clip): string => {
    const o = compactClip(c) as Record<string, unknown>;
    for (const k of except) delete o[k];
    return JSON.stringify(o);
  };
  assert(shown(was) === shown(now), `${what} was changed: ${shown(now)} (was ${shown(was)})`);
}

/** The final timeline holds what the seed held: canvas, tracks and clips. Top-level bookkeeping
 *  the load adds (such as `failures`) is not the person's project, and neither is an empty track
 *  a reverted edit left behind. */
function sameAs(seed: () => Timeline, final: Timeline): void {
  const d = timelineDiff(seed(), final);
  const empty = new Set(
    (final.tracks ?? []).filter((t) => !(t.clips ?? []).length).map((t) => String(t.id)),
  );
  const left = describeDiff({
    ...d,
    other: [],
    tracksAdded: d.tracksAdded.filter((id) => !empty.has(id)),
  });
  assert(left.length === 0, `the project is not back the way it was: ${left.join("; ")}`);
}

/** The calls the complaint set off: those of the follow-up turn. A runner that records no turns
 *  gets every call, so the check can only be looser there, never stricter. */
function complaintCalls(t: Trace): ToolCall[] {
  const known = t.toolCalls.some((c) => typeof c.turn === "number");
  return known ? t.toolCalls.filter((c) => (c.turn ?? 0) >= 1) : t.toolCalls;
}

const isEdit = (c: ToolCall): boolean => {
  const effect = toolEffect(c.name);
  return c.ok && effect !== undefined && isMutationEffect(effect);
};

/** mp4 renders asked for, refused ones too: each one the model decided to start. */
const renders = (t: Trace): ToolCall[] =>
  t.toolCalls.filter((c) => c.name === "export" && (c.args?.format ?? "mp4") !== "fcpxml");

/** A clip's saturation (1 when its grade leaves it alone; 0 is black and white). */
const saturation = (c: Clip | undefined): number => {
  const v = (c?.color as Record<string, unknown> | undefined)?.saturation;
  return v === undefined || v === null ? 1 : peakOf(v, 1);
};

/** The clip fades out over its last `frames` frames: a fade-out of about that length, or a
 *  volume ramp that starts about there and ends silent. */
function fadesOut(c: Clip, frames: number): boolean {
  const out = Number(c.fade?.out ?? 0);
  if (Math.abs(out - frames) <= 6) return true;
  const kf = Array.isArray(c.volume) ? c.volume : [];
  if (kf.length < 2) return false;
  const len = span(c);
  const last = kf[kf.length - 1];
  const loud = [...kf].reverse().find((k) => Number(k.v) > 0.05);
  return (
    Number(last.v) <= 0.02 &&
    Math.abs(Number(last.t) - len) <= 3 &&
    !!loud &&
    Math.abs(len - Number(loud.t) - frames) <= 6
  );
}

/** What the reply must say about an export that is still running: any wording that says it has
 *  not finished. A reply that calls it failed, done or saved says none of these. */
const STILL_GOING = new RegExp(
  [
    "\\bstill\\b",
    "in progress",
    "under ?way",
    "\\bongoing\\b",
    "in the queue",
    "\\bqueued\\b",
    "\\brunning\\b",
    "\\brendering\\b",
    "\\bexporting\\b",
    "\\bprocessing\\b",
    "being (?:rendered|exported|processed|made|written)",
    "yet to (?:finish|complete)",
    "not (?:yet )?(?:finished|done|complete|completed|ready)",
    "(?:has|is)(?:n['\u2019]?t| not) (?:yet )?(?:finished|completed|done|complete|ready)",
  ].join("|"),
  "i",
);

/** What the reply must name about a soloed track: the solo, however it is put. */
const NAMES_SOLO = /\bsolo|plays? (?:on its own|by itself|alone)|isolat/i;

// ── seeds ────────────────────────────────────────────────────────────────────

const mutedVoiceSeed = () =>
  timeline(
    [
      vtrack("v1", 0, [vclip("talk", "talk.mp4", 0, 360, { link_group: "lg_talk" })]),
      {
        ...atrack("a1", 0, [aclip("talkAud", "talk.mp4", 0, 360, { link_group: "lg_talk" })]),
        mute: true,
      },
    ],
    LANDSCAPE,
  );

const hiddenFootageSeed = () =>
  timeline([{ ...vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]), hidden: true }]);

const logoUnderFootageSeed = () =>
  timeline([
    vtrack("v1", 1, [vclip("a", "a.mp4", 0, 300)]),
    vtrack("v2", 0, [
      vclip("logo", "logo.png", 0, 300, {
        kind: "image",
        transform: { position: { x: 0.82, y: 0.1 }, scale: 0.2 },
      }),
    ]),
  ]);

const sidewaysSeed = () =>
  timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300, { rotate: 90 })])], LANDSCAPE);

const lateVoiceSeed = () =>
  timeline(
    [
      vtrack("v1", 0, [vclip("talk", "talk.mp4", 0, 300)]),
      // The sound of the same take, 9 frames (0.3 s) behind its picture, and not linked to it.
      atrack("a1", 0, [aclip("talkAud", "talk.mp4", 9, 309, { source_in: 0, source_out: 300 })]),
    ],
    LANDSCAPE,
  );

const doubledIntroSeed = () =>
  timeline([
    vtrack("v1", 0, [
      vclip("intro", "intro.mp4", 0, 90),
      vclip("intro2", "intro.mp4", 90, 180),
      vclip("main", "main.mp4", 180, 480),
    ]),
  ]);

const typoSeed = () =>
  timeline([
    vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
    ttrack("t1", 1, [
      {
        id: "title",
        kind: "text",
        timeline_in: 0,
        timeline_out: 90,
        content: [{ text: "Sumer Trip 2026" }],
        style: { size: "m" },
      },
    ]),
  ]);

const threeClipSeed = () =>
  timeline([
    vtrack("v1", 0, [
      vclip("a", "a.mp4", 0, 120),
      vclip("b", "b.mp4", 120, 240),
      vclip("c", "c.mp4", 240, 360),
    ]),
  ]);

const threeShotsSeed = () =>
  timeline([
    vtrack("v1", 0, [
      vclip("beach", "beach.mp4", 0, 90),
      vclip("city", "city.mp4", 90, 180),
      vclip("forest", "forest.mp4", 180, 270),
    ]),
  ]);

const twoShotsSeed = () =>
  timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 150), vclip("b", "b.mp4", 150, 300)])]);

const twelveSecondSeed = () => timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 360)])]);

const readyToExportSeed = () =>
  timeline(
    [vtrack("v1", 0, [vclip("a", "a.mp4", 0, 150), vclip("b", "b.mp4", 150, 300)])],
    LANDSCAPE,
  );

const voiceAndMusicSeed = (music: Partial<Track> = {}) =>
  timeline(
    [
      vtrack("v1", 0, [vclip("talk", "talk.mp4", 0, 300, { link_group: "lg_talk" })]),
      atrack("a1", 0, [aclip("talkAud", "talk.mp4", 0, 300, { link_group: "lg_talk" })]),
      { ...atrack("a2", 1, [aclip("music", "music.mp3", 0, 300, { volume: 0.3 })]), ...music },
    ],
    LANDSCAPE,
  );

const tenSecondSeed = () => timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])]);

const READ: ReferenceStep = { calls: [["get_timeline", {}]] };

// ── the cases ────────────────────────────────────────────────────────────────

export const COMPLAINT_SCENARIOS: Scenario[] = [
  // ── right: the problem was in the project before the edit it is blamed on ─────
  {
    id: "complaint_silent_after_trim",
    title: "No sound after a trim: the voice track was muted all along",
    tags: [...TAGS, "clips:2", "complaint:right", "cause:seed"],
    surface: "studio",
    seed: mutedVoiceSeed,
    prompt: "Trim the end off so the video finishes at the 8 second mark.",
    followUps: ["Ever since that change I can't hear anything when I play it."],
    // Moving the sound to a track that plays is as good as unmuting its own.
    scope: { change: ["talk", "talkAud"], tracks: ["a1"], addTracks: true },
    expectTools: ["set_track", "set_tracks"],
    maxRounds: 14,
    expect: (final) => {
      const talk = clipById(final, "talk");
      const voice = clipById(final, "talkAud");
      assert(talk && voice, "the clip or its sound is gone");
      near(Number(talk.timeline_out), 240, 3, "where the clip ends (8 s)");
      // The trim did not silence it, so the trim stays; the muted track is what has to change.
      assert(heard(final, "talkAud"), "the voice still makes no sound (its track is muted)");
      const trimmed = ["timeline_out", "source_out"];
      clipAsSeeded(final, mutedVoiceSeed, "talk", "the picture, apart from its end,", trimmed);
      clipAsSeeded(final, mutedVoiceSeed, "talkAud", "the voice, apart from its end,", trimmed);
      near(Number(voice.timeline_out), Number(talk.timeline_out), 2, "where its sound ends");
      const copies = allClips(final).filter((c) => c.kind === "audio");
      assert(copies.length === 1, `the voice is on the timeline ${copies.length} times`);
    },
    reference: [
      READ,
      { calls: [["set_clip_properties", { clip_ids: ["talk"], duration: 240 }]] },
      { text: "Done: the video now ends at 8 seconds, and its sound ends with it." },
      READ,
      { calls: [["set_track", { track_id: "a1", mute: false }]] },
      {
        text: "The trim was not the cause: the audio track (a1) was muted. I turned the mute off, so the voice plays again.",
      },
    ],
  },
  {
    id: "complaint_black_hidden_track",
    title: "Black picture under a new title: the footage track was hidden",
    tags: [...TAGS, "clips:1", "complaint:right", "cause:seed"],
    surface: "studio",
    seed: hiddenFootageSeed,
    prompt: "Put the title 'Launch day' over the first three seconds.",
    followUps: ["Why is the video black? All I can see is the title."],
    // Moving the footage to a track that draws is as good as showing its own track again.
    scope: { change: ["a"], tracks: ["v1"], add: ["text"], addTracks: true },
    expectTools: ["set_track", "set_tracks"],
    maxRounds: 14,
    expect: (final) => {
      titleAtStart(final, "Launch day", 90);
      clipAsSeeded(final, hiddenFootageSeed, "a", "the footage");
      assert(drawn(final, "a"), "the footage is still not drawn (its track is hidden)");
    },
    reference: [
      READ,
      {
        calls: [
          [
            "add_text_clips",
            { entries: [{ timeline_in: 0, timeline_out: 90, content: "Launch day" }] },
          ],
        ],
      },
      { text: "Added 'Launch day' over the first three seconds." },
      { calls: [["inspect_timeline", { start_frame: 30 }]] },
      { calls: [["set_track", { track_id: "v1", hidden: false }]] },
      {
        text: "The title was not the cause: the footage's track (v1) was hidden, so only the title was drawn. I made the track visible again.",
      },
    ],
  },
  {
    id: "complaint_logo_under_footage",
    title: "A logo made bigger is still unseen: its track sits under the footage",
    tags: [...TAGS, "clips:2", "complaint:right", "cause:seed"],
    surface: "studio",
    seed: logoUnderFootageSeed,
    prompt: "Make the logo a bit bigger.",
    followUps: ["I still can't see the logo anywhere."],
    // Restacking the tracks, lifting the logo onto a track above, or putting the footage on one
    // below all bring the logo out; the footage itself must stay as it is.
    scope: { change: ["logo", "a"], tracks: ["v1", "v2"], addTracks: true },
    expectTools: ["set_tracks", "set_track", "move_clips"],
    maxRounds: 14,
    expect: (final) => {
      const logo = clipById(final, "logo");
      assert(logo, "the logo is gone");
      const size = scaleOf(logo);
      assert(size > 0.205, `the logo is not bigger than before (scale ${size}, was 0.2)`);
      clipAsSeeded(final, logoUnderFootageSeed, "a", "the footage");
      assert(drawn(final, "a"), "the footage no longer shows");
      assert(drawn(final, "logo"), "the logo is not drawn at all");
      const order = visibleTracks(final);
      const logoAt = order.indexOf(trackHolding(final, "logo")!);
      const footageAt = order.indexOf(trackHolding(final, "a")!);
      assert(logoAt > footageAt, "the logo is still drawn underneath the full-frame footage");
    },
    reference: [
      READ,
      {
        calls: [
          [
            "set_clip_properties",
            { clip_ids: ["logo"], transform: { position: { x: 0.82, y: 0.1 }, scale: 0.3 } },
          ],
        ],
      },
      { text: "The logo is half as big again (scale 0.3), in the same corner." },
      { calls: [["inspect_timeline", { start_frame: 60 }]] },
      { calls: [["set_tracks", { tracks: [{ track_id: "v2", z: 2 }] }]] },
      {
        text: "The logo's track sat underneath the full-frame footage, so the footage covered it. I moved that track to the top: the logo shows in the top-right corner now.",
      },
    ],
  },
  {
    id: "complaint_video_sideways",
    title: "Sideways picture after a fade: the clip carried an extra quarter turn",
    tags: [...TAGS, "clips:1", "complaint:right", "cause:seed"],
    surface: "studio",
    seed: sidewaysSeed,
    prompt: "Give it a one second fade-in at the start.",
    followUps: ["Why is my whole video lying on its side?"],
    scope: { change: ["a"] },
    expectTools: ["set_clip_properties"],
    maxRounds: 14,
    expect: (final) => {
      const a = clipById(final, "a");
      assert(a, "the clip is gone");
      assert(fadesIn(a, 30), "the clip does not fade in over its first second");
      const rotate = a.rotate ?? 0;
      assert(
        typeof rotate === "number" && ((rotate % 360) + 360) % 360 === 0,
        `the picture is still turned (rotate ${JSON.stringify(rotate)})`,
      );
      assert(!a.flip?.h && !a.flip?.v, "the picture is mirrored, not turned upright");
      clipAsSeeded(final, sidewaysSeed, "a", "the clip, apart from its turn and fade,", [
        "rotate",
        "fade",
        "opacity",
      ]);
    },
    reference: [
      READ,
      { calls: [["set_clip_properties", { clip_ids: ["a"], fade: { in: 30 } }]] },
      { text: "Added a one second fade-in at the start." },
      { calls: [["set_clip_properties", { clip_ids: ["a"], rotate: 0 }]] },
      {
        text: "The fade did not turn it: the clip had an extra 90 degree rotation set on it. I set that back to 0, so it plays upright.",
      },
    ],
  },
  {
    id: "complaint_voice_late",
    title: "Voice behind the lips after a title: the sound sat 9 frames late",
    tags: [...TAGS, "clips:2", "complaint:right", "cause:seed"],
    surface: "studio",
    seed: lateVoiceSeed,
    prompt: "Put the title 'Interview' on screen for the first two seconds.",
    followUps: ["The voice doesn't match the lips, it comes in a little late."],
    // Linking the two after lining them up stamps the picture too.
    scope: { change: ["talk", "talkAud"], add: ["text"], addTracks: true },
    expectTools: ["move_clips", "link_clips"],
    maxRounds: 14,
    expect: (final) => {
      titleAtStart(final, "Interview", 60);
      const talk = clipById(final, "talk");
      const voice = clipById(final, "talkAud");
      assert(talk && voice, "the picture or its sound is gone");
      // The picture stays where it was: sliding it to meet the sound leaves black at the start.
      near(Number(talk.timeline_in), 0, 0, "where the picture starts");
      near(span(talk), 300, 1, "the picture's length");
      near(Number(talk.source_in ?? 0), 0, 0, "the picture's first frame");
      // In sync: at every frame both play the same moment of the take.
      const offset = (c: Clip) => Number(c.timeline_in) - Number(c.source_in ?? 0);
      near(offset(voice), offset(talk), 1, "the sound's offset from its picture (frames)");
      near(Number(voice.timeline_in), 0, 2, "where the sound starts");
      near(Number(voice.timeline_out), 300, 2, "where the sound ends");
      assert(heard(final, "talkAud"), "the voice no longer plays");
      clipAsSeeded(final, lateVoiceSeed, "talk", "the picture", ["link_group"]);
      clipAsSeeded(final, lateVoiceSeed, "talkAud", "the sound, apart from its timing,", [
        "timeline_in",
        "timeline_out",
        "source_in",
        "source_out",
        "link_group",
      ]);
    },
    reference: [
      READ,
      {
        calls: [
          [
            "add_text_clips",
            { entries: [{ timeline_in: 0, timeline_out: 60, content: "Interview" }] },
          ],
        ],
      },
      { text: "Added 'Interview' for the first two seconds." },
      { calls: [["move_clips", { moves: [{ clip_id: "talkAud", to_timeline_in: 0 }] }]] },
      { calls: [["link_clips", { clip_ids: ["talk", "talkAud"] }]] },
      {
        text: "The title did not move anything: the sound sat 9 frames (0.3 s) after its picture. I lined it up with the picture and linked the two so they stay together.",
      },
    ],
  },
  {
    id: "complaint_intro_plays_twice",
    title: "The intro plays twice after a crossfade: the intro was placed twice",
    tags: [...TAGS, "clips:3", "complaint:right", "cause:seed"],
    surface: "studio",
    seed: doubledIntroSeed,
    prompt: "Add a short crossfade between the intro and the main part.",
    followUps: ["Why does the intro play twice now?"],
    // Either copy of the intro may be the one that goes.
    scope: { change: ["intro", "intro2", "main"], remove: ["intro", "intro2"] },
    expectTools: ["ripple_delete", "remove_clips"],
    maxRounds: 14,
    expect: (final) => {
      const v1 = clipsOf(final, "v1");
      const intros = v1.filter((c) => c.media_ref === "intro.mp4");
      assert(intros.length === 1, `the intro is on the timeline ${intros.length} times`);
      near(span(intros[0]), 90, 2, "the intro's length");
      const main = clipById(final, "main");
      assert(main, "the main part is gone");
      near(span(main), 300, 2, "the main part's length");
      assert(v1.length === 2, `expected the intro and the main part, found ${v1.length} clips`);
      assert(contiguousFrom(final, "v1", 0, 1), "a gap is left where the second intro was");
      near(Number(main.timeline_in), Number(intros[0].timeline_out), 1, "the main part follows");
      assert(
        main.transition_in?.kind === "crossfade" && Number(main.transition_in.duration) > 0,
        `no crossfade into the main part (${JSON.stringify(main.transition_in ?? null)})`,
      );
      const moved = ["timeline_in", "timeline_out"];
      clipAsSeeded(
        final,
        doubledIntroSeed,
        "main",
        "the main part, apart from its place and crossfade,",
        [...moved, "transition_in"],
      );
      clipAsSeeded(
        final,
        doubledIntroSeed,
        String(intros[0].id),
        "the intro, apart from its place,",
        moved,
      );
    },
    reference: [
      READ,
      {
        calls: [
          [
            "set_transition",
            { clip_id: "main", transition_in: { kind: "crossfade", duration: 15 } },
          ],
        ],
      },
      { text: "Added a half-second crossfade into the main part." },
      { calls: [["ripple_delete", { track_id: "v1", start: 90, end: 180 }]] },
      {
        text: "The intro was on the timeline twice, back to back, from before the crossfade. I removed the second copy and closed the gap; the crossfade into the main part is still there.",
      },
    ],
  },
  {
    id: "complaint_title_misspelled",
    title: "A misspelled title is fixed in place, keeping the size just asked for",
    tags: [...TAGS, "clips:2", "complaint:right", "cause:seed"],
    surface: "studio",
    seed: typoSeed,
    prompt: "Make the title bigger.",
    followUps: ["You spelled it wrong. It should say Summer Trip 2026."],
    // Rewording it in place is the tool's job; a replacement that reads and looks the same passes.
    scope: { change: ["title"], remove: ["title"], add: ["text"] },
    expectTools: ["update_text"],
    maxRounds: 12,
    expect: (final) => {
      const t = theTitle(final, "Summer Trip 2026");
      near(Number(t.timeline_in), 0, 2, "where the title starts");
      near(Number(t.timeline_out), 90, 3, "where the title ends");
      const was = 1920 * 0.06; // the seed's size "m" on this canvas
      const now = typeSize(t, Number(final.canvas?.height) || 1920);
      assert(now > was * 1.05, `the title is no bigger than before (${Math.round(now)} px)`);
    },
    reference: [
      READ,
      { calls: [["update_text", { clip_ids: ["title"], style: { size: "l" } }]] },
      { text: "The title is bigger now." },
      { calls: [["update_text", { clip_ids: ["title"], content: "Summer Trip 2026" }]] },
      { text: "Fixed: it reads 'Summer Trip 2026', at the bigger size." },
    ],
  },

  // ── right: the first turn itself left the problem (or the complaint is mistaken) ──
  {
    id: "complaint_gap_after_delete",
    title: "A deleted clip leaves a black gap the person then complains about",
    tags: [...TAGS, "clips:3", "complaint:right", "cause:first-turn"],
    surface: "studio",
    seed: threeClipSeed,
    // "Delete" alone does not say to close up: a plain delete leaves the gap, and the complaint
    // is then right. A delete that closed up already makes the complaint mistaken; either way the
    // run must end with the gap closed and nothing else moved.
    prompt: "Delete the second clip.",
    followUps: ["Now there's a black gap in the middle of my video."],
    scope: { remove: ["b"], change: ["c"] },
    expectTools: ["ripple_delete", "move_clips"],
    maxRounds: 12,
    expect: (final) => {
      assert(!clipById(final, "b"), "the second clip is still there");
      assert(contiguousFrom(final, "v1", 0, 1), "there is still a gap in the picture");
      const v1 = clipsOf(final, "v1");
      assert(
        v1.length === 2,
        `expected the first and third clips, found ${JSON.stringify(v1.map((c) => c.id))}`,
      );
      const c = clipById(final, "c");
      assert(c, "the third clip is gone");
      near(span(c), 120, 1, "the third clip's length");
      near(Number(c.timeline_in), 120, 1, "where the third clip starts");
      clipAsSeeded(final, threeClipSeed, "c", "the third clip, apart from its place,", [
        "timeline_in",
        "timeline_out",
      ]);
    },
    reference: [
      READ,
      { calls: [["remove_clips", { clip_ids: ["b"] }]] },
      { text: "Deleted the second clip." },
      { calls: [["move_clips", { moves: [{ clip_id: "c", to_timeline_in: 120 }] }]] },
      {
        text: "You're right: deleting it left four seconds of nothing where it was. I moved the last clip up to close the gap.",
      },
    ],
  },
  {
    id: "complaint_wrong_clip_graded",
    title: "Black and white went on the wrong shot: move it, and give the first its colour back",
    tags: [...TAGS, "clips:3", "complaint:right", "cause:first-turn"],
    surface: "studio",
    seed: threeShotsSeed,
    prompt: "Make the city shot black and white.",
    followUps: [
      "That's the wrong one! I wanted the forest shot in black and white. Put the city back in colour.",
    ],
    scope: { change: ["city", "forest"] },
    expectTools: ["apply_color"],
    maxRounds: 12,
    expect: (final) => {
      const forest = saturation(clipById(final, "forest"));
      assert(forest <= 0.15, `the forest shot is not black and white (saturation ${forest})`);
      const city = saturation(clipById(final, "city"));
      assert(city >= 0.85, `the city shot is not back in colour (saturation ${city})`);
    },
    reference: [
      READ,
      { calls: [["apply_color", { clip_ids: ["city"], saturation: 0 }]] },
      { text: "The city shot is black and white now." },
      { calls: [["apply_color", { clip_ids: ["city"], reset: true }]] },
      { calls: [["apply_color", { clip_ids: ["forest"], saturation: 0 }]] },
      { text: "Switched: the city shot is back in colour and the forest shot is black and white." },
    ],
  },
  {
    id: "complaint_undo_the_look",
    title: "A disliked look is taken back completely, not partly",
    tags: [...TAGS, "clips:2", "complaint:right", "cause:first-turn"],
    surface: "studio",
    seed: twoShotsSeed,
    prompt: "Make it look more cinematic.",
    followUps: ["No, I don't like that at all. Put it back exactly the way it was."],
    // Whatever the look changed, every bit of it has to go: the end state is the seed (an empty
    // track left behind changes nothing anyone sees or hears).
    scope: { addTracks: true },
    expectTools: ["undo"],
    maxRounds: 16,
    expect: (final) => sameAs(twoShotsSeed, final),
    // ...after something was changed: a look never made leaves nothing to put back.
    expectTrace: (t) => {
      const made = t.toolCalls.some((c) => isEdit(c) && c.name !== "undo" && c.name !== "redo");
      assert(made, "no look was ever applied, so there was nothing to put back");
    },
    reference: [
      READ,
      {
        calls: [
          [
            "apply_color",
            { clip_ids: ["a", "b"], contrast: 1.2, saturation: 0.85, temperature: 5800 },
          ],
        ],
      },
      {
        calls: [
          ["set_transition", { clip_id: "b", transition_in: { kind: "crossfade", duration: 20 } }],
        ],
      },
      { text: "Gave both shots a cooler, higher-contrast grade and a slow dissolve between them." },
      { calls: [["undo", {}]] },
      { calls: [["undo", {}]] },
      { text: "Put back: both changes are undone, so the shots are exactly as they were." },
    ],
  },

  // ── mistaken: the edit is right and the person is looking at something else ───
  {
    id: "complaint_library_still_long",
    title: "'Nothing happened': the cut is on the timeline, the library file keeps its length",
    tags: [...TAGS, "clips:1", "complaint:mistaken"],
    surface: "studio",
    seed: twelveSecondSeed,
    prompt: "Cut this down to just the first four seconds.",
    followUps: ["Nothing happened. The video in my library is still 12 seconds long."],
    // Editing never rewrites the source file, and making a new file is not what was asked.
    mustNotCall: ["run_ffmpeg", "export"],
    scope: { change: ["a"], remove: ["a"], add: ["video"] },
    expectTools: ["set_clip_properties"],
    maxRounds: 12,
    expect: (final) => {
      const kept = allClips(final).filter((c) => c.media_ref === "a.mp4" && c.kind !== "audio");
      assert(kept.length === 1, `expected one clip of the footage, found ${kept.length}`);
      const [a] = kept;
      near(Number(a.timeline_in), 0, 1, "where the clip starts");
      near(span(a), 120, 3, "the clip's length (four seconds)");
      near(Number(a.source_in ?? 0), 0, 1, "the clip's first frame (the footage's first)");
      if (a.id === "a")
        clipAsSeeded(final, twelveSecondSeed, "a", "the clip, apart from its end,", [
          "timeline_out",
          "source_out",
        ]);
    },
    reference: [
      READ,
      { calls: [["set_clip_properties", { clip_ids: ["a"], duration: 120 }]] },
      { text: "Cut it down to the first four seconds." },
      READ,
      {
        text: "The cut is there: on your timeline the clip now runs 4 seconds. Editing never changes the file itself, so the library still shows the full 12-second original; your video uses only its first four.",
      },
    ],
  },
  {
    id: "complaint_export_not_failed",
    title: "'The export failed': it is still rendering, so check, say so, and do not export again",
    tags: [...TAGS, "clips:2", "complaint:mistaken"],
    surface: "journey",
    seed: readyToExportSeed,
    prompt: "Export the video.",
    followUps: ["The export failed, there's nothing in my Downloads folder."],
    scope: {},
    expectTools: ["export", "manage_exports"],
    maxRounds: 10,
    expectTrace: (t) => {
      const n = renders(t).length;
      assert(n > 0, "never exported");
      assert(n === 1, `exported ${n} times: a second render while the first still runs`);
      assert(
        !t.toolCalls.some((c) => c.name === "manage_exports" && c.args?.action === "cancel"),
        "cancelled the export the person is waiting for",
      );
      // Only the export list can say how a render is doing; answering from memory is a guess.
      const looked = complaintCalls(t).some(
        (c) => c.ok && c.name === "manage_exports" && (c.args?.action ?? "list") === "list",
      );
      assert(looked, "answered the complaint without checking the export");
      assert(
        STILL_GOING.test(t.finalText),
        "the reply does not say the export is still running, which is what the check showed",
      );
    },
    reference: [
      { calls: [["export", {}]] },
      {
        text: "Your export has started. The file is saved to your Downloads folder when it finishes.",
      },
      { calls: [["manage_exports", { action: "list" }]] },
      {
        text: "It has not failed: the export is still in progress, so the file is not in Downloads yet. It is saved there when the render finishes.",
      },
    ],
  },
  {
    id: "complaint_no_sound_but_there_is",
    title: "'No sound at all' after lowering the music: nothing is silent, so nothing is changed",
    tags: [...TAGS, "clips:3", "complaint:mistaken"],
    surface: "studio",
    seed: () => voiceAndMusicSeed(),
    prompt: "Turn the music down a little more.",
    followUps: ["Now there's no sound at all!"],
    // Re-stating a track's mute as off changes nothing a person hears, so it is allowed; what
    // the tracks do is checked below.
    scope: { change: ["music"], tracks: ["a1", "a2"] },
    expectTools: ["set_clip_properties", "inspect_media"],
    maxRounds: 12,
    expect: (final) => {
      const music = clipById(final, "music");
      assert(music, "the music is gone");
      const level = peakOf(music.volume);
      assert(level < 0.29, `the music was not turned down (volume ${level}, was 0.3)`);
      assert(level > 0.02, `the music was silenced, not turned down (volume ${level})`);
      assert(heard(final, "music"), "the music no longer plays");
      assert(heard(final, "talkAud"), "the voice no longer plays");
      clipAsSeeded(final, voiceAndMusicSeed, "music", "the music, apart from its level,", [
        "volume",
      ]);
    },
    reference: [
      READ,
      { calls: [["set_clip_properties", { clip_ids: ["music"], volume: 0.2 }]] },
      { text: "The music is a little lower now." },
      READ,
      { calls: [["inspect_media", { clip_id: "talkAud" }]] },
      {
        text: "Nothing in the project is silent: no track is muted, the voice plays at full level (about -18 LUFS) and the music at 20%. If you hear nothing at all, check the preview's volume and your computer's sound output.",
      },
    ],
  },

  // ── cannot be done by the agent: say what it is and how to change it ──────────
  {
    id: "complaint_voice_drowned_by_solo",
    title: "Only the music is heard: its track is soloed, which only the person can switch off",
    tags: [...TAGS, "clips:3", "complaint:cannot"],
    surface: "studio",
    // The person soloed the music track, and no tool can switch solo off.
    seed: () => voiceAndMusicSeed({ solo: true }),
    prompt: "Fade the music out over the last two seconds.",
    followUps: ["Why can't I hear my voice anymore? I only hear the music."],
    // Muting the music, or rebuilding its track, would bring the voice back by losing the music.
    scope: { change: ["music"], tracks: ["a1"] },
    // One refused try at switching solo off: the tools cannot, and the case is about saying so.
    maxToolErrors: 1,
    expectTools: ["get_timeline"],
    maxRounds: 12,
    expect: (final) => {
      const music = clipById(final, "music");
      assert(music, "the music is gone");
      assert(fadesOut(music, 60), "the music does not fade out over the last two seconds");
      near(peakOf(music.volume), 0.3, 0.01, "the music's level");
      assert(heard(final, "music"), "the music no longer plays (muted to bring the voice back)");
      clipAsSeeded(final, voiceAndMusicSeed, "music", "the music, apart from its fade,", [
        "fade",
        "volume",
      ]);
    },
    expectTrace: (t) =>
      assert(
        NAMES_SOLO.test(t.finalText),
        "the reply does not say the music track is soloed, the reason the voice is not heard",
      ),
    reference: [
      READ,
      { calls: [["set_clip_properties", { clip_ids: ["music"], fade: { out: 60 } }]] },
      { text: "The music now fades out over the last two seconds." },
      READ,
      {
        text: "Your voice is still there and not muted. The music track (a2) is soloed, so only it plays. I can't switch solo off from here: click the solo button on that track and you'll hear both again.",
      },
    ],
  },

  // ── "you didn't do it": check before doing it again ───────────────────────────
  {
    id: "complaint_title_not_added",
    title: "'You didn't add the title': check, and never leave two",
    tags: [...TAGS, "clips:1", "complaint:mistaken", "duplicate"],
    surface: "studio",
    seed: tenSecondSeed,
    prompt: "Cut this to five seconds and put the title 'Ocean' on it.",
    followUps: ["You didn't add the title."],
    scope: { change: ["a"], add: ["text"], addTracks: true },
    expectTools: ["add_text_clips", "get_timeline"],
    maxRounds: 12,
    expect: (final) => {
      const a = clipById(final, "a");
      assert(a, "the clip is gone");
      near(span(a), 150, 3, "the clip's length (five seconds)");
      clipAsSeeded(final, tenSecondSeed, "a", "the clip, apart from its end,", [
        "timeline_out",
        "source_out",
      ]);
      const t = theTitle(final, "Ocean");
      assert(
        Number(t.timeline_in) < 150 && Number(t.timeline_out) > 0,
        "the title is not on the clip",
      );
      assert(
        Number(t.timeline_out) <= 153,
        `the title runs on past the clip (to frame ${t.timeline_out})`,
      );
    },
    reference: [
      READ,
      { calls: [["set_clip_properties", { clip_ids: ["a"], duration: 150 }]] },
      {
        calls: [
          [
            "add_text_clips",
            { entries: [{ timeline_in: 0, timeline_out: 150, content: "Ocean" }] },
          ],
        ],
      },
      { text: "Cut it to five seconds and put 'Ocean' over it." },
      READ,
      {
        text: "It is there: the title 'Ocean' runs over the whole clip, from 0 to 5 seconds, on a text track above the video. If you don't see it, check that the playhead is inside those five seconds.",
      },
    ],
  },
];
