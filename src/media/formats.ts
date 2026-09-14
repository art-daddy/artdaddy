// What media this app accepts, and what the PREVIEW can decode without help.
//
// This is the ONE list. There were nine, and they disagreed: `avi` was a video to the chat
// composer but unimportable; `tiff` was inspectable but not importable; `opus` was known to
// exactly one module; and the proxy/transcript passes matched only paths containing
// `library/`, so media imported BY REFERENCE got neither. Every one of those is invisible in
// use — the file just quietly does nothing — which is why they are enumerated here instead of
// in each consumer.
//
// Coverage is a superset of other NLEs' ClipType(fileExtension:) — mov/mp4/m4v,
// mp3/wav/aac/m4a/aiff/aif/aifc/caf/flac, png/jpg/jpeg/tiff/heic/webp — plus the containers
// ffmpeg gives us for free (webm, mkv, avi, ogg/opus, gif/bmp/avif). Lottie (.json/.lottie) is
// a other NLEs FEATURE, not merely a format, and is deliberately absent rather than half-accepted.
//
// Subtitles (.srt/.vtt) ARE accepted, but they are not PLAYABLE: a subtitle asset can never
// become a timeline clip. `isPlaceable` is the rule, and it is enforced where clips are made
// (placement) and where they are dropped — not left to each consumer to remember.

export type MediaKind = "video" | "image" | "audio" | "subtitle";

/** Kinds that can be placed on the timeline as a clip. A subtitle is read into CAPTIONS by
 *  add_captions; it has no picture and no sound, so anything that probes, draws or renders a
 *  clip would fail on one. */
export function isPlaceable(kind: MediaKind | null | undefined): boolean {
  return kind === "video" || kind === "image" || kind === "audio";
}

/** Containers ffmpeg can read for us; export and inspection handle all of them. */
export const VIDEO_EXTS = ["mp4", "m4v", "mov", "webm", "mkv", "avi"] as const;
export const IMAGE_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "tif",
  "tiff",
  "heic",
  "heif",
] as const;
export const AUDIO_EXTS = [
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "oga",
  "opus",
  "aiff",
  "aif",
  "aifc",
  "caf",
] as const;
/** Subtitle sidecars. Accepted into the library, never placed as clips. */
export const SUBTITLE_EXTS = ["srt", "vtt"] as const;

/** Video the preview can demux itself: mp4box reads ISOBMFF only. Anything else needs the
 *  H.264 proxy — which is also why proxying must not be limited to media inside the project. */
const PREVIEW_NATIVE_VIDEO = new Set(["mp4", "m4v", "mov"]);
/** Images `createImageBitmap` decodes. TIFF/HEIC are importable but need a poster to show. */
const PREVIEW_NATIVE_IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);

const KIND_BY_EXT = new Map<string, MediaKind>([
  ...VIDEO_EXTS.map((e) => [e, "video"] as const),
  ...IMAGE_EXTS.map((e) => [e, "image"] as const),
  ...AUDIO_EXTS.map((e) => [e, "audio"] as const),
  ...SUBTITLE_EXTS.map((e) => [e, "subtitle"] as const),
]);

/** Lower-case extension without the dot, or "" when there is none. */
export function extOf(nameOrPath: string): string {
  const tail = String(nameOrPath).split(/[\\/]/).pop() ?? "";
  const dot = tail.lastIndexOf(".");
  return dot > 0 ? tail.slice(dot + 1).toLowerCase() : "";
}

/** The kind of media this FILENAME or PATH holds, or null when it is not media we accept.
 *  Never pass a clip's `media_ref` — that is a bare library id with no extension. */
export function kindOf(nameOrPath: string): MediaKind | null {
  return KIND_BY_EXT.get(extOf(nameOrPath)) ?? null;
}

export function isMediaFile(nameOrPath: string): boolean {
  return kindOf(nameOrPath) !== null;
}

/** True when the preview must be given a generated stand-in instead of the original. */
export function needsPreviewProxy(nameOrPath: string): boolean {
  const ext = extOf(nameOrPath);
  const kind = KIND_BY_EXT.get(ext);
  if (kind === "video") return !PREVIEW_NATIVE_VIDEO.has(ext);
  if (kind === "image") return !PREVIEW_NATIVE_IMAGE.has(ext);
  return false; // audio is conformed per clip window, so any container plays
}

/** `(mp4|mov|...)` for the rare consumer that genuinely needs a regex (never for classifying
 *  a clip ref — see mediaKind.guard.test.ts). */
export function extAlternation(kind: MediaKind): string {
  const exts = kind === "video" ? VIDEO_EXTS : kind === "image" ? IMAGE_EXTS : AUDIO_EXTS;
  return exts.join("|");
}
