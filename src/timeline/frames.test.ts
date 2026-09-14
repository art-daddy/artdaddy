import { describe, expect, it } from "vitest";

import { OpError } from "./errors";
import { canvasFps, isNum, newId, parseTimestamp, toFrames, toSecondsView } from "./frames";
import type { Timeline } from "./model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe("toFrames", () => {
  it("rounds numbers and parses integer strings", () => {
    expect(toFrames(60, 30)).toBe(60);
    expect(toFrames(59.6, 30)).toBe(60);
    expect(toFrames("144", 30)).toBe(144);
    expect(toFrames("-5", 30)).toBe(-5);
  });
  it("converts MM:SS time codes via fps", () => {
    expect(toFrames("0:02", 30)).toBe(60);
    expect(toFrames("1:00.5", 30)).toBe(1815);
  });
  it("rejects bools, decimal strings, and junk", () => {
    expect(() => toFrames(true, 30)).toThrow(OpError);
    expect(() => toFrames("5.0", 30)).toThrow(OpError);
    expect(() => toFrames({}, 30)).toThrow(OpError);
  });
});

describe("parseTimestamp", () => {
  it("handles numbers, decimals, MM:SS, H:MM:SS", () => {
    expect(parseTimestamp(5)).toBe(5);
    expect(parseTimestamp("2.5")).toBe(2.5);
    expect(parseTimestamp("1:30")).toBe(90);
    expect(parseTimestamp("1:00:00")).toBe(3600);
  });
  it("throws on junk", () => {
    expect(() => parseTimestamp("a:b")).toThrow(OpError);
    expect(() => parseTimestamp("1:2:3:4")).toThrow(OpError);
  });
});

describe("helpers", () => {
  it("isNum excludes NaN, strings, and bools", () => {
    expect(isNum(3)).toBe(true);
    expect(isNum(Number.NaN)).toBe(false);
    expect(isNum("3")).toBe(false);
    expect(isNum(true)).toBe(false);
  });
  it("canvasFps falls back to 30", () => {
    expect(canvasFps({ canvas: { width: 1, height: 1, fps: 24 }, tracks: [] })).toBe(24);
    expect(canvasFps({ canvas: { width: 1, height: 1, fps: 0 }, tracks: [] })).toBe(30);
  });
  it("newId is prefixed hex and non-repeating", () => {
    const a = newId("clip");
    expect(a).toMatch(/^clip_[0-9a-f]{8}$/);
    expect(newId("t")).not.toBe(a);
  });
});

describe("toSecondsView", () => {
  it("projects frame coords + keyframe t to seconds and drops units", () => {
    const tl: Timeline = {
      units: "frames",
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [
            {
              media_ref: "a.mp4",
              source_in: 0,
              source_out: 60,
              timeline_in: 0,
              timeline_out: 60,
              rotate: [{ t: 30, v: 90 }],
            },
          ],
        },
      ],
    };
    const s = toSecondsView(tl) as Any;
    const c = s.tracks[0].clips[0];
    expect(c.source_out).toBe(2);
    expect(c.timeline_out).toBe(2);
    expect(c.rotate[0].t).toBe(1);
    expect(s.units).toBeUndefined();
    expect(s.canvas.fps).toBe(30); // canvas untouched
  });
  it("passes a non-frames timeline through unchanged", () => {
    const tl = {
      units: "seconds",
      canvas: { width: 1, height: 1, fps: 30 },
      tracks: [],
    } as Timeline;
    expect(toSecondsView(tl)).toBe(tl);
  });
});
