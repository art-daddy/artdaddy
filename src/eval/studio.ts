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
import { kindOf } from "../media/formats";
import { registerJourneyStubs, type JourneyState } from "./journey";

/** What the studio stubs recorded, for a scenario's `expectTrace` grader. */
export interface StudioState extends JourneyState {
  generated: { media_ref: string; kind: string; prompt: string }[];
  downloads: { media_ref: string; url: string }[];
  searches: { query: string; engine: string }[];
  pages: { url: string; artifact: string }[];
  projects: { id: string; name: string }[];
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

/** The one URL the research stubs know about, and what they say about it. */
export const STUDIO_URL = "https://example.com/launch";
export const STUDIO_PAGE_ARTIFACT = "artifacts/page_1.html";
export const STUDIO_PAGE_TEXT =
  "The launch window opens at 09:40 UTC and the booster returns to the pad eight minutes later.";

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

/** Register the deterministic stand-ins for everything outside the timeline.
 *  Timeline tools stay REAL — this only fills in the surface around them. */
export function registerStudioStubs(
  registry: ClientToolRegistry,
  state: StudioState,
  fps = 30,
): void {
  // A studio workflow still needs import / transcript / export.
  registerJourneyStubs(registry, state, fps);

  // ── media I/O ─────────────────────────────────────────────────────────────
  registry.register("download_video", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const url = str(a.url, STUDIO_URL);
    state.downloads.push({ media_ref: STUDIO_DOWNLOAD_REF, url });
    return {
      ok: true,
      media_ref: STUDIO_DOWNLOAD_REF,
      path: "library/download_1.mp4",
      size_bytes: 8_400_000,
      duration_s: 12,
      width: 1920,
      height: 1080,
      fps: 30,
      has_audio: true,
      actual_duration_s: 12,
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
    return {
      ok: true,
      cached: false,
      metadata: {
        url: str(a.url, STUDIO_URL),
        extractor: "youtube",
        title: "Rocket launch — full replay",
        duration_s: 754,
        channel: "Orbital",
        uploader: "Orbital",
        upload_date: "20260114",
        view_count: 184_000,
        like_count: 9_200,
        description: "Full replay of the launch window and booster return.",
        description_truncated: false,
        thumbnail_url: "https://example.com/thumb.jpg",
        chapters: [
          { start_s: 0, end_s: 120, title: "Countdown" },
          { start_s: 120, end_s: 300, title: "Liftoff" },
          { start_s: 300, end_s: 754, title: "Booster return" },
        ],
        heatmap: [],
        heatmap_total_buckets: 0,
        has_storyboards: true,
        captions_available: true,
        is_live: false,
        was_live: true,
      },
    };
  });

  registry.register("youtube_search", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const query = str(a.query, "rocket launch");
    state.searches.push({ query, engine: "youtube" });
    return {
      ok: true,
      query,
      result_count: 2,
      enriched: true,
      results: [
        {
          url: STUDIO_URL,
          title: "Rocket launch — full replay",
          channel: "Orbital",
          duration_s: 754,
          is_short: false,
          metadata: null,
          metadata_error: null,
        },
        {
          url: "https://example.com/launch-short",
          title: "Launch in 30 seconds",
          channel: "Orbital",
          duration_s: 30,
          is_short: true,
          metadata: null,
          metadata_error: null,
        },
      ],
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
    return {
      ok: true,
      response: "A wide shot of a launch pad, then the vehicle clears the tower.",
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
  // would be a fiction. The model still gets the numeric facts it reasons over.
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
    return {
      ok: true,
      kind: "video",
      media_ref: subject,
      duration_s: 12,
      frames: [{ t: 0 }, { t: 4 }, { t: 8 }],
      frames_attached: 0,
      transcript: null,
      metadata: { width: 1920, height: 1080, fps: 30 },
      note: "(eval) frames were not attached in this harness",
    };
  });

  registry.register("inspect_timeline", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const raw = a.frames ?? a.frame;
    const frames = Array.isArray(raw) ? raw.map((f) => num(f, 0)) : [num(raw, 0)];
    state.inspections.push({ tool: "inspect_timeline", subject: frames.join(",") });
    return {
      ok: true,
      canvas: { width: 1080, height: 1920, fps },
      frame_numbers: frames,
      frames_attached: 0,
      frames: frames.map((f) => ({ frame: f, time_s: f / fps, ok: true })),
      note: "(eval) frames were not attached in this harness",
    };
  });

  registry.register("inspect_color", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const subject = str(a.clip_id ?? a.media_ref, "?");
    state.inspections.push({ tool: "inspect_color", subject });
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
      note: "(eval) the frame was not attached in this harness",
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
    active_project_id: "proj_current",
    projects: [
      { id: "proj_current", name: "Current cut", lastOpenedAt: "2026-08-01T10:00:00Z" },
      { id: "proj_teaser", name: "Teaser", lastOpenedAt: "2026-07-28T09:00:00Z" },
    ],
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
      note: "Created and set active. The current conversation continues on its own project; the new project opens in a fresh session.",
    };
  });

  registry.register("open_project", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const id = str(a.id ?? a.project_id, "proj_teaser");
    return {
      ok: true,
      id,
      name: id === "proj_teaser" ? "Teaser" : "Current cut",
      note: "Set active. The current conversation continues on its own project; the opened project resumes in a fresh session.",
    };
  });

  registry.register("rename_project", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const name = str(a.name, "Renamed");
    state.projects.push({ id: "proj_current", name });
    return { ok: true, id: "proj_current", name };
  });

  registry.register("duplicate_project", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const name = str(a.name, "Current cut copy");
    const id = `proj_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
    state.projects.push({ id, name });
    return { ok: true, id, name, path: `projects/${id}` };
  });

  registry.register("get_project_state", async () => ({
    ok: true,
    project_id: "proj_current",
    name: "Current cut",
    canvas: { width: 1080, height: 1920, fps },
    model_id: "gpt-5.4",
    active_style: "none",
    active_workflow: "none",
    downloads: [{ filename: "download_1.mp4" }],
    audio: [{ filename: "bed.mp3" }],
  }));

  registry.register("pack_project", async () => {
    const path = "Downloads/current-cut.artdaddy.zip";
    state.packs.push({ path });
    return { ok: true, path, clips: 3, collected: 3, missing: [], bytes: 18_400_000 };
  });

  // ── library ───────────────────────────────────────────────────────────────
  registry.register("library_op", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const action = str(a.action, "list");
    const id = typeof a.id === "string" ? a.id : undefined;
    state.libraryOps.push({ action, id });
    const row = (r: (typeof STUDIO_LIBRARY)[number]) => ({
      id: r.id,
      filename: r.filename,
      path: `library/${r.filename}`,
      kind: r.kind,
      folder: r.folder,
      size_bytes: 1_000_000,
    });
    const found = STUDIO_LIBRARY.find((r) => r.id === id) ?? STUDIO_LIBRARY[0];
    switch (action) {
      case "get":
        return { ok: true, clip: row(found) };
      case "update":
        return {
          ok: true,
          clip: {
            ...row(found),
            tags: Array.isArray(a.tags) ? a.tags.map((t) => String(t)) : [],
            notes: str(a.notes),
          },
        };
      case "move":
        return { ok: true, clip: { ...row(found), folder: str(a.folder, "broll") } };
      case "delete":
        return {
          ok: true,
          id: found.id,
          removed_clips: 0,
          removed_file: `library/${found.filename}`,
          unlinked_external: false,
        };
      case "create_folder":
        return { ok: true, folders: ["broll", "music", str(a.folder, "new")] };
      case "rename_folder":
        return {
          ok: true,
          old: str(a.folder, "broll"),
          new: str(a.name, "b-roll"),
          clips_moved: 2,
        };
      case "delete_folder":
        return { ok: true, folder: str(a.folder, "broll"), removed_clip_ids: [] };
      case "rescan":
        return {
          ok: true,
          added: [],
          removed_catalog_rows: [],
          removed_dup_files: [],
          offline_external: [],
        };
      case "resolve":
        return { ok: true, path: `library/${found.filename}` };
      default:
        return { ok: true, clips: STUDIO_LIBRARY.map(row) };
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
