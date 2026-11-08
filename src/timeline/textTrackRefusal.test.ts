import { describe, expect, it } from "vitest";

import { seededCtx } from "../test/timelineKit";
import { createToolRegistry } from "../tools";
import { loadTimeline } from "./engine";
import { rangesOverlap } from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// A refused add_text_clips must reach the model as an ordinary {ok:false} it can act on, and
// must leave the SAVED document byte-identical. Checked through the agent's own door (the tool
// registry) because the layers below disagree about how a refusal travels: the fit check throws
// a plain Error, applyOp re-throws anything that is not an OpError, and only the registry turns
// it into a result. Calling addTextClips directly â€” as the unit tests do â€” sees none of that.
//
// Every refusal kind is walked, including the one that CREATES a track before refusing (an
// earlier batch names a track that does not exist yet), which is where a partial write hides.

async function setup() {
  const { ctx, store } = await seededCtx();
  const reg = createToolRegistry(() => ctx as Any) as Any;
  const call = (args: Any) => reg.run("add_text_clips", args) as Promise<Any>;
  const seed = await call({
    entries: [{ content: "x", timeline_in: 0, timeline_out: 15, track_id: "titles" }],
  });
  expect(seed.ok).toBe(true);
  return { call, saved: async () => JSON.stringify(await loadTimeline(store)) };
}

const REFUSALS: Array<[string, Any[], RegExp]> = [
  [
    "entries the call put on one NAMED track overlap each other",
    [
      { content: "a", timeline_in: 100, timeline_out: 160, track_id: "lower" },
      { content: "b", timeline_in: 130, timeline_out: 190, track_id: "lower" },
    ],
    /entries\[1\] .*overlaps entries\[0\].* on track 'lower'/,
  ],
  [
    "a named track is occupied where the entry goes",
    [{ content: "a", timeline_in: 5, timeline_out: 10, track_id: "titles" }],
    /track 'titles' already has clips/,
  ],
  [
    "an earlier batch CREATES a track, then a later one is refused",
    [
      { content: "a", timeline_in: 0, timeline_out: 1, track_id: "lower_thirds" },
      { content: "b", timeline_in: 0, timeline_out: 1, track_id: "titles" },
    ],
    /track 'titles' already has clips/,
  ],
  [
    "an entry has nothing to draw",
    [
      { content: "a", timeline_in: 200, timeline_out: 220 },
      { timeline_in: 300, timeline_out: 320 },
    ],
    /entries\[1\] needs 'content'/,
  ],
];

describe("add_text_clips refusals, through the registry, against the saved document", () => {
  it.each(REFUSALS)("%s -> ok:false, actionable, nothing saved", async (_why, entries, message) => {
    const { call, saved } = await setup();
    const before = await saved();

    const r = await call({ entries });

    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(message);
    expect(await saved()).toBe(before);
  });

  // The counterpart, so the table above cannot pass by refusing everything.
  it("the same shapes succeed once the collision is removed", async () => {
    const { call, saved } = await setup();
    const before = await saved();
    const r = await call({
      entries: [
        { content: "a", timeline_in: 0, timeline_out: 1, track_id: "lower_thirds" },
        { content: "b", timeline_in: 20, timeline_out: 30, track_id: "titles" },
        { content: "c", timeline_in: 100, timeline_out: 160 },
        { content: "d", timeline_in: 160, timeline_out: 190 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(await saved()).not.toBe(before);
  });

  // The 12 of 13: two titles that overlap, no track named. Through the registry and into the saved
  // document, the way the agent reaches it: both land, on tracks that each show one text at a time,
  // and the reply says where, so the next call can edit them by the ids it was given.
  it("overlapping titles that name no track are placed on separate tracks and saved", async () => {
    const { call, saved } = await setup();
    const before = JSON.parse(await saved());
    const r = await call({
      entries: [
        { content: "a", timeline_in: 100, timeline_out: 160 },
        { content: "b", timeline_in: 130, timeline_out: 190 },
        { content: "c", timeline_in: 150, timeline_out: 200 },
      ],
    });
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    expect(r.count).toBe(3);
    expect(new Set(r.created.map((c: Any) => c.track_id)).size).toBe(3);
    expect(String((r.notes ?? []).join(" "))).toMatch(/3 text tracks/);

    const after = JSON.parse(await saved());
    const textTracks = after.tracks.filter((t: Any) => t.kind === "text");
    for (const t of textTracks) {
      const spans = (t.clips ?? [])
        .map((c: Any) => [c.timeline_in, c.timeline_out] as [number, number])
        .sort((x: number[], y: number[]) => x[0] - y[0]);
      for (let i = 1; i < spans.length; i++)
        expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
    }
    // What was already there is untouched (the new text may share a track that had room).
    const titlesBefore = before.tracks.find((t: Any) => t.id === "titles").clips;
    for (const c of titlesBefore)
      expect(after.tracks.find((t: Any) => t.id === "titles").clips).toContainEqual(c);
    // Every created id is on the track the reply said.
    for (const c of r.created)
      expect(
        after.tracks
          .find((t: Any) => t.id === c.track_id)
          .clips.some((x: Any) => x.id === c.clip_id),
      ).toBe(true);
  });

  // The suggestion must be one the caller can actually use: a TEXT track, not the busy one, with
  // room for the span. (Mutation testing showed nothing checked any of the three.)
  it("suggests only a text track that has room", async () => {
    const { call } = await setup();
    await call({
      entries: [{ content: "busy", timeline_in: 0, timeline_out: 15, track_id: "lower" }],
    });
    await call({
      entries: [{ content: "free", timeline_in: 900, timeline_out: 915, track_id: "spare" }],
    });
    const r = await call({
      entries: [{ content: "x", timeline_in: 5, timeline_out: 10, track_id: "titles" }],
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/track_id:'spare'/);
  });

  it("offers no track at all when none has room, rather than a busy one", async () => {
    const { call } = await setup();
    await call({
      entries: [{ content: "busy", timeline_in: 0, timeline_out: 15, track_id: "lower" }],
    });
    const r = await call({
      entries: [{ content: "x", timeline_in: 5, timeline_out: 10, track_id: "titles" }],
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).not.toMatch(/track_id:'/);
    expect(String(r.error)).toMatch(/omit track_id/);
  });

  // The guard's own contract: "a text clip with nothing to draw is never what anyone meant, and
  // it is invisible rather than noisy". It only catches the literal empty string. Each of these
  // renders NOTHING yet comes back ok:true.
  // KNOWN GAP (found 2026-09-27 by mutation testing; pre-existing). Remove `.fails` once fixed.
  it.fails.each([
    ["whitespace only", "   "],
    ["an empty runs list", []],
    ["a run with no text", [{ text: "" }]],
  ])("refuses a clip with nothing to draw: %s", async (_why, content) => {
    const { call, saved } = await setup();
    const before = await saved();
    const r = await call({ entries: [{ content, timeline_in: 100, timeline_out: 130 }] });
    expect(r.ok).toBe(false);
    expect(await saved()).toBe(before);
  });

  it("names the field when the caller sent `text` instead of `content`", async () => {
    const { call } = await setup();
    const r = await call({ entries: [{ text: "hi", timeline_in: 100, timeline_out: 130 }] });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/got 'text'/);
  });
});

describe("rangesOverlap: the one definition of 'these collide'", () => {
  it("is symmetric, and ranges that only touch do not collide", () => {
    expect(rangesOverlap(0, 60, 30, 90)).toBe(true);
    expect(rangesOverlap(30, 90, 0, 60)).toBe(true);
    expect(rangesOverlap(0, 60, 60, 90)).toBe(false);
    expect(rangesOverlap(60, 90, 0, 60)).toBe(false);
    expect(rangesOverlap(10, 20, 0, 100)).toBe(true);
    expect(rangesOverlap(0, 10, 20, 30)).toBe(false);
  });
});
