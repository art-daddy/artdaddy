// Preview <-> export PARITY as a PROPERTY (fuzzed), complementing the fixed-example parity.test.ts
// (which pins 8 features to "both sides REACT") and the byte-identical corpus (fixed inputs). The whole
// point of the renderPlan IR is that a look the contract accepts is defined ONCE and both backends read
// it — so parity has to be challenged with RANDOM inputs, not just curated ones. Three properties:
//
//  P1 — the preview samples the animatable opacity/rotate curves from the PLAN curve at the PLAN's ONE
//       declared offset (pc.visibility.inSec), fuzzed over constant + keyframed curves, clip starts, and
//       sample times. This is the B2 sampling contract expressed as a reference formula: a regression
//       that changes the offset base, drops the clamp, or applies a spurious fade diverges from it.
//  P2 — every plan-resolved field the fixed parity test proved BOTH sides honour still makes BOTH the
//       render graph AND the preview draw-list react, for RANDOM in-range values (a field wired on only
//       one backend is caught for values the 8 fixed cases never tried).
//  P3 — the preview resolves `blend` from the plan's CLOSED union (never a raw contract-invalid string),
//       so a preview that bypassed the plan and read clip.blend directly is caught by any junk input.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { sampleAnim } from "../timeline/anim";
import { toSecondsView } from "../timeline/frames";
import type { Timeline } from "../timeline/model";
import { buildRenderCommand } from "../timeline/render";
import { BLEND_KINDS, resolveRenderPlan } from "../timeline/renderPlan";
import { type AssetDims, buildScene } from "./scene";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FPS = 30;
const DIMS = new Map<string, AssetDims>([["v.mp4", { w: 1920, h: 1080 }]]);

/** A frames-view, single-video-clip timeline carrying `extra` clip props. */
function tlWith(extra: Any, tin = 0, tout = 60): Timeline {
  return {
    units: "frames",
    canvas: { width: 1000, height: 1000, fps: FPS },
    tracks: [
      {
        id: "v",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "c",
            kind: "video",
            media_ref: "v.mp4",
            source_in: 0,
            source_out: tout - tin,
            timeline_in: tin,
            timeline_out: tout,
            ...extra,
          },
        ],
      },
    ],
  } as Timeline;
}
const previewLayer = (extra: Any, tSeconds = 0, tin = 0, tout = 60): Any =>
  buildScene(tlWith(extra, tin, tout), tSeconds, DIMS).layers[0];
const planClip = (extra: Any, tin = 0, tout = 60): Any =>
  resolveRenderPlan(toSecondsView(tlWith(extra, tin, tout))).clips[0];
const renderFC = (extra: Any): string => buildRenderCommand(tlWith(extra), "/o.mp4").filterComplex;

const BASE_RENDER = renderFC({});
const BASE_PREVIEW = JSON.stringify(previewLayer({}));
const renderReacts = (extra: Any): boolean => renderFC(extra) !== BASE_RENDER;
const previewReacts = (extra: Any): boolean => JSON.stringify(previewLayer(extra)) !== BASE_PREVIEW;

describe("preview <-> export parity (property-based)", () => {
  it("P1: the preview samples opacity & rotate from the PLAN curve at the PLAN's declared offset (B2, fuzzed)", () => {
    const kfs = <T>(v: fc.Arbitrary<T>) =>
      fc
        .uniqueArray(fc.record({ t: fc.integer({ min: 0, max: 90 }), v }), {
          selector: (k) => k.t,
          minLength: 1,
          maxLength: 4,
        })
        .map((ks) => [...ks].sort((a, b) => a.t - b.t));
    const OPACITY = fc.oneof(
      fc.double({ min: 0, max: 1, noNaN: true }),
      kfs(fc.double({ min: 0, max: 1.5, noNaN: true })),
    ); // >1 exercises the preview's clamp01
    const ROTATE = fc.oneof(
      fc.integer({ min: -180, max: 180 }),
      kfs(fc.integer({ min: -180, max: 180 })),
    );
    fc.assert(
      fc.property(
        OPACITY,
        ROTATE,
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 2, max: 90 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (opacity, rotate, tin, len, frac) => {
          const tout = tin + len;
          const tFrame = tin + Math.floor(frac * (len - 1)); // a frame strictly inside [tin, tout)
          const extra = { opacity, rotate };
          const pc = planClip(extra, tin, tout);
          // The reference formula: sample the PLAN curve at (globalTime - the plan's ONE declared offset),
          // clamp opacity to [0,1], no fade (none set). The preview must match this exactly.
          const relSec = tFrame / FPS - pc.visibility.inSec;
          const expectedOpacity = Math.max(0, Math.min(1, sampleAnim(pc.media.opacity, relSec, 1)));
          const expectedRotate = (sampleAnim(pc.media.rotate, relSec, 0) * Math.PI) / 180;
          const layer = previewLayer(extra, tFrame / FPS, tin, tout);
          expect(layer.opacity).toBeCloseTo(expectedOpacity, 9);
          expect(layer.rotate).toBeCloseTo(expectedRotate, 9);
        },
      ),
      { numRuns: 250 },
    );
  });

  it("P2: every plan-resolved field the fixed parity test proved is honoured by BOTH backends still reacts on both, for random values", () => {
    const field = fc.oneof(
      fc.record({ rotate: fc.integer({ min: 1, max: 359 }) }),
      fc.record({ opacity: fc.double({ min: 0, max: 0.95, noNaN: true }) }),
      fc.record({ crop: fc.record({ left: fc.double({ min: 0.05, max: 0.9, noNaN: true }) }) }),
      fc.record({
        transform: fc.record({ scale: fc.double({ min: 0.1, max: 0.9, noNaN: true }) }),
      }),
      fc.record({ blend: fc.constantFrom(...BLEND_KINDS.filter((b) => b !== "normal")) }),
      fc.record({
        color: fc.record({ brightness: fc.double({ min: 0.1, max: 0.9, noNaN: true }) }),
      }),
      fc.record({ color: fc.record({ exposure: fc.double({ min: 0.1, max: 0.9, noNaN: true }) }) }),
      fc.record({ fade: fc.record({ in: fc.integer({ min: 1, max: 20 }) }) }),
    );
    fc.assert(
      fc.property(field, (extra) => {
        expect(renderReacts(extra)).toBe(true);
        expect(previewReacts(extra)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("P3: the preview resolves blend from the plan's closed union, never a raw contract-invalid string", () => {
    fc.assert(
      fc.property(fc.string(), (b) => {
        const layer = previewLayer({ blend: b });
        expect(layer.blend).toBe(planClip({ blend: b }).media.blend); // preview reads the plan-coerced value
        expect(BLEND_KINDS as readonly string[]).toContain(layer.blend); // always in-union, never the junk input
      }),
      { numRuns: 200 },
    );
  });
});
