// Pairwise (all-pairs) table for the RISKY interacting axes of set_clip_properties:
// {speed} x {length mechanism: none | timeline_out | duration | loop | stretch} x
// {linked A/V | standalone}. These are the factors that share the rescale /
// explicit-length / linkPartners code path — the t008 desync class. The full cross
// is only 2 x 5 x 2 = 20 rows (a small deterministic matrix, not an explosion) and
// it covers every PAIR among the interacting axes with named, readable cases. This
// complements the RANDOM fast-check sequences in invariants.property.test.ts with a
// designed table pinned on the load-bearing invariant.
//
// Universal oracle (must hold for EVERY row, valid edit or footgun): the edit is
// atomic (ok:true), linked A/V stay length+speed locked (linkLockOk — the t008
// invariant), and nothing serialises to NaN/Infinity. Renderability
// (validateTimeline == []) is asserted only for SELF-CONSISTENT rows — a bare
// length shrink WITHOUT a matching speed is a known parity footgun the renderer
// can't stretch, so we don't require it there.
import { describe, expect, it } from "vitest";

import { audioRunner, seededCtx, videoRunner } from "../test/timelineKit";
import { loadTimeline } from "./engine";
import { addClipsTool } from "./placement";
import { setClipPropertiesTool } from "./props";
import { validateTimeline } from "./validate";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Linked A/V (shared link_group + media_ref) stay identical in length AND speed —
 *  the invariant a speed/length edit must never break (mirrors invariants.property). */
function linkLockOk(tl: Any): boolean {
  const groups = new Map<string, Any[]>();
  for (const t of tl.tracks ?? []) {
    for (const c of t.clips ?? []) {
      if (!c.link_group) continue;
      const arr = groups.get(c.link_group) ?? [];
      arr.push(c);
      groups.set(c.link_group, arr);
    }
  }
  for (const clips of groups.values()) {
    const lenByMedia = new Map<string, Set<number>>();
    const speedByMedia = new Map<string, Set<number>>();
    for (const c of clips) {
      const key = String(c.media_ref);
      const len = (Number(c.timeline_out) || 0) - (Number(c.timeline_in) || 0);
      const speed = Number(c.speed ?? 1) || 1;
      (lenByMedia.get(key) ?? lenByMedia.set(key, new Set<number>()).get(key)!).add(len);
      (speedByMedia.get(key) ?? speedByMedia.set(key, new Set<number>()).get(key)!).add(speed);
    }
    for (const s of lenByMedia.values()) if (s.size > 1) return false;
    for (const s of speedByMedia.values()) if (s.size > 1) return false;
  }
  return true;
}

type LenMech = "none" | "timeline_out" | "duration" | "loop" | "stretch";
const LENS: LenMech[] = ["none", "timeline_out", "duration", "loop", "stretch"];

/** Fresh project with ONE 60-frame video clip. `linked` uses audioRunner so
 *  add_clips splits a linked audio partner (A/V); else videoRunner keeps it solo. */
async function oneClip(linked: boolean): Promise<{ ctx: Any; store: Any; id: string }> {
  const { ctx, store } = await seededCtx(linked ? audioRunner : videoRunner);
  const add = (await addClipsTool(
    { entries: [{ media_ref: "m.mp4", timeline_in: 0, timeline_out: 60 }] },
    ctx,
  )) as Any;
  const id = (add.created as Any[])[0].clip_id as string;
  return { ctx, store, id };
}

describe("set_clip_properties pairwise (speed x length-mechanism x linked)", () => {
  for (const linked of [false, true]) {
    for (const speed of [false, true]) {
      for (const len of LENS) {
        const label = `speed=${speed} len=${len} linked=${linked}`;
        it(label, async () => {
          const { ctx, store, id } = await oneClip(linked);
          const props: Any = {};
          if (speed) props.speed = 2;
          if (len === "timeline_out") props.timeline_out = 30;
          else if (len === "duration") props.duration = 30;
          else if (len === "loop") props.loop = true;
          else if (len === "stretch") props.stretch = true;

          const r = (await setClipPropertiesTool(
            { clip_ids: [id], properties: props },
            ctx,
          )) as Any;
          if (Object.keys(props).length === 0) {
            // degenerate row (no axis set): the tool rejects an empty edit, nothing changes.
            expect(r.ok).toBe(false);
            return;
          }
          expect(r.ok).toBe(true); // atomic apply

          const tl = await loadTimeline(store);
          // t008: a linked A/V pair never desyncs, whatever the axis combination.
          if (linked) expect(linkLockOk(tl)).toBe(true);
          // no numeric garbage leaked in by any combination.
          expect(JSON.parse(JSON.stringify(tl))).toEqual(tl);
          // Renderable when self-consistent: speed rescales to parity; loop/stretch are
          // fill-slot (parity-exempt); "none" is unchanged. A bare length change with no
          // matching speed is a documented parity footgun — not required to validate.
          const selfConsistent = speed || len === "none" || len === "loop" || len === "stretch";
          if (selfConsistent) expect(validateTimeline(tl)).toEqual([]);
        });
      }
    }
  }
});
