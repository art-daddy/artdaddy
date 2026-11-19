// The ffmpeg -progress parser. A new pure module, so: properties over its invariants, and the
// failure directions that a naive line-splitter gets wrong — chunk boundaries mid-line, mid-block,
// and mid-number; ffmpeg's `N/A` before the first frame; and the out_time_ms microseconds trap.
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { formatActivityMark } from "./exportActivity";
import {
  createProgressReader,
  createSequenceProgressReader,
  etaSeconds,
  formatEta,
  hhmmssToMs,
  newestProgressBlock,
  parseProgressBlocks,
  progressFraction,
  type RenderProgress,
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

  // Found by review: the app process says "still checking the sources" on the job's output while it hashes them,
  // and a streamed render hashes at every worker start while the final encoder is already printing. The beat is a
  // line of its own, but it arrives between two reads of ffmpeg's stream, which can end in the middle of a line:
  // glued in, it would turn `out_time_us` into noise and lose that block's position.
  it("is not damaged by the app process's heartbeat landing anywhere in ffmpeg's stream", () => {
    const stream = block({ frame: 30 }) + block({ frame: 60 }) + block({ frame: 90 }, true);
    const beat = "artdaddy_verify=12345\n";
    const expected = [
      { frame: 30, outMs: 4000 },
      { frame: 60, outMs: 4000 },
      { frame: 90, outMs: 4000 },
    ];
    for (let at = 0; at <= stream.length; at++) {
      const plain: { frame: number; outMs: number }[] = [];
      const feed = createProgressReader((r) => plain.push({ frame: r.frame, outMs: r.outMs }));
      feed(stream.slice(0, at));
      feed(beat);
      feed(stream.slice(at));
      expect(plain, `a beat after byte ${at}`).toEqual(expected);
      const sequenced: { frame: number; outMs: number }[] = [];
      const sequence = createSequenceProgressReader([4, 4, 4], (r) =>
        sequenced.push({ frame: r.frame, outMs: r.outMs }),
      );
      sequence(stream.slice(0, at));
      sequence(beat);
      sequence(stream.slice(at));
      expect(
        sequenced.map((r) => r.frame),
        `a beat after byte ${at} (sequence)`,
      ).toEqual([30, 60, 90]);
    }
  });
});

describe("createSequenceProgressReader", () => {
  it("reports cumulative work and finishes only after final assembly, regardless of chunk boundaries", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 2, maxLength: 6 }),
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 30 }),
        (durations, sizes) => {
          const records: Array<{ outMs: number; done: boolean }> = [];
          const feed = createSequenceProgressReader(durations, (record) => records.push(record));
          const stream = durations
            .map(
              (duration, index) =>
                `artdaddy_step=${index}\r\n${block({ out_time_us: duration * 1_000_000 }, true)}`,
            )
            .join("");
          let offset = 0;
          let part = 0;
          while (offset < stream.length) {
            const size = sizes[part++ % sizes.length];
            feed(stream.slice(offset, offset + size));
            offset += size;
          }
          expect(records).toHaveLength(durations.length);
          expect(records.map((record) => record.done)).toEqual(
            durations.map((_, index) => index === durations.length - 1),
          );
          expect(records.map((record) => record.outMs)).toEqual(
            durations.map((_, index) =>
              durations.slice(0, index + 1).reduce((total, duration) => total + duration * 1000, 0),
            ),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("resumes at the native job's current step rather than restarting at zero", () => {
    const seen: number[] = [];
    const feed = createSequenceProgressReader([2, 3, 5], (record) => seen.push(record.outMs));
    feed("artdaddy_step=2\n");
    feed(block({ out_time_us: 1_000_000 }));
    expect(seen).toEqual([6000]);
  });

  it("says which part of the sequence each record belongs to, and how many parts there are", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 2, maxLength: 8 }),
        (durations) => {
          const records: Array<{ step?: number; steps?: number }> = [];
          const feed = createSequenceProgressReader(durations, (record) => records.push(record));
          for (let index = 0; index < durations.length; index++) {
            feed(`artdaddy_step=${index}\n`);
            feed(block({ out_time_us: 500_000 }));
          }
          expect(records.map((record) => record.step)).toEqual(durations.map((_, index) => index));
          expect(records.every((record) => record.steps === durations.length)).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("leaves the parts out of a plain (not sequenced) reader", () => {
    const seen: Array<{ step?: number; steps?: number }> = [];
    const feed = createProgressReader((record) => seen.push(record));
    feed(block({ out_time_us: 1_000_000 }));
    expect(seen[0].step).toBeUndefined();
    expect(seen[0].steps).toBeUndefined();
  });
});

// The app process also prints the export's processor and disk use on the job's output, one `artdaddy_cpu=` line every few
// seconds (exportActivity.ts). Like the verification beat it is a chunk of its own on the wire and lands between two
// reads of ffmpeg's stream, so a reader must give the very same records with it anywhere as without it. The streams are
// built from the real text shape above; the expected records are what the reader says WITHOUT any mark.
describe("an activity mark in the job's output", () => {
  const mark = formatActivityMark({ cpuMs: 123_456, readBytes: 7_890_123 });
  const lf = block({ frame: 30 }) + block({ frame: 60 }) + block({ frame: 90 }, true);
  const crlf = lf.replace(/\n/g, "\r\n"); // what ffmpeg writes on Windows
  const steps = [0, 1, 2]
    .map((step) => `artdaddy_step=${step}\r\n${block({ frame: 30 * (step + 1) }, true)}`)
    .join("");
  const stepsLf = steps.replace(/\r\n/g, "\n"); // as the app process prints the step line itself

  const readPlain = (chunks: readonly string[]): RenderProgress[] => {
    const records: RenderProgress[] = [];
    const feed = createProgressReader((record) => records.push(record));
    for (const chunk of chunks) feed(chunk);
    return records;
  };
  const readSequence = (chunks: readonly string[]): RenderProgress[] => {
    const records: RenderProgress[] = [];
    const feed = createSequenceProgressReader([4, 4, 4], (record) => records.push(record));
    for (const chunk of chunks) feed(chunk);
    return records;
  };
  const cases = [
    { name: "progress blocks", text: lf, read: readPlain },
    { name: "progress blocks, CRLF", text: crlf, read: readPlain },
    { name: "a three-step sequence", text: steps, read: readSequence },
    { name: "a three-step sequence, LF", text: stepsLf, read: readSequence },
    { name: "a three-step sequence read as plain progress", text: steps, read: readPlain },
  ];

  it("gives the same records with the mark between two chunks or glued into one, at EVERY byte offset", () => {
    for (const { name, text, read } of cases) {
      const reference = read([text]);
      expect(reference, `${name}: the reference reads the stream`).toHaveLength(3);
      for (let at = 0; at <= text.length; at++) {
        expect(
          read([text.slice(0, at), mark, text.slice(at)]),
          `${name}, a mark after byte ${at}`,
        ).toEqual(reference);
        expect(
          read([text.slice(0, at) + mark + text.slice(at)]),
          `${name}, a mark in byte ${at}`,
        ).toEqual(reference);
      }
    }
  });

  it("gives the same records with marks at any places in a stream cut into chunks anywhere (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...cases),
        fc.array(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 30 }),
        fc.array(fc.record({ at: fc.nat(1_000), alone: fc.boolean() }), {
          minLength: 1,
          maxLength: 6,
        }),
        ({ text, read }, sizes, marks) => {
          // Where the stream is cut, and where each mark goes in it: at a position of the original text (so never inside
          // another mark), glued into the chunk being built or as a chunk of its own.
          const cuts = new Set<number>();
          for (let at = 0, i = 0; at < text.length; i++) {
            at += sizes[i % sizes.length];
            cuts.add(at);
          }
          const chunks: string[] = [];
          let current = "";
          for (let position = 0; position <= text.length; position++) {
            for (const { at, alone } of marks) {
              if (at % (text.length + 1) !== position) continue;
              if (alone) {
                if (current) chunks.push(current);
                current = "";
                chunks.push(mark);
              } else current += mark;
            }
            if (position === text.length) break;
            current += text[position];
            if (cuts.has(position + 1)) {
              chunks.push(current);
              current = "";
            }
          }
          if (current) chunks.push(current);
          expect(read(chunks)).toEqual(read([text]));
        },
      ),
      { numRuns: 400 },
    );
  });

  it("gives the same records for a tail that was cut anywhere through a mark, as an adopted export reads one", () => {
    for (const { name, text, read } of cases) {
      const reference = read([text]);
      for (let cut = 0; cut <= mark.length; cut++)
        expect(read([(mark + text).slice(cut)]), `${name}, a tail cut ${cut} bytes in`).toEqual(
          reference,
        );
    }
  });

  it("says nothing for a chunk that is only a mark, and keeps what it had", () => {
    const records: RenderProgress[] = [];
    const feed = createProgressReader((record) => records.push(record));
    feed(lf.slice(0, 100));
    feed(mark);
    expect(records).toEqual([]);
    feed(lf.slice(100));
    expect(records.map((record) => record.frame)).toEqual([30, 60, 90]);
  });
});

// A page that takes an export over after a reload is handed what the app process kept of the job's output, up to 64 KiB (some 280 blocks), in one go. All it needs is where the render is now: the
// newest whole block (a render made in parts also gets its step line from the caller). The streams are built from the real block text above, and every outcome is what a reader makes of the cut,
// set against what the same reader makes of the whole output.
describe("newestProgressBlock", () => {
  const run = (count: number, crlf = false, first = 1): string => {
    const text = Array.from({ length: count }, (_, index) => {
      const n = first + index;
      return block({ frame: n * 15, out_time_us: n * 500_000, speed: "1.0" });
    }).join("");
    return crlf ? text.replace(/\n/g, "\r\n") : text;
  };
  const readAll = (text: string): RenderProgress[] => {
    const records: RenderProgress[] = [];
    createProgressReader((record) => records.push(record))(text);
    return records;
  };

  it("leaves a reader the newest block's record and no other, however long the output was (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 300 }),
        fc.integer({ min: 0, max: 150 }),
        fc.boolean(),
        fc.constantFrom("", "frame=7\nfps=30.00\n", "frame=7\nfps=30.00\nout_time_us=12"),
        (count, cut, crlf, unfinished) => {
          // `cut` starts the output inside its first block, as a tail cut at a byte count does.
          const text = run(count, crlf).slice(cut) + unfinished;
          const kept = newestProgressBlock(text);
          expect(text.endsWith(kept)).toBe(true);
          expect(kept.length).toBe(run(1, crlf, count).length + unfinished.length);
          expect(readAll(kept)).toEqual(readAll(text).slice(-1));
          expect(readAll(kept)).toHaveLength(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("returns the output as it is when it holds fewer than two whole blocks", () => {
    const one = run(1);
    for (const text of ["", "noise\n", one, one.slice(0, -1), one + "frame=9\n", "frame=9\n" + one])
      expect(newestProgressBlock(text), JSON.stringify(text.slice(-30))).toBe(text);
  });

  it("does not take a line that only ends in 'progress' for the end of a block", () => {
    const text = run(2) + "sub_progress=continue\n";
    expect(readAll(newestProgressBlock(text))[0]).toEqual(readAll(run(2))[1]);
  });

  it("reads a render made in parts as the whole output read it: the newest record, in the part it belongs to (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 2, maxLength: 5 }),
        fc.boolean(),
        (counts, crlf) => {
          const eol = (text: string) => (crlf ? text.replace(/\n/g, "\r\n") : text);
          // One block a second in each part, as `counts[step]` seconds long; the app process prints the step line itself.
          const pieces = counts.flatMap((count, step) =>
            Array.from({ length: count }, (_, index) => ({
              step,
              text:
                (index === 0 ? `artdaddy_step=${step}\n` : "") +
                eol(
                  block(
                    { frame: (index + 1) * 30, out_time_us: (index + 1) * 1_000_000 },
                    index === count - 1,
                  ),
                ),
            })),
          );
          const readParts = (chunks: readonly string[]): RenderProgress[] => {
            const records: RenderProgress[] = [];
            const feed = createSequenceProgressReader(counts, (record) => records.push(record));
            for (const chunk of chunks) feed(chunk);
            return records;
          };
          for (let upTo = 1; upTo <= pieces.length; upTo++) {
            const text = pieces
              .slice(0, upTo)
              .map((piece) => piece.text)
              .join("");
            const joined = readParts([
              `artdaddy_step=${pieces[upTo - 1].step}\n`,
              newestProgressBlock(text),
            ]);
            expect(joined, `${upTo} blocks`).toEqual(readParts([text]).slice(-1));
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("still leaves the newest block's record when the app process's mark lands anywhere in the output, even inside a line", () => {
    const mark = formatActivityMark({ cpuMs: 123_456, readBytes: 7_890_123 });
    for (const crlf of [false, true]) {
      const text = run(4, crlf);
      const newest = readAll(text).at(-1);
      for (let at = 0; at <= text.length; at++) {
        const records = readAll(newestProgressBlock(text.slice(0, at) + mark + text.slice(at)));
        expect(records.at(-1), `crlf ${crlf}, a mark in byte ${at}`).toEqual(newest);
        // A mark inside the word `progress` hides one block's end, so one more block may come along; never the minutes before it.
        expect(records.length).toBeLessThanOrEqual(2);
      }
    }
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
