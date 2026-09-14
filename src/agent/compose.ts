// Compose the model-facing message for a turn: the user's text, the editor-
// context refs they attached (playhead / range / clip / media), and a manifest
// of attached library assets. Ports engine._compose_model_text +
// _format_editor_context — the model is TOLD what's attached, then pulls pixels
// on demand via inspect_media (other NLEs: nothing pushed eagerly).
import type { Attachment } from "../api/types";
import type { Mention } from "../timeline/mentions";

function formatEditorContext(mentions: Mention[]): string {
  if (!mentions.length) return "";
  const lines = [
    "Editor context the user attached to THIS message - treat these refs as the " +
      "subject of the request (FRAMES; ranges are half-open, end exclusive):",
  ];
  for (const m of mentions) {
    if (m.kind === "playhead") {
      lines.push(`  - playhead: frame ${m.frame} (${m.timecode})`.trimEnd());
    } else if (m.kind === "range") {
      lines.push(
        `  - range: frames [${m.startFrame}, ${m.endFrame}) = ${m.startTimecode}\u2013${m.endTimecode} ` +
          `(${m.durationFrames} frames)`,
      );
    } else if (m.kind === "clip") {
      const trk = m.trackId ? ` on track ${m.trackId}` : "";
      const src = m.source ? `, source ${m.source}` : "";
      lines.push(`  - clip ${m.clipId}${trk}: frames [${m.startFrame}, ${m.endFrame})${src}`);
    } else if (m.kind === "media") {
      const name = m.name ? ` (${m.name})` : "";
      lines.push(`  - media asset ${m.ref}${name} - call inspect_media on the ref to view it`);
    } else if (m.kind === "gap") {
      // Spelled out as EMPTY: a bare frame span reads exactly like a range, and the two ask for
      // opposite things — one has material to edit, the other is the absence of it.
      lines.push(
        `  - gap on track ${m.trackId}: empty frames [${m.startFrame}, ${m.endFrame}) = ` +
          `${m.startTimecode}–${m.endTimecode} (${m.durationFrames} frames, no clip there)`,
      );
    }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

/** Build the model-facing text: user text + editor context + attachment manifest. */
export function composeModelText(
  text: string,
  attachments: Attachment[],
  mentions: Mention[],
): string {
  const blocks: string[] = [];
  const ctx = formatEditorContext(mentions);
  if (ctx) blocks.push(ctx);
  if (attachments.length) {
    const lines = [
      "Attached file(s), already saved as project library assets. Reference each by " +
        "its ref in tools (add_clips source, inspect_media, get_transcript, ...) - never " +
        "a filesystem path - and don't ask the user to re-provide them. To SEE or " +
        "analyze one, call `inspect_media` with its ref:",
    ];
    for (const a of attachments) {
      const ref = a.path || a.caption || "file";
      const label = a.caption || "";
      lines.push(`  - ${a.kind ?? "file"}${label ? ` (${label})` : ""}: ${ref}`);
    }
    blocks.push(lines.join("\n"));
  }
  if (!blocks.length) return text;
  const tail = blocks.join("\n\n");
  return text ? `${text}\n\n${tail}` : tail;
}
