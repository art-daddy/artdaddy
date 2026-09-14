import { describe, expect, it } from "vitest";

import type { Timeline } from "../timeline/model";
import { type AssetDims, buildScene, clipRects, fitRects, textLayerToImageLayer } from "./scene";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function tl(clips: Any[], canvas = { width: 1000, height: 1000, fps: 30 }): Timeline {
  return { units: "frames", canvas, tracks: [{ id: "v", kind: "video", z: 0, clips }] } as Timeline;
}
const dims = (m: Record<string, AssetDims>): Map<string, AssetDims> => new Map(Object.entries(m));

describe("buildScene (golden draw-list)", () => {
  it("snapshots the composited scene for a multi-feature clip", () => {
    const scene = buildScene(
      tl([
        {
          id: "v",
          kind: "video",
          media_ref: "v.mp4",
          source_in: 0,
          source_out: 60,
          timeline_in: 0,
          timeline_out: 60,
          transform: { position: { x: 0.6, y: 0.4 }, scale: 0.5 },
          opacity: 0.8,
          rotate: 15,
          crop: { left: 0.1 },
          color: { brightness: 0.2 },
        },
      ]),
      1,
      dims({ "v.mp4": { w: 1920, h: 1080 } }),
    );
    expect(scene).toMatchSnapshot();
  });

  it("reads flip from the shared plan and negates the correct src axis", () => {
    // buildScene must consume the plan's strict-boolean flip (pc.media.flip), not re-coerce clip.flip; a
    // broken wiring or an h<->v swap flips the wrong axis. hflip -> negative src width; vflip -> height.
    const clip = (flip: Record<string, boolean>) => ({
      id: "v",
      kind: "video",
      media_ref: "v.mp4",
      source_in: 0,
      source_out: 60,
      timeline_in: 0,
      timeline_out: 60,
      flip,
    });
    const hs = buildScene(tl([clip({ h: true })]), 1, dims({ "v.mp4": { w: 100, h: 100 } }));
    expect(hs.layers[0].src.w).toBeLessThan(0);
    expect(hs.layers[0].src.h).toBeGreaterThan(0);
    const vs = buildScene(tl([clip({ v: true })]), 1, dims({ "v.mp4": { w: 100, h: 100 } }));
    expect(vs.layers[0].src.h).toBeLessThan(0);
    expect(vs.layers[0].src.w).toBeGreaterThan(0);
  });

  it("applies the visual fade envelope to a media clip's opacity, clip-relative over its own length", () => {
    // A 2s clip STARTING at 1s (frame 30) with a 1s fade-in and a 1s fade-out. The preview multiplies the
    // plan-sampled opacity by fadeMul(tFrame - tin, tout - tin, in, out), so the envelope is CLIP-RELATIVE
    // (tFrame - tin) over the clip's OWN length (tout - tin) — not absolute. The non-zero start makes both
    // arithmetic terms observable: a `tFrame + tin` or `tout + tin` mutation shifts the ramp and misreads
    // these samples. (opacity is unset -> plan sample 1, so layer.opacity == the fade envelope itself.)
    const clip = {
      id: "v",
      kind: "video",
      media_ref: "v.mp4",
      source_in: 0,
      source_out: 60,
      timeline_in: 30,
      timeline_out: 90,
      fade: { in: 30, out: 30 },
    };
    const op = (sec: number) =>
      buildScene(tl([clip]), sec, dims({ "v.mp4": { w: 100, h: 100 } })).layers[0].opacity;
    expect(op(1.0)).toBeCloseTo(0, 6); // clip start -> fade-in t=0
    expect(op(1.5)).toBeCloseTo(0.5, 6); // halfway up the 1s fade-in
    expect(op(2.0)).toBeCloseTo(1, 6); // fully in, between the ramps
    expect(op(2.5)).toBeCloseTo(0.5, 6); // halfway down the 1s fade-out (pins tout - tin)
  });
});

describe("text layers", () => {
  it("emits a text layer for an active text clip, honouring style", () => {
    const t = tl([
      {
        id: "t",
        kind: "text",
        text: "Hello",
        timeline_in: 0,
        timeline_out: 30,
        style: { size: 80, color: "#ff0000", align: "left" },
      },
    ]);
    const layer = buildScene(t, 0, dims({})).textLayers[0];
    expect(layer.kind).toBe("text");
    expect(layer.text).toBe("Hello");
    expect(layer.fontPx).toBe(80);
    expect(layer.color).toBe("#ff0000");
    expect(layer.align).toBe("left");
  });

  it("skips empty text and inactive text clips", () => {
    expect(
      buildScene(
        tl([{ id: "t", kind: "text", text: "", timeline_in: 0, timeline_out: 30 }]),
        0,
        dims({}),
      ).textLayers,
    ).toHaveLength(0);
    expect(
      buildScene(
        tl([{ id: "t", kind: "text", text: "hi", timeline_in: 60, timeline_out: 90 }]),
        0,
        dims({}),
      ).textLayers,
    ).toHaveLength(0);
  });

  it("reads string/array content and applies the shared plan defaults", () => {
    // A string content passes through; a content ARRAY joins with a SPACE (the exporter's join — words
    // must not concatenate), NOT the empty string, so preview + export read ONE identical caption string.
    expect(
      buildScene(
        tl([{ id: "t", kind: "text", content: "Cap", timeline_in: 0, timeline_out: 30 }]),
        0,
        dims({}),
      ).textLayers[0].text,
    ).toBe("Cap");
    expect(
      buildScene(
        tl([
          {
            id: "t",
            kind: "text",
            content: [{ text: "a" }, { text: "b" }],
            timeline_in: 0,
            timeline_out: 30,
          },
        ]),
        0,
        dims({}),
      ).textLayers[0].text,
    ).toBe("a b");
    // Unified defaults come from the shared plan (resolveText): white, centre, and the concrete bundled
    // family Poppins — NOT "sans-serif", which libass can't resolve without fontconfig at export.
    const def = buildScene(
      tl([{ id: "t", kind: "text", text: "x", timeline_in: 0, timeline_out: 30 }]),
      0,
      dims({}),
    ).textLayers[0];
    expect([def.color, def.align, def.font]).toEqual(["white", "center", "Poppins"]);
  });

  it("textLayerToImageLayer maps a text layer to an image draw layer", () => {
    const layer = buildScene(
      tl([{ id: "t", kind: "text", text: "Hi", timeline_in: 0, timeline_out: 30 }]),
      0,
      dims({}),
    ).textLayers[0];
    const img = textLayerToImageLayer(layer, "text:xyz");
    expect(img.kind).toBe("image");
    expect(img.source).toBe("text:xyz");
    expect(img.src).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(img.dst).toEqual(layer.box);
  });

  it("carries bold / italic / letter-spacing + the cased text into the layer (3A-1)", () => {
    const l = buildScene(
      tl([
        {
          id: "t",
          kind: "text",
          text: "hi",
          timeline_in: 0,
          timeline_out: 30,
          style: { bold: true, italic: true, spacing: 5, case: "upper" },
        },
      ]),
      0,
      dims({}),
    ).textLayers[0];
    expect(l.bold).toBe(true);
    expect(l.italic).toBe(true);
    expect(l.letterSpacingPx).toBe(5);
    expect(l.text).toBe("HI"); // case from the shared plan, so preview + export draw the same string
  });

  it("carries outline / shadow / box into the text layer, box winning over outline (3A-2)", () => {
    const l = buildScene(
      tl([
        {
          id: "t",
          kind: "text",
          text: "x",
          timeline_in: 0,
          timeline_out: 30,
          style: {
            outline: { color: "#ff0000", width: 3 },
            shadow: { color: "#000000", depth: 2 },
          },
        },
      ]),
      0,
      dims({}),
    ).textLayers[0];
    expect(l.outline).toEqual({ widthPx: 3, color: "#ff0000" });
    expect(l.shadow).toEqual({ depthPx: 2, color: "#000000" });
    const b = buildScene(
      tl([
        {
          id: "t",
          kind: "text",
          text: "x",
          timeline_in: 0,
          timeline_out: 30,
          style: {
            outline: { color: "#fff", width: 4 },
            box: { color: "#0000ff", opacity: 0.5, padding: 8 },
          },
        },
      ]),
      0,
      dims({}),
    ).textLayers[0];
    expect(b.bgBox).toEqual({ color: "#0000ff", opacity: 0.5, paddingPx: 8 });
    expect(b.outline).toBeNull();
  });

  it("draws only the phrase-chunk active at the current frame (Fix #3B)", () => {
    const t = tl([
      {
        id: "t",
        kind: "text",
        content: [
          { text: "first", t_in: 0, t_out: 1 },
          { text: "second", t_in: 1, t_out: 2 },
        ],
        timeline_in: 0,
        timeline_out: 60, // frames -> 2s
        animation: { build: "phrase-chunks", timing: "explicit" },
      },
    ]);
    expect(buildScene(t, 0.5, dims({})).textLayers[0].text).toBe("first"); // 0.5s -> chunk 1
    expect(buildScene(t, 1.5, dims({})).textLayers[0].text).toBe("second"); // 1.5s -> chunk 2
  });

  it("ramps opacity over an entrance fade window (Fix #3B)", () => {
    const t = tl([
      {
        id: "t",
        kind: "text",
        text: "hi",
        timeline_in: 0,
        timeline_out: 60,
        animation: { entrance: "fade", entrance_ms: 1000 },
      },
    ]);
    expect(buildScene(t, 0.5, dims({})).textLayers[0].opacity).toBeCloseTo(0.5, 1); // halfway through a 1s fade-in
    expect(buildScene(t, 1.5, dims({})).textLayers[0].opacity).toBe(1); // fully faded in
  });

  it("applies emphasis to the active hero chunk in the preview (Fix #3B)", () => {
    const t = tl([
      {
        id: "t",
        kind: "text",
        content: [{ text: "plain" }, { text: "hero", emphasis: true }],
        timeline_in: 0,
        timeline_out: 60,
        animation: {
          build: "phrase-chunks",
          timing: "even",
          emphasis: { kind: "color", color: "#ff0000" },
        },
        style: { color: "#ffffff" },
      },
    ]);
    expect(buildScene(t, 0.5, dims({})).textLayers[0].color).toBe("#ffffff"); // plain chunk: base
    expect(buildScene(t, 1.5, dims({})).textLayers[0].color).toBe("#ff0000"); // hero chunk: emphasis colour
  });

  it("highlight / box-invert emphasis sets the hero chunk's bgBox in the preview (Slice A)", () => {
    const heroLayer = (kind: string) => {
      const t = tl([
        {
          id: "t",
          kind: "text",
          content: [{ text: "a" }, { text: "b", emphasis: true }],
          timeline_in: 0,
          timeline_out: 60,
          animation: {
            build: "phrase-chunks",
            timing: "even",
            emphasis: { kind, color: "#ffff00" },
          },
          style: { color: "#ffffff" },
        },
      ]);
      return buildScene(t, 1.5, dims({})).textLayers[0]; // 1.5s -> hero chunk "b" active
    };
    const hi = heroLayer("highlight");
    expect(hi.text).toBe("b");
    expect(hi.bgBox?.color).toBe("#ffff00"); // a real highlighter box behind the hero
    expect(hi.color).toBe("#ffffff"); // highlight keeps the base text colour
    const inv = heroLayer("box-invert");
    expect(inv.bgBox?.color).toBe("#ffff00"); // boxed
    expect(inv.color).toBe("#000000"); // box-invert inverts the text to black
  });

  it("preview karaoke sweep advances the sung boundary over time (Slice A2)", () => {
    const t = tl([
      {
        id: "t",
        kind: "text",
        content: [
          { text: "one", t_in: 0, t_out: 1 },
          { text: "two", t_in: 1, t_out: 2 },
        ],
        timeline_in: 0,
        timeline_out: 60,
        animation: { build: "word-highlight", timing: "explicit" },
        style: { color: "#ffffff" },
      },
    ]);
    const early = buildScene(t, 0.2, dims({})).textLayers[0].karaoke!;
    const late = buildScene(t, 1.5, dims({})).textLayers[0].karaoke!;
    // The sung-char boundary MOVES between two sample times — the scene-graph analogue of "two frames
    // differ" (a static assertion would pass on inert code).
    expect(late.sungChars).toBeGreaterThan(early.sungChars);
    expect(buildScene(t, 1.5, dims({})).textLayers[0].text).toBe("one two"); // the full joined karaoke line
  });

  it("animates a pop/slide entrance in the preview (Fix #3B)", () => {
    const pop = tl([
      {
        id: "t",
        kind: "text",
        text: "hi",
        timeline_in: 0,
        timeline_out: 60,
        animation: { entrance: "pop", entrance_ms: 1000 },
        style: { size: 100 },
      },
    ]);
    const early = buildScene(pop, 0.0, dims({})).textLayers[0].fontPx;
    const settled = buildScene(pop, 1.5, dims({})).textLayers[0].fontPx;
    expect(early).toBeLessThan(settled); // grows into place
    expect(settled).toBe(100);
    const slide = tl([
      {
        id: "t",
        kind: "text",
        text: "hi",
        timeline_in: 0,
        timeline_out: 60,
        animation: { entrance: "slide-up", entrance_ms: 1000 },
        transform: { position: { x: 0.5, y: 0.5 } },
      },
    ]);
    const y0 = buildScene(slide, 0.0, dims({})).textLayers[0].box.y;
    const yEnd = buildScene(slide, 1.5, dims({})).textLayers[0].box.y;
    expect(y0).toBeGreaterThan(yEnd); // starts lower, slides up to the settled position
  });

  it("approximates word-highlight as the full joined line in the preview (Fix #3B)", () => {
    const t = tl([
      {
        id: "t",
        kind: "text",
        content: [
          { text: "one", t_in: 0, t_out: 1 },
          { text: "two", t_in: 1, t_out: 2 },
        ],
        timeline_in: 0,
        timeline_out: 60,
        animation: { build: "word-highlight", timing: "explicit" },
      },
    ]);
    // The preview draws the whole line (the per-word \k sweep is exporter-only, an accepted approximation).
    expect(buildScene(t, 0.5, dims({})).textLayers[0].text).toBe("one two");
  });
});

describe("fitRects", () => {
  it("contain letterboxes a wide image in a square box", () => {
    const { dst, src } = fitRects(
      { x: 0, y: 0, w: 1000, h: 1000 },
      { w: 2000, h: 1000 },
      "contain",
    );
    expect(dst).toEqual({ x: 0, y: 250, w: 1000, h: 500 });
    expect(src).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it("cover centre-crops a wide image to fill a square box", () => {
    const { dst, src } = fitRects({ x: 0, y: 0, w: 1000, h: 1000 }, { w: 2000, h: 1000 }, "cover");
    expect(dst).toEqual({ x: 0, y: 0, w: 1000, h: 1000 });
    expect(src.w).toBeCloseTo(0.5, 5);
    expect(src.h).toBeCloseTo(1, 5);
    expect(src.x).toBeCloseTo(0.25, 5);
    expect(src.y).toBeCloseTo(0, 5);
  });
});

describe("buildScene visibility", () => {
  // The preview sees the clip's ref UNRESOLVED — a bare library id with no extension
  // to sniff — so the layer's kind has to come from the clip itself. Get it wrong and
  // an image is handed to the video decoder: the canvas shows nothing, while every
  // string-level assertion about the scene still passes. Both directions are pinned
  // so neither a stored kind nor the legacy path fallback can rot unnoticed.
  it("takes an image layer's kind from the CLIP, not the ref's extension", () => {
    const s = buildScene(
      tl([
        { kind: "image", media_ref: "media_a1b2c3d4e5f6", timeline_in: 0, timeline_out: 30 },
        { kind: "video", media_ref: "media_ffffffffffff", timeline_in: 0, timeline_out: 30 },
      ]),
      0.5,
      dims({}),
    );
    expect(s.layers.map((l) => l.kind)).toEqual(["image", "video"]);
  });

  it("still infers kind from the ref for legacy clips that stored a path", () => {
    const s = buildScene(
      tl([{ media_ref: "library/old.png", timeline_in: 0, timeline_out: 30 }]),
      0.5,
      dims({}),
    );
    expect(s.layers[0].kind).toBe("image");
  });

  it("includes only image clips visible at t", () => {
    const s = buildScene(
      tl([
        { media_ref: "a.png", timeline_in: 0, timeline_out: 30 },
        { media_ref: "b.png", timeline_in: 60, timeline_out: 90 },
      ]),
      0.5, // -> frame 15
      dims({}),
    );
    expect(s.layers.map((l) => (l as Any).source)).toEqual(["a.png"]);
  });
  it("skips audio and text but includes video with a source time", () => {
    const s = buildScene(
      tl([
        { media_ref: "a.mp4", source_in: 30, source_out: 90, timeline_in: 0, timeline_out: 60 },
        { kind: "audio", media_ref: "m.mp3", timeline_in: 0, timeline_out: 30 },
        { kind: "text", text: "x", timeline_in: 0, timeline_out: 30 },
      ]),
      1, // t=1s -> frame 30
      dims({ "a.mp4": { w: 100, h: 100 } }),
    );
    expect(s.layers.length).toBe(1);
    expect(s.layers[0].kind).toBe("video");
    // sourceTime = (source_in 30 + (frame30 - tin0)*speed1) / fps30 = 2s
    expect((s.layers[0] as Any).sourceTime).toBe(2);
  });
  it("applies clip speed to a video's source time", () => {
    const s = buildScene(
      tl([
        {
          media_ref: "a.mp4",
          source_in: 0,
          source_out: 120,
          timeline_in: 0,
          timeline_out: 60,
          speed: 2,
        },
      ]),
      1, // frame 30
      dims({ "a.mp4": { w: 100, h: 100 } }),
    );
    // sourceTime = (0 + 30*2) / 30 = 2s
    expect((s.layers[0] as Any).sourceTime).toBe(2);
  });
  it("skips clips on a hidden track", () => {
    const t = {
      units: "frames",
      canvas: { width: 1000, height: 1000, fps: 30 },
      tracks: [
        {
          id: "v",
          kind: "video",
          z: 0,
          hidden: true,
          clips: [{ media_ref: "a.png", timeline_in: 0, timeline_out: 30 }],
        },
        {
          id: "v2",
          kind: "video",
          z: 1,
          clips: [{ media_ref: "b.png", timeline_in: 0, timeline_out: 30 }],
        },
      ],
    } as Any;
    const s = buildScene(t, 0, dims({}));
    expect(s.layers.map((l) => (l as Any).source)).toEqual(["b.png"]);
  });
  const transTl = (kind: string): Any =>
    ({
      units: "frames",
      canvas: { width: 1000, height: 1000, fps: 30 },
      tracks: [
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [
            { media_ref: "a.png", timeline_in: 0, timeline_out: 60 },
            {
              media_ref: "b.png",
              timeline_in: 60,
              timeline_out: 120,
              transition_in: { kind, duration: 15 },
            },
          ],
        },
      ],
    }) as Any;

  it("crossfade cross-dissolves the incoming clip via opacity", () => {
    // Centered on the cut (frame 60): progress (60-52.5)/15 = 0.5; both composite.
    const s = buildScene(transTl("crossfade"), 60 / 30, dims({}));
    expect(s.layers.map((l) => (l as Any).source)).toEqual(["a.png", "b.png"]);
    const b = s.layers.find((l) => (l as Any).source === "b.png") as Any;
    expect(b.opacity).toBeCloseTo(0.5, 5);
    expect(b.transition).toBeUndefined();
    // past the window -> full opacity, no blend
    const out = buildScene(transTl("crossfade"), 70 / 30, dims({})).layers.find(
      (l) => (l as Any).source === "b.png",
    ) as Any;
    expect(out.opacity).toBe(1);
  });

  it("wipe attaches mask metadata and keeps the clip opaque", () => {
    // Centered on the cut (frame 60): progress (60-52.5)/15 = 0.5.
    const b = buildScene(transTl("wipe-l"), 60 / 30, dims({})).layers.find(
      (l) => (l as Any).source === "b.png",
    ) as Any;
    expect(b.transition).toEqual({ kind: "wipe-l", p: 0.5 });
    expect(b.opacity).toBe(1);
  });

  it("dip-to-colour inserts a colour quad and ramps the incoming clip", () => {
    // Centered: frame 63 -> progress (63-52.5)/15 = 0.7 (second half): colour full, B at 2p-1 = 0.4
    const s = buildScene(transTl("dip-to-black"), 63 / 30, dims({}));
    expect(s.layers.map((l) => (l as Any).source)).toEqual(["a.png", "", "b.png"]); // colour quad sits between
    const solid = s.layers.find((l) => (l as Any).solid) as Any;
    expect(solid.solid).toEqual([0, 0, 0]);
    expect(solid.opacity).toBe(1); // clamp(2*0.7,0,1)
    const b = s.layers.find((l) => (l as Any).source === "b.png") as Any;
    expect(b.opacity).toBeCloseTo(0.4, 5);
    // dip-to-white uses a white quad
    const white = buildScene(transTl("dip-to-white"), 63 / 30, dims({})).layers.find(
      (l) => (l as Any).solid,
    ) as Any;
    expect(white.solid).toEqual([1, 1, 1]);
  });
});

describe("buildScene geometry + ordering", () => {
  it("honours a layout box and clamps opacity", () => {
    const s = buildScene(
      tl([
        {
          media_ref: "a.png",
          timeline_in: 0,
          timeline_out: 30,
          opacity: 2,
          transform: { position: { x: 0.2, y: 0.2 }, scale_x: 0.2, scale_y: 0.2 },
        },
      ]),
      0,
      dims({ "a.png": { w: 200, h: 200 } }),
    );
    expect(s.layers[0].dst).toEqual({ x: 100, y: 100, w: 200, h: 200 });
    expect(s.layers[0].opacity).toBe(1);
  });
  it("defaults to canvas dims when the asset size is unknown", () => {
    const s = buildScene(
      tl([{ media_ref: "a.png", timeline_in: 0, timeline_out: 30 }]),
      0,
      dims({}),
    );
    expect(s.width).toBe(1000);
    expect(s.layers[0].dst).toEqual({ x: 0, y: 0, w: 1000, h: 1000 });
  });
  it("uses defaults for a missing track z and clip opacity", () => {
    const t = {
      units: "frames",
      canvas: { width: 100, height: 100, fps: 30 },
      tracks: [
        {
          id: "v",
          kind: "video",
          clips: [{ media_ref: "a.png", timeline_in: 0, timeline_out: 30 }],
        },
      ],
    } as Any as Timeline;
    const s = buildScene(t, 0, dims({}));
    expect(s.layers[0].z).toBe(0);
    expect(s.layers[0].opacity).toBe(1);
    expect(s.layers[0].dst).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });
  it("sorts layers by track z", () => {
    const t = {
      units: "frames",
      canvas: { width: 100, height: 100, fps: 30 },
      tracks: [
        {
          id: "top",
          kind: "video",
          z: 5,
          clips: [{ media_ref: "top.png", timeline_in: 0, timeline_out: 30 }],
        },
        {
          id: "bot",
          kind: "video",
          z: 1,
          clips: [{ media_ref: "bot.png", timeline_in: 0, timeline_out: 30 }],
        },
      ],
    } as Any as Timeline;
    const s = buildScene(t, 0, dims({}));
    expect(s.layers.map((l) => l.source)).toEqual(["bot.png", "top.png"]);
  });
  it("converts a constant rotate to radians and exposes the clip box", () => {
    const s = buildScene(
      tl([
        {
          media_ref: "a.png",
          timeline_in: 0,
          timeline_out: 30,
          rotate: 90,
          transform: { position: { x: 0.3, y: 0.2 }, scale_x: 0.4, scale_y: 0.3 },
        },
      ]),
      0,
      dims({ "a.png": { w: 400, h: 300 } }),
    );
    expect(s.layers[0].rotate).toBeCloseTo(Math.PI / 2, 6);
    expect(s.layers[0].clipBox).toEqual({ x: 100, y: 50, w: 400, h: 300 });
  });
  it("defaults rotate to 0 when absent and holds the first keyframe (v=0) at t=0", () => {
    const s = buildScene(
      tl([
        { media_ref: "a.png", timeline_in: 0, timeline_out: 30 },
        {
          media_ref: "b.png",
          timeline_in: 0,
          timeline_out: 30,
          rotate: [
            { t: 0, v: 0 },
            { t: 30, v: 90 },
          ],
        },
      ]),
      0,
      dims({}),
    );
    expect(s.layers[0].rotate).toBe(0); // absent
    expect(s.layers[1].rotate).toBe(0); // keyframed -> deferred to 0
  });
  it("samples keyframed rotate and position at the current frame", () => {
    const s = buildScene(
      tl([
        {
          media_ref: "a.png",
          timeline_in: 0,
          timeline_out: 30,
          rotate: [
            { t: 0, v: 0 },
            { t: 30, v: 90 },
          ],
          transform: {
            position: {
              x: [
                { t: 0, v: 0.2 },
                { t: 30, v: 0.5 },
              ],
              y: 0.15,
            },
            scale_x: 0.2,
            scale_y: 0.2,
          },
        },
      ]),
      10 / 30, // frame 10
      dims({ "a.png": { w: 200, h: 200 } }),
    );
    expect(s.layers[0].rotate).toBeCloseTo((30 * Math.PI) / 180, 6); // 90 * 10/30 = 30deg
    expect(s.layers[0].clipBox.x).toBeCloseTo(200, 6); // 100 + 300 * 10/30 = 200
    expect(s.layers[0].dst.x).toBeCloseTo(200, 6); // box moved -> dst moves with it
  });
  it("applies the plan's single declared sampling offset to opacity — a dropped offset would drift (B2)", () => {
    // A clip that STARTS at 2s (60f) with opacity fading 0->1 over its first second. The preview must
    // sample the curve CLIP-RELATIVE (globalTime - the plan's inSec), so opacity is 0 at the clip start
    // and 0.5 halfway — NOT an absolute-time sample (which would read past the last keyframe -> 1). The
    // exporter's matching offset is pinned by the byte-identical render.corpus, so a drift on EITHER
    // backend is caught (the agreement the fps assert also protects).
    const t = tl([
      {
        media_ref: "a.png",
        timeline_in: 60,
        timeline_out: 150,
        opacity: [
          { t: 0, v: 0 },
          { t: 30, v: 1 },
        ],
      },
    ]);
    const op = (sec: number) =>
      buildScene(t, sec, dims({ "a.png": { w: 10, h: 10 } })).layers[0].opacity;
    expect(op(2.0)).toBeCloseTo(0, 6); // clip start -> curve t=0
    expect(op(2.5)).toBeCloseTo(0.5, 6); // halfway through the 1s fade
    expect(op(3.0)).toBeCloseTo(1, 6); // fade complete
  });
  it("applies the plan's declared offset to the transform sample (Ken Burns) — a dropped offset would drift (B2)", () => {
    // A still with a Ken Burns pan: position.x moves 0.2 -> 0.8 over the clip's first second, and the clip
    // STARTS at 2s (60f). The preview's boxOf must sample the transform CLIP-RELATIVE (globalTime - the
    // plan's inSec), so box-x tracks px=0.2 at clip start and 0.5 halfway — NOT an absolute-time sample
    // (which would read past the last keyframe -> 0.8). box-x = round(px*1000 - (scale*1000)/2).
    const t = tl([
      {
        media_ref: "a.png",
        timeline_in: 60,
        timeline_out: 150,
        transform: {
          position: {
            x: [
              { t: 0, v: 0.2 },
              { t: 30, v: 0.8 },
            ],
            y: 0.5,
          },
          scale: 0.2,
        },
      },
    ]);
    const boxX = (sec: number) =>
      buildScene(t, sec, dims({ "a.png": { w: 100, h: 100 } })).layers[0].clipBox.x;
    expect(boxX(2.0)).toBe(100); // clip start: px=0.2 -> 0.2*1000 - 100
    expect(boxX(2.5)).toBe(400); // halfway: px=0.5
    expect(boxX(3.0)).toBe(700); // end: px=0.8
  });
  it("derives a colour eq from clip.color (identity when absent)", () => {
    const graded = buildScene(
      tl([
        {
          media_ref: "a.png",
          timeline_in: 0,
          timeline_out: 30,
          color: { brightness: 0.2, saturation: 0.5 },
        },
      ]),
      0,
      dims({}),
    );
    expect(graded.layers[0].eq).toEqual([0.2, 1, 0.5, 1]);
    const plain = buildScene(
      tl([{ media_ref: "a.png", timeline_in: 0, timeline_out: 30 }]),
      0,
      dims({}),
    );
    expect(plain.layers[0].eq).toEqual([0, 1, 1, 1]);
  });
  it("derives exposure, white balance, and levels from clip.color", () => {
    const g = buildScene(
      tl([
        {
          media_ref: "a.png",
          timeline_in: 0,
          timeline_out: 30,
          color: { exposure: 1, temperature: 8000, blacks: 0.4 },
        },
      ]),
      0,
      dims({}),
    ).layers[0];
    expect(g.exposure).toBe(1);
    expect(g.wb[0]).toBeGreaterThan(1); // warmer -> more red
    expect(g.wb[2]).toBeLessThan(1); // ... and less blue
    expect(g.levels[2]).toBeCloseTo(0.2, 5); // blacks 0.4 -> outBlack 0.2
    const plain = buildScene(
      tl([{ media_ref: "a.png", timeline_in: 0, timeline_out: 30 }]),
      0,
      dims({}),
    ).layers[0];
    expect(plain.exposure).toBe(0);
    expect(plain.wb).toEqual([1, 1, 1]);
    expect(plain.levels).toEqual([0, 1, 0, 1]);
  });
});

describe("clipRects crop + flip", () => {
  const box = { x: 0, y: 0, w: 1000, h: 1000 };
  it("crops the source region before fitting", () => {
    const { dst, src } = clipRects(
      box,
      { w: 1000, h: 1000 },
      "contain",
      { left: 0.25, right: 0.25 },
      false,
      false,
    );
    expect(src.x).toBeCloseTo(0.25, 5);
    expect(src.w).toBeCloseTo(0.5, 5);
    expect(dst).toEqual({ x: 250, y: 0, w: 500, h: 1000 }); // cropped 500x1000 -> centred
  });
  it("flips horizontally by negating the src width", () => {
    const { src } = clipRects(box, { w: 1000, h: 1000 }, "contain", undefined, true, false);
    expect(src.x).toBeCloseTo(1, 5);
    expect(src.w).toBeCloseTo(-1, 5);
  });
  it("flips vertically by negating the src height", () => {
    const { src } = clipRects(box, { w: 1000, h: 1000 }, "contain", undefined, false, true);
    expect(src.y).toBeCloseTo(1, 5);
    expect(src.h).toBeCloseTo(-1, 5);
  });
});
