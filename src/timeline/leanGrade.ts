// Fix 4b's decision (Phase 3a, DESIGN-3a 2.4): a still picture's colour grade and spatial effects computed ONCE, on the single decoded frame, instead of on every repeat of it. Fix 3 holds the fitted picture and repeats it
// in the graph; where the filters between the fit and the encoder are the same function of the frame whenever they run, running them before the repeat gives the same frames at a fraction of the work (0.15 CPU-s and 35 ms
// a frame per graded picture in the lab). A filter with memory between frames (`hqdn3d`, `tmix`), a frame count or a clock, or random numbers (`noise`, and `vignette`, which dithers: FILTER-MAP 8.7) stays per frame, and
// one such filter keeps the whole stack where it is. Pure: the builder (render.ts) passes in the clip's pre-alpha filters and takes back whether to emit them before the repeat; every refusal is a closed word on the tally.
import type { LeanOptions } from "./leanOptions";
import type { LeanTally } from "./leanRecord";

/** The ffmpeg filters that return the same output frame for the same input frame, however often and whenever they run: the grade's own filters (`colorFilters`, render.ts) and the two spatial effects with
 *  fixed parameters. An allow-list, because a deny-list misses the next filter. */
const FRAME_INDEPENDENT = new Set([
  "exposure",
  "eq",
  "colortemperature",
  "colorbalance",
  "vibrance",
  "colorlevels",
  "curves",
  "lut3d",
  "gblur",
  "unsharp",
]);

/** True when every filter of the stack is one single named filter on the allow-list (no chain, no label inside the text) whose parameters are CONSTANTS: numbers, a quoted list of curve points, or a LUT's file. A parameter that is
 *  an expression (`eq=brightness=sin(t)`, a `custom` effect's raw text) can depend on the frame or the clock, so the name alone is not enough. */
export function gradeStackIsFrameIndependent(filters: readonly string[]): boolean {
  return filters.every((filter) => {
    const text = filter.trim();
    const name = /^([A-Za-z0-9_]+)(?:=|$)/.exec(text)?.[1];
    const unquoted = text.replace(/'[^']*'/g, "");
    return (
      name !== undefined &&
      FRAME_INDEPENDENT.has(name) &&
      !/[,;[\]]/.test(unquoted) &&
      parametersAreConstants(name, text.slice(name.length + 1))
    );
  });
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const CURVE_POINTS = /^'[0-9 ./-]*'$/;
function parametersAreConstants(name: string, body: string): boolean {
  if (name === "lut3d") return /^file=(?:[A-Za-z0-9_./-]+|'[^']*')$/.test(body);
  return body.split(":").every((pair) => {
    const at = pair.indexOf("=");
    if (at <= 0) return false;
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    return /^[A-Za-z0-9_]+$/.test(key) && (NUMBER.test(value) || CURVE_POINTS.test(value));
  });
}

export interface GradeOnceRequest {
  lean: LeanOptions;
  tally: LeanTally;
  /** The clip's pre-alpha filters in the order it runs them today (grade, then effects). */
  preAlpha: readonly string[];
  /** Fix 3 repeats this picture's one decoded frame in the graph (leanStills.ts): without that there is no repeat to move the stack in front of. */
  heldOnce: boolean;
}

/** True when the clip's pre-alpha stack is emitted before the repeat; false: today's place (after the repeat, the frame-rate step and the retiming stamps). */
export function leanGradeOnce(req: GradeOnceRequest): boolean {
  const { lean, tally } = req;
  try {
    if (lean.plain === true) return false;
    if (!req.heldOnce || req.preAlpha.length === 0) return false;
    if (lean.grade !== true) {
      tally.kept("flag_off");
      return false;
    }
    if (!gradeStackIsFrameIndependent(req.preAlpha)) {
      tally.kept("not_proven");
      return false;
    }
    tally.ran("grade");
    return true;
  } catch {
    tally.kept("error");
    return false;
  }
}
