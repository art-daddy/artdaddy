// Pure timeline-manipulation helpers shared by placement/edit/props ops (no
// I/O, no async). Ports the helper layer of timeline_op_tools.py +
// timeline_edit_tools.py (_detect_kind, _resolve_track, _append_media_clip,
// _split_clip_at, link_partners, ...).
import { OpError } from "./errors";
import { newId, toFrames } from "./frames";
import type { Clip, Timeline, Track } from "./model";

export const AUDIO_EXTS = new Set([
  ".wav",
  ".mp3",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
  ".aif",
  ".aiff",
  ".wma",
]);
export const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".avif",
]);
export const DEFAULT_TRACK: Record<string, string> = { audio: "music", text: "captions" };
/** Must be one of `starterTracks()`, else the first clip lands on a track created beside
 *  the empty starter one. */
export const DEFAULT_VISUAL_TRACK = "v1";

export type MediaKind = "video" | "image" | "audio" | "lottie" | "subtitle";

function ext(p: string): string {
  const m = p.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
}

/** Classify a source path into video | image | audio | lottie | subtitle by extension. */
export function detectKind(source: string): MediaKind {
  const e = ext(source);
  if (e === ".lottie") return "lottie";
  if (e === ".srt" || e === ".vtt") return "subtitle";
  if (IMAGE_EXTS.has(e)) return "image";
  if (AUDIO_EXTS.has(e)) return "audio";
  return "video";
}

/** The kind to place a clip of, refusing anything that cannot BE a clip.
 *
 *  A subtitle has no picture and no sound: probing, drawing or rendering one fails, and
 *  detectKind's fallback would call it "video". Both placement paths ask here rather than each
 *  remembering the exception. */
export function placeableKind(source: string): MediaKind {
  const kind = detectKind(source);
  if (kind === "subtitle") {
    throw new OpError(
      `'${source}' is a subtitle file and can't be placed as a clip — use add_captions with subtitle_media_ref to place its cues as captions`,
    );
  }
  return kind;
}

export function clipKind(clip: Clip): string {
  const k = clip.kind;
  // The clip CARRIES its kind (other NLEs stores mediaType on the clip for the same
  // reason). Deriving it from the ref only works while the ref is a path with an
  // extension — a bare library id has none, and every image would read as video.
  if (k === "audio" || k === "text" || k === "image" || k === "video") return k;
  return clip.media_ref ? detectKind(String(clip.media_ref)) : "video"; // legacy clips
}

function trackKindFor(kind: string): Track["kind"] {
  if (kind === "audio") return "audio";
  if (kind === "text") return "text";
  return "video";
}

/** Map a [start_s, end_s] SOURCE-seconds range on a clip's underlying media to the
 *  clip's PROJECT-FRAME range, through its trim + speed + timeline position:
 *  frame = timeline_in + (seconds*fps - source_in) / speed. Returns null when the
 *  range is wholly outside the clip's visible span; otherwise clamps endpoints to
 *  [timeline_in, timeline_out]. Pure. Shared by the perception tools (inspect_media
 *  already inlines this) so a placed clip_id reports edit-ready frames, not source
 *  seconds — the "clip_id -> project frames, media_ref -> source seconds" rule. */
export function clipSpanToFrames(
  clip: Pick<Clip, "source_in" | "timeline_in" | "timeline_out" | "speed">,
  startS: number,
  endS: number,
  fps: number,
): [number, number] | null {
  const tin = Number(clip.timeline_in) || 0;
  const tout = Number(clip.timeline_out) || 0;
  const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
  const srcIn = Number(clip.source_in) || 0;
  const toFrame = (ts: number): number => tin + (ts * fps - srcIn) / speed;
  let sf = toFrame(startS);
  let ef = toFrame(endS);
  if (ef < tin || sf > tout) return null;
  sf = Math.max(tin, Math.min(tout, sf));
  ef = Math.max(tin, Math.min(tout, ef));
  return [Math.round(sf), Math.round(ef)];
}

/** The SOURCE-seconds span a clip actually shows: the inverse of clipSpanToFrames over the
 *  clip's visible range. Derived from timeline_out rather than source_out so it cannot inherit
 *  an out-of-range source_out — the manual-trim path has written those before. Pure. */
export function clipSourceSpanSeconds(
  clip: Pick<Clip, "source_in" | "timeline_in" | "timeline_out" | "speed">,
  fps: number,
): [number, number] {
  const tin = Number(clip.timeline_in) || 0;
  const tout = Number(clip.timeline_out) || 0;
  const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
  const srcIn = Number(clip.source_in) || 0;
  const visible = Math.max(0, tout - tin);
  return [srcIn / fps, (srcIn + visible * speed) / fps];
}

export function nextZ(tracks: Track[]): number {
  const zs = tracks.map((t) => t.z).filter((z): z is number => typeof z === "number");
  return zs.length ? Math.trunc(Math.max(...zs)) + 1 : 0;
}

export function findTrack(timeline: Timeline, id: string): Track | undefined {
  return (timeline.tracks ?? []).find((t) => t.id === id);
}

export function findClip(timeline: Timeline, clipId: string): [Track, Clip] | null {
  for (const t of timeline.tracks ?? []) {
    for (const c of t.clips ?? []) {
      if (c !== null && typeof c === "object" && c.id === clipId) return [t, c];
    }
  }
  return null;
}

/** Every OTHER clip sharing this clip's link_group (e.g. a video's split audio). */
export function linkPartners(timeline: Timeline, clip: Clip): Array<[Track, Clip]> {
  const lg = clip.link_group;
  if (!lg) return [];
  const out: Array<[Track, Clip]> = [];
  for (const t of timeline.tracks ?? []) {
    for (const c of t.clips ?? []) {
      if (c !== null && typeof c === "object" && c.link_group === lg && c.id !== clip.id)
        out.push([t, c]);
    }
  }
  return out;
}

/** Drag a clip's link partners with a timing edit.
 *
 *  ONE rule for every door, because two doors owning this diverged: `trim_clips` set each
 *  partner's edges EQUAL to the lead's (destroying a J/L offset), while
 *  `set_clip_properties` locked the partner's LENGTH to the lead's but left its start
 *  (correct for a tail trim, wrong for a head trim — which it simply never performed).
 *
 *  Each edge moves by the SAME DELTA as the lead's, which is Premiere's behaviour and
 *  satisfies both: an aligned pair stays aligned through a head trim, a J/L offset
 *  survives, and an equal-length pair stays equal-length (t008) because both edges shift
 *  by their own delta. `window` is the lead's resolved source window, copied so a slip
 *  cannot leave the audio playing content the picture moved away from. */
/** All clip ids sharing `clipId`'s link group (incl. itself); a lone clip -> [clipId].
 *  The one answer to "what travels with this clip": selection expands to it, and the drag
 *  path excludes it from snap targets so a pair cannot snap to its own starting edges. */
export function linkGroupIds(timeline: Timeline | null, clipId: string): string[] {
  let lg: unknown;
  for (const t of timeline?.tracks ?? [])
    for (const c of t.clips ?? []) if (String(c.id) === clipId) lg = c.link_group;
  if (lg == null) return [clipId];
  const ids: string[] = [];
  for (const t of timeline?.tracks ?? [])
    for (const c of t.clips ?? []) if (c.link_group === lg && c.id) ids.push(String(c.id));
  return ids.length ? ids : [clipId];
}

export function dragLinkPartners(
  partners: Clip[],
  before: { timeline_in: number; timeline_out: number },
  after: { timeline_in: number; timeline_out: number },
  window?: { source_in: number; source_out: number },
): void {
  const dIn = after.timeline_in - before.timeline_in;
  const dOut = after.timeline_out - before.timeline_out;
  for (const pc of partners) {
    pc.timeline_in = (Number(pc.timeline_in) || 0) + dIn;
    pc.timeline_out = (Number(pc.timeline_out) || 0) + dOut;
    if (window) {
      pc.source_in = window.source_in;
      pc.source_out = window.source_out;
    }
  }
}

/** Tracks a ripple should shift ALONGSIDE the anchor to keep cross-track alignment
 *  (Premiere "sync lock"): every OTHER track that is sync-locked (absent flag =
 *  locked, the default) and not exempted by `ignoreIds`. */
export function syncLockedTracks(
  timeline: Timeline,
  anchor: Track,
  ignoreIds: Set<string>,
): Track[] {
  return (timeline.tracks ?? []).filter(
    (t) => t !== anchor && t.sync_locked !== false && !ignoreIds.has(t.id),
  );
}

/** Re-lock each linked group's partners to its LEAD (the group's video clip, else
 *  the first member). Same-source split A/V -- a video + its OWN extracted audio
 *  (matching media_ref) -- must stay identical, so the partner inherits the lead's
 *  speed and length (keeping its own start, so J/L offsets survive). A CROSS-source
 *  user link (e.g. a video + a separate, longer music bed) only "moves together":
 *  its speed/length are left alone. A/V that share a source must share speed --
 *  a mismatch is never intentional and desyncs playback (the t008 bug). Enforced
 *  as a post-mutation invariant in applyOp, so no edit path can leave a same-source
 *  pair desynced. Standalone audio (BGM loop/stretch) has no link_group -> untouched. */
export function normalizeLinks(timeline: Timeline): void {
  const tracks = (timeline as Timeline | null | undefined)?.tracks;
  if (!Array.isArray(tracks)) return;
  const groups = new Map<string, Clip[]>();
  for (const t of tracks) {
    if (t === null || typeof t !== "object") continue;
    const clips = t.clips;
    if (!Array.isArray(clips)) continue;
    for (const c of clips) {
      if (c !== null && typeof c === "object" && c.link_group) {
        let arr = groups.get(c.link_group);
        if (!arr) groups.set(c.link_group, (arr = []));
        arr.push(c);
      }
    }
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const lead = members.find((c) => c.kind !== "audio") ?? members[0];
    const leadLen = (Number(lead.timeline_out) || 0) - (Number(lead.timeline_in) || 0);
    for (const c of members) {
      if (c === lead || c.media_ref !== lead.media_ref) continue; // only same-source split A/V
      if (lead.speed === undefined) delete (c as Record<string, unknown>).speed;
      else c.speed = lead.speed;
      c.timeline_out = (Number(c.timeline_in) || 0) + leadLen;
    }
  }
}

/** Return (or create) the track to place a clip of `kind` on. */
export function resolveTrack(
  timeline: Timeline,
  trackId: string | null | undefined,
  kind: string,
  create: boolean,
): Track {
  const tracks = timeline.tracks;
  const wantKind = trackKindFor(kind);
  const targetId = trackId || DEFAULT_TRACK[kind] || DEFAULT_VISUAL_TRACK;
  const existing = tracks.find((t) => t.id === targetId);
  if (existing) {
    // An explicit track_id must match the clip's kind (parity with established NLEs): a video/image
    // clip needs a video track, audio an audio track, text a text track. Silently
    // dropping a video clip onto an audio track (or vice-versa) yields an unrenderable
    // timeline, so refuse instead — applyOp turns this into an atomic {ok:false}.
    if (existing.kind !== wantKind) {
      throw new OpError(
        `track '${targetId}' is a ${existing.kind} track; a ${kind} clip needs a ${wantKind} track`,
      );
    }
    return existing;
  }
  if (!create) throw new OpError(`track '${targetId}' not found`);
  const track: Track = { id: targetId, kind: wantKind, z: nextZ(tracks), clips: [] };
  tracks.push(track);
  return track;
}

/** Resolve a placement entry's (timeline_in, timeline_out) in frames. */
export function spanFrames(entry: Record<string, unknown>, fps: number): [number, number] {
  if (entry.timeline_in === undefined || entry.timeline_in === null)
    throw new OpError("each entry needs 'timeline_in'");
  const tin = toFrames(entry.timeline_in, fps);
  let tout: number;
  if (entry.timeline_out !== undefined && entry.timeline_out !== null)
    tout = toFrames(entry.timeline_out, fps);
  else if (entry.duration !== undefined && entry.duration !== null)
    tout = tin + toFrames(entry.duration, fps);
  else throw new OpError("each entry needs 'timeline_out' or 'duration'");
  if (tout <= tin)
    throw new OpError(`timeline_out must be after timeline_in (got in=${tin}, out=${tout} frames)`);
  return [tin, tout];
}

function spanOverlaps(clips: Clip[], tin: number, tout: number): boolean {
  for (const c of clips) {
    if (c === null || typeof c !== "object") continue;
    const ci = c.timeline_in;
    const co = c.timeline_out;
    if (typeof ci === "number" && typeof co === "number" && ci < tout && tin < co) return true;
  }
  return false;
}

function nextAudioTrackId(tracks: Track[]): string {
  const existing = new Set(tracks.map((t) => t.id));
  let n = 1;
  while (existing.has(`a${n}`)) n++;
  return `a${n}`;
}

/** A text track the whole caption group fits on, creating one if every existing track is busy.
 *
 *  add_captions derives its own timings, so it owns the choice of where they land. Taking the
 *  default track unconditionally meant one pre-existing title was enough to make the entire
 *  call fail validation ("timeline_in=0 overlaps prev") and change nothing — a plain
 *  "add a title, then caption it" sequence. An explicit track_id is still honoured as given:
 *  the caller asked for that track, and quietly moving their captions elsewhere is worse. */
export function resolveCaptionTrack(
  timeline: Timeline,
  trackId: string | null | undefined,
  spans: Array<{ in: number; out: number }>,
): Track {
  if (trackId) return resolveTrack(timeline, trackId, "text", true);
  const fits = (t: Track) => !spans.some((s) => spanOverlaps(t.clips ?? [], s.in, s.out));
  const free = timeline.tracks.find((t) => t.kind === "text" && fits(t));
  if (free) return free;
  const existing = new Set(timeline.tracks.map((t) => t.id));
  if (!existing.has(DEFAULT_TRACK.text))
    return resolveTrack(timeline, DEFAULT_TRACK.text, "text", true);
  let n = 2;
  while (existing.has(`${DEFAULT_TRACK.text}${n}`)) n++;
  return resolveTrack(timeline, `${DEFAULT_TRACK.text}${n}`, "text", true);
}

function resolveLinkedAudioTrack(timeline: Timeline, tin: number, tout: number): Track {
  const tracks = timeline.tracks;
  const musicId = DEFAULT_TRACK.audio;
  for (const t of tracks) {
    if (t.kind !== "audio" || t.id === musicId) continue;
    if (!spanOverlaps(t.clips ?? [], tin, tout)) return t;
  }
  const track: Track = { id: nextAudioTrackId(tracks), kind: "audio", z: nextZ(tracks), clips: [] };
  tracks.push(track);
  return track;
}

/** An audio track the clip FITS on, for a placement that named no track.
 *
 *  Sending every unaddressed audio clip to the default zone meant the second one destroyed the
 *  first under same-track overwrite semantics: a voiceover placed first, then a music bed, and the
 *  narration was gone. Overwrite is correct when the caller NAMES a track — they pointed at it —
 *  but "put this somewhere" should not mean "put this where the last one is". Same rule other NLEs
 *  uses (`resolveOrCreateAudioTrack` → `availableAudioTrackIndex`): reuse a lane whose span is
 *  free, else open a new one, so dialogue stays put and music/VO land alongside it.
 *
 *  The default zone is still tried FIRST, so a project with one bed and nothing else is unchanged. */
function resolveFreeAudioTrack(timeline: Timeline, tin: number, tout: number): Track {
  const tracks = timeline.tracks;
  const preferred = tracks.find((t) => t.id === DEFAULT_TRACK.audio && t.kind === "audio");
  if (preferred && !spanOverlaps(preferred.clips ?? [], tin, tout)) return preferred;
  if (!preferred && !tracks.some((t) => t.kind === "audio"))
    return resolveTrack(timeline, DEFAULT_TRACK.audio, "audio", true);
  for (const t of tracks) {
    if (t.kind !== "audio") continue;
    if (!spanOverlaps(t.clips ?? [], tin, tout)) return t;
  }
  const track: Track = { id: nextAudioTrackId(tracks), kind: "audio", z: nextZ(tracks), clips: [] };
  tracks.push(track);
  return track;
}

export interface MediaSpec {
  source: string;
  kind: MediaKind;
  tin: number;
  tout: number;
  sIn: number | null;
  sOut: number | null;
  hasAudio: boolean;
  /** false = place the picture only, creating no linked audio clip. Default true. */
  withAudio?: boolean;
  loop?: boolean;
  stretch?: boolean;
  trackId?: string | null;
}

/** What an overwrite cost: the material that was already there and is now gone or shorter.
 *
 *  An overwrite is the one edit that destroys work nobody named. The change delta already carried
 *  `removed_ids`, but as a diff artifact among many — and it cannot express a TRUNCATION at all,
 *  because a clip cut at a boundary comes back as a clip id the caller has never seen. A real
 *  session paid for that gap: a placement at frame 0 ate a graded 96-frame shot and left a 24-frame
 *  stub of the next one, and the agent, unable to account for the stub, told the user "the rest of
 *  the timeline stayed in place". */
export interface OverwriteReport {
  /** Clip ids that no longer exist. A clip cut at a boundary LOSES its id: the surviving piece is
   *  a new clip, listed in `shortened` with `was_clip` naming the one it came from. */
  removed: string[];
  /** Material that survived with fewer frames. */
  shortened: Array<{
    id: string;
    was: [number, number];
    now: [number, number];
    /** Set when this piece was cut out of a clip that had a different id. */
    was_clip?: string;
  }>;
}

export function emptyOverwriteReport(): OverwriteReport {
  return { removed: [], shortened: [] };
}

export function overwroteAnything(r: OverwriteReport): boolean {
  return r.removed.length > 0 || r.shortened.length > 0;
}

/** One line the model cannot read as routine bookkeeping. */
export function describeOverwrite(r: OverwriteReport): string {
  const parts: string[] = [];
  if (r.removed.length) parts.push(`removed ${r.removed.join(", ")}`);
  for (const s of r.shortened) {
    const from = s.was_clip ? `${s.was_clip} -> ${s.id}` : s.id;
    parts.push(`shortened ${from} (${s.was[0]}-${s.was[1]} to ${s.now[0]}-${s.now[1]})`);
  }
  return `this overwrote material that was already on the timeline: ${parts.join("; ")}. Undo restores it.`;
}

/** Build + place one media clip (+ its linked audio for a video with sound).
 *  `overwrite` (add_clips) clears the landing region first so the clip drops
 *  straight in; left false (insert_clips) it assumes the space is already open. */
export function appendMediaClip(
  timeline: Timeline,
  spec: MediaSpec,
  overwrite = false,
): { created: Array<Record<string, unknown>>; overwrote: OverwriteReport } {
  const created: Array<Record<string, unknown>> = [];
  const clip: Clip = {
    id: newId("clip"),
    media_ref: spec.source,
    timeline_in: spec.tin,
    timeline_out: spec.tout,
  };
  // Record the kind on the clip so nothing has to re-derive it from the ref.
  if (spec.kind === "video" || spec.kind === "image" || spec.kind === "audio")
    clip.kind = spec.kind;
  if (spec.kind === "audio") {
    if (spec.loop) clip.loop = true;
    if (spec.stretch) clip.stretch = true;
  }
  if (spec.kind === "video" || spec.kind === "audio") {
    const sIn = spec.sIn ?? 0;
    clip.source_in = sIn;
    clip.source_out = spec.sOut ?? sIn + (spec.tout - spec.tin);
  }
  const track =
    spec.kind === "audio" && !spec.trackId
      ? resolveFreeAudioTrack(timeline, spec.tin, spec.tout)
      : resolveTrack(timeline, spec.trackId, spec.kind, true);
  // Overwrite (add_clips, NLE-style): trim/split/remove whatever already sits
  // in [tin, tout) on this track so the new clip fills it — no overlap, no ripple.
  const overwrote = overwrite
    ? clearRegion(timeline, track, spec.tin, spec.tout)
    : emptyOverwriteReport();
  (track.clips ??= []).push(clip);
  created.push({ clip_id: clip.id, kind: spec.kind, track_id: track.id });
  // Declining the audio is a PLACEMENT decision, so it happens here rather than being undone
  // afterwards. Without it the only way to place a shot silently was to bake a muted copy through
  // ffmpeg — which is what the escape hatch was used for, and it costs the clip its editability,
  // doubles its bytes, and leaves a `*_silent.mp4` in the library with nothing recording where it
  // came from. The alternatives all need the linked clip's id, which only exists AFTER placement.
  if (spec.kind === "video" && spec.hasAudio && spec.withAudio !== false) {
    const lg = newId("lg");
    clip.link_group = lg;
    const audioClip: Clip = {
      id: newId("aud"),
      kind: "audio",
      media_ref: spec.source,
      source_in: clip.source_in,
      source_out: clip.source_out,
      timeline_in: spec.tin,
      timeline_out: spec.tout,
      link_group: lg,
    };
    const atrack = resolveLinkedAudioTrack(timeline, spec.tin, spec.tout);
    (atrack.clips ??= []).push(audioClip);
    created.push({ clip_id: audioClip.id, kind: "audio", track_id: atrack.id, linked_to: clip.id });
  }
  return { created, overwrote };
}

/** Split `clip` at timeline frame `at`; return the right half (a new id).
 *  Caller guarantees timeline_in < at < timeline_out. */
/** Partition one keyframe array at clip-relative frame `splitRel`: the left clip
 *  keeps keys before the cut; the right clip keeps keys at/after it, remapped to
 *  its own origin (t -= splitRel). Preserves every key's TIMELINE position. */
function splitKeyframeArray(
  arr: unknown[],
  splitRel: number,
): { left: unknown[]; right: unknown[] } {
  const left: unknown[] = [];
  const right: unknown[] = [];
  for (const k of arr) {
    const t = Number((k as { t?: unknown }).t);
    if (t < splitRel) left.push(k);
    else right.push({ ...(k as Record<string, unknown>), t: t - splitRel });
  }
  return { left, right };
}

/** Split every animatable keyframe track between the two halves of a split clip
 *  so animation stays put in timeline terms (the right half must not inherit the
 *  original clip's origin). Scalar (non-keyframed) values are already copied to
 *  both by the clone. */
function partitionClipKeyframes(left: Clip, right: Clip, splitRel: number): void {
  const apply = (lo: Record<string, unknown>, ro: Record<string, unknown>, key: string): void => {
    const v = lo[key];
    if (!Array.isArray(v)) return;
    const s = splitKeyframeArray(v, splitRel);
    if (s.left.length) lo[key] = s.left;
    else delete lo[key];
    if (s.right.length) ro[key] = s.right;
    else delete ro[key];
  };
  const lRec = left as unknown as Record<string, unknown>;
  const rRec = right as unknown as Record<string, unknown>;
  for (const key of ["opacity", "rotate", "volume"]) apply(lRec, rRec, key);
  const lt = left.transform as Record<string, unknown> | undefined;
  const rt = right.transform as Record<string, unknown> | undefined;
  if (lt && rt) {
    const lp = lt.position as Record<string, unknown> | undefined;
    const rp = rt.position as Record<string, unknown> | undefined;
    if (lp && rp) {
      apply(lp, rp, "x");
      apply(lp, rp, "y");
    }
    apply(lt, rt, "scale");
    apply(lt, rt, "scale_x");
    apply(lt, rt, "scale_y");
  }
}

export function splitClipAt(track: Track, clip: Clip, at: number, newGroup: string | null): Clip {
  const clips = (track.clips ??= []);
  const tin = clip.timeline_in;
  const right = JSON.parse(JSON.stringify(clip)) as Clip;
  right.id = newId("clip");
  if ("source_in" in clip && "source_out" in clip) {
    const speed = Number(clip.speed ?? 1.0) || 1.0;
    const srcAt = (clip.source_in as number) + Math.round((at - tin) * speed);
    clip.timeline_out = at;
    clip.source_out = srcAt;
    right.timeline_in = at;
    right.source_in = srcAt;
  } else {
    clip.timeline_out = at;
    right.timeline_in = at;
  }
  if (typeof tin === "number") partitionClipKeyframes(clip, right, at - tin);
  if (newGroup !== null && clip.link_group) right.link_group = newGroup;
  const idx = clips.indexOf(clip);
  clips.splice(idx + 1, 0, right);
  return right;
}

/** Open a `span`-frame gap at `at` on `track`: split a straddling clip (+ its
 *  linked partner), then shift clips at/after `at` right (carrying partners). */
export function rippleOpenGap(
  timeline: Timeline,
  track: Track,
  at: number,
  span: number,
  syncTracks: Track[] = [],
): void {
  for (const c of [...(track.clips ?? [])]) {
    const ci = c.timeline_in;
    const co = c.timeline_out;
    if (typeof ci === "number" && typeof co === "number" && ci < at && at < co) {
      const newGroup = c.link_group ? newId("lg") : null;
      const partners = linkPartners(timeline, c);
      splitClipAt(track, c, at, newGroup);
      for (const [pt, pc] of partners) {
        const pci = pc.timeline_in;
        const pco = pc.timeline_out;
        if (typeof pci === "number" && typeof pco === "number" && pci < at && at < pco)
          splitClipAt(pt, pc, at, newGroup);
      }
    }
  }
  // Push clips at/after `at` RIGHT by span on the anchor + every sync-locked track,
  // carrying linked partners (dedup via the Set). Rightward always has room -> no refusal.
  const pushed = new Set<Clip>();
  const push = (c: Clip): void => {
    if (pushed.has(c)) return;
    pushed.add(c);
    c.timeline_in = (Number(c.timeline_in) || 0) + span;
    c.timeline_out = (Number(c.timeline_out) || 0) + span;
  };
  for (const t of [track, ...syncTracks]) {
    for (const c of t.clips ?? []) {
      if ((Number(c.timeline_in) || 0) >= at) {
        push(c);
        for (const [, pc] of linkPartners(timeline, c)) push(pc);
      }
    }
  }
}

/** Delete the frame range [s, e) on `track` and close the gap. Unlike a
 *  whole-clip delete this is PRECISE: clips straddling either boundary are cut
 *  at the boundary (source_in/out mapped through the cut, linked partners cut
 *  too) rather than dropped, so only the material inside [s, e) is removed.
 *  A clip that spans the whole range is split so its head and tail survive.
 *  Clips (and their linked partners) fully inside the range are removed; clips
 *  at/after `e` shift left by the range length, carrying their partners. */
export function rippleDeleteRange(
  timeline: Timeline,
  track: Track,
  s: number,
  e: number,
  syncTracks: Track[] = [],
): void {
  const span = e - s;
  if (span <= 0) return;
  // 1. Cut every clip that straddles a boundary so nothing crosses s or e.
  for (const at of [s, e]) {
    for (const c of [...(track.clips ?? [])]) {
      const ci = c.timeline_in;
      const co = c.timeline_out;
      if (typeof ci === "number" && typeof co === "number" && ci < at && at < co) {
        const newGroup = c.link_group ? newId("lg") : null;
        const partners = linkPartners(timeline, c);
        splitClipAt(track, c, at, newGroup);
        for (const [pt, pc] of partners) {
          const pci = pc.timeline_in;
          const pco = pc.timeline_out;
          if (typeof pci === "number" && typeof pco === "number" && pci < at && at < pco)
            splitClipAt(pt, pc, at, newGroup);
        }
      }
    }
  }
  // 2. Every clip now sits entirely before s, inside [s, e), or at/after e.
  //    Collect the inside-range clips (+ linked groups) for removal.
  const dropIds = new Set<string>();
  const dropGroups = new Set<string>();
  for (const c of track.clips ?? []) {
    const ci = c.timeline_in;
    const co = c.timeline_out;
    if (typeof ci === "number" && typeof co === "number" && ci >= s && co <= e && co > ci) {
      if (c.id) dropIds.add(c.id);
      if (c.link_group) dropGroups.add(c.link_group);
    }
  }
  // 3. Sync-locked tracks shift along to preserve cross-track alignment (Premiere
  //    model). VALIDATE first: if a clip that stays (starts before e, and isn't
  //    being removed) would overlap the leftward-sliding tail, refuse the WHOLE
  //    edit (atomic) and name the track so the caller can exempt it.
  for (const st of syncTracks) {
    let boundary = 0; // furthest end of clips that stay put
    let minStart = Infinity; // earliest start of clips that slide
    for (const c of st.clips ?? []) {
      if ((c.id && dropIds.has(c.id)) || (c.link_group && dropGroups.has(c.link_group))) continue; // being removed
      const ci = Number(c.timeline_in) || 0;
      if (ci >= e) minStart = Math.min(minStart, ci);
      else boundary = Math.max(boundary, Number(c.timeline_out) || 0);
    }
    if (minStart !== Infinity && minStart - span < boundary) {
      throw new OpError(
        `sync-locked track '${st.id}' can't absorb the ${span}-frame ripple (its clips would overlap); ` +
          `pass '${st.id}' in ignore_sync_locked_tracks to leave it in place`,
      );
    }
  }
  // 4. Slide every clip at/after e LEFT by the removed length, on the anchor track
  //    and each sync-locked track, carrying linked partners on any track. The Set
  //    dedupes a clip reached both as a track member and as a partner.
  const shifted = new Set<Clip>();
  const slide = (c: Clip): void => {
    if (shifted.has(c)) return;
    shifted.add(c);
    c.timeline_in = (Number(c.timeline_in) || 0) - span;
    c.timeline_out = (Number(c.timeline_out) || 0) - span;
  };
  for (const t of [track, ...syncTracks]) {
    for (const c of t.clips ?? []) {
      if ((Number(c.timeline_in) || 0) >= e) {
        slide(c);
        for (const [, pc] of linkPartners(timeline, c)) slide(pc);
      }
    }
  }
  // 5. Physically drop the inside-range clips (and their linked partners on any
  //    track) once every surviving clip's coordinates are settled.
  if (dropIds.size || dropGroups.size) {
    for (const t of timeline.tracks ?? []) {
      t.clips = (t.clips ?? []).filter(
        (c) =>
          !(
            c !== null &&
            typeof c === "object" &&
            ((c.id && dropIds.has(c.id)) || (c.link_group && dropGroups.has(c.link_group)))
          ),
      );
    }
  }
}

/** Overwrite-clear the frame range [s, e) on `track`: trim/split/remove any clips
 *  overlapping the range so it's empty, WITHOUT closing the gap — the incoming clip
 *  fills it. An NLE "overwrite" edit (add_clips): the destructive sibling of
 *  rippleDeleteRange (which closes the gap) and rippleOpenGap (which pushes clips aside).
 *
 *  Confined to `track`. It used to cut and DELETE linked partners on every other track,
 *  so dropping a music clip onto A1 over the audio half of an A/V pair deleted the video
 *  on V1 — and overwriting from frame 3 left the video 3 frames long. A partner that the
 *  overwrite desyncs is UNLINKED instead (Premiere: overwriting one half breaks the pair);
 *  leaving it linked would violate the linked-A/V length invariant. Callers that must clear
 *  both halves already call this once per track.
 *
 *  Returns what it cost, because the caller is the only one that can report it. */
export function clearRegion(
  timeline: Timeline,
  track: Track,
  s: number,
  e: number,
): OverwriteReport {
  const report = emptyOverwriteReport();
  if (e <= s) return report;
  const spanOf = (c: Clip): [number, number] => [
    Number(c.timeline_in) || 0,
    Number(c.timeline_out) || 0,
  ];
  // What the CALLER could have known about before this ran: only these ids can be "removed".
  const preExisting = new Map<string, [number, number]>();
  // Original span per id, extended to the pieces a split produces, so a truncation is measured
  // against the clip the caller knew rather than against the intermediate the split left behind.
  const wasSpan = new Map<string, [number, number]>();
  const bornFrom = new Map<string, string>();
  for (const c of track.clips ?? []) {
    if (typeof c.id !== "string") continue;
    preExisting.set(c.id, spanOf(c));
    wasSpan.set(c.id, spanOf(c));
  }
  const broken = new Set<string>(); // groups this overwrite desyncs
  // 1. Cut every clip ON THIS TRACK straddling a boundary so nothing crosses s or e
  //    (source_in/out mapped through the cut). Both halves stay in the original group;
  //    step 3 breaks it.
  for (const at of [s, e]) {
    for (const c of [...(track.clips ?? [])]) {
      const ci = c.timeline_in;
      const co = c.timeline_out;
      if (typeof ci === "number" && typeof co === "number" && ci < at && at < co) {
        if (c.link_group) broken.add(c.link_group);
        const right = splitClipAt(track, c, at, null);
        if (typeof c.id === "string" && typeof right.id === "string") {
          const was = wasSpan.get(c.id);
          if (was) wasSpan.set(right.id, was);
          bornFrom.set(right.id, bornFrom.get(c.id) ?? c.id);
        }
      }
    }
  }
  // 2. Drop every clip ON THIS TRACK now fully inside [s, e).
  const dropIds = new Set<string>();
  for (const c of track.clips ?? []) {
    const ci = c.timeline_in;
    const co = c.timeline_out;
    if (typeof ci === "number" && typeof co === "number" && ci >= s && co <= e && co > ci) {
      if (c.link_group) broken.add(c.link_group);
      if (c.id) dropIds.add(c.id);
    }
  }
  if (dropIds.size)
    track.clips = (track.clips ?? []).filter(
      (c) => !(c !== null && typeof c === "object" && c.id && dropIds.has(c.id)),
    );
  // 3. Break every group the overwrite touched, on every track: a partner still linked to a
  //    clip that just changed length is the t008 desync the invariant battery rejects.
  if (broken.size)
    for (const t of timeline.tracks ?? [])
      for (const c of t.clips ?? [])
        if (c?.link_group && broken.has(c.link_group))
          delete (c as Record<string, unknown>).link_group;
  // 4. Account for it, from the OUTCOME rather than from the steps above: an id the caller knew
  //    that is gone, and every surviving piece that lost frames.
  const survivors = new Map<string, Clip>();
  for (const c of track.clips ?? []) if (typeof c.id === "string") survivors.set(c.id, c);
  for (const id of preExisting.keys()) if (!survivors.has(id)) report.removed.push(id);
  for (const [id, c] of survivors) {
    const was = wasSpan.get(id);
    if (!was) continue; // a clip this overwrite did not touch at all
    const now = spanOf(c);
    if (now[0] === was[0] && now[1] === was[1]) continue;
    const from = bornFrom.get(id);
    report.shortened.push({ id, was, now, ...(from ? { was_clip: from } : {}) });
  }
  return report;
}

/** Deep-clone `clip` (fresh id, standalone — dropped from any link group) and
 *  insert it on `track` at frame `at`, rippling a gap open first so nothing
 *  overlaps. Returns the inserted copy. */
export function insertClipClone(
  timeline: Timeline,
  track: Track,
  clip: Clip,
  at: number,
  syncTracks: Track[] = [],
): Clip {
  const tin = Number(clip.timeline_in) || 0;
  const tout = Number(clip.timeline_out) || 0;
  const len = Math.max(1, tout - tin);
  rippleOpenGap(timeline, track, at, len, syncTracks);
  const copy = JSON.parse(JSON.stringify(clip)) as Clip;
  copy.id = newId("clip");
  copy.timeline_in = at;
  copy.timeline_out = at + len;
  delete (copy as Record<string, unknown>).link_group;
  (track.clips ??= []).push(copy);
  return copy;
}
