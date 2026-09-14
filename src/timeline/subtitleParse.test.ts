// Someone else's file, so both directions matter: nothing injectable survives into the caption
// (it ends up inside an ASS line at export), and nothing legitimate is silently dropped — a
// track missing every line containing "<" looks like it worked, which is worse than a refusal.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseSubtitles, SubtitleParseError, subtitleFormat } from "./subtitleParse";

const SRT = `1
00:00:01,000 --> 00:00:02,500
Hello.

2
00:00:03,000 --> 00:00:04,000
World.
`;

const VTT = `WEBVTT

NOTE this is a comment
that runs on

00:00:01.000 --> 00:00:02.500 line:90%
Hello.

cue-id
00:00:03.000 --> 00:00:04.000
World.
`;

describe("parseSubtitles", () => {
  it("reads SRT cues with their timings", () => {
    expect(parseSubtitles(SRT, "srt")).toEqual([
      { text: "Hello.", start: 1, end: 2.5 },
      { text: "World.", start: 3, end: 4 },
    ]);
  });

  it("reads WebVTT, skipping NOTE blocks, cue ids and cue settings", () => {
    expect(parseSubtitles(VTT, "vtt")).toEqual([
      { text: "Hello.", start: 1, end: 2.5 },
      { text: "World.", start: 3, end: 4 },
    ]);
  });

  it("accepts WebVTT's two-part MM:SS.mmm timing", () => {
    const cues = parseSubtitles("WEBVTT\n\n01:02.500 --> 01:04.000\nLate.\n", "vtt");
    expect([cues[0].start, cues[0].end]).toEqual([62.5, 64]);
  });

  it("keeps multi-line cue text as separate lines", () => {
    const cues = parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\nfirst\nsecond\n", "srt");
    expect(cues[0].text).toBe("first\nsecond");
  });

  it("strips markup but keeps the words", () => {
    const cues = parseSubtitles(
      "1\n00:00:01,000 --> 00:00:02,000\n<i>Hello</i> <b>there</b>\n",
      "srt",
    );
    expect(cues[0].text).toBe("Hello there");
  });

  it("strips SSA position overrides", () => {
    const cues = parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\n{\\an8}Top.\n", "srt");
    expect(cues[0].text).toBe("Top.");
  });

  it("does NOT eat arithmetic that merely looks like a tag", () => {
    // The dropped-legitimate-text direction. "5 < 6" is not markup.
    const cues = parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\n5 < 6 and 7 > 2\n", "srt");
    expect(cues[0].text).toBe("5 < 6 and 7 > 2");
  });

  it("orders cues by time even when the file does not", () => {
    const cues = parseSubtitles(
      "1\n00:00:05,000 --> 00:00:06,000\nlater\n\n2\n00:00:01,000 --> 00:00:02,000\nearlier\n",
      "srt",
    );
    expect(cues.map((c) => c.text)).toEqual(["earlier", "later"]);
  });

  it("tolerates a BOM and CRLF line endings", () => {
    const cues = parseSubtitles(`\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nHi.\r\n`, "srt");
    expect(cues[0].text).toBe("Hi.");
  });

  it("refuses a WebVTT file with no header rather than half-reading it", () => {
    expect(() => parseSubtitles("00:00:01.000 --> 00:00:02.000\nHi.\n", "vtt")).toThrow(
      SubtitleParseError,
    );
  });

  it("refuses garbage instead of returning zero captions", () => {
    // Returning [] here is the silent-success failure: the user would see an empty track.
    expect(() => parseSubtitles("garbage --> nonsense\nBroken.\n", "srt")).toThrow(
      SubtitleParseError,
    );
    expect(() => parseSubtitles("", "srt")).toThrow(/no captions/i);
  });

  it("refuses a cue that ends before it starts", () => {
    expect(() => parseSubtitles("1\n00:00:05,000 --> 00:00:01,000\nBackwards.\n", "srt")).toThrow(
      /ends at or before/i,
    );
  });

  it("never emits a cue containing a tag or an unescaped brace override", () => {
    // Pinned counterexamples: the fuzz found `{\` only on ~1 run in 10 (seed 1885435009), so it
    // read as a flaky test rather than the real hole it was — an UNTERMINATED override was kept
    // because the strip rule demanded a closing brace.
    for (const body of ["{\\", "{\\an8", "{\\an8}hi", "a{\\b", "{\\}"]) {
      let cues;
      try {
        cues = parseSubtitles(`1\n00:00:01,000 --> 00:00:02,000\n${body}\n`, "srt");
      } catch {
        continue; // refusing is acceptable; emitting the opener is not
      }
      for (const c of cues) expect(c.text, body).not.toMatch(/\{\\/);
    }
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (body) => {
        let cues;
        try {
          cues = parseSubtitles(`1\n00:00:01,000 --> 00:00:02,000\n${body}\n`, "srt");
        } catch {
          return; // refusing is always acceptable; emitting markup is not
        }
        for (const c of cues) {
          expect(c.text).not.toMatch(/<\/?[a-zA-Z][^>]*>/);
          expect(c.text).not.toMatch(/\{\\/);
        }
      }),
    );
  });

  it("never emits a cue whose end is not after its start", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: 500 }), fc.nat({ max: 500 })), { maxLength: 12 }),
        (pairs) => {
          const body = pairs
            .map(
              ([a, b], i) =>
                `${i + 1}\n00:00:${String(a % 60).padStart(2, "0")},000 --> 00:00:${String(
                  b % 60,
                ).padStart(2, "0")},000\nline${i}\n`,
            )
            .join("\n");
          let cues;
          try {
            cues = parseSubtitles(body, "srt");
          } catch {
            return;
          }
          for (const c of cues) expect(c.end).toBeGreaterThan(c.start);
        },
      ),
    );
  });
});

describe("subtitleFormat", () => {
  it("recognises the two formats and nothing else", () => {
    expect(subtitleFormat("a.srt")).toBe("srt");
    expect(subtitleFormat("a.VTT")).toBe("vtt");
    expect(subtitleFormat("a.mp4")).toBeNull();
    expect(subtitleFormat("srt")).toBeNull();
  });
});
