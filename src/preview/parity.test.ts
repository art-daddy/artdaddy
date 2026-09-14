// preview <-> render FEATURE PARITY. The mp4 renderer (render.ts) is the source
// of truth; the live preview (scene.ts draw-list) supports a SUBSET. This test
// pins which per-clip features each side reacts to, so parity can't silently
// regress and the known gaps are documented. A gap is written as `it.fails`:
// today the preview does NOT react, so the "preview reacts" assertion fails and
// the test passes. The day preview gains the feature, the assertion passes,
// `it.fails` goes RED, and you flip it to a plain `it` — a self-closing TODO.
import { describe, expect, it } from "vitest";

import type { Timeline } from "../timeline/model";
import { buildRenderCommand } from "../timeline/render";
import { type AssetDims, buildScene } from "./scene";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const DIMS = new Map<string, AssetDims>([["v.mp4", { w: 1920, h: 1080 }]]);

/** The preview draw-layer for a single video clip carrying `extra` props. */
function previewLayer(extra: Any): Any {
  const t = {
    units: "frames",
    canvas: { width: 1000, height: 1000, fps: 30 },
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
            source_out: 60,
            timeline_in: 0,
            timeline_out: 60,
            ...extra,
          },
        ],
      },
    ],
  } as Timeline;
  return buildScene(t, 0, DIMS).layers[0];
}
/** The render filter_complex for the same clip (seconds view). */
function renderFC(extra: Any): string {
  const t = {
    canvas: { width: 1920, height: 1080, fps: 30 },
    tracks: [
      {
        id: "v",
        kind: "video",
        z: 0,
        clips: [
          {
            media_ref: "/v.mp4",
            kind: "video",
            source_in: 0,
            source_out: 2,
            timeline_in: 0,
            timeline_out: 2,
            ...extra,
          },
        ],
      },
    ],
  } as Timeline;
  return buildRenderCommand(t, "/o.mp4").filterComplex;
}

const BASE_RENDER = renderFC({});
const BASE_PREVIEW = JSON.stringify(previewLayer({}));
const renderReacts = (extra: Any): boolean => renderFC(extra) !== BASE_RENDER;
const previewReacts = (extra: Any): boolean => JSON.stringify(previewLayer(extra)) !== BASE_PREVIEW;

describe("preview <-> render parity: features BOTH sides honour", () => {
  const both: Array<[string, Any]> = [
    ["rotate", { rotate: 90 }],
    ["opacity", { opacity: 0.5 }],
    ["crop", { crop: { left: 0.2 } }],
    ["transform (scale)", { transform: { scale: 0.5 } }],
    ["blend mode", { blend: "screen" }],
    ["color grade primaries", { color: { brightness: 0.3, contrast: 1.2 } }],
    ["color exposure", { color: { exposure: 0.5 } }],
    ["fade (visual)", { fade: { in: 15 } }],
    ["per-clip effects (blur)", { effects: [{ type: "blur", params: { radius: 5 } }] }],
    ["glow / bloom", { glow: 5 }],
    [
      "tone curves",
      {
        color: {
          masterCurve: [
            [0, 0.05],
            [1, 0.95],
          ],
        },
      },
    ],
  ];
  for (const [name, extra] of both) {
    it(`${name}: render + preview both react`, () => {
      expect(renderReacts(extra)).toBe(true);
      expect(previewReacts(extra)).toBe(true);
    });
  }
});

describe("preview <-> render parity: render-only features (preview GAPS)", () => {
  const gaps: Array<[string, Any]> = [
    // `custom` is a raw ffmpeg filter string — there is nothing for WebGL to interpret.
    ["custom ffmpeg filter", { effects: [{ type: "custom", params: { expr: "hflip" } }] }],
    // A .cube LUT needs the file loaded + a 3D texture; the preview has no asset path for it yet.
    ["3D LUT (.cube)", { color: { lut: "media_1.cube" } }],
  ];
  for (const [name, extra] of gaps) {
    it(`${name}: render reacts`, () => {
      expect(renderReacts(extra)).toBe(true);
    });
    // GAP: preview does NOT react yet. When it does, this goes red -> flip to `it`.
    it.fails(`${name}: preview reacts (GAP \u2014 flip to it when preview gains it)`, () => {
      expect(previewReacts(extra)).toBe(true);
    });
  }
});

describe("preview <-> render parity: APPROXIMATED (both react, pixels differ by design)", () => {
  // ffmpeg `tmix` averages N PREVIOUS frames and `hqdn3d` is a spatial+temporal
  // denoise; a stateless per-draw shader can reproduce neither, so the preview shows
  // a directional smear / mild softening instead. Both sides must still REACT — a
  // silent no-op is what this whole ledger exists to catch.
  const approx: Array<[string, Any]> = [
    ["motion blur", { effects: [{ type: "motion", params: { frames: 8 } }] }],
    ["denoise", { effects: [{ type: "denoise", params: { strength: 12 } }] }],
  ];
  for (const [name, extra] of approx) {
    it(`${name}: render + preview both react`, () => {
      expect(renderReacts(extra)).toBe(true);
      expect(previewReacts(extra)).toBe(true);
    });
  }
});
