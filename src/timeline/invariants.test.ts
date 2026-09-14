import { describe, expect, it } from "vitest";

import { linkLockOk, noBadOverlaps, timelineInvariantViolations } from "./invariants";
import type { Timeline } from "./model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tl = (tracks: any[]): Timeline =>
  ({ canvas: { width: 1920, height: 1080, fps: 30 }, tracks }) as Timeline;

describe("timelineInvariantViolations (shared battery)", () => {
  it("is empty for an internally-consistent timeline", () => {
    const t = tl([
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "a",
            media_ref: "a.mp4",
            kind: "video",
            timeline_in: 0,
            timeline_out: 60,
            source_in: 0,
            source_out: 60,
            speed: 1,
          },
        ],
      },
    ]);
    expect(timelineInvariantViolations(t)).toEqual([]);
  });

  it("flags a linked-A/V desync (t008): same-source partners differ in length", () => {
    const t = tl([
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "v",
            media_ref: "m.mp4",
            kind: "video",
            timeline_in: 0,
            timeline_out: 60,
            speed: 1,
            link_group: "g",
          },
        ],
      },
      {
        id: "a1",
        kind: "audio",
        z: 0,
        clips: [
          {
            id: "a",
            media_ref: "m.mp4",
            kind: "audio",
            timeline_in: 0,
            timeline_out: 30,
            speed: 1,
            link_group: "g",
          },
        ],
      },
    ]);
    expect(linkLockOk(t)).toBe(false);
    expect(timelineInvariantViolations(t).some((v) => /linked A\/V/.test(v))).toBe(true);
  });

  it("flags a same-track overlap", () => {
    const t = tl([
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "a",
            media_ref: "a.mp4",
            kind: "video",
            timeline_in: 0,
            timeline_out: 60,
            source_in: 0,
            source_out: 60,
            speed: 1,
          },
          {
            id: "b",
            media_ref: "b.mp4",
            kind: "video",
            timeline_in: 30,
            timeline_out: 90,
            source_in: 0,
            source_out: 60,
            speed: 1,
          },
        ],
      },
    ]);
    expect(noBadOverlaps(t)).toBe(false);
    expect(timelineInvariantViolations(t).some((v) => /overlap/.test(v))).toBe(true);
  });
});
