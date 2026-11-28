// The languages the app accepts (whisperLanguages.ts, the engine's own table at its pinned release) against the speech
// model manifest (modelManifest.ts) and the accuracy gate the manifest's files were measured by (speechGate.json).
// whisperLanguages.test.ts holds the table to the engine's source; these hold the files and the measurements to the
// table, so a model file, a re-measured gate or an engine upgrade that no longer matches the languages offered fails
// here instead of in a person's transcript.
import { describe, expect, it } from "vitest";

import { MODEL_MANIFEST } from "./modelManifest";
import gate from "./speechGate.json";
import { WHISPER_LANGUAGES, WHISPER_LANGUAGES_TAG, whisperCode } from "./whisperLanguages";

const ENGLISH_ONLY = /\.en([.-]|$)/;

describe("the speech model files can hear the languages the app offers", () => {
  const entries = Object.entries(MODEL_MANIFEST);

  it("walks at least one file, or the walks below pass for nothing", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  // whisper publishes English-only files beside each multilingual one (ggml-small.en.bin, ggml-small.en-q8_0.bin). One of
  // them in the manifest would write every language but English as English words, while the app still offers all of them.
  it.each(entries)("%s is a multilingual file, not an English-only one", (_key, entry) => {
    expect(entry.file).not.toMatch(ENGLISH_ONLY);
  });

  // The gate is the evidence a file was run on other languages: each file the app downloads was measured transcribing
  // speech that is not English, and every language it was measured on is one the app offers.
  it.each(entries)("%s was measured by the gate on languages besides English", (_key, entry) => {
    const settings = [gate.baseline, ...Object.values(gate.settings)].filter(
      (s) => s.model === entry.file && s.variant === entry.variant,
    );
    const ids = new Set(
      Object.entries(gate.settings)
        .filter(([, s]) => settings.includes(s))
        .map(([id]) => id),
    );
    const isBaseline = settings.includes(gate.baseline);
    const heard = gate.rows
      .filter((row) => isBaseline || Object.keys(row.results).some((id) => ids.has(id)))
      .map((row) => row.language);
    expect(heard.filter((language) => language !== "en").length).toBeGreaterThan(0);
    expect(heard.filter((language) => !Object.hasOwn(WHISPER_LANGUAGES, language))).toEqual([]);
  });
});

describe("the accuracy gate speaks the engine's language codes", () => {
  // The app looks a language up in the gate by the code whisperCode gives it (speechDecoding.ts, speechModel.ts). A row
  // written any other way ("zh-CN", "fil", "Japanese") is a measurement no request ever finds: its language keeps the
  // slower setting, or never gets the smaller download, although the gate cleared it.
  it("writes every measured language exactly as the app looks it up", () => {
    const rows = gate.rows.map((row) => row.language);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((language) => whisperCode(language) !== language)).toEqual([]);
  });

  // The gate's verdicts are about one engine; the language table is another engine's if the two releases differ, and a
  // language the newer engine renamed or dropped would be cleared, or refused, on the word of the other one.
  it("was measured on the engine release whose language table the app holds", () => {
    expect(gate.engine).toBe(`whisper.cpp ${WHISPER_LANGUAGES_TAG}`);
  });
});
