// The processor-path half of the accuracy gate: the two settings in speechGate.json that were measured with the
// graphics chip off (ZC, q8_0 greedy; ZBC, q8_0 5 beams), and how speechDecoding.ts reads a path's own measurements.
//
// Three witnesses, none of them the code under test: the study's own score files (copied as fixtures), the study's
// decision document section 10.1 (transcribed by hand into speechGateCpuS1.json), and the frozen answers of the old
// code (speechDecodingFreeze.json). The cells were generated from the score files by a script; these tests read the
// cells back and compare them with both, in every row.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import freezeData from "./__fixtures__/speechDecodingFreeze.json";
import s1Data from "./__fixtures__/speechGateCpuS1.json";
import studyGreedy from "./__fixtures__/speechGateCpu.z_vs_B.json";
import studyBeams from "./__fixtures__/speechGateCpu.zb_vs_B.json";
import { backendsOf, MODEL_MANIFEST } from "./modelManifest";
import {
  clearedOn,
  decodeArgs,
  greedyTable,
  measuredOn,
  SHIPPED_EVIDENCE,
  type GateEvidence,
  type ModelVariant,
} from "./speechDecoding";
import gateData from "./speechGate.json";

interface Cell {
  error_pct: number;
  diff_points: number;
  ci_low: number;
  ci_high: number;
  verdict: string;
}
interface GateFile {
  settings: Record<
    string,
    { variant: string; beam: number; model: string; flags: string[]; backend?: string }
  >;
  rows: Array<{
    set: string;
    language: string;
    unit: string;
    utterances: number;
    baseline_error_pct: number;
    results: Record<string, Cell>;
  }>;
}
const GATE = gateData as unknown as GateFile;

type S1Row = [string, string, number, number, number, number, number, "pass" | "fail"];
const S1 = s1Data as unknown as {
  greedy: S1Row[];
  beams: S1Row[];
  languageTable: Array<[string, string, string]>;
};
interface Study {
  others: string[];
  corrected: boolean;
  rows: Array<{
    set: string;
    unit: string;
    n: number;
    base_pct: number;
    results: Record<
      string,
      {
        pct: number;
        diff: number;
        lo: number;
        hi: number;
        verdict: string;
        empty: number;
        overlong: number;
      }
    >;
  }>;
}
const STUDIES: Array<[id: string, cell: string, study: Study, s1: S1Row[]]> = [
  ["ZC", "Z_cpu", studyGreedy as unknown as Study, S1.greedy],
  ["ZBC", "ZB_cpu", studyBeams as unknown as Study, S1.beams],
];

/** The rule the gate file states about itself ("rule"), as the verdict word it gives a result. */
const verdictOf = (diff: number, high: number): string =>
  diff > 2.0 ? "fail" : high <= 4.0 ? "pass" : "weak";
const rowOf = (set: string) => GATE.rows.find((r) => r.set === set)!;

describe("the two processor settings", () => {
  it("are exactly what the lane's contract says: the 8-bit file on the processor, greedy and 5 beams", () => {
    expect(GATE.settings.ZC).toEqual({
      variant: "q8_0",
      beam: 1,
      model: "ggml-small-q8_0.bin",
      flags: ["-bs", "1", "-bo", "1"],
      backend: "cpu",
    });
    expect(GATE.settings.ZBC).toEqual({
      variant: "q8_0",
      beam: 5,
      model: "ggml-small-q8_0.bin",
      flags: [],
      backend: "cpu",
    });
  });

  it("are the only processor settings, and the settings measured before them still read as the graphics chip", () => {
    const processor = Object.entries(GATE.settings).filter(([, s]) => s.backend === "cpu");
    expect(processor.map(([id]) => id)).toEqual(["ZC", "ZBC"]);
    for (const id of ["G", "Q", "Z", "ZB"]) {
      expect(Object.hasOwn(GATE.settings[id], "backend"), id).toBe(false);
      expect(measuredOn(GATE.settings[id]), id).toBe("gpu");
    }
  });

  it("every setting names its path as the code reads it, and no two measure one variant and beam on one path", () => {
    const seen = new Set<string>();
    for (const [id, s] of Object.entries(GATE.settings)) {
      expect([undefined, "gpu", "cpu"], id).toContain(s.backend);
      const where = measuredOn(s);
      expect(where, id).not.toBeNull();
      const key = `${s.variant}/${s.beam}/${where}`;
      expect(seen.has(key), `${id} repeats ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("each processor setting is a manifest file allowed on the processor, at its own variant, with the arguments the app passes for its beam", () => {
    for (const [id, s] of Object.entries(GATE.settings).filter(([, s]) => s.backend === "cpu")) {
      const entry = Object.values(MODEL_MANIFEST).find((e) => e.file === s.model);
      expect(entry, `${id}: ${s.model}`).toBeDefined();
      expect(entry!.variant, id).toBe(s.variant);
      expect(backendsOf(entry!), id).toContain("cpu");
      expect(decodeArgs(s.beam), id).toEqual(s.flags);
      expect([1, 5], id).toContain(s.beam);
    }
  });
});

describe("the processor cells, row by row", () => {
  it("are exactly the cells the study measured: 12 greedy sets and 10 five-beam sets, none for any other set", () => {
    const have = GATE.rows.flatMap((r) =>
      Object.keys(r.results)
        .filter((id) => id === "ZC" || id === "ZBC")
        .map((id) => `${id}:${r.set}`),
    );
    const want = STUDIES.flatMap(([id, , study]) => study.rows.map((r) => `${id}:${r.set}`));
    expect(have.sort()).toEqual(want.sort());
    expect(have).toHaveLength(22);
    expect(STUDIES[0][2].rows).toHaveLength(12);
    expect(STUDIES[1][2].rows).toHaveLength(10);
  });

  it.each(STUDIES)(
    "%s: every cell is the study's score-file cell, in the gate's own words, with its set's baseline and size",
    (id, cellName, study) => {
      expect(study.corrected).toBe(false);
      expect(study.others).toEqual([cellName]);
      for (const r of study.rows) {
        const row = rowOf(r.set);
        const cell = r.results[cellName];
        expect([row.unit, row.utterances, row.baseline_error_pct], r.set).toEqual([
          r.unit,
          r.n,
          r.base_pct,
        ]);
        const word = verdictOf(cell.diff, cell.hi);
        // The study scores two words; the gate has three, and its "weak" is one of the study's FAIL.
        expect(cell.verdict === "PASS", `${id} ${r.set}`).toBe(word === "pass");
        expect(row.results[id], `${id} ${r.set}`).toEqual({
          error_pct: cell.pct,
          diff_points: cell.diff,
          ci_low: cell.lo,
          ci_high: cell.hi,
          verdict: word,
        });
        // A figure built on empty or runaway output would not be a measurement of speech.
        expect([cell.empty, cell.overlong], `${id} ${r.set}`).toEqual([0, 0]);
      }
    },
  );

  it.each(STUDIES)(
    "%s: the study document's table (section 10.1) says the same of every cell, number by number",
    (id, cellName, study, s1) => {
      expect(s1).toHaveLength(study.rows.length);
      for (const [label, set, base, pct, diff, lo, hi, verdict] of s1) {
        const cell = rowOf(set).results[id];
        expect(cell, `${id} ${label}`).toBeDefined();
        expect(
          [
            rowOf(set).baseline_error_pct,
            cell.error_pct,
            cell.diff_points,
            cell.ci_low,
            cell.ci_high,
            cell.verdict,
          ],
          `${id} ${label}`,
        ).toEqual([base, pct, diff, lo, hi, verdict]);
        // And the table as transcribed is the score file's: a typo in the transcription cannot hide behind a typo in a cell.
        const source = study.rows.find((r) => r.set === set)!.results[cellName];
        expect([pct, diff, lo, hi], `${id} ${label}`).toEqual([
          source.pct,
          source.diff,
          source.lo,
          source.hi,
        ]);
      }
    },
  );

  it("carry the gate's own three words, and each follows the rule from its two figures", () => {
    for (const row of GATE.rows)
      for (const [id, cell] of Object.entries(row.results)) {
        expect(["pass", "fail", "weak"], `${row.set} ${id}`).toContain(cell.verdict);
        expect(cell.verdict, `${row.set} ${id}`).toBe(verdictOf(cell.diff_points, cell.ci_high));
      }
    // The two cells that cross the line, as the findings: Dutch greedy and Arabic 5 beams fail on the processor.
    expect(rowOf("nl").results.ZC.verdict).toBe("fail");
    expect(rowOf("nl").results.ZBC.verdict).toBe("pass");
    expect(rowOf("ar").results.ZBC.verdict).toBe("fail");
    expect(rowOf("ar").results.ZC).toBeUndefined();
  });
});

const sortedOf = (set: ReadonlySet<string> | undefined): string[] => [...(set ?? [])].sort();
/** A table of cleared languages as plain data. */
const plain = (table: ReturnType<typeof clearedOn>): Record<string, Record<string, string[]>> =>
  Object.fromEntries(
    [...table].map(([variant, byBeam]) => [
      variant,
      Object.fromEntries([...byBeam].map(([beam, set]) => [String(beam), sortedOf(set)])),
    ]),
  );

describe("clearedOn reads one path's measurements and no other's", () => {
  const studyGreedyLanguages = S1.languageTable
    .filter((r) => r[2] === "greedy")
    .map((r) => r[1])
    .sort();
  const studyBeamLanguages = S1.languageTable
    .filter((r) => r[2] === "5 beams")
    .map((r) => r[1])
    .sort();

  it("on the processor: the study's table (greedy in 10, 5 beams in 9, Arabic in neither), for the 8-bit variant only", () => {
    const table = plain(clearedOn(SHIPPED_EVIDENCE, "cpu"));
    expect(Object.keys(table)).toEqual(["q8_0"]);
    expect(table.q8_0["1"]).toEqual(studyGreedyLanguages);
    expect(table.q8_0["5"]).toEqual(studyBeamLanguages);
    expect([studyGreedyLanguages.length, studyBeamLanguages.length]).toEqual([10, 9]);
    expect(table.q8_0["1"]).not.toContain("nl");
    expect(table.q8_0["5"]).not.toContain("ar");
    expect(table.q8_0["1"]).not.toContain("ar");
  });

  it("on the chip: what the old code cleared, per setting (the frozen lists), unmoved by the processor settings", () => {
    const frozen = freezeData.clearedLanguages as Record<string, string[]>;
    expect(plain(clearedOn(SHIPPED_EVIDENCE, "gpu"))).toEqual({
      f16: { "1": frozen.G },
      q5_1: { "1": frozen.Q },
      q8_0: { "1": frozen.Z, "5": frozen.ZB },
    });
  });

  it("the two paths really do disagree on this file, which is why neither may stand in for the other", () => {
    const chip = plain(clearedOn(SHIPPED_EVIDENCE, "gpu")).q8_0;
    const processor = plain(clearedOn(SHIPPED_EVIDENCE, "cpu")).q8_0;
    expect(chip["1"]).toContain("nl");
    expect(processor["1"]).not.toContain("nl");
    expect(chip["5"]).toContain("ar");
    expect(processor["5"]).not.toContain("ar");
  });

  it("greedyTable, which beamFor reads, is the chip's table and does not move when the processor settings are removed", () => {
    const withoutProcessor: GateFile = structuredClone(GATE);
    for (const [id, s] of Object.entries(withoutProcessor.settings))
      if (s.backend === "cpu") delete withoutProcessor.settings[id];
    for (const row of withoutProcessor.rows) for (const id of ["ZC", "ZBC"]) delete row.results[id];
    const a = greedyTable(SHIPPED_EVIDENCE);
    const b = greedyTable(withoutProcessor as unknown as GateEvidence);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [variant, set] of a)
      expect(sortedOf(set), variant).toEqual(sortedOf(b.get(variant)));
    expect(sortedOf(a.get("q8_0"))).toEqual(
      (freezeData.greedyTable as Record<string, string[]>).q8_0,
    );
  });
});

describe("measuredOn", () => {
  it("is the chip unless the setting says it was the processor, and nothing for any other spelling of a path", () => {
    expect(measuredOn({})).toBe("gpu");
    expect(measuredOn({ backend: "gpu" })).toBe("gpu");
    expect(measuredOn({ backend: "cpu" })).toBe("cpu");
    for (const odd of [
      "CPU",
      "Cpu",
      " cpu",
      "cpu ",
      "processor",
      "vulkan",
      "",
      null,
      0,
      {},
      ["cpu"],
    ])
      expect(measuredOn({ backend: odd as never }), JSON.stringify(odd)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Properties of the reading, over evidence that is not the shipped one
// ---------------------------------------------------------------------------------------------------------------

type Backend = "gpu" | "cpu" | "CPU" | "" | undefined;
interface MiniSetting {
  variant: string;
  beam: number;
  backend: Backend;
}
interface MiniEvidence {
  settings: Record<string, MiniSetting>;
  rows: Array<{
    language: string;
    results: Record<string, { diff_points: number; ci_high: number } | undefined>;
  }>;
}

describe("clearedOn and greedyTable, over any evidence", () => {
  const IDS = ["S0", "S1", "S2", "S3", "S4"];
  const cell = fc.constantFrom(
    { diff_points: 0.5, ci_high: 1.5 }, // passes
    { diff_points: 2.0, ci_high: 4.0 }, // passes, at both edges
    { diff_points: 2.01, ci_high: 1.0 }, // fails on the point loss
    { diff_points: 1.0, ci_high: 4.01 }, // weak: the interval is too wide
    undefined, // no cell
  );
  const setting = fc.record({
    variant: fc.constantFrom("f16", "q8_0", "q5_1", "f32"),
    beam: fc.constantFrom(1, 5, 3),
    backend: fc.constantFrom<Backend>("gpu", "cpu", "CPU", "", undefined),
  });
  const evidence: fc.Arbitrary<MiniEvidence> = fc.record({
    settings: fc.dictionary(fc.constantFrom(...IDS), setting),
    rows: fc.array(
      fc.record({
        language: fc.constantFrom("a", "b", "c", "d"),
        results: fc.dictionary(fc.constantFrom(...IDS), cell),
      }),
      { maxLength: 10 },
    ),
  });
  const asEvidence = (e: MiniEvidence): GateEvidence =>
    ({
      settings: Object.fromEntries(
        Object.entries(e.settings).map(([id, s]) => [id, { flags: [], ...s }]),
      ),
      rows: e.rows.map((r, i) => ({ set: `s${i}`, ...r })),
    }) as unknown as GateEvidence;
  const run = { numRuns: 400 };

  /** An independent oracle: a language is cleared at (variant, beam) on a path iff some setting measures exactly that
   *  there, and for EVERY such setting, EVERY row of the language has a cell that passes the owner's rule. */
  const oracle = (
    e: MiniEvidence,
    path: "gpu" | "cpu",
  ): Record<string, Record<string, string[]>> => {
    const out: Record<string, Record<string, string[]>> = {};
    const known = new Set(["f16", "q8_0", "q5_1"]);
    const languages = [...new Set(e.rows.map((r) => r.language))];
    const onPath = (s: MiniSetting): boolean =>
      (s.backend === undefined ? "gpu" : s.backend) === path;
    for (const s of Object.values(e.settings).filter((x) => onPath(x) && known.has(x.variant))) {
      const same = Object.entries(e.settings).filter(
        ([, o]) => onPath(o) && o.variant === s.variant && o.beam === s.beam,
      );
      out[s.variant] ??= {};
      out[s.variant][String(s.beam)] = languages
        .filter((l) =>
          same.every(([id]) =>
            e.rows
              .filter((r) => r.language === l)
              .every((r) => {
                const c = r.results[id];
                return c !== undefined && c.diff_points <= 2.0 && c.ci_high <= 4.0;
              }),
          ),
        )
        .sort();
    }
    return out;
  };

  it("clears a language on a path exactly when every measurement of that variant and beam on THAT path passes in every row", () => {
    fc.assert(
      fc.property(evidence, (e) => {
        for (const path of ["gpu", "cpu"] as const)
          expect(plain(clearedOn(asEvidence(e), path)), path).toEqual(oracle(e, path));
      }),
      run,
    );
  });

  it("is not moved by anything measured on the other path, in either direction", () => {
    fc.assert(
      fc.property(evidence, (e) => {
        for (const [path, other] of [
          ["cpu", "gpu"],
          ["gpu", "cpu"],
        ] as const) {
          const kept: MiniEvidence = {
            settings: Object.fromEntries(
              Object.entries(e.settings).filter(
                ([, s]) => (s.backend === undefined ? "gpu" : s.backend) !== other,
              ),
            ),
            rows: e.rows,
          };
          expect(plain(clearedOn(asEvidence(e), path))).toEqual(
            plain(clearedOn(asEvidence(kept), path)),
          );
        }
      }),
      run,
    );
  });

  it("clears nothing for a setting whose path is spelled any way but gpu, cpu or nothing", () => {
    fc.assert(
      fc.property(evidence, (e) => {
        const named = Object.fromEntries(
          Object.entries(e.settings).filter(([, s]) => s.backend === "CPU" || s.backend === ""),
        );
        const only: MiniEvidence = { settings: named, rows: e.rows };
        expect(plain(clearedOn(asEvidence(only), "cpu"))).toEqual({});
        expect(plain(clearedOn(asEvidence(only), "gpu"))).toEqual({});
      }),
      run,
    );
  });

  it("does not depend on the order of the settings or of the rows", () => {
    fc.assert(
      fc.property(evidence, (e) => {
        const reversed: MiniEvidence = {
          settings: Object.fromEntries(Object.entries(e.settings).reverse()),
          rows: [...e.rows].reverse(),
        };
        for (const path of ["gpu", "cpu"] as const)
          expect(plain(clearedOn(asEvidence(reversed), path))).toEqual(
            plain(clearedOn(asEvidence(e), path)),
          );
      }),
      run,
    );
  });

  it("greedyTable takes the chip's greedy settings only, whatever else the evidence holds", () => {
    fc.assert(
      fc.property(evidence, (e) => {
        // What the old code did, with the one difference this change makes: a setting measured elsewhere is skipped.
        const want = new Map<string, string[]>();
        for (const [id, s] of Object.entries(e.settings)) {
          if (s.backend !== undefined && s.backend !== "gpu") continue;
          if (s.beam !== 1 || !["f16", "q8_0", "q5_1"].includes(s.variant)) continue;
          const languages = [...new Set(e.rows.map((r) => r.language))];
          want.set(
            s.variant,
            languages
              .filter((l) =>
                e.rows
                  .filter((r) => r.language === l)
                  .every((r) => {
                    const c = r.results[id];
                    return c !== undefined && c.diff_points <= 2.0 && c.ci_high <= 4.0;
                  }),
              )
              .sort(),
          );
        }
        const got = greedyTable(asEvidence(e));
        expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
        for (const [variant, set] of got) expect(sortedOf(set), variant).toEqual(want.get(variant));
      }),
      run,
    );
  });

  it("walks every variant the type allows, so a new one cannot be left out of the reading", () => {
    const variants: Record<ModelVariant, true> = { f16: true, q8_0: true, q5_1: true };
    for (const variant of Object.keys(variants)) {
      const e: MiniEvidence = {
        settings: { S0: { variant, beam: 1, backend: "cpu" } },
        rows: [{ language: "a", results: { S0: { diff_points: 0, ci_high: 0 } } }],
      };
      expect(plain(clearedOn(asEvidence(e), "cpu")), variant).toEqual({
        [variant]: { "1": ["a"] },
      });
    }
  });
});
