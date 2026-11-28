// Cases for two gaps of the eval coverage report (art-daddy/backlog#42):
//   - files attached to a chat message ("use this", a logo, a reference to match, a file the app
//     cannot use, several at once): tagged gap:attachments;
//   - the timeline changed by hand between two turns, and @mentions of a clip, a range, a gap, the
//     playhead or a library item: tagged gap:outside-change-mentions.
//
// Each message reaches the model as the app builds it (eval/turns.ts, with the app's own
// agent/compose.ts): an attached file is named by what its import returned, so a file linked by the
// desktop attach button shows its full path, which the agent's tools refuse (tools/store.ts
// isUnsafeAgentRef), and a pasted one shows library/<id><ext>; an @mention is the composer's
// editor-context block; a change made by hand between two turns is made through the editor's own
// commit path, and the next message says so. The composer offers no @mention of a track
// (timeline/mentionOptions.ts): a clip mention names its track.
//
// Checks read the end result. Nothing here grades taste or the exact words of a reply; where a
// reply is the whole job (a file that never arrived), only its plain meaning is checked.
import { footageClip, type Footage, type FootageClip } from "../footage";
import type { Clip, Timeline } from "../../timeline/model";
import {
  buildClipMention,
  buildGapMention,
  buildMediaMention,
  buildPlayheadMention,
  buildRangeMention,
} from "../../timeline/mentions";
import type { ReferenceCalls, ReferenceStep } from "../reference";
import type { InferenceRequest } from "../harness";
import type { Scenario, Trace } from "../types";
import {
  aclip,
  allClips,
  assert,
  atrack,
  clipById,
  clipsOf,
  near,
  span,
  timeline,
  vclip,
  vtrack,
} from "./helpers";

const FPS = 30;
const LANDSCAPE = { width: 1920, height: 1080, fps: FPS };

// ── our own media (invented; no person's file) ───────────────────────────────

const shot = (shows: string, seconds: number) => [{ from: 0, to: seconds, shows }];

const TALK: FootageClip = {
  media_ref: "media_3c9e0a7b51d2",
  filename: "studio_talk.mp4",
  kind: "video",
  duration_s: 10,
  audio: true,
  shots: shot("a person talking to the camera in a bright studio", 10),
};
const BEACH: FootageClip = {
  media_ref: "media_8a41f2c6d0e9",
  filename: "beach_walk.mp4",
  kind: "video",
  duration_s: 5,
  audio: true,
  shots: shot("a person walking along a beach at golden hour", 5),
};
const CITY: FootageClip = {
  media_ref: "media_b07d3e9a2c14",
  filename: "city_night.mp4",
  kind: "video",
  duration_s: 10,
  audio: true,
  shots: shot("traffic streaming through a city street at night", 10),
};
/** Linked by the desktop attach button: the message names it by this path. */
const DRONE: FootageClip = {
  media_ref: "media_5e2b8c1f9a07",
  filename: "sunset_drone.mp4",
  kind: "video",
  duration_s: 6,
  audio: false,
  path: "D:/Footage/sunset_drone.mp4",
  shots: shot("an aerial shot gliding over a coastline at sunset", 6),
};
/** Pasted: copied into the project, named library/<id>. An image's id carries its extension. */
const TITLE_CARD: FootageClip = {
  media_ref: "media_c41a9e7d2b68.png",
  filename: "title_card.png",
  kind: "image",
  width: 1920,
  height: 1080,
  shots: shot("white letters reading 'Summer Notes' on a plain blue background", 1),
};
const LOGO: FootageClip = {
  media_ref: "media_e93b0d5a7c21.png",
  filename: "brand_logo.png",
  kind: "image",
  width: 800,
  height: 400,
  shots: shot("a white wordmark on a transparent background", 1),
};
const SONG: FootageClip = {
  media_ref: "media_7f2a6c0e8b35",
  filename: "calm_piano.mp3",
  kind: "audio",
  duration_s: 60,
  path: "D:/Music/calm_piano.mp3",
  sound: "a slow solo piano piece, no voice",
};
/** Four photos attached together, in an order that is NOT their alphabetical one. */
const PHOTOS: FootageClip[] = [
  ["media_1d4f7a2c9e30.jpg", "harbour.jpg", "fishing boats moored in a small harbour"],
  ["media_6b8e0c3a5f12.jpg", "castle.jpg", "a stone castle on a green hill"],
  ["media_9c2a4e6b8d01.jpg", "market.jpg", "fruit stalls in a busy street market"],
  ["media_0e7c5a3f1b94.jpg", "bridge.jpg", "an old stone bridge over a river"],
].map(([media_ref, filename, shows]) => ({
  media_ref,
  filename,
  kind: "image" as const,
  width: 4032,
  height: 3024,
  path: `D:/Photos/Trip/${filename}`,
  shots: shot(shows, 1),
}));
const BTS: FootageClip = {
  media_ref: "media_2a9d6f1c7e43",
  filename: "behind_the_scenes.mp4",
  kind: "video",
  duration_s: 4,
  audio: false,
  path: "D:/Footage/behind_the_scenes.mp4",
  shots: shot("a crew setting up lights on a small set", 4),
};
const LOOP: FootageClip = {
  media_ref: "media_d5c8b2e0a961",
  filename: "upbeat_loop.mp3",
  kind: "audio",
  duration_s: 30,
  path: "D:/Music/upbeat_loop.mp3",
  sound: "an upbeat electronic loop, no voice",
};
/** Pasted video. */
const STREET: FootageClip = {
  media_ref: "media_f0a3e7c2d856",
  filename: "street_food.mp4",
  kind: "video",
  duration_s: 5,
  audio: false,
  shots: shot("a cook flipping noodles in a wok at a street stall", 5),
};
const OLD_TAKE: FootageClip = {
  media_ref: "media_47b1e9d3c0a2",
  filename: "old_take.mp4",
  kind: "video",
  duration_s: 5,
  audio: true,
  shots: shot("a person talking to the camera, slightly out of focus", 5),
};
const POSTER: FootageClip = {
  media_ref: "media_a8e2c6f4b017.jpg",
  filename: "concert_poster.jpg",
  kind: "image",
  width: 1080,
  height: 1350,
  shots: shot("a printed poster for a jazz concert with a saxophone drawing", 1),
};
/** A portrait still in a shape no canvas preset has (4:5). */
const REFERENCE_POST: FootageClip = {
  media_ref: "media_5b0e8d2a6c39.jpg",
  filename: "reference_post.jpg",
  kind: "image",
  width: 1080,
  height: 1350,
  path: "D:/Downloads/reference_post.jpg",
  shots: shot("a portrait photo of a coffee cup on a wooden table", 1),
};
const TAKE_ONE: FootageClip = {
  media_ref: "media_6e1c9a4f2b78",
  filename: "interview_take1.mp4",
  kind: "video",
  duration_s: 5,
  audio: false,
  shots: shot("a person answering a question, looking away from the camera", 5),
};
const TAKE_TWO: FootageClip = {
  media_ref: "media_93f7b0d1e5a4",
  filename: "interview_take2.mp4",
  kind: "video",
  duration_s: 5,
  audio: false,
  path: "D:/Footage/interview_take2.mp4",
  shots: shot("the same person answering the same question, looking into the camera", 5),
};
const HARBOUR: FootageClip = {
  media_ref: "media_c3a7e1f9b240",
  filename: "harbour_timelapse.mp4",
  kind: "video",
  duration_s: 8,
  audio: false,
  path: "D:/Footage/harbour_timelapse.mp4",
  shots: shot("a timelapse of boats leaving a harbour at dawn", 8),
};

const footage = (...clips: FootageClip[]): Footage => ({ clips });
const wide = (tracks: Parameters<typeof timeline>[0]) => timeline(tracks, LANDSCAPE);
/** A whole footage file placed on the timeline: `frames` long from `at`. */
const placed = (id: string, c: FootageClip, at: number, frames: number) =>
  vclip(id, c.media_ref, at, at + frames, c.kind === "image" ? { kind: "image" } : {});

// ── readers and checks ──────────────────────────────────────────────────────

/** The clips that play footage file `c`, by any name the tools may have stored for it. */
function playing(final: Timeline, lib: Footage, c: FootageClip): Clip[] {
  return allClips(final).filter(
    (x) => footageClip(lib, String(x.media_ref ?? ""))?.media_ref === c.media_ref,
  );
}
function onePlaying(final: Timeline, lib: Footage, c: FootageClip, what: string): Clip {
  const hits = playing(final, lib, c).filter((x) => x.kind !== "audio" || c.kind === "audio");
  assert(hits.length > 0, `${what} (${c.filename}) is not on the timeline`);
  assert(hits.length === 1, `${what} (${c.filename}) is on the timeline ${hits.length} times`);
  return hits[0];
}
const at = (c: Clip | undefined): number => Number(c?.timeline_in);
const end = (c: Clip | undefined): number => Number(c?.timeline_out);
function trackOfClip(tl: Timeline, id: string) {
  return (tl.tracks ?? []).find((t) => (t.clips ?? []).some((c) => c.id === id));
}
function textOf(c: { text?: unknown; content?: unknown }): string {
  if (typeof c.text === "string") return c.text;
  if (typeof c.content === "string") return c.content;
  if (Array.isArray(c.content))
    return c.content.map((x) => String((x as { text?: unknown })?.text ?? "")).join(" ");
  return "";
}
/** A fade-in of about `frames`: the fade field, or an opacity ramp from near 0 to near 1. */
function fadeInOf(c: Clip | undefined): number | null {
  const fade = (c as { fade?: { in?: unknown } } | undefined)?.fade;
  if (fade?.in != null && Number(fade.in) > 0) return Number(fade.in);
  const opa = (c as { opacity?: unknown } | undefined)?.opacity;
  if (!Array.isArray(opa) || opa.length < 2) return null;
  const pts = [...(opa as { t: number; v: number }[])].sort((a, b) => a.t - b.t);
  const full = pts.find((k) => Number(k.v) >= 0.8);
  if (Number(pts[0].v) > 0.2 || !full) return null;
  return Number(full.t) - Number(pts[0].t);
}
function saturationOf(c: Clip | undefined): number {
  const v = (c as { color?: { saturation?: unknown } } | undefined)?.color?.saturation;
  return v === undefined ? 1 : Number(v);
}
/** The seed's tracks, unchanged: what a request that must change nothing leaves behind. */
function untouched(seed: () => Timeline) {
  return (final: Timeline) => {
    if (JSON.stringify(seed().tracks) !== JSON.stringify(final.tracks))
      throw new Error("the timeline changed; nothing should have been edited");
  };
}
const called = (t: Trace, name: string) => t.toolCalls.filter((c) => c.ok && c.name === name);

/** The id of the first clip the previous round's add_clips / insert_clips created (a correct run
 *  that goes on to style a clip it placed has to read the id the tool minted). */
function createdId(req: InferenceRequest, kind?: string): string {
  for (const r of req.round_input.tool_results ?? []) {
    const result = r.result as { created?: { clip_id?: string; kind?: string }[] };
    const hit = (result.created ?? []).find((c) => !kind || c.kind === kind);
    if (hit?.clip_id) return hit.clip_id;
  }
  throw new Error("the previous round created no clip");
}
/** The id of the track the previous round's add_track created. */
function createdTrack(req: InferenceRequest): string {
  for (const r of req.round_input.tool_results ?? []) {
    const result = r.result as { track_id?: string; created_tracks?: string[]; id?: string };
    const id = result.track_id ?? result.created_tracks?.[0] ?? result.id;
    if (id) return String(id);
  }
  throw new Error("the previous round created no track");
}
const step = (...calls: ReferenceCalls): ReferenceStep => ({ calls });
const say = (text: string): ReferenceStep => ({ text });
const read: ReferenceStep = step(["get_timeline", {}]);

// ── gap 4: attached files ───────────────────────────────────────────────────

const talkBeach = () =>
  wide([vtrack("v1", 0, [placed("talk", TALK, 0, 300), placed("beach", BEACH, 300, 150)])]);

const ATTACHMENTS: Scenario[] = [
  {
    id: "attach_clip_to_end",
    title: "Add an attached clip to the end",
    tags: ["gap:attachments", "lang:en", "turns:1", "clips:2", "attach:linked"],
    surface: "studio",
    footage: footage(TALK, BEACH, DRONE),
    seed: talkBeach,
    prompt: "Add this clip to the end of my video.",
    turnContext: [{ turn: 0, attach: [DRONE.media_ref] }],
    scope: { add: ["video"] },
    expectTools: ["add_clips"],
    maxRounds: 6,
    expect: (final) => {
      const lib = footage(TALK, BEACH, DRONE);
      const drone = onePlaying(final, lib, DRONE, "the attached clip");
      near(at(drone), 450, 2, "the attached clip starts where the video ended");
      near(span(drone), 180, 3, "the attached clip plays whole (6 s)");
    },
    reference: [
      read,
      step(["add_clips", { entries: [{ media_ref: DRONE.filename, timeline_in: 450 }] }]),
      say("Added the drone shot after the beach clip, so the video now ends on it."),
    ],
  },
  {
    id: "attach_photo_as_opener",
    title: "Open the video on an attached picture, pushing the rest later",
    tags: ["gap:attachments", "lang:en", "turns:1", "clips:2", "attach:copied"],
    surface: "studio",
    footage: footage(TALK, BEACH, TITLE_CARD),
    seed: talkBeach,
    prompt: "Use this picture as the opening shot for 3 seconds, then the video as it is.",
    turnContext: [{ turn: 0, attach: [TITLE_CARD.media_ref] }],
    scope: { change: ["talk", "beach"], add: ["image", "video"] },
    expectTools: ["insert_clips"],
    maxRounds: 6,
    expect: (final) => {
      const card = onePlaying(final, footage(TALK, BEACH, TITLE_CARD), TITLE_CARD, "the picture");
      near(at(card), 0, 1, "the picture opens the video");
      near(span(card), 90, 2, "the picture holds for 3 s");
      const talk = clipById(final, "talk");
      const beach = clipById(final, "beach");
      assert(talk && beach, "a clip of the video is gone");
      near(at(talk), 90, 2, "the video starts after the picture");
      near(span(talk), 300, 1, "the talk clip keeps its length");
      near(at(beach), 390, 2, "the beach clip still follows the talk clip");
      near(span(beach), 150, 1, "the beach clip keeps its length");
    },
    reference: [
      read,
      step([
        "insert_clips",
        { at: 0, entries: [{ media_ref: `library/${TITLE_CARD.media_ref}`, duration: 90 }] },
      ]),
      say("The picture now opens the video for 3 seconds; everything else follows it."),
    ],
  },
  {
    id: "attach_logo_top_right",
    title: "Lay an attached logo small in a corner for the whole video",
    tags: ["gap:attachments", "lang:en", "turns:1", "clips:2", "attach:copied", "overlay"],
    surface: "studio",
    footage: footage(TALK, BEACH, LOGO),
    seed: () =>
      wide([vtrack("v1", 0, [placed("talk", TALK, 0, 300), placed("beach", BEACH, 300, 150)])]),
    prompt: "Put this logo small in the top right corner for the whole video.",
    turnContext: [{ turn: 0, attach: [LOGO.media_ref] }],
    scope: { add: ["image", "video"], addTracks: true },
    expectTools: ["add_clips", "set_clip_properties"],
    mustNotCall: ["generate_image"],
    maxRounds: 8,
    expect: (final) => {
      const logo = onePlaying(final, footage(TALK, BEACH, LOGO), LOGO, "the logo");
      near(at(logo), 0, 2, "the logo starts with the video");
      near(end(logo), 450, 3, "the logo stays to the end of the video");
      const tracks = final.tracks ?? [];
      const logoTrack = trackOfClip(final, String(logo.id));
      const footageTrack = trackOfClip(final, "talk");
      assert(logoTrack && footageTrack, "a track is missing");
      assert(logoTrack !== footageTrack, "the logo sits on the footage's own track, not over it");
      const z = (t: typeof logoTrack) => Number(t?.z ?? tracks.indexOf(t!));
      assert(z(logoTrack) > z(footageTrack), "the logo's track is under the footage");
      const tf = (logo as { transform?: Record<string, unknown> }).transform ?? {};
      const pos = (tf.position ?? {}) as { x?: number; y?: number };
      const size = Math.max(
        Number(tf.scale ?? 0) || 0,
        Number(tf.scale_x ?? 0) || 0,
        Number(tf.scale_y ?? 0) || 0,
      );
      assert(size > 0 && size <= 0.5, `the logo is not small (scale ${size || "full frame"})`);
      assert(
        Number(pos.x) > 0.5 && Number(pos.x) < 1 && Number(pos.y) < 0.5 && Number(pos.y) > 0,
        `the logo is not in the top right corner (centre ${pos.x}, ${pos.y})`,
      );
    },
    reference: [
      read,
      step(["add_track", { kind: "video" }]),
      {
        calls: (req) => [
          [
            "add_clips",
            {
              entries: [
                {
                  media_ref: `library/${LOGO.media_ref}`,
                  track_id: createdTrack(req),
                  timeline_in: 0,
                  timeline_out: 450,
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
              clip_ids: [createdId(req)],
              transform: { position: { x: 0.88, y: 0.12 }, scale: 0.2 },
            },
          ],
        ],
      },
      say("The logo sits small in the top right corner from the first frame to the last."),
    ],
  },
  {
    id: "attach_song_under_video",
    title: "Use an attached song as background music for the whole video",
    tags: ["gap:attachments", "lang:en", "turns:1", "clips:2", "attach:linked", "audio"],
    surface: "studio",
    footage: footage(TALK, BEACH, SONG),
    seed: talkBeach,
    prompt: "Use this song as background music for the whole video.",
    turnContext: [{ turn: 0, attach: [SONG.media_ref] }],
    scope: { add: ["audio"], addTracks: true },
    expectTools: ["add_clips"],
    mustNotCall: ["generate_music"],
    maxRounds: 6,
    expect: (final) => {
      const song = onePlaying(final, footage(TALK, BEACH, SONG), SONG, "the song");
      assert(
        trackOfClip(final, String(song.id))?.kind === "audio",
        "the song is not on an audio track",
      );
      near(at(song), 0, 2, "the song starts with the video");
      // The song runs 60 s; the video 15 s. Left whole it plays on over black.
      near(end(song), 450, 3, "the song ends with the video");
    },
    reference: [
      read,
      step([
        "add_clips",
        { entries: [{ media_ref: SONG.filename, timeline_in: 0, timeline_out: 450 }] },
      ]),
      say("The piano track now plays under the whole video and ends with it."),
    ],
  },
  {
    id: "attach_photos_slideshow_in_order",
    title: "A slideshow of several attached photos, in the order attached",
    tags: ["gap:attachments", "lang:en", "turns:1", "clips:0", "attach:several"],
    surface: "studio",
    footage: footage(...PHOTOS),
    seed: () => wide([vtrack("v1", 0, [])]),
    prompt: "Make a slideshow of these photos, 2 seconds each, in the order I attached them.",
    turnContext: [{ turn: 0, attach: PHOTOS.map((p) => p.media_ref) }],
    scope: { add: ["image", "video"], addTracks: true },
    expectTools: ["add_clips"],
    maxRounds: 6,
    expect: (final) => {
      const lib = footage(...PHOTOS);
      const shown = allClips(final)
        .filter((c) => footageClip(lib, String(c.media_ref ?? "")))
        .sort((a, b) => at(a) - at(b));
      assert(shown.length === 4, `expected the 4 photos on the timeline, got ${shown.length}`);
      const order = shown.map((c) => footageClip(lib, String(c.media_ref))!.filename);
      assert(
        JSON.stringify(order) === JSON.stringify(PHOTOS.map((p) => p.filename)),
        `the photos play as ${order.join(", ")}, not in the order attached`,
      );
      shown.forEach((c, i) => {
        near(at(c), i * 60, 1, `photo ${i + 1} starts`);
        near(span(c), 60, 1, `photo ${i + 1} holds 2 s`);
      });
    },
    reference: [
      step([
        "add_clips",
        {
          entries: PHOTOS.map((p, i) => ({
            media_ref: p.filename,
            timeline_in: i * 60,
            duration: 60,
          })),
        },
      ]),
      say("The four photos play for 2 seconds each, in the order you attached them."),
    ],
  },
  {
    id: "attach_clip_and_song_together",
    title: "Two attachments of different kinds: a clip for the end, a song under all of it",
    tags: ["gap:attachments", "lang:en", "turns:1", "clips:1", "attach:several", "audio"],
    surface: "studio",
    footage: footage(TALK, BTS, LOOP),
    seed: () => wide([vtrack("v1", 0, [placed("talk", TALK, 0, 300)])]),
    prompt: "Add the clip to the end of the video and put the song under the whole thing.",
    turnContext: [{ turn: 0, attach: [BTS.media_ref, LOOP.media_ref] }],
    scope: { add: ["video", "audio"], addTracks: true },
    expectTools: ["add_clips"],
    mustNotCall: ["generate_music"],
    maxRounds: 6,
    expect: (final) => {
      const lib = footage(TALK, BTS, LOOP);
      const clip = onePlaying(final, lib, BTS, "the attached clip");
      near(at(clip), 300, 2, "the attached clip starts where the video ended");
      near(span(clip), 120, 3, "the attached clip plays whole (4 s)");
      const song = onePlaying(final, lib, LOOP, "the song");
      near(at(song), 0, 2, "the song starts with the video");
      // The whole thing now ends after the added clip, at 420.
      near(end(song), 420, 3, "the song ends with the video, added clip included");
    },
    reference: [
      read,
      step([
        "add_clips",
        {
          entries: [
            { media_ref: BTS.filename, timeline_in: 300 },
            { media_ref: LOOP.filename, timeline_in: 0, timeline_out: 420 },
          ],
        },
      ]),
      say("The clip now closes the video, and the song plays under all of it."),
    ],
  },
  {
    id: "attach_in_follow_up",
    title: "A file attached to a follow-up, placed relative to the earlier subject",
    tags: ["gap:attachments", "lang:en", "turns:2", "clips:2", "attach:copied"],
    surface: "studio",
    footage: footage(BEACH, CITY, STREET),
    seed: () =>
      wide([vtrack("v1", 0, [placed("beach", BEACH, 0, 150), placed("city", CITY, 150, 300)])]),
    prompt: "Make the first clip black and white.",
    followUps: ["Now put this one right after it."],
    turnContext: [{ turn: 1, attach: [STREET.media_ref] }],
    scope: { change: ["beach", "city"], add: ["video"] },
    expectTools: ["apply_color", "insert_clips"],
    maxRounds: 10,
    expect: (final) => {
      const beach = clipById(final, "beach");
      assert(saturationOf(beach) <= 0.15, "the first clip is not black and white");
      const street = onePlaying(final, footage(BEACH, CITY, STREET), STREET, "the attached clip");
      near(at(street), 150, 2, "the attached clip comes right after the first clip");
      near(span(street), 150, 3, "the attached clip plays whole (5 s)");
      const city = clipById(final, "city");
      assert(city, "the city clip is gone");
      near(at(city), 300, 2, "the city clip moved up to follow the attached clip");
      near(span(city), 300, 1, "the city clip keeps its length");
    },
    reference: [
      read,
      step(["apply_color", { clip_ids: ["beach"], saturation: 0 }]),
      say("The beach clip is black and white now."),
      step([
        "insert_clips",
        { at: 150, entries: [{ media_ref: `library/${STREET.media_ref}.mp4` }] },
      ]),
      say("The street food clip now sits right after the beach clip; the city clip follows it."),
    ],
  },
  {
    id: "attach_never_arrived",
    title: "The request speaks of an attachment, but none came through",
    tags: ["gap:attachments", "lang:en", "turns:1", "clips:2", "attach:none", "honesty"],
    surface: "studio",
    // The import was refused (the app tells the person), so the message went out without it.
    footage: footage(TALK, BEACH, OLD_TAKE),
    seed: talkBeach,
    prompt: "Put the clip I just attached between these two.",
    scope: {},
    maxRounds: 6,
    expect: untouched(talkBeach),
    expectTrace: (t) => {
      const said = t.finalText;
      if (
        !/(\b(no|not|nothing|never|without|missing|none)\b|n't\b)[^.?!]{0,80}\b(attach\w*|file|clip|came through|arriv\w*|receiv\w*|see|find)/i.test(
          said,
        )
      )
        throw new Error("the reply does not say that no attached file came through");
    },
    reference: [
      read,
      say(
        "I don't see any attached file with your message, so nothing was added. Could you attach the clip again?",
      ),
    ],
  },
  {
    id: "attach_picture_asked_for_sound",
    title: "An attached picture asked for its song: say plainly a picture has no sound",
    tags: ["gap:attachments", "lang:en", "turns:1", "clips:2", "attach:copied", "honesty"],
    surface: "studio",
    footage: footage(TALK, BEACH, POSTER),
    seed: talkBeach,
    prompt: "Use the song from this as the background music.",
    turnContext: [{ turn: 0, attach: [POSTER.media_ref] }],
    scope: {},
    mustNotCall: ["generate_music"],
    maxRounds: 6,
    expect: untouched(talkBeach),
    expectTrace: (t) => {
      const said = t.finalText;
      if (!/\b(image|picture|photo|poster|still|jpe?g)\b/i.test(said))
        throw new Error("the reply does not say the attachment is a picture");
      if (
        !/(\b(no|not|without|cannot)\b|n't\b)[^.?!]{0,60}\b(sound|audio|song|music)\b/i.test(said)
      )
        throw new Error("the reply does not say the picture has no sound to use");
    },
    reference: [
      say(
        "The file you attached is a picture (a concert poster), so it has no sound: there is no song in it I can use. Send me the song itself and I'll put it under the video.",
      ),
    ],
  },
  {
    id: "attach_match_picture_shape",
    title: "Make the video the shape of an attached reference picture",
    tags: ["gap:attachments", "lang:en", "turns:1", "clips:1", "attach:linked", "canvas"],
    surface: "studio",
    footage: footage(TALK, REFERENCE_POST),
    seed: () => wide([vtrack("v1", 0, [placed("talk", TALK, 0, 300)])]),
    prompt: "Make my video the same shape as this picture.",
    turnContext: [{ turn: 0, attach: [REFERENCE_POST.media_ref] }],
    scope: { canvas: ["width", "height"], change: ["talk"] },
    expectTools: ["inspect_media", "set_project_settings"],
    maxRounds: 6,
    expect: (final) => {
      // 1080x1350 is 4:5. No canvas preset has that shape, so only a look at the picture finds it.
      const ratio = Number(final.canvas?.width) / Number(final.canvas?.height);
      near(ratio, 0.8, 0.01, "canvas width / height (the picture is 4:5)");
      assert(clipById(final, "talk"), "the footage is gone");
    },
    reference: [
      step(["inspect_media", { media_ref: REFERENCE_POST.filename }]),
      step(["set_project_settings", { size: { width: 1080, height: 1350 } }]),
      say("The picture is 1080x1350 (4:5), so the canvas is now 1080x1350 too."),
    ],
  },
  {
    id: "attach_swap_second_clip",
    title: "Swap one clip for an attached better take",
    tags: ["gap:attachments", "lang:en", "turns:1", "clips:3", "attach:linked"],
    surface: "studio",
    footage: footage(BEACH, TAKE_ONE, CITY, TAKE_TWO),
    seed: () =>
      wide([
        vtrack("v1", 0, [
          placed("beach", BEACH, 0, 150),
          placed("take", TAKE_ONE, 150, 150),
          placed("city", CITY, 300, 150),
        ]),
      ]),
    prompt: "Swap the second clip for this better take.",
    turnContext: [{ turn: 0, attach: [TAKE_TWO.media_ref] }],
    scope: { change: ["take"], remove: ["take"], add: ["video"] },
    expectTools: ["set_clip_properties"],
    maxRounds: 6,
    expect: (final) => {
      const lib = footage(BEACH, TAKE_ONE, CITY, TAKE_TWO);
      assert(playing(final, lib, TAKE_ONE).length === 0, "the old take is still on the timeline");
      const take = onePlaying(final, lib, TAKE_TWO, "the better take");
      near(at(take), 150, 2, "the better take sits where the second clip was");
      near(span(take), 150, 3, "the better take fills the second clip's place");
      near(at(clipById(final, "city")), 300, 2, "the third clip stays where it was");
    },
    reference: [
      read,
      step(["set_clip_properties", { clip_ids: ["take"], media_ref: TAKE_TWO.filename }]),
      say("The second clip now plays the new take, in the same place and length."),
    ],
  },
];

// ── gap 9a: the timeline changed by hand between two turns ─────────────────────

/** Move clips by hand: each id to its new [in, out). */
const moveTo =
  (moves: Record<string, number>) =>
  (tl: Timeline): void => {
    for (const c of allClips(tl)) {
      const to = moves[String(c.id)];
      if (to === undefined) continue;
      const len = Number(c.timeline_out) - Number(c.timeline_in);
      c.timeline_in = to;
      c.timeline_out = to + len;
    }
  };
const deleteClip =
  (id: string) =>
  (tl: Timeline): void => {
    for (const t of tl.tracks ?? []) t.clips = (t.clips ?? []).filter((c) => c.id !== id);
  };

const threeShots = () =>
  timeline([
    vtrack("v1", 0, [
      vclip("intro", "intro.mp4", 0, 150),
      vclip("beach", "beach.mp4", 150, 300),
      vclip("city", "city.mp4", 300, 450),
    ]),
  ]);

const OUTSIDE_EDITS: Scenario[] = [
  {
    id: "outside_reorder_then_fade_first",
    title: "The person reorders clips by hand, then asks about 'the first clip'",
    tags: ["gap:outside-change-mentions", "lang:en", "turns:2", "clips:3", "outside:move"],
    seed: threeShots,
    prompt: "Make the city clip black and white.",
    followUps: ["Now give the first clip a one-second fade-in."],
    turnContext: [
      {
        turn: 1,
        editedBefore: {
          what: "dragged the city clip to the start",
          apply: moveTo({ city: 0, intro: 150, beach: 300 }),
        },
      },
    ],
    scope: { change: ["city"] },
    expectTools: ["get_timeline", "apply_color", "set_clip_properties"],
    maxRounds: 10,
    expect: (final) => {
      const city = clipById(final, "city");
      assert(saturationOf(city) <= 0.15, "the city clip is not black and white");
      const fade = fadeInOf(city);
      assert(fade !== null, "the clip that now opens the video (city) has no fade-in");
      near(fade!, 30, 4, "the fade-in on the opening clip");
      assert(fadeInOf(clipById(final, "intro")) === null, "the fade went on the old first clip");
    },
    reference: [
      read,
      step(["apply_color", { clip_ids: ["city"], saturation: 0 }]),
      say("The city clip is black and white."),
      read,
      step(["set_clip_properties", { clip_ids: ["city"], fade: { in: 30 } }]),
      say("You moved the city clip to the start, so it got the one-second fade-in."),
    ],
  },
  {
    id: "outside_delete_then_close_gaps",
    title: "The person deletes a clip by hand, then asks to close the gaps",
    tags: ["gap:outside-change-mentions", "lang:en", "turns:2", "clips:4", "outside:delete"],
    seed: () =>
      timeline([
        vtrack("v1", 0, [
          vclip("opening", "opening.mp4", 0, 150),
          vclip("kitchen", "kitchen.mp4", 150, 300),
          vclip("garden", "garden.mp4", 300, 450),
          vclip("ending", "ending.mp4", 450, 600),
        ]),
      ]),
    prompt: "Make the last clip two seconds shorter.",
    followUps: ["Close any gaps so it plays straight through."],
    turnContext: [
      { turn: 1, editedBefore: { what: "deleted the kitchen clip", apply: deleteClip("kitchen") } },
    ],
    scope: { change: ["garden", "ending"] },
    expectTools: ["get_timeline", "set_clip_properties", "ripple_delete", "move_clips"],
    maxRounds: 10,
    expect: (final) => {
      assert(!clipById(final, "kitchen"), "the clip the person deleted came back");
      const v1 = clipsOf(final, "v1");
      assert(
        JSON.stringify(v1.map((c) => c.id)) === JSON.stringify(["opening", "garden", "ending"]),
        `v1 holds ${v1.map((c) => c.id).join(", ")}`,
      );
      let cursor = 0;
      for (const c of v1) {
        near(at(c), cursor, 1, `${c.id} starts where the clip before it ends`);
        cursor = end(c);
      }
      near(span(clipById(final, "garden")), 150, 1, "the garden clip keeps its length");
      near(span(clipById(final, "ending")), 90, 2, "the last clip is 2 s shorter (3 s)");
    },
    reference: [
      read,
      step(["set_clip_properties", { clip_ids: ["ending"], duration: 90 }]),
      say("The last clip is two seconds shorter now."),
      read,
      step(["ripple_delete", { track_id: "v1", start: 150, end: 300 }]),
      say(
        "You had deleted the kitchen clip, which left a hole; I closed it, so it plays straight through.",
      ),
    ],
  },
  {
    id: "outside_trim_then_music_to_end",
    title: "The person shortens the video by hand, then asks the music to end with it",
    tags: ["gap:outside-change-mentions", "lang:en", "turns:2", "clips:3", "outside:trim", "audio"],
    seed: () =>
      timeline([
        vtrack("v1", 0, [vclip("talk", "talk.mp4", 0, 300), vclip("beach", "beach.mp4", 300, 600)]),
        atrack("a1", 0, [aclip("music", "music.mp3", 0, 600)]),
      ]),
    prompt: "Turn the music down to about half.",
    followUps: ["Make the music stop exactly where the video ends."],
    turnContext: [
      {
        turn: 1,
        editedBefore: {
          what: "trimmed the end of the beach clip",
          apply: (tl) => {
            const beach = allClips(tl).find((c) => c.id === "beach")!;
            beach.timeline_out = 450;
            beach.source_out = Number(beach.source_in ?? 0) + 150;
          },
        },
      },
    ],
    scope: { change: ["music"] },
    expectTools: ["get_timeline", "set_clip_properties"],
    maxRounds: 10,
    expect: (final) => {
      const music = clipById(final, "music");
      assert(music, "the music is gone");
      near(at(music), 0, 1, "the music still starts at the start");
      near(end(music), 450, 2, "the music ends where the video now ends");
      const vol = Number((music as { volume?: unknown }).volume);
      assert(vol >= 0.3 && vol <= 0.7, `the music is not at about half volume (${vol})`);
    },
    reference: [
      read,
      step(["set_clip_properties", { clip_ids: ["music"], volume: 0.5 }]),
      say("The music is at half volume."),
      read,
      step(["set_clip_properties", { clip_ids: ["music"], duration: 450 }]),
      say(
        "You shortened the beach clip, so the video ends at 15 s; the music now stops there too.",
      ),
    ],
  },
  {
    id: "outside_add_then_title_last",
    title: "The person adds a clip by hand, then asks for a title over the last clip",
    tags: ["gap:outside-change-mentions", "lang:en", "turns:2", "clips:2", "outside:add", "text"],
    seed: () =>
      timeline([
        vtrack("v1", 0, [
          vclip("intro", "intro.mp4", 0, 150),
          vclip("beach", "beach.mp4", 150, 300),
        ]),
      ]),
    prompt: "Flip the first clip horizontally.",
    followUps: [
      "Add the words 'Thanks for watching' over the last clip, for as long as it's on screen.",
    ],
    turnContext: [
      {
        turn: 1,
        editedBefore: {
          what: "added outro.mp4 after the last clip",
          apply: (tl) => {
            const v1 = (tl.tracks ?? []).find((t) => t.id === "v1")!;
            v1.clips = [...(v1.clips ?? []), vclip("outro", "outro.mp4", 300, 450) as Clip];
          },
        },
      },
    ],
    scope: { change: ["intro"], add: ["text"], addTracks: true },
    expectTools: ["get_timeline", "set_clip_properties", "add_text_clips"],
    maxRounds: 10,
    expect: (final) => {
      const intro = clipById(final, "intro") as { flip?: { h?: unknown } } | undefined;
      assert(intro?.flip?.h === true, "the first clip is not flipped");
      const outro = clipById(final, "outro");
      assert(outro, "the clip the person added is gone");
      const title = allClips(final).find((c) => /thanks for watching/i.test(textOf(c)));
      assert(title, "no 'Thanks for watching' text on the timeline");
      near(at(title), at(outro), 2, "the words start with the last clip");
      near(end(title), end(outro), 2, "the words stay as long as the last clip");
    },
    reference: [
      read,
      step(["set_clip_properties", { clip_ids: ["intro"], flip: { h: true } }]),
      say("The first clip is flipped."),
      read,
      step([
        "add_text_clips",
        { entries: [{ timeline_in: 300, timeline_out: 450, content: "Thanks for watching" }] },
      ]),
      say("'Thanks for watching' now sits over the outro clip you added, for its whole length."),
    ],
  },
  {
    id: "outside_split_then_remove_piece",
    title: "The person splits a clip by hand, then asks to delete the piece they cut off",
    tags: ["gap:outside-change-mentions", "lang:en", "turns:2", "clips:2", "outside:split"],
    seed: () =>
      timeline([
        vtrack("v1", 0, [vclip("talk", "talk.mp4", 0, 300), vclip("beach", "beach.mp4", 300, 450)]),
      ]),
    prompt: "Make the second clip a bit brighter.",
    followUps: ["Delete the piece I just cut off the end of the first clip, and close the gap."],
    turnContext: [
      {
        turn: 1,
        editedBefore: {
          what: "split the talk clip at frame 200",
          apply: (tl) => {
            const v1 = (tl.tracks ?? []).find((t) => t.id === "v1")!;
            const talk = (v1.clips ?? []).find((c) => c.id === "talk")!;
            talk.timeline_out = 200;
            talk.source_out = 200;
            v1.clips = [
              ...(v1.clips ?? []),
              vclip("talk_cut", "talk.mp4", 200, 300, { source_in: 200, source_out: 300 }) as Clip,
            ];
          },
        },
      },
    ],
    scope: { remove: ["talk_cut"], change: ["beach"] },
    expectTools: ["get_timeline", "ripple_delete"],
    maxRounds: 10,
    expect: (final) => {
      assert(!clipById(final, "talk_cut"), "the piece the person cut off is still there");
      const talk = clipById(final, "talk");
      assert(talk, "the first clip itself was deleted");
      near(at(talk), 0, 1, "the first clip still starts at 0");
      near(span(talk), 200, 1, "the first clip keeps the part before the cut");
      const beach = clipById(final, "beach");
      near(at(beach), 200, 1, "the second clip closed up to the first");
      const color = ((beach as { color?: Record<string, unknown> })?.color ?? {}) as Record<
        string,
        number
      >;
      assert(
        Number(color.exposure ?? 0) > 0 ||
          Number(color.brightness ?? 0) > 0 ||
          Number(color.gamma ?? 1) > 1 ||
          Number(color.shadows ?? 0) > 0,
        "the second clip is no longer brighter",
      );
    },
    reference: [
      read,
      step(["apply_color", { clip_ids: ["beach"], exposure: 0.3 }]),
      say("The beach clip is a bit brighter."),
      read,
      step(["ripple_delete", { track_id: "v1", start: 200, end: 300 }]),
      say("Deleted the piece you cut off the talk clip and closed the gap."),
    ],
  },
];

// ── gap 9b: @mentions ──────────────────────────────────────────────────────────

/** The seed's clip `id`, as the composer's @ picker would mention it. */
const mentionOf = (seed: () => Timeline, id: string) => {
  const tl = seed();
  const track = trackOfClip(tl, id)!;
  return buildClipMention(clipById(tl, id)!, String(track.id));
};

const introBeachCity = () =>
  timeline([
    vtrack("v1", 0, [
      vclip("intro", "intro.mp4", 0, 150),
      vclip("beach", "beach.mp4", 150, 450),
      vclip("city", "city.mp4", 450, 600),
    ]),
  ]);
const talkThenBeach = () =>
  timeline([
    vtrack("v1", 0, [vclip("talk", "talk.mp4", 0, 300), vclip("beach", "beach.mp4", 300, 600)]),
  ]);
const twoGaps = () =>
  timeline([
    vtrack("v1", 0, [
      vclip("a", "a.mp4", 0, 150),
      vclip("b", "b.mp4", 240, 390),
      vclip("c", "c.mp4", 450, 600),
    ]),
  ]);
const oneTalk = () => timeline([vtrack("v1", 0, [vclip("talk", "talk.mp4", 0, 300)])]);
const beachDroneCity = () =>
  timeline([
    vtrack("v1", 0, [
      vclip("beach", "beach.mp4", 0, 150),
      vclip("drone", "drone.mp4", 150, 300),
      vclip("city", "city.mp4", 300, 450),
    ]),
  ]);
/** The person moved the talk clip after the beach clip, after @mentioning it where it was. */
const movedTalk = () =>
  timeline([
    vtrack("v1", 0, [vclip("beach", "beach.mp4", 0, 150), vclip("talk", "talk.mp4", 150, 450)]),
  ]);
/** The person deleted the beach clip (closing the gap) after @mentioning it. */
const beachGone = () =>
  timeline([
    vtrack("v1", 0, [vclip("intro", "intro.mp4", 0, 150), vclip("city", "city.mp4", 150, 300)]),
  ]);

const MENTIONS: Scenario[] = [
  {
    id: "mention_clip_trim",
    title: "Trim the @mentioned clip, not the first one",
    tags: ["gap:outside-change-mentions", "lang:en", "turns:1", "clips:3", "mention:clip"],
    seed: introBeachCity,
    prompt: "Trim this clip to 4 seconds.",
    turnContext: [{ turn: 0, mentions: [mentionOf(introBeachCity, "beach")] }],
    scope: { change: ["beach", "city"] },
    expectTools: ["set_clip_properties"],
    maxRounds: 5,
    expect: (final) => {
      const beach = clipById(final, "beach");
      assert(beach, "the mentioned clip is gone");
      near(span(beach), 120, 2, "the mentioned clip is 4 s");
      near(at(beach), 150, 1, "the mentioned clip still starts where it did");
      near(span(clipById(final, "intro")), 150, 0, "the first clip keeps its length");
      near(span(clipById(final, "city")), 150, 0, "the last clip keeps its length");
    },
    reference: [
      step(["set_clip_properties", { clip_ids: ["beach"], duration: 120 }]),
      say("The beach clip is 4 seconds now."),
    ],
  },
  {
    id: "mention_range_cut_across_clips",
    title: "Cut out an @mentioned range that crosses a cut, and close the gap",
    tags: ["gap:outside-change-mentions", "lang:en", "turns:1", "clips:2", "mention:range"],
    seed: talkThenBeach,
    prompt: "Cut this part out and close the gap.",
    turnContext: [{ turn: 0, mentions: [buildRangeMention(240, 360, FPS)] }],
    scope: { change: ["talk", "beach"], remove: ["beach"], add: ["video"] },
    expectTools: ["ripple_delete"],
    maxRounds: 5,
    expect: (final) => {
      // Cutting into a clip's head may leave it as a new clip: find each one by its source.
      const bySource = (ref: string) => allClips(final).filter((c) => c.media_ref === ref);
      const [talk] = bySource("talk.mp4");
      const beach = bySource("beach.mp4");
      assert(talk && beach.length === 1, "a clip is gone, or split in pieces");
      near(at(talk), 0, 0, "the first clip starts at 0");
      near(span(talk), 240, 1, "the first clip ends where the range began");
      near(Number(talk.source_in ?? 0), 0, 1, "the first clip keeps its opening");
      near(at(beach[0]), 240, 1, "the second clip closed up to the first");
      near(span(beach[0]), 240, 1, "the second clip lost its first 2 s");
      near(
        Number(beach[0].source_in ?? 0),
        60,
        1,
        "the second clip now starts 2 s into its source",
      );
    },
    reference: [
      step(["ripple_delete", { track_id: "v1", start: 240, end: 360 }]),
      say(
        "Cut frames 240-360 (the end of the talk clip and the start of the beach clip) and closed the gap.",
      ),
    ],
  },
  {
    id: "mention_gap_close_one",
    title: "Close the @mentioned gap and leave the other one",
    tags: ["gap:outside-change-mentions", "lang:en", "turns:1", "clips:3", "mention:gap"],
    seed: twoGaps,
    prompt: "Close this gap.",
    turnContext: [{ turn: 0, mentions: [buildGapMention("v1", { start: 150, end: 240 }, FPS)] }],
    scope: { change: ["b", "c"] },
    expectTools: ["ripple_delete", "move_clips"],
    maxRounds: 5,
    expect: (final) => {
      near(at(clipById(final, "a")), 0, 0, "the first clip stays");
      near(at(clipById(final, "b")), 150, 1, "the mentioned gap is closed");
      const c = clipById(final, "c");
      const gap = at(c) - end(clipById(final, "b"));
      near(gap, 60, 1, "the other gap (2 s before the last clip) is still there");
    },
    reference: [
      step(["ripple_delete", { track_id: "v1", start: 150, end: 240 }]),
      say("Closed the 3-second gap after the first clip; the later gap is untouched."),
    ],
  },
  {
    id: "mention_playhead_split",
    title: "Split at the @mentioned playhead",
    tags: ["gap:outside-change-mentions", "lang:en", "turns:1", "clips:1", "mention:playhead"],
    seed: oneTalk,
    prompt: "Split the clip here.",
    turnContext: [{ turn: 0, mentions: [buildPlayheadMention(137, FPS)] }],
    scope: { change: ["talk"], add: ["video"] },
    expectTools: ["split_clips"],
    maxRounds: 5,
    expect: (final) => {
      const v1 = clipsOf(final, "v1");
      assert(v1.length === 2, `expected 2 pieces, got ${v1.length}`);
      near(end(v1[0]), 137, 0, "the cut is at the playhead");
      near(at(v1[1]), 137, 0, "the second piece starts at the playhead");
      near(Number(v1[1].source_in ?? 0), 137, 1, "the second piece continues the source");
    },
    reference: [
      step(["split_clips", { splits: [{ clip_id: "talk", at: 137 }] }]),
      say("Split the clip at frame 137."),
    ],
  },
  {
    id: "mention_library_item_add",
    title: "Add the @mentioned library item after the last clip",
    tags: ["gap:outside-change-mentions", "lang:en", "turns:1", "clips:2", "mention:media"],
    surface: "studio",
    footage: footage(TALK, BEACH, HARBOUR, CITY),
    seed: () =>
      wide([vtrack("v1", 0, [placed("talk", TALK, 0, 150), placed("beach", BEACH, 150, 150)])]),
    prompt: "Add this one after the last clip.",
    // A linked library file: the @ picker names it by its id (lib/files.ts listProjectFiles).
    turnContext: [
      {
        turn: 0,
        mentions: [buildMediaMention(HARBOUR.media_ref, HARBOUR.filename, "video")],
      },
    ],
    scope: { add: ["video"] },
    expectTools: ["add_clips"],
    maxRounds: 5,
    expect: (final) => {
      const lib = footage(TALK, BEACH, HARBOUR, CITY);
      assert(playing(final, lib, CITY).length === 0, "a different library clip was added");
      const harbour = onePlaying(final, lib, HARBOUR, "the mentioned clip");
      near(at(harbour), 300, 2, "the mentioned clip comes after the last clip");
      near(span(harbour), 240, 3, "the mentioned clip plays whole (8 s)");
    },
    reference: [
      step(["add_clips", { entries: [{ media_ref: HARBOUR.media_ref, timeline_in: 300 }] }]),
      say("Added the harbour timelapse after the beach clip."),
    ],
  },
  {
    id: "mention_disagrees_with_words",
    title: "The @mention points at one clip, the words name another: do not delete blindly",
    tags: [
      "gap:outside-change-mentions",
      "lang:en",
      "turns:1",
      "clips:3",
      "mention:clip",
      "ambiguous",
    ],
    seed: beachDroneCity,
    prompt: "Delete the drone shot.",
    turnContext: [{ turn: 0, mentions: [mentionOf(beachDroneCity, "city")] }],
    scope: { remove: ["drone", "city"], change: ["drone", "city"] },
    maxRounds: 5,
    expectTrace: (t, final) => {
      const gone = ["drone", "city"].filter((id) => !final || !clipById(final, id));
      const said = t.finalText;
      if (gone.length === 2) throw new Error("deleted both the drone shot and the mentioned clip");
      if (gone.length === 0) {
        // Asked which one: the reply must ask, and name what disagrees.
        if (!/\?/.test(said) || !/drone/i.test(said) || !/city/i.test(said))
          throw new Error("deleted nothing and did not ask which clip was meant");
        return;
      }
      // Deleted one: the reply must say the other was pointed at (or named) and left alone.
      const other = gone[0] === "drone" ? "city" : "drone";
      if (!new RegExp(other, "i").test(said))
        throw new Error(
          `deleted ${gone[0]} without saying that the ${other} clip was the other candidate`,
        );
    },
    reference: [
      read,
      say(
        "You pointed at the city clip but asked me to delete the drone shot. Which one should I delete: the drone shot, or the city clip?",
      ),
    ],
  },
  {
    id: "mention_stale_position",
    title: "An @mentioned clip was moved after it was mentioned: act on the clip where it is now",
    tags: ["gap:outside-change-mentions", "lang:en", "turns:1", "clips:2", "mention:clip", "stale"],
    seed: movedTalk,
    prompt: "Cut this clip in half.",
    // Mentioned where it was (frames 0-300), then dragged after the beach clip before sending.
    turnContext: [
      {
        turn: 0,
        mentions: [
          {
            kind: "clip",
            clipId: "talk",
            trackId: "v1",
            startFrame: 0,
            endFrame: 300,
            source: "talk.mp4",
          },
        ],
      },
    ],
    scope: { change: ["talk"], add: ["video"] },
    expectTools: ["get_timeline", "split_clips"],
    maxRounds: 6,
    expect: (final) => {
      near(span(clipById(final, "beach")), 150, 0, "the beach clip is untouched");
      const pieces = allClips(final)
        .filter((c) => c.media_ref === "talk.mp4")
        .sort((a, b) => at(a) - at(b));
      assert(pieces.length === 2, `expected the talk clip in 2 pieces, got ${pieces.length}`);
      near(at(pieces[0]), 150, 0, "the first half starts where the clip is now");
      near(end(pieces[0]), 300, 1, "the cut is in the middle of the clip where it is now");
      near(end(pieces[1]), 450, 0, "the second half ends where the clip ends");
    },
    reference: [
      read,
      step(["split_clips", { splits: [{ clip_id: "talk", at: 300 }] }]),
      say("The talk clip now sits at frames 150-450, so I split it at frame 300."),
    ],
  },
  {
    id: "mention_clip_no_longer_exists",
    title: "An @mentioned clip was deleted before sending: say so, change nothing",
    tags: [
      "gap:outside-change-mentions",
      "lang:en",
      "turns:1",
      "clips:2",
      "mention:clip",
      "stale",
      "honesty",
    ],
    seed: beachGone,
    prompt: "Speed this clip up to double speed.",
    // Mentioned at frames 150-300; the person then deleted it and the city clip slid into its place.
    turnContext: [
      {
        turn: 0,
        mentions: [
          {
            kind: "clip",
            clipId: "beach",
            trackId: "v1",
            startFrame: 150,
            endFrame: 300,
            source: "beach.mp4",
          },
        ],
      },
    ],
    scope: {},
    maxRounds: 5,
    expect: untouched(beachGone),
    expectTrace: (t) => {
      if (
        !/(no longer|(\bnot\b|n't) (on|in|part of) the (timeline|project)|\b(deleted|removed|gone)\b|(can't|cannot|couldn't|could not) (find|see)|(isn't|is not|wasn't|was not) there|(doesn't|does not) exist|not found|no (such )?clip)/i.test(
          t.finalText,
        )
      )
        throw new Error("the reply does not say the mentioned clip is no longer there");
    },
    reference: [
      read,
      say(
        "The clip you pointed at (beach) is no longer on the timeline: it looks like it was deleted. I didn't change anything. Which clip should I speed up?",
      ),
    ],
  },
];

export const GAP_CONTEXT_SCENARIOS: Scenario[] = [...ATTACHMENTS, ...OUTSIDE_EDITS, ...MENTIONS];
