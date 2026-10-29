// How big a clip is when it is uploaded for a video question: see videoEdge.test.ts for the rule and the A/B behind it.
// Kept apart from geminiEncode so the rule can be read, and tested, without ffmpeg.

/** A clip longer than this many seconds is encoded at the smaller size. */
export const LONG_CLIP_SECONDS = 60;
export const LONG_CLIP_EDGE = 480;
export const SHORT_CLIP_EDGE = 720;

/** The picture height a clip of `durationS` seconds is encoded at. A length that is not a usable number keeps the
 *  old, larger size: not knowing how long a clip is is not a reason to make it worse. */
export function videoEdgeFor(durationS: number | null | undefined): number {
  return typeof durationS === "number" && Number.isFinite(durationS) && durationS > LONG_CLIP_SECONDS
    ? LONG_CLIP_EDGE
    : SHORT_CLIP_EDGE;
}
