// Property tests for assEscape — the caption-text INJECTION DEFENCE + content-integrity guard. This is
// the one place untrusted caption text meets the libass override syntax, so it has two hard, perfect
// properties: (1) no input can OPEN an override block or forge a command (security), and (2) text is
// preserved except for the documented unsupported flag indicators. Fixed-example tests in
// assCaption.test.ts cover the common cases; these challenge the FAILURE direction with adversarial
// unicode — astral emoji, RTL/control marks, lone surrogates, and long runs of braces/backslashes.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { assEscape, unrenderableFlags } from "./assCaption";

const ZWSP = "\u200B";
const withoutFlags = (text: string): string =>
  unrenderableFlags(text).reduce((remaining, flag) => remaining.split(flag).join(""), text);

// Adversarial caption text: full grapheme clusters (emoji/CJK/RTL scripts), raw UTF-16 code units incl.
// LONE SURROGATES + control chars + the ASS specials, dense runs of just the specials, and explicit
// surrogate soup — the inputs a naive escaper mangles or drops. (fast-check v4: `fc.string({ unit })`.)
const adversarial = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 40 }),
  fc.string({ unit: "binary", maxLength: 40 }),
  fc.string({
    unit: fc.constantFrom(
      "{",
      "}",
      "\\",
      "\n",
      "\r",
      ZWSP,
      "\u202E",
      "\u0000",
      "N",
      "h",
      "a",
      "😀",
    ),
    maxLength: 40,
  }),
  fc
    .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 40 })
    .map((cs) => String.fromCharCode(...cs)),
);

describe("assEscape — injection defence + content integrity (property)", () => {
  it("leaves no override brace that could OPEN a libass block", () => {
    // Security: for ANY input, every `{`/`}` in the output is preceded by a backslash, so caption text
    // can never inject a `{...}` override (colour/transform/alpha) into the burned subtitle.
    fc.assert(
      fc.property(adversarial, (s) => {
        expect(/(?<!\\)[{}]/.test(assEscape(s))).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("leaves no backslash that could form an unintended command", () => {
    // Every backslash in the output is followed by ZWSP (a neutralised USER backslash) or by `{`/`}`/`N`
    // (the only escapes assEscape itself adds). So a user-typed `\h`/`\n`/`\p` can never become a libass
    // command — `C:\new` renders intact, not as a line break.
    const danglingCmd = new RegExp("\\\\(?![" + ZWSP + "{}N])");
    fc.assert(
      fc.property(adversarial, (s) => {
        expect(danglingCmd.test(assEscape(s))).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("preserves text except unsupported flags and normalized line endings", () => {
    fc.assert(
      fc.property(adversarial, (s) => {
        const escaped = assEscape(s);
        const restored = escaped
          .replace(/\\N/g, "\n")
          .replace(/\\([{}])/g, "$1")
          .replace(/\\\u200B/g, "\\");
        expect(unrenderableFlags(escaped)).toEqual([]);
        expect(restored).toBe(withoutFlags(s).replace(/\r\n|\r/g, "\n"));
      }),
      { numRuns: 500, examples: [["\u{1F1E6}"], ["\\{\u{1F1E6}x\r\n"]] },
    );
  });

  it("is the identity on plain text apart from unsupported flag indicators", () => {
    const plain = fc
      .string({ unit: "grapheme", maxLength: 60 })
      .filter((s) => !/[{}\\\r\n]/.test(s));
    fc.assert(
      fc.property(plain, (s) => {
        expect(assEscape(s)).toBe(withoutFlags(s));
      }),
      { numRuns: 500 },
    );
  });
});
