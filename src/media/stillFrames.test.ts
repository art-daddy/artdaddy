import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  packSize,
  parsePackIndex,
  serializePackIndex,
  splitPngStream,
  stillFrameAt,
  stillFrameBefore,
  stillFrameShown,
  timingFromProbe,
  type StillTiming,
} from "./stillFrames";

// The GIF the rule was measured on, as ffprobe reports it: time base 1/100, frame starts and the
// durations 7,13,5,20,7,1 (its last frame lasts 1 cs, so one pass is 53 cs).
const IRREGULAR: StillTiming = { den: 100, pts: [0, 7, 20, 25, 45, 52], period: 53, passes: Infinity };
const run = (t: StillTiming, fps: number, n: number) =>
  Array.from({ length: n }, (_, k) => stillFrameAt(t, fps, k)).join("");

describe("stillFrameAt: the frame of an animated still the export shows at a project frame", () => {
  // ffmpeg's own output for the export's chain (-stream_loop -1, fps=FPS:start_time=0:round=near),
  // captured from the shipped build, frame by frame.
  it("matches the export's frames, measured at 30, 24, 60 and 25 fps", () => {
    expect(run(IRREGULAR, 30, 77)).toBe(
      "00111122333333440011112333333444001111233333344500111123333334450011112333333",
    );
    expect(run(IRREGULAR, 24, 62)).toBe("00111233333450111123333340011123333344001112333334400111233333");
    expect(run(IRREGULAR, 60, 154)).toBe(
      "0000111111112223333333333334444500001111111122233333333333344445000011111111222333333333333444400000111111122233333333333344444000011111111222333333333333",
    );
    expect(run(IRREGULAR, 25, 64)).toBe("0011123333344001112233333450111123333344001112333334400111233333");
  });

  // 15 cs at 30 fps is exactly 4.5 project frames. Floating point says 4.4999999999999991 (rounds
  // down); ffmpeg rounds the exact half away from zero, so the second frame starts at frame 5.
  it("rounds an exact half the way ffmpeg does, not the way floating point does", () => {
    const t: StillTiming = { den: 100, pts: [0, 15], period: 30, passes: Infinity };
    expect(stillFrameAt(t, 30, 4)).toBe(0);
    expect(stillFrameAt(t, 30, 5)).toBe(1);
  });

  it("holds the last frame after its last pass when the still plays a fixed number of times", () => {
    const once: StillTiming = { den: 1000, pts: [0, 100, 200], period: 300, passes: 1 };
    expect(run(once, 10, 6)).toBe("012222");
    const twice: StillTiming = { ...once, passes: 2 };
    expect(run(twice, 10, 8)).toBe("01201222");
  });

  it("shows the first frame before the clip starts (a transition's lead-in)", () => {
    expect(stillFrameAt(IRREGULAR, 30, -5)).toBe(0);
  });

  // Measured on the shipped ffmpeg (frames at 0, 1, 2 and 30 cs): several frames can start before
  // the first project frame rounds, and the export shows the LAST of those there, not the first.
  it("shows the last of several frames that start before the first project frame", () => {
    const t: StillTiming = { den: 100, pts: [0, 1, 2, 30], period: 31, passes: Infinity };
    expect(stillFrameAt(t, 24, 0)).toBe(2); // 2 cs is 0.48 of a frame at 24 fps: rounds to 0
    expect(stillFrameAt(t, 30, 0)).toBe(1); // at 30 fps 1 cs is 0.3 of a frame (0), 2 cs is 0.6 (1)
    expect(stillFrameAt(t, 60, 0)).toBe(0);
    expect(stillFrameAt(t, 60, 1)).toBe(2);
    expect(stillFrameAt(t, 24, -3)).toBe(2); // the lead-in clones frame 0's picture
  });

  it("is a still for a one-frame image", () => {
    const one: StillTiming = { den: 100, pts: [0], period: 10, passes: Infinity };
    expect(run(one, 30, 40)).toBe("0".repeat(40));
  });

  it("agrees with a brute-force walk over every looped frame, for any timing", () => {
    const timing = fc
      .tuple(fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 8 }), fc.integer({ min: 1, max: 3 }))
      .map(([delays, passes]) => {
        const pts = delays.slice(0, -1).reduce((acc, d) => [...acc, acc[acc.length - 1] + d], [0]);
        return {
          den: 100,
          pts,
          period: delays.reduce((a, b) => a + b, 0),
          passes: passes === 3 ? Infinity : passes,
        } satisfies StillTiming;
      });
    fc.assert(
      fc.property(timing, fc.constantFrom(24, 25, 30, 60), fc.integer({ min: 0, max: 400 }), (t, fps, k) => {
        // Every (pass, frame) in order; the last one whose rounded start is not after k.
        let shown = 0;
        const passes = Number.isFinite(t.passes) ? t.passes : 1000;
        for (let L = 0; L < passes; L++)
          for (let i = 0; i < t.pts.length; i++) {
            const ticks = (2 * (L * t.period + t.pts[i]) * fps + t.den) / (2 * t.den);
            if (Math.floor(ticks) <= k) shown = i;
          }
        expect(stillFrameAt(t, fps, k)).toBe(shown);
      }),
    );
  });
});

// After a still's slot ends the export holds its stream's last frame: the frame in view at the
// end of its span. Measured on the shipped ffmpeg for 64 lengths x speeds (the GIF below, delays
// 7,13,5,20,7,9,9,7,13,1 cs): the last frame STARTING before the span's end, 64 of 64. The rule the
// preview used before (the frame at the last whole stream frame) was wrong in 16 of them.
const HELD: StillTiming = { den: 100, pts: [0, 7, 20, 25, 45, 52, 61, 70, 77, 90], period: 91, passes: Infinity };

describe("stillFrameBefore: the frame the export holds after a still's span", () => {
  it("matches every case the old rule got wrong (measured)", () => {
    const cases: Array<[number, number, number]> = [
      // [speed, slot length in frames at 30 fps, frame held]
      [2, 7, 4], [2, 31, 2], [2, 45, 3], [2, 90, 5],
      [1.15, 7, 3], [1.15, 13, 4], [1.15, 31, 3], [1.15, 90, 7],
      [1.5, 10, 4], [1.5, 31, 6], [1.25, 7, 3], [1.25, 13, 5],
      [3, 10, 1], [3, 30, 3], [3, 90, 8], [0.75, 31, 8],
    ];
    for (const [speed, len, held] of cases)
      expect(stillFrameBefore(HELD, len * speed * 100 / 30), `${speed}x ${len} frames`).toBe(held);
  });

  it("is the last frame of the last pass once a still that plays N times has played them", () => {
    const twice: StillTiming = { ...HELD, passes: 2 };
    expect(stillFrameBefore(twice, 91 * 5)).toBe(9);
    expect(stillFrameBefore(twice, 91 + 30)).toBe(3); // still inside pass 2
  });

  it("agrees with a brute-force walk, for any timing and span", () => {
    const timing = fc
      .tuple(fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 8 }), fc.integer({ min: 1, max: 3 }))
      .map(([delays, passes]) => ({
        den: 100,
        pts: delays.slice(0, -1).reduce((acc, d) => [...acc, acc[acc.length - 1] + d], [0]),
        period: delays.reduce((a, b) => a + b, 0),
        passes: passes === 3 ? Infinity : passes,
      }));
    fc.assert(
      fc.property(timing, fc.double({ min: 0.01, max: 2000, noNaN: true }), (t, end) => {
        let held = 0;
        const passes = Number.isFinite(t.passes) ? t.passes : 1000;
        for (let L = 0; L < passes; L++)
          for (let i = 0; i < t.pts.length; i++) if (L * t.period + t.pts[i] < end) held = i;
        expect(stillFrameBefore(t, end)).toBe(held);
      }),
    );
  });
});

describe("stillFrameShown: the frame a clip shows at a clip-relative project frame", () => {
  // One answer for the preview and for an inspect look: the frame the export shows there.
  const at = (k: number, len: number, speed = 1) => stillFrameShown(HELD, 30, k, len, speed);

  it("shows the export's frame inside the clip, at the clip's speed", () => {
    for (let k = 0; k < 90; k++) expect(at(k, 90)).toBe(stillFrameAt(HELD, 30, k));
    for (let k = 0; k < 45; k++) expect(at(k, 45, 2)).toBe(stillFrameAt(HELD, 30, Math.floor(k * 2 + 1e-6)));
  });

  it("shows its first frame before the clip (a lead-in) and holds the end-of-span frame after it", () => {
    expect(at(-4, 90)).toBe(stillFrameAt(HELD, 30, 0));
    expect(at(90, 90, 2)).toBe(stillFrameBefore(HELD, (90 * 2 * 100) / 30));
    expect(at(140, 7, 2)).toBe(4); // measured: 2x for 7 frames holds frame 4
  });
});

// The JSON ffprobe prints for `-show_entries stream=time_base,width,height:frame=pts,duration`,
// captured from the shipped build for the measured GIF.
const PROBED_GIF = {
  frames: [
    { pts: 0, duration: 7 },
    { pts: 7, duration: 13 },
    { pts: 20, duration: 5 },
    { pts: 25, duration: 20 },
    { pts: 45, duration: 7 },
    { pts: 52, duration: 1 },
  ],
  streams: [{ width: 240, height: 20, time_base: "1/100" }],
};

describe("timingFromProbe: a still's timing, as ffprobe reports it", () => {
  it("reads the frame starts, the time base and one pass", () => {
    expect(timingFromProbe(PROBED_GIF, Infinity)).toEqual({
      timing: IRREGULAR,
      w: 240,
      h: 20,
    });
  });

  // An APNG's stream time base is 1/100000 (apngdec.c): a delay of 7 cs is 7000 there.
  it("keeps the stream's own time base", () => {
    const apng = {
      frames: [
        { pts: 0, duration: 7000 },
        { pts: 7000, duration: 13000 },
      ],
      streams: [{ width: 8, height: 8, time_base: "1/100000" }],
    };
    expect(timingFromProbe(apng, 1)?.timing).toEqual({ den: 100000, pts: [0, 7000], period: 20000, passes: 1 });
  });

  it("measures from the first frame when the stream does not start at 0", () => {
    const shifted = { ...PROBED_GIF, frames: PROBED_GIF.frames.map((f) => ({ ...f, pts: f.pts + 30 })) };
    expect(timingFromProbe(shifted, Infinity)?.timing).toEqual(IRREGULAR);
  });

  // The failure direction: a timing the rule cannot use must never reach the preview as if it were
  // real. The caller then shows the still unmoving, which is what it showed before.
  it("refuses a timing it cannot trust", () => {
    const frames = PROBED_GIF.frames;
    const streams = PROBED_GIF.streams;
    expect(timingFromProbe({ frames: [], streams }, Infinity)).toBeNull();
    expect(timingFromProbe({ frames, streams: [] }, Infinity)).toBeNull();
    expect(timingFromProbe({ frames, streams: [{ ...streams[0], time_base: "0/100" }] }, Infinity)).toBeNull();
    expect(timingFromProbe({ frames, streams: [{ ...streams[0], time_base: "1/3.5" }] }, Infinity)).toBeNull();
    expect(timingFromProbe({ frames: [frames[1], frames[0]], streams }, Infinity)).toBeNull(); // out of order
    expect(timingFromProbe({ frames: [frames[0], { pts: 7 }], streams }, Infinity)).toBeNull(); // no last duration
    expect(timingFromProbe({ frames: [{ pts: "x", duration: 1 }], streams }, Infinity)).toBeNull();
    expect(timingFromProbe(null, Infinity)).toBeNull();
    expect(timingFromProbe({ frames, streams: [{ ...streams[0], width: 0 }] }, Infinity)).toBeNull();
  });

  // A GIF's packets past its picture count are what follows its last picture: they decode to
  // nothing, but the export's loop waits them out. Pictures come from the count, the pass from the
  // packets; a count that cannot be trusted never removes a frame.
  it("keeps a GIF's trailing packet in the pass and out of the pictures", () => {
    const frames = [...PROBED_GIF.frames, { pts: 53, duration: 10 }];
    const streams = [{ ...PROBED_GIF.streams[0], nb_frames: "6" }];
    expect(timingFromProbe({ frames, streams }, Infinity)?.timing).toEqual({ ...IRREGULAR, period: 63 });
    for (const nb_frames of [undefined, "N/A", "0", "7", "8", "-1", "5.5"]) {
      const s = [{ ...PROBED_GIF.streams[0], nb_frames }];
      expect(timingFromProbe({ frames, streams: s }, Infinity)?.timing.pts, `nb_frames ${nb_frames}`).toHaveLength(7);
    }
  });
});

describe("packSize: how large the preview's frames are", () => {
  it("keeps a small animation at its own size", () => {
    expect(packSize(30, 480, 270)).toEqual({ w: 480, h: 270 });
    expect(packSize(12, 32, 32)).toEqual({ w: 32, h: 32 }); // an emoji-sized icon
    expect(packSize(2, 1, 1)).toEqual({ w: 1, h: 1 });
  });

  it("never shrinks an animation that already fits", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 1024 }), fc.integer({ min: 1, max: 1024 }), (n, w, h) => {
        fc.pre(n * w * h <= 64e6);
        expect(packSize(n, w, h)).toEqual({ w, h });
      }),
    );
  });

  it("bounds the long edge, keeping the shape", () => {
    expect(packSize(10, 4000, 2000)).toEqual({ w: 1024, h: 512 });
    expect(packSize(10, 2000, 4000)).toEqual({ w: 512, h: 1024 });
  });

  // Every frame is decoded once and kept on disk; a long, big animation would be gigabytes.
  it("shrinks a long animation to a total pixel budget, and gives up below a usable size", () => {
    const s = packSize(2000, 1920, 1080)!;
    expect(s.w * s.h * 2000).toBeLessThanOrEqual(64e6);
    expect(s.w / s.h).toBeCloseTo(1920 / 1080, 1);
    expect(packSize(200000, 1920, 1080)).toBeNull();
  });

  it("never asks for more pixels than the budget, and never a zero side", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20000 }), fc.integer({ min: 1, max: 8000 }), fc.integer({ min: 1, max: 8000 }), (n, w, h) => {
        const s = packSize(n, w, h);
        if (!s) return;
        expect(s.w).toBeGreaterThanOrEqual(1);
        expect(s.h).toBeGreaterThanOrEqual(1);
        expect(s.w).toBeLessThanOrEqual(Math.max(w, 1));
        expect(s.h).toBeLessThanOrEqual(Math.max(h, 1));
        expect(Math.max(s.w, s.h)).toBeLessThanOrEqual(1024);
        expect(s.w * s.h * n).toBeLessThanOrEqual(64e6);
      }),
    );
  });
});

/** A minimal real-shaped PNG: signature, IHDR, IDAT of `idat` bytes, IEND (CRCs zero). */
const png = (idat: number): number[] => {
  const chunk = (type: string, len: number) => [0, 0, (len >> 8) & 255, len & 255, ...[...type].map((c) => c.charCodeAt(0)), ...new Array(len).fill(7), 0, 0, 0, 0];
  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", 13), ...chunk("IDAT", idat), ...chunk("IEND", 0)];
};

describe("splitPngStream: the frames ffmpeg wrote one after another", () => {
  it("finds each PNG by its own chunks", () => {
    const a = png(5);
    const b = png(300);
    const c = png(0);
    const stream = new Uint8Array([...a, ...b, ...c]);
    expect(splitPngStream(stream)).toEqual([
      [0, a.length],
      [a.length, a.length + b.length],
      [a.length + b.length, stream.length],
    ]);
  });

  // A torn or foreign file must not yield frames: the caller shows the still unmoving instead.
  it("returns nothing for a stream that is cut short or is not PNGs", () => {
    const whole = png(20);
    expect(splitPngStream(new Uint8Array(whole.slice(0, whole.length - 3)))).toBeNull();
    expect(splitPngStream(new Uint8Array([...whole, 1, 2, 3]))).toBeNull();
    expect(splitPngStream(new Uint8Array([0x47, 0x49, 0x46]))).toBeNull();
    expect(splitPngStream(new Uint8Array(0))).toBeNull();
  });

  it("never throws, whatever the bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (tail) => {
        expect(() => splitPngStream(new Uint8Array([...png(3), ...tail]))).not.toThrow();
      }),
    );
  });
});

describe("the pack's index: written by the generator, read back by the preview", () => {
  it("round-trips, a still that loops forever included", () => {
    for (const passes of [Infinity, 1, 3]) {
      const index = { timing: { ...IRREGULAR, passes }, w: 240, h: 20 };
      expect(parsePackIndex(serializePackIndex(index))).toEqual(index);
    }
  });

  // It is a file in the project, so it is read as untrusted input.
  it("refuses an index it cannot trust", () => {
    const good = JSON.parse(serializePackIndex({ timing: IRREGULAR, w: 240, h: 20 }));
    expect(parsePackIndex("not json")).toBeNull();
    expect(parsePackIndex(JSON.stringify({ ...good, v: 99 }))).toBeNull();
    expect(parsePackIndex(JSON.stringify({ ...good, pts: [0, 9, 3] }))).toBeNull();
    expect(parsePackIndex(JSON.stringify({ ...good, period: 52 }))).toBeNull(); // before the last start
    expect(parsePackIndex(JSON.stringify({ ...good, passes: -1 }))).toBeNull();
    expect(parsePackIndex(JSON.stringify({ ...good, den: 0 }))).toBeNull();
    expect(parsePackIndex(JSON.stringify({ ...good, w: 0 }))).toBeNull();
  });
});
