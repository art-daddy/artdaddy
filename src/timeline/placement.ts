// Clip placement tools (add_clips, insert_clips, add_text_clips): SCHEMA + argument validation +
// the async PREFLIGHT a rule may not do (resolve the path, ffprobe duration / has-audio), then a
// call into timeline/operations.ts. The probes run BEFORE the mutation lease is taken, so a rule
// stays sync and the lease is never held across I/O.
import { stderrExcerpt, type CommandResult, type CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { isUnsafeAgentRef } from "../tools/store";
import { ctxApplyOp, loadTimeline } from "./engine";
import { OpError } from "./errors";
import { canvasFps, toFrames } from "./frames";
import { placeableKind, type MediaKind, type MediaSpec } from "./helpers";
import {
  addTextClips,
  insertClips,
  placeClips,
  updateTextClips,
  type InsertSpec,
} from "./operations";

type Result = Record<string, unknown>;
type Args = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };
const present = (v: unknown): boolean => v !== undefined && v !== null;

/** Message for a probe that RAN but failed (ffprobe exited non-zero) — surfaced
 *  instead of silently assuming a default, so a broken probe can't quietly
 *  misclassify media (the audio-only-.mp4-treated-as-video / oversized-clip bug). */
function probeFail(what: string, source: string, r: CommandResult): string {
  const detail = stderrExcerpt(r.stderr || r.stdout || `exit ${r.code}`, 160);
  return `couldn't probe '${source}' for ${what} (ffprobe: ${detail})`;
}

interface Probe {
  /** Identity of the bytes the answer describes. */
  stamp: string;
  has: boolean;
}

/** Size of `source` right now, or null when the platform cannot say cheaply.
 *
 *  These caches used to be keyed by PATH alone and never invalidated, so an answer outlived the
 *  file it described. Importing links media IN PLACE, so replacing that file is normal use — and
 *  the render's "does this really have audio?" guard then read the stale `true` cached at
 *  placement, emitted `[N:a]` for a source with no audio stream, and ffmpeg refused the whole
 *  graph. Caught by exporting a real project, not by any unit test. Null means don't cache: a
 *  slower probe is always better than a wrong one. */
async function sourceStamp(ctx: ClientToolContext, source: string): Promise<string | null> {
  try {
    const size = await ctx.store.byteSize(source);
    return size === null ? null : String(size);
  } catch {
    return null;
  }
}

const hasAudioCache = new Map<string, Probe>();
/** Test hook: reset the has-audio probe cache. */
export function clearHasAudioCache(): void {
  hasAudioCache.clear();
}

/** True if `source` has an audio stream (cached against the file's current size). A probe FAILURE
 *  (ffprobe exits non-zero) is surfaced as an OpError, not silently assumed; only a runner that
 *  THROWS (ffprobe entirely unavailable) degrades to an optimistic "yes". */
export async function sourceHasAudio(ctx: ClientToolContext, source: string): Promise<boolean> {
  const stamp = await sourceStamp(ctx, source);
  const cached = stamp === null ? undefined : hasAudioCache.get(source);
  if (cached && cached.stamp === stamp) return cached.has;
  let has: boolean;
  try {
    const r = await ctx.runner.run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      source,
    ]);
    if (r.code !== 0) throw new OpError(probeFail("audio streams", source, r));
    has = Boolean(r.stdout.trim());
  } catch (e) {
    if (e instanceof OpError) throw e;
    has = true; // ffprobe unavailable (threw) -> assume audio (graceful)
  }
  if (stamp !== null) hasAudioCache.set(source, { stamp, has });
  return has;
}

const hasVideoCache = new Map<string, Probe>();
/** Test hook: reset the has-video probe cache. */
export function clearHasVideoCache(): void {
  hasVideoCache.clear();
}

/** True if `source` has a VIDEO stream (cached against the file's current size). A probe FAILURE
 *  (ffprobe exits non-zero) is surfaced as an OpError; only a runner that THROWS (ffprobe
 *  entirely unavailable) degrades to "yes" so an unprobeable container still behaves like the
 *  video its extension implies. */
export async function sourceHasVideo(ctx: ClientToolContext, source: string): Promise<boolean> {
  const stamp = await sourceStamp(ctx, source);
  const cached = stamp === null ? undefined : hasVideoCache.get(source);
  if (cached && cached.stamp === stamp) return cached.has;
  let has: boolean;
  try {
    const r = await ctx.runner.run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      source,
    ]);
    if (r.code !== 0) throw new OpError(probeFail("video streams", source, r));
    has = Boolean(r.stdout.trim());
  } catch (e) {
    if (e instanceof OpError) throw e;
    has = true; // ffprobe unavailable (threw) -> trust the extension (graceful)
  }
  if (stamp !== null) hasVideoCache.set(source, { stamp, has });
  return has;
}

const durationCache = new Map<string, number>();
/** Test hook: reset the source-duration probe cache. */
export function clearDurationCache(): void {
  durationCache.clear();
}

/** Source media duration in seconds (cached). A probe FAILURE (ffprobe exits
 *  non-zero) is surfaced as an OpError; a runner that THROWS, or a valid file
 *  with no duration (a still image), yields 0 (callers apply a still default). */
export async function sourceDurationSeconds(
  runner: CommandRunner,
  source: string,
): Promise<number> {
  const cached = durationCache.get(source);
  if (cached !== undefined) return cached;
  let dur = 0;
  try {
    const r = await runner.run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      source,
    ]);
    if (r.code !== 0) throw new OpError(probeFail("duration", source, r));
    const v = parseFloat(r.stdout.trim());
    if (Number.isFinite(v)) dur = v; // code 0 + no duration (a still image) -> 0
  } catch (e) {
    if (e instanceof OpError) throw e;
    dur = 0; // ffprobe unavailable (threw) -> 0 (still-default / graceful)
  }
  durationCache.set(source, dur);
  return dur;
}

/** [startSeconds, endSeconds] -> [source_in_frames, source_out_frames]. */
function sourceSpanFrames(span: unknown, fps: number): [number, number] {
  if (!Array.isArray(span) || span.length !== 2)
    throw new OpError("source_span must be [startSeconds, endSeconds]");
  const s0 = Number(span[0]);
  const s1 = Number(span[1]);
  if (!Number.isFinite(s0) || !Number.isFinite(s1))
    throw new OpError("source_span values must be numbers (seconds)");
  if (s0 < 0 || s1 <= s0)
    throw new OpError(`source_span must have 0 <= start < end (got ${JSON.stringify(span)})`);
  return [Math.round(s0 * fps), Math.round(s1 * fps)];
}

/** [startSeconds, endSeconds] -> [source_in, source_out] frames, CLAMPED to the
 *  source's real duration so a guessed/oversized end can't create a clip that
 *  runs past EOF (a blank/silent tail — the "30-minute clip" bug). Only clamps
 *  when the probe yields a duration (durF > 0); stills/unprobeable spans pass
 *  through. Throws if the span starts at/after the media's end. */
async function spanToFrames(
  ctx: ClientToolContext,
  span: unknown,
  fps: number,
  abs: string,
): Promise<[number, number]> {
  const [sIn, sOut] = sourceSpanFrames(span, fps);
  const durF = Math.round((await sourceDurationSeconds(ctx.runner, abs)) * fps);
  if (durF > 0) {
    if (sIn >= durF) {
      throw new OpError(
        `source_span start ${(sIn / fps).toFixed(2)}s is at/after the media's end (${(durF / fps).toFixed(2)}s)`,
      );
    }
    if (sOut > durF) return [sIn, durF]; // clamp an oversized/guessed span to EOF
  }
  return [sIn, sOut];
}

interface Placement {
  tin: number;
  tout: number;
  sIn: number | null;
  sOut: number | null;
  loop: boolean;
  stretch: boolean;
  note?: string;
}

/** Resolve an add_clips entry's length: ONE of source_span (seconds) or
 *  timeline_out/duration (frames); loop/stretch (audio) fill a longer span.
 *  Fence + report: the model often sets more than one — keep the canonical one
 *  (source_span > length; loop > stretch) and return a `note` rather than reject. */
async function resolvePlace(
  ctx: ClientToolContext,
  entry: Args,
  fps: number,
  abs: string,
  kind: MediaKind,
): Promise<Placement> {
  if (!present(entry.timeline_in)) throw new OpError("each entry needs 'timeline_in'");
  const tin = toFrames(entry.timeline_in, fps);
  let loop = Boolean(entry.loop);
  let stretch = Boolean(entry.stretch);
  const notes: string[] = [];
  if (loop && stretch) {
    stretch = false;
    notes.push(
      "set both loop and stretch; kept loop and ignored stretch (both fill a longer span).",
    );
  }
  if ((loop || stretch) && kind !== "audio")
    throw new OpError("loop/stretch apply to audio clips only");

  // The model often fills MORE than one length field, padding the unused ones
  // with zeros / [0,0]. Treat only NON-degenerate values as given, then pick one:
  // a fill (loop/stretch) always uses timeline_out/duration; otherwise a valid
  // source_span wins; else timeline_out/duration.
  const span = entry.source_span;
  const spanValid =
    Array.isArray(span) &&
    span.length === 2 &&
    Number.isFinite(Number(span[0])) &&
    Number.isFinite(Number(span[1])) &&
    Number(span[0]) >= 0 &&
    Number(span[1]) > Number(span[0]);
  const toutValid = present(entry.timeline_out) && toFrames(entry.timeline_out, fps) > tin;
  const durValid = present(entry.duration) && toFrames(entry.duration, fps) > 0;
  const toutOf = () =>
    toutValid ? toFrames(entry.timeline_out, fps) : tin + toFrames(entry.duration, fps);
  const noteOf = (): string | undefined => (notes.length ? notes.join(" ") : undefined);

  if (loop || stretch) {
    if (!toutValid && !durValid)
      throw new OpError("loop/stretch need a timeline_out or duration to fill");
    const sOut = Math.round((await sourceDurationSeconds(ctx.runner, abs)) * fps);
    if (sOut <= 0)
      throw new OpError(`could not determine source duration for loop/stretch fill: ${abs}`);
    return { tin, tout: toutOf(), sIn: 0, sOut, loop, stretch, note: noteOf() };
  }
  if (spanValid) {
    // Class-A cross-check: source_span and timeline_out/duration both set the length.
    // source_span (a real slice of the asset) WINS; if the length the model also set
    // disagrees, coerce to the span and say so (LOUD note) rather than rejecting — a hard
    // reject loops models that can't retract the extra field.
    if (toutValid || durValid) {
      const [rs, re] = span as [number, number];
      const spanLen = Math.round((Number(re) - Number(rs)) * fps);
      const wantLen = toutValid
        ? toFrames(entry.timeline_out, fps) - tin
        : toFrames(entry.duration, fps);
      if (Math.abs(spanLen - wantLen) > 1) {
        // Naming the DISAGREEMENT is not naming the CONSEQUENCE. "they disagreed on the length"
        // read as a tidy precedence note, so a span 2 frames short of the requested window landed
        // as an unexplained black flash frames later. Say where the clip actually ends and that
        // the remainder is a hole.
        notes.push(
          spanLen < wantLen
            ? `used source_span (~${spanLen} frames), ${wantLen - spanLen} SHORTER than the timeline_out/duration you also set (${wantLen}): this clip ends at frame ${tin + spanLen}, leaving a ${wantLen - spanLen}-frame GAP before ${tin + wantLen}. To fill the whole span, pass duration with loop or stretch instead of source_span.`
            : `used source_span (~${spanLen} frames); ignored the timeline_out/duration you also set (${wantLen} frames) — they disagreed on the length.`,
        );
      }
    }
    const [sIn, sOut] = await spanToFrames(ctx, span, fps, abs);
    return {
      tin,
      tout: tin + (sOut - sIn),
      sIn,
      sOut,
      loop: false,
      stretch: false,
      note: noteOf(),
    };
  }
  if (toutValid || durValid) {
    return {
      tin,
      tout: toutOf(),
      sIn: null,
      sOut: null,
      loop: false,
      stretch: false,
      note: noteOf(),
    };
  }
  // No length given -> place the WHOLE source at 1x (omit = whole asset, other NLEs);
  // stills / unprobeable default to 5s.
  let durF = Math.round((await sourceDurationSeconds(ctx.runner, abs)) * fps);
  if (durF <= 0) durF = Math.round(5 * fps);
  return {
    tin,
    tout: tin + durF,
    sIn: null,
    sOut: null,
    loop: false,
    stretch: false,
    note: noteOf(),
  };
}

/** Media that is still being GENERATED: a catalog row and a path, but no file yet.
 *  `resolveMediaRef` returns null for it (it checks existence), so without this the ref falls
 *  through to ffprobe and the contract's promise — place it now, it fills in later — is false. */
async function pendingMediaRow(
  ctx: ClientToolContext,
  ref: string,
): Promise<{ id: string; path: string; kind: MediaKind } | null> {
  const row = await ctx.store.pendingMedia(ref).catch(() => null);
  if (!row) return null;
  const kind = (row.kind === "audio" || row.kind === "image" ? row.kind : "video") as MediaKind;
  return { id: row.id, path: row.path, kind };
}

async function resolveAddEntry(
  ctx: ClientToolContext,
  entry: Args,
  fps: number,
): Promise<MediaSpec & { note?: string }> {
  const raw = String(entry.media_ref ?? "").trim();
  if (!raw) throw new OpError("each entry needs a non-empty 'media_ref'");
  // The agent places media by LIBRARY REF (media id / filename / contained project-relative path)
  // only — never a raw system path. Reject a bare absolute path or a '..' escape outright, so
  // add_clips can't pull an arbitrary local file onto the timeline (which render/preview would then
  // read); a non-absolute UNRESOLVED ref still falls through to ffprobe (unchanged). An EXTERNAL
  // referenced-in-place clip is created by the USER import path, not here.
  if (isUnsafeAgentRef(raw))
    throw new OpError(
      `media_ref must be a library asset (media id / filename), not a system path: ${raw}`,
    );
  const abs = (await ctx.store.resolveMediaRef(raw)) ?? raw;
  // Still generating: trust the catalog row instead of probing bytes that do not exist yet.
  const pending = await pendingMediaRow(ctx, raw);
  if (pending) {
    if (!present(entry.timeline_out) && !present(entry.duration))
      throw new OpError(
        `'${raw}' is still being generated, so its length is not known yet — give this entry a timeline_out or duration.`,
      );
    const place = await resolvePlace(ctx, entry, fps, pending.path, pending.kind);
    return {
      source: pending.id,
      kind: pending.kind,
      tin: place.tin,
      tout: place.tout,
      sIn: place.sIn,
      sOut: place.sOut,
      loop: place.loop,
      stretch: place.stretch,
      // Unknowable until it lands, and video models split both ways (Veo emits audio, image-to-video
      // does not). Optimistic only because resolveClipSources disables an audio clip whose source
      // turns out to have no stream: before that guard this cost a user every render in the project,
      // since ffmpeg fails the WHOLE graph on one `[N:a]` that matches nothing.
      hasAudio: pending.kind === "video",
      withAudio: entry.with_audio === false ? false : undefined,
      trackId: entry.track_id as string | undefined,
      note: place.note,
    };
  }
  let kind = placeableKind(abs);
  // A container ext (.mp4/.mov/...) can be AUDIO-ONLY. Treat a "video" source with
  // no video stream as audio, so it places ONE audio clip (not a video shell + a
  // spuriously split linked-audio clip on a second track).
  if (kind === "video" && !(await sourceHasVideo(ctx, abs))) kind = "audio";
  const place = await resolvePlace(ctx, entry, fps, abs, kind);
  const hasAudio = kind === "video" ? await sourceHasAudio(ctx, abs) : false;
  // Store the LIBRARY ID, never a path — so get_timeline shows the model the same
  // handle every other tool takes. Uncatalogued media falls back to the portable
  // project-relative form, and the clip's `kind` is recorded either way.
  return {
    source: await ctx.store.toMediaRef(abs),
    kind,
    tin: place.tin,
    tout: place.tout,
    sIn: place.sIn,
    sOut: place.sOut,
    loop: place.loop,
    stretch: place.stretch,
    hasAudio,
    withAudio: entry.with_audio === false ? false : undefined,
    trackId: entry.track_id as string | undefined,
    note: place.note,
  };
}

export async function addClipsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  const entries = args.entries;
  if (!Array.isArray(entries) || entries.length === 0)
    return { ok: false, error: "entries[] must be non-empty" };
  let specs: Array<MediaSpec & { note?: string }>;
  try {
    specs = await resolveAddSpecs(ctx, entries as Args[]);
  } catch (e) {
    if (e instanceof OpError) return { ok: false, error: e.message };
    throw e;
  }
  // If the project was closed/superseded while the async preflight (resolve + ffprobe) ran, the
  // session-liveness guard in saveTimeline abandons the write — the clip never lands in a project
  // the user already left. No per-tool guard needed: it's enforced centrally at the commit.
  return ctxApplyOp(ctx, "add_clips", (timeline) => placeClips(timeline, specs));
}

/** Resolve entries to placeable specs — every probe and path lookup, and NO mutation.
 *
 *  Split out so a multi-file gesture can do all of this BEFORE taking the mutation lease and then
 *  commit the placements as one undoable intent; holding the lease across ffprobe would stall
 *  every other edit in the app. */
export async function resolveAddSpecs(
  ctx: ClientToolContext,
  entries: Args[],
): Promise<Array<MediaSpec & { note?: string }>> {
  const fps = canvasFps(await loadTimeline(ctx.store));
  return Promise.all(entries.map((e) => resolveAddEntry(ctx, e, fps)));
}

async function resolveInsertEntry(
  ctx: ClientToolContext,
  entry: Args,
  fps: number,
): Promise<InsertSpec> {
  const raw = String(entry.media_ref ?? "").trim();
  if (!raw) throw new OpError("each entry needs a non-empty 'media_ref'");
  // Same containment as resolveAddEntry: reject a raw system path (absolute / '..' escape); a
  // non-absolute unresolved ref still falls through to ffprobe.
  if (isUnsafeAgentRef(raw))
    throw new OpError(
      `media_ref must be a library asset (media id / filename), not a system path: ${raw}`,
    );
  const abs = (await ctx.store.resolveMediaRef(raw)) ?? raw;
  // Same as resolveAddEntry: generating media has no bytes to probe, and insert_clips is the
  // other door onto the timeline — a guard on only one of them is the gap, not the fix.
  const pendingIns = await pendingMediaRow(ctx, raw);
  if (pendingIns) {
    if (!present(entry.duration))
      throw new OpError(
        `'${raw}' is still being generated, so its length is not known yet — give this entry a duration.`,
      );
    const dur = toFrames(entry.duration, fps);
    if (dur <= 0) throw new OpError(`insert entry duration must be > 0 (got ${dur} frames)`);
    return {
      source: pendingIns.id,
      kind: pendingIns.kind,
      dur,
      sIn: null,
      sOut: null,
      // Optimistic for the same reason as resolveAddEntry, and safe for the same reason.
      hasAudio: pendingIns.kind === "video",
      withAudio: entry.with_audio === false ? false : undefined,
      loop: false,
      stretch: false,
      note: undefined,
    };
  }
  let kind = placeableKind(abs);
  if (kind === "video" && !(await sourceHasVideo(ctx, abs))) kind = "audio";
  const span = entry.source_span;
  const spanValid =
    Array.isArray(span) &&
    span.length === 2 &&
    Number.isFinite(Number(span[0])) &&
    Number.isFinite(Number(span[1])) &&
    Number(span[0]) >= 0 &&
    Number(span[1]) > Number(span[0]);
  const durValid = present(entry.duration) && toFrames(entry.duration, fps) > 0;
  let loop = Boolean(entry.loop);
  let stretch = Boolean(entry.stretch);
  const notes: string[] = [];
  // Fence + report: loop and stretch are two ways to fill a longer span — keep loop.
  if (loop && stretch) {
    stretch = false;
    notes.push(
      "set both loop and stretch; kept loop and ignored stretch (both fill a longer span).",
    );
  }
  if ((loop || stretch) && kind !== "audio")
    throw new OpError("loop/stretch apply to audio clips only");
  let dur: number;
  let sIn: number | null;
  let sOut: number | null;
  if (spanValid) {
    // Class-A cross-check: source_span and duration both set the length. source_span WINS;
    // a disagreeing duration is coerced away with a LOUD note (never rejected).
    if (durValid) {
      const [rs, re] = span as [number, number];
      const spanLen = Math.round((Number(re) - Number(rs)) * fps);
      const wantLen = toFrames(entry.duration, fps);
      if (Math.abs(spanLen - wantLen) > 1) {
        notes.push(
          `used source_span (~${spanLen} frames); ignored the duration you also set (${wantLen} frames) — they disagreed on the length.`,
        );
      }
    }
    // loop/stretch are fill MODES, not a length value — precedence + note (source_span wins).
    if (loop || stretch) {
      notes.push(
        "source_span cuts an exact span, so the loop/stretch you also passed was ignored — use duration + loop/stretch to fill a longer span.",
      );
      loop = false;
      stretch = false;
    }
    [sIn, sOut] = await spanToFrames(ctx, span, fps, abs);
    dur = sOut - sIn;
  } else if (durValid) {
    dur = toFrames(entry.duration, fps);
    if (loop || stretch) {
      const nat = Math.round((await sourceDurationSeconds(ctx.runner, abs)) * fps);
      if (nat <= 0)
        throw new OpError(`could not determine source duration for loop/stretch fill: ${abs}`);
      sIn = 0;
      sOut = nat;
    } else {
      sIn = null;
      sOut = null;
    }
  } else {
    // Omit both -> splice the WHOLE source at 1x (stills default to 5s).
    dur = Math.round((await sourceDurationSeconds(ctx.runner, abs)) * fps);
    if (dur <= 0) dur = Math.round(5 * fps);
    sIn = null;
    sOut = null;
  }
  if (dur <= 0) throw new OpError(`insert entry duration must be > 0 (got ${dur} frames)`);
  const hasAudio = kind === "video" ? await sourceHasAudio(ctx, abs) : false;
  return {
    source: await ctx.store.toMediaRef(abs),
    kind,
    dur,
    sIn,
    sOut,
    hasAudio,
    withAudio: entry.with_audio === false ? false : undefined,
    loop,
    stretch,
    note: notes.length ? notes.join(" ") : undefined,
  };
}

export async function insertClipsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  const entries = args.entries;
  if (!Array.isArray(entries) || entries.length === 0)
    return { ok: false, error: "entries[] must be non-empty" };
  let fps: number;
  try {
    fps = canvasFps(await loadTimeline(ctx.store));
  } catch (e) {
    return { ok: false, error: `could not read timeline.json: ${String(e)}` };
  }
  let atF: number;
  try {
    atF = toFrames(args.at, fps);
  } catch (e) {
    if (e instanceof OpError) return { ok: false, error: e.message };
    throw e;
  }
  if (atF < 0) return { ok: false, error: "'at' must be >= 0 frames" };
  let specs: InsertSpec[];
  try {
    specs = await Promise.all(entries.map((e) => resolveInsertEntry(ctx, e as Args, fps)));
  } catch (e) {
    if (e instanceof OpError) return { ok: false, error: e.message };
    throw e;
  }
  return ctxApplyOp(ctx, "insert_clips", (timeline) =>
    insertClips(timeline, specs, args.track_id as string | undefined, atF),
  );
}
export function addTextClipsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  const entries = args.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return Promise.resolve({ ok: false, error: "entries[] must be non-empty" });
  }
  return ctxApplyOp(ctx, "add_text_clips", (timeline) => addTextClips(timeline, entries as Args[]));
}

const TEXT_PATCH_KEYS = ["content", "style", "transform", "animation", "rotate"] as const;

export function updateTextTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return Promise.resolve(NOT_READY);
  const ids = Array.isArray(args.clip_ids) ? args.clip_ids.map(String).filter(Boolean) : [];
  const group = String(args.caption_group ?? "").trim();
  if (!ids.length && !group) {
    return Promise.resolve({ ok: false, error: "pass clip_ids[] or caption_group" });
  }
  if (!TEXT_PATCH_KEYS.some((k) => args[k] !== undefined)) {
    return Promise.resolve({
      ok: false,
      error: `pass at least one of ${TEXT_PATCH_KEYS.join(", ")} to change`,
    });
  }
  return ctxApplyOp(ctx, "update_text", (timeline) => {
    // The group is resolved INSIDE the op, against the timeline being written: resolving it
    // outside would restyle whatever the group held when the call started.
    const targets = group
      ? (timeline.tracks ?? [])
          .flatMap((t) => t.clips ?? [])
          .filter((c) => c.caption_group === group)
          .map((c) => String(c.id))
      : ids;
    if (group && !targets.length) throw new OpError(`no clips found for caption_group: ${group}`);
    return updateTextClips(timeline, targets, args);
  });
}
