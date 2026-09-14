// A subtitle is a library citizen that can NEVER become a clip. That rule is the whole reason
// the kind exists rather than being "half-accepted", so it is asserted at the doors a subtitle
// could actually come through — not just on the classifier.
import { describe, expect, it, beforeEach } from "vitest";

import { isPlaceable, kindOf } from "../media/formats";
import { detectKind, placeableKind } from "../timeline/helpers";
import { OpError } from "../timeline/errors";
import { addClipsTool, insertClipsTool } from "../timeline/placement";
import { MEDIA_RE } from "../lib/upload";
import { attachmentKindFromName, mediaKindFromName } from "../components/chatMedia";
import { resetTestDocuments, seededCtx } from "../test/timelineKit";
import { joinPath } from "./store";
import { DIR } from "../test/timelineKit";

type Any = Record<string, unknown>;

describe("subtitle is a library kind", () => {
  it("classifies .srt and .vtt", () => {
    expect(kindOf("a.srt")).toBe("subtitle");
    expect(kindOf("a.vtt")).toBe("subtitle");
    expect(detectKind("a.srt")).toBe("subtitle");
  });

  it("can be dragged in, like other media", () => {
    expect(MEDIA_RE.test("captions.srt")).toBe(true);
    expect(MEDIA_RE.test("captions.vtt")).toBe(true);
  });

  it("is mentionable in chat but never sent as an attachment", () => {
    // There is nothing for a model to look at or listen to; it travels as a media_ref.
    expect(mediaKindFromName("a.srt")).toBe("subtitle");
    expect(attachmentKindFromName("a.srt")).toBeNull();
    expect(attachmentKindFromName("a.mp4")).toBe("video");
  });
});

describe("subtitle can never become a clip", () => {
  beforeEach(async () => {
    await resetTestDocuments();
  });

  it("is not placeable", () => {
    expect(isPlaceable(kindOf("a.srt"))).toBe(false);
    for (const k of ["video", "image", "audio"] as const) expect(isPlaceable(k)).toBe(true);
  });

  it("refuses at the shared placement rule, rather than being called video", () => {
    // detectKind's fallback is "video"; without this the file would be probed and rendered.
    expect(() => placeableKind("a.srt")).toThrow(OpError);
    expect(() => placeableKind("a.mp4")).not.toThrow();
  });

  it("points the caller at add_captions instead of just refusing", () => {
    expect(() => placeableKind("a.srt")).toThrow(/add_captions/);
  });

  it("add_clips refuses one", async () => {
    const { ctx, store } = await seededCtx();
    await ctx.store.writeText(
      joinPath(DIR, "library/subs.srt"),
      "1\n00:00:01,000 --> 00:00:02,000\nHi.\n",
    );
    const r = (await addClipsTool(
      { entries: [{ media_ref: "library/subs.srt", timeline_in: 0, duration: 30 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/add_captions/);
    // and nothing was placed
    const tl = await (await import("../timeline/engine")).loadTimeline(store);
    expect(tl.tracks.flatMap((t) => t.clips ?? [])).toHaveLength(0);
  });

  it("insert_clips refuses one too, not just add_clips", async () => {
    // The sibling producer: guarding one path and not the other is the usual half-fix.
    const { ctx } = await seededCtx();
    await ctx.store.writeText(
      joinPath(DIR, "library/subs.srt"),
      "1\n00:00:01,000 --> 00:00:02,000\nHi.\n",
    );
    const r = (await insertClipsTool(
      { at: 0, entries: [{ media_ref: "library/subs.srt", duration: 30 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/add_captions/);
  });
});
