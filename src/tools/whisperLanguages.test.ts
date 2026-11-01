import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  languageProblem,
  LANGUAGE_ALIASES,
  WHISPER_LANGUAGES,
  WHISPER_LANGUAGES_TAG,
  whisperCode,
} from "./whisperLanguages";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ENGINE_CODES = Object.keys(WHISPER_LANGUAGES);

/** The engine's own table, as it is in its source at the pinned release. */
function upstreamTable(): Array<[code: string, id: number, name: string]> {
  const text = readFileSync(
    path.join(HERE, "__fixtures__", "whisper", `g_lang.${WHISPER_LANGUAGES_TAG}.txt`),
    "utf8",
  );
  return [...text.matchAll(/\{\s*"([a-z]+)",\s*\{\s*(\d+),\s*"([a-z ]+)"/g)].map((m) => [
    m[1],
    Number(m[2]),
    m[3],
  ]);
}

describe("the table is the engine's own", () => {
  it("lists the same languages, under the same names, as the engine's source at the pinned release", () => {
    const upstream = upstreamTable();
    expect(upstream).toHaveLength(100);
    expect(upstream.map(([, id]) => id)).toEqual(upstream.map((_, i) => i));
    expect(Object.entries(WHISPER_LANGUAGES)).toEqual(
      upstream.map(([code, , name]) => [code, name]),
    );
  });

  it("is the table of the release the engine is pinned to, wherever the pin is written", () => {
    const pinned = new Set<string>();
    const sidecars = readFileSync(path.join(REPO, "scripts", "fetch-sidecars.mjs"), "utf8");
    pinned.add(/WHISPER_UPSTREAM_TAG = "([^"]+)"/.exec(sidecars)![1]);
    const workflows = path.join(REPO, ".github", "workflows");
    for (const file of readdirSync(workflows).filter((f) => f.endsWith(".yml"))) {
      const text = readFileSync(path.join(workflows, file), "utf8");
      for (const m of text.matchAll(/whisper_ref:[\s\S]*?default:\s*"([^"]+)"/g)) pinned.add(m[1]);
    }
    // One release everywhere; and it is the one whose table is vendored here.
    expect([...pinned]).toEqual([WHISPER_LANGUAGES_TAG]);
  });
});

describe("the engine only ever gets a language it accepts", () => {
  it("whatever a caller sends: a code of the engine's, or nothing (detect)", () => {
    const hostile = [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "prototype",
    ];
    const anything = fc.oneof(fc.string(), fc.constantFrom(...hostile), fc.anything());
    fc.assert(
      fc.property(anything, (raw) => {
        const code = whisperCode(raw);
        expect(code === "" || ENGINE_CODES.includes(code)).toBe(true);
        expect(whisperCode(code), "settled: resolving the answer again changes nothing").toBe(code);
      }),
      { numRuns: 500 },
    );
  });

  it("whatever is written around a language it still finds it: case, space, region, script", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ENGINE_CODES),
        fc.constantFrom("", " ", "  "),
        fc.constantFrom("", "-US", "_BR", "-Hant", "-419", "_x_y"),
        fc.boolean(),
        (code, pad, region, upper) => {
          const written = `${pad}${upper ? code.toUpperCase() : code}${region}${pad}`;
          expect(whisperCode(written)).toBe(code);
        },
      ),
    );
  });

  it("knows each of the engine's languages by its English name too, as the engine does", () => {
    for (const [code, name] of Object.entries(WHISPER_LANGUAGES))
      expect(whisperCode(name), name).toBe(code);
    expect(whisperCode("Haitian Creole")).toBe("ht");
  });

  it("names nothing for nothing, and for auto", () => {
    for (const none of ["", " ", "auto", "AUTO", "Auto ", null, undefined])
      expect(whisperCode(none)).toBe("");
  });

  it("takes only a string to name a language: a number or an object a model made up names none", () => {
    for (const odd of [0, 42, true, {}, [], ["en"], { language: "en" }, { toString: "x" }])
      expect(whisperCode(odd)).toBe("");
  });

  // The ones that were sent, and the ones a model is likely to send next.
  it.each([
    ["fil", "tl"], // the one user whose 19 calls all failed: whisper files Filipino under Tagalog
    ["jpn", "ja"],
    ["cmn", "zh"],
    ["zho", "zh"],
    ["chi", "zh"],
    ["eng", "en"],
    ["spa", "es"],
    ["deu", "de"],
    ["ger", "de"],
    ["fra", "fr"],
    ["fre", "fr"],
    ["por", "pt"],
    ["rus", "ru"],
    ["ita", "it"],
    ["kor", "ko"],
    ["hin", "hi"],
    ["ara", "ar"],
    ["nld", "nl"],
    ["dut", "nl"],
    ["tur", "tr"],
    ["vie", "vi"],
    ["ind", "id"],
    ["tha", "th"],
    ["heb", "he"],
    ["iw", "he"], // retired by ISO in 1989, still what Java and Android write
    ["in", "id"],
    ["ji", "yi"],
    ["jv", "jw"], // ISO's code for Javanese; the engine's is the older "jw"
    ["nb", "no"],
    ["nob", "no"],
    ["tgl", "tl"],
    ["filipino", "tl"],
    ["mandarin", "zh"],
    ["pt-BR", "pt"],
    ["zh-Hant", "zh"],
    ["es_MX", "es"],
  ])("%s is %s", (written, code) => {
    expect(whisperCode(written)).toBe(code);
    expect(languageProblem(written)).toBeNull();
  });

  it("is never fooled into an answer by a name the engine does not know", () => {
    for (const unknown of ["xx", "ceb", "klingon", "zz", "x".repeat(500), "😀"])
      expect(whisperCode(unknown), unknown).toBe("");
  });
});

describe("the other names for a language", () => {
  it("each lead to a language the engine has", () => {
    for (const [alias, code] of Object.entries(LANGUAGE_ALIASES))
      expect(ENGINE_CODES, `${alias} -> ${code}`).toContain(code);
  });

  it("never take the place of a code or a name the engine already has", () => {
    const names = new Set(Object.values(WHISPER_LANGUAGES));
    for (const alias of Object.keys(LANGUAGE_ALIASES)) {
      expect(ENGINE_CODES, `${alias} is the engine's own code`).not.toContain(alias);
      expect(names.has(alias), `${alias} is the engine's own name`).toBe(false);
    }
  });
});

describe("what the model is told when its language is not known", () => {
  it("says nothing when it is known, absent, or auto", () => {
    for (const fine of ["es", "ES", "jpn", "fil", "", "auto", null, undefined, 42, {}])
      expect(languageProblem(fine), String(fine)).toBeNull();
  });

  it("says the language was detected instead, and how to name one, when it is not known", () => {
    const note = languageProblem("klingon")!;
    expect(note).toMatch(/"klingon" is not one the speech engine knows/);
    expect(note).toMatch(/detected from the audio/);
    expect(note).toMatch(/"tl" \(Filipino\)/);
  });

  it("speaks exactly when the engine would have been handed something it does not know", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const named = raw.trim() !== "" && raw.trim().toLowerCase() !== "auto";
        expect(languageProblem(raw) !== null).toBe(named && whisperCode(raw) === "");
      }),
    );
  });

  it("does not repeat a very long name back at the model in full", () => {
    expect(languageProblem("q".repeat(5_000))!.length).toBeLessThan(300);
  });
});
