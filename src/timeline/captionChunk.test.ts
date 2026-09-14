// The chunker decides what a viewer reads. Two invariants carry the feature, and both are
// stated as properties rather than examples: every word survives (a caption track that quietly
// drops speech is worse than none, because nobody re-reads their own video to check), and the
// placed spans never overlap (validateTimeline REFUSES an overlapping track, so a rounding
// collision between two words would reject the entire edit).
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { applyCase, chunkWords, fitSpans, type CaptionWord } from "./captionChunk";

const w = (text: string, start: number, end: number): CaptionWord => ({ text, start, end });

/** Timed words from a sentence, one word every 0.5s. */
const timed = (sentence: string): CaptionWord[] =>
  sentence.split(" ").map((t, i) => w(t, i * 0.5, i * 0.5 + 0.4));

const wordArb = fc
  .array(fc.stringMatching(/^[a-zA-Z.,!?]{1,12}$/), { minLength: 1, maxLength: 60 })
  .map((tokens) => tokens.map((t, i) => w(t, i, i + 0.9)));

describe("chunkWords", () => {
  it("never loses or reorders a word, whatever the caps", () => {
    fc.assert(
      fc.property(
        wordArb,
        fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined }),
        fc.option(fc.integer({ min: 1, max: 40 }), { nil: undefined }),
        (words, maxWords, maxCharacters) => {
          const flat = chunkWords(words, { maxWords, maxCharacters }).flatMap((p) => p.words);
          expect(flat.map((x) => x.text)).toEqual(words.map((x) => x.text));
        },
      ),
    );
  });

  it("respects both caps together, except for one over-long word", () => {
    fc.assert(
      fc.property(
        wordArb,
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 30 }),
        (words, maxWords, maxCharacters) => {
          for (const p of chunkWords(words, { maxWords, maxCharacters })) {
            expect(p.words.length).toBeLessThanOrEqual(maxWords);
            // A single word wider than the cap is emitted alone rather than split or dropped.
            if (p.words.length > 1) expect(p.text.length).toBeLessThanOrEqual(maxCharacters);
          }
        },
      ),
    );
  });

  it("breaks at a sentence end even when there is room left", () => {
    // The failure direction: filling to the cap starts a new sentence mid-caption, which is
    // what makes auto-captions read as machine-made.
    expect(chunkWords(timed("Hi there. How are you"), { maxWords: 5 }).map((p) => p.text)).toEqual([
      "Hi there.",
      "How are you",
    ]);
  });

  it("carries the phrase's own start and end from its words", () => {
    const [first] = chunkWords(timed("one two three"), { maxWords: 2 });
    expect([first.start, first.end]).toEqual([0, 0.9]);
  });

  it("emits a word longer than the character cap instead of hanging", () => {
    const out = chunkWords([w("extraordinarily", 0, 1), w("so", 1, 2)], { maxCharacters: 4 });
    expect(out.map((p) => p.text)).toEqual(["extraordinarily", "so"]);
  });

  it("returns nothing for no words", () => {
    expect(chunkWords([])).toEqual([]);
  });
});

describe("fitSpans", () => {
  const fit = (spans: Array<[number, number]>, maxGapFrames = 0, limit = 10_000) =>
    fitSpans(
      spans.map(([i, o]) => ({ in: i, out: o })),
      { maxGapFrames, limit },
    ).map((s) => [s.in, s.out]);

  it("never emits overlapping or empty spans", () => {
    // This is the one that would reject the whole edit at validateTimeline.
    fc.assert(
      fc.property(
        fc
          .array(fc.tuple(fc.integer({ min: 0, max: 300 }), fc.integer({ min: 1, max: 40 })), {
            maxLength: 30,
          })
          .map((rows) =>
            rows
              .map(([start, len]) => ({ in: start, out: start + len }))
              .sort((a, b) => a.in - b.in),
          ),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 400 }),
        (spans, maxGapFrames, limit) => {
          const out = fitSpans(spans, { maxGapFrames, limit });
          for (const s of out) {
            expect(s.out).toBeGreaterThan(s.in);
            expect(s.out).toBeLessThanOrEqual(limit);
          }
          for (let i = 1; i < out.length; i++)
            expect(out[i].in).toBeGreaterThanOrEqual(out[i - 1].out);
        },
      ),
    );
  });

  it("holds an earlier caption across a short gap rather than blinking off", () => {
    expect(
      fit(
        [
          [0, 30],
          [36, 60],
        ],
        10,
      ),
    ).toEqual([
      [0, 36],
      [36, 70],
    ]);
  });

  it("leaves a long gap alone", () => {
    // The opposite direction: closing every gap would leave a caption on screen through
    // silence it has nothing to do with.
    expect(
      fit(
        [
          [0, 30],
          [200, 230],
        ],
        10,
      )[0],
    ).toEqual([0, 30]);
  });

  it("shortens the earlier caption when two words collide", () => {
    expect(
      fit([
        [0, 40],
        [30, 60],
      ]),
    ).toEqual([
      [0, 30],
      [30, 60],
    ]);
  });

  it("holds the final caption, but never past the limit", () => {
    expect(fit([[0, 30]], 15, 40)).toEqual([[0, 40]]);
  });

  it("drops a caption squeezed out of existence rather than emitting a zero-length clip", () => {
    expect(
      fit([
        [10, 20],
        [10, 40],
      ]),
    ).toEqual([[10, 40]]);
  });

  it("drops spans that start past the limit", () => {
    expect(
      fit(
        [
          [0, 30],
          [500, 530],
        ],
        0,
        100,
      ),
    ).toEqual([[0, 30]]);
  });
});

describe("applyCase", () => {
  it("uppercases, lowercases, and leaves anything else alone", () => {
    expect(applyCase("Hi there", "upper")).toBe("HI THERE");
    expect(applyCase("Hi There", "lower")).toBe("hi there");
    expect(applyCase("Hi There", undefined)).toBe("Hi There");
    expect(applyCase("Hi There", "auto")).toBe("Hi There");
  });
});
