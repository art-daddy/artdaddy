// Whether the preview trusts this browser's own decoder with High-profile H.264 (the profile most phones and cameras
// record). The check decodes a small calibration clip and reads four coloured corners back; a decoder that gets the
// colours wrong, or never finishes, must send the preview through a proxy instead of showing the person a wrongly
// coloured picture. The browser parts (the decoder, the canvas) are faked; the rule they feed is the real one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Rgb = [number, number, number];
/** The calibration clip's four quadrants as a correct decoder draws them: red, green, blue, near white. */
const TRUE_COLOURS: Record<string, Rgb> = {
  topLeft: [224, 16, 16],
  topRight: [16, 224, 16],
  bottomLeft: [16, 16, 224],
  bottomRight: [240, 240, 240],
};

interface FakeFrame {
  displayWidth: number;
  displayHeight: number;
  colours: Record<string, Rgb>;
}

const video = vi.hoisted(() => ({
  ready: Promise.resolve() as Promise<void>,
  frame: null as unknown,
  opened: 0,
  closed: 0,
}));
vi.mock("./videoSource", () => ({
  VideoSource: class {
    constructor() {
      video.opened += 1;
    }
    whenReady(): Promise<void> {
      return video.ready;
    }
    async frameAt(): Promise<unknown> {
      return video.frame;
    }
    close(): void {
      video.closed += 1;
    }
  },
}));

class FakeCanvas {
  private frame: FakeFrame | null = null;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext() {
    return {
      drawImage: (frame: FakeFrame) => {
        this.frame = frame;
      },
      getImageData: (x: number, y: number) => {
        const quadrant = `${y < this.height / 2 ? "top" : "bottom"}${x < this.width / 2 ? "Left" : "Right"}`;
        const [r, g, b] = this.frame!.colours[quadrant];
        return { data: new Uint8ClampedArray([r, g, b, 255]) };
      },
    };
  }
}

const frameWith = (colours: Partial<Record<string, Rgb>>): FakeFrame => ({
  displayWidth: 64,
  displayHeight: 36,
  colours: { ...TRUE_COLOURS, ...colours } as Record<string, Rgb>,
});

async function check(): Promise<{ trusted: boolean; again: () => Promise<boolean> }> {
  vi.resetModules(); // the answer is kept for the session: each case needs a fresh one
  const { highH264DecodesCorrectly } = await import("./h264Support");
  return { trusted: await highH264DecodesCorrectly(), again: highH264DecodesCorrectly };
}

beforeEach(() => {
  video.ready = Promise.resolve();
  video.frame = frameWith({});
  video.opened = 0;
  video.closed = 0;
  vi.stubGlobal("VideoDecoder", class {});
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
});
afterEach(() => vi.useRealTimers());

describe("High-profile H.264 in the browser's own decoder", () => {
  it("is trusted when the calibration clip comes back in its true colours", async () => {
    expect((await check()).trusted).toBe(true);
    expect([video.opened, video.closed]).toEqual([1, 1]);
  });

  it.each(Object.keys(TRUE_COLOURS))(
    "is not trusted when the %s colour comes back wrong",
    async (corner) => {
      video.frame = frameWith({ [corner]: [128, 128, 128] });
      expect((await check()).trusted).toBe(false);
      expect(video.closed).toBe(1);
    },
  );

  // Compression moves colours a little; a decoder bug moves them a lot. The line is a distance of 80.
  it("allows the small colour error of a good decode, and not a larger one", async () => {
    video.frame = frameWith({ topLeft: [224 - 40, 16 + 40, 16 + 40] }); // 69 away
    expect((await check()).trusted).toBe(true);
    video.frame = frameWith({ topLeft: [224 - 50, 16 + 50, 16 + 50] }); // 87 away
    expect((await check()).trusted).toBe(false);
  });

  it("is not trusted when no frame could be decoded", async () => {
    video.frame = null;
    expect((await check()).trusted).toBe(false);
    expect(video.closed).toBe(1);
  });

  it("is not trusted, and decodes nothing, where the browser has no video decoder", async () => {
    vi.stubGlobal("VideoDecoder", undefined);
    expect((await check()).trusted).toBe(false);
    expect(video.opened).toBe(0);
  });

  it("gives up after four seconds on a decoder that never answers, and frees it", async () => {
    video.ready = new Promise<void>(() => undefined);
    vi.resetModules();
    const { highH264DecodesCorrectly } = await import("./h264Support");
    vi.useFakeTimers();
    const answer = highH264DecodesCorrectly();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(video.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBe(false);
    expect(video.closed).toBe(1);
  });

  it("decodes the clip once per session, however often it is asked", async () => {
    const { again } = await check();
    await Promise.all([again(), again()]);
    expect(video.opened).toBe(1);
  });
});
