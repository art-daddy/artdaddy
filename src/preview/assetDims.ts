// Real pixel size of each media source, as learned by the COMPOSITOR (the preview
// worker's image/video decoders) and published back to the main thread.
//
// The stage overlay needs it because a clip's transform box is NOT where its picture
// lands: `fit` (contain by default) letterboxes the picture inside that box, so a
// 726x612 photo in a 1080x1920 frame is drawn 490px short of the box top and bottom.
// Drawing handles from the box put them a quarter of the canvas away from the clip.
//
// Deliberately sourced from the worker rather than probed again here: a second decode
// would be a second answer, and disagreeing answers are the whole bug class this fixes.
import type { AssetDims } from "./scene";

const dims = new Map<string, AssetDims>();
const listeners = new Set<() => void>();
let version = 0;

export function setAssetDims(source: string, d: AssetDims): void {
  const cur = dims.get(source);
  if (cur && cur.w === d.w && cur.h === d.h) return;
  if (!(d.w > 0) || !(d.h > 0)) return;
  dims.set(source, d);
  version += 1;
  for (const fn of listeners) fn();
}

/** null until the compositor has decoded the source; callers must degrade, not guess. */
export function assetDims(source: string | undefined): AssetDims | null {
  return (source && dims.get(source)) || null;
}

/** Monotonic counter for useSyncExternalStore — a new value means some size landed. */
export function assetDimsVersion(): number {
  return version;
}

export function subscribeAssetDims(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test hook. */
export function _resetAssetDims(): void {
  dims.clear();
  version = 0;
  listeners.clear();
}
