// Resolve a clip `source` (library id / filename / alias / project-relative /
// absolute path) to a URL the webview can actually fetch. On desktop this is a
// Tauri asset URL (convertFileSrc); the ref→absolute-path step reuses the same
// ProjectStoreAccess.resolveRef the tools use, so the preview and the render see
// identical files. Results are cached per (projectDir, source). Main-thread only
// (needs the store + Tauri api); the worker receives already-resolved URLs.
import type { ProjectStoreAccess } from "../tools/store";
import { joinPath } from "../tools/store";
import { extAlternation, needsPreviewProxy } from "../media/formats";
import { imageProxyRel, posterRel, proxyRel } from "./proxyPaths";

export type AssetUrlConverter = (absPath: string) => string | Promise<string>;

// Default: Tauri's asset protocol. Dynamically imported so the browser bundle /
// unit tests never load the Tauri api; tests inject a fake via setAssetUrlConverter.
let convertAsset: AssetUrlConverter = async (p) => {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(p);
};

/** DI hook (tests / future web adapter): override how an absolute path becomes a URL. */
export function setAssetUrlConverter(fn: AssetUrlConverter): void {
  convertAsset = fn;
}

const PASSTHROUGH = /^(https?|blob|data|asset|tauri):/i;
const cache = new Map<string, string>();
// Separate from `cache` because it memoises a different question: not "what URL is this ref" but
// "is there a proxy standing in for it". Answering that costs a resolveRef plus an `exists` over
// Tauri IPC, and the preview client re-resolves EVERY source whenever the timeline object changes
// -- which is every edit and every pointermove of a drag. Uncached, dragging one clip on a
// four-source timeline meant tens of filesystem round-trips a second, with the worker unable to
// draw the new timeline until all of them came back.
const previewCache = new Map<string, string | null>();

/** Resolve a clip source to a fetchable URL, or null if nothing resolves. */
export async function resolveSourceUrl(
  store: ProjectStoreAccess,
  source: string,
): Promise<string | null> {
  const s = (source ?? "").trim();
  if (!s) return null;
  if (PASSTHROUGH.test(s)) return s;
  const key = `${store.projectDir}\u0000${s}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const abs = await store.resolveRef(s);
  if (!abs) return null;
  const url = await convertAsset(abs);
  cache.set(key, url);
  return url;
}

/** Drop cached resolutions (e.g. after media is re-imported). */
export function clearSourceUrlCache(): void {
  cache.clear();
  previewCache.clear();
}

const PREVIEW_VID_RE = new RegExp(`\\.(${extAlternation("video")})$`, "i");

/** Like {@link resolveSourceUrl}, but prefers a generated H.264 PREVIEW PROXY
 *  when one exists (for sources the WebCodecs preview can't decode, e.g. HEVC).
 *  The timeline's clip source is unchanged — this only changes what the preview
 *  fetches; the server still renders from the original. */
export async function resolvePreviewUrl(
  store: ProjectStoreAccess,
  source: string,
): Promise<string | null> {
  const s = (source ?? "").trim();
  const key = `${store.projectDir}\u0000${s}`;
  const memo = previewCache.get(key);
  if (memo !== undefined) return memo;
  const url = await resolvePreviewUrlUncached(store, s);
  previewCache.set(key, url);
  return url;
}

async function resolvePreviewUrlUncached(
  store: ProjectStoreAccess,
  s: string,
): Promise<string | null> {
  if (s && !PASSTHROUGH.test(s)) {
    // Key off the RESOLVED path, not the ref: a clip stores a bare library id, which
    // has no extension to test and hashes to a key no generator ever wrote. The
    // generator keys by the catalog path, and canonicalSource() reduces the absolute
    // form to that same `library/<id>.<ext>` — so both sides agree for an id, a
    // project-relative path, or an absolute one.
    const abs = (await store.resolveRef(s)) ?? s;
    if (PREVIEW_VID_RE.test(abs)) {
      const proxyAbs = joinPath(store.projectDir, proxyRel(abs));
      if (await store.exists(proxyAbs)) {
        console.debug(`[resolve] preview via proxy ${proxyAbs}`);
        return resolveSourceUrl(store, proxyAbs);
      }
      console.debug(`[resolve] no proxy (looked ${proxyAbs}); using original ${s}`);
    } else if (needsPreviewProxy(abs)) {
      // A still with no browser decoder (TIFF/HEIC): the original would draw nothing.
      const pngAbs = joinPath(store.projectDir, imageProxyRel(abs));
      if (await store.exists(pngAbs)) return resolveSourceUrl(store, pngAbs);
      console.debug(`[resolve] no image proxy (looked ${pngAbs}); using original ${s}`);
    }
  }
  return resolveSourceUrl(store, s);
}

/** The generated first-frame POSTER for a video source, if one has been made.
 *
 *  Decoding the first real frame is not instant: the index has to be read and the decoder run
 *  from a keyframe. Until then a video layer has no texture and the compositor shows its black
 *  base — so pressing play on a cold timeline moved the playhead over several seconds of black.
 *  The poster already exists on disk for the timeline thumbnail; this lets the preview stand it
 *  in until a real frame arrives. Null when there is none, which keeps it strictly best-effort. */
export async function resolvePosterUrl(
  store: ProjectStoreAccess,
  source: string,
): Promise<string | null> {
  const s = (source ?? "").trim();
  if (!s || PASSTHROUGH.test(s)) return null;
  const key = `${store.projectDir}\u0000poster\u0000${s}`;
  const memo = previewCache.get(key);
  if (memo !== undefined) return memo;
  const abs = (await store.resolveRef(s)) ?? s;
  const posterAbs = joinPath(store.projectDir, posterRel(abs));
  const url = (await store.exists(posterAbs)) ? await resolveSourceUrl(store, posterAbs) : null;
  previewCache.set(key, url);
  return url;
}
