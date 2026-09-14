import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import { compactClip, diffTimeline } from "./shape";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function tl(tracks: Any[]): Timeline {
  return { canvas: { width: 1080, height: 1920, fps: 30 }, tracks } as Any;
}
function clip(id: string, tin: number, tout: number, extra: Any = {}): Any {
  return {
    id,
    media_ref: `${id}.mp4`,
    kind: "video",
    timeline_in: tin,
    timeline_out: tout,
    source_in: 0,
    source_out: tout - tin,
    ...extra,
  };
}
function track(id: string, clips: Any[], z = 0): Any {
  return { id, kind: "video", z, clips };
}

describe("compactClip (fidelity)", () => {
  const SCALAR_DEFAULTS: Record<string, unknown> = {
    speed: 1,
    volume: 1,
    opacity: 1,
    rotate: 0,
    glow: 0,
    loop: false,
    stretch: false,
    blend: "normal",
  };
  const EMPTY_OBJ_KEYS = [
    "transform",
    "crop",
    "flip",
    "color",
    "style",
    "animation",
    "fade",
    "duck",
  ];
  const clipArb = fc.record(
    {
      id: fc.constant("c"),
      media_ref: fc.constant("a.mp4"),
      kind: fc.constant("video"),
      timeline_in: fc.nat(100),
      timeline_out: fc.integer({ min: 101, max: 200 }),
      source_in: fc.nat(50),
      source_out: fc.integer({ min: 51, max: 150 }),
      speed: fc.constantFrom(1, 2, 0.5),
      volume: fc.constantFrom(1, 0.5),
      opacity: fc.constantFrom(1, 0.8),
      rotate: fc.constantFrom(0, 90),
      glow: fc.constantFrom(0, 5),
      loop: fc.boolean(),
      stretch: fc.boolean(),
      blend: fc.constantFrom("normal", "screen"),
      transform: fc.constantFrom({}, { position: { x: 0.5, y: 0.5 } }),
      crop: fc.constantFrom({}, { left: 0.1 }),
      effects: fc.constantFrom([] as Any[], [{ type: "blur", params: { radius: 5 } }]),
    },
    { requiredKeys: ["id", "media_ref", "kind", "timeline_in", "timeline_out"] },
  );

  it("drops ONLY default-valued fields and never alters a retained value", () => {
    fc.assert(
      fc.property(clipArb, (c) => {
        const out = compactClip(c as Any) as Any;
        // every retained field is byte-identical to the input
        for (const k of Object.keys(out)) expect(out[k]).toEqual((c as Any)[k]);
        // every dropped field equalled its default (scalar, empty object, or empty effects)
        for (const k of Object.keys(c)) {
          if (k in out) continue;
          if (k in SCALAR_DEFAULTS) expect((c as Any)[k]).toEqual(SCALAR_DEFAULTS[k]);
          else if (EMPTY_OBJ_KEYS.includes(k)) expect((c as Any)[k]).toEqual({});
          else if (k === "effects") expect((c as Any)[k]).toEqual([]);
          else throw new Error(`compactClip dropped a non-default field: ${k}`);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("diffTimeline", () => {
  it("returns an empty delta when nothing changed", () => {
    const t = tl([track("v1", [clip("a", 0, 30)])]);
    expect(diffTimeline(t, tl([track("v1", [clip("a", 0, 30)])]))).toEqual({});
  });

  it("reports removed clip ids", () => {
    const before = tl([track("v1", [clip("a", 0, 30), clip("b", 30, 60)])]);
    const after = tl([track("v1", [clip("a", 0, 30)])]);
    const d = diffTimeline(before, after);
    expect(d.removed_ids).toEqual(["b"]);
    expect(d.clips).toBeUndefined();
    expect(d.shifted).toBeUndefined();
  });

  it("reports a new clip in `clips` with its track id", () => {
    const before = tl([track("v1", [])]);
    const after = tl([track("v1", [clip("a", 0, 30)])]);
    const d = diffTimeline(before, after);
    expect(d.clips).toHaveLength(1);
    expect([d.clips![0].id, d.clips![0].track]).toEqual(["a", "v1"]);
  });

  it("reports a property-only change as a resulting clip (defaults omitted)", () => {
    const before = tl([track("v1", [clip("a", 0, 30, { volume: 1 })])]);
    const after = tl([track("v1", [clip("a", 0, 30, { volume: 0.5, opacity: 1 })])]);
    const d = diffTimeline(before, after);
    expect(d.clips).toHaveLength(1);
    expect(d.clips![0].volume).toBe(0.5);
    expect(d.clips![0].opacity).toBeUndefined(); // default stripped by compactClip
    expect(d.shifted).toBeUndefined();
  });

  it("collapses a same-delta shift run of >= 3 into one `shifted` rule", () => {
    const before = tl([
      track("v1", [clip("a", 0, 30), clip("b", 30, 60), clip("c", 60, 90), clip("d", 90, 120)]),
    ]);
    const after = tl([track("v1", [clip("b", 0, 30), clip("c", 30, 60), clip("d", 60, 90)])]);
    const d = diffTimeline(before, after);
    expect(d.removed_ids).toEqual(["a"]);
    expect(d.shifted).toEqual([{ track: "v1", from_frame: 30, by: -30, count: 3 }]);
    expect(d.clips).toBeUndefined(); // all three collapsed into the rule
  });

  it("lists a shift run below the collapse threshold as individual clips", () => {
    const before = tl([track("v1", [clip("a", 0, 30), clip("b", 30, 60)])]);
    const after = tl([track("v1", [clip("b", 0, 30)])]);
    const d = diffTimeline(before, after);
    expect(d.removed_ids).toEqual(["a"]);
    expect(d.shifted).toBeUndefined();
    expect(d.clips!.map((c: Any) => c.id)).toEqual(["b"]);
    expect([d.clips![0].timeline_in, d.clips![0].timeline_out]).toEqual([0, 30]);
  });

  it("treats a clip that shifts AND changes a prop as a resulting clip, not a shift", () => {
    const before = tl([track("v1", [clip("a", 0, 30), clip("b", 30, 60, { volume: 1 })])]);
    const after = tl([track("v1", [clip("b", 0, 30, { volume: 0.5 })])]);
    const d = diffTimeline(before, after);
    expect(d.removed_ids).toEqual(["a"]);
    expect(d.shifted).toBeUndefined();
    expect(d.clips!.map((c: Any) => c.id)).toEqual(["b"]);
    expect(d.clips![0].volume).toBe(0.5);
  });

  it("reports created tracks", () => {
    const before = tl([track("v1", [])]);
    const after = tl([track("v1", []), track("v2", [], 1)]);
    expect(diffTimeline(before, after).created_tracks).toEqual(["v2"]);
  });

  it("orders clips deterministically across tracks", () => {
    const before = tl([track("v2", [clip("x", 0, 30)], 1), track("v1", [clip("y", 0, 30)])]);
    const after = tl([track("v2", [clip("x", 10, 40)], 1), track("v1", [clip("y", 10, 40)])]);
    const d = diffTimeline(before, after);
    // both are single-clip shifts (< 3) -> listed as clips, sorted by track id
    expect(d.clips!.map((c: Any) => c.track)).toEqual(["v1", "v2"]);
  });

  it("caps the clips list and notes the remainder", () => {
    const base = Array.from({ length: 35 }, (_, i) => clip(`c${i}`, i * 10, i * 10 + 5));
    const before = tl([
      track(
        "v1",
        base.map((c) => ({ ...c, volume: 1 })),
      ),
    ]);
    const after = tl([
      track(
        "v1",
        base.map((c) => ({ ...c, volume: 0.5 })),
      ),
    ]);
    const d = diffTimeline(before, after);
    expect(d.clips).toHaveLength(30);
    expect(d.clips_note).toContain("30 of 35");
  });
});
