// Collapsing exists to keep a minute of speech from eating a whole get_timeline response.
// The rules that matter: a collapsed row must still let the model READ the captions and ACT
// on them, and it must never swallow a clip the model has no other way to reach.
import { beforeEach, describe, expect, it } from "vitest";

import { clipText, collapseCaptionGroups } from "./shape";
import { applyOp } from "./engine";
import { getTimelineTool } from "./ops";
import { resetTestDocuments, seededCtx } from "../test/timelineKit";
import type { Clip } from "./model";

const cap = (id: string, group: string | undefined, tin: number, text: string): Clip =>
  ({
    id,
    kind: "text",
    timeline_in: tin,
    timeline_out: tin + 30,
    content: [{ text }],
    ...(group ? { caption_group: group } : {}),
  }) as Clip;

describe("collapseCaptionGroups", () => {
  it("collapses a group to one row carrying its span, count and words", () => {
    const out = collapseCaptionGroups([
      cap("t1", "g1", 0, "hello"),
      cap("t2", "g1", 30, "there"),
      cap("t3", "g1", 60, "friend"),
    ]);
    expect(out).toEqual([
      {
        kind: "caption_group",
        caption_group: "g1",
        timeline_in: 0,
        timeline_out: 90,
        count: 3,
        text: "hello there friend",
        note: expect.stringContaining("update_text"),
      },
    ]);
  });

  it("leaves a lone caption alone, because a summary would hide its id for no saving", () => {
    const out = collapseCaptionGroups([cap("t1", "g1", 0, "solo")]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("t1");
    expect(out[0].kind).toBe("text");
  });

  it("keeps ungrouped clips exactly as they were", () => {
    // A title on the same track must not be swallowed by a neighbouring caption group.
    const out = collapseCaptionGroups([
      cap("title", undefined, 0, "MY TITLE"),
      cap("t1", "g1", 30, "a"),
      cap("t2", "g1", 60, "b"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("title");
    expect(out[1].kind).toBe("caption_group");
  });

  it("keeps two different groups separate", () => {
    const out = collapseCaptionGroups([
      cap("a1", "g1", 0, "one"),
      cap("a2", "g1", 30, "two"),
      cap("b1", "g2", 60, "three"),
      cap("b2", "g2", 90, "four"),
    ]);
    expect(out.map((r) => r.caption_group)).toEqual(["g1", "g2"]);
    expect(out.map((r) => r.count)).toEqual([2, 2]);
  });

  it("emits each group once even when its clips are interleaved", () => {
    const out = collapseCaptionGroups([
      cap("a1", "g1", 0, "one"),
      cap("b1", "g2", 30, "two"),
      cap("a2", "g1", 60, "three"),
      cap("b2", "g2", 90, "four"),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.count)).toEqual([2, 2]);
  });

  it("truncates a long read rather than returning the whole script", () => {
    const many = Array.from({ length: 200 }, (_, i) => cap(`t${i}`, "g1", i * 30, "word"));
    const row = collapseCaptionGroups(many)[0];
    expect(String(row.text).length).toBeLessThan(300);
    expect(String(row.text).endsWith("…")).toBe(true);
    expect(row.count).toBe(200); // the count still tells the truth
  });

  it("changes nothing when no clip carries a group", () => {
    const clips = [cap("t1", undefined, 0, "a"), cap("t2", undefined, 30, "b")];
    expect(collapseCaptionGroups(clips).map((c) => c.id)).toEqual(["t1", "t2"]);
  });
});

describe("clipText", () => {
  it("reads words from runs and from a bare string alike", () => {
    expect(clipText({ content: [{ text: "a" }, { text: "b" }] } as Clip)).toBe("a b");
    expect(clipText({ content: "plain" } as Clip)).toBe("plain");
    expect(clipText({ text: "legacy" } as Clip)).toBe("legacy");
    expect(clipText({} as Clip)).toBe("");
  });
});

// A pure collapse function proves nothing about what the model actually receives; this drives
// the tool the model calls.
describe("get_timeline caption collapsing (whole path)", () => {
  beforeEach(async () => {
    await resetTestDocuments();
  });

  const seed = async (store: Parameters<typeof applyOp>[0]): Promise<void> => {
    await applyOp(store, "seed", (tl) => {
      tl.tracks.push({
        id: "captions",
        kind: "text",
        z: 0,
        clips: [cap("t1", "g1", 0, "hello"), cap("t2", "g1", 30, "there")],
      });
    });
  };

  const clipsOf = (r: Record<string, unknown>): Array<Record<string, unknown>> =>
    (r.timeline as { tracks: Array<{ clips: Array<Record<string, unknown>> }> }).tracks[0]?.clips ??
    [];

  it("hands the model one collapsed row, not every caption", async () => {
    const { ctx, store } = await seededCtx();
    await seed(store);
    const clips = clipsOf((await getTimelineTool({}, ctx)) as Record<string, unknown>);
    expect(clips).toHaveLength(1);
    expect(clips[0].kind).toBe("caption_group");
    expect(clips[0].text).toBe("hello there");
  });

  it("expands to real clips, with their ids, on caption_detail", async () => {
    const { ctx, store } = await seededCtx();
    await seed(store);
    const clips = clipsOf(
      (await getTimelineTool({ caption_detail: true }, ctx)) as Record<string, unknown>,
    );
    expect(clips.map((c) => c.id)).toEqual(["t1", "t2"]);
  });
});
