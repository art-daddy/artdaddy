// The privacy text says what the app does when it downloads the speech model, and the practice is decided by the plan
// (speechModel.ts), so the text is checked against the plan and not against a copy of it. On a PC that transcribes on
// its processor and holds only the smaller model file, the full-size file is downloaded as well for every language the
// smaller file is not cleared for: Arabic, which was measured and did not pass, and every language that was not
// measured. A sentence that names Arabic as the only reason understates the practice (review L12-003).
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL_KEY, MODEL_MANIFEST } from "./modelManifest";
import { planModel } from "./speechModel";
import { WHISPER_LANGUAGES } from "./whisperLanguages";

const PRIVACY = path.resolve(__dirname, "..", "..", "src-tauri", "PRIVACY.txt");

/** The one manifest file that only the processor may run: the smaller one. */
const SMALLER = Object.keys(MODEL_MANIFEST).find((key) => key !== DEFAULT_MODEL_KEY) as string;

/** The languages a processor PC holding only the smaller file would download the full-size file for if asked for
 *  them by name: read from the plan itself. */
const fullSizeLanguages = Object.keys(WHISPER_LANGUAGES).filter(
  (code) =>
    planModel({ backend: "cpu", language: code, installed: [SMALLER] }).key === DEFAULT_MODEL_KEY,
);

/** The sentences of the policy, one per entry (a semicolon ends a clause the disclosure may stand on). */
const sentences = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[.;])\s+/))
    .map((s) => s.trim())
    .filter((s) => s !== "");

describe("the privacy text about the second, full-size download", () => {
  it("is about more than one language, as the plan makes it (the premise of the checks below)", () => {
    expect(fullSizeLanguages, "Arabic was measured and did not pass").toContain("ar");
    // The engine knows 100 language codes and the gate cleared 19: the rest take the full-size file.
    expect(fullSizeLanguages.length).toBeGreaterThan(1);
    expect(fullSizeLanguages.length).toBeLessThan(Object.keys(WHISPER_LANGUAGES).length);
  });

  it("states a rule over languages, not Arabic alone, wherever the policy says the full-size file is downloaded as well", () => {
    const said = sentences(readFileSync(PRIVACY, "utf8")).filter(
      (s) => /full-size/i.test(s) && /\bas well\b/i.test(s),
    );
    expect(said.length, "the policy says when the full-size file is downloaded as well").toBeGreaterThan(0);
    for (const sentence of said) {
      if (fullSizeLanguages.length > 1)
        expect(
          sentence,
          `${fullSizeLanguages.length} language codes take the full-size file, so the sentence must say more than one`,
        ).toMatch(/\b(another|other|every|any|all|many)\b[^.;]{0,40}\blanguages?\b/i);
    }
  });

  it("does not tie the full-size download to Arabic alone anywhere in the policy", () => {
    const text = readFileSync(PRIVACY, "utf8");
    // "Arabic is transcribed" / "because Arabic keeps" as the whole reason, without any other language beside it.
    for (const sentence of sentences(text))
      if (/full-size/i.test(sentence) && /\bArabic\b/.test(sentence))
        expect(sentence, "Arabic is one example of the languages, not the rule").toMatch(
          /\b(another|other|every|any|all|many)\b[^.;]{0,40}\blanguages?\b/i,
        );
  });
});
