// Shared "editor context" reference model for the chat — a playhead, a timeline
// range, a timeline clip, or a library media asset — mirroring other NLEs'
// AgentMention / AgentTimelineRangeMention. Integer FRAMES are authoritative;
// timecodes are derived for readability. A range is HALF-OPEN [startFrame,
// endFrame). These builders are pure so they're unit-testable and reused by the
// chat composer, the right-click "Add to chat" menus, and get_timeline.
import type { Clip } from "./model";

export const RANGE_SEMANTICS = "startInclusiveEndExclusive" as const;

/** SMPTE-style non-drop timecode HH:MM:SS:FF at `fps`. */
export function formatTimecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame));
  const r = Math.max(1, Math.round(fps));
  const ff = f % r;
  const totalSec = Math.floor(f / r);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${p2(Math.floor(totalSec / 3600))}:${p2(Math.floor(totalSec / 60) % 60)}:${p2(totalSec % 60)}:${p2(ff)}`;
}

export interface PlayheadMention {
  kind: "playhead";
  frame: number;
  fps: number;
  timecode: string;
}
export interface RangeMention {
  kind: "range";
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  fps: number;
  startTimecode: string;
  endTimecode: string;
  durationTimecode: string;
  semantics: typeof RANGE_SEMANTICS;
}
export interface ClipMention {
  kind: "clip";
  clipId: string;
  trackId?: string;
  startFrame: number;
  endFrame: number;
  source?: string;
  speed?: number;
}
export interface MediaMention {
  kind: "media";
  ref: string;
  name?: string;
  mediaKind?: string;
}
/** Empty space on ONE track. Distinct from a range, which spans the timeline and usually holds
 *  material — a gap is the absence of it, and that is the thing the model has to tell apart. */
export interface GapMention {
  kind: "gap";
  trackId: string;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  fps: number;
  startTimecode: string;
  endTimecode: string;
  semantics: typeof RANGE_SEMANTICS;
}
export type Mention = PlayheadMention | RangeMention | ClipMention | MediaMention | GapMention;

export function buildPlayheadMention(frame: number, fps: number): PlayheadMention {
  const fr = Math.max(0, Math.round(frame));
  return { kind: "playhead", frame: fr, fps, timecode: formatTimecode(fr, fps) };
}

/** Half-open [start, end) range; inputs are normalised (ordered, >= 0). */
export function buildRangeMention(startFrame: number, endFrame: number, fps: number): RangeMention {
  const a = Math.max(0, Math.round(Math.min(startFrame, endFrame)));
  const b = Math.max(a, Math.round(Math.max(startFrame, endFrame)));
  const dur = b - a;
  return {
    kind: "range",
    startFrame: a,
    endFrame: b,
    durationFrames: dur,
    fps,
    startTimecode: formatTimecode(a, fps),
    endTimecode: formatTimecode(b, fps),
    durationTimecode: formatTimecode(dur, fps),
    semantics: RANGE_SEMANTICS,
  };
}

export function buildClipMention(clip: Clip, trackId?: string): ClipMention {
  const m: ClipMention = {
    kind: "clip",
    clipId: String(clip.id ?? ""),
    startFrame: Number(clip.timeline_in) || 0,
    endFrame: Number(clip.timeline_out) || 0,
  };
  if (trackId) m.trackId = trackId;
  if (typeof clip.media_ref === "string" && clip.media_ref) m.source = clip.media_ref;
  if (typeof clip.speed === "number" && clip.speed !== 1) m.speed = clip.speed;
  return m;
}

export function buildMediaMention(ref: string, name?: string, mediaKind?: string): MediaMention {
  const m: MediaMention = { kind: "media", ref };
  if (name) m.name = name;
  if (mediaKind) m.mediaKind = mediaKind;
  return m;
}

/** `gap` comes from `gapsOn` / `gapAt`, which own what counts as a gap — trailing space after
 *  the last clip is not one. */
export function buildGapMention(
  trackId: string,
  gap: { start: number; end: number },
  fps: number,
): GapMention {
  const a = Math.max(0, Math.round(Math.min(gap.start, gap.end)));
  const b = Math.max(a, Math.round(Math.max(gap.start, gap.end)));
  return {
    kind: "gap",
    trackId,
    startFrame: a,
    endFrame: b,
    durationFrames: b - a,
    fps,
    startTimecode: formatTimecode(a, fps),
    endTimecode: formatTimecode(b, fps),
    semantics: RANGE_SEMANTICS,
  };
}

/** Short label for a chip in the composer. */
export function mentionLabel(m: Mention): string {
  switch (m.kind) {
    case "playhead":
      return `playhead ${m.timecode}`;
    case "range":
      return `range ${m.startTimecode}–${m.endTimecode}`;
    case "clip":
      return `clip ${m.clipId}`;
    case "media":
      return m.name || m.ref;
    case "gap":
      return `gap ${m.trackId} ${m.startTimecode}–${m.endTimecode}`;
  }
}

/** Stable identity used to dedupe mentions (adding the same clip twice is a no-op). */
export function mentionKey(m: Mention): string {
  switch (m.kind) {
    case "playhead":
      return `playhead:${m.frame}`;
    case "range":
      return `range:${m.startFrame}-${m.endFrame}`;
    case "clip":
      return `clip:${m.clipId}`;
    case "media":
      return `media:${m.ref}`;
    case "gap":
      // Keyed by WHERE it is, not by which track row it was clicked on alone: two gaps on the
      // same track are different subjects.
      return `gap:${m.trackId}:${m.startFrame}-${m.endFrame}`;
  }
}
