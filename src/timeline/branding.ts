// The branding a DELIVERABLE carries: a corner bug burned over the whole video and the end
// card on its tail.
//
// Applied to exports only. `renderTimelineTool`'s working render and `inspect_timeline`'s
// preview frames go through the same `buildRenderCommand`, and branding those would put the
// bug in front of the model as if the user had put it there — so this is a plan input the
// export door supplies, not a default the builder assumes.
//
// The assets are authored by `scripts/brand-video.mjs` from src/brand.json at three aspect
// ratios and staged into src-tauri/resources/brand. They are FULL-FRAME: the watermark png is
// a transparent frame with the bug already inset for that ratio, so it composites at 0:0 once
// scaled to the output size — no second copy of the inset rule here to drift from the one that
// drew it.

/** The ratios the assets are authored at. */
export type BrandRatio = "16x9" | "1x1" | "9x16";

const RATIO_AR: Record<BrandRatio, number> = {
  "16x9": 16 / 9,
  "1x1": 1,
  "9x16": 9 / 16,
};

/** Which authored ratio a canvas gets. Nearest in log-aspect, so a 1024x1024 and a 1080x1080
 *  canvas both land on 1x1, and anything wider than about 4:3 takes the landscape bug rather
 *  than a square one stretched across it.
 *
 *  4:3 is the exact geometric mean of 1:1 and 16:9, so it is a genuine tie — decided toward the
 *  EARLIER entry rather than by whichever `Math.log` rounded lower, which is what picked the
 *  square bug for a 1024x768 project and would have flipped on another machine. */
export function brandRatio(width: number, height: number): BrandRatio {
  if (!(width > 0) || !(height > 0)) return "16x9";
  const ar = width / height;
  let best: BrandRatio = "16x9";
  let bestGap = Infinity;
  for (const id of Object.keys(RATIO_AR) as BrandRatio[]) {
    const gap = Math.abs(Math.log(ar) - Math.log(RATIO_AR[id]));
    if (gap < bestGap - 1e-9) {
      bestGap = gap;
      best = id;
    }
  }
  return best;
}

export const watermarkFile = (r: BrandRatio): string => `watermark-${r}.png`;
export const endcardFile = (r: BrandRatio): string => `endcard-${r}.mp4`;

/** Absolute paths to the two assets a branded render feeds ffmpeg. */
export interface Branding {
  watermark: string;
  endcard: string;
  /** Probed from the bundled artifact before planning; never a stale authored constant. */
  endcardDuration: number;
}
