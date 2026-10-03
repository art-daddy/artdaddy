// Client-owned history (Phase 1, option A, docs/USER_JOURNEY_ANALYSIS.md): the app's transcript
// is the model's whole history, rebuilt by the server every round. The frames an earlier round
// showed must therefore be re-sent each round while they stay in the conversation. This module
// decides WHICH (a pure rule over the transcript) and reads their bytes.
//
// The rule keeps the newest frames and drops the oldest in BATCHES: Azure caches the request
// prefix, and dropping one frame per round would change the prefix every round. With a batch of
// 16 the kept set changes once per 16 new frames, so the cache misses once per batch. The server
// enforces Azure's own limit (50 images per request) again where it assembles the input.
import type { Turn } from "../store/chatTranscript";
import { readImageSize } from "../tools/imageDims";
import type { ProjectStoreAccess } from "../tools/store";
import type { InferenceAttachment } from "./types";

/** At most this many frames are re-sent; above it the oldest go, a batch at a time. */
export const HISTORY_FRAMES_MAX = 40;
/** How many frames leave at once when the history grows past {@link HISTORY_FRAMES_MAX}. */
export const HISTORY_FRAMES_BATCH = 16;
/** A frame larger than this is not re-sent (the server says so to the model). Frames the
 *  inspect tools write are JPEG well under it; this stops a full-size still or a page capture
 *  from riding every round. */
export const HISTORY_FRAME_MAX_BYTES = 2 * 1024 * 1024;

export interface FrameRef {
  call_id: string;
  index: number;
  path: string;
  caption?: string;
}

/** Every frame the applied (not undone) history showed the model, oldest first. */
export function historyFrameRefs(turns: Turn[]): FrameRef[] {
  const out: FrameRef[] = [];
  for (const t of turns) {
    if (t.undone) continue;
    for (const p of t.parts) {
      if (p.kind !== "tool_result" || p.partial) continue;
      const refs = (p as { frame_refs?: unknown }).frame_refs;
      if (!Array.isArray(refs)) continue;
      const callId = String((p as { call_id?: unknown }).call_id ?? "");
      if (!callId) continue;
      refs.forEach((r, index) => {
        const path = (r as { path?: unknown })?.path;
        if (typeof path !== "string" || !path) return;
        const caption = (r as { caption?: unknown }).caption;
        out.push(
          typeof caption === "string" && caption
            ? { call_id: callId, index, path, caption }
            : { call_id: callId, index, path },
        );
      });
    }
  }
  return out;
}

/** The frames to re-send: the newest, with the oldest dropped in whole batches. */
export function keptFrames(all: FrameRef[]): FrameRef[] {
  const n = all.length;
  if (n <= HISTORY_FRAMES_MAX) return all;
  const cut = HISTORY_FRAMES_BATCH * Math.ceil((n - HISTORY_FRAMES_MAX) / HISTORY_FRAMES_BATCH);
  return all.slice(cut);
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function extOf(path: string): string | undefined {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? `.${m[1].toLowerCase()}` : undefined;
}

/** Azure refuses the WHOLE request over one image it cannot decode (probed 2026-10-03), and a
 *  history frame rides every round: only jpeg/png/gif/webp stating a size go (the header parser
 *  also reads BMP, which Azure does not take). */
function decodableImage(bytes: Uint8Array): boolean {
  const size = readImageSize(bytes);
  return !!size && size.width > 0 && size.height > 0 && !(bytes[0] === 0x42 && bytes[1] === 0x4d);
}

/** The bytes of the kept frames, each tagged with the call and index it belongs to. A frame
 *  that is missing, unreadable, too large, not a decodable image, or outside the project is
 *  skipped; the server tells the model so. */
export async function historyAttachments(
  turns: Turn[],
  store: ProjectStoreAccess | null,
): Promise<InferenceAttachment[]> {
  if (!store) return [];
  const out: InferenceAttachment[] = [];
  for (const f of keptFrames(historyFrameRefs(turns))) {
    // The transcript is a file on disk: no path in it may reach a file outside this project.
    const abs = store.resolveWritable(f.path);
    if (!abs) continue;
    try {
      const bytes = await store.readBytes(abs);
      if (!bytes.length || bytes.length > HISTORY_FRAME_MAX_BYTES || !decodableImage(bytes)) continue;
      out.push({
        kind: "image",
        b64: toB64(bytes),
        ...(f.caption ? { caption: f.caption } : {}),
        ext: extOf(f.path),
        call_id: f.call_id,
        index: f.index,
      });
    } catch {
      /* gone (trimmed past the cache budget, or deleted): the server writes a note instead */
    }
  }
  return out;
}
