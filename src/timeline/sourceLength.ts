// How long each clip's SOURCE really is, in project frames — the one fact both trim
// doors need and neither used to have.
//
// `null` means "no limit here": a still or text clip (which other NLEs also treats as
// infinite), or a probe we could not run. Callers must then SKIP the clamp rather than
// block a valid edit — a failed ffprobe is not evidence the media is short.
//
// This lives outside props.ts because `set_clip_properties` (the model's door) and
// `trim_clips` (the editor's drag door) both bound a clip by it. When it lived in
// props.ts only the model's edits were bounded, so a hand-drag could stretch a video
// past its own footage and the export silently ran out of frames.
import { loadTimeline } from "./engine";
import { canvasFps } from "./frames";
import { findClip } from "./helpers";
import type { Timeline } from "./model";
import { sourceDurationSeconds } from "./placement";
import type { ClientToolContext } from "../tools/context";

export async function sourceLengths(
  ctx: ClientToolContext,
  clipIds: readonly unknown[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  let timeline: Timeline;
  try {
    timeline = await loadTimeline(ctx.store);
  } catch {
    return out; // no timeline to read -> applyOp will report the real failure
  }
  const fps = canvasFps(timeline);
  for (const cid of clipIds) {
    const id = String(cid ?? "");
    if (out.has(id)) continue;
    const found = findClip(timeline, id);
    const clip = found?.[1];
    const ref = clip?.media_ref;
    if (!clip || clip.kind === "image" || clip.kind === "text" || typeof ref !== "string") {
      out.set(id, null);
      continue;
    }
    try {
      const abs = (await ctx.store.resolveMediaRef(ref)) ?? ref;
      const secs = await sourceDurationSeconds(ctx.runner, abs);
      out.set(id, secs > 0 ? Math.round(secs * fps) : null);
    } catch {
      out.set(id, null); // unprobeable -> no clamp (chosen over blocking the edit)
    }
  }
  return out;
}

/** Longest timeline span a clip may occupy given where its source window starts.
 *  `null` (unbounded source) stays unbounded. */
export function maxSpanFrames(
  totalFrames: number | null,
  sourceIn: number,
  speed: number,
): number | null {
  if (totalFrames === null || !(totalFrames > 0)) return null;
  const s = speed > 0 ? speed : 1;
  return Math.max(1, Math.floor(Math.max(0, totalFrames - Math.max(0, sourceIn)) / s));
}
