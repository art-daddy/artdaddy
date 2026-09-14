// Where the preview looks for a clip's generated PROXY / POSTER, keyed by a hash
// of the (project-relative) clip source. Pure so it's shared by the generator
// (mediaProxy), the preview resolver (resolve), and the timeline thumbnail
// (ClipThumbnail) without any of them depending on ffmpeg.
import { shortHash } from "../tools/media";
import { INTERNAL_DIR } from "../tools/store";

/** Canonical form of a clip source for proxy/poster keying, so the SAME library
 *  file referenced as an ABSOLUTE path (…/library/x.mp4, e.g. added by the agent)
 *  or a PROJECT-RELATIVE path (library/x.mp4, e.g. a manual drag) maps to ONE
 *  proxy/poster instead of two — otherwise the preview looks up a proxy under a
 *  hash that no generator ever wrote. */
function canonicalSource(source: string): string {
  const s = (source ?? "").replace(/\\/g, "/").trim();
  const m = /(?:^|\/)(library\/.+)$/i.exec(s);
  return m ? m[1] : s;
}

/** Stable per-source key shared by the proxy + poster paths. */
export function proxyKey(source: string): string {
  return shortHash(canonicalSource(source));
}

// Bump when the proxy transcode RECIPE changes (codec/scale/GOP/…) so existing
// proxies are treated as stale and regenerated instead of being reused as-is.
const PROXY_REV = 3;

// Same idea for the first-frame POSTER extraction recipe.
// r2: pick a representative frame ~10% in instead of frame 0, so a film that opens on black
// stops producing a black tile that reads as a missing thumbnail.
const POSTER_REV = 2;

/** Versioned proxy filename — a recipe change re-generates instead of reusing an
 *  old proxy (e.g. a keyframe-interval change that affects seek/scrub latency). */
export function proxyName(source: string): string {
  return `${proxyKey(source)}.r${PROXY_REV}.mp4`;
}

/** H.264 preview proxy for a source that the WebCodecs pipeline can't decode. */
export function proxyRel(source: string): string {
  return `${INTERNAL_DIR}/cache/proxies/${proxyName(source)}`;
}

// Same idea for the still-image stand-in recipe.
const IMAGE_PROXY_REV = 1;

/** PNG stand-in for an image `createImageBitmap` has no decoder for (TIFF, HEIC). */
export function imageProxyName(source: string): string {
  return `${proxyKey(source)}.r${IMAGE_PROXY_REV}.png`;
}

export function imageProxyRel(source: string): string {
  return `${INTERNAL_DIR}/cache/proxies/${imageProxyName(source)}`;
}

/** Versioned poster filename — shared by the generator (mediaProxy) and the
 *  reader (posterRel) so a recipe bump re-generates instead of both sides
 *  silently disagreeing on the path (generator writes X, reader looks for Y). */
export function posterName(source: string): string {
  return `${proxyKey(source)}.r${POSTER_REV}.jpg`;
}

/** First-frame poster used as the timeline clip thumbnail. */
export function posterRel(source: string): string {
  return `${INTERNAL_DIR}/cache/posters/${posterName(source)}`;
}
