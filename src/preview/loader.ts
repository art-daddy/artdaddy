// Load a clip source into an ImageBitmap + its dimensions. A source is fetched
// as a URL; on Tauri desktop a local filesystem path is first converted to an
// asset URL the webview can fetch. Video-frame decode is a later slice.
// Browser-only (fetch + createImageBitmap); excluded from unit coverage.
import type { AssetDims } from "./scene";

export interface LoadedImage {
  bitmap: ImageBitmap;
  dims: AssetDims;
}

/** Resolve a clip source to a URL the webview can fetch. */
export async function sourceToUrl(source: string): Promise<string> {
  if (/^(https?|blob|data|asset|tauri):/i.test(source)) return source;
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    return convertFileSrc(source);
  } catch {
    return source; // web without a server asset route -> best-effort
  }
}

export async function loadImage(source: string): Promise<LoadedImage> {
  const url = await sourceToUrl(source);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`asset fetch failed (${resp.status}) for ${source}`);
  const bitmap = await createImageBitmap(await resp.blob());
  return { bitmap, dims: { w: bitmap.width, h: bitmap.height } };
}
