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
    // `custom` is a raw ffmpeg filter string — there is nothing for WebGL to interpret. Known gap, art-daddy/backlog#23.
    ["custom ffmpeg filter", { effects: [{ type: "custom", params: { expr: "hflip" } }] }],
    // A .cube LUT needs the file loaded + a 3D texture; the preview has no asset path for it yet. Known gap,
    // art-daddy/backlog#23.
    ["3D LUT (.cube)", { color: { lut: "media_1.cube" } }],
    // Hub mismatch 2 (art-daddy/backlog#83): neither is in the preview's shader.
    ["colour wheels", { color: { shadowsHue: 210, shadowsAmount: 0.8 } }],
    ["vibrance", { color: { vibrance: 1.5 } }],
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

/** The text a title carries: its own `text`, unless `extra` gives it runs (a caption has only runs). */
const words = (extra: Any): Any => ("content" in extra ? extra : { text: "Parity", ...extra });

/** The preview's text layer for one title carrying `extra`, and the export's caption file for it. */
function previewText(extra: Any): Any {
  const t = {
    units: "frames",
    canvas: { width: 1000, height: 1000, fps: 30 },
    tracks: [
      {
        id: "t",
        kind: "text",
        z: 0,
        clips: [{ id: "c", kind: "text", timeline_in: 0, timeline_out: 60, ...words(extra) }],
      },
    ],
  } as Timeline;
  return buildScene(t, 0, DIMS).textLayers[0];
}
function renderAss(extra: Any): string {
  const t = {
    canvas: { width: 1920, height: 1080, fps: 30 },
    tracks: [
      {
        id: "t",
        kind: "text",
        z: 0,
        clips: [{ kind: "text", timeline_in: 0, timeline_out: 2, ...words(extra) }],
      },
    ],
  } as Timeline;
  return buildRenderCommand(t, "/o.mp4")
    .assFiles.map((f) => f.content)
    .join("\n");
}

// Hub mismatch 11 (art-daddy/backlog#83): text the export draws one way and the preview another.
// The pixels are in e2e/ui/parity.spec.ts (run-style, raw-ass); these say which side reacts.
describe("preview <-> render parity: text the preview draws in its base style (GAPS, row 11)", () => {
  const runs = (style?: Any) => ({
    content: [{ text: "only" }, { text: "this", ...(style ? { style } : {}) }, { text: "word" }],
  });
  const gaps: Array<[string, Any, Any]> = [
    ["raw_ass override", {}, { raw_ass: "{\\c&H2020FF&}Parity" }],
    ["a run in its own colour", runs(), runs({ color: "#FF2020" })],
  ];
  for (const [name, base, extra] of gaps) {
    it(`${name}: render reacts, and the preview still draws the text`, () => {
      expect(renderAss(extra)).not.toBe(renderAss(base));
      expect(previewText(extra)?.text, "the preview drew no text at all").toBeTruthy();
    });
    it.fails(`${name}: preview reacts (GAP: flip to it when preview gains it)`, () => {
      expect(JSON.stringify(previewText(extra))).not.toBe(JSON.stringify(previewText(base)));
    });
  }
});

// Hub mismatch 14 (art-daddy/backlog#83), account policy rather than a look: an export of an
// account that is not exempt carries the watermark and the end card (pixels:
// src/timeline/branding.smoke.e2e.ts); the preview never draws either.
describe("preview <-> render parity: branding (row 14)", () => {
  const branding = { watermark: "/brand/wm.png", endcard: "/brand/end.mp4", endcardDuration: 2 };

  it("the export opens the watermark and the end card for a branded account", () => {
    const seconds = {
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
            },
          ],
        },
      ],
    } as Timeline;
    const plan = buildRenderCommand(seconds, "/o.mp4", { branding });
    expect(plan.args).toContain("/brand/wm.png");
    expect(plan.args).toContain("/brand/end.mp4");
  });

  it.fails("row 14: the preview draws the watermark the export burns in", () => {
    const frames = {
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
            },
          ],
        },
      ],
    } as Timeline;
    const sources = buildScene(frames, 0, DIMS).layers.map((l) => l.source);
    expect(sources).toContain("/brand/wm.png");
  });
});
