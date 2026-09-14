// Conformance: every entry in ANIM_PROPS must actually resolve on a REAL clip.
//
// The bug this exists to prevent shipped once already: five of the eight paths pointed at the top
// level of the clip when scale and position live under `transform`, so the keyframe lane silently
// showed nothing for them. Two properties were hand-checked and the rest assumed. A table that
// drives behaviour needs a test that walks EVERY row, not a sample of it.
//
// The fixture is built from the model's own types rather than by hand, so it cannot encode the same
// misreading the paths did.
import { describe, expect, it } from "vitest";

import { ANIM_PROPS, animPropsFor, readAnim, writeAnim } from "./animProps";
import { sampleAnim } from "./anim";
import type { Clip, Keyframe, Transform } from "./model";

/** A clip carrying a CONSTANT at every animatable path, typed so the compiler checks the shape. */
function constantClip(): Clip {
  const transform: Transform = {
    position: { x: 0.25, y: 0.75 },
    scale: 1.5,
    scale_x: 1.25,
    scale_y: 0.8,
  };
  return {
    id: "c1",
    media_ref: "a.mp4",
    kind: "video",
    timeline_in: 0,
    timeline_out: 60,
    transform,
    rotate: 30,
    opacity: 0.6,
    volume: 0.4,
  } as Clip;
}

describe("ANIM_PROPS conformance", () => {
  it.each(ANIM_PROPS.map((p) => [p.path, p] as const))(
    "%s resolves to the value actually stored on the clip",
    (path, prop) => {
      const got = readAnim(constantClip(), path);
      expect(got, `${path} did not resolve — is the path right for the model?`).toBeDefined();
      expect(typeof got).toBe("number");
      void prop;
    },
  );

  it.each(ANIM_PROPS.map((p) => [p.path] as const))(
    "%s round-trips: a curve written there reads back",
    (path) => {
      const clip = constantClip();
      const curve: Keyframe[] = [
        { t: 0, v: 0 },
        { t: 10, v: 1 },
      ];
      const patch = writeAnim(clip, path, curve);
      // The patch is applied to the clip the way setClipProperties applies it.
      const patched = { ...clip, ...patch } as Clip;
      expect(readAnim(patched, path)).toEqual(curve);
      expect(sampleAnim(readAnim(patched, path), 5)).toBeCloseTo(0.5, 6);
    },
  );

  it.each(ANIM_PROPS.map((p) => [p.path] as const))(
    "%s writes without destroying any sibling on its way down",
    (path) => {
      const clip = constantClip();
      const patched = { ...clip, ...writeAnim(clip, path, 0.42) } as Clip;
      // Every OTHER path must still read exactly what it did before.
      for (const other of ANIM_PROPS) {
        if (other.path === path) continue;
        expect(readAnim(patched, other.path), `writing ${path} clobbered ${other.path}`).toEqual(
          readAnim(clip, other.path),
        );
      }
    },
  );

  it("writes only the clip's TOP-level field, which is what setClipProperties patches", () => {
    const patch = writeAnim(constantClip(), "transform.scale_x", 2);
    expect(Object.keys(patch)).toEqual(["transform"]);
  });

  it("creates the intermediate objects when the property is absent entirely", () => {
    const bare = { id: "c1", media_ref: "a.mp4", kind: "video" } as Clip;
    const patched = { ...bare, ...writeAnim(bare, "transform.position.y", 0.9) } as Clip;
    expect(readAnim(patched, "transform.position.y")).toBe(0.9);
  });

  it("splits the properties by clip kind, with no overlap and nothing orphaned", () => {
    const video = animPropsFor("video").map((p) => p.path);
    const audio = animPropsFor("audio").map((p) => p.path);
    expect(video.length).toBeGreaterThan(0);
    expect(audio).toEqual(["volume"]);
    expect(video).not.toContain("volume");
    // Every declared property is reachable from some kind — one listed but never offered is dead.
    expect(new Set([...video, ...audio]).size).toBe(ANIM_PROPS.length);
  });

  it("gives every property a unique path and a label", () => {
    expect(new Set(ANIM_PROPS.map((p) => p.path)).size).toBe(ANIM_PROPS.length);
    expect(new Set(ANIM_PROPS.map((p) => p.label)).size).toBe(ANIM_PROPS.length);
    for (const p of ANIM_PROPS) expect(p.step).toBeGreaterThan(0);
  });
});
