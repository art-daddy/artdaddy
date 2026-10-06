// An animated still in the preview worker (browser-only: fetch + createImageBitmap; the pure rules
// it follows live in media/stillFrames.ts and are tested there).
//
// Its frames arrive as ONE file of PNGs written back to back (stillFramePack.ts). Each frame is
// decoded when first needed, a few ahead of the playhead, and uploaded as its own texture, so two
// clips of one GIF at different points of its loop each draw their own frame. A frame not decoded
// yet never holds anything up: the frame last drawn stands in for it.
import { splitPngStream, stillFrameShown, type StillTiming } from "../media/stillFrames";
import type { PreviewRenderer } from "./renderer";

/** Frames decoded ahead of the one on screen, so playback finds them ready. */
const AHEAD = 3;
/** Decodes in flight at once, per still. */
const MAX_DECODES = 3;
/** Texture memory one still may hold, in pixels; at least a few frames whatever their size. */
const TEXTURE_PIXELS = 32e6;
const MIN_TEXTURES = 6;

export class AnimatedStill {
  private frames: Blob[] | null = null;
  private dead = false;
  /** Uploaded frame textures, least recently used first. */
  private readonly resident = new Map<number, string>();
  private readonly decoding = new Set<number>();
  private cap = MIN_TEXTURES;
  private lastKey: string | null = null;

  constructor(
    readonly source: string,
    readonly url: string,
    private readonly timing: StillTiming,
    private readonly renderer: () => PreviewRenderer | null,
    /** Something new can be drawn: a frame decoded, or the frames arrived. */
    private readonly onChange: () => void,
  ) {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const resp = await fetch(this.url);
      if (!resp.ok) throw new Error(`frames fetch failed (${resp.status})`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const ranges = splitPngStream(bytes);
      // The index and the frames are written by one job, so a count that disagrees means a torn or
      // stale pack: drawn unmoving rather than with frames that show at the wrong times.
      if (!ranges || ranges.length !== this.timing.pts.length)
        throw new Error(
          `frames do not match their index (${ranges?.length ?? 0} of ${this.timing.pts.length})`,
        );
      if (this.dead) return;
      this.frames = ranges.map(([a, b]) => new Blob([bytes.subarray(a, b)], { type: "image/png" }));
      this.onChange();
    } catch (err) {
      console.warn(`[preview] animated still stays unmoving: ${this.source}`, err);
    }
  }

  /** The texture key to draw where the still is in its clip (`still` from the scene), or null while
   *  no frame of this still is on the GPU yet (the original picture is drawn then). */
  keyFor(fps: number, at: { k: number; len: number; speed: number }): string | null {
    if (!this.frames || this.dead) return this.lastKey;
    const n = this.frames.length;
    const idx = stillFrameShown(this.timing, fps, at.k, at.len, at.speed);
    for (let i = 1; i <= AHEAD; i++) this.decode((idx + i) % n);
    const key = this.resident.get(idx);
    if (key) {
      this.resident.delete(idx); // most recently used goes last
      this.resident.set(idx, key);
      this.lastKey = key;
      return key;
    }
    this.decode(idx);
    return this.lastKey;
  }

  private decode(idx: number): void {
    if (!this.frames || this.resident.has(idx) || this.decoding.has(idx)) return;
    if (this.decoding.size >= MAX_DECODES) return;
    this.decoding.add(idx);
    void createImageBitmap(this.frames[idx])
      .then((bitmap) => {
        this.decoding.delete(idx);
        const r = this.renderer();
        if (this.dead || !r) return bitmap.close();
        this.cap = Math.max(
          MIN_TEXTURES,
          Math.floor(TEXTURE_PIXELS / (bitmap.width * bitmap.height)),
        );
        const key = `${this.source}\u0000frame\u0000${idx}`;
        r.setTexture(key, bitmap);
        bitmap.close(); // the texture holds the pixels now
        this.resident.set(idx, key);
        for (const [oldIdx, oldKey] of this.resident) {
          if (this.resident.size <= this.cap) break;
          if (oldKey === this.lastKey) continue; // never the frame standing in on screen
          this.resident.delete(oldIdx);
          r.dropTextures((k) => k === oldKey);
        }
        this.onChange();
      })
      .catch((err) => {
        this.decoding.delete(idx);
        console.warn(`[preview] frame ${idx} of ${this.source} did not decode`, err);
      });
  }

  close(): void {
    this.dead = true;
    const r = this.renderer();
    const keys = new Set(this.resident.values());
    if (r && keys.size) r.dropTextures((k) => keys.has(k));
    this.resident.clear();
    this.frames = null;
  }
}
