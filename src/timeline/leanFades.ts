// Fix 2's decisions (Phase 3a): which per-pixel alpha filters of a clip get an `enable` window, and whether the dip's colour layer can be short. Pure: the builder (render.ts) passes in
// what it knows and takes back TEXT to append (`:enable='...'`, or "" = today's filter, byte for byte) or a frame span. The windows themselves are leanWindows.ts (a superset of the
// frames whose factor is not exactly 1, proven against the builder's own expression text); this module only decides WHEN to ask, and counts the answer on the builder's tally so the
// report can say why a clip kept 0.27.0's recipe. It never throws: any doubt is today's text.
import type { LeanOptions } from "./leanOptions";
import type { LeanTally } from "./leanRecord";
import { dipLayerFrames, fadeWindow, opacityWindow, transitionWindow } from "./leanWindows";
import type { TransitionKind } from "./transition";

const option = (window: string | null): string => (window === null ? "" : `:enable='${window}'`);

/** One window: null when the switch is off or a plain retry (nothing counted for a plain build), when the clip's shape is not proven, when the window functions have nothing to give or throw. */
function decide(
  lean: LeanOptions,
  tally: LeanTally,
  fix: "fades" | "dip",
  provable: boolean,
  build: () => string | null,
): string | null {
  try {
    if (lean.plain === true) return null;
    if (lean[fix] !== true) {
      tally.kept("flag_off");
      return null;
    }
    if (!provable) {
      tally.kept("not_proven");
      return null;
    }
    const window = build();
    if (window === null) {
      tally.kept("not_proven");
      return null;
    }
    tally.ran(fix);
    return window;
  } catch {
    tally.kept("error");
    return null;
  }
}

/** The ` :enable='...'` text for the animated-opacity `geq` (`curve` is compileAnim's text; `first..end` the clip's drawn frames), or "". */
export function opacityEnable(
  lean: LeanOptions,
  tally: LeanTally,
  curve: string,
  first: number,
  end: number,
  fps: number,
): string {
  return option(decide(lean, tally, "fades", true, () => opacityWindow(curve, first, end, fps)));
}

/** The text for a transition's `geq`. `startSec` and `durSec` are the numbers the builder prints (tin - leadIn, the duration); a wipe-right that is not a shape of the proof matrix
 *  (static placement, no rotation, no blend, ...) is `eligible: false` and keeps today's thin line, counted as not_proven. */
export function transitionEnable(
  lean: LeanOptions,
  tally: LeanTally,
  kind: TransitionKind,
  startSec: number,
  durSec: number,
  fps: number,
  eligible: boolean,
): string {
  return option(
    decide(lean, tally, "fades", eligible, () => transitionWindow(kind, startSec, durSec, fps)),
  );
}

/** The text for a clip's fade `geq` (the four numbers `fadeAlphaExpr` receives). */
export function fadeEnable(
  lean: LeanOptions,
  tally: LeanTally,
  tin: number,
  tout: number,
  fadeIn: number,
  fadeOut: number,
  fps: number,
): string {
  return option(
    decide(lean, tally, "fades", true, () => fadeWindow(tin, tout, fadeIn, fadeOut, fps)),
  );
}

/** What to do with a dip's full-canvas colour layer: keep today's whole-timeline layer, skip the layer and its overlay (the overlay's gate opens on no frame of this command), or
 *  make the layer only the frames the gate needs plus one on each side. */
export type DipLayerPlan =
  { kind: "keep" } | { kind: "skip" } | { kind: "layer"; from: number; to: number };

export function dipLayerPlan(
  lean: LeanOptions,
  tally: LeanTally,
  gateFirst: number,
  gateEnd: number,
  range: { from: number; to: number } | null,
  baseFrames: number,
): DipLayerPlan {
  try {
    if (lean.plain === true) return { kind: "keep" };
    if (lean.dip !== true) {
      tally.kept("flag_off");
      return { kind: "keep" };
    }
    if (!Number.isSafeInteger(baseFrames) || baseFrames <= 0) {
      tally.kept("not_proven");
      return { kind: "keep" };
    }
    const layer = dipLayerFrames(gateFirst, gateEnd, range, baseFrames);
    tally.ran("dip");
    return layer === null ? { kind: "skip" } : { kind: "layer", from: layer.from, to: layer.to };
  } catch {
    tally.kept("error");
    return { kind: "keep" };
  }
}
