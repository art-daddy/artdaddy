// Pure label/lookup helpers for the timeline editor (no React, no store).
import type { Clip, Track } from "../../timeline/model";

/** A clip's stable id, falling back to a caller-supplied index key. */
export function clipId(c: Clip, fallback: string): string {
  return String(c.id ?? fallback);
}

/** Human label for a clip: the text content for text clips, else the media's name.
 *  A clip stores a bare library id, so the readable name comes from the catalog
 *  (`names`); anything unresolved falls back to the ref's last path segment, which
 *  is what legacy path-shaped refs carried. */
export function clipLabel(c: Clip, names?: Record<string, string>): string {
  if (c.kind === "text") {
    const t: unknown =
      (c as Record<string, unknown>).text ?? (c as Record<string, unknown>).content;
    if (typeof t === "string") return t;
    if (t && typeof t === "object") {
      const o = t as Record<string, unknown>;
      const inner = o.content ?? o.text;
      if (typeof inner === "string") return inner;
    }
    return "text";
  }
  const s = String(c.media_ref ?? c.kind ?? "clip");
  return names?.[s] ?? s.split(/[\\/]/).pop() ?? s;
}

/** Premiere-style track labels: v1/v2/a1/t1… numbered per kind, in array order. */
export function trackLabels(tracks: Track[]): string[] {
  const counts: Record<string, number> = {};
  return tracks.map((tr) => {
    const kind = String(tr.kind ?? "video");
    const p =
      kind === "audio" ? "a" : kind === "text" ? "t" : kind === "video" ? "v" : kind[0] || "x";
    counts[p] = (counts[p] ?? 0) + 1;
    return `${p}${counts[p]}`;
  });
}

/** The same labels keyed by track id, for anything that holds an id rather than a row —
 *  the chat's tool summaries. Here rather than at the call site so a sentence about a
 *  track cannot disagree with the ruler the user is looking at. */
export function trackLabelById(tracks: Track[]): Record<string, string> {
  const labels = trackLabels(tracks);
  const out: Record<string, string> = {};
  tracks.forEach((tr, i) => {
    if (tr.id) out[String(tr.id)] = labels[i];
  });
  return out;
}

/** Locate a clip + its track id in the timeline (for building a clip mention). */
export function findClipWithTrack(
  tracks: Track[],
  clipId: string,
): { clip: Clip; trackId: string } | null {
  for (const t of tracks) {
    for (const c of t.clips ?? []) {
      if (String(c.id) === clipId) return { clip: c, trackId: String(t.id ?? "") };
    }
  }
  return null;
}
