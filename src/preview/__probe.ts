// Dev-only browser probe for the WebGL2 compositor (happy-dom has no WebGL, so
// the renderer + shaders are validated here). Composites a wide red image
// (letterboxed via contain) with a semi-transparent blue box on top, so a
// screenshot shows: black bands + a red middle band + a 50%-opacity blue square.
// Not part of the production build (index.html is the only vite entry).
import type { Timeline } from "../timeline/model";
import { PreviewRenderer } from "./renderer";
import { type AssetDims, buildScene } from "./scene";

function solid(w: number, h: number, color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return c;
}

const canvas = document.getElementById("probe") as HTMLCanvasElement;
try {
  const renderer = new PreviewRenderer(canvas);
  renderer.setTexture("red.png", solid(800, 400, "#ee0000"));
  renderer.setTexture("blue.png", solid(400, 400, "#0000ee"));
  const dims = new Map<string, AssetDims>([
    ["red.png", { w: 800, h: 400 }],
    ["blue.png", { w: 400, h: 400 }],
  ]);
  const tl = {
    units: "frames",
    canvas: { width: 600, height: 600, fps: 30 },
    tracks: [
      {
        id: "a",
        kind: "video",
        z: 0,
        clips: [{ media_ref: "red.png", timeline_in: 0, timeline_out: 30 }],
      },
      {
        id: "b",
        kind: "video",
        z: 1,
        clips: [
          {
            media_ref: "blue.png",
            timeline_in: 0,
            timeline_out: 30,
            opacity: 0.5,
            // The model's own shape (normBox): normalised centre + scale, NOT a pixel rect.
            // This said `layout: {x,y,w,h}`, which nothing reads — so the overlay silently
            // covered the whole canvas and two of the pixel tests passed for that reason.
            transform: { position: { x: 0.5, y: 0.5 }, scale_x: 400 / 600, scale_y: 400 / 600 },
          },
        ],
      },
    ],
  } as unknown as Timeline;
  renderer.render(buildScene(tl, 0, dims));
  // SAME TASK as render(): the context is not preserveDrawingBuffer, so the drawing
  // buffer is discarded once this task yields and any later drawImage reads black.
  // Copying it here gives the pixel tests something that is still there when they look.
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
