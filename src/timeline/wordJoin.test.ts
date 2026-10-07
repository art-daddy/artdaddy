import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { joinWords, UNSPACED_CHAR, wordGap } from "./wordJoin";

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
    const spaced = fc
      .string({ unit: "grapheme", maxLength: 8 })
      .filter((s) => !UNSPACED_CHAR.test(s));
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
