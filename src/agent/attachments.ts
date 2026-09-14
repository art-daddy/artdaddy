// Turn a tool result's `_attachments` (media the model should SEE) into inference
// attachments (bytes). The client owns the media, so it resolves each ref to its
// local file, reads the bytes, and hands them to the next model round.
import type { ProjectStoreAccess } from "../tools/store";
import type { InferenceAttachment } from "./types";

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i) : "";
}

/** Read a tool result's `_attachments` (media the model should SEE) into
 *  inference attachments (bytes), resolving each client ref to its local file. */
export async function collectInferenceAttachments(
  rawAttachments: unknown,
  store: ProjectStoreAccess | null,
): Promise<InferenceAttachment[]> {
  if (!store || !Array.isArray(rawAttachments)) return [];
  const out: InferenceAttachment[] = [];
  for (const a of rawAttachments) {
    if (!a || typeof a !== "object") continue;
    const path = (a as { path?: string }).path;
    if (!path) continue;
    try {
      const abs = (await store.resolveRef(path)) ?? path;
      out.push({
        kind: String((a as { kind?: string }).kind ?? "image"),
        b64: toB64(await store.readBytes(abs)),
        caption: String((a as { caption?: string }).caption ?? ""),
        fps: (a as { fps?: number }).fps,
        ext: extOf(path),
      });
    } catch {
      /* unreadable ref — skip */
    }
  }
  return out;
}
