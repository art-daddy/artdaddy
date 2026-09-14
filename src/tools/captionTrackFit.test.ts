// Two ways a caption/title call reports success and shows the user nothing.
//
// Both were found by the MCP all-tools sweep against the running app, not by a unit test:
// add_captions took the default text track whatever was already on it (one pre-existing title
// made the whole call fail validation and change nothing), and add_text_clips accepted an entry
// with no `content` and placed a text clip with nothing to draw.
import { beforeEach, describe, expect, it } from "vitest";

import { addCaptionsTool } from "./captions";
import { joinPath } from "./store";
import { addTextClipsTool, updateTextTool } from "../timeline/placement";
import { loadTimeline } from "../timeline/engine";
import { DIR, resetTestDocuments, seededCtx } from "../test/timelineKit";
import type { Clip } from "../timeline/model";

const SRT = "1\n00:00:00,000 --> 00:00:01,000\nfirst\n\n2\n00:00:01,500 --> 00:00:02,500\nsecond\n";

const textClips = async (store: Parameters<typeof loadTimeline>[0]) => {
  const tl = await loadTimeline(store);
  return (tl.tracks ?? [])
    .filter((t) => t.kind === "text")
    .map((t) => ({ id: t.id, clips: (t.clips ?? []).length }));
};

beforeEach(async () => {
  await resetTestDocuments();
});

describe("add_captions picks a text track the group actually fits on", () => {
  const seedSubtitle = async (ctx: Awaited<ReturnType<typeof seededCtx>>["ctx"]) => {
    await ctx.store.writeText(joinPath(DIR, "library/cues.srt"), SRT);
    return "library/cues.srt";
  };

  it("does not fail just because a title already sits where the captions go", async () => {
    // The repro: add a title, then caption. Taking the default track unconditionally made this
    // "rejected by validation; timeline left unchanged" — a plain, obvious user sequence.
    const { ctx, store } = await seededCtx();
    const title = await addTextClipsTool(
      { entries: [{ timeline_in: 0, timeline_out: 30, content: "hello" }] },
      ctx,
    );
    expect(title.ok).not.toBe(false);

    const ref = await seedSubtitle(ctx);
    const r = await addCaptionsTool({ subtitle_media_ref: ref }, ctx);
    expect(r.ok).not.toBe(false);
    expect(r.count).toBe(2);

    // ...and the title is still there: the captions went somewhere else, they did not replace it.
    const tl = await loadTimeline(store);
    const all = (tl.tracks ?? []).flatMap((t) => t.clips ?? []);
    expect(all.filter((c) => c.kind === "text")).toHaveLength(3);
    const runText = (c: (typeof all)[number]) => {
      const run = c.content?.[0];
      return typeof run === "string" ? run : run?.text;
    };
    expect(all.some((c) => runText(c) === "hello")).toBe(true);
  });

  it("reuses a free text track rather than growing a new one every call", async () => {
    // The failure direction of the fix: "always make a new track" would also pass the test
    // above, and would litter a project with one track per caption pass.
    const { ctx, store } = await seededCtx();
    const ref = await seedSubtitle(ctx);
    await addCaptionsTool({ subtitle_media_ref: ref }, ctx);
    const first = await textClips(store);
    expect(first).toHaveLength(1);

    // Same spans again — this one genuinely collides, so it must land elsewhere.
    await addCaptionsTool({ subtitle_media_ref: ref }, ctx);
    expect(await textClips(store)).toHaveLength(2);
  });

  it("still honours an explicit text_track_id instead of quietly relocating", async () => {
    // The caller named a track. Moving their captions somewhere else "to make it work" is a
    // worse outcome than telling them it did not fit.
    const { ctx, store } = await seededCtx();
    const ref = await seedSubtitle(ctx);
    await addCaptionsTool({ subtitle_media_ref: ref, text_track_id: "mine" }, ctx);
    const tracks = await textClips(store);
    expect(tracks.map((t) => t.id)).toContain("mine");
  });
});

describe("captions sit low in the frame, where a title does not", () => {
  // The reported symptom was a title and its captions rendered on top of each other: text
  // defaults to dead-centre, which is right for a title and wrong for a caption. The rule is
  // that the two DEFAULTS must not collide — not the specific number that achieves it.
  // `position.y` is animatable (a number or keyframes); a default caption only ever has a number.
  const yOf = (clip: Clip | undefined) => {
    const y = clip?.transform?.position?.y;
    return typeof y === "number" ? y : undefined;
  };

  const captionsOf = async (store: Parameters<typeof loadTimeline>[0]) => {
    const tl = await loadTimeline(store);
    return (tl.tracks ?? []).flatMap((t) => t.clips ?? []).filter((c) => c.caption_group);
  };

  it("a default caption and a default title do not land in the same place", async () => {
    const { ctx, store } = await seededCtx();
    await ctx.store.writeText(joinPath(DIR, "library/cues.srt"), SRT);
    await addTextClipsTool(
      { entries: [{ timeline_in: 0, timeline_out: 30, content: "title" }] },
      ctx,
    );
    await addCaptionsTool({ subtitle_media_ref: "library/cues.srt" }, ctx);

    const all = (await loadTimeline(store)).tracks.flatMap((t) => t.clips ?? []);
    const title = all.find((c) => !c.caption_group && c.kind === "text");
    const caps = all.filter((c) => c.caption_group);
    expect(caps.length).toBeGreaterThan(0);
    // The title keeps the app default (no transform of its own = centred)...
    expect(yOf(title)).toBeUndefined();
    // ...and every caption is explicitly placed BELOW the centre it would otherwise share.
    for (const c of caps) expect(yOf(c)).toBeGreaterThan(0.5);
  });

  it("places captions from speech the same way as from a subtitle file", async () => {
    // Two doors into the same tool; styling one and not the other is the usual half-fix.
    const { ctx, store } = await seededCtx();
    await ctx.store.writeText(joinPath(DIR, "library/cues.srt"), SRT);
    await addCaptionsTool({ subtitle_media_ref: "library/cues.srt" }, ctx);
    const fromFile = yOf((await captionsOf(store))[0]);
    expect(fromFile).toBeGreaterThan(0.5);
  });

  it("lets the caller move them, and does not discard the rest of their transform", async () => {
    // Repositioning a whole caption set is a group patch, and a patch must not wipe the
    // position it is merging into — the over-correction that would make the new default useless.
    const { ctx, store } = await seededCtx();
    await ctx.store.writeText(joinPath(DIR, "library/cues.srt"), SRT);
    const made = await addCaptionsTool({ subtitle_media_ref: "library/cues.srt" }, ctx);
    const before = yOf((await captionsOf(store))[0]);

    await updateTextTool(
      { caption_group: String(made.caption_group), transform: { scale: 1.4 } },
      ctx,
    );
    const after = (await captionsOf(store))[0];
    expect(after.transform?.scale).toBe(1.4);
    expect(yOf(after)).toBe(before);

    await updateTextTool(
      { caption_group: String(made.caption_group), transform: { position: { y: 0.2 } } },
      ctx,
    );
    const moved = (await captionsOf(store))[0];
    expect(yOf(moved)).toBe(0.2);
    expect(moved.transform?.position?.x).toBe(0.5);
  });
});

describe("add_text_clips refuses a clip with nothing to draw", () => {
  it("rejects an entry with no content instead of placing an invisible clip", async () => {
    const { ctx, store } = await seededCtx();
    const r = await addTextClipsTool({ entries: [{ timeline_in: 0, timeline_out: 30 }] }, ctx);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/content/);
    expect(await textClips(store)).toHaveLength(0);
  });

  it("names the mistake when the caller sends 'text' — the field it is easiest to guess wrong", async () => {
    const { ctx } = await seededCtx();
    const r = await addTextClipsTool(
      { entries: [{ timeline_in: 0, timeline_out: 30, text: "hello" }] },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/'text'/);
  });

  it("still allows raw_ass, which carries its own content", async () => {
    // The over-correction guard: raw_ass is the escape hatch and has no `content`.
    const { ctx, store } = await seededCtx();
    const r = await addTextClipsTool(
      { entries: [{ timeline_in: 0, timeline_out: 30, raw_ass: "{\\an5}hi" }] },
      ctx,
    );
    expect(r.ok).not.toBe(false);
    expect(await textClips(store)).toHaveLength(1);
  });

  it("leaves the WHOLE batch unwritten when one entry is contentless", async () => {
    // Atomicity: a partial batch is the worst outcome — some titles appear, some do not, and
    // the error says nothing about which.
    const { ctx, store } = await seededCtx();
    const r = await addTextClipsTool(
      {
        entries: [
          { timeline_in: 0, timeline_out: 30, content: "fine" },
          { timeline_in: 40, timeline_out: 60 },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(await textClips(store)).toHaveLength(0);
  });
});
