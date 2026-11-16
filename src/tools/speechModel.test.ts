// speechModel.ts: which model file a run uses, and the rule that the smaller file only ever runs on the processor.
//
// The invariant under test: the 8-bit file is launched on the processor path and never on the graphics chip; a
// language the gate did not clear on the processor uses today's file on every path (a language that is only a
// prediction may start on the smaller file when that is the one that is here: nothing is kept from it, and a guess
// never makes a PC download); a PC with a graphics chip is planned exactly as before. The oracles here are NOT the
// module: they are the study's own table (the document's
// section 10.1, __fixtures__/speechGateCpuS1.json), the raw cells of the gate re-read with the owner's rule, the
// frozen answers of the old code (speechDecodingFreeze.json), and the manifest's own `backends`.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import freezeData from "./__fixtures__/speechDecodingFreeze.json";
import s1Data from "./__fixtures__/speechGateCpuS1.json";
import { backendsOf, DEFAULT_MODEL_KEY, MODEL_MANIFEST, type ModelEntry } from "./modelManifest";
import {
  beamFor,
  clearedOn,
  DEFAULT_BEAM,
  measuredOn,
  planDecode,
  SHIPPED_EVIDENCE,
  type GateEvidence,
  type ModelVariant,
} from "./speechDecoding";
import gateData from "./speechGate.json";
import {
  acceptableRun,
  assertLaunchArgv,
  launchPlan,
  modelKeyOfPath,
  modelRules,
  OFFER_SMALLER_TO_INSTALLED,
  planModel,
  processorBeam,
  type PlanInput,
} from "./speechModel";
import type { SpeechBackend } from "./speechPace";
import { LANGUAGE_ALIASES, WHISPER_LANGUAGES, whisperCode } from "./whisperLanguages";

type S1Row = [string, string, number, number, number, number, number, "pass" | "fail"];
const S1 = s1Data as unknown as {
  summary: string;
  greedy: S1Row[];
  beams: S1Row[];
  languageTable: Array<[string, string, string]>;
};
interface FreezeRows {
  languages: Record<string, Record<ModelVariant, [number, string]>>;
  plans: Record<string, Record<ModelVariant, Array<[number, string | null]>>>;
  lasts: Array<string | null>;
}
const FREEZE = freezeData as unknown as FreezeRows;
const GATE = gateData as unknown as {
  baseline: { variant: string; model: string };
  settings: Record<string, { variant: string; model: string; beam: number; backend?: string }>;
  rows: Array<{
    set: string;
    language: string;
    results: Record<string, { diff_points: number; ci_high: number }>;
  }>;
};

// The two files, by the names the manifest gives them. Written out here on purpose: the module may not know them.
const BASELINE = "small";
const SMALLER = "small_q8_0";

const CODES = Object.keys(WHISPER_LANGUAGES);
const NAMES = Object.values(WHISPER_LANGUAGES);
const ALIASES = Object.keys(LANGUAGE_ALIASES);
const SPELLINGS = [
  ...CODES,
  ...NAMES,
  ...ALIASES,
  "en-US",
  "EN",
  "pt_BR",
  "zh-Hant",
  " en ",
  "KOREAN",
  "Dutch",
];

/** What the study's table says each language needs on the processor, by code. */
const NEEDS = new Map<string, 1 | 5 | null>(
  S1.languageTable.map(([, code, how]) => [
    code,
    how === "greedy" ? 1 : how === "5 beams" ? 5 : null,
  ]),
);
const needOf = (code: string): 1 | 5 | null => NEEDS.get(code) ?? null;
/** Whether a string, in any spelling, names a language the study cleared on the processor. */
const clearedNeed = (language: unknown): 1 | 5 | null =>
  typeof language === "string" && whisperCode(language) !== ""
    ? needOf(whisperCode(language))
    : null;
const resolvable = (language: unknown): boolean =>
  typeof language === "string" && whisperCode(language) !== "";

describe("the study's table, as the witness", () => {
  it("is the document's: 20 languages, greedy in 10, 5 beams in 9, one that neither passes", () => {
    expect(S1.languageTable).toHaveLength(20);
    const count = (how: string): number => S1.languageTable.filter((row) => row[2] === how).length;
    expect([count("greedy"), count("5 beams"), count("NEITHER passes")]).toEqual([10, 9, 1]);
    expect(S1.summary).toBe("greedy in 10 languages, 5 beams in 9, neither passes in 1, pending 0");
    expect(needOf("ar")).toBeNull();
    expect(needOf("nl")).toBe(5);
    expect(needOf("en")).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Conformance walks: each walks EVERY entry of a table that drives behaviour, so a drift in any one fails here.
// ---------------------------------------------------------------------------------------------------------------

describe("processorBeam is the study's language table, for every language the engine can be given", () => {
  it("for each of the engine's language codes", () => {
    const drifted = CODES.filter((code) => processorBeam(code) !== needOf(code));
    expect(drifted).toEqual([]);
    const got = CODES.map((code) => processorBeam(code));
    expect([got.filter((b) => b === 1).length, got.filter((b) => b === 5).length]).toEqual([10, 9]);
    expect(got.filter((b) => b === null).length).toBe(CODES.length - 19);
  });

  it("for each spelling of a language: the answer of its code, whatever the letter case or the name used", () => {
    const drifted = SPELLINGS.filter((s) => processorBeam(s) !== needOf(whisperCode(s)));
    expect(drifted).toEqual([]);
  });

  it("agrees with the raw cells of every gate row, re-read with the owner's rule, for every processor setting", () => {
    const onProcessor = Object.entries(GATE.settings).filter(([, s]) => s.backend === "cpu");
    expect(onProcessor.map(([id]) => id).sort()).toEqual(["ZBC", "ZC"]);
    const greedyId = onProcessor.find(([, s]) => s.beam === 1)![0];
    const beamsId = onProcessor.find(([, s]) => s.beam === 5)![0];
    // A language is cleared at a setting only when EVERY one of its rows has a cell there that passes: at most two
    // points worse, with an interval that stays under four. No row, or no cell, is no clearance.
    const clearedAt = (id: string, code: string): boolean => {
      const rows = GATE.rows.filter((r) => r.language === code);
      return (
        rows.length > 0 &&
        rows.every((r) => {
          const c = r.results[id];
          return c !== undefined && c.diff_points <= 2.0 && c.ci_high <= 4.0;
        })
      );
    };
    const drifted: string[] = [];
    for (const code of CODES) {
      const expected = clearedAt(greedyId, code) ? 1 : clearedAt(beamsId, code) ? 5 : null;
      if (processorBeam(code) !== expected)
        drifted.push(`${code}: ${processorBeam(code)} not ${expected}`);
    }
    expect(drifted).toEqual([]);
    // Every language that has a gate row is walked through a row, so the loop above is not a walk over nothing.
    expect(new Set(GATE.rows.map((r) => r.language)).size).toBe(20);
    for (const row of GATE.rows)
      expect(processorBeam(row.language), row.set).toBe(needOf(row.language));
  });

  it("never reads the chip: the chip clears Dutch at greedy and Arabic at 5 beams for the same file, and the processor does not", () => {
    const chip = clearedOn(SHIPPED_EVIDENCE, "gpu").get("q8_0")!;
    expect(chip.get(1)!.has("nl")).toBe(true);
    expect(chip.get(5)!.has("ar")).toBe(true);
    expect(processorBeam("nl")).toBe(5);
    expect(processorBeam("ar")).toBeNull();
  });
});

/** The rules each manifest entry keeps about the paths it may be launched on, as the names of the ones it breaks. */
function pathProblems(
  entry: ModelEntry,
  gate: typeof GATE = GATE,
  evidence: GateEvidence = SHIPPED_EVIDENCE,
): string[] {
  const broken: string[] = [];
  const settings = Object.values(gate.settings);
  const measuredHere = (path: SpeechBackend): boolean =>
    settings.some(
      (s) =>
        measuredOn(s as { backend?: SpeechBackend }) === path &&
        s.variant === entry.variant &&
        s.model === entry.file,
    );
  const isBaseline = gate.baseline.variant === entry.variant && gate.baseline.model === entry.file;
  if (![gate.baseline, ...settings].some((m) => m.variant === entry.variant))
    broken.push("variant");
  if (entry.backends === undefined) {
    // No `backends` is both paths, and only today's file may say so: it is the gate's own baseline.
    if (!isBaseline) broken.push("unrestricted_but_not_the_baseline");
    return broken;
  }
  if (entry.backends.length === 0) broken.push("no_path");
  for (const path of entry.backends) {
    if (path !== "gpu" && path !== "cpu") broken.push("unknown_path");
    else if (!measuredHere(path)) broken.push(`no_gate_setting_on_${path}`);
  }
  if (entry.backends.includes("cpu")) {
    const cleared = clearedOn(evidence, "cpu").get(entry.variant);
    if (![...(cleared?.values() ?? [])].some((set) => set.size > 0))
      broken.push("nothing_cleared_on_cpu");
  }
  return broken;
}

describe("every manifest entry's paths are justified by the gate (a future entry is checked here automatically)", () => {
  const entries = Object.entries(MODEL_MANIFEST);

  it("walks at least the two files, or the walk below would pass for nothing", () => {
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(MODEL_MANIFEST)).toContain(BASELINE);
    expect(Object.keys(MODEL_MANIFEST)).toContain(SMALLER);
  });

  it.each(entries)("%s: its paths and variant are measured by the gate", (_key, entry) => {
    expect(pathProblems(entry)).toEqual([]);
  });

  it("the default model runs on both paths and is today's file; exactly one file is restricted to the processor", () => {
    expect(DEFAULT_MODEL_KEY).toBe(BASELINE);
    expect([...backendsOf(MODEL_MANIFEST[DEFAULT_MODEL_KEY])].sort()).toEqual(["cpu", "gpu"]);
    const processorOnly = entries.filter(([, e]) => !backendsOf(e).includes("gpu"));
    expect(processorOnly.map(([key]) => key)).toEqual([SMALLER]);
    expect(backendsOf(MODEL_MANIFEST[SMALLER])).toEqual(["cpu"]);
  });

  it("gives every file its own name, in any letter case, since the name is how a launch finds the entry", () => {
    const names = entries.map(([, e]) => e.file.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  // A walk that cannot fail proves nothing: each rule is shown to fire on an entry that breaks it. (The gate holds chip
  // measurements of the 8-bit file too, so the data alone cannot say it must stay off the chip: that is the owner's
  // decision, and it is pinned as a literal above and in speechModelLaunch.test.ts.)
  describe("the checker itself", () => {
    const smaller = MODEL_MANIFEST[SMALLER];
    const without = (drop: (s: (typeof GATE.settings)[string]) => boolean): typeof GATE => {
      const copy = structuredClone(GATE);
      for (const [id, s] of Object.entries(copy.settings)) if (drop(s)) delete copy.settings[id];
      return copy;
    };
    const noProcessor = without((s) => s.backend === "cpu");
    const noChipEightBit = without((s) => s.backend !== "cpu" && s.variant === "q8_0");
    const broken: Array<[string, string, ModelEntry, typeof GATE?]> = [
      ["no_path", "an empty list of paths", { ...smaller, backends: [] }],
      [
        "unknown_path",
        "a path that is neither",
        { ...smaller, backends: ["tpu" as SpeechBackend] },
      ],
      [
        "no_gate_setting_on_cpu",
        "a restriction to the processor with no processor measurement",
        smaller,
        noProcessor,
      ],
      [
        "nothing_cleared_on_cpu",
        "a restriction to the processor with nothing cleared there",
        smaller,
        noProcessor,
      ],
      [
        "no_gate_setting_on_gpu",
        "a launch on the chip of a file measured only elsewhere",
        { ...smaller, backends: ["gpu"] },
        noChipEightBit,
      ],
      [
        "unrestricted_but_not_the_baseline",
        "the 8-bit file with no restriction at all",
        { ...smaller, backends: undefined },
      ],
      [
        "variant",
        "a variant the gate never measured",
        { ...smaller, variant: "f32" as ModelVariant },
      ],
    ];
    it.each(broken)("flags %s: %s", (rule, _what, entry, gate = GATE) => {
      const evidence = gate === GATE ? SHIPPED_EVIDENCE : (gate as unknown as GateEvidence);
      expect(pathProblems(entry, gate, evidence)).toContain(rule);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// planModel
// ---------------------------------------------------------------------------------------------------------------

const plan = (
  backend: SpeechBackend,
  language: string | null,
  installed: readonly string[],
  offer?: boolean,
): { key: string; variant: ModelVariant; beam: number } =>
  planModel({ backend, language, installed }, offer);

describe("planModel on the graphics chip is today's plan, byte for byte", () => {
  const installedSets: string[][] = [[], [BASELINE], [SMALLER], [BASELINE, SMALLER]];

  it("for every language spelling the old code was frozen over, whatever is installed and whichever switch", () => {
    const drifted: string[] = [];
    let walked = 0;
    for (const [spelling, perVariant] of Object.entries(FREEZE.languages))
      for (const installed of installedSets)
        for (const offer of [false, true]) {
          walked++;
          const got = JSON.stringify(plan("gpu", spelling, installed, offer));
          const want = JSON.stringify({ key: "small", variant: "f16", beam: perVariant.f16[0] });
          if (got !== want) drifted.push(`${JSON.stringify(spelling)}: ${got} not ${want}`);
        }
    expect(drifted).toEqual([]);
    expect(walked).toBeGreaterThan(3000);
  });

  it("is what planDecode gave for the language it predicted, for every request and last language the old code was frozen over", () => {
    const drifted: string[] = [];
    for (const [requested, perVariant] of Object.entries(FREEZE.plans))
      FREEZE.lasts.forEach((last, i) => {
        const old = planDecode("f16", requested, last);
        expect([old.beam, old.predicted]).toEqual(perVariant.f16[i]);
        const got = plan("gpu", old.predicted, [], false);
        if (got.beam !== old.beam || got.key !== "small" || got.variant !== "f16")
          drifted.push(
            `${JSON.stringify(requested)} after ${JSON.stringify(last)}: ${JSON.stringify(got)}`,
          );
      });
    expect(drifted).toEqual([]);
  });

  it("is the same for nothing known as for a language the engine does not know", () => {
    for (const language of [null, "", "auto", "zz", "__proto__", "x".repeat(10_000)])
      expect(plan("gpu", language, []), String(language).slice(0, 12)).toEqual({
        key: "small",
        variant: "f16",
        beam: DEFAULT_BEAM,
      });
  });
});

// The plan for a processor-only PC, as a table to read: what a run is started with, for each kind of language and
// each set of files already on disk, with the owner's switch off and on. Kinds of language: nothing known; cleared
// greedy (en); cleared at 5 beams, where today's file would run greedy (nl) and where it would not (ko); not cleared
// because it failed (ar); not cleared because nobody measured it (fi).
type Outcome = [key: string, beam: number];
const PROCESSOR_TABLE: Array<
  [language: string | null, installed: string[], off: Outcome, on: Outcome]
> = [
  [null, [], [SMALLER, 5], [SMALLER, 5]],
  [null, [BASELINE], [BASELINE, 5], [BASELINE, 5]],
  [null, [SMALLER], [SMALLER, 5], [SMALLER, 5]],
  [null, [BASELINE, SMALLER], [BASELINE, 5], [BASELINE, 5]],
  ["en", [], [SMALLER, 1], [SMALLER, 1]],
  ["en", [BASELINE], [BASELINE, 1], [SMALLER, 1]],
  ["en", [SMALLER], [SMALLER, 1], [SMALLER, 1]],
  ["en", [BASELINE, SMALLER], [SMALLER, 1], [SMALLER, 1]],
  ["nl", [], [SMALLER, 5], [SMALLER, 5]],
  ["nl", [BASELINE], [BASELINE, 1], [SMALLER, 5]],
  ["nl", [SMALLER], [SMALLER, 5], [SMALLER, 5]],
  ["nl", [BASELINE, SMALLER], [SMALLER, 5], [SMALLER, 5]],
  ["ko", [], [SMALLER, 5], [SMALLER, 5]],
  ["ko", [BASELINE], [BASELINE, 5], [SMALLER, 5]],
  ["ko", [SMALLER], [SMALLER, 5], [SMALLER, 5]],
  ["ko", [BASELINE, SMALLER], [SMALLER, 5], [SMALLER, 5]],
  ["ar", [], [BASELINE, 5], [BASELINE, 5]],
  ["ar", [BASELINE], [BASELINE, 5], [BASELINE, 5]],
  ["ar", [SMALLER], [BASELINE, 5], [BASELINE, 5]],
  ["ar", [BASELINE, SMALLER], [BASELINE, 5], [BASELINE, 5]],
  ["fi", [], [BASELINE, 5], [BASELINE, 5]],
  ["fi", [BASELINE], [BASELINE, 5], [BASELINE, 5]],
  ["fi", [SMALLER], [BASELINE, 5], [BASELINE, 5]],
  ["fi", [BASELINE, SMALLER], [BASELINE, 5], [BASELINE, 5]],
];

describe("planModel on a PC with no usable graphics chip", () => {
  it.each(PROCESSOR_TABLE)("language %s, installed %j", (language, installed, off, on) => {
    expect(OFFER_SMALLER_TO_INSTALLED).toBe(false);
    for (const [offer, [key, beam]] of [
      [false, off],
      [true, on],
    ] as Array<[boolean, Outcome]>) {
      const got = plan("cpu", language, installed, offer);
      expect([got.key, got.beam], `switch ${offer}`).toEqual([key, beam]);
      expect(got.variant).toBe(MODEL_MANIFEST[key].variant);
    }
    // With no second argument the plan is the one the module's own switch gives.
    expect(plan("cpu", language, installed)).toEqual(
      plan("cpu", language, installed, OFFER_SMALLER_TO_INSTALLED),
    );
  });

  it("walks every language the study measured, not only the representatives above", () => {
    for (const [, code, how] of S1.languageTable) {
      const got = plan("cpu", code, []);
      if (how === "NEITHER passes") expect([got.key, got.beam], code).toEqual([BASELINE, 5]);
      else expect([got.key, got.beam], code).toEqual([SMALLER, how === "greedy" ? 1 : 5]);
    }
  });
});

// A language that is only a GUESS (the last one this PC heard) never makes a PC fetch a file: the plan for it names a
// file that is here whenever one is, and the commit point still refuses what a wrong guess made. A language that was
// named or heard keeps the rule above (the baseline file, downloaded when it is not here).
const guess = (
  backend: SpeechBackend,
  language: string | null,
  installed: readonly string[],
  offer?: boolean,
): { key: string; variant: ModelVariant; beam: number } =>
  planModel({ backend, language, installed, predicted: true }, offer);

describe("planModel for a language that is only predicted", () => {
  it("starts a processor PC that holds only the smaller file on that file, for EVERY language the engine knows", () => {
    for (const code of CODES) {
      const got = guess("cpu", code, [SMALLER]);
      expect(got.key, code).toBe(SMALLER);
      // A cleared language at the beam the study cleared it at, any other at the beam that suits every language.
      expect(got.beam, code).toBe(needOf(code) ?? DEFAULT_BEAM);
      // The same language NAMED, and not cleared, still needs the baseline file: a download, by design.
      expect(plan("cpu", code, [SMALLER]).key, `${code} named`).toBe(
        needOf(code) === null ? BASELINE : SMALLER,
      );
    }
  });

  it("is the plan it always was on every other set of files, on the graphics chip, and with the switch on", () => {
    for (const language of [...CODES, null, "", "zz", "auto"])
      for (const offer of [false, true]) {
        for (const installed of [[], [BASELINE], [BASELINE, SMALLER]])
          expect(guess("cpu", language, installed, offer), `${language} ${installed}`).toEqual(
            plan("cpu", language, installed, offer),
          );
        for (const installed of [[], [BASELINE], [SMALLER], [BASELINE, SMALLER]])
          expect(guess("gpu", language, installed, offer), `${language} ${installed}`).toEqual(
            plan("gpu", language, installed, offer),
          );
      }
    // With only the smaller file here the switch has nothing to offer: the smaller file is here already.
    for (const language of CODES)
      expect(guess("cpu", language, [SMALLER], true)).toEqual(
        guess("cpu", language, [SMALLER], false),
      );
  });

  it("names a file that is installed whenever one is, on the processor with the owner's switch off: a guess never needs a download", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(...SPELLINGS), fc.string(), fc.constant(null)),
        fc.subarray([BASELINE, SMALLER], { minLength: 1 }),
        (language, installed) => {
          expect(installed).toContain(guess("cpu", language, installed, false).key);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("starts what the commit point will refuse for a language the study did not clear on the smaller file, and keeps what it clears", () => {
    for (const code of CODES) {
      const got = guess("cpu", code, [SMALLER]);
      expect(acceptableRun(got, code), code).toBe(needOf(code) !== null);
      // English was cleared at the narrowest beam, so a run at any beam is kept when that is what the clip says.
      expect(acceptableRun(got, "en"), `${code} turning out English`).toBe(true);
    }
  });

  it("is re-planned once, for the language the engine heard, when the guess was wrong, and that plan is kept (the loop ends)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SPELLINGS),
        fc.constantFrom(...SPELLINGS),
        fc.subarray([BASELINE, SMALLER]),
        (guessed, heard, installed) => {
          if (!resolvable(heard)) return;
          const first = guess("cpu", guessed, installed, false);
          if (acceptableRun(first, heard)) return;
          // The first run made its file, so it is installed now; the language is known, so it is no longer a guess.
          const second = plan("cpu", heard, [...installed, first.key], false);
          expect(acceptableRun(second, heard)).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("is a guess only when it is exactly true", () => {
    for (const predicted of [false, undefined, null, 0, 1, "true", "yes", {}, []])
      expect(
        planModel({
          backend: "cpu",
          language: "ar",
          installed: [SMALLER],
          predicted: predicted as never,
        }),
        String(predicted),
      ).toEqual(plan("cpu", "ar", [SMALLER]));
  });
});

describe("planModel, as rules over any input", () => {
  const language = fc.oneof(
    fc.constantFrom(...CODES),
    fc.constantFrom(...NAMES),
    fc.constantFrom(...ALIASES),
    fc.string(),
    fc.constantFrom(
      "",
      "auto",
      "AUTO",
      " en ",
      "en-US",
      "zh_Hant",
      "__proto__",
      "constructor",
      "x".repeat(10_000),
    ),
    fc.anything(),
  ) as unknown as fc.Arbitrary<string | null>;
  const installed = fc.array(
    fc.oneof(
      fc.constantFrom(BASELINE, SMALLER),
      fc.constantFrom("nope", "__proto__", "constructor", ""),
      fc.string(),
    ),
    { maxLength: 8 },
  );
  const backend = fc.constantFrom<SpeechBackend>("gpu", "cpu");
  const hostileBackend = fc.oneof(
    fc.constantFrom("CPU", "cpu ", "Cpu", "gpu", "vulkan", "", "cpu\0"),
    fc.anything(),
  ) as unknown as fc.Arbitrary<SpeechBackend>;
  const run = { numRuns: 300 };

  it("never plans the smaller file for anything but the processor, whatever the backend is said to be", () => {
    fc.assert(
      fc.property(
        fc.oneof(hostileBackend, fc.constant("gpu" as SpeechBackend)),
        language,
        installed,
        fc.boolean(),
        (b, l, i, offer) => {
          if (b === "cpu") return;
          expect(plan(b, l, i, offer).key).toBe(BASELINE);
        },
      ),
      run,
    );
  });

  it("never plans it for a language the study did not clear on the processor", () => {
    fc.assert(
      fc.property(backend, language, installed, fc.boolean(), (b, l, i, offer) => {
        if (!resolvable(l) || clearedNeed(l) !== null) return;
        const got = plan(b, l, i, offer);
        expect([got.key, got.variant]).toEqual([BASELINE, "f16"]);
      }),
      run,
    );
  });

  it("always names a file the manifest has, with the variant the manifest gives it", () => {
    fc.assert(
      fc.property(fc.anything(), fc.boolean(), (input, offer) => {
        const got = planModel(input as PlanInput, offer);
        expect(Object.hasOwn(MODEL_MANIFEST, got.key)).toBe(true);
        expect(got.variant).toBe(MODEL_MANIFEST[got.key].variant);
        expect([1, 5]).toContain(got.beam);
      }),
      run,
    );
    fc.assert(
      fc.property(backend, language, installed, fc.boolean(), (b, l, i, offer) => {
        const got = plan(b, l, i, offer);
        expect(got.variant).toBe(MODEL_MANIFEST[got.key].variant);
      }),
      run,
    );
  });

  it("is a plan its own commit point accepts, for the language it was planned for", () => {
    fc.assert(
      fc.property(backend, language, installed, fc.boolean(), (b, l, i, offer) => {
        if (!resolvable(l)) return;
        expect(acceptableRun(plan(b, l, i, offer), l as string)).toBe(true);
      }),
      run,
    );
  });

  it("starts a processor PC with nothing installed on the smaller file for a cleared language (the halved download)", () => {
    fc.assert(
      fc.property(language, fc.boolean(), (l, offer) => {
        if (!resolvable(l)) return;
        const need = clearedNeed(l);
        const got = plan("cpu", l, [], offer);
        expect([got.key, got.beam]).toEqual(
          need === null ? [BASELINE, beamFor("f16", l as string)] : [SMALLER, need],
        );
      }),
      run,
    );
  });

  it("never surprises a PC that has only today's file with a download while the switch is off, and does when it is on", () => {
    fc.assert(
      fc.property(language, (l) => {
        expect(plan("cpu", l, [BASELINE], false).key).toBe(BASELINE);
        const on = plan("cpu", l, [BASELINE], true);
        expect(on.key).toBe(resolvable(l) && clearedNeed(l) !== null ? SMALLER : BASELINE);
      }),
      run,
    );
  });

  it("gives a PC that has both files the smaller one for a cleared language, and today's for the rest", () => {
    fc.assert(
      fc.property(language, fc.boolean(), (l, offer) => {
        const got = plan("cpu", l, [BASELINE, SMALLER], offer);
        expect(got.key).toBe(resolvable(l) && clearedNeed(l) !== null ? SMALLER : BASELINE);
      }),
      run,
    );
  });

  it("treats a language it cannot read exactly as it treats nothing known", () => {
    fc.assert(
      fc.property(backend, language, installed, fc.boolean(), (b, l, i, offer) => {
        if (resolvable(l)) return;
        expect(plan(b, l, i, offer)).toEqual(plan(b, null, i, offer));
      }),
      run,
    );
  });

  it("reads every spelling of a language as the language: letter case, a name, a regional tag", () => {
    fc.assert(
      fc.property(
        backend,
        fc.constantFrom(...SPELLINGS),
        installed,
        fc.boolean(),
        (b, s, i, offer) => {
          const code = whisperCode(s);
          expect(plan(b, s, i, offer)).toEqual(plan(b, code === "" ? null : code, i, offer));
        },
      ),
      run,
    );
  });

  it("depends on which files are installed, not on the order, repeats or unknown names in the list", () => {
    fc.assert(
      fc.property(backend, language, installed, fc.boolean(), (b, l, i, offer) => {
        const known = [...new Set(i.filter((k) => k === BASELINE || k === SMALLER))].sort();
        expect(plan(b, l, [...i].reverse(), offer)).toEqual(plan(b, l, known, offer));
        expect(plan(b, l, [...i, ...i], offer)).toEqual(plan(b, l, i, offer));
      }),
      run,
    );
  });

  it("is pure: the same input gives the same plan, a plan is its own object, and the input is left as it was", () => {
    fc.assert(
      fc.property(backend, language, installed, fc.boolean(), (b, l, i, offer) => {
        const frozen = Object.freeze([...i]);
        const input: PlanInput = Object.freeze({ backend: b, language: l, installed: frozen });
        const first = planModel(input, offer);
        const second = planModel(input, offer);
        expect(second).toEqual(first);
        expect(second).not.toBe(first);
        expect(frozen).toEqual(i);
      }),
      run,
    );
  });

  it("a refused run is re-planned once with the language it turned out to be in, and that plan is kept (the loop ends)", () => {
    fc.assert(
      fc.property(
        backend,
        language,
        installed,
        fc.boolean(),
        language,
        (b, predicted, i, offer, detected) => {
          if (!resolvable(detected)) return;
          const first = plan(b, predicted, i, offer);
          if (acceptableRun(first, detected as string)) return;
          // The first run made its file, so it is installed now.
          const second = plan(b, detected, [...i, first.key], offer);
          expect(acceptableRun(second, detected as string)).toBe(true);
        },
      ),
      { numRuns: 600 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// acceptableRun: the commit point
// ---------------------------------------------------------------------------------------------------------------

describe("acceptableRun: today's file is judged as it always was, the smaller file by the processor's table", () => {
  it("today's file, for every spelling and every width from 0 to 6, is exactly what the old code said", () => {
    const drifted: string[] = [];
    for (const [spelling, perVariant] of Object.entries(FREEZE.languages))
      for (let beam = 0; beam <= 6; beam++) {
        const old = perVariant.f16[1][beam] === "1";
        if (acceptableRun({ variant: "f16", beam }, spelling) !== old)
          drifted.push(`${JSON.stringify(spelling)} at ${beam}`);
      }
    expect(drifted).toEqual([]);
  });

  it("the smaller file is acceptable for a language only when the study cleared it there, and at no narrower a beam", () => {
    const drifted: string[] = [];
    for (const spelling of SPELLINGS)
      for (let beam = 0; beam <= 6; beam++) {
        const need = needOf(whisperCode(spelling));
        const want = need !== null && beam >= need;
        if (acceptableRun({ variant: "q8_0", beam }, spelling) !== want)
          drifted.push(`${spelling} at ${beam}`);
      }
    expect(drifted).toEqual([]);
  });

  it("never accepts Arabic, nor a language nobody measured, from the smaller file, at any width", () => {
    for (const language of [
      "ar",
      "arabic",
      "ara",
      "AR",
      "ar-EG",
      "fi",
      "he",
      "zz",
      "",
      "auto",
      "klingon",
      "__proto__",
    ])
      for (const beam of [0, 1, 2, 3, 4, 5, 6, 99, Infinity])
        expect(acceptableRun({ variant: "q8_0", beam }, language), `${language} at ${beam}`).toBe(
          false,
        );
  });

  it("accepts today's file at the default width for every string, which is what makes the re-plan loop end", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constantFrom(...SPELLINGS), fc.anything()),
        (detected) => {
          expect(acceptableRun({ variant: "f16", beam: 5 }, detected as string)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("a wider beam is never less acceptable than a narrower one", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ModelVariant>("f16", "q8_0", "q5_1"),
        fc.oneof(fc.constantFrom(...SPELLINGS), fc.string()),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 6 }),
        (variant, language, a, b) => {
          const [narrow, wide] = a <= b ? [a, b] : [b, a];
          if (acceptableRun({ variant, beam: narrow }, language))
            expect(acceptableRun({ variant, beam: wide }, language)).toBe(true);
        },
      ),
    );
  });

  it("accepts nothing made by a variant that no manifest entry carries, or by anything that is not a run", () => {
    for (const language of ["en", "nl", "ko", "ar", ""])
      for (const beam of [0, 1, 5, 6])
        expect(acceptableRun({ variant: "q5_1", beam }, language)).toBe(false);
    for (const used of [
      undefined,
      null,
      {},
      { variant: "constructor", beam: 5 },
      { variant: "f16" },
      { variant: "q8_0", beam: NaN },
    ])
      expect(acceptableRun(used as never, "en"), JSON.stringify(used)).toBe(false);
  });

  it("agrees with the plan: the file and beam planModel picks for a language are accepted for it, on every table row", () => {
    for (const [language, , off, on] of PROCESSOR_TABLE) {
      if (language === null) continue;
      for (const [offer, [key, beam]] of [
        [false, off],
        [true, on],
      ] as Array<[boolean, Outcome]>)
        expect(
          acceptableRun({ variant: MODEL_MANIFEST[key].variant, beam }, language),
          `${language} ${offer}`,
        ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The failure direction: hostile input, and manifests and gates that are not the shipped ones
// ---------------------------------------------------------------------------------------------------------------

describe("hostile input is never a reason to use the smaller file, and never a throw", () => {
  const hostileLanguages: unknown[] = [
    "",
    "auto",
    "x".repeat(10_000),
    "__proto__",
    "constructor",
    "toString",
    [],
    ["en"],
    {},
    { toString: () => "en" },
    0,
    NaN,
    true,
    undefined,
  ];

  it("a language that is not a readable string is nothing known: today's file when it is here, else the smaller one", () => {
    for (const language of hostileLanguages) {
      expect(plan("cpu", language as string, [BASELINE]), String(language).slice(0, 12)).toEqual({
        key: BASELINE,
        variant: "f16",
        beam: 5,
      });
      expect(plan("cpu", language as string, []).key).toBe(SMALLER);
      expect(plan("gpu", language as string, [SMALLER]).key).toBe(BASELINE);
    }
  });

  it("an installed list that is not a list is an empty one, and names the manifest does not have are no files", () => {
    for (const installed of [null, undefined, "small", "small_q8_0", { 0: "small", length: 1 }, 7])
      expect(plan("cpu", "en", installed as never)).toEqual(plan("cpu", "en", []));
    expect(
      plan("cpu", "en", [
        "__proto__",
        "constructor",
        "toString",
        "SMALL",
        " small",
        "small ",
        "small\0",
      ]),
    ).toEqual(plan("cpu", "en", []));
  });

  it("a backend that is not exactly 'cpu' is the graphics chip: the smaller file is never planned for it", () => {
    for (const backend of [
      "CPU",
      "cpu ",
      " cpu",
      "Cpu",
      "processor",
      "",
      null,
      undefined,
      0,
      {},
      ["cpu"],
    ])
      expect(plan(backend as never, "en", [SMALLER]).key, String(backend)).toBe(BASELINE);
  });

  it("an input that is not an object at all is still a plan", () => {
    for (const input of [undefined, null, 0, "cpu", [], () => 1])
      expect(planModel(input as never)).toEqual({
        key: BASELINE,
        variant: "f16",
        beam: DEFAULT_BEAM,
      });
  });
});

// The rules over worlds the shipped files are not: a manifest or a gate that is wrong must not make a wrong launch.
describe("the rules over a manifest or a gate that is not the shipped one", () => {
  const entry = (
    file: string,
    variant: ModelVariant,
    backends?: readonly SpeechBackend[],
  ): ModelEntry => ({
    file,
    bytes: 1,
    sha256: "0".repeat(64),
    revision: "0".repeat(40),
    variant,
    ...(backends ? { backends } : {}),
  });
  type Cell = { diff_points: number; ci_high: number };
  const PASS: Cell = { diff_points: 0.5, ci_high: 1.5 };
  const FAIL: Cell = { diff_points: 2.5, ci_high: 4.5 };
  const gate = (
    settings: Record<string, { variant: string; beam: number; backend?: string }>,
    rows: Array<[language: string, results: Record<string, Cell>]>,
  ): GateEvidence =>
    ({
      settings: Object.fromEntries(
        Object.entries(settings).map(([id, s]) => [id, { flags: [], ...s }]),
      ),
      rows: rows.map(([language, results], i) => ({ set: `s${i}`, language, results })),
    }) as unknown as GateEvidence;
  const processorGate = gate(
    {
      C1: { variant: "q8_0", beam: 1, backend: "cpu" },
      C5: { variant: "q8_0", beam: 5, backend: "cpu" },
    },
    [
      ["en", { C1: PASS }],
      ["nl", { C1: FAIL, C5: PASS }],
      ["ar", { C5: FAIL }],
      ["fr", { C1: PASS, C5: FAIL }],
      ["de", { C1: PASS }],
      ["de", { C1: FAIL }],
      ["ko", { C5: PASS }],
      ["it", { C1: PASS, C5: PASS }],
      ["sv", {}],
    ],
  );
  const shipped = {
    small: entry("ggml-small.bin", "f16"),
    small_q8_0: entry("ggml-small-q8_0.bin", "q8_0", ["cpu"]),
  };

  it("reads a language from its own cells: greedy first, else 5 beams, never a failing or a missing cell, never one set of two", () => {
    const rules = modelRules(shipped, "small", processorGate);
    const got = Object.fromEntries(
      ["en", "nl", "ar", "fr", "de", "ko", "it", "sv", "fi"].map((l) => [
        l,
        rules.processorBeam(l),
      ]),
    );
    // "it" passes at both widths, and takes the narrower; no language of the shipped gate does, so only this world says so.
    expect(got).toEqual({
      en: 1,
      nl: 5,
      ar: null,
      fr: 1,
      de: null,
      ko: 5,
      it: 1,
      sv: null,
      fi: null,
    });
  });

  it("plans the smaller file only from processor measurements: a gate that cleared it on the chip alone clears nothing", () => {
    const chipOnly = gate(
      { C1: { variant: "q8_0", beam: 1 }, C5: { variant: "q8_0", beam: 5, backend: "gpu" } },
      [["en", { C1: PASS, C5: PASS }]],
    );
    const rules = modelRules(shipped, "small", chipOnly);
    expect(rules.processorBeam("en")).toBeNull();
    for (const language of [null, "en", "auto"])
      expect(rules.planModel({ backend: "cpu", language, installed: [] }).key).toBe("small");
  });

  it("a setting that names its path in some other way clears nothing, on either path", () => {
    const odd = gate(
      {
        C1: { variant: "q8_0", beam: 1, backend: "CPU" },
        C2: { variant: "q8_0", beam: 5, backend: "processor" },
      },
      [["en", { C1: PASS, C2: PASS }]],
    );
    const rules = modelRules(shipped, "small", odd);
    expect(rules.processorBeam("en")).toBeNull();
    expect(rules.planModel({ backend: "cpu", language: "en", installed: [] }).key).toBe("small");
  });

  it("a file the manifest lists with no path at all is never planned and never launched", () => {
    const manifest = { small: shipped.small, dead: entry("ggml-small-q8_0.bin", "q8_0", []) };
    const rules = modelRules(manifest, "small", processorGate);
    for (const language of [null, "en", "nl"])
      expect(rules.planModel({ backend: "cpu", language, installed: [] }).key).toBe("small");
    const argv = ["-m", "/m/ggml-small-q8_0.bin"];
    for (const cpuOnly of [true, false]) expect(() => rules.launchPlan(argv, cpuOnly)).toThrow();
    expect(() => rules.assertLaunchArgv(argv)).toThrow();
    expect(() => rules.assertLaunchArgv([...argv, "-ng"])).toThrow();
  });

  it("a file the manifest allows on the chip only is never launched on the processor", () => {
    const rules = modelRules(
      { small: shipped.small, chipOnly: entry("ggml-small-q8_0.bin", "q8_0", ["gpu"]) },
      "small",
      processorGate,
    );
    const argv = ["-m", "/m/ggml-small-q8_0.bin"];
    expect(() => rules.launchPlan(argv, true)).toThrow();
    expect(rules.launchPlan(argv, false)).toEqual({ cpuOnly: false, key: "chipOnly" });
    expect(() => rules.assertLaunchArgv([...argv, "-ng"])).toThrow();
    expect(() => rules.assertLaunchArgv(argv)).not.toThrow();
  });

  it("a manifest with no file restricted to the processor plans today's file on every path", () => {
    const rules = modelRules(
      { small: shipped.small, big: entry("ggml-small-q8_0.bin", "q8_0") },
      "small",
      processorGate,
    );
    for (const language of [null, "en", "nl", "ar"])
      expect(rules.planModel({ backend: "cpu", language, installed: [] }).key).toBe("small");
    // ...and the unrestricted file keeps both paths: nothing is converted.
    expect(rules.launchPlan(["-m", "/m/ggml-small-q8_0.bin"], false)).toEqual({
      cpuOnly: false,
      key: "big",
    });
  });

  it("a restricted file nothing was cleared for is not planned, though the manifest restricts it", () => {
    const rules = modelRules(shipped, "small", gate({}, []));
    expect(rules.planModel({ backend: "cpu", language: null, installed: [] }).key).toBe("small");
    // It is still never launched on the chip.
    expect(rules.launchPlan(["-m", "/m/ggml-small-q8_0.bin"], false).cpuOnly).toBe(true);
  });

  it("with two files restricted to the processor, the first is planned, and both are held to the processor", () => {
    const manifest = { ...shipped, other: entry("ggml-small-q5_1.bin", "q5_1", ["cpu"]) };
    const rules = modelRules(
      manifest,
      "small",
      gate(
        {
          C1: { variant: "q8_0", beam: 1, backend: "cpu" },
          D1: { variant: "q5_1", beam: 1, backend: "cpu" },
        },
        [["en", { C1: PASS, D1: PASS }]],
      ),
    );
    expect(rules.planModel({ backend: "cpu", language: "en", installed: [] }).key).toBe(
      "small_q8_0",
    );
    for (const file of ["ggml-small-q8_0.bin", "ggml-small-q5_1.bin"]) {
      expect(rules.launchPlan(["-m", `/m/${file}`], false).cpuOnly).toBe(true);
      expect(() => rules.assertLaunchArgv(["-m", `/m/${file}`])).toThrow();
      expect(() => rules.assertLaunchArgv(["-m", `/m/${file}`, "-ng"])).not.toThrow();
    }
  });

  it("two files that differ only in letter case name no one: the file name is ambiguous, so it is refused", () => {
    const rules = modelRules(
      { small: shipped.small, twin: entry("GGML-SMALL.BIN", "q8_0", ["cpu"]) },
      "small",
      processorGate,
    );
    expect(rules.modelKeyOfPath("/m/ggml-small.bin")).toBeNull();
    expect(() => rules.launchPlan(["-m", "/m/ggml-small.bin"], false)).toThrow();
  });

  it("refuses to be built without its baseline file", () => {
    expect(() => modelRules(shipped, "missing", processorGate)).toThrow();
    expect(() => modelRules(shipped, "__proto__", processorGate)).toThrow();
  });
});

describe("the module's exports are the shipped rules", () => {
  it("planModel, processorBeam, acceptableRun, launchPlan, assertLaunchArgv and modelKeyOfPath agree with modelRules over the shipped files", () => {
    const rules = modelRules(MODEL_MANIFEST, DEFAULT_MODEL_KEY, SHIPPED_EVIDENCE);
    for (const code of CODES) expect(processorBeam(code)).toBe(rules.processorBeam(code));
    expect(planModel({ backend: "cpu", language: "nl", installed: [] })).toEqual(
      rules.planModel({ backend: "cpu", language: "nl", installed: [] }),
    );
    const argv = ["-m", `/models/${MODEL_MANIFEST[SMALLER].file}`];
    expect(launchPlan(argv, false)).toEqual(rules.launchPlan(argv, false));
    expect(modelKeyOfPath(argv[1])).toBe(SMALLER);
    expect(() => assertLaunchArgv(argv)).toThrow();
    expect(() => assertLaunchArgv([...argv, "-ng"])).not.toThrow();
    expect(acceptableRun({ variant: "q8_0", beam: 5 }, "nl")).toBe(true);
  });
});
