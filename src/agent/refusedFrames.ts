// Pictures the AI provider refused (UJ-046): what the server names, and what the app writes in its transcript so they are never sent again.
//
// The provider refuses a whole request over one picture and never says which. When the server has found it, it names it in the round's
// result (`refused_frames`: the tool call that showed it and its place in that call's frames). The app then writes `refused: true` on
// that frame's own entry in the transcript: `historyFrames` stops re-sending its bytes, the server reads the mark and tells the model
// it was left out, and the mark is saved with the conversation, so it holds after a restart.
//
// What the server names is checked before anything is written (it is data from outside the app), the mark is the one key added,
// nothing else about the conversation changes, and marking twice is marking once: the person is told once.
import type { Turn } from "../store/chatTranscript";

export interface RefusedFrame {
  call_id: string;
  index: number;
}

/** The most pictures one round can name: a request carries at most 50 (the provider's own limit), so a server cannot have found more. */
export const MAX_NAMED = 50;

/** What the server named, as far as it can be trusted: a call id that is text and a place that is a whole number, each once, in the
 *  order given, at most {@link MAX_NAMED}. Anything else is dropped. */
export function refusedFramesOf(raw: unknown): RefusedFrame[] {
  if (!Array.isArray(raw)) return [];
  const out: RefusedFrame[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_NAMED) break;
    if (!item || typeof item !== "object") continue;
    const { call_id: callId, index } = item as { call_id?: unknown; index?: unknown };
    if (typeof callId !== "string" || callId === "") continue;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) continue;
    const key = JSON.stringify([callId, index]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ call_id: callId, index });
  }
  return out;
}

/** Write the mark on each named frame that is in the conversation and not marked yet. Returns the new turns and how many frames were
 *  marked now (0 when everything named was already marked or is not in the conversation, and then `turns` is the same array). Pure:
 *  the turns it was given are not written into, and a turn or part it did not change is the same object. */
export function markRefusedFrames(
  turns: Turn[],
  named: RefusedFrame[],
): { turns: Turn[]; marked: number } {
  const places = new Map<string, Set<number>>();
  for (const { call_id: callId, index } of named) {
    const set = places.get(callId) ?? new Set<number>();
    set.add(index);
    places.set(callId, set);
  }
  let marked = 0;
  const next = turns.map((t) => {
    let turnChanged = false;
    const parts = t.parts.map((p) => {
      if (p.kind !== "tool_result") return p;
      const wanted = places.get(String(p.call_id ?? ""));
      const refs = (p as { frame_refs?: unknown }).frame_refs;
      if (!wanted || !Array.isArray(refs)) return p;
      let partChanged = false;
      const frameRefs = refs.map((ref, i) => {
        if (!wanted.has(i) || !ref || typeof ref !== "object") return ref;
        if ((ref as { refused?: unknown }).refused === true) return ref;
        partChanged = true;
        marked += 1;
        return { ...(ref as object), refused: true };
      });
      if (!partChanged) return p;
      turnChanged = true;
      return { ...p, frame_refs: frameRefs };
    });
    return turnChanged ? { ...t, parts } : t;
  });
  return marked ? { turns: next, marked } : { turns, marked: 0 };
}

/** The one line the person reads when pictures were left out of the conversation. */
export function refusedNotice(count: number): string {
  return count === 1
    ? "The AI provider refused 1 picture from this conversation, so it is left out of every message from now on."
    : `The AI provider refused ${count} pictures from this conversation, so they are left out of every message from now on.`;
}
