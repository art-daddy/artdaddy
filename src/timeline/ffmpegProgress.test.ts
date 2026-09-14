// The ffmpeg -progress parser. A new pure module, so: properties over its invariants, and the
// failure directions that a naive line-splitter gets wrong — chunk boundaries mid-line, mid-block,
// and mid-number; ffmpeg's `N/A` before the first frame; and the out_time_ms microseconds trap.
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import {
  createProgressReader,
  etaSeconds,
  formatEta,
  hhmmssToMs,
  parseProgressBlocks,
  progressFraction,
} from "./ffmpegProgress";

/** A real block, as ffmpeg writes it. */
const block = (o: Partial<Record<string, string | number>> = {}, end = false) =>
  [
    `frame=${o.frame ?? 120}`,
    `fps=${o.fps ?? 48.5}`,
    `stream_0_0_q=28.0`,
    `bitrate=1234.5kbits/s`,
    `total_size=98765`,
    `out_time_us=${o.out_time_us ?? 4_000_000}`,
    `out_time_ms=${o.out_time_us ?? 4_000_000}`,
    `out_time=${o.out_time ?? "00:00:04.000000"}`,
    `dup_frames=0`,
    `drop_frames=0`,
    `speed=${o.speed ?? "1.5"}x`,
    `progress=${end ? "end" : "continue"}`,
    "",
  ].join("\n");

describe("parseProgressBlocks", () => {
  it("reads one complete block", () => {
    const { records, rest } = parseProgressBlocks(block());
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ frame: 120, fps: 48.5, outMs: 4000, speed: 1.5, done: false });
    expect(rest).toBe("");
  });

  it("treats out_time_ms as MICROseconds, which is what ffmpeg actually sends", () => {
    // The trap: ffmpeg's `out_time_ms` has carried microseconds for years. Reading it as
    // milliseconds makes a 4-second render report 4000 SECONDS done, so the bar pins at 100%
    // one frame in and the ETA is nonsense.
    const { records } = parseProgressBlocks(block({ out_time_us: 4_000_000 }));
    expect(records[0].outMs).toBe(4000);
  });

  it("keeps an unfinished block as the remainder rather than emitting half of it", () => {
    const text = block() + "frame=240\nfps=50\n";
    const { records, rest } = parseProgressBlocks(text);
    expect(records).toHaveLength(1);
    expect(rest).toBe("frame=240\nfps=50\n");
  });

  it("reads several blocks out of one chunk", () => {
    const { records } = parseProgressBlocks(block({ frame: 30 }) + block({ frame: 60 }, true));
    expect(records.map((r) => r.frame)).toEqual([30, 60]);
    expect(records.map((r) => r.done)).toEqual([false, true]);
  });

  it("does not let one block's fields leak into the next", () => {
    // A parser that never resets its field map reports the previous speed forever once ffmpeg
    // stops sending one.
    const first = block({ speed: "2.0" });
    const second = "frame=300\nout_time_us=9000000\nprogress=continue\n";
    const { records } = parseProgressBlocks(first + second);
    expect(records[1]).toEqual({ frame: 300, fps: 0, outMs: 9000, speed: 0, done: false });
  });

  it("survives ffmpeg's N/A placeholders before the first frame lands", () => {
    const { records } = parseProgressBlocks(
      "frame=0\nfps=0.0\nout_time_us=N/A\nout_time=N/A\nspeed=N/A\nprogress=continue\n",
    );
    expect(records[0]).toEqual({ frame: 0, fps: 0, outMs: 0, speed: 0, done: false });
  });

  it("falls back to out_time when the microsecond fields are absent", () => {
    const { records } = parseProgressBlocks("out_time=00:01:30.500000\nprogress=continue\n");
    expect(records[0].outMs).toBe(90_500);
  });

  it("ignores noise that is not key=value", () => {
    const { records } = parseProgressBlocks(
      "ffmpeg version 6.0\n  built with gcc\nframe=10\nout_time_us=1000000\nprogress=continue\n",
    );
    expect(records).toHaveLength(1);
    expect(records[0].frame).toBe(10);
  });

  it("handles CRLF, which is what ffmpeg writes on Windows", () => {
    // This is the platform we ship on. Without trimming, `progress=end\r` never equals "end",
    // so the render would appear to run forever and the dialog would never say it finished.
    const crlf = block({ frame: 90 }, true).replace(/\n/g, "\r\n");
    const { records } = parseProgressBlocks(crlf);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ frame: 90, fps: 48.5, outMs: 4000, speed: 1.5, done: true });
  });
});

describe("createProgressReader", () => {
  it("reassembles blocks split at EVERY byte boundary (property)", () => {
    // The real failure mode: a chunk arrives mid-line, or mid-number. However the stream is
    // diced, the reader must produce exactly the same records.
    const stream = block({ frame: 30 }) + block({ frame: 60 }) + block({ frame: 90 }, true);
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 60 }),
        (sizes) => {
          const seen: number[] = [];
          const feed = createProgressReader((r) => seen.push(r.frame));
          let i = 0;
          while (i < stream.length) {
            const n = sizes[i % sizes.length];
            feed(stream.slice(i, i + n));
            i += n;
          }
          expect(seen).toEqual([30, 60, 90]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("emits nothing until a block is complete", () => {
    const onRecord = vi.fn();
    const feed = createProgressReader(onRecord);
    feed("frame=10\nfps=25\nout_time_us=500000\n");
    expect(onRecord).not.toHaveBeenCalled();
    feed("progress=continue\n");
    expect(onRecord).toHaveBeenCalledTimes(1);
  });

  it("bounds its buffer against a producer that never sends a newline, without wedging", () => {
    // Two things at once: memory must not grow forever, and a block arriving AFTER the garbage
    // must still parse. A cap that trimmed unconditionally would eat live blocks instead.
    const seen: number[] = [];
    const feed = createProgressReader((r) => seen.push(r.frame));
    for (let i = 0; i < 30; i++) feed("x".repeat(5000)); // 150k of newline-free noise
    feed("\n" + block({ frame: 7 }));
    expect(seen).toEqual([7]);

    // ...and a block larger than the trim window still survives when it arrives whole.
    const seen2: number[] = [];
    const feed2 = createProgressReader((r) => seen2.push(r.frame));
    feed2(block({ frame: 11 }));
    expect(seen2).toEqual([11]);
  });
});

describe("hhmmssToMs", () => {
  it("reads ffmpeg's timestamp form", () => {
    expect(hhmmssToMs("00:00:04.000000")).toBe(4000);
    expect(hhmmssToMs("01:02:03.5")).toBe(3_723_500);
    expect(hhmmssToMs("N/A")).toBe(0);
    expect(hhmmssToMs(undefined)).toBe(0);
  });
});

describe("progressFraction", () => {
  it("is 0 at the start and 1 at the end", () => {
    expect(progressFraction(0, 10_000)).toBe(0);
    expect(progressFraction(5_000, 10_000)).toBe(0.5);
    expect(progressFraction(10_000, 10_000)).toBe(1);
  });

  it("never exceeds 1, even though ffmpeg overshoots the nominal duration", () => {
    expect(progressFraction(10_040, 10_000)).toBe(1);
  });

  it("reports 0 rather than guessing when the total is unknown", () => {
    expect(progressFraction(5_000, 0)).toBe(0);
  });

  it("stays within 0..1 and never goes backwards as output grows (property)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e7, noNaN: true }),
        fc.double({ min: 0, max: 1e7, noNaN: true }),
        fc.double({ min: 1, max: 1e7, noNaN: true }),
        (a, up, total) => {
          const lo = progressFraction(a, total);
          const hi = progressFraction(a + up, total);
          expect(lo).toBeGreaterThanOrEqual(0);
          expect(hi).toBeLessThanOrEqual(1);
          expect(hi).toBeGreaterThanOrEqual(lo);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("etaSeconds", () => {
  it("divides the remaining output by the encoding speed", () => {
    expect(etaSeconds(2_000, 10_000, 2)).toBe(4); // 8s left at 2x
  });

  it("says nothing rather than guessing when speed or total is unknown", () => {
    expect(etaSeconds(2_000, 10_000, 0)).toBeNull();
    expect(etaSeconds(2_000, 0, 1.5)).toBeNull();
  });

  it("is 0 once the output has caught up, never negative", () => {
    expect(etaSeconds(12_000, 10_000, 1.5)).toBe(0);
  });
});

describe("formatEta", () => {
  it("reads as a duration a human would say", () => {
    expect(formatEta(45)).toBe("45s");
    expect(formatEta(125)).toBe("2m 05s");
    expect(formatEta(0)).toBe("0s");
  });

  it("switches to minutes at exactly a minute", () => {
    expect(formatEta(59)).toBe("59s");
    expect(formatEta(60)).toBe("1m 00s");
  });

  it("shows nothing when there is nothing to say", () => {
    expect(formatEta(null)).toBe("");
    expect(formatEta(NaN)).toBe("");
    expect(formatEta(-1)).toBe("");
  });
});
