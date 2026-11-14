// Fix 1's decision, one zooming clip at a time (Phase 3a): may this clip's cover aperture be the exact mask stream, or does it keep 0.27.0's per-pixel `geq`?
// The builder (render.ts) passes in what it knows and takes back a mask stream or null (= emit today's text). It touches nothing but what it is handed: the export's budget (what the mask
// takes is booked on it) and the builder's tally (the closed word of `LeanKeptReason` for every refusal, so the export's report can say why a clip kept today's recipe). It never throws.
import { apertureRects, maskStream, type MaskStream } from "./leanMasks";
import type { LeanMaskBudget, LeanOptions } from "./leanOptions";
import type { LeanTally } from "./leanRecord";
import { pixFmtHasAlpha } from "./pixelFormats";

/** Added graph text per command the lean masks may use (DESIGN-3a 2.1 item 6; the native staging cap is 32 MiB for the whole job). */
export const LEAN_MAX_MASK_CHARS = 2 * 1024 * 1024;
/** Mask rectangles (`drawbox` filters) per command (revised with the per-clip budget: see leanMasks.ts). */
export const LEAN_MAX_MASK_BOXES = 12000;

/**
 * The filters a zooming clip may carry between its pre-scale and the alpha stage and still take the mask: each one leaves the picture's size, its
 * alpha plane and its pixel format class alone. `alphamerge` REPLACES the alpha plane, so a filter that writes alpha (`chromakey`) or can resize
 * (`custom` is the agent's raw filter text) must keep today's `geq`; an allow-list, because a deny-list misses the next effect.
 */
const PRE_ALPHA_SAFE = new Set([
  "exposure",
  "eq",
  "colortemperature",
  "colorbalance",
  "vibrance",
  "colorlevels",
  "curves",
  "lut3d",
  "gblur",
  "hqdn3d",
  "unsharp",
  "noise",
  "vignette",
  "tmix",
]);

/** True when every filter of the clip's pre-alpha stage is one single named filter on the allow-list (no chain, no label inside the text). */
export function preAlphaIsLeanSafe(filters: readonly string[]): boolean {
  return filters.every((filter) => {
    const text = filter.trim();
    const name = /^([A-Za-z0-9_]+)(?:=|$)/.exec(text)?.[1];
    const unquoted = text.replace(/'[^']*'/g, "");
    return name !== undefined && PRE_ALPHA_SAFE.has(name) && !/[,;[\]]/.test(unquoted);
  });
}

/** What the builder has spent so far in one command. */
export type { LeanMaskBudget };

export interface ZoomMaskRequest {
  lean: LeanOptions;
  tally: LeanTally;
  budget: LeanMaskBudget;
  /** The clip's input file, and the filter text of its pre-scale (what the probe must run to learn the picture's size). */
  path: string;
  preScale: string;
  /** The aperture's width and height in pre-scaled pixels as expressions of T, W and H (the text the `geq` holds). */
  widthExpr: string;
  heightExpr: string;
  fps: number;
  /** The frames the clip is drawn on, within this command's range: [from, to). */
  from: number;
  to: number;
  /** Shapes the proof does not cover (DESIGN-3a 2.1 item 7): rotation, glow, a speed other than 1, a crop or flip, an animated still, a window's frozen frame. */
  unproven: boolean;
}

/** The mask stream for one zooming clip, or null: today's `geq` stays. */
export function leanZoomMask(req: ZoomMaskRequest): MaskStream | null {
  const { lean, tally } = req;
  try {
    if (lean.plain === true) return null;
    if (lean.zoom !== true) {
      tally.kept("flag_off");
      return null;
    }
    if (req.unproven) {
      tally.kept("not_proven");
      return null;
    }
    const key = `${req.path}\n${req.preScale}`;
    const probed = lean.probed?.get(key);
    if (!probed) {
      // Not read yet: ask (the async boundary answers and builds again). If nothing ever answers, the clip keeps `geq`, counted as unknown.
      if (lean.requests && !lean.requests.some((r) => r.key === key))
        lean.requests.push({
          key,
          path: req.path,
          filters: `setsar=1,showinfo,${req.preScale},showinfo`,
        });
      tally.kept("unknown_source");
      return null;
    }
    const alpha = pixFmtHasAlpha(probed.fmt);
    if (alpha !== false) {
      tally.kept(alpha === true ? "see_through" : "unknown_source");
      return null;
    }
    const input = {
      widthExpr: req.widthExpr,
      heightExpr: req.heightExpr,
      width: probed.scaled[0],
      height: probed.scaled[1],
      fps: req.fps,
      from: req.from,
      to: req.to,
    };
    const rects = apertureRects(input);
    if (!rects) {
      tally.kept("error");
      return null;
    }
    const mask = maskStream(input, rects);
    if (
      !mask ||
      req.budget.chars + mask.text.length > LEAN_MAX_MASK_CHARS ||
      req.budget.boxes + mask.boxes > LEAN_MAX_MASK_BOXES
    ) {
      tally.kept("over_budget");
      return null;
    }
    req.budget.chars += mask.text.length;
    req.budget.boxes += mask.boxes;
    tally.ran("zoom");
    return mask;
  } catch {
    tally.kept("error");
    return null;
  }
}
