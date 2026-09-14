// How much media the PREVIEW may pull into the webview at once.
//
// A 1.84 GB screen recording crashed the whole app on project open (WER: app.exe, exception
// 0xE0000008 — Chromium's out-of-memory code). Preview loads a source WHOLE: the video path
// fetches the file and mp4box then keeps a copy of every encoded sample, and the audio path
// fetches it and expands it to raw PCM. On desktop the asset fetch is served by the Rust
// process, so an oversized source is not a slow load — it is an allocation failure that takes
// the app down before anything can catch it.
//
// This is deliberately NOT `MAX_HEAP_READ_BYTES` (64 MB): that ceiling guards tool reads, which
// always have an alternative (reference the file by path, stream it with probeMedia). Preview
// has no alternative — it must hold the bytes to decode them — so it gets its own, higher
// ceiling. One constant, one predicate, used by EVERY door that pulls preview media in; the
// last fix here bounded only the audio path and the app kept dying on the video one.
//
// Stopgap, honestly: the real remedy is the preview PROXY the app already knows how to point at
// (resolvePreviewUrl), so large sources are previewed from a small H.264 stand-in instead of
// being refused.
export const MAX_PREVIEW_MEDIA_BYTES = 300 * 1024 * 1024;

/** Unknown size (a platform without stat, a server without content-length) is ALLOWED, not
 *  refused: silencing every preview on a platform that cannot answer is the worse failure. */
export function overPreviewBudget(size: number | null | undefined): boolean {
  return typeof size === "number" && Number.isFinite(size) && size > MAX_PREVIEW_MEDIA_BYTES;
}

/** One wording for every door, so the user gets the same explanation wherever it trips. */
export function tooLargeNotice(name: string, size: number): string {
  const gb = size / 1024 ** 3;
  const shown = gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(size / 1024 ** 2)} MB`;
  return `"${name}" is ${shown} — too large to preview, so it won't play in the editor. It still exports normally.`;
}

/** Basename for the notice: media_refs are opaque ids, so prefer the resolved path's tail. */
export function displayName(absPath: string | null | undefined, fallback: string): string {
  if (!absPath) return fallback;
  const cut = Math.max(absPath.lastIndexOf("/"), absPath.lastIndexOf("\\"));
  return absPath.slice(cut + 1) || fallback;
}
