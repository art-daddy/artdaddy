// The pixel size of each clip's SOURCE — the fact a scale edit needs and never had.
//
// Without it "scale: 3.45" is just a number: the app cannot tell a gentle push-in on 4K footage
// from a 14x blow-up of a 480p podcast, and it happily rendered the second one as a featureless
// smear. Mirrors sourceLength.ts (probe outside the project lock, hand the facts to the pure op).
//
// `null` means "no bound here" — a text clip (whose `scale` sets type size, not a pixel box), an
// unprobeable file, or a probe that answered with nonsense. Callers must then SKIP the clamp: a
// failed ffprobe is not evidence that the media is small.
import type { ClientToolContext } from "../tools/context";
import { probePath } from "../tools/media";
import { stillPicture } from "../media/stillPicture";
import { loadTimeline } from "./engine";
import { findClip } from "./helpers";
import type { Dims } from "./magnification";
import type { Timeline } from "./model";

const cache = new Map<string, Dims | null>();

/** Test hook: reset the source-dimension probe cache. */
export function clearSourceDimsCache(): void {
  cache.clear();
}

async function probe(ctx: ClientToolContext, source: string): Promise<Dims | null> {
  const hit = cache.get(source);
  if (hit !== undefined) return hit;
  let dims: Dims | null = null;
  try {
    // The size every decoder SHOWS, from the one owner. A private stream probe here reported the
    // STORED size: a portrait phone video (a landscape frame plus a display matrix) and a portrait
    // phone JPEG (EXIF orientation) were measured on their sides, so the ceiling on zooming into
    // them was computed for a picture of the wrong shape.
    const r = await probePath(ctx.runner, source);
    const v = (r.ok ? r.video : null) as { width?: unknown; height?: unknown } | null;
    // ffprobe EXITS 0 on an undecodable file and prints width=0 height=0, so judge the reported
    // numbers rather than the exit code.
    const [w, h] = [Number(v?.width), Number(v?.height)];
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) dims = { w, h };
  } catch {
    dims = null; // ffprobe unavailable -> no clamp (chosen over blocking the edit)
  }
  cache.set(source, dims);
  return dims;
}

/** Source pixel size per clip id. Absent/unknown entries are `null`. */
export async function sourceDims(
  ctx: ClientToolContext,
  clipIds: readonly unknown[],
): Promise<Map<string, Dims | null>> {
  const out = new Map<string, Dims | null>();
  let timeline: Timeline;
  try {
    timeline = await loadTimeline(ctx.store);
  } catch {
    return out; // no timeline to read -> applyOp will report the real failure
  }
  for (const cid of clipIds) {
    const id = String(cid ?? "");
    if (out.has(id)) continue;
    const clip = findClip(timeline, id)?.[1];
    const ref = clip?.media_ref;
    // Text has no picture; audio has none either. `scale` on a text clip is TYPE SIZE.
    if (!clip || clip.kind === "text" || clip.kind === "audio" || typeof ref !== "string") {
      out.set(id, null);
      continue;
    }
    try {
      const abs = (await ctx.store.resolveMediaRef(ref)) ?? ref;
      // A HEIF-family still is measured as its decoded picture: probed directly, a tiled iPhone
      // photo reports the size of one 512px tile, and the clamp would refuse a gentle zoom on it.
      const picture = await stillPicture(ctx.store, ctx.runner, abs, ctx.signal);
      out.set(id, "path" in picture ? await probe(ctx, picture.path) : null);
    } catch {
      out.set(id, null);
    }
  }
  return out;
}
