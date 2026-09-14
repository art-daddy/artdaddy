import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { clipKind, clipSourceSpanSeconds, clipSpanToFrames, detectKind } from "./helpers";
import type { Clip } from "./model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe("detectKind", () => {
  it("classifies by extension", () => {
    expect(detectKind("a.mp4")).toBe("video");
    expect(detectKind("a.MOV")).toBe("video");
    expect(detectKind("a.png")).toBe("image");
    expect(detectKind("a.jpeg")).toBe("image");
    expect(detectKind("a.mp3")).toBe("audio");
    expect(detectKind("a.wav")).toBe("audio");
    expect(detectKind("a.lottie")).toBe("lottie");
    expect(detectKind("noext")).toBe("video");
  });
});

describe("clipSourceSpanSeconds", () => {
  const clip = (over: Partial<Clip>): Clip =>
    ({ id: "c", timeline_in: 0, timeline_out: 900, source_in: 5400, ...over }) as Clip;

  // The repro: a 30s span of a 10-minute file, placed at the start. inspect_media(clip_id)
  // sampled frames at 149s and 447s — the quarter points of the WHOLE file — because nothing
  // told it the clip only shows 180-210s.
  it("reports the span the clip actually shows, not the whole source", () => {
    expect(clipSourceSpanSeconds(clip({}), 30)).toEqual([180, 210]);
  });

  it("accounts for speed: the same visible length consumes more source at 2x", () => {
    expect(clipSourceSpanSeconds(clip({ speed: 2 }), 30)).toEqual([180, 240]);
    expect(clipSourceSpanSeconds(clip({ speed: 0.5 }), 30)).toEqual([180, 195]);
  });

  it("treats a missing or absurd speed as 1x rather than dividing by it", () => {
    expect(clipSourceSpanSeconds(clip({ speed: 0 }), 30)).toEqual([180, 210]);
    expect(clipSourceSpanSeconds(clip({ speed: -3 }), 30)).toEqual([180, 210]);
  });

  // Ignores source_out on purpose: the manual trim path has written source ranges past the
  // end of the file, and a window built from one would ask ffmpeg for frames that do not
  // exist. The visible span cannot encode that.
  it("ignores a source_out that runs past the end of the footage", () => {
    expect(clipSourceSpanSeconds(clip({ source_out: 999999 }), 30)).toEqual([180, 210]);
  });

  // The invariant that survives a rewrite: this is the inverse of clipSpanToFrames, so
  // feeding its answer back must return the clip's own visible range.
  it("round-trips through clipSpanToFrames for any clip", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100000 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 100000 }),
        fc.constantFrom(0.5, 1, 2, 3),
        fc.constantFrom(24, 25, 30, 60),
        (tin, len, srcIn, speed, fps) => {
          const c = clip({ timeline_in: tin, timeline_out: tin + len, source_in: srcIn, speed });
          const [s, e] = clipSourceSpanSeconds(c, fps);
          expect(clipSpanToFrames(c, s, e, fps)).toEqual([tin, tin + len]);
        },
      ),
    );
  });
});

describe("clipKind", () => {
  it("prefers explicit audio/text, else infers from source", () => {
    expect(clipKind({ kind: "audio" } as Any as Clip)).toBe("audio");
    expect(clipKind({ kind: "text" } as Any as Clip)).toBe("text");
    expect(clipKind({ media_ref: "a.png" } as Any as Clip)).toBe("image");
    expect(clipKind({} as Any as Clip)).toBe("video");
  });
});
