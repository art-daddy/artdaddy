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
  STUDIO_DOWNLOAD_REF,
  STUDIO_IMAGE_REF,
  STUDIO_MOMENT_FRAMES,
  STUDIO_MUSIC_REF,
  STUDIO_SCREENSHOT_REF,
  STUDIO_URL,
  STUDIO_VIDEO_REF,
  STUDIO_VOICEOVER_REF,
} from "../studio";
import type { Scenario, Trace } from "../types";
import { aclip, allClips, atrack, clipsOf, timeline, vclip, vtrack } from "./helpers";

const FPS = 30;

// ── local graders ────────────────────────────────────────────────────────────

function called(trace: Trace, name: string) {
  return trace.toolCalls.filter((c) => c.name === name && c.ok);
}
function mustCall(trace: Trace, name: string): void {
  if (called(trace, name).length === 0) throw new Error(`never called ${name}`);
}
function mustNotCall(trace: Trace, name: string): void {
  const hits = trace.toolCalls.filter((c) => c.name === name);
  if (hits.length > 0) throw new Error(`reached for ${name} (${hits.length}×) when it shouldn't`);
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
const emptyProject = () => timeline([], { width: 1920, height: 1080, fps: FPS });
const logoStill = () =>
  timeline([vtrack("v1", 0, [vclip("logo", "logo.png", 0, 90, { kind: "image" })])]);

export const STUDIO_SCENARIOS: Scenario[] = [
  // ── structural gaps the timeline surface already supports ──────────────────
  {
    id: "add_track_for_overlay",
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
  },
  {
    id: "redo_after_undo",
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
  },

  // ── inspection: look before you edit ──────────────────────────────────────
  {
    id: "inspect_color_then_warm",
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
      const effects = (c?.effects ?? []) as Record<string, unknown>[];
      const hasGrade = Object.keys(color).length > 0 || effects.length > 0;
      if (!hasGrade) throw new Error("measured the shot but never graded it");
      // The stub reports warm_cool -0.13 and saturation 0.11 — a fix must push
      // temperature warm or saturation up, not just author an inert block.
      const temp = Number(color.temperature ?? color.temp ?? 0);
      const sat = Number(color.saturation ?? 0);
      if (temp <= 0 && sat <= 0 && effects.length === 0)
        throw new Error(`grade does not warm or saturate (temp ${temp}, sat ${sat})`);
    },
    expectTrace: (t) => mustCall(t, "inspect_color"),
  },
  {
    id: "inspect_timeline_check",
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
      // 2s at 30fps = frame 60. The model must not make the user do fps math for it.
      const call = called(t, "inspect_timeline")[0];
      const raw = JSON.stringify(call.args);
      if (!/\b60\b/.test(raw)) throw new Error(`inspected the wrong frame: ${raw}`);
    },
  },
  {
    id: "inspect_media_before_place",
    title: "Look at the footage before choosing where to cut",
    tags: ["studio", "inspect"],
    surface: "studio",
    seed: oneClip,
    prompt: "What's actually in this shot? Have a look and then cut the boring opening off.",
    expectTools: ["inspect_media"],
    maxRounds: 10,
    expect: (final) => {
      const c = clipsOf(final, "v1")[0];
      if (!c) throw new Error("the clip is gone");
      const span = Number(c.timeline_out) - Number(c.timeline_in);
      if (span >= 300) throw new Error("nothing was trimmed");
      if (span < 30) throw new Error(`trimmed to almost nothing (${span}f)`);
    },
  },

  // ── media in: find it, fetch it, place it ─────────────────────────────────
  {
    id: "download_and_place",
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
  },
  {
    id: "search_then_fetch",
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
    title: "Answer how long a video is without downloading it",
    tags: ["studio", "metadata", "read-only"],
    surface: "studio",
    seed: oneClip,
    prompt: `How long is ${STUDIO_URL}, and what are its chapters? Don't bring it in yet.`,
    expectTools: ["video_get_metadata"],
    maxRounds: 6,
    expect: untouched(oneClip),
    expectTrace: (t) => {
      mustCall(t, "video_get_metadata");
      // Reading metadata is the cheap path; pulling the file is not.
      mustNotCall(t, "download_video");
    },
  },
  {
    id: "probe_before_trusting",
    title: "Check the real resolution of a source",
    tags: ["studio", "probe", "read-only"],
    surface: "studio",
    seed: oneClip,
    prompt: "Is the footage in this project actually 4K, or is it upscaled? Just check.",
    expectTools: ["probe_media"],
    maxRounds: 6,
    expect: untouched(oneClip),
    expectTrace: (t) => {
      // Either read answers "what resolution is this" honestly; demanding the exact
      // tool would grade the instruction instead of the outcome. What must NOT
      // happen is answering from thin air.
      if (called(t, "probe_media").length + called(t, "inspect_media").length === 0)
        throw new Error("answered without inspecting the media");
    },
  },
  {
    id: "clip_window_from_source",
    title: "Pull one window out of a long source",
    tags: ["studio", "clip_video"],
    surface: "studio",
    seed: emptyProject,
    prompt:
      `Take ${STUDIO_URL} — I only want the bit from two minutes in to two and a half ` +
      "minutes. Get just that and put it on the timeline.",
    expectTools: ["clip_video", "add_clips"],
    maxRounds: 12,
    expect: (final) => {
      if (allClips(final).length === 0) throw new Error("nothing reached the timeline");
    },
  },

  // ── vision: look at it, then act on what you saw ──────────────────────────
  {
    id: "find_moment_and_trim",
    title: "Find the best moment and cut to it",
    tags: ["studio", "vision", "trim"],
    surface: "studio",
    seed: oneClip,
    prompt: "Find the moment the rocket clears the tower and cut this down to just that.",
    expectTools: ["video_find_moment"],
    maxRounds: 12,
    expect: (final) => {
      const clips = allClips(final).filter((c) => c.kind !== "text");
      if (clips.length === 0) throw new Error("the timeline is empty");
      const total = clips.reduce((n, c) => n + (Number(c.timeline_out) - Number(c.timeline_in)), 0);
      const want = STUDIO_MOMENT_FRAMES.end - STUDIO_MOMENT_FRAMES.start;
      // The reported moment is 60 frames. Generous, but a model that ignored the
      // search result and kept all 300 frames — or deleted everything — fails.
      if (Math.abs(total - want) > 25)
        throw new Error(`kept ${total}f; the moment the search returned is ${want}f`);
    },
    expectTrace: (t) => mustCall(t, "video_find_moment"),
  },
  {
    id: "video_ask_question",
    title: "Answer a question about the footage without editing",
    tags: ["studio", "vision", "read-only"],
    surface: "studio",
    seed: oneClip,
    prompt: "What happens in this shot? Don't change anything, I'm just asking.",
    expectTools: ["video_ask"],
    maxRounds: 6,
    expect: untouched(oneClip),
    expectTrace: (t) => mustCall(t, "video_ask"),
  },
  {
    id: "describe_the_logo",
    title: "Describe a still image in the project",
    tags: ["studio", "vision", "read-only"],
    surface: "studio",
    seed: logoStill,
    prompt: "Describe the logo image for me — colours, background, that sort of thing.",
    expectTools: ["vision_describe"],
    maxRounds: 6,
    expect: untouched(logoStill),
  },
  {
    id: "compare_two_images",
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
    id: "find_content_then_crop",
    title: "Locate the logo in a frame and crop to it",
    tags: ["studio", "vision", "crop"],
    surface: "studio",
    seed: logoStill,
    prompt: "There's a wordmark in that image — crop it down to just the wordmark.",
    expectTools: ["find_content", "crop_image"],
    maxRounds: 10,
    expectTrace: (t) => {
      mustCall(t, "find_content");
      const crop = called(t, "crop_image")[0];
      if (!crop) throw new Error("found the wordmark but never cropped");
      // The chain is the point: the crop must use the box the search returned,
      // not a box the model invented. This is what a "did it read the reply?" test
      // has to assert — calling both tools proves nothing on its own.
      const raw = JSON.stringify(crop.args);
      for (const [k, v] of Object.entries(STUDIO_BBOX)) {
        if (!new RegExp(`\\b${v}\\b`).test(raw))
          throw new Error(`crop ignored the located bbox (${k}=${v} missing from ${raw})`);
      }
    },
  },
  {
    id: "research_then_caption",
    title: "Read a page and put a fact on screen",
    tags: ["studio", "research", "captions"],
    surface: "studio",
    seed: oneClip,
    prompt:
      `Read ${STUDIO_URL} and put the launch time on screen as a caption over the first ` +
      "couple of seconds.",
    expectTools: ["get_page", "add_text_clips"],
    maxRounds: 12,
    expect: (final) => {
      const texts = allClips(final).filter((c) => c.kind === "text");
      if (texts.length === 0) throw new Error("no caption was created");
      const body = captionText(final);
      // The page says 09:40 UTC. A caption that doesn't carry the researched fact
      // means the model read the page and then made something up.
      if (!/09:?40/.test(body)) throw new Error(`caption does not carry the fact: "${body}"`);
    },
  },
  {
    id: "web_search_answer",
    title: "Search the web and answer, without editing",
    tags: ["studio", "research", "read-only"],
    surface: "studio",
    seed: oneClip,
    prompt:
      "Search the web for the launch at example.com and tell me when the launch window " +
      "opens. Don't touch the edit.",
    expectTools: ["web_search"],
    maxRounds: 8,
    expect: untouched(oneClip),
    expectTrace: (t) => mustCall(t, "web_search"),
  },
  {
    id: "screenshot_page_and_place",
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
  },

  // ── generation: make what's missing, then USE it ──────────────────────────
  {
    id: "generate_image_and_place",
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
    maxRounds: 12,
    expect: (final) => {
      const hit = placed(final, STUDIO_IMAGE_REF);
      if (Number(hit.timeline_in) > 5)
        throw new Error(`title card starts at ${hit.timeline_in}f, not at the front`);
      const span = Number(hit.timeline_out) - Number(hit.timeline_in);
      if (span <= 0) throw new Error("the title card has no duration");
    },
  },
  {
    id: "generate_video_broll",
    title: "Generate b-roll and cut it in",
    tags: ["studio", "generation", "placement"],
    surface: "studio",
    seed: twoClips,
    prompt: "I need a shot of clouds moving fast between these two. Make one and drop it in.",
    followUps: ["Yes, go ahead."],
    expectTools: ["generate_video", "insert_clips"],
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
  },
  {
    id: "generate_voiceover_and_place",
    title: "Write and place a voiceover",
    tags: ["studio", "generation", "audio"],
    surface: "studio",
    seed: oneClip,
    prompt: "Record a voiceover saying 'Welcome to the launch' and lay it under the video.",
    expectTools: ["generate_voiceover", "add_clips"],
    maxRounds: 12,
    expect: (final) => {
      const hit = placed(final, STUDIO_VOICEOVER_REF);
      const kind = trackKindOf(final, String(hit.id));
      if (kind !== "audio") throw new Error(`voiceover landed on a ${kind} track`);
    },
  },
  {
    id: "generate_music_bed",
    title: "Generate a music bed under the cut",
    tags: ["studio", "generation", "audio"],
    surface: "studio",
    seed: oneClip,
    prompt: "This needs music. Make something calm and instrumental and put it underneath.",
    expectTools: ["generate_music", "add_clips"],
    maxRounds: 12,
    expect: (final) => {
      const hit = placed(final, STUDIO_MUSIC_REF);
      const kind = trackKindOf(final, String(hit.id));
      if (kind !== "audio") throw new Error(`music landed on a ${kind} track`);
    },
  },
  {
    id: "list_models_before_generating",
    title: "Answer what generation models are available",
    tags: ["studio", "generation", "read-only"],
    surface: "studio",
    seed: oneClip,
    prompt: "What can you generate video with, and how long can the clips be?",
    expectTools: ["list_models"],
    maxRounds: 6,
    expect: untouched(oneClip),
    expectTrace: (t) => {
      mustCall(t, "list_models");
      // Asking about capability must not burn a generation call.
      mustNotCall(t, "generate_video");
    },
  },
  // ── project lifecycle ────────────────────────────────────────────────────
  {
    id: "project_rename",
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
  },
  {
    id: "project_duplicate_before_risk",
    title: "Copy the project before experimenting",
    tags: ["studio", "project"],
    surface: "studio",
    seed: oneClip,
    prompt: "Before we try anything drastic, make me a copy of this project called 'backup'.",
    expectTools: ["duplicate_project"],
    maxRounds: 8,
    expect: untouched(oneClip),
    expectTrace: (t) => mustCall(t, "duplicate_project"),
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
    title: "Answer what the project is set to",
    tags: ["studio", "project", "read-only"],
    surface: "studio",
    seed: oneClip,
    prompt: "Remind me what this project's canvas and frame rate are.",
    maxRounds: 6,
    expect: untouched(oneClip),
    expectTrace: (t) => {
      const read = called(t, "get_project_state").length + called(t, "get_timeline").length;
      if (read === 0) throw new Error("answered without reading the project");
      // A settings QUESTION must never become a settings CHANGE.
      mustNotCall(t, "set_project_settings");
    },
  },
  {
    id: "project_pack_for_handoff",
    title: "Package the project to hand off",
    tags: ["studio", "project", "deliverable"],
    surface: "studio",
    seed: oneClip,
    prompt: "Bundle this whole project up so I can send it to my editor.",
    expectTools: ["pack_project"],
    maxRounds: 8,
    expectTrace: (t) => mustCall(t, "pack_project"),
  },

  // ── library ──────────────────────────────────────────────────────────────
  {
    id: "library_tag_broll",
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
  },

  // ── escape hatch: the tool it should NOT reach for ───────────────────────
  {
    id: "no_ffmpeg_for_speed",
    title: "A first-class tool exists — don't shell out",
    tags: ["studio", "escape-hatch"],
    surface: "studio",
    seed: clipPlusMusic,
    prompt: "Speed the video up to double and drop the music to about a third.",
    expectTools: ["set_clip_properties"],
    flagTools: ["run_ffmpeg"],
    maxRounds: 10,
    expect: (final) => {
      const v = clipsOf(final, "v1")[0];
      const speed = Number((v as Record<string, unknown>)?.speed ?? 1);
      if (Math.abs(speed - 2) > 0.05) throw new Error(`speed is ${speed}, expected 2`);
      const m = clipsOf(final, "a1")[0];
      const vol = Number((m as Record<string, unknown>)?.volume ?? 1);
      if (vol < 0.2 || vol > 0.45) throw new Error(`music volume ${vol}, expected ≈0.33`);
    },
    expectTrace: (t) => {
      // The whole point: a raw-ffmpeg detour here is a capability-model failure,
      // not a shortcut. It bypasses the timeline entirely and the user's undo stack.
      mustNotCall(t, "run_ffmpeg");
    },
  },
];

/** Kept, not deleted, for tools withdrawn from the served catalog: the model is no longer offered
 *  them, so running one of these would fail on the withdrawal rather than on the behaviour it
 *  tests. Bringing the tool back is moving the scenario up into the list above. */
export const WITHDRAWN_SCENARIOS: Scenario[] = [
  {
    id: "extract_style_from_reference",
    title: "Turn reference edits into a reusable style",
    tags: ["studio", "style"],
    surface: "studio",
    seed: oneClip,
    prompt:
      "I like how ref1.mp4 and ref2.mp4 are cut. Work out that style and save it as " +
      "'punchy' so we can reuse it.",
    expectTools: ["extract_style"],
    maxRounds: 10,
    expectTrace: (t) => mustCall(t, "extract_style"),
  },
];
