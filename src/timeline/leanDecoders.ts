// Fix 5's decision (Phase 3a, DESIGN-3a 2.5): on the one-pass engine, one decoder thread for a still picture that fix 3 reads ONCE. A picture decoded once has no per-frame decode left for threads to speed up, so its
// extra decoder threads (each holding its own frame buffers) are memory with nothing to buy (LAB-W1 8d: the exact-mask reel 6.50 to 5.66 GiB working set with the 14 pictures and 3 sound inputs on one thread each).
// A picture that is read again for every frame keeps ffmpeg's own thread count: capping its decode is where the lab saw 35 percent slower exports. Sound-only inputs are NOT capped (decision 7 in STATUS.md,
// after the independent review of 15 Nov): audio decoders have no thread pool to speak of, so the lab's gain was the pictures', and two more arguments on every such input make the command longer, which can push an
// explicit one-pass export over the length that sends it to the streamed engine. Pure: returns the input options or null (= today's text), counts on the builder's tally, never throws. The streamed engine already
// gives these inputs one thread and is unchanged.
import type { LeanOptions } from "./leanOptions";
import type { LeanTally } from "./leanRecord";

export interface DecoderCapRequest {
  lean: LeanOptions;
  tally: LeanTally;
  /** The engine of the command (`partition-pipes-v1` is the streamed one). */
  engine: string | undefined;
  /** Fix 3 reads this picture once (leanStills.ts), so its decode is one frame's worth. */
  readOnce: boolean;
}

/** The input options that cap this picture's decoder to one thread, or null: today's options stay. */
export function leanDecoderCap(req: DecoderCapRequest): string[] | null {
  const { lean, tally } = req;
  try {
    if (lean.plain === true) return null;
    if (req.engine === "partition-pipes-v1") return null;
    if (!req.readOnce) return null;
    if (lean.decoders !== true) {
      tally.kept("flag_off");
      return null;
    }
    tally.ran("decoders");
    return ["-threads:v", "1"];
  } catch {
    tally.kept("error");
    return null;
  }
}
