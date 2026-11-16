// Pins what speechDecoding.ts did before the processor-path work (lane L12-q8-host), as literal data.
//
// This is the pure-refactor discipline of the repository's test standard: the table in
// __fixtures__/speechDecodingFreeze.json was written ONCE by running the OLD code at commit 3e4e3d4a over every
// model variant and every language spelling the app can be given, and this test asserts the code still says the
// same. It must pass unchanged after the processor settings were added to speechGate.json; it is never regenerated
// to make it pass. (A deliberate re-measurement of a chip-path result edits the fixture with it, as moving to
// another model edits the "0.27.0" test in modelManifest.test.ts.)
//
// What it protects: a PC with a graphics chip is decoded exactly as it was, for every language, on every variant.
import { describe, expect, it } from "vitest";

import freezeData from "./__fixtures__/speechDecodingFreeze.json";
import evidence from "./speechGate.json";
import {
  acceptableBeam,
  beamFor,
  clearedLanguages,
  decodeArgs,
  DEFAULT_BEAM,
  GREEDY_BEAM,
  greedyTable,
  MAX_LOSS_UPPER,
  MAX_POINT_LOSS,
  planDecode,
  type GateEvidence,
  type ModelVariant,
} from "./speechDecoding";
import { LANGUAGE_ALIASES, WHISPER_LANGUAGES } from "./whisperLanguages";

type PerVariant<T> = Record<ModelVariant, T>;
type PlanCell = [beam: number, predicted: string | null];
interface Freeze {
  constants: Record<string, number>;
  variants: ModelVariant[];
  lasts: Array<string | null>;
  usedBeams: number[];
  greedyTable: Record<string, string[]>;
  clearedLanguages: Record<string, string[]>;
  decodeArgs: { numbers: Record<string, string[]>; notNumbers: Record<string, string[]> };
  nonStrings: Record<string, PerVariant<{ beam: number; plan: PlanCell[]; accepted: string }>>;
  languages: Record<string, PerVariant<[beam: number, accepted: string]>>;
  plans: Record<string, PerVariant<PlanCell[]>>;
}
const FREEZE = freezeData as unknown as Freeze;
const GATE = evidence as GateEvidence;
const VARIANTS: ModelVariant[] = ["f16", "q8_0", "q5_1"];

// Values a JSON file cannot hold, by the label the fixture gives them.
const NON_STRINGS: Array<[string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["0", 0],
  ["42", 42],
  ["true", true],
  ["{}", {}],
  ["[]", []],
  ['["en"]', ["en"]],
  ["{toString:()=>'en'}", { toString: () => "en" }],
];
const NOT_NUMBERS: Array<[string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["'3'", "3"],
  ["'abc'", "abc"],
  ["''", ""],
  ["{}", {}],
  ["[]", []],
  ["[3]", [3]],
  ["true", true],
  ["false", false],
];

const bit = (b: boolean): string => (b ? "1" : "0");
const accepted = (v: ModelVariant, language: string): string =>
  FREEZE.usedBeams.map((u) => bit(acceptableBeam(u, v, language))).join("");
const plan = (v: ModelVariant, requested: string): PlanCell[] =>
  FREEZE.lasts.map((last) => {
    const p = planDecode(v, requested, last);
    return [p.beam, p.predicted];
  });
const sorted = (set: ReadonlySet<string> | undefined): string[] => [...(set ?? [])].sort();

describe("the fixture itself", () => {
  it("covers every variant, and every language the app can be given by code, name or alias", () => {
    expect(FREEZE.variants).toEqual(VARIANTS);
    const wanted = [
      ...Object.keys(WHISPER_LANGUAGES),
      ...Object.values(WHISPER_LANGUAGES),
      ...Object.keys(LANGUAGE_ALIASES),
    ];
    expect(wanted.length).toBeGreaterThan(300);
    const missing = wanted.filter((s) => !Object.hasOwn(FREEZE.languages, s));
    expect(missing).toEqual([]);
    for (const row of GATE.rows) expect(Object.hasOwn(FREEZE.languages, row.language)).toBe(true);
    // The odd spellings are in it too, or the walk below would be a walk over the easy ones.
    for (const odd of ["", "auto", "AUTO", "zz", "constructor", "toString", "en-US", " en "])
      expect(Object.hasOwn(FREEZE.languages, odd), JSON.stringify(odd)).toBe(true);
  });

  it("holds the very values the code's own constants have", () => {
    expect(FREEZE.constants).toEqual({
      DEFAULT_BEAM: 5,
      GREEDY_BEAM: 1,
      MAX_POINT_LOSS: 2,
      MAX_LOSS_UPPER: 4,
    });
    expect({ DEFAULT_BEAM, GREEDY_BEAM, MAX_POINT_LOSS, MAX_LOSS_UPPER }).toEqual(FREEZE.constants);
  });
});

describe("beamFor and acceptableBeam are what they were, for every variant and every spelling", () => {
  it("beamFor", () => {
    const drifted: string[] = [];
    for (const [spelling, perVariant] of Object.entries(FREEZE.languages))
      for (const v of VARIANTS)
        if (beamFor(v, spelling) !== perVariant[v][0])
          drifted.push(`${v} ${JSON.stringify(spelling)}: ${beamFor(v, spelling)} not ${perVariant[v][0]}`);
    expect(drifted).toEqual([]);
  });

  it("acceptableBeam, for a run at each width from 0 to 6", () => {
    const drifted: string[] = [];
    for (const [spelling, perVariant] of Object.entries(FREEZE.languages))
      for (const v of VARIANTS)
        if (accepted(v, spelling) !== perVariant[v][1])
          drifted.push(`${v} ${JSON.stringify(spelling)}: ${accepted(v, spelling)} not ${perVariant[v][1]}`);
    expect(drifted).toEqual([]);
  });

  it("a name that is not a string names no language, whatever it is", () => {
    for (const [label, value] of NON_STRINGS) {
      const row = FREEZE.nonStrings[label];
      expect(row, label).toBeDefined();
      for (const v of VARIANTS) {
        expect(beamFor(v, value as string), `${v} ${label}`).toBe(row[v].beam);
        expect(accepted(v, value as string), `${v} ${label}`).toBe(row[v].accepted);
        const got = [null, "ko"].map((last) => {
          const p = planDecode(v, value as string, last);
          return [p.beam, p.predicted];
        });
        expect(got, `${v} ${label}`).toEqual(row[v].plan);
      }
    }
    expect(Object.keys(FREEZE.nonStrings).sort()).toEqual(NON_STRINGS.map(([l]) => l).sort());
  });

  it("names every object has are no language (pinned as literals, not through a JSON key)", () => {
    for (const odd of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])
      for (const v of VARIANTS) {
        expect(beamFor(v, odd), `${v} ${odd}`).toBe(DEFAULT_BEAM);
        expect(acceptableBeam(DEFAULT_BEAM, v, odd)).toBe(true);
        expect(acceptableBeam(GREEDY_BEAM, v, odd)).toBe(false);
        expect(planDecode(v, odd, null)).toEqual({ beam: DEFAULT_BEAM, predicted: null });
        expect(planDecode(v, odd, "en")).toEqual({ beam: beamFor(v, "en"), predicted: "en" });
      }
  });
});

describe("planDecode is what it was: a named language decides, else the last one heard, else the default", () => {
  it("for every variant, every language code and a set of spellings, with each kind of last language", () => {
    const drifted: string[] = [];
    for (const [requested, perVariant] of Object.entries(FREEZE.plans))
      for (const v of VARIANTS)
        if (JSON.stringify(plan(v, requested)) !== JSON.stringify(perVariant[v]))
          drifted.push(`${v} ${JSON.stringify(requested)}: ${JSON.stringify(plan(v, requested))}`);
    expect(drifted).toEqual([]);
    expect(Object.keys(FREEZE.plans).length).toBeGreaterThan(100);
  });

  it("keeps the quirks the old code had, as they are", () => {
    // An empty last language is kept as the empty string, not turned into null.
    expect(planDecode("f16", "auto", "")).toEqual({ beam: DEFAULT_BEAM, predicted: "" });
    // A last language the engine does not know is predicted as it is, and gets the default.
    expect(planDecode("f16", "auto", "zz")).toEqual({ beam: DEFAULT_BEAM, predicted: "zz" });
    // A named language beats the last one, in either direction.
    expect(planDecode("f16", "es", "ko").beam).toBe(GREEDY_BEAM);
    expect(planDecode("f16", "ko", "en").beam).toBe(DEFAULT_BEAM);
  });
});

describe("decodeArgs is what it was, for every beam and for anything that is not one", () => {
  it("numbers", () => {
    const labels = Object.keys(FREEZE.decodeArgs.numbers);
    expect(labels.length).toBeGreaterThan(20);
    const drifted: string[] = [];
    for (const label of labels) {
      const n = Number(label);
      expect(String(n)).toBe(label);
      if (JSON.stringify(decodeArgs(n)) !== JSON.stringify(FREEZE.decodeArgs.numbers[label]))
        drifted.push(`${label}: ${JSON.stringify(decodeArgs(n))}`);
    }
    expect(drifted).toEqual([]);
    for (const beam of [0, 1, 2, 3, 4, 5, 6, 7]) expect(labels).toContain(String(beam));
  });

  it("values that are not numbers", () => {
    expect(Object.keys(FREEZE.decodeArgs.notNumbers).sort()).toEqual(NOT_NUMBERS.map(([l]) => l).sort());
    for (const [label, value] of NOT_NUMBERS)
      expect(decodeArgs(value as number), label).toEqual(FREEZE.decodeArgs.notNumbers[label]);
  });
});

describe("the chip-path tables the gate gives are what they were", () => {
  it("greedyTable, per variant", () => {
    const table = greedyTable(GATE);
    for (const v of VARIANTS) expect(sorted(table.get(v)), v).toEqual(FREEZE.greedyTable[v]);
    expect([...table.keys()].sort()).toEqual([...VARIANTS].sort());
  });

  it("clearedLanguages, for each setting that was measured before the processor was", () => {
    const ids = Object.keys(FREEZE.clearedLanguages);
    expect(ids).toEqual(["G", "Q", "Z", "ZB"]);
    for (const id of ids)
      expect(sorted(clearedLanguages(GATE.rows, id)), id).toEqual(FREEZE.clearedLanguages[id]);
  });
});
