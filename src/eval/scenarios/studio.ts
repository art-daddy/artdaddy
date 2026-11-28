// Studio scenarios — the contract OUTSIDE the timeline editing verbs.
//
// The canonical corpus grades "given clips already on a timeline, does the model
// edit them correctly?". These grade the other half of the catalog: does it find
// footage, look at it, generate what's missing, manage the project, and — the part
// that actually matters — CARRY THE RESULT THROUGH to the timeline.
//
// GRADING RULE (repo test standard): a stub returning `ok:true` is not evidence.
// Wherever a tool produces an asset, the assertion is on the TIMELINE — "the
// generated voiceover is on an audio track", "the clip now spans the moment the
// search reported" — never merely "the tool was called". Where a task is genuinely
// read-only, the assertion is the OPPOSITE outcome: the timeline must be untouched,
// which catches a model that answers a question by editing.
import {
  STUDIO_BBOX,
  STUDIO_CROP_REF,
  STUDIO_DOWNLOAD_REF,
  STUDIO_FOOTAGE_REF,
  STUDIO_IMAGE_REF,
  STUDIO_MOMENT_FRAMES,
  STUDIO_MUSIC_REF,
  STUDIO_SCREENSHOT_REF,
  STUDIO_URL,
  STUDIO_VIDEO_REF,
  STUDIO_VOICEOVER_REF,
} from "../studio";
import type { Scenario, Trace } from "../types";
import { timelineLookFrames } from "../../tools/inspect";
import { aclip, allClips, atrack, clipsOf, timeline, vclip, vtrack } from "./helpers";
import { call, calls, READ_TIMELINE, repliesTo, say } from "./steps";

const FPS = 30;

// ── local graders ────────────────────────────────────────────────────────────

function called(trace: Trace, name: string) {
  return trace.toolCalls.filter((c) => c.name === name && c.ok);
}
function mustCall(trace: Trace, name: string): void {
  if (called(trace, name).length === 0) throw new Error(`never called ${name}`);
}
/** Some look at the footage happened, free or paid: what a cut or an answer about it rests on. */
function mustLook(trace: Trace): void {
  const looks = ["inspect_media", "inspect_timeline", "video_ask", "video_find_moment"];
  if (!looks.some((name) => called(trace, name).length > 0))
    throw new Error("acted on the footage without looking at it");
}
/** The clips that play the studio footage. */
function footageOf(final: ReturnType<Scenario["seed"]>) {
  return allClips(final).filter((c) => String(c.media_ref ?? "") === STUDIO_FOOTAGE_REF);
}
/** The asset really landed on the timeline — the outcome, not the instruction. */
function placed(final: ReturnType<Scenario["seed"]>, ref: string) {
  const hit = allClips(final).find((c) => String(c.media_ref ?? "") === ref);
  if (!hit) {
    const refs = allClips(final).map((c) => c.media_ref);
    throw new Error(`${ref} never reached the timeline (clips: ${JSON.stringify(refs)})`);
  }
  return hit;
}
function trackKindOf(final: ReturnType<Scenario["seed"]>, clipId: string): string {
  const t = (final.tracks ?? []).find((tr) => (tr.clips ?? []).some((c) => c.id === clipId));
  return String(t?.kind ?? "?");
}
/** A caption's words, however the model chose to author them: `text` is the plain
 *  form and `content[]` the per-run form (both are legal in the contract). */
function captionText(final: ReturnType<Scenario["seed"]>): string {
  return allClips(final)
    .filter((c) => c.kind === "text")
    .map((c) => {
      const rec = c as unknown as Record<string, unknown>;
      const runs = Array.isArray(rec.content)
        ? (rec.content as Record<string, unknown>[]).map((r) => String(r.text ?? "")).join(" ")
        : "";
      return `${String(rec.text ?? "")} ${runs}`;
    })
    .join(" ");
}
/** A read-only ask must leave the cut exactly as it was. */
function untouched(seed: () => ReturnType<Scenario["seed"]>) {
  return (final: ReturnType<Scenario["seed"]>) => {
    const before = JSON.stringify(seed().tracks);
    const after = JSON.stringify(final.tracks);
    if (before !== after) throw new Error("a read-only request modified the timeline");
  };
}

// ── seeds ────────────────────────────────────────────────────────────────────

const oneClip = () => timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])]);
const clipPlusMusic = () =>
  timeline([
    vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
    atrack("a1", 0, [aclip("m", "music.mp3", 0, 300)]),
  ]);
const twoClips = () =>
  timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 150), vclip("b", "b.mp4", 150, 300)])]);
const logoStill = () =>
  timeline([vtrack("v1", 0, [vclip("logo", "logo.png", 0, 90, { kind: "image" })])]);

export const STUDIO_SCENARIOS: Scenario[] = [
  // ── structural gaps the timeline surface already supports ──────────────────
  {
    id: "add_track_for_overlay",
    scope: { addTracks: true },
    title: "Make room for an overlay above the footage",
    tags: ["tracks"],
    seed: oneClip,
    prompt: "I want to lay a logo on top of this shot later. Give me somewhere to put it.",
    expectTools: ["add_track"],
    maxRounds: 6,
    expect: (final) => {
      const video = (final.tracks ?? []).filter((t) => t.kind === "video");
      if (video.length < 2) throw new Error(`expected a second video track, got ${video.length}`);
      const zs = video.map((t) => Number(t.z ?? 0));
      if (new Set(zs).size !== zs.length) throw new Error(`two video tracks share a z (${zs})`);
      // The new track must sit ABOVE the footage or an overlay would render under it.
      const base = video.find((t) => (t.clips ?? []).some((c) => c.id === "a"));
      const other = video.find((t) => t !== base);
      if (Number(other?.z ?? 0) <= Number(base?.z ?? 0))
        throw new Error("the new track is not above the existing footage");
    },
    reference: [
      READ_TIMELINE,
      call("add_track", { kind: "video", z: 1 }),
      say("Added an empty video track above the shot, ready for your logo."),
    ],
  },
  {
    id: "redo_after_undo",
    scope: { change: ["a"] },
    title: "Undo an edit, then ask for it back",
    tags: ["undo", "redo", "multi-turn"],
    seed: oneClip,
    prompt: "Cut this down to 4 seconds.",
    followUps: ["Actually undo that.", "No wait, put it back the way you just had it."],
    expectTools: ["redo"],
    maxRounds: 12,
    expect: (final) => {
      const c = clipsOf(final, "v1")[0];
      if (!c) throw new Error("the clip is gone");
      const span = Number(c.timeline_out) - Number(c.timeline_in);
      if (Math.abs(span - 4 * FPS) > 6)
        throw new Error(`redo did not restore the 4s trim (span ${span}f)`);
    },
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["a"], duration: 120 }),
      say("Cut it down to 4 seconds."),
      call("undo"),
      say("Undone: it is back to its full 10 seconds."),
      call("redo"),
      say("Put it back: the clip is 4 seconds again."),
    ],
  },

  // ── inspection: look before you edit ──────────────────────────────────────
  {
    id: "inspect_color_then_warm",
    scope: { change: ["a"] },
    title: "Measure a cold shot, then warm it",
    tags: ["studio", "inspect", "color"],
    surface: "studio",
    seed: oneClip,
    prompt: "This shot looks cold and flat to me. Check what it's actually doing and then fix it.",
    expectTools: ["inspect_color", "apply_color"],
    maxRounds: 10,
    expect: (final) => {
      const c = clipsOf(final, "v1")[0];
      const color = (c?.color ?? {}) as Record<string, unknown>;
      if (Object.keys(color).length === 0) throw new Error("measured the shot but never graded it");
      // The stub reports a cold (warm_cool -0.13), flat (saturation 0.11) shot. The fix warms it or
      // lifts its colour, and moves nothing the other way. The knobs' neutrals are 6500 K for
      // temperature (higher is warmer) and 1 for the saturation multiplier (apply_color's contract);
      // compared with 0, any grade at all passed, a colder one included.
      const temp = Number(color.temperature ?? 6500);
      const sat = Number(color.saturation ?? 1);
      const vib = Number(color.vibrance ?? 0);
      const values = `temperature ${temp} K, saturation ${sat}, vibrance ${vib}`;
      if (temp < 6500 || sat < 1 || vib < 0)
        throw new Error(`the grade makes the shot colder or flatter (${values})`);
      if (temp <= 6500 && sat <= 1 && vib <= 0)
        throw new Error(`the grade does not warm or saturate the shot (${values})`);
    },
    expectTrace: (t) => mustCall(t, "inspect_color"),
    reference: [
      call("inspect_color", { clip_id: "a" }),
      // The scopes: a cool cast (warm_cool -0.13) and almost no colour (saturation 0.11).
      call("apply_color", { clip_ids: ["a"], temperature: 7400, saturation: 1.3, contrast: 1.1 }),
      say(
        "Measured it: the shot has a cool blue cast and very little colour. I warmed the white " +
          "balance to 7400 K, lifted saturation by 30% and added a little contrast.",
      ),
    ],
  },
  {
    id: "inspect_timeline_check",
    scope: {},
    title: "Check the composite at a frame before answering",
    tags: ["studio", "inspect", "read-only"],
    surface: "studio",
    seed: () =>
      timeline([
        vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
        vtrack("v2", 1, [vclip("logo", "logo.png", 0, 300, { kind: "image" })]),
      ]),
    prompt: "At the two second mark, is the logo covering anything important? Just tell me.",
    expectTools: ["inspect_timeline"],
    maxRounds: 8,
    expect: untouched(() =>
      timeline([
        vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
        vtrack("v2", 1, [vclip("logo", "logo.png", 0, 300, { kind: "image" })]),
      ]),
    ),
    expectTrace: (t) => {
      mustCall(t, "inspect_timeline");
      // 2s at 30fps = frame 60. The model must not make the user do fps math for it: one of the
      // frames the call LOOKS AT (the tool's own sampling rule) must be within 2 frames of it.
      const call = called(t, "inspect_timeline")[0];
      const seen = timelineLookFrames((call.args ?? {}) as Record<string, unknown>);
      if (!seen.some((f) => Math.abs(f - 60) <= 2))
        throw new Error(`inspected the wrong frame: ${JSON.stringify(call.args)} looks at ${seen}`);
    },
    reference: [
      call("inspect_timeline", { start_frame: 60 }),
      say(
        "At the 2-second mark (frame 60) the logo is on screen, layered on top of the shot. The " +
          "picture itself did not come through to me here, so I cannot see what the logo sits " +
          "over; I have not changed anything.",
      ),
    ],
  },
  {
    id: "inspect_media_before_place",
    scope: { change: ["a"], remove: ["a"], add: ["video"] },
    title: "Look at the footage before choosing where to cut",
    tags: ["studio", "inspect"],
    surface: "studio",
    seed: oneClip,
    prompt: "What's actually in this shot? Have a look and then cut the boring opening off.",
    expectTools: ["inspect_media"],
    // "Have a look" asks for a look at the content; the paid looks are fair ways to take it.
    paidTools: ["video_ask", "video_find_moment"],
    maxRounds: 10,
    expect: (final) => {
      const kept = footageOf(final);
      if (kept.length === 0) throw new Error("the shot is gone");
      // Every look says nothing moves until the vehicle rises at 3 s and clears the tower at 4 s
      // (studioShotAt): the cut goes somewhere in that opening, and keeps the vehicle clearing it.
      const from = Math.min(...kept.map((c) => Number(c.source_in ?? 0)));
      if (from < FPS)
        throw new Error(`the opening was not cut: the shot still starts ${from} frames in`);
      if (from > STUDIO_MOMENT_FRAMES.peak)
        throw new Error(
          `cut into the launch: the shot now starts ${from} frames in, after the vehicle clears the tower (frame ${STUDIO_MOMENT_FRAMES.peak})`,
        );
      const span = kept.reduce((n, c) => n + Number(c.timeline_out) - Number(c.timeline_in), 0);
      if (span < FPS) throw new Error(`trimmed to almost nothing (${span}f)`);
    },
    // "Have a look": a cut without one (say, the first two seconds) only fits the footage by luck.
    expectTrace: (t) => mustLook(t),
    reference: [
      call("inspect_media", { clip_id: "a" }),
      // The look: the pad sits still until 3 s, when the vehicle rises. Keep a beat before it.
      call("ripple_delete", { track_id: "v1", ranges: [{ start: 0, end: 75 }] }),
      say(
        "It's a rocket launch: a still wide shot of the pad, then the vehicle rises at 3 s and " +
          "clears the tower. I cut the first 2.5 seconds of the motionless pad, so it now opens " +
          "half a second before liftoff.",
      ),
    ],
  },

  // ── media in: find it, fetch it, place it ─────────────────────────────────
  {
    id: "download_and_place",
    scope: { add: ["video", "audio"], addTracks: true },
    title: "Download a video and put it on the end",
    tags: ["studio", "download", "placement"],
    surface: "studio",
    seed: oneClip,
    prompt: `Grab ${STUDIO_URL} and stick it on the end of what I've got.`,
    expectTools: ["download_video", "add_clips"],
    maxRounds: 10,
    expect: (final) => {
      const hit = placed(final, STUDIO_DOWNLOAD_REF);
      // "on the end" — it must start at or after the existing clip's tail.
      if (Number(hit.timeline_in) < 300 - 2)
        throw new Error(`placed at ${hit.timeline_in}f, not after the existing shot (300f)`);
    },
    reference: [
      READ_TIMELINE,
      call("download_video", { url: STUDIO_URL, output_name: "launch" }),
      {
        calls: (req) => [
          [
            "add_clips",
            {
              entries: [
                {
                  media_ref: repliesTo(req, "download_video")[0]?.media_ref,
                  track_id: "v1",
                  timeline_in: 300,
                },
              ],
            },
          ],
        ],
      },
      say("Downloaded the video and placed it right after your shot, at 10 seconds."),
    ],
  },
  {
    id: "search_then_fetch",
    scope: { add: ["video", "audio"], addTracks: true },
    title: "Search YouTube, then bring the right one in",
    tags: ["studio", "search", "download"],
    surface: "studio",
    seed: oneClip,
    prompt: "Find me a rocket launch clip on YouTube and add the full replay after this shot.",
    expectTools: ["youtube_search", "download_video", "add_clips"],
    maxRounds: 12,
    expect: (final) => placed(final, STUDIO_DOWNLOAD_REF),
    expectTrace: (t) => {
      mustCall(t, "youtube_search");
      // It must download the one it was told to want — the replay, not the short.
      // Compared EXACTLY: the short's url has the replay's url as a prefix, so a
      // substring check would score the wrong pick as correct.
      const dl = called(t, "download_video")[0];
      if (!dl) throw new Error("never downloaded anything");
      const url = String((dl.args ?? {}).url ?? "");
      if (url !== STUDIO_URL) throw new Error(`downloaded the wrong result: "${url}"`);
    },
  },
  {
    id: "metadata_before_download",
    scope: {},
    title: "Answer how long a video is without downloading it",
    tags: ["studio", "metadata", "read-only"],
    surface: "studio",
    seed: oneClip,
    prompt: `How long is ${STUDIO_URL}, and what are its chapters? Don't bring it in yet.`,
    expectTools: ["video_get_metadata"],
    // Reading metadata is the cheap path; pulling the file is not, and the user said not yet.
    mustNotCall: ["download_video"],
    maxRounds: 6,
    expect: untouched(oneClip),
    expectTrace: (t) => {
      mustCall(t, "video_get_metadata");
      // The answer is the one the read gave: 754 s (12:34), in the stand-in's three chapters.
      if (!/12:34|754|(12|twelve)\s*min/i.test(t.finalText))
        throw new Error("the answer does not give the length the read reported (12:34)");
      if (!/countdown|liftoff|booster/i.test(t.finalText))
        throw new Error("the answer does not name the chapters the read reported");
    },
    reference: [
      call("video_get_metadata", { url: STUDIO_URL }),
      say(
        "It runs 12 minutes 34 seconds. Chapters: Countdown (0:00 to 2:00), Liftoff (2:00 to " +
          "5:00) and Booster return (5:00 to the end). I have not brought it in.",
      ),
    ],
  },
  {
    id: "probe_before_trusting",
    scope: {},
    title: "Check the real resolution of a source",
    tags: ["studio", "probe", "read-only"],
    surface: "studio",
    seed: oneClip,
    prompt: "Is the footage in this project actually 4K, or is it upscaled? Just check.",
    // probe_media is withdrawn; inspect_media reports a source's real size (its `metadata`).
    expectTools: ["inspect_media"],
    maxRounds: 6,
    expect: untouched(oneClip),
    expectTrace: (t) => {
      // What must NOT happen is answering from thin air: the size has to be read, and the answer
      // has to be the one the read gave (the stand-in's source is 1920x1080, not 4K).
      if (called(t, "inspect_media").length === 0)
        throw new Error("answered without inspecting the media");
      if (!/1080|1920|full ?hd/i.test(t.finalText))
        throw new Error(`the answer does not give the size the read reported (1920x1080)`);
    },
    reference: [
      call("inspect_media", { clip_id: "a" }),
      say("It is not 4K: the source is 1920x1080 (Full HD), and it is used at that size."),
    ],
  },
  // ── vision: look at it, then act on what you saw ──────────────────────────
  {
    id: "find_moment_and_trim",
    scope: { change: ["a"], remove: ["a"], add: ["video"] },
    title: "Find the best moment and cut to it",
    tags: ["studio", "vision", "trim"],
    surface: "studio",
    seed: oneClip,
    prompt: "Find the moment the rocket clears the tower and cut this down to just that.",
    // Graded on the cut, not on the look that found it: the free look's frames show the moment
    // (studioShotAt), so the paid moment search is allowed and not required.
    expectTools: ["inspect_media", "video_find_moment", "video_ask"],
    paidTools: ["video_find_moment", "video_ask"],
    maxRounds: 12,
    expect: (final) => {
      const kept = footageOf(final);
      if (kept.length === 0) throw new Error("the shot is gone");
      const total = kept.reduce((n, c) => n + (Number(c.timeline_out) - Number(c.timeline_in)), 0);
      const want = STUDIO_MOMENT_FRAMES.end - STUDIO_MOMENT_FRAMES.start;
      // The moment is 60 frames. Generous, but a model that kept all 300 frames — or deleted
      // everything — fails.
      if (Math.abs(total - want) > 25)
        throw new Error(`kept ${total}f; the moment the rocket clears the tower is ${want}f`);
      // ...and what is kept is that moment, not any 60 frames of the shot.
      const peak = STUDIO_MOMENT_FRAMES.peak;
      if (!kept.some((c) => Number(c.source_in ?? 0) <= peak && peak < Number(c.source_out ?? 0)))
        throw new Error(
          `kept ${total}f, but not the moment the rocket clears the tower (frame ${peak} of the shot)`,
        );
    },
    // Any look will do; a cut made without one only holds the moment by luck.
    expectTrace: (t) => mustLook(t),
    reference: [
      call("inspect_media", { clip_id: "a" }),
      // The look: the vehicle rises at 3 s and clears the tower by 5 s.
      call("ripple_delete", {
        track_id: "v1",
        ranges: [
          { start: 0, end: 90 },
          { start: 150, end: 300 },
        ],
      }),
      say("Cut the shot down to the two seconds where the rocket rises and clears the tower."),
    ],
  },
  {
    id: "video_ask_question",
    scope: {},
    title: "Answer what only listening to the shot can tell, without editing",
    tags: ["studio", "vision", "audio", "read-only"],
    surface: "studio",
    seed: oneClip,
    // A sound that is not speech: the free look's frames, loudness and speech transcript cannot
    // say what it is, so this is the case that needs the paid look, which hears the shot.
    prompt:
      "Is there music under this shot, or is it just the sound of the launch? " +
      "Don't change anything, I'm just asking.",
    expectTools: ["video_ask"],
    paidTools: ["video_ask"],
    maxRounds: 6,
    expect: untouched(oneClip),
    expectTrace: (t) => {
      if (!called(t, "video_ask").some((c) => (c.args ?? {}).visual_only !== true))
        throw new Error("answered without a look that hears the shot (video_ask)");
      // The answer the look gave (STUDIO_SOUND): the engines, and no music.
      const said = t.finalText;
      if (!/engine|roar/i.test(said))
        throw new Error("the answer does not name the sound the look heard (the engines' roar)");
      if (
        /music/i.test(said) &&
        !/(\bno\b|\bnot\b|\bwithout\b|n't\b|\bnone\b)[^.]{0,30}\bmusic/i.test(said)
      )
        throw new Error("the answer says there is music; the look heard none");
    },
    reference: [
      call("video_ask", {
        clip_id: "a",
        prompt: "Is there music under this shot, or only the sound of the launch itself?",
      }),
      say("There is no music: the only sound is the roar of the engines. I changed nothing."),
    ],
  },
  {
    id: "compare_two_images",
    scope: {},
    title: "Compare two stills and pick one",
    tags: ["studio", "vision", "read-only"],
    surface: "studio",
    seed: () =>
      timeline([
        vtrack("v1", 0, [
          vclip("s1", "shot1.png", 0, 60, { kind: "image" }),
          vclip("s2", "shot2.png", 60, 120, { kind: "image" }),
        ]),
      ]),
    prompt:
      "Look at the two still images on my timeline (s1 and s2) and tell me which one " +
      "is better exposed. Just tell me which.",
    expectTools: ["image_ask"],
    maxRounds: 6,
    expect: untouched(() =>
      timeline([
        vtrack("v1", 0, [
          vclip("s1", "shot1.png", 0, 60, { kind: "image" }),
          vclip("s2", "shot2.png", 60, 120, { kind: "image" }),
        ]),
      ]),
    ),
    expectTrace: (t) => mustCall(t, "image_ask"),
  },
  {
    id: "crop_to_wordmark",
    scope: { change: ["logo"], remove: ["logo"], add: ["image", "video"], addTracks: true },
    title: "Crop a still to a box the user gives, and use the crop",
    tags: ["studio", "crop", "placement"],
    surface: "studio",
    seed: logoStill,
    // Was find_content_then_crop: find_content is withdrawn, and the harness attaches no pixels, so
    // a look cannot locate the wordmark. The user gives the box instead. What the case still holds
    // is the chain, now from the user to crop_image to the timeline: the crop must use THIS box
    // (in source pixels, as crop_image takes it), and the cropped still must replace the logo.
    prompt:
      "The wordmark in my logo image fills the box from x 120 to 360 and y 80 to 240, in " +
      "pixels. Crop the image down to just that box and show the crop on the timeline in place " +
      "of the full logo.",
    expectTools: ["crop_image"],
    maxRounds: 10,
    expect: (final) => {
      const crop = placed(final, STUDIO_CROP_REF);
      if (Math.abs(Number(crop.timeline_in)) > 2 || Math.abs(Number(crop.timeline_out) - 90) > 3)
        throw new Error(
          `the crop shows ${crop.timeline_in}-${crop.timeline_out}f, not where the logo was (0-90f)`,
        );
      if (allClips(final).some((c) => c.media_ref === "logo.png"))
        throw new Error("the full logo is still on the timeline beside the crop");
    },
    expectTrace: (t) => {
      const crop = called(t, "crop_image")[0];
      if (!crop) throw new Error("never cropped");
      const box = ((crop.args ?? {}) as { bbox?: Record<string, unknown> }).bbox ?? {};
      for (const [k, v] of Object.entries(STUDIO_BBOX))
        if (Math.abs(Number(box[k]) - v) > 2)
          throw new Error(`crop ${k}=${String(box[k])}, the box the user gave has ${k}=${v}`);
    },
    reference: [
      // x 120 to 360 and y 80 to 240 is a 240 x 160 box at (120, 80).
      call("crop_image", { media_ref: "logo.png", bbox: { x: 120, y: 80, w: 240, h: 160 } }),
      // Swapping the clip's source keeps its place and length (set_clip_properties media_ref).
      {
        calls: (req) => [
          [
            "set_clip_properties",
            { clip_ids: ["logo"], media_ref: repliesTo(req, "crop_image")[0]?.media_ref },
          ],
        ],
      },
      say("Cropped the logo to the wordmark box and swapped the crop in where the full logo was."),
    ],
  },
  {
    id: "research_then_caption",
    scope: { add: ["text"], addTracks: true },
    title: "Look a fact up and put it on screen",
    tags: ["studio", "research", "captions"],
    surface: "studio",
    seed: oneClip,
    // get_page is withdrawn; a web search is how the app looks something up now, and its
    // stand-in returns the page's fact in a result snippet.
    prompt:
      "Find out when the launch window at example.com opens and put that time on screen as a " +
      "caption over the first couple of seconds.",
    expectTools: ["web_search", "add_text_clips"],
    paidTools: ["web_search"],
    maxRounds: 12,
    expect: (final) => {
      const texts = allClips(final).filter((c) => c.kind === "text");
      if (texts.length === 0) throw new Error("no caption was created");
      const body = captionText(final);
      // The page says 09:40 UTC. A caption that doesn't carry the researched fact
      // means the model read the page and then made something up.
      if (!/09:?40/.test(body)) throw new Error(`caption does not carry the fact: "${body}"`);
    },
    reference: [
      call("web_search", { query: "launch window opens", site: "example.com" }),
      call("add_text_clips", {
        entries: [{ timeline_in: 0, timeline_out: 60, content: "Launch window opens 09:40 UTC" }],
      }),
      say(
        "The page says the launch window opens at 09:40 UTC; that is on screen as a caption " +
          "for the first two seconds.",
      ),
    ],
  },
  {
    id: "web_search_answer",
    scope: {},
    title: "Search the web and answer, without editing",
    tags: ["studio", "research", "read-only"],
    surface: "studio",
    seed: oneClip,
    prompt:
      "Search the web for the launch at example.com and tell me when the launch window " +
      "opens. Don't touch the edit.",
    expectTools: ["web_search"],
    paidTools: ["web_search"],
    maxRounds: 8,
    expect: untouched(oneClip),
    expectTrace: (t) => {
      mustCall(t, "web_search");
      // The answer is the time the search found (STUDIO_PAGE_TEXT), not one made up.
      if (!/\b0?9[:.h]?40\b/i.test(t.finalText))
        throw new Error("the answer does not give the time the search found (09:40 UTC)");
    },
    reference: [
      call("web_search", { query: "launch window opens", site: "example.com" }),
      say("According to example.com, the launch window opens at 09:40 UTC. I left the edit alone."),
    ],
  },
  {
    id: "screenshot_page_and_place",
    scope: { change: ["a"], add: ["image", "video"], addTracks: true },
    title: "Screenshot a page and show it on screen",
    tags: ["studio", "research", "placement"],
    surface: "studio",
    seed: oneClip,
    prompt: `Take a picture of ${STUDIO_URL} and show it for two seconds at the start.`,
    expectTools: ["get_page_image", "add_clips"],
    maxRounds: 12,
    expect: (final) => {
      const hit = placed(final, STUDIO_SCREENSHOT_REF);
      const span = Number(hit.timeline_out) - Number(hit.timeline_in);
      if (Math.abs(span - 2 * FPS) > 8)
        throw new Error(`screenshot shows for ${span}f, asked for ${2 * FPS}f`);
    },
    reference: [
      call("get_page_image", { url: STUDIO_URL }),
      {
        calls: (req) => [
          [
            "insert_clips",
            {
              at: 0,
              track_id: "v1",
              entries: [
                { media_ref: repliesTo(req, "get_page_image")[0]?.media_ref, duration: 2 * FPS },
              ],
            },
          ],
        ],
      },
      say("Took a picture of the page and opened the video with it for two seconds."),
    ],
  },

  // ── generation: make what's missing, then USE it ──────────────────────────
  {
    id: "generate_image_and_place",
    scope: { change: ["a"], add: ["image", "video"], addTracks: true },
    title: "Generate a title card and put it first",
    tags: ["studio", "generation", "placement"],
    surface: "studio",
    seed: oneClip,
    prompt: "Make me a title card image of a sunset over a launch pad and put it at the front.",
    // The model SELF-GATES here: autopilot bypasses needsApproval entirely, so nothing
    // in the client stopped it — it read `expensive: true` off the catalog and asked
    // first. The follow-up is the real user flow; do NOT pre-authorise in the prompt,
    // or the scenario stops measuring the capability and starts measuring the wording.
    followUps: ["Yes, go ahead."],
    expectTools: ["generate_image", "add_clips"],
    paidTools: ["generate_image"],
    maxRounds: 12,
    expect: (final) => {
      const hit = placed(final, STUDIO_IMAGE_REF);
      if (Number(hit.timeline_in) > 5)
        throw new Error(`title card starts at ${hit.timeline_in}f, not at the front`);
      const span = Number(hit.timeline_out) - Number(hit.timeline_in);
      if (span <= 0) throw new Error("the title card has no duration");
    },
    reference: [
      say("Generating an image uses your credits. Shall I go ahead and make the title card?"),
      call("generate_image", {
        prompt: "A title card: a warm sunset over a rocket launch pad, room for a title",
        aspect_ratio: "9:16",
      }),
      {
        calls: (req) => {
          const assets = (repliesTo(req, "generate_image")[0]?.assets ?? []) as {
            media_ref: string;
          }[];
          return [
            [
              "insert_clips",
              {
                at: 0,
                track_id: "v1",
                entries: [{ media_ref: assets[0]?.media_ref, duration: 3 * FPS }],
              },
            ],
          ];
        },
      },
      say("Made the sunset title card and put it at the front, for three seconds before the shot."),
    ],
  },
  {
    id: "generate_video_broll",
    scope: { change: ["b"], add: ["video", "audio"], addTracks: true },
    title: "Generate b-roll and cut it in",
    tags: ["studio", "generation", "placement"],
    surface: "studio",
    seed: twoClips,
    prompt: "I need a shot of clouds moving fast between these two. Make one and drop it in.",
    followUps: ["Yes, go ahead."],
    expectTools: ["generate_video", "insert_clips"],
    paidTools: ["generate_video"],
    maxRounds: 12,
    expect: (final) => {
      const hit = placed(final, STUDIO_VIDEO_REF);
      const tin = Number(hit.timeline_in);
      if (tin <= 0) throw new Error("the generated shot went to the front, not between");
      const others = allClips(final).filter((c) => c.id !== hit.id);
      if (!others.some((c) => Number(c.timeline_out) <= tin + 2))
        throw new Error("nothing sits before the generated shot");
      if (!others.some((c) => Number(c.timeline_in) >= Number(hit.timeline_out) - 2))
        throw new Error("nothing sits after the generated shot");
    },
    reference: [
      READ_TIMELINE,
      say("Generating a video uses your credits. Shall I go ahead and make the clouds shot?"),
      call("generate_video", {
        prompt: "Clouds racing across the sky, fast time-lapse",
        duration: 4,
        aspect_ratio: "9:16",
      }),
      {
        calls: (req) => [
          [
            "insert_clips",
            {
              at: 150,
              track_id: "v1",
              entries: [
                { media_ref: repliesTo(req, "generate_video")[0]?.media_ref, duration: 4 * FPS },
              ],
            },
          ],
        ],
      },
      say("Made a 4-second shot of fast clouds and dropped it in between your two clips."),
    ],
  },
  {
    id: "generate_voiceover_and_place",
    scope: { add: ["audio"], addTracks: true },
    title: "Write and place a voiceover",
    tags: ["studio", "generation", "audio"],
    surface: "studio",
    seed: oneClip,
    prompt: "Record a voiceover saying 'Welcome to the launch' and lay it under the video.",
    expectTools: ["generate_voiceover", "add_clips"],
    paidTools: ["generate_voiceover"],
    maxRounds: 12,
    expect: (final) => {
      const hit = placed(final, STUDIO_VOICEOVER_REF);
      const kind = trackKindOf(final, String(hit.id));
      if (kind !== "audio") throw new Error(`voiceover landed on a ${kind} track`);
    },
  },
  {
    id: "generate_music_bed",
    scope: { add: ["audio"], addTracks: true },
    title: "Generate a music bed under the cut",
    tags: ["studio", "generation", "audio"],
    surface: "studio",
    seed: oneClip,
    prompt: "This needs music. Make something calm and instrumental and put it underneath.",
    expectTools: ["generate_music", "add_clips"],
    paidTools: ["generate_music"],
    maxRounds: 12,
    expect: (final) => {
      const hit = placed(final, STUDIO_MUSIC_REF);
      const kind = trackKindOf(final, String(hit.id));
      if (kind !== "audio") throw new Error(`music landed on a ${kind} track`);
    },
    reference: [
      READ_TIMELINE,
      call("generate_music", { prompt: "calm, gentle ambient bed", instrumental: true }),
      // Its length is not known until it is made, so it goes in at its own length.
      {
        calls: (req) => [
          [
            "add_clips",
            {
              entries: [
                { media_ref: repliesTo(req, "generate_music")[0]?.media_ref, timeline_in: 0 },
              ],
            },
          ],
        ],
      },
      say(
        "Made a calm instrumental bed and laid it under the video from the start, on its own audio track.",
      ),
    ],
  },
  {
    id: "list_models_before_generating",
    scope: {},
    title: "Answer what generation models are available",
    tags: ["studio", "generation", "read-only"],
    surface: "studio",
    seed: oneClip,
    prompt: "What can you generate video with, and how long can the clips be?",
    expectTools: ["list_models"],
    maxRounds: 6,
    expect: untouched(oneClip),
    // Asking about capability must not burn a generation call: no paid tool is allowed here, so
    // the oracle's paid-tool check fails any of them (it used to name generate_video alone).
    expectTrace: (t) => {
      mustCall(t, "list_models");
      // The answer is the list's: Veo, whose clips run up to 8 seconds.
      if (!/veo/i.test(t.finalText) || !/\b(8|eight)\b/i.test(t.finalText))
        throw new Error(
          "the answer does not give the model and the clip lengths list_models reported",
        );
    },
    reference: [
      call("list_models", { type: "video" }),
      say(
        "Video is made with Veo. Each clip can be 4, 6 or 8 seconds long, at 720p or 1080p, in " +
          "16:9 or 9:16.",
      ),
    ],
  },
  // ── project lifecycle ────────────────────────────────────────────────────
  {
    id: "project_rename",
    scope: {},
    title: "Rename the project",
    tags: ["studio", "project"],
    surface: "studio",
    seed: oneClip,
    prompt: "Call this project 'Summer Reel' from now on.",
    expectTools: ["rename_project"],
    maxRounds: 6,
    expect: untouched(oneClip),
    expectTrace: (t) => {
      const hit = called(t, "rename_project")[0];
      if (!hit) throw new Error("never renamed the project");
      if (!/summer reel/i.test(JSON.stringify(hit.args)))
        throw new Error(`renamed to the wrong thing: ${JSON.stringify(hit.args)}`);
    },
    reference: [
      call("rename_project", { name: "Summer Reel" }),
      say("The project is now called 'Summer Reel'."),
    ],
  },
  {
    id: "project_new_for_side_idea",
    title: "Start a separate project at a given spec",
    tags: ["studio", "project"],
    surface: "studio",
    seed: oneClip,
    prompt: "Start me a separate project called 'Teaser', vertical, at 24 frames a second.",
    expectTools: ["new_project"],
    maxRounds: 8,
    expectTrace: (t) => {
      const hit = called(t, "new_project")[0];
      if (!hit) throw new Error("never created the project");
      const raw = JSON.stringify(hit.args);
      if (!/teaser/i.test(raw)) throw new Error(`wrong name: ${raw}`);
      if (!/\b24\b/.test(raw)) throw new Error(`fps 24 was not carried through: ${raw}`);
    },
    reference: [
      call("new_project", { name: "Teaser", aspect_ratio: "9:16", fps: 24 }),
      say(
        "Created a separate project called 'Teaser', vertical (9:16) at 24 fps. It is in your " +
          "project list; this project stays open.",
      ),
    ],
  },
  {
    id: "project_duplicate_before_risk",
    scope: {},
    title: "Copy the project before experimenting",
    tags: ["studio", "project"],
    surface: "studio",
    seed: oneClip,
    prompt: "Before we try anything drastic, make me a copy of this project called 'backup'.",
    expectTools: ["duplicate_project"],
    maxRounds: 8,
    expect: untouched(oneClip),
    expectTrace: (t) => mustCall(t, "duplicate_project"),
    reference: [
      call("duplicate_project", { name: "backup" }),
      say("Made a copy of this project called 'backup'; we are still working in the original."),
    ],
  },
  {
    id: "project_list_and_open",
    title: "List projects and switch to one",
    tags: ["studio", "project"],
    surface: "studio",
    seed: oneClip,
    prompt: "What other projects do I have? Open the teaser one.",
    expectTools: ["list_projects", "open_project"],
    maxRounds: 8,
    expectTrace: (t) => {
      mustCall(t, "list_projects");
      const open = called(t, "open_project")[0];
      if (!open) throw new Error("never opened the other project");
      if (!/teaser/i.test(JSON.stringify(open.args)))
        throw new Error(`opened the wrong project: ${JSON.stringify(open.args)}`);
    },
  },
  {
    id: "project_state_question",
    scope: {},
    title: "Answer what the project is set to",
    tags: ["studio", "project", "read-only"],
    surface: "studio",
    seed: oneClip,
    prompt: "Remind me what this project's canvas and frame rate are.",
    // A settings QUESTION must never become a settings CHANGE.
    mustNotCall: ["set_project_settings"],
    maxRounds: 6,
    expect: untouched(oneClip),
    expectTrace: (t) => {
      const read = called(t, "get_project_state").length + called(t, "get_timeline").length;
      // The app can hand the model the project with its message; then it has read it without a call.
      if (read === 0 && !t.stateBlock) throw new Error("answered without reading the project");
      // Either way the answer is the project's real canvas and frame rate, not a guess: a read
      // followed by a wrong answer used to pass.
      const { width, height, fps } = oneClip().canvas;
      for (const value of [width, height, fps]) {
        if (!t.finalText.includes(String(value)))
          throw new Error(`answered without the project's real canvas and frame rate (${value})`);
      }
    },
    reference: [
      call("get_project_state"),
      say("The canvas is 1080 by 1920 (vertical, 9:16) and the frame rate is 30 fps."),
    ],
  },
  {
    id: "project_pack_for_handoff",
    scope: {},
    title: "Package the project to hand off",
    tags: ["studio", "project", "deliverable"],
    surface: "studio",
    seed: oneClip,
    prompt: "Bundle this whole project up so I can send it to my editor.",
    expectTools: ["pack_project"],
    maxRounds: 8,
    expectTrace: (t) => mustCall(t, "pack_project"),
    reference: [
      call("pack_project"),
      say(
        "Bundled the whole project, media included, into current-cut.artdaddy.zip in your " +
          "Downloads folder. Send that file to your editor.",
      ),
    ],
  },

  // ── library ──────────────────────────────────────────────────────────────
  {
    id: "library_tag_broll",
    scope: {},
    title: "Find library assets and tag them",
    tags: ["studio", "library"],
    surface: "studio",
    seed: oneClip,
    prompt: "Go through my library and tag the b-roll clips as 'broll'.",
    expectTools: ["library_op"],
    maxRounds: 10,
    expectTrace: (t) => {
      const ops = called(t, "library_op");
      if (ops.length === 0) throw new Error("never touched the library");
      const actions = ops.map((o) => String((o.args ?? {}).action ?? ""));
      if (!actions.includes("list")) throw new Error(`never listed the library (${actions})`);
      if (!actions.includes("update")) throw new Error(`never tagged anything (${actions})`);
    },
  },
  {
    id: "library_place_from_catalog",
    scope: { add: ["video", "audio"], addTracks: true },
    title: "Put a library asset on the timeline by description",
    tags: ["studio", "library", "placement"],
    surface: "studio",
    seed: oneClip,
    prompt: "I've got an ocean shot somewhere in my library. Find it and put it on the end.",
    expectTools: ["library_op", "add_clips"],
    maxRounds: 12,
    expect: (final) => {
      const hit = placed(final, "media_broll_ocean");
      if (Number(hit.timeline_in) < 300 - 2)
        throw new Error(`placed at ${hit.timeline_in}f, not on the end`);
    },
    reference: [
      READ_TIMELINE,
      call("library_op", { action: "list" }),
      call("add_clips", {
        entries: [{ media_ref: "media_broll_ocean", track_id: "v1", timeline_in: 300 }],
      }),
      say("Found ocean.mp4 in your b-roll folder and put it on the end, after your shot."),
    ],
  },

  // ── escape hatch: the tool it should NOT reach for ───────────────────────
  {
    id: "no_ffmpeg_for_speed",
    scope: { change: ["a", "m"] },
    title: "A first-class tool exists — don't shell out",
    tags: ["studio", "escape-hatch"],
    surface: "studio",
    seed: clipPlusMusic,
    prompt: "Speed the video up to double and drop the music to about a third.",
    expectTools: ["set_clip_properties"],
    flagTools: ["run_ffmpeg"],
    // The whole point: a raw-ffmpeg detour here is a capability-model failure, not a shortcut. It
    // bypasses the timeline entirely and the user's undo stack.
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 10,
    expect: (final) => {
      const v = clipsOf(final, "v1")[0];
      const speed = Number((v as Record<string, unknown>)?.speed ?? 1);
      if (Math.abs(speed - 2) > 0.05) throw new Error(`speed is ${speed}, expected 2`);
      const m = clipsOf(final, "a1")[0];
      const vol = Number((m as Record<string, unknown>)?.volume ?? 1);
      if (vol < 0.2 || vol > 0.45) throw new Error(`music volume ${vol}, expected ≈0.33`);
    },
    reference: [
      READ_TIMELINE,
      calls(
        ["set_clip_properties", { clip_ids: ["a"], speed: 2 }],
        ["set_clip_properties", { clip_ids: ["m"], volume: 0.33 }],
      ),
      say("The video plays at double speed, and the music is down to about a third."),
    ],
  },
];
