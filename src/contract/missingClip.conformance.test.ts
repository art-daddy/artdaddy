import { describe, expect, it } from "vitest";

import catalog from "./catalog.json";
import { seededCtx } from "../test/timelineKit";
import { createToolRegistry } from "../tools";
import { loadTimeline } from "../timeline/engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// Every tool that takes a clip id must, when that clip is gone, tell the model so in words it can
// act on: the id, that it no longer exists, and to re-read get_timeline. One user's session hit a
// clip removed between reading the timeline and acting on it, and the refusal gave no way to tell
// a stale id from a typo. 3ba29aa added `missingClip` at the sites that were seen; this walks
// EVERY such tool in the contract, with otherwise-VALID arguments, so the only thing wrong with
// each call is the id — the realistic case.
//
// Driven through the registry (the agent's door), against a real seeded timeline, and it also
// checks nothing was written: a refusal that half-applies is worse than one that is vague.

const GONE = "clip_gone_7f3a";

/** Minimal valid args per tool, each naming GONE wherever a clip id goes. */
const CALLS: Record<string, Record<string, unknown>> = {
  apply_color: { clip_ids: [GONE], brightness: 0.1 },
  apply_effects: { clip_ids: [GONE], add: [{ type: "blur" }] },
  export: { clip_ids: [GONE] },
  get_transcript: { clip_id: GONE },
  inspect_color: { clip_id: GONE },
  inspect_media: { clip_id: GONE },
  link_clips: { clip_ids: [GONE, `${GONE}_b`] },
  move_clips: { moves: [{ clip_id: GONE, to_timeline_in: 30 }] },
  remove_clips: { clip_ids: [GONE] },
  ripple_delete: { clip_id: GONE },
  set_clip_properties: { clip_ids: [GONE], opacity: 0.5 },
  set_keyframes: { clip_id: GONE, property: "opacity", keyframes: [{ t: 0, v: 1 }] },
  set_transition: { clip_id: GONE, transition_in: { kind: "fade", duration: 10 } },
  split_clips: { splits: [{ clip_id: GONE, at: 15 }] },
  unlink_clips: { clip_ids: [GONE] },
  update_text: { clip_ids: [GONE], content: "hello" },
  video_ask: { clip_id: GONE, prompt: "what happens?" },
  video_find_moment: { clip_id: GONE, query: "a rocket" },
};

/** Tools that do NOT yet explain a missing clip actionably (found 2026-09-27). Each is an
 *  expected failure: fixing one flips its test red until it is removed from here. */
const KNOWN_GAPS: Record<string, string> = {
  remove_clips: '"no matching clip ids" — does not say WHICH id',
  unlink_clips: '"no linked clips to unlink" — misleading: reads as "exists but not linked"',
  get_transcript: "names the id, but no re-read hint",
  inspect_media: "names the id, but no re-read hint",
  inspect_color: "names the id, but no re-read hint",
  video_ask: "names the id, but no re-read hint",
  video_find_moment: "names the id, but no re-read hint",
};

/** Tools whose schema names a clip id at any depth — read from the contract, not remembered. */
function clipIdTools(): string[] {
  const mentions = (o: unknown): boolean => {
    if (!o || typeof o !== "object") return false;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === "properties" && v && typeof v === "object") {
        if (Object.keys(v).some((n) => /^clip_ids?$/.test(n))) return true;
      }
      if (mentions(v)) return true;
    }
    return false;
  };
  return (catalog as Any).tools
    .filter((t: Any) => mentions(t.parameters ?? t.input_schema))
    .map((t: Any) => t.name)
    .sort();
}

describe("every clip-id tool explains a missing clip actionably", () => {
  it("covers every tool in the contract that takes a clip id", () => {
    expect(Object.keys(CALLS).sort()).toEqual(clipIdTools());
    for (const name of Object.keys(KNOWN_GAPS)) expect(CALLS).toHaveProperty(name);
  });

  const check = async (name: string, args: Record<string, unknown>) => {
    const { ctx, store } = await seededCtx();
    const reg = createToolRegistry(() => ctx as Any) as Any;
    const before = JSON.stringify(await loadTimeline(store));

    const r = (await reg.run(name, args)) as Any;

    // Nothing may be written whatever the message says.
    expect(JSON.stringify(await loadTimeline(store))).toBe(before);
    expect(r.ok, `${name} accepted a clip that does not exist`).toBe(false);
    const msg = String(r.error ?? "");
    expect(msg, `${name}: ${msg}`).toContain(GONE);
    expect(msg, `${name}: ${msg}`).toMatch(/no clip|no longer exists|not found|does not exist/i);
    expect(msg, `${name}: ${msg}`).toMatch(/get_timeline/);
  };

  const fixed = Object.entries(CALLS).filter(([n]) => !(n in KNOWN_GAPS));
  const gaps = Object.entries(CALLS).filter(([n]) => n in KNOWN_GAPS);
  it.each(fixed)("%s names the id, says it is gone, and says to re-read", check);
  it.fails.each(gaps)("KNOWN GAP: %s does not yet explain a missing clip", check);

  // The expected failures above must fail for the MESSAGE, never because a stale id slipped
  // through and wrote something.
  it.each(gaps)("KNOWN GAP %s still refuses and writes nothing", async (name, args) => {
    const { ctx, store } = await seededCtx();
    const reg = createToolRegistry(() => ctx as Any) as Any;
    const before = JSON.stringify(await loadTimeline(store));
    const r = (await reg.run(name, args)) as Any;
    expect(r.ok).toBe(false);
    expect(JSON.stringify(await loadTimeline(store))).toBe(before);
  });
});
