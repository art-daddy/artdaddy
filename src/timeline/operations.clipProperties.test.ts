// Clip properties as the agent's set_clip_properties writes them (and the Inspector, which goes the same
// way): volume and fades that must reach the clip's own sound, speed changes that keep the footage and
// the sound in step, lengths, replacing a clip's source, and the zoom limit. Mutation testing (26 Nov)
// found this operation's lines all run while about a third of its planted bugs went unnoticed. Each
// case is what a person would see or hear afterwards.
import { describe, expect, it } from "vitest";

import { findClip } from "./helpers";
import type { Timeline } from "./model";
import { setClipProperties, type ClipPropertyPlan, type SwapMedia } from "./operations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const vid = (id: string, tin: number, tout: number, sin = 0, over: Any = {}): Any => {
  const speed = over.speed ?? 1;
  return {
    id,
    kind: "video",
    media_ref: `${id}.mp4`,
    timeline_in: tin,
    timeline_out: tout,
    source_in: sin,
    source_out: sin + Math.round((tout - tin) * speed),
    ...over,
  };
};
const track = (id: string, kind: string, clips: Any[], over: Any = {}): Any => ({
  id,
  kind,
  z: 0,
  clips,
  ...over,
});
const tl = (...tracks: Any[]): Timeline =>
  ({ units: "frames", canvas: { width: 1920, height: 1080, fps: 30 }, tracks }) as Timeline;

const NO_LIMIT = new Map<string, number | null>();
const clipOf = (t: Timeline, id: string): Any => {
  const found = findClip(t, id);
  if (!found) throw new Error(`no clip ${id}`);
  return found[1];
};
const at = (t: Timeline, id: string): [number, number] => {
  const c = clipOf(t, id);
  return [c.timeline_in, c.timeline_out];
};
const footage = (t: Timeline, id: string): [number, number] => {
  const c = clipOf(t, id);
  return [c.source_in, c.source_out];
};

/** What the tool resolves from its arguments; only the parts a case sets differ from "nothing". */
const plan = (over: Partial<ClipPropertyPlan>): ClipPropertyPlan => ({
  props: {},
  durationRaw: null,
  window: {},
  namesEdge: false,
  speedChanged: false,
  explicitLen: false,
  ...over,
});

/** A picture `v` at [30, 90), its own sound `s` linked to it, a second picture `w` in the same link
 *  group, and an unrelated sound `bg` beside `s` on the audio track. */
function linked(over: Any = {}): Timeline {
  return tl(
    track("v1", "video", [vid("v", 30, 90, 100, { link_group: "g", ...over })]),
    track("v2", "video", [vid("w", 30, 90, 100, { media_ref: "w.mp4", link_group: "g" })]),
    track("a1", "audio", [
      vid("s", 30, 90, 100, {
        kind: "audio",
        media_ref: "v.mp4",
        link_group: "g",
        volume: 0.8,
        fade: { in: 3, out: 3 },
        ...over,
      }),
      vid("bg", 90, 150, 0, { kind: "audio", media_ref: "bg.mp3" }),
    ]),
  );
}

describe("volume and fades set on a picture reach its own sound", () => {
  // The renderer reads volume and fades on AUDIO clips only, so set on the picture alone they would do
  // nothing a person can hear.
  it("a volume set on the picture is the volume of its sound, and leaves its fades alone", () => {
    const t = linked();
    setClipProperties(t, ["v"], plan({ props: { volume: 0.5 } }), NO_LIMIT);
    expect(clipOf(t, "s").volume).toBe(0.5);
    expect(clipOf(t, "s").fade).toEqual({ in: 3, out: 3 });
    expect(clipOf(t, "w").volume).toBeUndefined(); // a linked PICTURE has no sound of its own
  });

  it("a fade set on the picture is the fade of its sound, and leaves its volume alone", () => {
    const t = linked();
    setClipProperties(t, ["v"], plan({ props: { fade: { in: 10, out: 5 } } }), NO_LIMIT);
    expect(clipOf(t, "s").fade).toEqual({ in: 10, out: 5 });
    expect(clipOf(t, "s").volume).toBe(0.8);
    expect(clipOf(t, "w").fade).toBeUndefined();
  });

  it("clearing them on the picture clears them on the sound", () => {
    const t = linked();
    setClipProperties(t, ["v"], plan({ props: { volume: null, fade: null } }), NO_LIMIT);
    expect("volume" in clipOf(t, "s")).toBe(false);
    expect("fade" in clipOf(t, "s")).toBe(false);
  });
});

describe("speed", () => {
  it("2x plays the same footage in half the frames, and the clip's sound speeds up with it", () => {
    const t = linked();
    setClipProperties(t, ["v"], plan({ props: { speed: 2 }, speedChanged: true }), NO_LIMIT);
    expect(at(t, "v")).toEqual([30, 60]);
    expect(footage(t, "v")).toEqual([100, 160]);
    expect(clipOf(t, "s").speed).toBe(2);
    expect(at(t, "s")).toEqual([30, 60]);
    expect(at(t, "bg")).toEqual([90, 150]);
  });
});

describe("length", () => {
  it("a new duration plays more of the footage from the same first frame, and the sound follows", () => {
    const t = linked();
    setClipProperties(
      t,
      ["v"],
      plan({ durationRaw: 30, explicitLen: true, window: { duration: 30 } }),
      NO_LIMIT,
    );
    expect(at(t, "v")).toEqual([30, 60]);
    expect(footage(t, "v")).toEqual([100, 130]);
    expect(at(t, "s")).toEqual([30, 60]);
    expect(footage(t, "s")).toEqual([100, 130]);
  });

  it("at 2x a new duration plays twice as many source frames", () => {
    const t = tl(track("v1", "video", [vid("v", 30, 90, 100, { speed: 2 })]));
    setClipProperties(
      t,
      ["v"],
      plan({ durationRaw: 30, explicitLen: true, window: { duration: 30 } }),
      NO_LIMIT,
    );
    expect(at(t, "v")).toEqual([30, 60]);
    expect(footage(t, "v")).toEqual([100, 160]);
  });

  it("a source in-point alone slips the footage: same place, same length", () => {
    const t = tl(track("v1", "video", [vid("v", 30, 90, 100)]));
    setClipProperties(t, ["v"], plan({ window: { sourceIn: 120 }, namesEdge: true }), NO_LIMIT);
    expect(at(t, "v")).toEqual([30, 90]);
    expect(footage(t, "v")).toEqual([120, 180]);
  });

  it.each([["loop"], ["stretch"]])(
    "a %s clip is simply resized: it fills the new length from the same footage",
    (mode) => {
      const bed = vid("bed", 0, 90, 0, { kind: "audio", media_ref: "bed.mp3", [mode]: true });
      const t = tl(track("a1", "audio", [bed]));
      setClipProperties(
        t,
        ["bed"],
        plan({ durationRaw: 300, explicitLen: true, window: { duration: 300 } }),
        NO_LIMIT,
      );
      expect(at(t, "bed")).toEqual([0, 300]);
      expect(footage(t, "bed")).toEqual([0, 90]);
    },
  );

  it("says how many clips it changed", () => {
    const t = tl(track("v1", "video", [vid("a", 0, 60), vid("b", 60, 120)]));
    expect(setClipProperties(t, ["a", "b"], plan({ props: { opacity: 0.5 } }), NO_LIMIT)).toEqual({
      updated: 2,
    });
  });
});

describe("replacing a clip's source", () => {
  const swap = (over: Partial<SwapMedia>): ClipPropertyPlan =>
    plan({ media: { ref: "new.mp4", kind: "video", totalFrames: null, hasAudio: true, ...over } });

  it("a longer replacement keeps the slot and plays from its first frame; the sound follows", () => {
    const t = linked();
    setClipProperties(t, ["v"], swap({ totalFrames: 300 }), NO_LIMIT);
    expect(at(t, "v")).toEqual([30, 90]);
    expect(footage(t, "v")).toEqual([0, 60]);
    expect(clipOf(t, "v").media_ref).toBe("new.mp4");
    const s = clipOf(t, "s");
    expect([s.media_ref, s.timeline_in, s.timeline_out, s.source_in, s.source_out]).toEqual([
      "new.mp4",
      30,
      90,
      0,
      60,
    ]);
    expect(clipOf(t, "w").media_ref).toBe("w.mp4"); // a linked picture is not the clip's sound
  });

  it("at 2x the slot holds twice as many source frames", () => {
    const t = tl(track("v1", "video", [vid("v", 30, 90, 100, { speed: 2 })]));
    const r = setClipProperties(t, ["v"], swap({ totalFrames: 200 }), NO_LIMIT);
    expect(at(t, "v")).toEqual([30, 90]);
    expect(footage(t, "v")).toEqual([0, 120]);
    expect(r.notes).toBeUndefined();
  });

  it("a replacement exactly as long as the slot fits without a word", () => {
    const t = tl(track("v1", "video", [vid("v", 30, 90, 100)]));
    const r = setClipProperties(t, ["v"], swap({ totalFrames: 60 }), NO_LIMIT);
    expect(at(t, "v")).toEqual([30, 90]);
    expect(r.notes).toBeUndefined();
  });

  it("a shorter replacement shortens the clip, and says by how much", () => {
    const t = tl(track("v1", "video", [vid("v", 30, 90, 100, { speed: 2 })]));
    const r = setClipProperties(t, ["v"], swap({ totalFrames: 80 }), NO_LIMIT);
    expect(at(t, "v")).toEqual([30, 70]);
    expect(footage(t, "v")).toEqual([0, 80]);
    expect(String(r.notes)).toMatch(/now 40 frames \(it was 60\)/);
  });

  it.each([
    ["a still", "image", "image"],
    ["an animation", "lottie", undefined],
  ])(
    "replacing it with %s drops the source window a still cannot have",
    (_what, kind, clipKind) => {
      const t = tl(track("v1", "video", [vid("v", 30, 90, 100)]));
      setClipProperties(
        t,
        ["v"],
        swap({ kind: kind as SwapMedia["kind"], ref: "p.png" }),
        NO_LIMIT,
      );
      const v = clipOf(t, "v");
      expect(v.kind).toBe(clipKind);
      expect("source_in" in v).toBe(false);
      expect("source_out" in v).toBe(false);
      expect(at(t, "v")).toEqual([30, 90]);
    },
  );

  it("replacing a sound with another sound keeps it a sound clip", () => {
    const t = tl(track("a1", "audio", [vid("s", 0, 60, 0, { kind: "audio", media_ref: "s.mp3" })]));
    setClipProperties(t, ["s"], swap({ kind: "audio", ref: "t.mp3" }), NO_LIMIT);
    expect(clipOf(t, "s").kind).toBe("audio");
    expect(footage(t, "s")).toEqual([0, 60]);
  });

  it("a replacement with no sound removes the clip's own sound and nothing else, and says so", () => {
    const t = linked();
    const r = setClipProperties(t, ["v"], swap({ hasAudio: false, totalFrames: 300 }), NO_LIMIT);
    expect(findClip(t, "s")).toBeNull();
    expect(at(t, "bg")).toEqual([90, 150]);
    expect(clipOf(t, "w").media_ref).toBe("w.mp4");
    expect(String(r.notes)).toMatch(/has no audio/);
  });
});

describe("the zoom limit", () => {
  // A 320x180 source covering a 1920x1080 canvas is magnified 6x already (the limit), so any scale
  // above 1, on either axis, asks for more than the source can show.
  const small = new Map([["v", { w: 320, h: 180 }]]);
  const zoomed = (transform: Any) =>
    tl(track("v1", "video", [vid("v", 0, 60, 0, { transform, fit: "cover" })]));

  it.each([["scale"], ["scale_x"], ["scale_y"]])(
    "a %s that magnifies past the limit is brought back, and the agent is told",
    (key) => {
      const t = zoomed({});
      const r = setClipProperties(
        t,
        ["v"],
        plan({ props: { transform: { [key]: 3 } } }),
        NO_LIMIT,
        small,
      );
      expect(clipOf(t, "v").transform[key]).toBeLessThan(3);
      expect(String(r.notes)).toMatch(/zoom reduced/);
    },
  );

  it("a change to anything else leaves a clip's zoom as it was", () => {
    const t = zoomed({ scale: 3 });
    const r = setClipProperties(t, ["v"], plan({ props: { opacity: 0.5 } }), NO_LIMIT, small);
    expect(clipOf(t, "v").transform.scale).toBe(3);
    expect(r.notes).toBeUndefined();
  });
});
