// Attachment-transport (client side). A client media tool can't reach the
// server's AttachmentQueue directly, so it writes extracted media into the
// project store and declares the requests in `result._attachments`. The server
// gateway drains + enqueues them: when a read_media client is connected it
// fetches the bytes FROM the client into a server temp (remote-safe); otherwise
// it reads the co-located file directly. See gateway.py::_drain_attachments.

export type AttachmentKind = "image" | "video" | "audio";

export interface Attachment {
  /** Absolute path inside the project store (server reads it via the shared FS). */
  path: string;
  kind: AttachmentKind;
  caption?: string;
  /** Video only: Gemini inline-video sampling rate (frames/sec). */
  fps?: number;
}

export function imageAttachment(path: string, caption = ""): Attachment {
  return { path, kind: "image", caption };
}

export function videoAttachment(path: string, caption = "", fps?: number): Attachment {
  return fps === undefined
    ? { path, kind: "video", caption }
    : { path, kind: "video", caption, fps };
}

export function audioAttachment(path: string, caption = ""): Attachment {
  return { path, kind: "audio", caption };
}
