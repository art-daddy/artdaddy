// Did an edit the person made by hand put back a clip the agent had just changed? Pure: two pairs of timelines
// in, the answer out (timeline/agentUndo.ts asks it after every hand edit, and only while the agent's edit is
// recent).
//
// A clip is compared field by field, each field's value in one canonical JSON form (object keys sorted, so two
// equal values never differ by key order), plus the track it sits on. The agent's edit is reduced to what it did
// to each clip it touched: the clip's state before it (none for a clip the agent made) and the fields it changed.
// A hand edit puts one back when it touches such a clip and leaves every field the agent changed exactly as it was
// before the agent's edit, or removes a clip the agent made. A clip the agent removed cannot be put back by hand
// (a clip made again by hand is a new clip), only by Undo, so it is never counted here.

import type { Timeline } from "./model";

/** One clip as compared here: each field's canonical value, and the id of its track under TRACK. */
export type ClipState = ReadonlyMap<string, string>;

/** The key a clip's track is kept under: a clip's own fields are JSON keys, and none starts with a NUL. */
export const TRACK = "\u0000track";

/** What one edit did to one clip: the clip before it (null when the edit made the clip), and the fields it changed. */
export interface ClipChange {
  readonly before: ClipState | null;
  readonly fields: readonly string[];
}

/** One JSON text per value, whatever the order its object keys were written in. `undefined` is no value at all. */
export function canonical(value: unknown): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol")
    return undefined;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? undefined;
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v) ?? "null").join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const text = canonical((value as Record<string, unknown>)[key]);
    if (text !== undefined) parts.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${parts.join(",")}}`;
}

/** Every clip of the timeline that has an id, by id. */
export function clipStates(timeline: Timeline): Map<string, ClipState> {
  const out = new Map<string, ClipState>();
  for (const track of Array.isArray(timeline?.tracks) ? timeline.tracks : []) {
    if (!track || typeof track !== "object") continue;
    for (const clip of Array.isArray(track.clips) ? track.clips : []) {
      if (!clip || typeof clip !== "object" || typeof clip.id !== "string" || !clip.id) continue;
      const state = new Map<string, string>([[TRACK, String(track.id)]]);
      for (const [key, value] of Object.entries(clip)) {
        const text = canonical(value);
        if (text !== undefined) state.set(key, text);
      }
      out.set(clip.id, state);
    }
  }
  return out;
}

function changedFields(a: ClipState, b: ClipState): string[] {
  const fields: string[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()]))
    if (a.get(key) !== b.get(key)) fields.push(key);
  return fields.sort();
}

/** What an edit from `before` to `after` did to each clip it made or changed (a clip it removed is left out). */
export function clipChanges(before: Timeline, after: Timeline): Map<string, ClipChange> {
  const was = clipStates(before);
  const out = new Map<string, ClipChange>();
  for (const [id, state] of clipStates(after)) {
    const old = was.get(id);
    if (!old) {
      out.set(id, { before: null, fields: [] });
      continue;
    }
    const fields = changedFields(old, state);
    if (fields.length) out.set(id, { before: old, fields });
  }
  return out;
}

function sameClip(a: ClipState | undefined, b: ClipState | undefined): boolean {
  if (!a || !b) return a === b;
  return changedFields(a, b).length === 0;
}

/** The clips a hand edit (from `handBefore` to `handAfter`, as clipStates) put back the way they were before the agent's
 *  edit described by `change`: each one the hand edit touched, and whose every field the agent changed is back to its value
 *  from before the agent's edit, or which the agent made and the hand edit removed. */
export function clipsPutBack(
  change: ReadonlyMap<string, ClipChange>,
  handBefore: ReadonlyMap<string, ClipState>,
  handAfter: ReadonlyMap<string, ClipState>,
): string[] {
  const out: string[] = [];
  for (const [id, made] of change) {
    const now = handAfter.get(id);
    if (sameClip(handBefore.get(id), now)) continue; // the hand edit did not touch it
    if (made.before === null) {
      if (!now) out.push(id);
      continue;
    }
    const before = made.before;
    if (now && made.fields.every((field) => now.get(field) === before.get(field))) out.push(id);
  }
  return out;
}
