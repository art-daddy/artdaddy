// Studio surface for the eval harness — deterministic stand-ins for every
// NON-timeline tool in the contract (research, vision, generation, project
// lifecycle, library, inspection, media I/O).
//
// WHY STAND-INS RATHER THAN REAL CALLS: the eval asks whether the MODEL can drive
// the CONTRACT — does it pick the right tool, shape the arguments correctly, read
// the reply, and carry the result through to the timeline? Whether Gemini really
// describes an image, or ffmpeg really burns pixels, is a different question that
// the pixel/smoke lane already answers. Making these calls for real would put
// paid inference, live YouTube, and the open web on the critical path of EVERY
// eval run — money, minutes, and flake, buying no extra signal about the model.
//
// WHAT MAKES A STUB HONEST (all three are load-bearing):
//   1. It mirrors the REAL tool's success shape key-for-key, including the
//      frames-vs-seconds discriminator (`clip_id` ⇒ project frames, `media_ref` ⇒
//      source seconds). A stub that invents a shape teaches the model a fiction
//      and the eval would grade against that fiction.
//   2. It returns media_refs the REAL timeline tools then accept, so a scenario
//      can assert the OUTCOME on the timeline ("the generated image is on screen
//      at frame 0") instead of the instruction ("generate_image was called").
//      Per the repo test standard, the call is not the evidence — the artifact is.
//   3. Its facts are FIXED and exported, so a grader asserts the model carried
//      THIS bbox / THIS moment through, not merely that it called something.
import type { ClientToolRegistry } from "../tools/registry";
import {
  mediaLookTimes,
  planTimelineLook,
  timelineLookFrames,
  visibleClips,
} from "../tools/inspect";
import { GRID_NOTE } from "../tools/inspectOverlay";
import { slimMetadata } from "../tools/net";
import { resolveRenderPlan } from "../timeline/renderPlan";
import type { Timeline } from "../timeline/model";
import { kindOf } from "../media/formats";
import { isWebUrl } from "../../scripts/webUrl.mjs";
import { registerJourneyStubs, type JourneyState } from "./journey";

/** What the studio stubs recorded, for a scenario's `expectTrace` grader. */
export interface StudioState extends JourneyState {
  generated: { media_ref: string; kind: string; prompt: string }[];
  downloads: { media_ref: string; url: string }[];
  searches: { query: string; engine: string }[];
  pages: { url: string; artifact: string }[];
  projects: { id: string; name: string }[];
  /** Projects switched to over MCP (manage_project open, studioManageProject), in order. */
  opened: string[];
  libraryOps: { action: string; id?: string }[];
  ffmpegCalls: { command: string }[];
  packs: { path: string }[];
  inspections: { tool: string; subject: string }[];
}

export function emptyStudioState(): StudioState {
  return {
    imported: [],
    exports: [],
    generated: [],
    downloads: [],
    searches: [],
    pages: [],
    projects: [],
    opened: [],
    libraryOps: [],
    ffmpegCalls: [],
    packs: [],
    inspections: [],
  };
}

// ── fixed facts a grader can assert the model carried through ────────────────

/** The one moment `video_find_moment` ever reports, in BOTH unit domains.
 *  A scenario that asks the model to trim to "the best bit" is graded on whether
 *  the clip really ends up spanning THIS window — not on the call happening. */
export const STUDIO_MOMENT_FRAMES = { start: 90, end: 150, peak: 120 } as const;
export const STUDIO_MOMENT_SECONDS = { start: 3, end: 5, peak: 4 } as const;

/** The footage the studio seeds place (clip `a`): the launch every look at it describes. Nothing
 *  moves until the vehicle rises at the moment's start, it clears the tower at the peak, and it
 *  climbs away after the moment's end. */
export const STUDIO_FOOTAGE_REF = "a.mp4";

/** What a frame of the footage shows, `seconds` into it, in words: the stand-in for the picture a
 *  real look attaches, and the same story video_ask and video_find_moment tell. */
export function studioShotAt(seconds: number): string {
  if (seconds < STUDIO_MOMENT_SECONDS.start)
    return "a wide shot of the launch pad, nothing moving yet";
  if (seconds <= STUDIO_MOMENT_SECONDS.end)
    return "the vehicle rising off the pad and clearing the tower";
  return "the vehicle climbing away on a column of smoke";
}

/** What the footage sounds like: only a look that hears it (video_ask) can say. */
export const STUDIO_SOUND = "The only sound is the roar of the engines: no music, no voices.";

/** The one bbox `find_content` ever reports. `crop_image` must be handed THIS. */
export const STUDIO_BBOX = { x: 120, y: 80, w: 240, h: 160 } as const;
export const STUDIO_IMAGE_SIZE = { w: 1080, h: 1920 } as const;

/** Refs the generation stubs mint. Scenarios assert these land on the timeline. */
export const STUDIO_IMAGE_REF = "media_gen_image_1";
export const STUDIO_VIDEO_REF = "media_gen_video_1";
export const STUDIO_VOICEOVER_REF = "media_gen_voiceover_1";
export const STUDIO_MUSIC_REF = "media_gen_music_1";
export const STUDIO_CROP_REF = "media_crop_1";
export const STUDIO_DOWNLOAD_REF = "media_download_1";
export const STUDIO_CLIP_REF = "media_clipped_1";
export const STUDIO_SCREENSHOT_REF = "media_page_shot_1";

/** The library catalog `library_op` reports. Two b-roll items, a music bed, and
 *  the stills the scenarios seed onto the timeline — a model that goes looking for
 *  a placed clip in the library must FIND it, or the fixture contradicts itself. */
export const STUDIO_LIBRARY = [
  { id: "media_broll_city", filename: "city.mp4", kind: "video", folder: "broll" },
  { id: "media_broll_ocean", filename: "ocean.mp4", kind: "video", folder: "broll" },
  { id: "media_bed", filename: "bed.mp3", kind: "audio", folder: "music" },
  { id: "logo.png", filename: "logo.png", kind: "image", folder: "stills" },
  { id: "shot1.png", filename: "shot1.png", kind: "image", folder: "stills" },
  { id: "shot2.png", filename: "shot2.png", kind: "image", folder: "stills" },
  { id: "a.mp4", filename: "a.mp4", kind: "video", folder: "footage" },
] as const;

/** One item of the library as the studio stand-in keeps it through a run. */
interface LibraryRow {
  id: string;
  filename: string;
  kind: string;
  folder: string;
  tags?: string[];
  notes?: string;
}

/** The person's projects, the open one first: the case's timeline is the open project's. */
export const STUDIO_PROJECTS = [
  { id: "proj_current", name: "Current cut", lastOpenedAt: "2026-08-01T10:00:00Z" },
  { id: "proj_teaser", name: "Teaser", lastOpenedAt: "2026-07-28T09:00:00Z" },
] as const;

type StudioProject = { id: string; name: string; lastOpenedAt: string };

/** The projects as the stand-ins report them now: the known ones with any rename applied, then
 *  any the run created. */
function projectsNow(state: StudioState): StudioProject[] {
  const out: StudioProject[] = STUDIO_PROJECTS.map((p) => ({ ...p }));
  for (const p of state.projects) {
    const known = out.find((o) => o.id === p.id);
    if (known) known.name = p.name;
    else out.push({ id: p.id, name: p.name, lastOpenedAt: STUDIO_PROJECTS[0].lastOpenedAt });
  }
  return out;
}

/** The project the tools act on: the open one, unless the run switched over MCP. */
function activeProject(state: StudioState): StudioProject {
  const all = projectsNow(state);
  const id = state.opened[state.opened.length - 1] ?? STUDIO_PROJECTS[0].id;
  return all.find((p) => p.id === id) ?? all[0];
}

/** manage_project, the tool the app answers itself over MCP (mcp/bridge.ts), over the stand-ins'
 *  projects, in the app's reply shapes. A runner that serves the studio cases over MCP answers
 *  `list`, `current` and `open` with this, so the door, list_projects and open_project tell one
 *  story: the host knew only the open project, and refused to open the Teaser that list_projects
 *  had just listed. Null for an action it leaves to the runner (`create`, or one it does not
 *  have). A successful open switches the project `current` reports, and is recorded in `opened`. */
export function studioManageProject(
  state: StudioState,
  args: Record<string, unknown>,
): { ok: boolean; reply: Record<string, unknown> | string } | null {
  const action = String(args.action ?? "");
  if (action === "list") {
    const all = projectsNow(state);
    const projects = all.map((p) => ({ id: p.id, name: p.name }));
    return { ok: true, reply: { active_id: activeProject(state).id, projects } };
  }
  if (action === "current") {
    const active = activeProject(state);
    return { ok: true, reply: { active_id: active.id, name: active.name } };
  }
  if (action !== "open") return null;
  const id = String(args.id ?? "");
  if (!id) return { ok: false, reply: "open requires 'id' (from action='list')" };
  if (!projectsNow(state).some((p) => p.id === id))
    return { ok: false, reply: { opened: id, ready: false, reason: "no such project" } };
  state.opened.push(id);
  return { ok: true, reply: { opened: id, ready: true } };
}

/** The one URL the research stubs know about, and what they say about it. */
export const STUDIO_URL = "https://example.com/launch";
export const STUDIO_PAGE_ARTIFACT = "artifacts/page_1.html";
export const STUDIO_PAGE_TEXT =
  "The launch window opens at 09:40 UTC and the booster returns to the pad eight minutes later.";

/** The YouTube videos the search stand-in finds for any query, in rank order. The short is listed
 *  only when the search asks for shorts, as the real tool does. */
export const STUDIO_REPLAY_URL = "https://www.youtube.com/watch?v=Orb1tReplay";
export const STUDIO_HIGHLIGHTS_URL = "https://www.youtube.com/watch?v=Orb1tHilite";
export const STUDIO_SHORT_URL = "https://www.youtube.com/shorts/Orb1tShort1";
/** What downloading the YouTube replay brings into the library. */
export const STUDIO_REPLAY_REF = "media_download_replay";

/** A video the research stand-ins know. A search lists it, a metadata read describes it and a
 *  download brings it in, and all three tell the same story: a "12:34 full replay" whose links
 *  were not YouTube's and whose download ran 12 s made a careful agent refuse to place it. */
interface StudioVideo {
  url: string;
  /** What its download mints: the library keeps one entry per file, so fetching it again gives
   *  the same ref. */
  media_ref: string;
  title: string;
  duration_s: number;
  is_short: boolean;
  description: string;
  chapters: { start_s: number; end_s: number; title: string }[];
  view_count: number;
  was_live: boolean;
}

const LAUNCH_CHAPTERS = [
  { start_s: 0, end_s: 120, title: "Countdown" },
  { start_s: 120, end_s: 300, title: "Liftoff" },
  { start_s: 300, end_s: 754, title: "Booster return" },
];

const STUDIO_VIDEOS: readonly StudioVideo[] = [
  {
    url: STUDIO_REPLAY_URL,
    media_ref: STUDIO_REPLAY_REF,
    title: "Rocket launch — full replay",
    duration_s: 754,
    is_short: false,
    description: "Full replay of the launch window and booster return.",
    chapters: LAUNCH_CHAPTERS,
    view_count: 184_000,
    was_live: true,
  },
  {
    url: STUDIO_HIGHLIGHTS_URL,
    media_ref: "media_download_highlights",
    title: "Rocket launch — highlights",
    duration_s: 125,
    is_short: false,
    description: "The best two minutes of the launch: liftoff and the booster landing.",
    chapters: [],
    view_count: 96_000,
    was_live: false,
  },
  {
    url: STUDIO_SHORT_URL,
    media_ref: "media_download_short",
    title: "Launch in 30 seconds",
    duration_s: 30,
    is_short: true,
    description: "The launch, sped up.",
    chapters: [],
    view_count: 410_000,
    was_live: false,
  },
  {
    // The page the other research stand-ins describe carries the full replay too.
    url: STUDIO_URL,
    media_ref: STUDIO_DOWNLOAD_REF,
    title: "Rocket launch — full replay",
    duration_s: 754,
    is_short: false,
    description: "Full replay of the launch window and booster return.",
    chapters: LAUNCH_CHAPTERS,
    view_count: 184_000,
    was_live: true,
  },
];

/** A YouTube link's video id, in any of the forms YouTube links take; null for any other site. */
function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
    if (host === "youtu.be") return u.pathname.split("/")[1] || null;
    if (host !== "youtube.com") return null;
    if (u.pathname === "/watch") return u.searchParams.get("v");
    return /^\/(?:shorts|embed|live)\/([^/]+)/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The known video at a link, matched as the site would: a YouTube video by its id, any other page
 *  by its address. */
function videoAt(url: string): StudioVideo | undefined {
  const id = youtubeId(url);
  if (id) return STUDIO_VIDEOS.find((v) => youtubeId(v.url) === id);
  const bare = url.trim().replace(/\/+$/, "");
  return STUDIO_VIDEOS.find((v) => v.url === bare);
}

/** What downloading the whole video at `url` brings into the library: its media_ref, or null for
 *  a link that holds no video here. Any form of a YouTube link to the same video gives the same. */
export function studioDownloadRef(url: string): string | null {
  return videoAt(url)?.media_ref ?? null;
}

/** What yt-dlp says about a link that holds no video this harness knows. */
function noVideoAt(url: string): { ok: false; error: string; url: string } {
  if (!url) return { ok: false, error: "url is required.", url };
  if (!isWebUrl(url))
    return {
      ok: false,
      error: `url must be an http(s) link, not ${url.slice(0, 120)}. A local file comes in with import_media.`,
      url,
    };
  const id = youtubeId(url);
  return {
    ok: false,
    error: id
      ? `ERROR: [youtube] ${id}: Video unavailable. This video is unavailable`
      : `ERROR: Unsupported URL: ${url}`,
    url,
  };
}

/** A known video's metadata, in the shape video_get_metadata returns (tools/net.ts curateInfoJson). */
function videoMetadata(v: StudioVideo, url: string): Record<string, unknown> {
  const id = youtubeId(v.url);
  return {
    url,
    extractor: id ? "youtube" : "generic",
    title: v.title,
    duration_s: v.duration_s,
    channel: "Orbital",
    uploader: "Orbital",
    upload_date: "20260114",
    view_count: v.view_count,
    like_count: Math.round(v.view_count / 20),
    description: v.description,
    description_truncated: false,
    thumbnail_url: id
      ? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`
      : "https://example.com/thumb.jpg",
    chapters: v.chapters,
    heatmap: [],
    heatmap_total_buckets: 0,
    has_storyboards: !!id,
    captions_available: !!id,
    is_live: false,
    was_live: v.was_live,
  };
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
/** The contract's unit discriminator: a placed clip reports PROJECT FRAMES, a raw
 *  library asset reports SOURCE SECONDS. Every read stub must honour it or the
 *  eval would reward the model for doing fps math it must never do. */
function isClipSubject(a: Record<string, unknown>): boolean {
  return typeof a.clip_id === "string" && !!a.clip_id;
}

/** Whether a look is at the studio footage: by its media_ref, or by the clip that plays it. */
async function looksAtFootage(
  a: Record<string, unknown>,
  timeline?: () => Promise<Timeline>,
): Promise<boolean> {
  const isFootage = (ref: unknown) =>
    String(ref ?? "")
      .split("/")
      .pop() === STUDIO_FOOTAGE_REF;
  if (!isClipSubject(a)) return isFootage(a.media_ref);
  if (!timeline) return false;
  const clips = ((await timeline()).tracks ?? []).flatMap((t) => t.clips ?? []);
  return isFootage(clips.find((c) => c.id === a.clip_id)?.media_ref);
}

/** Register the deterministic stand-ins for everything outside the timeline.
 *  Timeline tools stay REAL — this only fills in the surface around them. `timeline` reads the
 *  scenario's live timeline, so a look at it answers from what is actually there. */
export function registerStudioStubs(
  registry: ClientToolRegistry,
  state: StudioState,
  fps = 30,
  timeline?: () => Promise<Timeline>,
): void {
  // A studio workflow still needs import / transcript / export.
  registerJourneyStubs(registry, state, fps);

  // ── media I/O ─────────────────────────────────────────────────────────────
  // A download is the video at its link, whole or the window asked for, and the probe then knows
  // how long it runs (state.imported), so a file placed whole runs what the download reported.
  registry.register("download_video", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const url = str(a.url);
    const video = videoAt(url);
    if (!video) return noVideoAt(url);
    const from = typeof a.start_s === "number" ? Math.max(0, a.start_s) : null;
    const to = typeof a.end_s === "number" ? Math.min(video.duration_s, a.end_s) : null;
    const part = from !== null && to !== null && to > from;
    const duration = part ? to - from : video.duration_s;
    const media_ref = part
      ? `${video.media_ref}_${Math.round(from)}_${Math.round(to)}`
      : video.media_ref;
    state.downloads.push({ media_ref, url });
    state.imported.push({ media_ref, kind: "video", duration_s: duration });
    return {
      ok: true,
      media_ref,
      path: `library/${str(a.output_name, `${media_ref}.mp4`)}`,
      size_bytes: Math.round(duration * 700_000),
      duration_s: duration,
      width: 1920,
      height: 1080,
      fps: 30,
      // The real download is picture-only unless asked for the sound.
      has_audio: a.with_audio === true,
      actual_duration_s: duration,
      video_duration_s: null,
      metadata: null,
    };
  });

  registry.register("clip_video", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      media_ref: STUDIO_CLIP_REF,
      filename: str(a.name, "clipped_1") + ".mp4",
      size_bytes: 2_100_000,
    };
  });

  registry.register("probe_media", async () => ({
    ok: true,
    duration_s: 12,
    format: "mov,mp4,m4a,3gp,3g2,mj2",
    size_bytes: 8_400_000,
    n_streams: 2,
    has_audio: true,
    video: {
      width: 3840,
      height: 2160,
      fps: 30,
      avg_fps: 30,
      codec: "h264",
      pix_fmt: "yuv420p",
      sample_aspect_ratio: "1:1",
      display_aspect_ratio: "16:9",
      rotation: null,
      nb_frames: "360",
    },
    audio: { codec: "aac", sample_rate: "48000", channels: 2, channel_layout: "stereo" },
  }));

  registry.register("video_get_metadata", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const url = str(a.url);
    const video = videoAt(url);
    if (!video) return noVideoAt(url);
    return { ok: true, cached: false, metadata: videoMetadata(video, url) };
  });

  registry.register("youtube_search", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const query = str(a.query, "rocket launch");
    state.searches.push({ query, engine: "youtube" });
    const enrich = a.enrich !== false;
    const n = Math.max(1, Math.min(10, Math.trunc(num(a.n, 5))));
    const results = STUDIO_VIDEOS.filter(
      (v) => youtubeId(v.url) !== null && (!v.is_short || a.shorts === true),
    )
      .slice(0, n)
      .map((v) => ({
        url: v.url,
        title: v.title,
        channel: "Orbital",
        duration_s: v.duration_s,
        is_short: v.is_short,
        metadata: enrich ? slimMetadata(videoMetadata(v, v.url)) : null,
        metadata_error: null,
      }));
    return {
      ok: true,
      query,
      result_count: results.length,
      results,
      enriched: enrich,
      beat_id: null,
    };
  });

  // ── research / web ────────────────────────────────────────────────────────
  registry.register("web_search", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const query = str(a.query, "launch");
    state.searches.push({ query, engine: "browser" });
    return {
      ok: true,
      query,
      engine: "browser",
      result_count: 2,
      results: [
        { title: "Launch window confirmed", url: STUDIO_URL, snippet: STUDIO_PAGE_TEXT },
        {
          title: "Booster recovery explained",
          url: "https://example.com/booster",
          snippet: "The booster returns to the pad under its own power.",
        },
      ],
    };
  });

  registry.register("get_page", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const url = str(a.url, STUDIO_URL);
    state.pages.push({ url, artifact: STUDIO_PAGE_ARTIFACT });
    return {
      ok: true,
      url,
      final_url: url,
      title: "Launch window confirmed",
      html_artifact_id: STUDIO_PAGE_ARTIFACT,
      html_chars: STUDIO_PAGE_TEXT.length,
      cached: false,
    };
  });

  registry.register("get_page_image", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      url: str(a.url, STUDIO_URL),
      viewport: str(a.viewport, "1280x720"),
      media_ref: STUDIO_SCREENSHOT_REF,
      cached: false,
    };
  });

  registry.register("read_file", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      path: str(a.path, STUDIO_PAGE_ARTIFACT),
      content: STUDIO_PAGE_TEXT,
      truncated: false,
      total_chars: STUDIO_PAGE_TEXT.length,
    };
  });

  // ── vision ────────────────────────────────────────────────────────────────
  registry.register("vision_describe", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    state.inspections.push({ tool: "vision_describe", subject: str(a.media_ref, "?") });
    return {
      ok: true,
      description:
        "A wordmark logo in white on a transparent background, centred, with generous padding.",
    };
  });

  registry.register("image_ask", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const refs = Array.isArray(a.media_refs) ? a.media_refs : [a.media_ref].filter(Boolean);
    return {
      ok: true,
      prompt: str(a.prompt, "describe"),
      answer: "The second image is brighter and better exposed; the first is underexposed.",
      model: "gemini-3.1-flash-lite",
      n_images: refs.length || 1,
    };
  });

  registry.register("find_content", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      prompt: str(a.prompt, "the logo"),
      media_ref: str(a.media_ref, "logo.png"),
      bbox: { ...STUDIO_BBOX },
      label: "logo",
      contents: "wordmark",
      tile: 0,
      n_tiles: 1,
      image_size: { ...STUDIO_IMAGE_SIZE },
    };
  });

  registry.register("crop_image", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const bbox = (a.bbox ?? {}) as Record<string, unknown>;
    const w = num(bbox.w, STUDIO_BBOX.w);
    const h = num(bbox.h, STUDIO_BBOX.h);
    return {
      ok: true,
      media_ref: STUDIO_CROP_REF,
      filename: "crop_1.png",
      source_media_ref: str(a.media_ref, "logo.png"),
      source_size: { ...STUDIO_IMAGE_SIZE },
      bbox: { x: num(bbox.x, STUDIO_BBOX.x), y: num(bbox.y, STUDIO_BBOX.y), w, h },
      size: { w, h },
    };
  });

  registry.register("video_ask", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const byClip = isClipSubject(a);
    // The paid look hears the shot unless asked not to (`visual_only`); the free look's frames,
    // loudness and speech transcript cannot say what a sound that is not speech is.
    const heard = a.visual_only === true ? "" : ` ${STUDIO_SOUND}`;
    return {
      ok: true,
      response: `A wide shot of a launch pad, then the vehicle clears the tower.${heard}`,
      timing: byClip ? "project_frames" : "source_seconds",
      timestamps_found: byClip
        ? [{ text: "clears the tower", frame: STUDIO_MOMENT_FRAMES.peak }]
        : [{ text: "clears the tower", seconds: STUDIO_MOMENT_SECONDS.peak }],
      video_duration_s: 12,
      window_s: null,
    };
  });

  registry.register("video_find_moment", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    state.inspections.push({ tool: "video_find_moment", subject: str(a.clip_id ?? a.media_ref) });
    if (isClipSubject(a)) {
      return {
        ok: true,
        timing: "project_frames",
        moments: [
          {
            start_frame: STUDIO_MOMENT_FRAMES.start,
            end_frame: STUDIO_MOMENT_FRAMES.end,
            peak_frame: STUDIO_MOMENT_FRAMES.peak,
            why: "the vehicle clears the tower here",
            shots: [
              {
                in_frame: STUDIO_MOMENT_FRAMES.start,
                out_frame: STUDIO_MOMENT_FRAMES.end,
                description: "wide, vehicle rising",
              },
            ],
          },
        ],
        video_duration_s: 12,
        raw_text: null,
      };
    }
    return {
      ok: true,
      timing: "source_seconds",
      moments: [
        {
          start_s: STUDIO_MOMENT_SECONDS.start,
          end_s: STUDIO_MOMENT_SECONDS.end,
          peak_s: STUDIO_MOMENT_SECONDS.peak,
          why: "the vehicle clears the tower here",
          shots: [
            {
              in_s: STUDIO_MOMENT_SECONDS.start,
              out_s: STUDIO_MOMENT_SECONDS.end,
              description: "wide, vehicle rising",
            },
          ],
        },
      ],
      video_duration_s: 12,
      raw_text: null,
    };
  });

  // ── inspection ────────────────────────────────────────────────────────────
  // No `_attachments`: the harness has no real frames, and a fabricated attachment
  // would be a fiction. The model still gets the numeric facts it reasons over, and a
  // look at the studio footage says in words what its pictures show (studioShotAt).
  // Captioning needs decoded audio and a whisper run, neither of which exists in the
  // harness. Stubbed like the inspect_* reads: a shaped, deterministic answer that says so,
  // rather than a silent success the eval would read as "captions are on the timeline".
  registry.register("add_captions", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      created: [],
      count: 0,
      caption_group: "cap_eval",
      source_track: str(a.track_id, "a1"),
      note: "(eval) no audio to transcribe in this harness; no caption clips were placed",
    };
  });

  registry.register("inspect_media", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const subject = str(a.clip_id ?? a.media_ref, "?");
    state.inspections.push({ tool: "inspect_media", subject });
    // The real result, key for key, for a fixed 12 s 1080p clip with sound. Times are project
    // frames for a clip_id (the seeds place it at frame 0, untrimmed), source seconds otherwise;
    // the samples are the real tool's own.
    const clip = isClipSubject(a);
    const start = num(a.start_seconds, 0);
    const end = num(a.end_seconds, 12);
    const at = (t: number): { frame: number } | { t: number } =>
      clip ? { frame: Math.round(t * fps) } : { t: Math.round(t * 1000) / 1000 };
    // No pixels to attach, so a look at the footage is told what its pictures show, in words; a
    // look that showed nothing left the model nothing to act on (the case then failed whatever it
    // did). Any other subject has no agreed content and stays unseen.
    const footage = await looksAtFootage(a, timeline);
    const shown = (times: number[]): string =>
      footage
        ? `; what the pictures show: ${times
            .map((t) => {
              const when = clip
                ? `frame ${Math.round(t * fps)}`
                : `${Math.round(t * 1000) / 1000} s`;
              return `at ${when}, ${studioShotAt(t)}`;
            })
            .join("; ")}`
        : "";
    const base = {
      ok: true,
      kind: "video",
      media_ref: subject,
      duration_s: 12,
      window_s: [start, end],
      timing: clip ? "project_frames" : "source_seconds",
      metadata: { width: 1920, height: 1080, fps: 30 },
      loudness: { integrated_lufs: -18.2, true_peak_dbtp: -3.1, rms_dbfs: -21.5 },
      transcript: null,
      frames_attached: 0,
    };
    if (a.overview === true) {
      const seconds = [0, 4, 8];
      const tiles = seconds.map((t) => Math.round(t * (clip ? fps : 1)));
      return {
        ...base,
        overview: clip ? { tile_frames: tiles } : { tile_times: tiles },
        note: `(eval) the storyboard was not attached in this harness${shown(seconds)}`,
      };
    }
    const times = mediaLookTimes(start, end, a.max_frames);
    return {
      ...base,
      frames: times.map(at),
      coordinate_grid: GRID_NOTE,
      sharpness: 182.4,
      noise_sigma: 1.1,
      note: `(eval) frames were not attached in this harness${shown(times)}`,
    };
  });

  registry.register("inspect_timeline", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (timeline) {
      // The real tool's answer minus the pixels: same frames, same out-of-range and empty-timeline
      // refusals, same clips on canvas at each frame, read from the scenario's actual timeline.
      const raw = await timeline();
      const planned = planTimelineLook(raw, a);
      state.inspections.push({
        tool: "inspect_timeline",
        subject: timelineLookFrames(a).join(","),
      });
      if (!planned.ok) return planned.result;
      const look = resolveRenderPlan(planned.seconds);
      return {
        ok: true,
        canvas: raw.canvas,
        duration_frames: planned.total,
        frame_numbers: planned.nums,
        ...(planned.outOfRange.length ? { out_of_range: planned.outOfRange } : {}),
        coordinate_grid: GRID_NOTE,
        frames_attached: 0,
        frames: planned.nums.map((f) => ({
          frame: f,
          time_s: Math.round((f / planned.fps) * 1000) / 1000,
          ok: true,
          visible_clips: visibleClips(look, f, planned.fps),
        })),
        note: "(eval) frames were not attached in this harness",
      };
    }
    const frames = timelineLookFrames(a);
    state.inspections.push({ tool: "inspect_timeline", subject: frames.join(",") });
    return {
      ok: true,
      canvas: { width: 1080, height: 1920, fps },
      frame_numbers: frames,
      frames_attached: 0,
      coordinate_grid: GRID_NOTE,
      frames: frames.map((f) => ({ frame: f, time_s: f / fps, ok: true })),
      note: "(eval) frames were not attached in this harness",
    };
  });

  registry.register("inspect_color", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const subject = str(a.clip_id ?? a.media_ref, "?");
    state.inspections.push({ tool: "inspect_color", subject });
    // The levels never change, so a look after a grade must not read as the grade doing nothing.
    const clip =
      isClipSubject(a) && timeline
        ? ((await timeline()).tracks ?? [])
            .flatMap((t) => t.clips ?? [])
            .find((c) => c.id === a.clip_id)
        : undefined;
    const graded = !!clip?.color && Object.keys(clip.color).length > 0;
    // A deliberately COLD, FLAT subject: a scenario can then ask the model to warm
    // it up and be graded on whether the grade it authored moves the right way.
    return {
      ok: true,
      subject: isClipSubject(a) ? "clip" : "media",
      scopes: {
        mean: [0.34, 0.38, 0.47],
        mean_luma: 0.38,
        black_point: 0.09,
        white_point: 0.78,
        clip_low_pct: 0.2,
        clip_high_pct: 0.1,
        saturation: 0.11,
        warm_cool: -0.13,
        green_magenta: 0.01,
        hue_histogram: [1, 1, 2, 3, 8, 14, 22, 26, 12, 6, 3, 2],
      },
      frame_attached: 0,
      note: graded
        ? "(eval) the frame was not attached in this harness, and these are the source's levels: the grade on this clip is not measured here"
        : "(eval) the frame was not attached in this harness",
    };
  });

  // ── generation ────────────────────────────────────────────────────────────
  registry.register("list_models", async () => ({
    ok: true,
    models: [
      {
        id: "gemini-image",
        kind: "image",
        label: "Gemini Image",
        aspect_ratios: ["1:1", "16:9", "9:16"],
        qualities: ["standard", "high"],
        max_images: 4,
        supports_reference_images: true,
      },
      {
        id: "veo-video",
        kind: "video",
        label: "Veo",
        aspect_ratios: ["16:9", "9:16"],
        durations: [4, 6, 8],
        resolutions: ["720p", "1080p"],
        supports_start_frame: true,
        supports_end_frame: true,
        supports_reference_images: true,
      },
    ],
    defaults: { image: "gemini-image", video: "veo-video", tts: "tts-1", music: "music-1" },
  }));

  registry.register("generate_image", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const prompt = str(a.prompt, "an image");
    const count = Math.max(1, Math.min(4, num(a.count, 1)));
    const assets = Array.from({ length: count }, (_, i) => ({
      media_ref: i === 0 ? STUDIO_IMAGE_REF : `${STUDIO_IMAGE_REF}_${i + 1}`,
      path: `library/gen_image_${i + 1}.png`,
      kind: "image" as const,
    }));
    for (const asset of assets)
      state.generated.push({ media_ref: asset.media_ref, kind: "image", prompt });
    return { ok: true, model: str(a.model, "gemini-image"), status: "generating", count, assets };
  });

  registry.register("generate_video", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const prompt = str(a.prompt, "a video");
    state.generated.push({ media_ref: STUDIO_VIDEO_REF, kind: "video", prompt });
    return {
      ok: true,
      model: str(a.model, "veo-video"),
      kind: "video",
      status: "generating",
      media_ref: STUDIO_VIDEO_REF,
    };
  });

  registry.register("generate_voiceover", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const text = str(a.text ?? a.script, "Welcome to the show.");
    state.generated.push({ media_ref: STUDIO_VOICEOVER_REF, kind: "audio", prompt: text });
    return {
      ok: true,
      status: "generating",
      voice: str(a.voice, "alloy"),
      model: str(a.model, "tts-1"),
      style: null,
      language: null,
      media_ref: STUDIO_VOICEOVER_REF,
    };
  });

  registry.register("generate_music", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const prompt = str(a.prompt, "a music bed");
    state.generated.push({ media_ref: STUDIO_MUSIC_REF, kind: "audio", prompt });
    return {
      ok: true,
      model: str(a.model, "music-1"),
      prompt,
      instrumental: a.instrumental !== false,
      seed: null,
      status: "generating",
      media_ref: STUDIO_MUSIC_REF,
    };
  });

  registry.register("extract_style", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const name = str(a.style_name ?? a.name, "extracted");
    const refs = Array.isArray(a.references) ? a.references.map((r) => String(r)) : [];
    return {
      ok: true,
      style_name: name,
      version: 1,
      style_path: `styles/${name}.md`,
      references: refs,
      metrics_summary: {
        fps: 30,
        total_seconds: 42,
        payload_mb: 1.4,
        dimensions_present: ["pacing", "captions", "colour"],
      },
      draft_preview: "Fast cuts, punchy captions, warm grade.",
      cost: { analyze_input_tokens: 4200, analyze_output_tokens: 900 },
      warnings: [],
    };
  });

  // ── project lifecycle ─────────────────────────────────────────────────────
  registry.register("list_projects", async () => ({
    ok: true,
    active_project_id: activeProject(state).id,
    projects: projectsNow(state),
  }));

  registry.register("new_project", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const name = str(a.name, "Untitled");
    const id = `proj_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
    state.projects.push({ id, name });
    return {
      ok: true,
      id,
      name,
      canvas: { width: num(a.width, 1080), height: num(a.height, 1920), fps: num(a.fps, 30) },
      note: `Created "${name}". This does NOT switch you or the user's screen: your tools keep acting on "${activeProject(state).name}". Tell the user the new project is in their project list. (Over MCP, manage_project {action:'open', id} switches.)`,
    };
  });

  // As the real tool: a project by its id (or a folder path ending in it), and only one the list
  // holds. It used to answer for any id, naming an unknown one "Current cut".
  registry.register("open_project", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const ref = str(a.project).trim();
    if (!ref) return { ok: false, error: "project id or path is required" };
    const id =
      ref
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() ?? ref;
    const project = projectsNow(state).find((p) => p.id === id);
    if (!project) return { ok: false, error: `project not found: ${ref}` };
    return {
      ok: true,
      id: project.id,
      name: project.name,
      note: `"${project.name}" is in the user's project list (File > Open Project). This does NOT switch you or the user's screen: your tools keep acting on "${activeProject(state).name}". (Over MCP, manage_project {action:'open', id} switches.)`,
    };
  });

  registry.register("rename_project", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const name = str(a.name, "Renamed");
    const id = activeProject(state).id;
    state.projects.push({ id, name });
    return { ok: true, id, name };
  });

  registry.register("duplicate_project", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const name = str(a.name, "Current cut copy");
    const id = `proj_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
    state.projects.push({ id, name });
    return { ok: true, id, name, path: `projects/${id}` };
  });

  // One library for the whole run, as the app keeps one catalog: a write changes what a later read
  // shows, and an id it does not hold is refused as the real tool refuses it. It used to answer an
  // unknown id with the first item, and to forget a tag as soon as it had set it.
  const library: LibraryRow[] = STUDIO_LIBRARY.map((r) => ({ ...r }));
  const row = (r: LibraryRow) => ({
    id: r.id,
    filename: r.filename,
    path: `library/${r.filename}`,
    kind: r.kind,
    folder: r.folder,
    size_bytes: 1_000_000,
    ...(r.tags ? { tags: r.tags } : {}),
    ...(r.notes !== undefined ? { notes: r.notes } : {}),
  });

  registry.register("get_project_state", async () => {
    const active = activeProject(state);
    return {
      ok: true,
      project_id: active.id,
      name: active.name,
      canvas: { width: 1080, height: 1920, fps },
      model_id: "gpt-5.4",
      active_style: "none",
      active_workflow: "none",
      // The same inventory library_op lists, in the real tool's shape.
      library: library.map((r) => ({
        media_ref: r.id,
        filename: r.filename,
        kind: r.kind,
        folder: r.folder || null,
      })),
      library_count: library.length,
    };
  });

  registry.register("pack_project", async () => {
    const path = "Downloads/current-cut.artdaddy.zip";
    state.packs.push({ path });
    return { ok: true, path, clips: 3, collected: 3, missing: [], bytes: 18_400_000 };
  });

  // ── library ───────────────────────────────────────────────────────────────
  const folderOf = (v: unknown): string =>
    String(v ?? "")
      .trim()
      .replace(/^\/+|\/+$/g, "");
  const inFolder = (r: LibraryRow, folder: string, deep = true): boolean =>
    r.folder === folder || (deep && r.folder.startsWith(`${folder}/`));
  registry.register("library_op", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const action = str(a.action).trim();
    const id = typeof a.id === "string" ? a.id.trim() : undefined;
    state.libraryOps.push({ action, id });
    if (!action) return { ok: false, error: "an 'action' is required" };
    const found = library.find((r) => r.id === id);
    switch (action) {
      case "list": {
        const folder = folderOf(a.folder);
        const clips = folder
          ? library.filter((r) => inFolder(r, folder, a.recursive !== false))
          : library;
        return { ok: true, clips: clips.map(row) };
      }
      case "get":
        return found
          ? { ok: true, clip: row(found) }
          : { ok: false, error: `unknown clip id ${id ?? ""}` };
      case "update":
      case "move": {
        if (!found) return { ok: false, error: `update: unknown clip id ${id ?? ""}` };
        if (action === "update" && typeof a.filename === "string" && a.filename.trim())
          found.filename = a.filename.trim();
        if (a.folder !== undefined && a.folder !== null) found.folder = folderOf(a.folder);
        if (action === "update" && Array.isArray(a.tags))
          found.tags = a.tags.map((t) => String(t).trim()).filter(Boolean);
        if (action === "update" && a.notes !== undefined && a.notes !== null)
          found.notes = String(a.notes);
        return { ok: true, clip: row(found) };
      }
      case "delete":
        if (!found) return { ok: false, error: `delete: unknown clip id ${id ?? ""}` };
        library.splice(library.indexOf(found), 1);
        return {
          ok: true,
          id: found.id,
          removed_clips: 0,
          removed_file: `library/${found.filename}`,
          unlinked_external: false,
        };
      case "create_folder": {
        const folder = folderOf(a.folder);
        if (!folder) return { ok: false, error: "create_folder: name is empty" };
        return {
          ok: true,
          folders: [...new Set([...library.map((r) => r.folder), folder])].sort(),
        };
      }
      case "rename_folder": {
        const from = folderOf(a.old);
        const to = folderOf(a.new);
        if (!from) return { ok: false, error: "rename_folder: old name is empty" };
        if (!to) return { ok: false, error: "rename_folder: new name is empty" };
        const moved = library.filter((r) => inFolder(r, from));
        for (const r of moved) r.folder = to + r.folder.slice(from.length);
        return { ok: true, old: from, new: to, clips_moved: moved.length };
      }
      case "delete_folder": {
        const folder = folderOf(a.folder);
        if (!folder) return { ok: false, error: "delete_folder: name is empty" };
        const members = library.filter((r) => inFolder(r, folder));
        if (members.length && a.force !== true)
          return {
            ok: false,
            error: `delete_folder: ${folder} contains ${members.length} clip(s); move them out first or pass force=true.`,
          };
        for (const m of members) library.splice(library.indexOf(m), 1);
        return { ok: true, folder, removed_clip_ids: members.map((m) => m.id) };
      }
      case "rescan":
        return {
          ok: true,
          added: [],
          removed_catalog_rows: [],
          removed_dup_files: [],
          offline_external: [],
        };
      case "resolve": {
        const ref = str(a.id ?? a.id_or_path).trim();
        if (!ref) return { ok: false, error: "resolve: an id or path is required" };
        const hit = library.find(
          (r) => r.id === ref || r.filename === ref || `library/${r.filename}` === ref,
        );
        return hit
          ? { ok: true, path: `library/${hit.filename}` }
          : { ok: false, error: `resolve: unknown library id ${ref}` };
      }
      default:
        return { ok: false, error: `library_op: unknown action ${action}` };
    }
  });

  // ── escape hatch ──────────────────────────────────────────────────────────
  // Succeeds, so a scenario grading "did the model reach for the escape hatch when
  // a first-class tool existed?" measures the CHOICE, not a failure it recovered from.
  registry.register("run_ffmpeg", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const command = str(a.command ?? a.args, "-i in.mp4 out.mp4");
    state.ffmpegCalls.push({ command });
    return {
      ok: true,
      media_ref: "media_ffmpeg_1",
      filename: "ffmpeg_out.mp4",
      kind: "video",
      duration_s: 6,
      video: { width: 1080, height: 1920, fps: 30, codec: "h264" },
      audio: null,
    };
  });
}

/** True if a media_ref the studio stubs mint is AUDIO-only. The harness's ffprobe
 *  emulation consults this: a generated voiceover/music ref must not report a video
 *  stream, or placement would route it to a video track and every audio scenario
 *  would fail on the harness rather than on the model. */
export function studioRefIsAudio(ref: string): boolean {
  if (!ref) return false;
  if (kindOf(ref) === "audio") return true;
  return (
    ref === STUDIO_VOICEOVER_REF || ref === STUDIO_MUSIC_REF || /voiceover|music|_bed/.test(ref)
  );
}
