// The facts the speech sample may carry about how a run was made (speechFacts.ts): every value from a closed list, nothing
// else, and nothing at all while the build keeps them dark. The lists are read from the tables the app already has (the model
// manifest, the engine's languages, the makers of whisperFacts.ts), so a table that grows is a table this file walks.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MODEL_MANIFEST } from "./modelManifest";
import {
  __resetSpeechFactsShipped,
  __setSpeechFactsShipped,
  DTW_STATES,
  LEAD_CLASSES,
  leadOf,
  speechFactsOn,
  speechFactTokens,
  type SpeechRunNotes,
} from "./speechFacts";
import { LEADING_QUIET_MS, voiceStartsLate, type VoiceStart } from "./speechLeadingQuiet";
import { GPU_MAKERS } from "./whisperFacts";
import { WHISPER_LANGUAGES } from "./whisperLanguages";

const MODEL_FILES = Object.keys(MODEL_MANIFEST);
const LANGUAGES = [...Object.keys(WHISPER_LANGUAGES), "auto"];

/** Every token the sample may ever add, written out from the tables (not from the reader): the whole vocabulary. */
const VOCABULARY = new Set([
  "ng=1",
  "held=1",
  "net=1",
  ...MODEL_FILES.map((key) => `mf=${key}`),
  ...DTW_STATES.map((state) => `dtw=${state}`),
  ...LEAD_CLASSES.map((lead) => `lead=${lead}`),
  ...GPU_MAKERS.map((maker) => `gpu=${maker}`),
  ...LANGUAGES.map((code) => `lang=${code}`),
]);

beforeEach(() => __setSpeechFactsShipped(true));
afterEach(() => __resetSpeechFactsShipped());

describe("the tokens the speech sample adds", () => {
  const everything: SpeechRunNotes = {
    ng: true,
    held: true,
    mf: "small_q8_0",
    net: true,
    dtw: "r",
    lead: "gt1",
    lang: "en",
  };

  it("says each fact in the words of its list, in the order the analysts were told", () => {
    expect(speechFactTokens(everything, "amd")).toEqual([
      "ng=1",
      "held=1",
      "mf=small_q8_0",
      "net=1",
      "dtw=r",
      "lead=gt1",
      "gpu=amd",
      "lang=en",
    ]);
  });

  it("leaves out a fact that does not apply, and says nothing for a run that knows nothing", () => {
    expect(speechFactTokens({ mf: "small", lang: "auto" })).toEqual(["mf=small", "lang=auto"]);
    expect(speechFactTokens(undefined)).toEqual([]);
    expect(speechFactTokens({})).toEqual([]);
    expect(speechFactTokens({ ng: true }, undefined)).toEqual(["ng=1"]);
  });

  it("is conformant: every model file of the manifest, every language of the engine and every maker can be said", () => {
    expect(MODEL_FILES.length).toBeGreaterThan(1);
    expect(LANGUAGES.length).toBeGreaterThan(90);
    for (const key of MODEL_FILES) expect(speechFactTokens({ mf: key })).toEqual([`mf=${key}`]);
    for (const code of LANGUAGES)
      expect(speechFactTokens({ lang: code })).toEqual([`lang=${code}`]);
    for (const maker of GPU_MAKERS) expect(speechFactTokens({}, maker)).toEqual([`gpu=${maker}`]);
    for (const lead of LEAD_CLASSES) expect(speechFactTokens({ lead })).toEqual([`lead=${lead}`]);
    for (const dtw of DTW_STATES) expect(speechFactTokens({ dtw })).toEqual([`dtw=${dtw}`]);
  });

  it("drops what is not in the lists: a word nobody listed, a wrong type, a flag that is not true", () => {
    const junk = {
      ng: 1,
      held: "yes",
      mf: "ggml-small.bin",
      net: false,
      dtw: "2",
      lead: "gt2",
      lang: "English",
    };
    expect(speechFactTokens(junk as unknown as SpeechRunNotes, "radeon")).toEqual([]);
    // the table is not an object that hands out what every object has
    for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"])
      expect(
        speechFactTokens({ mf: word, lang: word, lead: word, dtw: word } as never, word),
        word,
      ).toEqual([]);
  });

  it("property: whatever it is handed, every token is one of the vocabulary and none carries anything else", () => {
    const value = fc.oneof(
      fc.constant(true),
      fc.constant(false),
      fc.string(),
      fc.integer(),
      fc.constantFrom(...MODEL_FILES, ...LANGUAGES, ...LEAD_CLASSES, ...DTW_STATES, ...GPU_MAKERS),
      fc.constant(null),
      fc.object(),
    );
    fc.assert(
      fc.property(
        fc.record(
          { ng: value, held: value, mf: value, net: value, dtw: value, lead: value, lang: value },
          { requiredKeys: [] },
        ),
        value,
        (notes, gpu) => {
          const tokens = speechFactTokens(notes as unknown as SpeechRunNotes, gpu);
          for (const token of tokens) expect(VOCABULARY.has(token), token).toBe(true);
          expect(new Set(tokens).size).toBe(tokens.length);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: and nothing legitimate is dropped, whatever subset of the facts a run has", () => {
    const some = <T>(values: readonly T[]) =>
      fc.option(fc.constantFrom(...values), { nil: undefined });
    fc.assert(
      fc.property(
        fc.record({
          ng: fc.option(fc.constant(true as const), { nil: undefined }),
          held: fc.option(fc.constant(true as const), { nil: undefined }),
          mf: some(MODEL_FILES),
          net: fc.option(fc.constant(true as const), { nil: undefined }),
          dtw: some(DTW_STATES),
          lead: some(LEAD_CLASSES),
          lang: some(LANGUAGES),
        }),
        some(GPU_MAKERS),
        (notes, gpu) => {
          const expected = [
            notes.ng ? "ng=1" : "",
            notes.held ? "held=1" : "",
            notes.mf ? `mf=${notes.mf}` : "",
            notes.net ? "net=1" : "",
            notes.dtw ? `dtw=${notes.dtw}` : "",
            notes.lead ? `lead=${notes.lead}` : "",
            gpu ? `gpu=${gpu}` : "",
            notes.lang ? `lang=${notes.lang}` : "",
          ].filter(Boolean);
          expect(speechFactTokens(notes, gpu)).toEqual(expected);
        },
      ),
    );
  });

  it("can never push the whole `reason` over the 300 characters the service keeps: no token is cut in the middle", () => {
    const longest = (words: readonly string[]): string =>
      [...words].sort((a, b) => b.length - a.length)[0];
    const all = speechFactTokens(
      {
        ng: true,
        held: true,
        mf: longest(MODEL_FILES),
        net: true,
        dtw: "r",
        lead: "gt1",
        lang: longest(LANGUAGES),
      },
      longest(GPU_MAKERS),
    ).join(" ");
    // the older figures at their widest: an audio length and a wall time of a day, a speed, the engine's longest word for
    // the model, a thread count, the beam, a re-run and a batch of ninety-nine clips
    const older =
      "audio_s=86400.0 wall_s=86400.0 x=9999.99 model=large-v3-turbo threads=999 beam=5 rerun=1 files=99";
    expect(`${older} ${all}`.length).toBeLessThan(300);
  });

  it("says nothing at all while the build keeps the facts dark, whatever the run knows", () => {
    __setSpeechFactsShipped(false);
    expect(speechFactsOn()).toBe(false);
    expect(speechFactTokens(everything, "amd")).toEqual([]);
    for (const maker of GPU_MAKERS)
      expect(speechFactTokens({ ng: true, lang: "en" }, maker)).toEqual([]);
  });
});

describe("where the voice started, as the sample says it", () => {
  const AT = (ms: number): VoiceStart => ({ kind: "at", ms });

  it("is gt1 for a voice more than a second in, le1 for a second or less, and not known for anything else", () => {
    expect(leadOf(AT(0))).toBe("le1");
    expect(leadOf(AT(LEADING_QUIET_MS))).toBe("le1");
    expect(leadOf(AT(LEADING_QUIET_MS + 20))).toBe("gt1");
    expect(leadOf(AT(29_980))).toBe("gt1");
    // nothing stood out (silence, a very quiet recording, a voice after the scanned seconds): not a start that was found
    expect(leadOf({ kind: "none" })).toBe("unk");
    expect(leadOf({ kind: "unknown" })).toBe("unk");
    expect(leadOf({ kind: "unknown", stalled: true })).toBe("unk");
  });

  it("property: it says gt1 exactly when the first-word rule takes the voice for a late one", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 0, max: 40_000 }).map((ms): VoiceStart => ({ kind: "at", ms })),
          fc.constant<VoiceStart>({ kind: "none" }),
          fc.constant<VoiceStart>({ kind: "unknown" }),
          fc.constant<VoiceStart>({ kind: "unknown", stalled: true }),
        ),
        (voice) => {
          expect(leadOf(voice) === "gt1").toBe(voiceStartsLate(voice));
          expect(LEAD_CLASSES).toContain(leadOf(voice));
        },
      ),
    );
  });
});
