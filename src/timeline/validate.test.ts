import { describe, expect, it } from "vitest";

import { emptyTimeline, type Timeline } from "./model";
import { validateTimeline } from "./validate";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function media(over: Record<string, unknown> = {}): Any {
  return {
    media_ref: "a.mp4",
    source_in: 0,
    source_out: 60,
    timeline_in: 0,
    timeline_out: 60,
    ...over,
  };
}
function tl(tracks: Any[]): Timeline {
  return { units: "frames", canvas: { width: 1080, height: 1920, fps: 30 }, tracks };
}

describe("validateTimeline structural", () => {
  it("rejects missing canvas, bad dims, and a non-list tracks", () => {
    expect(validateTimeline({ tracks: [] } as Any)[0]).toContain("canvas");
    expect(
      validateTimeline({ canvas: { width: 0, height: 1, fps: 30 }, tracks: [] } as Any)[0],
    ).toContain("width");
    expect(
      validateTimeline({ canvas: { width: 1, height: 1, fps: 30 }, tracks: "x" } as Any)[0],
    ).toContain("list");
  });
  it("accepts an empty timeline (valid editing state)", () => {
    expect(validateTimeline(emptyTimeline())).toEqual([]);
  });
  it("rejects duplicate track ids, bad kind, and non-numeric z", () => {
    const errs = validateTimeline(
      tl([
        { id: "a", kind: "video", z: 0, clips: [] },
        { id: "a", kind: "nope", clips: [] },
      ]),
    );
    expect(errs.some((e) => e.includes("duplicate track id"))).toBe(true);
    expect(errs.some((e) => e.includes("kind must be"))).toBe(true);
    expect(errs.some((e) => e.includes("z must be a number"))).toBe(true);
  });
});

describe("validateTimeline media clips", () => {
  it("accepts a well-formed timeline", () => {
    expect(validateTimeline(tl([{ id: "v", kind: "video", z: 0, clips: [media()] }]))).toEqual([]);
  });
  it("flags missing fields", () => {
    const errs = validateTimeline(
      tl([{ id: "v", kind: "video", z: 0, clips: [{ timeline_in: 0, timeline_out: 60 }] }]),
    );
    expect(errs.some((e) => e.includes("missing field 'media_ref'"))).toBe(true);
  });
  it("flags the timing invariant", () => {
    const errs = validateTimeline(
      tl([{ id: "v", kind: "video", z: 0, clips: [media({ source_out: 30 })] }]),
    );
    expect(errs.some((e) => e.includes("!= timeline duration"))).toBe(true);
  });
  it("flags the speed invariant with a note", () => {
    const errs = validateTimeline(
      tl([
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [media({ speed: 2, source_out: 60, timeline_out: 60 })],
        },
      ]),
    );
    // source 2s / speed 2 = 1s played != 2s timeline
    expect(errs.some((e) => e.includes("/speed"))).toBe(true);
  });
  it("flags non-positive speed and same-track overlap", () => {
    expect(
      validateTimeline(tl([{ id: "v", kind: "video", z: 0, clips: [media({ speed: 0 })] }])).some(
        (e) => e.includes("speed"),
      ),
    ).toBe(true);
    const overlap = validateTimeline(
      tl([
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [
            media({ timeline_in: 0, timeline_out: 60 }),
            media({ timeline_in: 30, timeline_out: 90, source_out: 60 }),
          ],
        },
      ]),
    );
    expect(overlap.some((e) => e.includes("overlaps previous clip"))).toBe(true);
  });

  it("allows an abutting transition (non-shifting model B)", () => {
    const errs = validateTimeline(
      tl([
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [
            media({ timeline_in: 0, timeline_out: 60 }),
            media({
              timeline_in: 60,
              timeline_out: 120,
              transition_in: { kind: "crossfade", duration: 15 },
            }),
          ],
        },
      ]),
    );
    expect(errs).toEqual([]); // clips abut (overlap 0) — the crossfade is render-side
  });

  it("rejects a transition longer than either clip", () => {
    const errs = validateTimeline(
      tl([
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [
            media({ timeline_in: 0, timeline_out: 60 }),
            media({
              timeline_in: 60,
              timeline_out: 120,
              transition_in: { kind: "crossfade", duration: 90 },
            }),
          ],
        },
      ]),
    );
    expect(errs.some((e) => e.includes("exceeds a clip's length"))).toBe(true); // dur 90f > clip len 60f
  });

  it("rejects a transition on a clip with no preceding clip", () => {
    const errs = validateTimeline(
      tl([
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [media({ transition_in: { kind: "crossfade", duration: 15 } })],
        },
      ]),
    );
    expect(errs.some((e) => e.includes("needs a preceding clip"))).toBe(true);
  });
});

describe("validateTimeline text + audio clips", () => {
  it("validates text clips", () => {
    expect(
      validateTimeline(
        tl([
          {
            id: "t",
            kind: "text",
            z: 0,
            clips: [{ kind: "text", text: "hi", timeline_in: 0, timeline_out: 30 }],
          },
        ]),
      ),
    ).toEqual([]);
    expect(
      validateTimeline(
        tl([
          {
            id: "t",
            kind: "text",
            z: 0,
            clips: [{ kind: "text", text: "x", timeline_in: 30, timeline_out: 10 }],
          },
        ]),
      ).some((e) => e.includes("timeline_out must be > timeline_in")),
    ).toBe(true);
  });
  it("validates audio clips", () => {
    expect(
      validateTimeline(
        tl([
          {
            id: "a",
            kind: "audio",
            z: 0,
            clips: [{ kind: "audio", media_ref: "m.mp3", timeline_in: 0, timeline_out: 30 }],
          },
        ]),
      ),
    ).toEqual([]);
    expect(
      validateTimeline(
        tl([
          {
            id: "a",
            kind: "audio",
            z: 0,
            clips: [{ kind: "audio", timeline_in: 0, timeline_out: 30 }],
          },
        ]),
      ).some((e) => e.includes("missing 'media_ref'")),
    ).toBe(true);
  });
  it("flags overlapping audio clips", () => {
    const errs = validateTimeline(
      tl([
        {
          id: "a",
          kind: "audio",
          z: 0,
          clips: [
            { kind: "audio", media_ref: "m.mp3", timeline_in: 0, timeline_out: 30 },
            { kind: "audio", media_ref: "m.mp3", timeline_in: 15, timeline_out: 45 },
          ],
        },
      ]),
    );
    expect(errs.some((e) => e.includes("overlaps previous clip"))).toBe(true);
  });
});

describe("validateTimeline range + shape errors", () => {
  const track = (clips: Any[]): Any => ({ id: "v", kind: "video", z: 0, clips });
  it("flags individual media range violations", () => {
    expect(
      validateTimeline(
        tl([track([media({ source_in: -5, source_out: 60, timeline_in: 0, timeline_out: 60 })])]),
      ).some((e) => e.includes("source_in=")),
    ).toBe(true);
    expect(
      validateTimeline(tl([track([media({ source_in: 60, source_out: 30 })])])).some((e) =>
        e.includes("source_out"),
      ),
    ).toBe(true);
    expect(
      validateTimeline(
        tl([track([media({ timeline_in: 60, timeline_out: 30, source_in: 0, source_out: 30 })])]),
      ).some((e) => e.includes("must be > timeline_in")),
    ).toBe(true);
  });
  it("flags non-numeric coordinates and speed", () => {
    expect(
      validateTimeline(tl([track([media({ source_in: "abc" })])])).some((e) =>
        e.includes("must be a number or MM:SS"),
      ),
    ).toBe(true);
    expect(
      validateTimeline(tl([track([media({ speed: "fast" })])])).some((e) =>
        e.includes("speed must be a number"),
      ),
    ).toBe(true);
  });
  it("flags a negative and a non-numeric media timeline_in", () => {
    expect(
      validateTimeline(tl([track([media({ timeline_in: -5, timeline_out: 60 })])])).some(
        (e) => e.includes("timeline_in=") && e.includes(">= 0"),
      ),
    ).toBe(true);
    expect(
      validateTimeline(tl([track([media({ timeline_in: "abc" })])])).some((e) =>
        e.includes("timeline_in/timeline_out must be a number"),
      ),
    ).toBe(true);
  });
  it("flags non-numeric audio/text times", () => {
    expect(
      validateTimeline(
        tl([
          {
            id: "a",
            kind: "audio",
            z: 0,
            clips: [{ kind: "audio", media_ref: "m.mp3", timeline_in: "x", timeline_out: 5 }],
          },
        ]),
      ).some((e) => e.includes("audio clip needs numeric")),
    ).toBe(true);
    expect(
      validateTimeline(
        tl([
          {
            id: "t",
            kind: "text",
            z: 0,
            clips: [{ kind: "text", text: "y", timeline_in: "x", timeline_out: 5 }],
          },
        ]),
      ).some((e) => e.includes("text clip needs numeric")),
    ).toBe(true);
  });
  it("flags a non-object clip and non-list clips", () => {
    expect(
      validateTimeline(tl([track([null])]) as Any).some((e) => e.includes("must be an object")),
    ).toBe(true);
    expect(
      validateTimeline(tl([{ id: "v", kind: "video", z: 0, clips: "x" }]) as Any).some((e) =>
        e.includes("clips must be a list"),
      ),
    ).toBe(true);
  });
});
