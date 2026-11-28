// An animated still (a GIF or an animated WebP) in the preview: its frames arrive as one file of PNGs and are decoded a
// few ahead of the playhead, each into its own texture. The browser parts (fetch, createImageBitmap, the WebGL renderer)
// are faked; what is checked is what the person sees: the picture moves, a frame not decoded yet never blanks the
// clip, texture memory stays bounded without ever dropping the frame on screen, a damaged pack stays still instead of
// showing frames at the wrong times, and a closed still uploads nothing more.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StillTiming } from "../media/stillFrames";
import type { PreviewRenderer } from "./renderer";
import { AnimatedStill } from "./stillAnimation";

const FPS = 30;
/** Eight frames, a tenth of a second each, looping: at 30 fps a frame lasts three project frames. */
const TIMING: StillTiming = {
  den: 100,
  pts: [0, 10, 20, 30, 40, 50, 60, 70],
  period: 80,
  passes: Infinity,
};
const CLIP = { len: 240, speed: 1 };

/** One PNG of the pack: the signature, a private chunk carrying the frame's number, and IEND. */
function png(index: number): number[] {
  return [
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...[0, 0, 0, 1, 0x66, 0x52, 0x41, 0x6d, index, 0, 0, 0, 0], // "fRAm", 1 byte of data
    ...[0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82],
  ];
}
const pack = (frames: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Array.from({ length: frames }, (_, i) => png(i)).flat());

interface Bitmap {
  frame: number;
  width: number;
  height: number;
  close: () => void;
}

let size = { width: 320, height: 240 };
/** While set, every decode waits here until the test releases it. */
let held: Array<() => void> | null = null;
beforeEach(() => {
  size = { width: 320, height: 240 };
  held = null;
  vi.stubGlobal("createImageBitmap", async (blob: Blob): Promise<Bitmap> => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (held) await new Promise<void>((resolve) => held!.push(resolve));
    return { frame: bytes[16], ...size, close: () => undefined };
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.unstubAllGlobals());

function serve(body: Uint8Array<ArrayBuffer>, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status })),
  );
}

/** The textures on the GPU, by key: which frame each holds. */
function gpu() {
  const textures = new Map<string, number>();
  const renderer = {
    setTexture: (key: string, bitmap: Bitmap) => textures.set(key, bitmap.frame),
    dropTextures: (drop: (key: string) => boolean) => {
      for (const key of [...textures.keys()]) if (drop(key)) textures.delete(key);
    },
  } as unknown as PreviewRenderer;
  return { textures, renderer };
}

/** Everything the still has started settles (the fetch, decodes, uploads). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
/** Let the decodes in flight reach the decoder, then let them all finish. */
async function release(): Promise<number> {
  await settle();
  const waiting = held?.splice(0) ?? [];
  held = null;
  for (const go of waiting) go();
  await settle();
  return waiting.length;
}

async function still(frames = TIMING.pts.length) {
  serve(pack(frames));
  const { textures, renderer } = gpu();
  const changed = vi.fn();
  const s = new AnimatedStill("gif.gif", "asset://frames.pack", TIMING, () => renderer, changed);
  await settle();
  /** The frame the clip draws at its project frame `k`: null for the original picture, -1 for a texture that is gone. */
  const drawn = (k: number): number | null => {
    const key = s.keyFor(FPS, { k, ...CLIP });
    return key === null ? null : (textures.get(key) ?? -1);
  };
  /** Draw `k` until its own frame is up, as playback does frame after frame. */
  const warm = async (k: number): Promise<number | null> => {
    for (let i = 0; i < 5; i++) {
      drawn(k);
      await settle();
    }
    return drawn(k);
  };
  return { s, textures, changed, drawn, warm };
}

describe("an animated still in the preview", () => {
  it("moves: two points of its clip draw two different frames of it", async () => {
    const { drawn, warm, changed } = await still();
    expect(changed).toHaveBeenCalled(); // the frames arrived
    expect(drawn(0)).toBeNull(); // nothing on the GPU yet: the original picture stands in
    expect(await warm(0)).toBe(0);
    expect(await warm(6)).toBe(2);
    expect(await warm(24)).toBe(0); // a pass is 24 project frames: the loop comes round
  });

  it("never blanks a frame that is not decoded yet: the frame last drawn stands in", async () => {
    const { drawn, warm } = await still();
    expect(await warm(0)).toBe(0);
    held = [];
    expect(drawn(15)).toBe(0); // far ahead of what was decoded
    await settle();
    expect(drawn(15)).toBe(0); // still decoding
    expect(await release()).toBeGreaterThan(0);
    expect(drawn(15)).toBe(5);
  });

  it("keeps texture memory bounded while the clip plays, with what is drawn always on the GPU", async () => {
    size = { width: 4000, height: 4000 }; // so big that only the minimum number of frames may stay
    const { drawn, textures } = await still();
    let most = 0;
    for (let k = 0; k < 24; k++) {
      const frame = drawn(k);
      expect(frame, `at ${k}`).not.toBe(-1); // what is drawn is on the GPU
      await settle();
      most = Math.max(most, textures.size);
    }
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(6);
  }, 60_000);

  it("stays unmoving, rather than show frames at the wrong times, when the pack does not match its index", async () => {
    const { drawn, textures } = await still(TIMING.pts.length - 1);
    for (const k of [0, 6, 12]) expect(drawn(k)).toBeNull();
    await settle();
    expect(textures.size).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("stays unmoving"),
      expect.any(Error),
    );
  });

  // Even when the answer carries a whole pack: frames that came with an error are not trusted.
  it("stays unmoving when its frames cannot be fetched", async () => {
    serve(pack(TIMING.pts.length), 404);
    const { textures, renderer } = gpu();
    const s = new AnimatedStill("gif.gif", "asset://frames.pack", TIMING, () => renderer, vi.fn());
    await settle();
    expect(s.keyFor(FPS, { k: 6, ...CLIP })).toBeNull();
    await settle();
    expect(textures.size).toBe(0);
  });

  it("frees its textures when closed, and uploads nothing from a decode that finishes after", async () => {
    const { s, drawn, warm, textures } = await still();
    await warm(0);
    expect(textures.size).toBeGreaterThan(0);
    held = [];
    drawn(12); // starts decodes that will finish after the close
    await settle();
    s.close();
    expect(textures.size).toBe(0);
    expect(await release()).toBeGreaterThan(0);
    expect(textures.size).toBe(0);
  });
});
