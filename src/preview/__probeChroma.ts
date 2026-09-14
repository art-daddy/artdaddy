// Dev-only browser probe for the CHROMA KEY in the real shader.
//
// The key's threshold is the one number the preview and the export have to agree on, and they
// did not: the shader used RGB distance, ffmpeg uses chroma-plane distance. chromaKey.ts now
// owns the maths and emits the GLSL, and its conformance test pins the TS side against real
// ffmpeg — but the TS side is not what runs. This renders the same decision ON THE GPU so a
// divergence in the shader expression itself cannot hide behind a passing unit test.
//
// Scene: a green screen carrying a WHITE patch and an ORANGE patch, keyed at similarity 0.42 —
// the value a real session settled on. ffmpeg at 0.42 removes the backing AND the white, and
// keeps the orange. The shader must do the same.
import type { Timeline } from "../timeline/model";
import { PreviewRenderer } from "./renderer";
import { type AssetDims, buildScene } from "./scene";

/** Green backing, white patch on the left half, orange patch on the right half. */
function greenScreen(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = "#00ff00";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w / 2, h / 2);
  ctx.fillStyle = "#ffa500";
  ctx.fillRect(w / 2, 0, w / 2, h / 2);
  return c;
}

const canvas = document.getElementById("probe") as HTMLCanvasElement;
try {
  const renderer = new PreviewRenderer(canvas);
  // A blue base, so anything the key removes reads as BLUE rather than black — black could also
  // mean "nothing drew at all", which is the failure this probe exists to catch.
  renderer.setTexture(
    "base.png",
    (() => {
      const c = document.createElement("canvas");
      c.width = 600;
      c.height = 600;
      const ctx = c.getContext("2d") as CanvasRenderingContext2D;
      ctx.fillStyle = "#0000ff";
      ctx.fillRect(0, 0, 600, 600);
      return c;
    })(),
  );
  renderer.setTexture("subject.png", greenScreen(600, 600));
  const dims = new Map<string, AssetDims>([
    ["base.png", { w: 600, h: 600 }],
    ["subject.png", { w: 600, h: 600 }],
  ]);
  const tl = {
    units: "frames",
    canvas: { width: 600, height: 600, fps: 30 },
    tracks: [
      {
        id: "a",
        kind: "video",
        z: 0,
        clips: [{ media_ref: "base.png", timeline_in: 0, timeline_out: 30 }],
      },
      {
        id: "b",
        kind: "video",
        z: 1,
        clips: [
          {
            media_ref: "subject.png",
            timeline_in: 0,
            timeline_out: 30,
            effects: [{ type: "chroma", params: { color: "#00FF00", similarity: 0.42, blend: 0 } }],
          },
        ],
      },
    ],
  } as unknown as Timeline;
  renderer.render(buildScene(tl, 0, dims));
  const snap = document.createElement("canvas");
  snap.id = "probe-snapshot";
  snap.width = canvas.width;
  snap.height = canvas.height;
  (snap.getContext("2d") as CanvasRenderingContext2D).drawImage(canvas, 0, 0);
  document.body.appendChild(snap);
  (window as unknown as { __probe: string }).__probe = "ok";
} catch (e) {
  (window as unknown as { __probe: string }).__probe = `error: ${String(e)}`;
}
