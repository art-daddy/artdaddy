// Which preview copy the person is waiting for (UJ-091): the clip under the playhead, else the first clip on the timeline. Pure.
import { canvasFps } from "../timeline/frames";
import type { Timeline } from "../timeline/model";

/** The library ref of the clip whose copy should be built first, or null when the timeline has no picture-bearing clip. A clip that is only sound or only text has
 *  no copy to wait for. Half-open spans, as every span check here: a clip ending at F does not cover F. */
export function focusRef(timeline: Timeline | null | undefined, frame: number): string | null {
  let first: { ref: string; at: number } | null = null;
  for (const track of timeline?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (clip.kind === "audio" || clip.kind === "text") continue;
      const ref = typeof clip.media_ref === "string" ? clip.media_ref : "";
      if (!ref) continue;
      if (frame >= clip.timeline_in && frame < clip.timeline_out) return ref;
      if (first === null || clip.timeline_in < first.at) first = { ref, at: clip.timeline_in };
    }
  }
  return first?.ref ?? null;
}

/** The playhead (seconds) as the frame the timeline's own clock counts. */
export const frameAt = (timeline: Timeline | null | undefined, seconds: number): number =>
  Math.floor(Math.max(0, seconds) * (timeline ? canvasFps(timeline) : 30));
