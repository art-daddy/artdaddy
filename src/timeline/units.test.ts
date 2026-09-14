import { describe, expect, it } from "vitest";

import { seededCtx, videoRunner } from "../test/timelineKit";
import { rippleDeleteTool } from "./edit";
import { loadTimeline } from "./engine";
import { addClipsTool } from "./placement";
import { setClipPropertiesTool, setKeyframesTool } from "./props";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// The frames/seconds convention, verified END-TO-END through the real client tools
// (the tools are where the fps math actually happens). The discriminator:
//   clip_id / a timeline position  => PROJECT FRAMES (at canvas fps, 30 here)
//   a slice of the raw SOURCE media => SECONDS
// The contract-side guard (descriptions name the right unit; new time params must
// be classified) lives in ArtDaddy/tests/unit/test_time_units_contract.py.
describe("time units: clip/timeline = frames, source media = seconds", () => {
  async function clipOf(ctx: Any, id: string): Promise<Any> {
    const tl = (await loadTimeline(ctx.store)) as Any;
    const c = (tl.tracks ?? []).flatMap((t: Any) => t.clips ?? []).find((x: Any) => x.id === id);
    if (!c) throw new Error(`clip ${id} not found`);
    return c;
  }

  it("SOURCE domain: source_span is SECONDS -> converted to frames (2s @ 30fps = 60f)", async () => {
    const { ctx } = await seededCtx();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, source_span: [0, 2] }] },
      ctx,
    )) as Any;
    const c = await clipOf(ctx, r.created[0].clip_id);
    expect(Number(c.source_out) - Number(c.source_in)).toBe(60); // 2 source-seconds -> 60 frames
    expect(Number(c.timeline_out) - Number(c.timeline_in)).toBe(60);
  });

  it("TIMELINE domain: set_keyframes t is FRAMES, stored as-is (no fps multiply)", async () => {
    const { ctx } = await seededCtx(videoRunner);
    const a = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 90 }] },
      ctx,
    )) as Any;
    const id = a.created[0].clip_id as string;
    await setKeyframesTool(
      {
        clip_id: id,
        property: "opacity",
        keyframes: [
          { t: 0, v: 0 },
          { t: 30, v: 1 },
        ],
      },
      ctx,
    );
    const c = await clipOf(ctx, id);
    expect((c.opacity as Array<{ t: number }>).map((k) => k.t)).toEqual([0, 30]); // frames, not [0, 900]
  });

  it("TIMELINE domain: fade is FRAMES, stored as-is (15f = half a second at 30fps)", async () => {
    const { ctx } = await seededCtx(videoRunner);
    const a = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 90 }] },
      ctx,
    )) as Any;
    const id = a.created[0].clip_id as string;
    await setClipPropertiesTool({ clip_ids: [id], fade: { in: 15 } }, ctx);
    const c = await clipOf(ctx, id);
    expect((c.fade as Any).in).toBe(15);
  });

  it("TIMELINE domain: ripple_delete ranges are FRAMES (cuts [30,60) = 30f)", async () => {
    const { ctx } = await seededCtx(videoRunner);
    const a = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 90, track_id: "v2" }] },
      ctx,
    )) as Any;
    const id = a.created[0].clip_id as string;
    const r = (await rippleDeleteTool(
      { clip_id: id, ranges: [{ start: 30, end: 60 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.removed_span).toBe(30); // 30 project frames removed
  });
});
