// The chunker decides what a viewer reads. Two invariants carry the feature, and both are
// stated as properties rather than examples: every word survives (a caption track that quietly
// drops speech is worse than none, because nobody re-reads their own video to check), and the
// placed spans never overlap (validateTimeline REFUSES an overlapping track, so a rounding
// collision between two words would reject the entire edit).
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { applyCase, chunkWords, fitSpans, type CaptionWord } from "./captionChunk";
import { lineWidthPx } from "./fontMetrics";

const w = (text: string, start: number, end: number, segment?: number): CaptionWord => ({
  text,
  start,
  end,
  segment,
});

/** Timed words from a sentence, one word every 0.5s. */
const timed = (sentence: string): CaptionWord[] =>
  sentence.split(" ").map((t, i) => w(t, i * 0.5, i * 0.5 + 0.4));

/** A line that holds `n` characters. The real one measures the drawn width; any rule will do here. */
const upTo =
  (n: number) =>
  (text: string): boolean =>
    text.length <= n;
const always = (): boolean => true;

const SENTENCE_END = /[.!?…。！？।॥؟۔]["')\]」』]?$/;

const wordArb = fc
  .array(fc.tuple(fc.stringMatching(/^[a-zA-Z.,;!?]{1,12}$/), fc.integer({ min: 0, max: 3 })), {
    minLength: 1,
    maxLength: 60,
  })
  .map((tokens) => {
    // Segments come in order, as a transcript's do.
    let seg = 0;
    return tokens.map(([t, bump], i) => w(t, i, i + 0.9, (seg += bump === 3 ? 1 : 0)));
  });

describe("chunkWords: a caption is as long as fits one line (UJ-030, Palmier's rule)", () => {
  it("never loses or reorders a word, whatever the line or the caps", () => {
    fc.assert(
      fc.property(
        wordArb,
        fc.integer({ min: 1, max: 60 }),
        fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined }),
        fc.option(fc.integer({ min: 1, max: 40 }), { nil: undefined }),
        (words, line, maxWords, maxCharacters) => {
          const out = chunkWords(words, { fits: upTo(line), maxWords, maxCharacters });
          expect(out.flatMap((p) => p.words)).toEqual(words);
        },
      ),
    );
  });

  it("every caption fits its line and its caps, unless it is one word too wide for them", () => {
    fc.assert(
      fc.property(
        wordArb,
        fc.integer({ min: 1, max: 60 }),
        fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined }),
        fc.option(fc.integer({ min: 1, max: 40 }), { nil: undefined }),
        (words, line, maxWords, maxCharacters) => {
          for (const p of chunkWords(words, { fits: upTo(line), maxWords, maxCharacters })) {
            if (p.words.length === 1) continue;
            expect(p.text.length).toBeLessThanOrEqual(line);
            if (maxWords) expect(p.words.length).toBeLessThanOrEqual(maxWords);
            if (maxCharacters) expect(p.text.length).toBeLessThanOrEqual(maxCharacters);
          }
        },
      ),
    );
  });

  it("never runs a caption across a sentence end or from one transcript segment into the next", () => {
    fc.assert(
      fc.property(wordArb, fc.integer({ min: 1, max: 200 }), (words, line) => {
        for (const p of chunkWords(words, { fits: upTo(line) })) {
          p.words.slice(0, -1).forEach((x) => expect(SENTENCE_END.test(x.text)).toBe(false));
          expect(new Set(p.words.map((x) => x.segment)).size).toBe(1);
        }
      }),
    );
  });

  it("keeps a sentence whole when it fits, however long", () => {
    const long = timed("one two three four five six seven eight nine ten eleven twelve");
    expect(chunkWords(long, { fits: always }).map((p) => p.text)).toEqual([
      "one two three four five six seven eight nine ten eleven twelve",
    ]);
  });

  it("breaks at a sentence end even when there is room left", () => {
    // The failure direction: filling to the line starts a new sentence mid-caption, which is
    // what makes auto-captions read as machine-made.
    expect(chunkWords(timed("Hi there. How are you"), { fits: always }).map((p) => p.text)).toEqual(
      ["Hi there.", "How are you"],
    );
  });

  it("cuts a line that does not fit at the clause mark nearest its middle", () => {
    const words = timed("alpha beta, gamma delta, epsilon zeta");
    expect(chunkWords(words, { fits: upTo(25) }).map((p) => p.text)).toEqual([
      "alpha beta, gamma delta,",
      "epsilon zeta",
    ]);
  });

  it("with no clause mark, cuts between the words nearest the middle: no one-word orphan", () => {
    // Filling to the line would leave "seven" alone on a caption of its own.
    const words = timed("one two three four five six seven");
    expect(chunkWords(words, { fits: upTo(30) }).map((p) => p.text)).toEqual([
      "one two three four",
      "five six seven",
    ]);
  });

  it("a cap only makes captions shorter: they still fit the line", () => {
    const words = timed("one two three four five six seven eight nine ten eleven twelve");
    for (const p of chunkWords(words, { fits: upTo(20), maxCharacters: 80 }))
      expect(p.text.length).toBeLessThanOrEqual(20);
    for (const p of chunkWords(words, { fits: always, maxWords: 2 }))
      expect(p.words.length).toBeLessThanOrEqual(2);
  });

  it("carries the phrase's own start and end from its words", () => {
    const [first] = chunkWords(timed("one two three"), { fits: always, maxWords: 2 });
    expect([first.start, first.end]).toEqual([0, 0.9]);
  });

  it("gives a word too wide for the line a caption of its own instead of hanging", () => {
    const out = chunkWords([w("extraordinarily", 0, 1), w("so", 1, 2)], { fits: upTo(4) });
    expect(out.map((p) => p.text)).toEqual(["extraordinarily", "so"]);
  });

  it("returns nothing for no words", () => {
    expect(chunkWords([], { fits: always })).toEqual([]);
  });

  // UJ-030: a caption only closed at a sentence end, so a transcript with none (a real Hindi clip:
  // commas only) became ONE caption for the whole 57 s.
  it("cuts a transcript with no sentence marks into lines that fit (Hindi, as drawn)", () => {
    const hindi = timed(
      "एक आदमी को अगर आपको सन्तुष रखना है, तोसको बताये कि खुध से कुम्टीषन करो, खुध से, गरीबो कि लिए अच्छी बाद्दि,",
    );
    // The default caption on a 1920x1080 canvas: Poppins at 65 px in a 1728 px line.
    const fits = (t: string): boolean => lineWidthPx(t, "Poppins", 65) <= 1728;
    const out = chunkWords(hindi, { fits });
    expect(out.length).toBeGreaterThan(1);
    for (const p of out) expect(fits(p.text)).toBe(true);
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

describe("Chinese and Japanese captions (UJ-004)", () => {
  it("joins the words with no space, and counts no space against max_characters", () => {
    const ja = ["藤村", "の", "り", "を"].map((t, i) => w(t, i * 0.3, i * 0.3 + 0.25));
    expect(chunkWords(ja, { fits: always }).map((p) => p.text)).toEqual(["藤村のりを"]);
    // A 4-character cap: there is no space between them to count, so a cut leaves 4 and 1 or 2 and 3.
    const capped = chunkWords(ja, { fits: always, maxCharacters: 4 }).map((p) => p.text);
    expect(capped.join("")).toBe("藤村のりを");
    for (const t of capped) expect(t.length).toBeLessThanOrEqual(4);
  });

  it("closes a caption at a Japanese or Chinese full stop, as it does at '.'", () => {
    const words = ["した。", "翌年", "の", "大会"].map((t, i) => w(t, i * 0.3, i * 0.3 + 0.25));
    expect(chunkWords(words, { fits: always }).map((p) => p.text)).toEqual([
      "した。",
      "翌年の大会",
    ]);
    const zh = ["好", "吗？", "我们"].map((t, i) => w(t, i * 0.3, i * 0.3 + 0.25));
    expect(chunkWords(zh, { fits: always }).map((p) => p.text)).toEqual(["好吗？", "我们"]);
  });

  it("cuts a long Japanese line where it no longer fits, measured as drawn", () => {
    const ja =
      "藤村|の|り|を|1914|年|大正|3|年|11|月|14|日|から|没年|不明|は|日本|の|セーリング|競技|選手"
        .split("|")
        .map((t, i) => w(t, i * 0.3, i * 0.3 + 0.25));
    // The default caption on a 1080x1920 canvas: 115 px in a 972 px line, about eight characters.
    const fits = (t: string): boolean => lineWidthPx(t, "Poppins", 115) <= 972;
    const out = chunkWords(ja, { fits });
    expect(out.length).toBeGreaterThan(2);
    for (const p of out) if (p.words.length > 1) expect(fits(p.text)).toBe(true);
  });

  it("closes a caption at the sentence ends of Hindi, Arabic and Urdu too", () => {
    const at = (ts: string[]) => ts.map((t, i) => w(t, i * 0.3, i * 0.3 + 0.25));
    const chunk = (ts: string[]) => chunkWords(at(ts), { fits: always }).map((p) => p.text);
    expect(chunk(["नमस्ते", "दोस्तों।", "आज"])).toEqual(["नमस्ते दोस्तों।", "आज"]);
    expect(chunk(["كيف", "حالك؟", "شكرا"])).toEqual(["كيف حالك؟", "شكرا"]);
    expect(chunk(["آپ", "کیسے", "ہیں۔", "شکریہ"])).toEqual(["آپ کیسے ہیں۔", "شکریہ"]);
  });
});
