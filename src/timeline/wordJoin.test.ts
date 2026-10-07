import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  breakUnspaced,
  breakWords,
  joinWords,
  UNSPACED_CHAR,
  wordGap,
  wordSpans,
} from "./wordJoin";
import { lineWidthPx } from "./fontMetrics";

describe("joinWords: words back into the line they are read as", () => {
  it("writes Chinese and Japanese with no space between words", () => {
    expect(joinWords(["藤村", "の", "り", "を", "2023", "年"])).toBe("藤村のりを2023年");
    expect(joinWords(["我们", "今天", "去", "北京，", "好", "吗？"])).toBe(
      "我们今天去北京，好吗？",
    );
    expect(joinWords(["した。", "翌年"])).toBe("した。翌年");
    expect(joinWords(["AI", "が", "日本", "代表"])).toBe("AIが日本代表");
  });

  it("keeps the space of every language that writes one", () => {
    expect(joinWords(["Hallo", "Albi!", "Herzlichen"])).toBe("Hallo Albi! Herzlichen");
    expect(joinWords(["एक", "आदमी,"])).toBe("एक आदमी,");
    expect(joinWords(["안녕하세요", "여러분"])).toBe("안녕하세요 여러분");
    expect(joinWords(["مرحبا", "بالعالم"])).toBe("مرحبا بالعالم");
    expect(joinWords(["สวัสดีครับ", "ยินดีต้อนรับ"])).toBe("สวัสดีครับ ยินดีต้อนรับ");
  });

  it("is join(' ') exactly for any words without Chinese or Japanese in them", () => {
    // The byte-identical gate: every caption already made in a spaced language renders as before.
    // (A word that starts or ends a line has no space beside it: the line break separates it.)
    const spaced = fc
      .string({ unit: "grapheme", maxLength: 8 })
      .filter((s) => !UNSPACED_CHAR.test(s) && !/^\n|\n$/.test(s));
    fc.assert(
      fc.property(fc.array(spaced, { maxLength: 12 }), (ws) => {
        expect(joinWords(ws)).toBe(ws.join(" "));
      }),
      { numRuns: 500 },
    );
  });

  it("joins pair by pair: the line is the words with each gap between them", () => {
    const word = fc.oneof(
      fc.constantFrom("藤村", "の", "年", "。", "，", "Hello", "AI", "2023", "über", "एक", ""),
      fc.string({ maxLength: 4 }),
    );
    fc.assert(
      fc.property(fc.array(word, { maxLength: 10 }), (ws) => {
        const line = joinWords(ws);
        let expected = ws[0] ?? "";
        for (let i = 1; i < ws.length; i++) expected += wordGap(ws[i - 1], ws[i]) + ws[i];
        expect(line).toBe(expected);
        // Nothing is dropped or added but separators.
        expect(line.replace(/ /g, "")).toBe(ws.join("").replace(/ /g, ""));
      }),
      { numRuns: 500 },
    );
  });

  it("decides a gap by the two characters that meet, including surrogate pairs", () => {
    expect(wordGap("Hello", "世界")).toBe("");
    expect(wordGap("世界", "Hello")).toBe("");
    expect(wordGap("Hello", "world")).toBe(" ");
    // U+20B9F, a Han character outside the BMP: judged as one character, not two halves.
    expect(wordGap("\u{20B9F}", "x")).toBe("");
    expect(wordGap("x", "\u{20B9F}")).toBe("");
    expect(wordGap("", "")).toBe(" ");
  });
});

// UJ-029: neither renderer can break inside Chinese or Japanese (libass and the preview's wrap both
// break at spaces only), so a long line ran off both edges. The breaks are decided here, once, and
// both renderers draw them.
describe("breakUnspaced: Chinese and Japanese lines broken to fit, everything else untouched", () => {
  const SIZE = 40;
  // As the plan measures: in the clip's font, here Poppins (Japanese falls back, one em a character).
  const measure = (line: string): number => lineWidthPx(line, "Poppins", SIZE);
  it("breaks a Japanese line that would run past the width, only between words", () => {
    const text = "藤村のりを1914年大正3年11月14日から没年不明は日本のセーリング競技選手";
    const broken = breakUnspaced(text, measure, 10 * SIZE);
    expect(broken.replace(/\n/g, "")).toBe(text); // nothing lost or added but breaks
    const lines = broken.split("\n");
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(10 * SIZE);
    // Every break falls where the word-breaker says a word starts.
    const starts = new Set((wordSpans(text) ?? []).map((s) => s.start));
    let at = 0;
    for (const line of lines.slice(0, -1)) {
      at += line.length;
      expect(starts.has(at)).toBe(true);
    }
  });

  it("leaves text without Chinese or Japanese exactly as it was, however long", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 120 }), (s) => {
        fc.pre(!UNSPACED_CHAR.test(s));
        expect(breakUnspaced(s, measure, 5 * SIZE)).toBe(s);
      }),
      { numRuns: 300 },
    );
  });

  it("keeps a line that already fits, and restarts the width at an authored break", () => {
    expect(breakUnspaced("藤村のりを", measure, 10 * SIZE)).toBe("藤村のりを");
    expect(breakUnspaced("藤村の\nりを", measure, 4 * SIZE)).toBe("藤村の\nりを");
  });

  it("puts a line break in front of each word that starts a new line, and joins with no space there", () => {
    const words = ["藤村", "の", "り", "を", "1914", "年", "大正", "3", "年"];
    const broken = breakWords(words, measure, 6 * SIZE);
    expect(broken.map((w) => w.replace(/^\n/, ""))).toEqual(words);
    expect(broken[0].startsWith("\n")).toBe(false);
    const lines = joinWords(broken).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(joinWords(words));
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(6 * SIZE);
    const latin = ["Hello", "there", "and", "welcome", "back"];
    expect(breakWords(latin, measure, 2 * SIZE)).toEqual(latin);
  });

  it("property: any Japanese text is broken only between words, never lost, every line fitting", () => {
    const pool = [..."日本語の文章を書きますオリンピック北京我们好吗。、！？1914年"];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...pool), { maxLength: 60 }),
        fc.integer({ min: 3, max: 20 }),
        (cs, em) => {
          const text = cs.join("");
          const broken = breakUnspaced(text, measure, em * SIZE);
          expect(broken.replace(/\n/g, "")).toBe(text);
          for (const line of broken.split("\n")) {
            // A single word wider than the line keeps its own line rather than being cut.
            const one = (wordSpans(line) ?? []).length <= 1;
            if (!one) expect(measure(line)).toBeLessThanOrEqual(em * SIZE);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
