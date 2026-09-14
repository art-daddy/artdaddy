// Pure media-kind helpers for the chat panel (attachment + @-mention pickers).
import { kindOf, type MediaKind } from "../media/formats";

export function attachmentKind(mime: string): "video" | "audio" | "image" {
  if (mime.startsWith("video")) return "video";
  if (mime.startsWith("audio")) return "audio";
  return "image";
}

/** What the library says this file is — used to LABEL a mention. */
export function mediaKindFromName(name: string): MediaKind {
  return kindOf(name) ?? "image";
}

/** The kind to send as a chat ATTACHMENT, or null when the file cannot be one. A subtitle is a
 *  real library asset but has nothing for a model to look at or listen to; it reaches the model
 *  as a media_ref for add_captions instead. */
export function attachmentKindFromName(name: string): "video" | "audio" | "image" | null {
  const kind = mediaKindFromName(name);
  return kind === "subtitle" ? null : kind;
}
