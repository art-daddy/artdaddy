// A case's own footage: a library of clips whose content is KNOWN, so a request over a person's own
// media ("make a trailer from my clips") can still be graded by code: which clips were used, where,
// and what is said in them.
//
// WHY: people mostly ask for a finished video from a library of their own footage. The studio
// stand-ins (studio.ts) know one shot, `a.mp4`; a request over twelve clips needs twelve that each say
// what they are. A case declares `footage` (types.ts) on the "studio" surface, and the stand-ins below
// answer from it in the real tools' shapes:
//   - the library: library_op (list, get, ...), get_project_state, import_media from a path;
//   - a look: inspect_media (the length, the size, what the pictures show IN WORDS, the loudness and
//     the speech), video_ask and video_find_moment (the paid looks, with their 30-minute limits);
//   - speech: get_transcript (the timeline's words, through each clip's trim, speed and position) and
//     add_captions (caption clips from those words, chunked and timed by the app's own code);
//   - the probe: each file's length, size and sound track, so a clip placed whole runs its real length
//     and a video with sound gets its linked audio clip, as in the app.
// What stands in is only what needs pixels, sound or a disk: placement, the caption chunking, the
// frames-vs-seconds mapping and the timeline itself are the app's own code.
//
// The shape is shared with the lab's Copilot host, which calls `useFootage` the way the harness does.
import { CAPTION_DEFAULT_POSITION } from "../tools/captions";
import type { CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { mediaLookTimes } from "../tools/inspect";
import { GRID_NOTE } from "../tools/inspectOverlay";
import type { ClientToolRegistry } from "../tools/registry";
import { isUnsafeAgentRef } from "../tools/store";
import { clipWordFrames } from "../tools/transcribe";
import { applyCase, chunkWords, fitSpans, type CaptionWord } from "../timeline/captionChunk";
import { ctxApplyOp, loadTimeline } from "../timeline/engine";
import { canvasFps, newId } from "../timeline/frames";
import {
  clipSourceSpanSeconds,
  clipSpanToFrames,
  findClip,
  resolveTextTrack,
} from "../timeline/helpers";
import type { Clip, Timeline } from "../timeline/model";
import { lineWidthIn, planCanvas, textBox } from "../timeline/renderPlan";

/** What the pictures show over [from, to) SOURCE seconds, in words. */
export interface FootageShot {
  from: number;
  to: number;
  shows: string;
}

/** Spoken words: [text, start, end) in SOURCE seconds. A row may hold several words (a sentence):
 *  where single words are needed it is split evenly over its span (`footageWordRows`). */
export type FootageWords = readonly (readonly [string, number, number])[];

/** One file of a case's footage, as the library and the looks know it. */
export interface FootageClip {
  /** The library id the tools hand out (an image's carries its extension, so placement sees a still:
   *  the harness has no catalog that resolves an id to a file). */
  media_ref: string;
  filename: string;
  kind: "video" | "audio" | "image";
  /** Seconds. Absent for an image. */
  duration_s?: number;
  /** Default 1920x1080. */
  width?: number;
  height?: number;
  /** Default 30. */
  fps?: number;
  /** The file has a sound track: a video's camera sound. Always true for "audio", never for "image". */
  audio?: boolean;
  /** What a look that HEARS the file reports beyond speech (video_ask), e.g. "waves, no music". */
  sound?: string;
  shots?: readonly FootageShot[];
  words?: FootageWords;
  /** The spoken language, as a short code. Default "en". */
  language?: string;
  loudness?: { integrated_lufs: number; true_peak_dbtp: number };
  folder?: string;
  /** Where the file sits on disk (made up), for import_media by path. */
  path?: string;
  /** In the project's library from the start (default true). False: only on disk until imported. */
  inLibrary?: boolean;
}

export interface Footage {
  clips: readonly FootageClip[];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const baseName = (s: string): string => s.replace(/\\/g, "/").split("/").pop() ?? "";
const stem = (s: string): string => s.replace(/\.[^.]+$/, "");
const extOf = (s: string): string => (/\.[^./\\]+$/.exec(s)?.[0] ?? "").toLowerCase();
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The footage clip a tool was given, by any name the app accepts from the agent: its library id, its
 *  filename, or a library path ending in either. Never an absolute path or a `..` escape: the app's
 *  tools refuse those (tools/store.ts isUnsafeAgentRef), so they name no clip here either. */
export function footageClip(footage: Footage, ref: unknown): FootageClip | undefined {
  const raw = str(ref);
  if (!raw || isUnsafeAgentRef(raw)) return undefined;
  const name = baseName(raw);
  const lower = name.toLowerCase();
  return footage.clips.find(
    (c) =>
      c.media_ref === raw ||
      c.media_ref === name ||
      stem(name) === c.media_ref ||
      c.filename.toLowerCase() === lower,
  );
}

export const hasSound = (c: FootageClip): boolean =>
  c.kind === "audio" || (c.kind === "video" && c.audio === true);
const widthOf = (c: FootageClip): number => c.width ?? 1920;
const heightOf = (c: FootageClip): number => c.height ?? 1080;
const fpsOfClip = (c: FootageClip): number => c.fps ?? 30;
const sizeOf = (c: FootageClip): number =>
  c.kind === "image" ? 2_400_000 : Math.round((c.duration_s ?? 1) * 1_250_000);

/** The words of a clip, one row per word: a row holding several words is split evenly over its span. */
export function footageWordRows(c: FootageClip): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const [text, s, e] of c.words ?? []) {
    const parts = text.split(/\s+/).filter(Boolean);
    const step = (e - s) / Math.max(1, parts.length);
    parts.forEach((w, i) => out.push([w, round3(s + i * step), round3(s + (i + 1) * step)]));
  }
  return out;
}

/** What the pictures show `t` seconds into the clip. */
export function footageShotAt(c: FootageClip, t: number): string {
  const shots = c.shots ?? [];
  if (!shots.length) return "";
  if (c.kind === "image") return shots[0].shows;
  const hit = shots.find((s) => t >= s.from && t < s.to);
  if (hit) return hit.shows;
  return t < shots[0].from ? shots[0].shows : shots[shots.length - 1].shows;
}

// ── the probe ───────────────────────────────────────────────────────────────

/** The ffprobe answer for a footage file, in the shape tools/media.ts probePath reads. */
function probeJson(c: FootageClip): Record<string, unknown> {
  const streams: Record<string, unknown>[] = [];
  if (c.kind !== "audio") {
    const fps = `${fpsOfClip(c)}/1`;
    streams.push({
      index: 0,
      codec_type: "video",
      codec_name: c.kind === "image" ? extOf(c.filename).slice(1) || "png" : "h264",
      width: widthOf(c),
      height: heightOf(c),
      pix_fmt: "yuv420p",
      ...(c.kind === "video" ? { r_frame_rate: fps, avg_frame_rate: fps } : {}),
    });
  }
  if (hasSound(c))
    streams.push({
      index: streams.length,
      codec_type: "audio",
      codec_name: c.kind === "audio" ? "mp3" : "aac",
      sample_rate: "48000",
      channels: 2,
      channel_layout: "stereo",
    });
  const format =
    c.kind === "image" ? "image2" : c.kind === "audio" ? "mp3" : "mov,mp4,m4a,3gp,3g2,mj2";
  return {
    format: {
      format_name: format,
      ...(c.kind === "image" ? {} : { duration: String(c.duration_s ?? 0) }),
      size: String(sizeOf(c)),
    },
    streams,
  };
}

/** `base`, answering for the footage's files: their length, size, picture and sound streams. */
export function footageRunner(footage: Footage, base: CommandRunner): CommandRunner {
  return {
    run: async (program, args) => {
      if (program !== "ffprobe") return base.run(program, args);
      const c = footageClip(footage, args[args.length - 1]);
      if (!c) return base.run(program, args);
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
      if (args.includes("format=duration"))
        return ok(c.kind === "image" ? "" : String(c.duration_s ?? ""));
      const at = args.indexOf("-select_streams");
      if (at >= 0) {
        const which = String(args[at + 1] ?? "");
        // A still's first frame carries no turn of its own (tools/media.ts turnByFrame).
        if (args.includes("-read_intervals")) return ok(JSON.stringify({ frames: [] }));
        if (which.startsWith("v")) return ok(c.kind === "audio" ? "" : "0");
        if (which.startsWith("a")) return ok(hasSound(c) ? (c.kind === "audio" ? "0" : "1") : "");
      }
      if (args.includes("-show_streams")) return ok(JSON.stringify(probeJson(c)));
      return base.run(program, args);
    },
  };
}

/** The probe as tools/media.ts parseProbe reports it (inspect_media's `metadata`). */
function metadataOf(c: FootageClip): Record<string, unknown> {
  const fps = fpsOfClip(c);
  return {
    ok: true,
    duration_s: c.kind === "image" ? null : (c.duration_s ?? null),
    format: (probeJson(c).format as Record<string, unknown>).format_name,
    size_bytes: sizeOf(c),
    n_streams: (c.kind === "audio" ? 0 : 1) + (hasSound(c) ? 1 : 0),
    has_audio: hasSound(c),
    video:
      c.kind === "audio"
        ? null
        : {
            width: widthOf(c),
            height: heightOf(c),
            fps: c.kind === "image" ? null : fps,
            avg_fps: c.kind === "image" ? null : fps,
            codec: c.kind === "image" ? extOf(c.filename).slice(1) || "png" : "h264",
            pix_fmt: "yuv420p",
            sample_aspect_ratio: "1:1",
            display_aspect_ratio: null,
            rotation: null,
            nb_frames: c.kind === "image" ? null : String(Math.round((c.duration_s ?? 0) * fps)),
          },
    audio: hasSound(c)
      ? {
          codec: c.kind === "audio" ? "mp3" : "aac",
          sample_rate: "48000",
          channels: 2,
          channel_layout: "stereo",
        }
      : null,
  };
}

// ── the stand-ins ───────────────────────────────────────────────────────────

/** The longest a paid look takes, as the real tools refuse (tools/video.ts). */
const PAID_LOOK_MAX_S = 1800;
/** Sentence rows a look returns at most (tools/inspect.ts). */
const SEGMENT_CAP = 400;
/** Tiles one overview shows at most. */
const OVERVIEW_TILES = 36;
/** Library rows get_project_state shows (tools/project.ts LIBRARY_PREVIEW). */
const LIBRARY_PREVIEW = 60;
const DEFAULT_LOUDNESS = { integrated_lufs: -19.6, true_peak_dbtp: -2.8 };

type Args = Record<string, unknown>;
type Result = Record<string, unknown>;

/** Up to `max` of `items`, spread evenly from the first to the last. */
function spread<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  return Array.from(
    { length: max },
    (_, i) => items[Math.round((i * (items.length - 1)) / (max - 1))],
  );
}

/** Wire a case's footage into a run: the probe answers for its files, and the library, look, speech
 *  and caption tools answer from it. Call it after registerStudioStubs, with the context the
 *  timeline tools use (its runner is wrapped in place, so every tool that probes sees the footage). */
export function useFootage(
  registry: ClientToolRegistry,
  ctx: ClientToolContext,
  footage: Footage,
): void {
  ctx.runner = footageRunner(footage, ctx.runner);
  const inLibrary = new Set(
    footage.clips.filter((c) => c.inLibrary !== false).map((c) => c.media_ref),
  );
  const notes = new Map<string, { tags?: string[]; notes?: string; folder?: string }>();
  const listed = (): FootageClip[] => footage.clips.filter((c) => inLibrary.has(c.media_ref));
  const known = (ref: unknown): FootageClip | undefined => {
    const c = footageClip(footage, ref);
    return c && inLibrary.has(c.media_ref) ? c : undefined;
  };
  const row = (c: FootageClip): Result => {
    const extra = notes.get(c.media_ref) ?? {};
    const folder = extra.folder ?? c.folder;
    return {
      id: c.media_ref,
      filename: c.filename,
      path: c.path ?? `library/${c.media_ref}${c.kind === "image" ? "" : extOf(c.filename)}`,
      kind: c.kind,
      ...(c.path ? { external: true } : {}),
      ...(folder ? { folder } : {}),
      size_bytes: sizeOf(c),
      added_by: c.path ? "import_reference" : "import_media",
      ...(extra.tags ? { tags: extra.tags } : {}),
      ...(extra.notes ? { notes: extra.notes } : {}),
    };
  };
  const timeline = (): Promise<Timeline> => loadTimeline(ctx.store);

  // ── the library ───────────────────────────────────────────────────────────
  registry.register("library_op", async (args) => {
    const a = (args ?? {}) as Args;
    const action = str(a.action);
    if (!action) return { ok: false, error: "an 'action' is required" };
    const id = str(a.id);
    const c = known(id);
    switch (action) {
      case "list": {
        const folder = str(a.folder);
        const rows = listed()
          .map(row)
          .filter((r) => {
            if (!folder) return true;
            const f = String(r.folder ?? "");
            return a.recursive === false
              ? f === folder
              : f === folder || f.startsWith(`${folder}/`);
          });
        return { ok: true, clips: rows };
      }
      case "get":
        return c ? { ok: true, clip: row(c) } : { ok: false, error: `unknown clip id ${id}` };
      case "resolve":
        return c ? { ok: true, path: row(c).path } : { ok: false, error: `unknown clip id ${id}` };
      case "update":
      case "move": {
        if (!c) return { ok: false, error: `update: unknown clip id ${id}` };
        const extra = { ...(notes.get(c.media_ref) ?? {}) };
        if (a.folder !== undefined) extra.folder = str(a.folder);
        if (action === "update" && Array.isArray(a.tags))
          extra.tags = a.tags.map((t) => String(t).trim()).filter(Boolean);
        if (action === "update" && a.notes !== undefined && a.notes !== null)
          extra.notes = String(a.notes);
        notes.set(c.media_ref, extra);
        return { ok: true, clip: row(c) };
      }
      case "delete": {
        if (!c) return { ok: false, error: `unknown clip id ${id}` };
        inLibrary.delete(c.media_ref);
        return {
          ok: true,
          id: c.media_ref,
          removed_clips: 0,
          removed_file: row(c).path,
          unlinked_external: !!c.path,
        };
      }
      case "create_folder":
        return {
          ok: true,
          folders: [...new Set([...listed().map((x) => x.folder ?? ""), str(a.folder)])]
            .filter(Boolean)
            .sort(),
        };
      default:
        return {
          ok: false,
          error: `library_op '${action}' is not available for this library in the eval`,
        };
    }
  });

  registry.register("get_project_state", async () => {
    const tl = await timeline();
    const all = listed();
    const library = all.slice(0, LIBRARY_PREVIEW).map((c) => ({
      media_ref: c.media_ref,
      filename: c.filename,
      kind: c.kind,
      folder: c.folder ?? null,
    }));
    return {
      ok: true,
      project_id: "proj_current",
      name: "Current cut",
      canvas: tl.canvas ?? null,
      model_id: "",
      active_style: "",
      active_workflow: "",
      library,
      library_count: all.length,
      ...(all.length > library.length
        ? { library_truncated: `showing ${library.length} of ${all.length}; use library_op list` }
        : {}),
    };
  });

  // import_media from a path, as tools/import.ts importFromPath answers: a file the footage has at that
  // path, or a folder holding footage files directly inside it (in filename order), linked in place.
  registry.register("import_media", async (args) => {
    const a = (args ?? {}) as Args;
    const source = (a.source ?? null) as Args | null;
    if (!source || typeof source !== "object")
      return { ok: false, error: "a 'source' object is required" };
    const path = str(source.path);
    if (!path)
      return {
        ok: false,
        error: "this eval has no network or file picker: import a file or folder by its path",
      };
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const entry = (c: FootageClip) => {
      const existed = inLibrary.has(c.media_ref);
      inLibrary.add(c.media_ref);
      return { media_ref: c.media_ref, filename: c.filename, kind: c.kind, existed };
    };
    const file = footage.clips.find((c) => c.path && norm(c.path) === norm(path));
    if (file) return { ok: true, ...entry(file), external: true };
    const inside = footage.clips
      .filter((c) => c.path && norm(c.path).slice(0, norm(c.path).lastIndexOf("/")) === norm(path))
      .sort((x, y) => baseName(x.path!).localeCompare(baseName(y.path!)));
    if (inside.length) {
      const imported = inside.map(entry);
      return { ok: true, imported, count: imported.length, external: true };
    }
    return { ok: false, error: `no file or directory at '${path}'` };
  });

  // ── looks ─────────────────────────────────────────────────────────────────

  /** What a look was asked about: the footage file, and the placed clip when it was given one. */
  async function subjectOf(
    tool: string,
    a: Args,
  ): Promise<
    { c: FootageClip; clip: Clip | null; tl: Timeline | null } | { error: string } | null
  > {
    const clipId = str(a.clip_id);
    if (clipId) {
      const tl = await timeline();
      const found = findClip(tl, clipId);
      if (!found)
        return {
          error: `${tool}: no clip '${clipId}' on the timeline (read get_timeline for the ids)`,
        };
      const clip = found[1];
      if (!clip.media_ref)
        return { error: `clip ${clipId} has no source media to inspect (e.g. a text clip).` };
      const c = footageClip(footage, clip.media_ref);
      return c ? { c, clip, tl } : null;
    }
    const ref = str(a.media_ref);
    if (!ref)
      return { error: "provide media_ref (a library asset) or clip_id (a placed timeline clip)." };
    const c = known(ref);
    if (c) return { c, clip: null, tl: null };
    // An absolute path or a `..` escape is refused like a name the library does not hold, as the
    // app's resolver refuses it (tools/inspect.ts, store.resolveMediaRef).
    if (isUnsafeAgentRef(ref) || footageClip(footage, ref))
      return { error: `media not found: ${ref}. Pass a library id/filename or a clip_id.` };
    return null;
  }

  /** A source time in the caller's units: project frames for a clip, seconds otherwise (null when the
   *  clip does not show it). */
  const unitOf =
    (clip: Clip | null, fps: number) =>
    (t: number): { t: number } | { frame: number } | null => {
      if (!clip) return { t: round3(t) };
      const f = clipSpanToFrames(clip, t, t, fps);
      return f ? { frame: f[0] } : null;
    };

  /** The span a look covers, in source seconds: the window asked for, else the clip's span, else all. */
  function windowOf(c: FootageClip, clip: Clip | null, fps: number, a: Args): [number, number] {
    const dur = c.duration_s ?? 0;
    const [ws, we] = clip ? clipSourceSpanSeconds(clip, fps) : [0, dur];
    const start = typeof a.start_seconds === "number" ? Math.max(0, a.start_seconds) : ws;
    let end = typeof a.end_seconds === "number" ? a.end_seconds : we;
    if (end <= start) end = dur > start ? dur : start + 1;
    return [round3(start), round3(Math.min(end, dur || end))];
  }

  function transcriptOf(
    c: FootageClip,
    clip: Clip | null,
    fps: number,
    [start, end]: [number, number],
    words: boolean,
  ): Result {
    const fmt = clip ? "[text, start_frame, end_frame]" : "[text, start_s, end_s]";
    const project = (r: readonly [string, number, number]): [string, number, number] | null => {
      if (!clip) return [r[0], round3(r[1]), round3(r[2])];
      const f = clipSpanToFrames(clip, r[1], r[2], fps);
      return f ? [r[0], f[0], f[1]] : null;
    };
    const inWin = (r: readonly [string, number, number]) => !(r[1] > end || r[2] < start);
    const keep = (r: [string, number, number] | null): r is [string, number, number] => r !== null;
    const segs = (c.words ?? []).filter(inWin).map(project).filter(keep);
    const truncated = segs.length > SEGMENT_CAP;
    const next = truncated ? segs[SEGMENT_CAP][1] : null;
    return {
      format: fmt,
      language: c.language ?? "en",
      segments: segs.slice(0, SEGMENT_CAP),
      truncated,
      ...(clip ? { next_start_frame: next } : { next_start_s: next }),
      ...(words
        ? {
            words_format: fmt,
            words: footageWordRows(c).filter(inWin).map(project).filter(keep),
            words_truncated: false,
          }
        : {}),
    };
  }

  function loudnessOf(c: FootageClip, clip: Clip | null, tl: Timeline | null): Result | null {
    if (!hasSound(c)) return null;
    const l = c.loudness ?? DEFAULT_LOUDNESS;
    const base: Result = { ...l, rms_dbfs: round3(l.integrated_lufs - 3) };
    if (!clip || !tl) return base;
    let sound: Clip | null = clip.kind === "audio" ? clip : null;
    if (!sound && clip.link_group)
      for (const t of tl.tracks ?? [])
        for (const x of t.clips ?? [])
          if (x.kind === "audio" && x.link_group === clip.link_group) sound ??= x;
    if (!sound) return base;
    const vol = sound.volume ?? 1;
    if (typeof vol !== "number") return { ...base, clip_volume: "keyframed" };
    const db = vol > 0 ? 20 * Math.log10(vol) : null;
    const move = (v: number) => (db === null ? null : Math.round((v + db) * 10) / 10);
    return {
      ...base,
      clip_volume: vol,
      after_clip_volume:
        db === null
          ? null
          : {
              integrated_lufs: move(l.integrated_lufs),
              true_peak_dbtp: move(l.true_peak_dbtp),
              rms_dbfs: move(l.integrated_lufs - 3),
            },
    };
  }

  registry.register("inspect_media", async (args) => {
    const a = (args ?? {}) as Args;
    const subject = await subjectOf("inspect_media", a);
    if (subject === null)
      return {
        ok: true,
        kind: "video",
        media_ref: str(a.media_ref) || str(a.clip_id),
        frames_attached: 0,
        note: "(eval) frames were not attached in this harness",
      };
    if ("error" in subject) return { ok: false, error: subject.error };
    const { c, clip, tl } = subject;
    const fps = tl ? canvasFps(tl) : 30;
    const metadata = metadataOf(c);
    if (c.kind === "image")
      return {
        ok: true,
        kind: "image",
        media_ref: c.media_ref,
        width: widthOf(c),
        height: heightOf(c),
        frames_attached: 0,
        coordinate_grid: GRID_NOTE,
        metadata,
        note: `(eval) the image was not attached in this harness; what it shows: ${footageShotAt(c, 0)}`,
      };
    const span = windowOf(c, clip, fps, a);
    const at = unitOf(clip, fps);
    const timing = clip ? "project_frames" : "source_seconds";
    const say = (t: number): string => {
      const u = at(t);
      const when = u && "frame" in u ? `frame ${u.frame}` : `${round3(t)} s`;
      return `at ${when}, ${footageShotAt(c, t)}`;
    };
    const base: Result = {
      ok: true,
      kind: c.kind,
      media_ref: c.media_ref,
      duration_s: c.duration_s ?? null,
      window_s: span,
      timing,
      metadata,
      loudness: loudnessOf(c, clip, tl),
      transcript: hasSound(c) ? transcriptOf(c, clip, fps, span, a.word_timestamps === true) : null,
    };
    if (c.kind === "audio") return base;
    if (a.overview === true) {
      const starts = (c.shots ?? [])
        .filter((s) => s.to > span[0] && s.from < span[1])
        .map((s) => Math.max(s.from, span[0]));
      const tiles = spread(starts.length ? starts : [span[0]], OVERVIEW_TILES);
      const units = tiles.map(at).filter((u): u is NonNullable<typeof u> => u !== null);
      return {
        ...base,
        overview: clip
          ? { tile_frames: units.map((u) => ("frame" in u ? u.frame : null)) }
          : { tile_times: units.map((u) => ("t" in u ? u.t : null)) },
        frames_attached: 0,
        note: `(eval) the storyboard was not attached in this harness; what its tiles show: ${tiles.map(say).join("; ")}`,
      };
    }
    const times = mediaLookTimes(span[0], span[1], a.max_frames);
    return {
      ...base,
      frames: times.map(at).filter((u) => u !== null),
      coordinate_grid: GRID_NOTE,
      sharpness: 182.4,
      noise_sigma: 1.1,
      frames_attached: 0,
      note: `(eval) frames were not attached in this harness; what the pictures show: ${times.map(say).join("; ")}`,
    };
  });

  registry.register("video_ask", async (args) => {
    const a = (args ?? {}) as Args;
    const subject = await subjectOf("video_ask", a);
    if (subject === null)
      return { ok: false, error: "video_ask: this file has no picture to ask about" };
    if ("error" in subject) return { ok: false, error: subject.error };
    const { c, clip, tl } = subject;
    if (c.kind === "audio")
      return { ok: false, error: "video_ask: this file has no picture to ask about" };
    const fps = tl ? canvasFps(tl) : 30;
    const span = windowOf(c, clip, fps, a);
    const seconds = span[1] - span[0];
    if (seconds > PAID_LOOK_MAX_S)
      return {
        ok: false,
        error: `too long for video_ask (${seconds.toFixed(0)}s = ${(seconds / 60).toFixed(1)} min, cap ${PAID_LOOK_MAX_S}s = 30 min). Pass a shorter start_seconds/end_seconds window.`,
      };
    const shots = (c.shots ?? []).filter((s) => s.to > span[0] && s.from < span[1]);
    const heard =
      a.visual_only === true
        ? []
        : [
            c.sound,
            ...(c.words ?? [])
              .filter((w) => w[2] > span[0] && w[1] < span[1])
              .map((w) => `"${w[0]}"`),
          ].filter(Boolean);
    const at = unitOf(clip, fps);
    return {
      ok: true,
      response: [...shots.map((s) => s.shows), ...heard].join(". "),
      timing: clip ? "project_frames" : "source_seconds",
      timestamps_found: shots
        .map((s) => ({ text: s.shows, at: at(Math.max(s.from, span[0])) }))
        .filter((x) => x.at !== null)
        .map((x) => ({ text: x.text, ...x.at })),
      video_duration_s: c.duration_s ?? null,
      window_s: clip || typeof a.start_seconds === "number" ? span : null,
    };
  });

  registry.register("video_find_moment", async (args) => {
    const a = (args ?? {}) as Args;
    const subject = await subjectOf("video_find_moment", a);
    if (subject === null)
      return { ok: false, error: "video_find_moment: this file has no picture to search" };
    if ("error" in subject) return { ok: false, error: subject.error };
    const { c, clip, tl } = subject;
    const duration = c.duration_s ?? 0;
    if (c.kind !== "video")
      return { ok: false, error: "video_find_moment: this file has no picture to search" };
    if (duration > PAID_LOOK_MAX_S)
      return {
        ok: false,
        error: `video too long for video_find_moment (${duration.toFixed(0)}s = ${(duration / 60).toFixed(1)} min, cap ${PAID_LOOK_MAX_S}s = 30 min).`,
      };
    const fps = tl ? canvasFps(tl) : 30;
    const query = str(a.query ?? a.prompt).toLowerCase();
    const terms = query.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
    const score = (s: FootageShot) => terms.filter((w) => s.shows.toLowerCase().includes(w)).length;
    const shots = [...(c.shots ?? [])].sort((x, y) => score(y) - score(x));
    const best = shots.filter((s) => score(s) > 0 && score(s) === score(shots[0]));
    const picked = best.length ? best : shots.slice(0, 1);
    const moments = picked
      .map((s) => {
        const why = `this is where ${s.shows}`;
        if (!clip)
          return {
            start_s: s.from,
            end_s: s.to,
            peak_s: round3((s.from + s.to) / 2),
            why,
            shots: [{ in_s: s.from, out_s: s.to, description: s.shows }],
          };
        const f = clipSpanToFrames(clip, s.from, s.to, fps);
        if (!f) return null;
        return {
          start_frame: f[0],
          end_frame: f[1],
          peak_frame: Math.round((f[0] + f[1]) / 2),
          why,
          shots: [{ in_frame: f[0], out_frame: f[1], description: s.shows }],
        };
      })
      .filter((m) => m !== null);
    return {
      ok: true,
      timing: clip ? "project_frames" : "source_seconds",
      moments,
      video_duration_s: duration,
      raw_text: null,
    };
  });

  // ── speech ────────────────────────────────────────────────────────────────

  /** Every audio clip of footage with words, by track, in timeline order (as the real tools walk them:
   *  a video clip's sound is its linked audio clip). */
  const speechByTrack = (tl: Timeline): Map<string, Clip[]> => {
    const out = new Map<string, Clip[]>();
    for (const t of tl.tracks ?? []) {
      if (t.kind !== "audio") continue;
      const clips = (t.clips ?? []).filter((x) => typeof x.media_ref === "string" && x.media_ref);
      if (clips.length)
        out.set(
          t.id,
          [...clips].sort((x, y) => Number(x.timeline_in) - Number(y.timeline_in)),
        );
    }
    return out;
  };
  const wordsOf = (clip: Clip) => {
    const c = footageClip(footage, clip.media_ref);
    return c
      ? footageWordRows(c).map(([word, s, e]) => ({ word, start_seconds: s, end_seconds: e }))
      : [];
  };

  registry.register("get_transcript", async (args) => {
    const a = (args ?? {}) as Args;
    const tl = await timeline();
    const fps = Number(tl.canvas?.fps) || 30;
    const from = typeof a.start_frame === "number" ? a.start_frame : -Infinity;
    const to = typeof a.end_frame === "number" ? a.end_frame : Infinity;
    const wantId = str(a.clip_id);
    let group: string | null = null;
    if (wantId) {
      const found = findClip(tl, wantId);
      if (!found)
        return { ok: false, error: `get_transcript: no clip '${wantId}' on the timeline` };
      group =
        typeof found[1].link_group === "string" && found[1].link_group ? found[1].link_group : null;
    }
    const audio = [...speechByTrack(tl).entries()]
      .flatMap(([track, clips]) => clips.map((clip) => [track, clip] as const))
      .filter(([, x]) => !wantId || x.id === wantId || (group !== null && x.link_group === group))
      .sort((x, y) => Number(x[1].timeline_in) - Number(y[1].timeline_in));
    let idx = 0;
    const clips: Result[] = [];
    for (const [track, clip] of audio) {
      const rows: [number, string, number, number][] = [];
      for (const [text, tf, te] of clipWordFrames(wordsOf(clip), clip, fps)) {
        if (tf < from || tf >= to || tf >= Number(clip.timeline_out)) continue;
        rows.push([idx++, text, tf, te]);
      }
      if (rows.length) clips.push({ clip_id: clip.id, track_id: track, words: rows });
    }
    const preview = clips
      .flatMap((x) => (x.words as [number, string, number, number][]).map((r) => r[1]))
      .join(" ");
    return {
      ok: true,
      fps,
      timing: "project_frames",
      word_format: ["index", "text", "start_frame", "end_frame"],
      clips,
      word_count: idx,
      truncated: false,
      script_preview: preview.slice(0, 600),
      script_chars: preview.length,
    };
  });

  // add_captions as tools/captions.ts makes them, from the footage's words instead of a transcription:
  // the same chunking (one line of the caption box, never past a sentence), timing, gap closing,
  // position and placement.
  registry.register("add_captions", async (args) => {
    const a = (args ?? {}) as Args;
    if (a.subtitle_media_ref !== undefined)
      return {
        ok: false,
        error: `'${String(a.subtitle_media_ref)}' is not a subtitle file (.srt/.vtt). Omit subtitle_media_ref to caption spoken audio.`,
      };
    const tl = await timeline();
    const fps = canvasFps(tl);
    const byTrack = speechByTrack(tl);
    if (!byTrack.size) return { ok: false, error: "no audio on the timeline to caption" };
    const wantTrack = str(a.track_id);
    if (wantTrack && !byTrack.has(wantTrack))
      return {
        ok: false,
        error: `track '${wantTrack}' has no audio clips; omit track_id to caption the track with the most speech`,
      };
    const num = (v: unknown) =>
      Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined;
    const maxGap = a.max_gap_seconds === undefined ? 0.5 : Number(a.max_gap_seconds);
    if (!Number.isFinite(maxGap) || maxGap < 0 || maxGap > 2)
      return { ok: false, error: "max_gap_seconds must be a number from 0 through 2" };
    const textCase = a.case === undefined ? undefined : String(a.case);
    const hero = a.hero === undefined ? "none" : String(a.hero);
    if (!["none", "longest", "first", "last"].includes(hero))
      return { ok: false, error: "hero must be one of none | longest | first | last" };
    const t0 = (a.transform && typeof a.transform === "object" ? a.transform : {}) as Args;
    const pos = (t0.position && typeof t0.position === "object" ? t0.position : {}) as Args;
    const transform = { ...t0, position: { ...CAPTION_DEFAULT_POSITION, ...pos } };
    const style = a.style && typeof a.style === "object" ? (a.style as Clip["style"]) : undefined;
    const canvas = planCanvas(tl);
    const box = textBox({ style, transform: transform as Clip["transform"] }, canvas.w, canvas.h);
    const fits = (text: string) => lineWidthIn(applyCase(text, textCase), box) <= box.wPx;
    type Run = { text: string; t_in: number; t_out: number; emphasis?: boolean };
    const cuesByTrack = new Map<
      string,
      { in: number; out: number; text: string; words: Run[] }[]
    >();
    for (const trackId of wantTrack ? [wantTrack] : [...byTrack.keys()]) {
      const cues: { in: number; out: number; text: string; words: Run[] }[] = [];
      for (const clip of byTrack.get(trackId) ?? []) {
        const c = footageClip(footage, clip.media_ref);
        if (!c) continue;
        const [s0, s1] = clipSourceSpanSeconds(clip, fps);
        const timed: CaptionWord[] = [];
        (c.words ?? []).forEach((row, segment) =>
          footageWordRows({ ...c, words: [row] }).forEach(([text, start, end]) => {
            if (end > s0 - 1 && start < s1 + 1) timed.push({ text, start, end, segment });
          }),
        );
        for (const phrase of chunkWords(timed, {
          fits,
          maxWords: num(a.max_words),
          maxCharacters: num(a.max_characters),
        })) {
          const span = clipSpanToFrames(clip, phrase.start, phrase.end, fps);
          if (!span) continue;
          const card = span[0] / fps;
          const words: Run[] = phrase.words.map((w) => {
            const ws = clipSpanToFrames(clip, w.start, w.end, fps);
            return {
              text: applyCase(w.text, textCase),
              t_in: ws ? ws[0] / fps - card : 0,
              t_out: ws ? ws[1] / fps - card : 0,
            };
          });
          if (hero !== "none" && words.length) {
            let i = hero === "last" ? words.length - 1 : 0;
            if (hero === "longest") {
              const w = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").length;
              words.forEach((r, k) => {
                if (w(r.text) > w(words[i].text)) i = k;
              });
            }
            words[i].emphasis = true;
          }
          cues.push({ in: span[0], out: span[1], text: applyCase(phrase.text, textCase), words });
        }
      }
      if (cues.length) cuesByTrack.set(trackId, cues);
    }
    if (!cuesByTrack.size) return { ok: false, error: "no speech detected to caption" };
    const [sourceTrack, raw] = [...cuesByTrack.entries()].sort(
      (x, y) => y[1].length - x[1].length,
    )[0];
    raw.sort((x, y) => x.in - y.in);
    const limit = Math.max(
      ...(byTrack.get(sourceTrack) ?? []).map((x) => Number(x.timeline_out) || 0),
    );
    const fitted = fitSpans(
      raw.map((x) => ({ in: x.in, out: x.out })),
      { maxGapFrames: Math.round(maxGap * fps), limit },
    );
    const placed: { in: number; out: number; text: string; words: Run[] }[] = [];
    let cursor = 0;
    for (const span of fitted) {
      while (cursor < raw.length && raw[cursor].in < span.in) cursor++;
      const src = raw[Math.min(cursor, raw.length - 1)];
      placed.push({ ...src, in: span.in, out: span.out });
      cursor++;
    }
    if (!placed.length) return { ok: false, error: "no speech detected to caption" };
    const group = newId("cap");
    return ctxApplyOp(ctx, "add_captions", (draft) => {
      const track = resolveTextTrack(
        draft,
        a.text_track_id as string | undefined,
        placed.map((x) => ({ in: x.in, out: x.out })),
      );
      const created: Result[] = [];
      for (const cue of placed) {
        const clip: Clip = {
          id: newId("txt"),
          kind: "text",
          timeline_in: cue.in,
          timeline_out: cue.out,
          content:
            cue.words.length > 1
              ? cue.words.map((w) => ({
                  text: w.text,
                  t_in: w.t_in,
                  t_out: w.t_out,
                  ...(w.emphasis ? { emphasis: true } : {}),
                }))
              : [{ text: cue.text }],
          caption_group: group,
          transform: transform as Clip["transform"],
        };
        if (style) clip.style = style;
        if (a.animation && typeof a.animation === "object")
          clip.animation = a.animation as Clip["animation"];
        (track.clips ??= []).push(clip);
        created.push({ clip_id: clip.id, track_id: track.id });
      }
      return { created, count: created.length, caption_group: group, source_track: sourceTrack };
    });
  });
}
