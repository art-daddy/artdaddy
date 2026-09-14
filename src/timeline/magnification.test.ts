import { describe, expect, it } from "vitest";

import { fitRects } from "../preview/scene";
import {
  clampClipMagnification,
  clipMagnification,
  fitScale,
  MAX_MAGNIFICATION,
  visibleSourcePx,
} from "./magnification";
import type { Clip } from "./model";

const CANVAS = { w: 1080, h: 1920 }; // the vertical canvas every short is cut to
const SD = { w: 854, h: 480 }; // the reported source: a 480p podcast download
const HD = { w: 1920, h: 1080 };
const UHD = { w: 3840, h: 2160 };

const clip = (transform?: Clip["transform"]): Clip =>
  ({ id: "c1", ...(transform ? { transform } : {}) }) as Clip;

describe("fitScale is the compositor's own fit factor", () => {
  // A guard that says "13.8x" while the picture is actually something else is worthless, so the
  // number MUST come from the same place the pixels do.
  it.each([
    ["cover", SD],
    ["contain", SD],
    ["cover", UHD],
    ["contain", UHD],
  ] as const)("agrees with fitRects for %s of %o", (fit, img) => {
    const box = { x: 0, y: 0, w: 1080 * 3.45, h: 1920 * 3.45 };
    const { dst, src } = fitRects(box, img, fit);
    const mine = fitScale(box, img, fit);
    // fitRects expresses the same factor two different ways depending on the branch.
    const theirs = fit === "cover" ? box.w / (src.w * img.w) : dst.w / img.w;
    expect(mine).toBeCloseTo(theirs, 6);
  });

  it("reports 1 rather than Infinity for a source with no dimensions", () => {
    // ffprobe exits 0 on an undecodable file and prints 0x0; a guard must not divide by it.
    expect(fitScale({ w: 1080, h: 1920 }, { w: 0, h: 0 }, "cover")).toBe(1);
  });
});

describe("clipMagnification", () => {
  it("counts the blow-up `fit: cover` already costs before anyone zooms", () => {
    // Filling a 9:16 canvas from a 16:9 source is a 4x blow-up at scale 1. That is the price of a
    // vertical reframe, not a mistake — the ceiling has to clear it.
    expect(clipMagnification(clip(), CANVAS, SD, "cover")).toBeCloseTo(4, 6);
    expect(clipMagnification(clip(), CANVAS, HD, "cover")).toBeCloseTo(1.7778, 3);
    expect(clipMagnification(clip(), CANVAS, UHD, "cover")).toBeCloseTo(0.8889, 3);
  });

  it("multiplies by scale — the reported clip magnified a 480p source 13.8x", () => {
    expect(clipMagnification(clip({ scale: 3.45 }), CANVAS, SD, "cover")).toBeCloseTo(13.8, 2);
    expect(visibleSourcePx(CANVAS, 13.8)).toEqual({ w: 78, h: 139 });
  });

  it("is far lower under `contain`, which letterboxes instead of filling", () => {
    expect(clipMagnification(clip(), CANVAS, SD, "contain")).toBeCloseTo(1.2646, 3);
  });

  it("takes the PEAK of an animated zoom, not its first keyframe", () => {
    const c = clip({
      scale: [
        { t: 0, v: 1 },
        { t: 100, v: 3.45 },
      ],
    });
    expect(clipMagnification(c, CANVAS, SD, "cover")).toBeCloseTo(13.8, 2);
  });
});

describe("clampClipMagnification", () => {
  it("bounds the reported edit: scale 3.45 on a 480p source becomes 1.5", () => {
    const c = clip({ position: { x: 0.38, y: 0.49 }, scale: 3.45 });
    const r = clampClipMagnification(c, CANVAS, SD, "cover");
    expect(r).toMatchObject({ clamped: true });
    expect(r!.requested).toBeCloseTo(13.8, 2);
    expect(r!.applied).toBeCloseTo(MAX_MAGNIFICATION, 6);
    expect(c.transform!.scale).toBeCloseTo(1.5, 6);
    // The framing the user chose is theirs; only the zoom was out of range.
    expect(c.transform!.position).toEqual({ x: 0.38, y: 0.49 });
  });

  // The failure direction that would hurt most: a ceiling that makes the app's commonest edit —
  // reframing landscape footage to vertical — impossible.
  it.each([
    ["480p", SD, 1.5],
    ["1080p", HD, 3.375],
    ["4K", UHD, 6.75],
  ] as const)(
    "leaves a plain vertical reframe of %s alone, and allows a real push-in",
    (_n, src, headroom) => {
      expect(clampClipMagnification(clip(), CANVAS, src, "cover")!.clamped).toBe(false);
      expect(clampClipMagnification(clip({ scale: 1.2 }), CANVAS, src, "cover")!.clamped).toBe(
        false,
      );
      // The zoom each source can carry differs — that is the point of measuring the SOURCE.
      const atLimit = clampClipMagnification(
        clip({ scale: headroom * 0.99 }),
        CANVAS,
        src,
        "cover",
      );
      expect(atLimit!.clamped).toBe(false);
    },
  );

  it("does not touch a big zoom the source can actually carry", () => {
    // scale 3 on 4K is still a DOWNSCALE — nothing is invented, so nothing is refused.
    const c = clip({ scale: 3 });
    expect(clampClipMagnification(c, CANVAS, UHD, "cover")!.clamped).toBe(false);
    expect(c.transform!.scale).toBe(3);
  });

  it("keeps an animation's shape — every keyframe moves by the same factor", () => {
    const c = clip({
      scale: [
        { t: 0, v: 3.85, ease: "ease-out" },
        { t: 242, v: 7.7, ease: "linear" },
      ],
    });
    const r = clampClipMagnification(c, CANVAS, SD, "cover");
    expect(r!.clamped).toBe(true);
    const kf = c.transform!.scale as Array<{ t: number; v: number; ease?: string }>;
    expect(kf[1].v / kf[0].v).toBeCloseTo(2, 6); // the zoom still doubles
    expect(kf[0].ease).toBe("ease-out"); // easing survives
    expect(clipMagnification(c, CANVAS, SD, "cover")).toBeCloseTo(MAX_MAGNIFICATION, 6);
  });

  it("shrinks the axis that falls back to `scale`, so the picture is not stretched", () => {
    // scale_y is absent, so the Y axis reads `scale`. Scaling only scale_x would squash the box.
    const c = clip({ scale_x: 8 });
    const r = clampClipMagnification(c, CANVAS, SD, "cover");
    expect(r!.clamped).toBe(true);
    const sx = c.transform!.scale_x as number;
    const sy = c.transform!.scale as number;
    expect(sx / sy).toBeCloseTo(8, 6); // the box keeps the aspect it was given
    expect(clipMagnification(c, CANVAS, SD, "cover")).toBeCloseTo(MAX_MAGNIFICATION, 6);
  });

  it("refuses to guess when the source size is unknown", () => {
    // A failed ffprobe is not evidence the media is small — blocking the edit would be worse.
    expect(clampClipMagnification(clip({ scale: 20 }), CANVAS, null, "cover")).toBeNull();
    expect(clampClipMagnification(clip({ scale: 20 }), CANVAS, { w: 0, h: 0 }, "cover")).toBeNull();
    const c = clip({ scale: 20 });
    clampClipMagnification(c, { w: 0, h: 0 }, SD, "cover");
    expect(c.transform!.scale).toBe(20);
  });

  // The agent's typed params arrive with every unset field as an explicit `null`, not omitted —
  // `{scale: 0.28, scale_x: null, scale_y: null}` is what set_clip_properties actually receives.
  // Hand-made fixtures with clean objects agree with any code that only checks `undefined`, and
  // this shape crashed all three scale scenarios in the live eval.
  describe("an unset track is null, not missing", () => {
    const nulls = { scale: 0.28, scale_x: null, scale_y: null } as unknown as Clip["transform"];

    it("reads null as 'not set' rather than throwing", () => {
      expect(clipMagnification(clip(nulls), CANVAS, SD, "contain")).toBeCloseTo(0.354, 3);
      const r = clampClipMagnification(clip(nulls), CANVAS, SD, "contain");
      expect(r).toMatchObject({ clamped: false });
    });

    it("still clamps, and does not leave a null axis behind at full size", () => {
      const c = clip({ scale: null, scale_x: 8, scale_y: null } as unknown as Clip["transform"]);
      const r = clampClipMagnification(c, CANVAS, SD, "cover");
      expect(r!.clamped).toBe(true);
      expect(clipMagnification(c, CANVAS, SD, "cover")).toBeCloseTo(MAX_MAGNIFICATION, 6);
      // scale_y was null, so the Y axis reads `scale` — which must now carry the shrink.
      expect(typeof c.transform!.scale).toBe("number");
      expect((c.transform!.scale_x as number) / (c.transform!.scale as number)).toBeCloseTo(8, 6);
    });

    it("a wholly-null transform is the identity, not a crash", () => {
      const c = clip({ scale: null, scale_x: null, scale_y: null } as unknown as Clip["transform"]);
      expect(clipMagnification(c, CANVAS, SD, "cover")).toBeCloseTo(4, 6);
      expect(clampClipMagnification(c, CANVAS, SD, "cover")!.clamped).toBe(false);
    });
  });
});
