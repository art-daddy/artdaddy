// Load an image URL into an ImageBitmap + its dimensions. The main thread turns every file into a
// URL (preview/resolve.ts, which first opens it to the preview); the worker only ever gets URLs.
// Browser-only (fetch + createImageBitmap); excluded from unit coverage.
import type { AssetDims } from "./scene";

export interface LoadedImage {
  bitmap: ImageBitmap;
  dims: AssetDims;
}

export async function loadImage(url: string): Promise<LoadedImage> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`asset fetch failed (${resp.status}) for ${url}`);
  const bitmap = await createImageBitmap(await resp.blob());
  return { bitmap, dims: { w: bitmap.width, h: bitmap.height } };
}
