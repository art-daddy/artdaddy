// Resolve a clip `source` (library id / filename / alias / project-relative /
// absolute path) to a URL the webview can actually fetch. On desktop this is a
// Tauri asset URL (convertFileSrc); the ref→absolute-path step reuses the same
// ProjectStoreAccess.resolveRef the tools use, so the preview and the render see
// identical files. Results are cached per (projectDir, source). Main-thread only
// (needs the store + Tauri api); the worker receives already-resolved URLs.
import type { ProjectStoreAccess } from "../tools/store";
import { INTERNAL_DIR, joinPath } from "../tools/store";
import { extAlternation, needsPreviewProxy } from "../media/formats";
import { parsePackIndex } from "../media/stillFrames";
import {
  animIndexRel,
  animPackRel,
  imageProxyRel,
  posterRel,
  proxyRel,
  webOkRel,
} from "./proxyPaths";
import { highH264DecodesCorrectly } from "./h264Support";
import { onMediaDerived } from "./mediaDerived";
import type { StillAnimation } from "./protocol";

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

/** Widens the asset protocol's scope to one file, or to a folder and everything in it. */
export type AssetAccessGrant = (path: string, directory: boolean) => Promise<void>;

let grantAccess: AssetAccessGrant = async (path, directory) => {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("allow_preview_path", { path, directory });
};

/** DI hook (tests): override how the preview is given access to a file. */
export function setAssetAccessGrant(fn: AssetAccessGrant): void {
  grantAccess = fn;
}

// What this run has opened. The scope lives in the Rust process, so a cleared URL cache does not
// close anything and nothing here needs asking twice.
const opened = new Set<string>();

/** Test hook. */
export function _resetAssetAccess(): void {
  opened.clear();
}

async function openToPreview(path: string, directory: boolean): Promise<void> {
  const key = `${directory}\u0000${path}`;
  if (opened.has(key)) return;
  try {
    await grantAccess(path, directory);
    opened.add(key);
  } catch (e) {
    // Best-effort: the URL still goes out, and inside the static scope it plays anyway.
    console.warn(`[resolve] could not open ${path} to the preview`, e);
  }
}

/** The library is the gate (UJ-027). The asset protocol serves only the app's data folder and the
 *  home folder by itself, so footage on a second drive or a camera card, or a project kept there,
 *  played black after every restart. What the open project holds is opened before its URL goes
 *  out: its own folder (library copies, the cache, renders) or a file its library links. */
async function openIfHeld(store: ProjectStoreAccess, abs: string): Promise<void> {
  if (store.resolveWritable(abs) !== null) await openToPreview(store.projectDir, true);
  else if (await store.linksFile(abs)) await openToPreview(abs, false);
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
// Same reason: asked for every source on every timeline change. Cleared with the others when a
// stand-in lands, which is when a still's frames appear.
const animCache = new Map<string, StillAnimation | null>();
const sourceUrlListeners = new Set<() => void>();
let resolutionRevision = 0;

export function onSourceUrlsChanged(listener: () => void): () => void {
  sourceUrlListeners.add(listener);
  return () => {
    sourceUrlListeners.delete(listener);
  };
}

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
  const revision = resolutionRevision;
  const abs = await store.resolveRef(s);
  if (revision !== resolutionRevision) return resolveSourceUrl(store, s);
  if (!abs) return null;
  await openIfHeld(store, abs);
  const url = await convertAsset(abs);
  if (revision !== resolutionRevision) return resolveSourceUrl(store, s);
  cache.set(key, url);
  return url;
}

/** The thumbnail the project picker shows for the project at `projectDir`. */
export async function projectThumbnailUrl(projectDir: string): Promise<string> {
  await openToPreview(projectDir, true);
  return convertAsset(joinPath(projectDir, INTERNAL_DIR, "thumbnail.jpg"));
}

/** Drop cached resolutions (e.g. after media is re-imported). */
export function clearSourceUrlCache(): void {
  resolutionRevision++;
  cache.clear();
  previewCache.clear();
  animCache.clear();
  for (const listener of [...sourceUrlListeners]) listener();
}

onMediaDerived(clearSourceUrlCache);

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
  const revision = resolutionRevision;
  const url = await resolvePreviewUrlUncached(store, s);
  if (revision !== resolutionRevision) return resolvePreviewUrl(store, s);
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
      const nativeH264 = await highH264DecodesCorrectly();
      if (
        !nativeH264 &&
        !(await store.exists(joinPath(store.projectDir, webOkRel(abs, nativeH264))))
      ) {
        return null;
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
  const revision = resolutionRevision;
  const abs = (await store.resolveRef(s)) ?? s;
  const posterAbs = joinPath(store.projectDir, posterRel(abs));
  const url = (await store.exists(posterAbs)) ? await resolveSourceUrl(store, posterAbs) : null;
  if (revision !== resolutionRevision) return resolvePosterUrl(store, s);
  previewCache.set(key, url);
  return url;
}

/** The frames an animated still is drawn with, once its pack exists (stillFramePack.ts): where to
 *  fetch them and when each one shows. Null for anything else, and until the pack lands. */
export async function resolveStillAnimation(
  store: ProjectStoreAccess,
  source: string,
): Promise<StillAnimation | null> {
  const s = (source ?? "").trim();
  if (!s || PASSTHROUGH.test(s)) return null;
  const key = `${store.projectDir}\u0000anim\u0000${s}`;
  if (animCache.has(key)) return animCache.get(key)!;
  const revision = resolutionRevision;
  const abs = (await store.resolveRef(s)) ?? s;
  const indexAbs = joinPath(store.projectDir, animIndexRel(abs));
  let found: StillAnimation | null = null;
  if (await store.exists(indexAbs)) {
    const index = parsePackIndex(await store.readText(indexAbs).catch(() => ""));
    const url = index
      ? await resolveSourceUrl(store, joinPath(store.projectDir, animPackRel(abs)))
      : null;
    if (index && url) found = { url, timing: index.timing };
  }
  if (revision !== resolutionRevision) return resolveStillAnimation(store, s);
  animCache.set(key, found);
  return found;
}
