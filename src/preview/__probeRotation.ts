// Dev-only probe for e2e/ui/rotation.spec.ts (UJ-015). Decodes every rotated fixture with the
// preview's OWN decoder (VideoSource: mp4box + WebCodecs), composites it with the preview's renderer
// through buildScene, and reports what the canvas SHOWS - where the lit picture sits and the colour
// of each of its corners - for the spec to hold against expected.json, which is what ffmpeg (the
// export) shows. Nothing here reads an orientation back from the code under test: the answer is
// read off the pixels. Not part of the production build.
import { PreviewRenderer } from "./renderer";
import { type AssetDims, buildScene } from "./scene";
import { VideoSource } from "./videoSource";
import { CORNERS, ROTATION_FIXTURES, classify } from "./__rotationFixtures";
import type { Timeline } from "../timeline/model";

const SIZE = 200;

export interface RotationShot {
  decoded: boolean;
  /** The lit (non-black) part of the canvas: where the picture was drawn. */
  box: { x: number; y: number; w: number; h: number } | null;
  /** Palette colour at the middle of each quadrant of `box`: TL, TR, BL, BR. */
  corners: string[];
  /** RGB at named points, fractions of `box`. */
  at: Record<string, [number, number, number]>;
  error?: string;
}

const canvas = document.getElementById("probe") as HTMLCanvasElement;

function timeline(source: string, clip: Record<string, unknown>): Timeline {
  return {
    units: "frames",
    canvas: { width: SIZE, height: SIZE, fps: 30 },
    tracks: [
      {
        id: "v",
        kind: "video",
        z: 0,
        clips: [
          {
            kind: "video",
            media_ref: source,
            source_in: 0,
            source_out: 2,
            timeline_in: 0,
            timeline_out: 2,
            ...clip,
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

async function shoot(
  renderer: PreviewRenderer,
  file: string,
  tag: string,
  clip: Record<string, unknown>,
  points: Record<string, [number, number]> = {},
): Promise<RotationShot> {
  const vs = new VideoSource(`/e2e/ui/fixtures/rotation/${file}`);
  try {
    await vs.whenReady();
    const frame = await vs.frameAt(0);
    if (!frame) return { decoded: false, box: null, corners: [], at: {} };
    const key = `${file}#${tag}`;
    renderer.setTexture(key, frame, vs.orientation);
    renderer.render(
      buildScene(timeline(key, clip), 0, new Map<string, AssetDims>([[key, vs.dims]])),
    );
    // SAME TASK as render(): the context is not preserveDrawingBuffer.
    const snap = document.createElement("canvas");
    snap.width = SIZE;
    snap.height = SIZE;
    const ctx = snap.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    ctx.drawImage(canvas, 0, 0);
    const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const rgb = (x: number, y: number): [number, number, number] => {
      const i =
        (Math.min(SIZE - 1, Math.max(0, Math.floor(y))) * SIZE +
          Math.min(SIZE - 1, Math.max(0, Math.floor(x)))) *
        4;
      return [px[i], px[i + 1], px[i + 2]];
    };
    let [x0, y0, x1, y1] = [SIZE, SIZE, -1, -1];
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const [r, g, b] = rgb(x, y);
        if (r + g + b <= 60) continue;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    if (x1 < 0) return { decoded: true, box: null, corners: [], at: {} };
    const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    const inBox = ([fx, fy]: readonly [number, number]) =>
      rgb(box.x + fx * box.w, box.y + fy * box.h);
    const at: RotationShot["at"] = {};
    for (const [name, p] of Object.entries(points)) at[name] = inBox(p);
    return { decoded: true, box, corners: CORNERS.map((p) => classify(inBox(p))), at };
  } catch (e) {
    return { decoded: false, box: null, corners: [], at: {}, error: String(e) };
  } finally {
    vs.close();
  }
}

void (async () => {
  const out: Record<string, RotationShot> = {};
  try {
    const renderer = new PreviewRenderer(canvas);
    for (const fx of ROTATION_FIXTURES) out[fx.file] = await shoot(renderer, fx.file, "plain", {});
    // A crop is a fraction of the SHOWN picture: the left half of a portrait phone clip, not of
    // the landscape frame it is stored as.
    out["crop:h264_rot270.mp4"] = await shoot(renderer, "h264_rot270.mp4", "crop", {
      crop: { left: 0.5 },
    });
    // The preview's motion smear runs ACROSS the shown picture. Sampled just inside the boundary
    // between the left and right halves (where a sideways smear mixes them) and just inside the
    // boundary between the top and bottom halves (where it must not).
    out["motion:h264_rot270.mp4"] = await shoot(
      renderer,
      "h264_rot270.mp4",
      "motion",
      { effects: [{ type: "motion", params: { frames: 12 } }] },
      { acrossLeftRight: [0.47, 0.25], acrossTopBottom: [0.25, 0.47] },
    );
    (window as unknown as { __rotation: unknown }).__rotation = out;
  } catch (e) {
    (window as unknown as { __rotation: unknown }).__rotation = { error: String(e) };
  }
})();
