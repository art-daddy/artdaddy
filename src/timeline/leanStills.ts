// Fix 3's decision, one still picture at a time (Phase 3a): may this picture be decoded ONCE and its fitted frame repeated in the graph, or does it keep 0.27.0's
// `-loop 1 -framerate` input (the file read and decoded again for every frame: 12 MP JPEG +43 ms a frame, DESIGN-3a 2.3)? Pure: the builder (render.ts) passes in what
// it knows and takes back the loop or null (= emit today's text). It never throws; every refusal is one of the closed words of `LeanKeptReason`, counted on the
// builder's tally so the export's record can say why a picture kept today's recipe.
import type { StillLoop, StillReader } from "../media/stillReader";
import type { LeanOptions } from "./leanOptions";
import type { LeanTally } from "./leanRecord";

/** Bytes one held pixel can take: 8 for a picture as decoded (16-bit RGBA at most), 16 once a float colour grade has run on it (fix 4b may move the grade in front of the repeat, and a
 *  float filter's output is four planes of 4 bytes). Conservative on purpose: the estimate decides whether a picture is held at all. */
export const LEAN_STILL_BYTES_PER_PIXEL = 8;
export const LEAN_STILL_BYTES_PER_PIXEL_GRADED = 16;
/** The most one held frame may take by that estimate (256 MiB), and the most all the held frames of one command may take together (1.5 GiB). A picture over either keeps today's read for every frame
 *  (DESIGN-3a 2.3: the loop point is a memory decision; the reviewer's note of 15 Nov: a bound in pixels alone hides a 16-byte pixel). */
export const LEAN_STILL_MAX_HELD_BYTES = 256 * 2 ** 20;
export const LEAN_STILLS_MAX_TOTAL_BYTES = 1536 * 2 ** 20;

/** What the held frames of one command have taken so far (estimated bytes); the builder makes one per command, a streamed export's parts each have their own. */
export interface LeanStillBudget {
  bytes: number;
}

export interface PictureLoopRequest {
  lean: LeanOptions;
  tally: LeanTally;
  /** How ffmpeg opens the file (stillReader.ts): only "picture" (JPEG, PNG, WebP, BMP, TIFF) is in scope; the animated readers keep their own loops. */
  reader: StillReader;
  fps: number;
  path: string;
  /** An upper bound of the held frame in pixels when the builder knows one: a fixed box is fitted to exactly its size, and a zoom that contains or stretches its picture
   *  is scaled to its largest box at most. Null when it does not. */
  heldPixels: number | null;
  /** When it does not (a cover zoom: the picture is scaled to COVER its largest box, which it can overflow on one side), the text of that pre-scale: ffmpeg is asked
   *  what size it gives (leanProbe.ts, the same question and key as the zoom mask's, so one probe serves both). */
  preScale: string | null;
  /** The clip carries a colour grade or effects, so a float stack may have run on the held frame. */
  graded: boolean;
  /** The picture is cropped before its fit: the probe's question does not include the crop, so its answer is not the size that is held. */
  cropped: boolean;
  budget: LeanStillBudget;
}

/** The picture's loop in the graph, or null: today's `-loop 1 -framerate` input stays. */
export function leanPictureLoop(req: PictureLoopRequest): StillLoop | null {
  const { lean, tally } = req;
  try {
    if (lean.plain === true) return null;
    if (req.reader !== "picture") return null;
    if (lean.stills !== true) {
      tally.kept("flag_off");
      return null;
    }
    if (!Number.isFinite(req.fps) || req.fps <= 0) {
      tally.kept("error");
      return null;
    }
    let held = req.heldPixels;
    if (held === null) {
      if (req.preScale === null) {
        tally.kept("unknown_source");
        return null;
      }
      if (req.cropped) {
        tally.kept("not_proven");
        return null;
      }
      const key = `${req.path}\n${req.preScale}`;
      const probed = lean.probed?.get(key);
      if (!probed) {
        // Not read yet: ask (the async boundary answers and builds again). If nothing ever answers, the picture keeps today's read, counted as unknown.
        if (lean.requests && !lean.requests.some((r) => r.key === key))
          lean.requests.push({
            key,
            path: req.path,
            filters: `setsar=1,showinfo,${req.preScale},showinfo`,
          });
        tally.kept("unknown_source");
        return null;
      }
      held = probed.scaled[0] * probed.scaled[1];
    }
    if (!Number.isFinite(held) || held <= 0) {
      tally.kept("unknown_source");
      return null;
    }
    const bytes =
      held * (req.graded ? LEAN_STILL_BYTES_PER_PIXEL_GRADED : LEAN_STILL_BYTES_PER_PIXEL);
    if (
      bytes > LEAN_STILL_MAX_HELD_BYTES ||
      req.budget.bytes + bytes > LEAN_STILLS_MAX_TOTAL_BYTES
    ) {
      tally.kept("over_budget");
      return null;
    }
    req.budget.bytes += bytes;
    tally.ran("stills");
    // The same tail the export already uses for one decoded frame (an animated still's frame in a look, render.ts): repeat it, restamp it on the project's clock.
    return {
      input: [],
      graph: `loop=loop=-1:size=1:start=0,settb=1/${req.fps},setpts=N`,
      graphAfterFit: true,
      passes: Infinity,
      hold: false,
    };
  } catch {
    tally.kept("error");
    return null;
  }
}
