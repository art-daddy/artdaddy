// Gaps as a chat subject. The editor already owns gap selection (store `selectedGap`, the
// timeline highlight, Delete closing it); these cover exposing one to the model.
//
// The failure that matters is a gap arriving as something the model reads as a RANGE — the two
// look identical as a frame span and ask for opposite things.
import { describe, expect, it } from "vitest";

import { composeModelText } from "../agent/compose";
import { buildGapMention, buildRangeMention, mentionKey, mentionLabel } from "./mentions";
import { buildMentionOptions, type MentionSource } from "./mentionOptions";
import type { Timeline } from "./model";

const FPS = 30;

/** Two clips with a 30-frame hole between them on v1, and a full track on v2. */
const timeline = (): Timeline =>
  ({
    units: "frames",
    canvas: { width: 1920, height: 1080, fps: FPS },
    tracks: [
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          { id: "a", media_ref: "m1", timeline_in: 0, timeline_out: 30 },
          { id: "b", media_ref: "m1", timeline_in: 60, timeline_out: 90 },
        ],
      },
      {
        id: "v2",
        kind: "video",
        z: 1,
        clips: [{ id: "c", media_ref: "m1", timeline_in: 0, timeline_out: 90 }],
      },
    ],
  }) as unknown as Timeline;

const source = (over: Partial<MentionSource> = {}): MentionSource => ({
  timeline: timeline(),
  playheadFrame: null,
  selectedRange: null,
  selectedGap: null,
  media: [],
  ...over,
});

describe("buildGapMention", () => {
  it("carries the track, the span and its timecodes", () => {
    const m = buildGapMention("v1", { start: 30, end: 60 }, FPS);
    expect(m).toMatchObject({ kind: "gap", trackId: "v1", startFrame: 30, endFrame: 60 });
    expect(m.durationFrames).toBe(30);
    expect(m.startTimecode).toBe("00:00:01:00");
    expect(m.endTimecode).toBe("00:00:02:00");
  });

  it("normalises a reversed span instead of emitting a negative duration", () => {
    const m = buildGapMention("v1", { start: 60, end: 30 }, FPS);
    expect([m.startFrame, m.endFrame]).toEqual([30, 60]);
    expect(m.durationFrames).toBe(30);
  });

  it("keys two gaps on the same track apart", () => {
    const a = buildGapMention("v1", { start: 30, end: 60 }, FPS);
    const b = buildGapMention("v1", { start: 90, end: 120 }, FPS);
    expect(mentionKey(a)).not.toBe(mentionKey(b));
    // …and a gap is never confusable with a range over the same frames.
    expect(mentionKey(a)).not.toBe(mentionKey(buildRangeMention(30, 60, FPS)));
  });

  it("labels the chip with the track, so two gaps are tellable apart in the composer", () => {
    expect(mentionLabel(buildGapMention("v1", { start: 30, end: 60 }, FPS))).toContain("v1");
  });
});

describe("gaps in the mention picker", () => {
  it("offers the real gap on the track that has one", () => {
    const gaps = buildMentionOptions(source()).filter((o) => o.group === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].mention).toMatchObject({ trackId: "v1", startFrame: 30, endFrame: 60 });
  });

  it("does not invent a gap after the last clip", () => {
    // Trailing space is unbounded — there is nothing to close, and offering it would have the
    // model ripple against an edge that does not exist.
    const gaps = buildMentionOptions(source()).filter((o) => o.group === "gap");
    expect(gaps.every((g) => (g.mention as { endFrame: number }).endFrame <= 60)).toBe(true);
  });

  it("puts the selected gap first, ahead of the ones the user has not clicked", () => {
    const opts = buildMentionOptions(
      source({
        timeline: {
          ...timeline(),
          tracks: [
            {
              id: "v1",
              kind: "video",
              z: 0,
              clips: [
                { id: "a", media_ref: "m1", timeline_in: 0, timeline_out: 30 },
                { id: "b", media_ref: "m1", timeline_in: 60, timeline_out: 90 },
                { id: "d", media_ref: "m1", timeline_in: 150, timeline_out: 180 },
              ],
            },
          ],
        } as unknown as Timeline,
        selectedGap: { trackId: "v1", atFrame: 120 },
      }),
    ).filter((o) => o.group === "gap");
    expect(opts[0].mention).toMatchObject({ startFrame: 90, endFrame: 150 });
    expect(opts).toHaveLength(2); // the selected one is not also listed a second time
  });

  it("skips a locked track — its gap cannot be acted on", () => {
    const tl = timeline();
    (tl.tracks[0] as unknown as { locked: boolean }).locked = true;
    const gaps = buildMentionOptions(source({ timeline: tl })).filter((o) => o.group === "gap");
    expect(gaps).toHaveLength(0);
  });

  it("is reachable by typing, matching the track name", () => {
    const gaps = buildMentionOptions(source(), "v1").filter((o) => o.group === "gap");
    expect(gaps).toHaveLength(1);
  });
});

describe("what the model is told", () => {
  it("says the frames are EMPTY, so a gap cannot read as a range", () => {
    const text = composeModelText(
      "close this",
      [],
      [buildGapMention("v1", { start: 30, end: 60 }, FPS)],
    );
    expect(text).toContain("v1");
    expect(text).toContain("[30, 60)");
    expect(text).toMatch(/empty/i);
  });

  it("describes a gap differently from a range over the same frames", () => {
    const gap = composeModelText("x", [], [buildGapMention("v1", { start: 30, end: 60 }, FPS)]);
    const range = composeModelText("x", [], [buildRangeMention(30, 60, FPS)]);
    // Both name the same span; only one of them claims there is material in it.
    expect(gap).not.toBe(range);
    expect(range).not.toMatch(/empty/i);
  });
});
