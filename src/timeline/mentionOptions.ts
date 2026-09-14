// Pure helpers for the chat's "@ mention" autocomplete + "Add context" picker.
// Kept out of the React component so the option-building + query parsing are
// unit-testable; ChatView only renders + wires these.
import { canvasFps } from "./frames";
import { gapAt, gapsOn } from "./gaps";
import {
  buildClipMention,
  buildGapMention,
  buildMediaMention,
  buildPlayheadMention,
  buildRangeMention,
  mentionKey,
  mentionLabel,
  type Mention,
} from "./mentions";
import type { Timeline } from "./model";

export interface MentionOption {
  key: string;
  label: string;
  group: "playhead" | "range" | "clip" | "media" | "gap";
  mention: Mention;
}

/** The trailing "@query" the user is typing at the end of the input (drives the
 *  inline autocomplete), or null when the caret isn't in a fresh @token. */
export function detectAtQuery(text: string): string | null {
  const m = /(?:^|\s)@([\w-]*)$/.exec(text);
  return m ? m[1] : null;
}

/** Remove the trailing "@query" once a suggestion is chosen. */
export function stripAtQuery(text: string): string {
  return text.replace(/(^|\s)@[\w-]*$/, "$1");
}

export interface MentionSource {
  timeline: Timeline | null;
  playheadFrame: number | null;
  selectedRange: { startFrame: number; endFrame: number } | null;
  /** The gap the user clicked, as the editor stores it: a POINT, resolved to its span here. */
  selectedGap: { trackId: string; atFrame: number } | null;
  media: { ref: string; name: string; kind?: string }[];
}

/** Build the pickable options (playhead, selected range, clips, media),
 *  optionally filtered by a case-insensitive query. Capped for the dropdown. */
export function buildMentionOptions(src: MentionSource, query = ""): MentionOption[] {
  const fps = src.timeline ? canvasFps(src.timeline) : 30;
  const opts: MentionOption[] = [];
  if (src.playheadFrame != null) {
    const m = buildPlayheadMention(src.playheadFrame, fps);
    opts.push({ key: mentionKey(m), label: mentionLabel(m), group: "playhead", mention: m });
  }
  if (src.selectedRange) {
    const m = buildRangeMention(src.selectedRange.startFrame, src.selectedRange.endFrame, fps);
    opts.push({ key: mentionKey(m), label: mentionLabel(m), group: "range", mention: m });
  }
  // The selected gap leads, like the playhead and range: it is the one the user is looking at.
  // The rest of the timeline's gaps follow so they can be reached without clicking first.
  const seenGaps = new Set<string>();
  const pushGap = (trackId: string, gap: { start: number; end: number }) => {
    const m = buildGapMention(trackId, gap, fps);
    const key = mentionKey(m);
    if (seenGaps.has(key)) return;
    seenGaps.add(key);
    opts.push({ key, label: mentionLabel(m), group: "gap", mention: m });
  };
  if (src.selectedGap) {
    const g = gapAt(src.timeline, src.selectedGap.trackId, src.selectedGap.atFrame);
    if (g) pushGap(g.trackId, g);
  }
  for (const track of src.timeline?.tracks ?? []) {
    if (track.locked === true) continue; // nothing can be done to a gap on a locked track
    for (const g of gapsOn(track)) pushGap(String(track.id), g);
  }
  for (const track of src.timeline?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.id) continue;
      const m = buildClipMention(clip, track.id ? String(track.id) : undefined);
      opts.push({ key: mentionKey(m), label: `clip ${m.clipId}`, group: "clip", mention: m });
    }
  }
  for (const md of src.media) {
    const m = buildMediaMention(md.ref, md.name, md.kind);
    opts.push({ key: mentionKey(m), label: md.name || md.ref, group: "media", mention: m });
  }
  const q = query.trim().toLowerCase();
  const filtered = q
    ? opts.filter((o) => o.label.toLowerCase().includes(q) || o.key.toLowerCase().includes(q))
    : opts;
  return filtered.slice(0, 20);
}
