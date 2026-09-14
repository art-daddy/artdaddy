// update_text asserts the CLIPS after the call — what a viewer would read and see — rather
// than that the tool returned ok.
import { beforeEach, describe, expect, it } from "vitest";

import { updateTextTool, addTextClipsTool } from "./placement";
import { applyOp, loadTimeline } from "./engine";
import { resetTestDocuments, seededCtx } from "../test/timelineKit";
import type { ClientToolContext } from "../tools/context";
import type { Clip } from "./model";

type Any = Record<string, unknown>;

const textClips = (tl: Any): Clip[] =>
  ((tl.tracks as Any[]) ?? [])
    .flatMap((t) => (t.clips as Clip[]) ?? [])
    .filter((c) => c.kind === "text");

async function seedText(ctx: ClientToolContext, entries: Any[]): Promise<string[]> {
  const r = (await addTextClipsTool({ entries }, ctx)) as Any;
  expect(r.ok).toBe(true);
  return (r.created as Array<{ clip_id: string }>).map((c) => c.clip_id);
}

describe("update_text", () => {
  beforeEach(async () => {
    await resetTestDocuments();
  });

  it("replaces the words", async () => {
    const { ctx, store } = await seededCtx();
    const [id] = await seedText(ctx, [{ timeline_in: 0, duration: 30, content: "before" }]);

    expect(((await updateTextTool({ clip_ids: [id], content: "after" }, ctx)) as Any).ok).toBe(
      true,
    );
    expect(textClips(await loadTimeline(store))[0].content).toEqual([{ text: "after" }]);
  });

  it("patches style without erasing what it did not mention", async () => {
    const { ctx, store } = await seededCtx();
    const [id] = await seedText(ctx, [
      {
        timeline_in: 0,
        duration: 30,
        content: "hi",
        style: { font: "Anton", size: 90, outline: { color: "#000000", width: 8 } },
      },
    ]);

    await updateTextTool({ clip_ids: [id], style: { size: 120, outline: { width: 2 } } }, ctx);
    expect(textClips(await loadTimeline(store))[0].style).toEqual({
      font: "Anton",
      size: 120,
      outline: { color: "#000000", width: 2 },
    });
  });

  it("restyles a whole caption group without naming its clips", async () => {
    const { ctx, store } = await seededCtx();
    const ids = await seedText(ctx, [
      { timeline_in: 0, duration: 30, content: "a" },
      { timeline_in: 30, duration: 30, content: "b" },
      { timeline_in: 60, duration: 30, content: "c" },
    ]);
    // Two of the three are in the group; the third must be left alone.
    await applyOp(store, "mark", (tl) => {
      for (const t of tl.tracks) {
        for (const c of t.clips ?? []) {
          if (c.id === ids[0] || c.id === ids[1]) c.caption_group = "g1";
        }
      }
    });

    const r = (await updateTextTool({ caption_group: "g1", style: { size: 44 } }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    const after = textClips(await loadTimeline(store));
    expect(after.find((c) => c.id === ids[0])!.style).toMatchObject({ size: 44 });
    expect(after.find((c) => c.id === ids[1])!.style).toMatchObject({ size: 44 });
    expect(after.find((c) => c.id === ids[2])!.style).toBeUndefined();
  });

  it("refuses a group that matches nothing rather than silently changing zero clips", async () => {
    const { ctx } = await seededCtx();
    await seedText(ctx, [{ timeline_in: 0, duration: 30, content: "hi" }]);
    const r = (await updateTextTool({ caption_group: "ghost", style: { size: 44 } }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("ghost");
  });

  it("refuses a non-text clip instead of writing text fields onto video", async () => {
    const { ctx, store } = await seededCtx();
    await applyOp(store, "seed-video", (tl) => {
      tl.tracks.push({
        id: "v1",
        kind: "video",
        z: tl.tracks.length,
        clips: [
          {
            id: "vid1",
            kind: "video",
            media_ref: "a.mp4",
            timeline_in: 0,
            timeline_out: 30,
          } as Clip,
        ],
      });
    });

    const r = (await updateTextTool({ clip_ids: ["vid1"], content: "nope" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/only applies to text/i);
  });

  it("rejects the whole call when one id is unknown, changing nothing", async () => {
    // Atomicity: a half-applied restyle is worse than a refused one.
    const { ctx, store } = await seededCtx();
    const [id] = await seedText(ctx, [{ timeline_in: 0, duration: 30, content: "keep" }]);
    const r = (await updateTextTool({ clip_ids: [id, "ghost"], content: "changed" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(textClips(await loadTimeline(store))[0].content).toEqual([{ text: "keep" }]);
  });

  it("needs a target and something to change", async () => {
    const { ctx } = await seededCtx();
    const [id] = await seedText(ctx, [{ timeline_in: 0, duration: 30, content: "hi" }]);
    expect(((await updateTextTool({ content: "x" }, ctx)) as Any).ok).toBe(false);
    expect(((await updateTextTool({ clip_ids: [id] }, ctx)) as Any).ok).toBe(false);
  });

  it("does not move or retime the clip", async () => {
    // set_clip_properties owns timing; two owners for that is how a trim became a slip.
    const { ctx, store } = await seededCtx();
    const [id] = await seedText(ctx, [{ timeline_in: 10, duration: 30, content: "hi" }]);
    await updateTextTool({ clip_ids: [id], content: "different words entirely" }, ctx);
    const c = textClips(await loadTimeline(store))[0];
    expect([c.timeline_in, c.timeline_out]).toEqual([10, 40]);
  });

  it("clears an object with an explicit null", async () => {
    const { ctx, store } = await seededCtx();
    const [id] = await seedText(ctx, [
      { timeline_in: 0, duration: 30, content: "hi", animation: { build: "typewriter" } },
    ]);
    await updateTextTool({ clip_ids: [id], animation: null }, ctx);
    expect(textClips(await loadTimeline(store))[0].animation).toBeUndefined();
  });
});
