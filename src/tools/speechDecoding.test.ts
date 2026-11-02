import fc from "fast-check";
import { describe, expect, it } from "vitest";

import evidence from "./speechGate.json";
import {
  acceptableBeam,
  beamFor,
  clearedLanguages,
  clears,
  decodeArgs,
  DEFAULT_BEAM,
  GREEDY_BEAM,
  greedyTable,
  lastSpeechLanguage,
  MAX_LOSS_UPPER,
  MAX_POINT_LOSS,
  planDecode,
  rememberSpeechLanguage,
  SPEECH_LANGUAGE_KEY,
  type GateEvidence,
  type GateResult,
  type GateRow,
  type ModelVariant,
} from "./speechDecoding";
import { WHISPER_LANGUAGES } from "./whisperLanguages";

const GATE = evidence as GateEvidence;
const VARIANTS: ModelVariant[] = ["f16", "q8_0", "q5_1"];
const CODES = Object.keys(WHISPER_LANGUAGES);

const pass: GateResult = { diff_points: MAX_POINT_LOSS / 10, ci_high: MAX_LOSS_UPPER / 2 };
const fail: GateResult = { diff_points: MAX_POINT_LOSS * 1.2, ci_high: MAX_LOSS_UPPER * 1.2 };
const row = (language: string, ...results: GateResult[]): GateRow => ({
  set: language,
  language,
  results: Object.fromEntries(results.map((r, i) => [`S${i}`, r])),
});

// The rule is the owner's tolerance in code: at most two points worse, and an interval that rules
// out a loss of more than four. A result that is not a clear pass is not one.
describe("clears", () => {
  it("is the owner's two points, written as plain numbers so a drift in the constants shows", () => {
    expect(clears({ diff_points: 1.9, ci_high: 3.9 })).toBe(true); // over the old 1-point tolerance
    expect(clears({ diff_points: 2.01, ci_high: 0 })).toBe(false);
    expect(clears({ diff_points: 0, ci_high: 4.01 })).toBe(false);
  });

  it("passes at the tolerance and fails just past it, in either figure", () => {
    expect(clears({ diff_points: MAX_POINT_LOSS, ci_high: MAX_LOSS_UPPER })).toBe(true);
    expect(clears({ diff_points: MAX_POINT_LOSS + 0.01, ci_high: 0 })).toBe(false);
    expect(clears({ diff_points: 0, ci_high: MAX_LOSS_UPPER + 0.01 })).toBe(false);
    expect(clears({ diff_points: -3, ci_high: -1 })).toBe(true); // better than today
  });

  it("is never true for a missing, NaN or infinite figure", () => {
    expect(clears(undefined)).toBe(false);
    for (const bad of [NaN, Infinity, -Infinity])
      for (const other of [0, bad]) {
        expect(clears({ diff_points: bad, ci_high: other })).toBe(false);
        expect(clears({ diff_points: other, ci_high: bad })).toBe(false);
      }
  });
});

describe("clearedLanguages: a language is cleared only when EVERY test set of it clears", () => {
  const language = fc.constantFrom("en", "es", "ko", "hi");
  const result = fc.constantFrom(pass, fail);
  const rows = fc.array(fc.tuple(language, result), { maxLength: 24 });
  const build = (list: Array<[string, GateResult]>): GateRow[] =>
    list.map(([l, r]) => ({ set: l, language: l, results: { S0: r } }));

  it("does not depend on the order the rows come in", () => {
    fc.assert(
      fc.property(rows, fc.infiniteStream(fc.nat()), (list, rolls) => {
        const shuffled = [...list];
        const take = rolls[Symbol.iterator]();
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = (take.next().value as number) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        expect(clearedLanguages(build(shuffled), "S0")).toEqual(
          clearedLanguages(build(list), "S0"),
        );
      }),
    );
  });

  it("loses a language the moment one of its sets fails, and gains nothing for a failure", () => {
    fc.assert(
      fc.property(rows, language, (list, l) => {
        const before = clearedLanguages(build(list), "S0");
        const after = clearedLanguages(build([...list, [l, fail]]), "S0");
        expect(after.has(l)).toBe(false);
        for (const other of after) expect(before.has(other)).toBe(true);
        for (const other of before) if (other !== l) expect(after.has(other)).toBe(true);
      }),
    );
  });

  it("never lets another language's pass rescue a failing one", () => {
    fc.assert(
      fc.property(rows, language, (list, l) => {
        const withFailure = build([...list, [l, fail]]);
        const rescued = [...withFailure, ...build([[l === "en" ? "es" : "en", pass]])];
        expect(clearedLanguages(rescued, "S0").has(l)).toBe(false);
      }),
    );
  });

  it("does not clear a language that was measured for another setting only", () => {
    expect(clearedLanguages([row("en", pass)], "S1").has("en")).toBe(false);
    expect(clearedLanguages([row("en", pass, pass)], "S1").has("en")).toBe(true);
    expect(clearedLanguages([], "S0").size).toBe(0);
  });
});

// The shipped table is read from the gate's own evidence. These check the file against the code,
// not against a list typed beside it: the two places that apply the rule (the gate tool and the
// app) must agree on every measured result, the arguments the app passes must be the ones that
// were measured, and the table must not be silently empty.
describe("the shipped evidence", () => {
  it("says what the app would conclude: every recorded verdict agrees with the rule in code", () => {
    let checked = 0;
    for (const r of GATE.rows)
      for (const [id, result] of Object.entries(r.results)) {
        const recorded = (result as GateResult & { verdict: string }).verdict;
        expect(clears(result), `${r.set} ${id}`).toBe(recorded === "pass");
        checked++;
      }
    expect(checked).toBeGreaterThan(20);
  });

  it("measured exactly the arguments the app passes for the same beam", () => {
    for (const [id, s] of Object.entries(GATE.settings)) {
      expect(decodeArgs(s.beam), `setting ${id}`).toEqual([...s.flags]);
    }
    // And the setting everything is compared against is the engine's own default.
    expect(decodeArgs(DEFAULT_BEAM)).toEqual([]);
  });

  it("gives every measured language the beam its own results call for, on each model variant", () => {
    for (const variant of VARIANTS) {
      const settingId = Object.entries(GATE.settings).find(
        ([, s]) => s.variant === variant && s.beam === GREEDY_BEAM,
      )?.[0];
      for (const language of new Set(GATE.rows.map((r) => r.language))) {
        const sets = GATE.rows.filter((r) => r.language === language);
        const allClear = settingId !== undefined && sets.every((r) => clears(r.results[settingId]));
        expect(beamFor(variant, language), `${variant} ${language}`).toBe(
          allClear ? GREEDY_BEAM : DEFAULT_BEAM,
        );
      }
    }
  });

  it("is not empty: the language most people speak is cleared on the model every install has", () => {
    // The opposite failure: a broken derivation that clears nothing would pass every test above
    // and quietly give nobody the speed-up.
    expect(beamFor("f16", "en")).toBe(GREEDY_BEAM);
    expect(greedyTable(GATE).get("f16")!.size).toBeGreaterThan(3);
  });

  it("applies the two-point tolerance to measured languages at both of its edges", () => {
    // Cleared only since the tolerance went from one point to two: each costs between 1 and 2
    // points with an interval that stays under 4.
    for (const code of ["nl", "tr", "uk", "vi"])
      expect(beamFor("f16", code), code).toBe(GREEDY_BEAM);
    // Past the point edge (ko), past the interval edge (pl: about +1.8 but possibly +4.5) and far
    // past both (hi).
    for (const code of ["ko", "pl", "hi"]) expect(beamFor("f16", code), code).toBe(DEFAULT_BEAM);
  });

  it("never narrows a language it has no measurement for", () => {
    const measured = new Set(GATE.rows.map((r) => r.language));
    for (const code of CODES)
      if (!measured.has(code))
        for (const v of VARIANTS) expect(beamFor(v, code), `${v} ${code}`).toBe(DEFAULT_BEAM);
  });
});

describe("beamFor", () => {
  it("is the default or greedy for ANY string, and never throws", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.constantFrom(...CODES), fc.anything()), (raw) => {
        for (const v of VARIANTS) {
          const beam = beamFor(v, raw as string);
          expect([GREEDY_BEAM, DEFAULT_BEAM]).toContain(beam);
        }
      }),
    );
  });

  it("treats names every object has, and nothing, as an unknown language", () => {
    for (const odd of ["constructor", "__proto__", "toString", "hasOwnProperty", "", "auto", "zz"])
      expect(beamFor("f16", odd), odd).toBe(DEFAULT_BEAM);
  });

  it("reads a language the way the engine's own table does (regional tags and names)", () => {
    expect(beamFor("f16", "en-US")).toBe(beamFor("f16", "en"));
    expect(beamFor("f16", "EN")).toBe(beamFor("f16", "en"));
    expect(beamFor("f16", "english")).toBe(beamFor("f16", "en"));
  });
});

describe("decodeArgs", () => {
  it("is nothing at the default width, and an equal pair of arguments below it", () => {
    expect(decodeArgs(5)).toEqual([]);
    expect(decodeArgs(1)).toEqual(["-bs", "1", "-bo", "1"]);
    expect(decodeArgs(3)).toEqual(["-bs", "3", "-bo", "3"]);
  });

  it("falls back to the DEFAULT, never to the narrowest setting, for anything that is not a beam", () => {
    for (const bad of [0, -1, -100, NaN, Infinity, -Infinity, 0.4])
      expect(decodeArgs(bad), String(bad)).toEqual([]);
    expect(decodeArgs(99)).toEqual([]);
  });

  it("is [] or the exact four-argument form with a width in 1 to 4, for ANY number", () => {
    fc.assert(
      fc.property(fc.oneof(fc.double(), fc.integer({ min: -10, max: 10 })), (beam) => {
        const args = decodeArgs(beam);
        if (args.length === 0) return;
        expect(args).toHaveLength(4);
        expect(args[0]).toBe("-bs");
        expect(args[2]).toBe("-bo");
        expect(args[1]).toBe(args[3]);
        expect(Number(args[1])).toBeGreaterThanOrEqual(1);
        expect(Number(args[1])).toBeLessThan(DEFAULT_BEAM);
      }),
    );
  });
});

describe("planDecode and acceptableBeam", () => {
  const anyCode = fc.oneof(fc.constantFrom(...CODES), fc.string());

  it("a named language decides the beam, whatever this machine last heard", () => {
    fc.assert(
      fc.property(anyCode, fc.option(anyCode, { nil: null }), (named, last) => {
        for (const v of VARIANTS) {
          const plan = planDecode(v, named, last);
          if (plan.predicted !== null) expect(plan.beam).toBe(beamFor(v, plan.predicted));
        }
      }),
    );
    expect(planDecode("f16", "es", "ko").beam).toBe(beamFor("f16", "es"));
    expect(planDecode("f16", "ko", "en").beam).toBe(beamFor("f16", "ko"));
  });

  it("with no language named, the last one decides; with none known, the default", () => {
    expect(planDecode("f16", "auto", "en")).toEqual({
      beam: beamFor("f16", "en"),
      predicted: "en",
    });
    expect(planDecode("f16", "auto", null)).toEqual({ beam: DEFAULT_BEAM, predicted: null });
    expect(planDecode("f16", "", null).beam).toBe(DEFAULT_BEAM);
  });

  it("the default beam is acceptable for every language: what ran before can always be kept", () => {
    fc.assert(
      fc.property(anyCode, (detected) => {
        for (const v of VARIANTS) expect(acceptableBeam(DEFAULT_BEAM, v, detected)).toBe(true);
      }),
    );
  });

  it("a wider beam never makes a transcript less acceptable", () => {
    fc.assert(
      fc.property(
        anyCode,
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        (code, a, b) => {
          const [narrow, wide] = a <= b ? [a, b] : [b, a];
          for (const v of VARIANTS)
            if (acceptableBeam(narrow, v, code)) expect(acceptableBeam(wide, v, code)).toBe(true);
        },
      ),
    );
  });

  it("a language nobody measured needs the default: greedy is refused for it", () => {
    expect(acceptableBeam(GREEDY_BEAM, "f16", "zz")).toBe(false);
    expect(acceptableBeam(GREEDY_BEAM, "f16", "")).toBe(false);
  });

  it("the plan's own beam is always acceptable for the language it was chosen for", () => {
    fc.assert(
      fc.property(anyCode, fc.option(anyCode, { nil: null }), (named, last) => {
        for (const v of VARIANTS) {
          const plan = planDecode(v, named, last);
          if (plan.predicted !== null)
            expect(acceptableBeam(plan.beam, v, plan.predicted)).toBe(true);
        }
      }),
    );
  });
});

describe("the last detected language", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      data,
    };
  };

  it("is remembered as the engine's code, however it was written", () => {
    const s = memory();
    rememberSpeechLanguage("es-MX", s);
    expect(lastSpeechLanguage(s)).toBe("es");
    rememberSpeechLanguage("Korean", s);
    expect(lastSpeechLanguage(s)).toBe("ko");
  });

  it("is never made of anything the engine does not know", () => {
    const s = memory();
    for (const odd of ["", "auto", "zz", "<script>", "x".repeat(10_000)]) {
      rememberSpeechLanguage(odd, s);
      expect(s.data.has(SPEECH_LANGUAGE_KEY), JSON.stringify(odd).slice(0, 20)).toBe(false);
    }
    s.data.set(SPEECH_LANGUAGE_KEY, "klingon");
    expect(lastSpeechLanguage(s)).toBeNull();
  });

  it("is no history, not an error, where storage is missing or throws", () => {
    expect(lastSpeechLanguage(null)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(lastSpeechLanguage(broken)).toBeNull();
    expect(() => rememberSpeechLanguage("en", broken)).not.toThrow();
    expect(() => rememberSpeechLanguage("en", null)).not.toThrow();
  });
});
