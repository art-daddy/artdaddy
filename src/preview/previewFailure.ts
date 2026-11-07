// Why the preview could not show a video, as one word of the fixed list in api/editorEvents.ts (PREVIEW_FAILURES).
//
// A video the preview cannot decode used to be a `console.warn` in a webview nobody reads: "video preview stuck on one
// frame sometimes" had no record anywhere. The reason is taken from WHAT failed (a typed error at the place that knows),
// never from a message, which can carry a path.
import type { PreviewFailure } from "../api/editorEvents";

export class PreviewFailureError extends Error {
  readonly reason: PreviewFailure;
  constructor(reason: PreviewFailure, message: string) {
    super(message);
    this.name = "PreviewFailureError";
    this.reason = reason;
  }
}

/** The word for a failure: the typed error's own, `unsupported` for the decoder's own "not supported" answer, else `other`. */
export function previewFailureOf(error: unknown): PreviewFailure {
  if (error instanceof PreviewFailureError) return error.reason;
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name === "NotSupportedError" ? "unsupported" : "other";
}

/** The family of a WebCodecs codec string (`avc1.64001f` -> `avc1`, `hev1.1.6.L93.B0` -> `hev1`): the part that says which
 *  codec, not the profile and level. Empty when it is not a short name of that alphabet. */
export function codecFamily(codec: unknown): string {
  const family = typeof codec === "string" ? codec.split(".")[0].toLowerCase() : "";
  return /^[a-z0-9]{1,12}$/.test(family) ? family : "";
}
