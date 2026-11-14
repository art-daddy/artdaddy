// The two hints under the Graphics chip row (E8-4): an NVIDIA driver older than the pinned encoder needs, and Intel graphics that may be
// switched off in the BIOS. They are a pure function of what the app reads and they stay on the PC. The tests walk every combination of
// maker, driver string, test result, other adapters and processor name, and check the sentences against templates written out here.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  INTEL_SUFFIXES,
  NO_GRAPHICS_MODELS,
  NVIDIA_MIN_DRIVER,
  chipAdvice,
  hasIntelGraphics,
  nvidiaDriverNumber,
  nvidiaDriverUnits,
  type ChipAdviceFacts,
} from "./chipAdvice";
import type { ChipTestResult } from "./chipTest";
import { CHIP_MAKERS, type ChipMaker } from "./exportEncoder";

// The sentences of the copy pack (BUILD-PLAN-3c.md section 3), with their two blanks, written out here and not read from the module.
const nvidiaLine = (driver: string) =>
  `Your NVIDIA graphics driver is ${driver}. ArtDaddy's graphics-chip path needs 610 or newer. If a newer driver exists for your card, updating it can make exports faster. If not, ArtDaddy keeps using the processor.`;
const intelLine = (seen: string) =>
  `Your processor has Intel graphics, but ArtDaddy can only see ${seen} graphics. The Intel graphics may be switched off in your PC's BIOS. If it is switched on, ArtDaddy can test it and use it to make exports faster when it passes.`;

const RESULTS: ReadonlyArray<ChipTestResult | null> = [
  null,
  "passed",
  "no_device",
  "encode_failed",
  "garbled",
  "below_x264",
  "wrong_frames",
  "timed_out",
  "cached_pass",
  "cached_fail",
  "skipped_busy",
];

describe("NVIDIA's own driver number, from the four parts Windows keeps", () => {
  it.each([
    ["32.0.15.6094", 56094, "560.94"],
    ["31.0.15.5123", 55123, "551.23"],
    ["31.0.14.9729", 49729, "497.29"],
    ["32.0.16.1000", 61000, "610.00"],
    ["32.0.16.1012", 61012, "610.12"],
    ["32.0.16.0999", 60999, "609.99"],
    ["32.0.15.0001", 50001, "500.01"],
    ["27.21.14.6109", 46109, "461.09"],
  ])("%s is %s (%s)", (driver, units, shown) => {
    expect(nvidiaDriverUnits(driver)).toBe(units);
    expect(nvidiaDriverNumber(driver)).toBe(shown);
  });

  it.each([
    "",
    "garbage",
    "551.23",
    "32.0.15",
    "32.0.15.60",
    "32.0.15.609",
    "32.0.15.60940",
    "32.0.15.6094.1",
    "a.b.c.d",
    "32.0.15.60a4",
    " 32.0.15.6094",
    "32.0.15.6094 ",
    "32..15.6094",
    "32.0..6094",
    "32.0.15.",
    "-32.0.15.6094",
    "32.0.15.-094",
  ])("does not read %j: no number, so no line", (driver) => {
    expect(nvidiaDriverUnits(driver)).toBeNull();
    expect(nvidiaDriverNumber(driver)).toBeNull();
    expect(
      chipAdvice({
        adapters: [{ maker: "nvidia", driver, result: "encode_failed" }],
        processor: null,
      }),
    ).toBeNull();
  });

  it("is the last digit of the third part and the whole fourth, for every driver the four parts can spell (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 0, max: 9999 }),
        (first, third, fourth) => {
          const four = String(fourth).padStart(4, "0");
          const driver = `${first}.0.${third}.${four}`;
          const units = (third % 10) * 10_000 + fourth;
          expect(nvidiaDriverUnits(driver)).toBe(units);
          expect(nvidiaDriverNumber(driver)).toBe(
            `${Math.floor(units / 100)}.${String(units % 100).padStart(2, "0")}`,
          );
        },
      ),
    );
  });

  it("never gives a number for a string that is not four digit-only parts with a four-digit last one, whatever it holds (property)", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const four = /^\d+\.\d+\.\d+\.\d{4}$/.test(text);
        expect(nvidiaDriverUnits(text) !== null).toBe(four);
      }),
    );
  });
});

describe("which processors have Intel graphics on the chip", () => {
  it.each([
    ["Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz", true],
    ["Intel(R) Core(TM) i7-6700K CPU @ 4.00GHz", true],
    ["Intel(R) Core(TM) i5-3470 CPU @ 3.20GHz", true],
    ["Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz", true],
    ["Intel(R) Core(TM) i7-4790K CPU @ 4.00GHz", true],
    ["11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz", true],
    ["12th Gen Intel(R) Core(TM) i7-12700H", true],
    ["13th Gen Intel(R) Core(TM) i9-13980HX", true],
    ["12th Gen Intel(R) Core(TM) i5-12400", true],
    ["Intel(R) Core(TM) i7-8565U CPU @ 1.80GHz", true],
    ["Intel(R) Core(TM) i7-7700HQ CPU @ 2.80GHz", true],
    ["Intel(R) Core(TM) i7-4790T CPU @ 2.70GHz", true],
    // no graphics on the chip
    ["12th Gen Intel(R) Core(TM) i5-12400F", false],
    ["13th Gen Intel(R) Core(TM) i7-13700KF", false],
    ["Intel(R) Core(TM) i9-9900KF CPU @ 3.60GHz", false],
    ["Intel(R) Core(TM) i3-10100F CPU @ 3.60GHz", false],
    ["Intel(R) Core(TM) i9-10980XE CPU @ 3.00GHz", false],
    ["Intel(R) Core(TM) i7-7800X CPU @ 3.50GHz", false],
    ["Intel(R) Core(TM) i7-6800K CPU @ 3.40GHz", false],
    ["Intel(R) Core(TM) i7-5820K CPU @ 3.30GHz", false],
    ["Intel(R) Core(TM) i7-3820 CPU @ 3.60GHz", false],
    // not a model it knows: no hint
    ["Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz", false],
    ["Intel(R) Xeon(R) W-2295 CPU @ 3.00GHz", false],
    ["Intel(R) Core(TM) Ultra 7 155H", false],
    ["Intel(R) Pentium(R) Gold G5400 CPU @ 3.70GHz", false],
    ["Intel(R) Celeron(R) N4020 CPU @ 1.10GHz", false],
    ["Intel(R) Core(TM) i7 CPU 920 @ 2.67GHz", false],
    ["Intel(R) Core(TM) i7-6700Z", false],
    ["Intel(R) Core(TM) i7-6700KFX", false],
    ["Intel(R) Core(TM) i7-67", false],
    ["AMD Ryzen 7 5800X 8-Core Processor", false],
    ["AMD Ryzen 5 5600G with Radeon Graphics", false],
    ["Apple M2", false],
    ["Core i7-6700", false], // no maker named
    ["i7-6700", false],
    ["", false],
  ])("%j: %s", (name, expected) => {
    expect(hasIntelGraphics(name)).toBe(expected);
  });

  it("is false for no name at all, and for anything that is not a string", () => {
    expect(hasIntelGraphics(null)).toBe(false);
    for (const odd of [undefined, 7, {}, [], true] as unknown[])
      expect(hasIntelGraphics(odd as string)).toBe(false);
  });

  // The suffix table is the rule: each suffix is walked here, so a suffix added or moved without its reason fails.
  it("is decided by a table of suffixes that is itself walked: with graphics, none, and every other suffix unknown", () => {
    expect(INTEL_SUFFIXES.none).toEqual(expect.arrayContaining(["F", "KF"]));
    const disjoint = INTEL_SUFFIXES.withGraphics.filter((suffix) =>
      INTEL_SUFFIXES.none.includes(suffix),
    );
    expect(disjoint).toEqual([]);
    for (const suffix of INTEL_SUFFIXES.withGraphics)
      expect(
        hasIntelGraphics(`Intel(R) Core(TM) i7-8700${suffix}`),
        `with ${JSON.stringify(suffix)}`,
      ).toBe(true);
    for (const suffix of INTEL_SUFFIXES.none)
      expect(hasIntelGraphics(`Intel(R) Core(TM) i7-8700${suffix}`), `none ${suffix}`).toBe(false);
    const known = new Set([...INTEL_SUFFIXES.withGraphics, ...INTEL_SUFFIXES.none]);
    for (const letters of ["Z", "W", "L", "TX", "XF", "B", "N", "A", "KS1", "FK"])
      if (!known.has(letters))
        expect(hasIntelGraphics(`Intel(R) Core(TM) i7-8700${letters}`), `unknown ${letters}`).toBe(
          false,
        );
  });

  it("knows the desktop parts of the X79 and X99 platforms have no graphics, whatever their suffix", () => {
    for (const model of NO_GRAPHICS_MODELS) {
      const [prefix, rest] = model.split("-");
      expect(hasIntelGraphics(`Intel(R) Core(TM) ${prefix}-${rest} CPU @ 3.50GHz`), model).toBe(
        false,
      );
    }
    expect(NO_GRAPHICS_MODELS.length).toBeGreaterThan(0);
  });

  it("never says yes to a model with an F or KF suffix, for any generation (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("i3", "i5", "i7", "i9"),
        fc.integer({ min: 1000, max: 14999 }),
        fc.constantFrom("F", "KF"),
        (tier, number, suffix) => {
          expect(
            hasIntelGraphics(`Intel(R) Core(TM) ${tier}-${number}${suffix} CPU @ 3.00GHz`),
          ).toBe(false);
        },
      ),
    );
  });
});

interface Adapter {
  readonly maker: ChipMaker;
  readonly driver: string;
  readonly result: ChipTestResult | null;
}
const OLD = "32.0.15.6094"; // 560.94
const OLDER = "31.0.15.5123"; // 551.23
const AT_FLOOR = "32.0.16.1000"; // 610.00
const NEW = "32.0.16.1012"; // 610.12
const DRIVERS = [OLD, OLDER, "32.0.16.0999", AT_FLOOR, NEW, "", "garbage", "32.0.15", "551.23"];
const PROCESSORS: ReadonlyArray<string | null> = [
  null,
  "Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz",
  "12th Gen Intel(R) Core(TM) i5-12400F",
  "13th Gen Intel(R) Core(TM) i7-13700KF",
  "Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz",
  "AMD Ryzen 7 5800X 8-Core Processor",
];

describe("the two hints, over every combination of what the app reads", () => {
  // What each hint is for, written out here: the NVIDIA line for an NVIDIA chip whose test failed in the encoder and whose driver is
  // below 610; the Intel line for an Intel processor with graphics when every adapter the app sees is of another maker.
  const nvidiaFacts = (adapters: readonly Adapter[]) =>
    adapters
      .filter(
        (a) => a.maker === "nvidia" && (a.result === "encode_failed" || a.result === "cached_fail"),
      )
      .map((a) => nvidiaDriverUnits(a.driver))
      .filter((units): units is number => units !== null && units < NVIDIA_MIN_DRIVER * 100);
  const intelWanted = (adapters: readonly Adapter[], processor: string | null) =>
    hasIntelGraphics(processor) &&
    adapters.length > 0 &&
    adapters.every((a) => a.maker !== "intel");

  it("shows the NVIDIA line exactly for an NVIDIA chip that failed its test in the encoder with a driver below 610, and no other line for it", () => {
    let shown = 0;
    for (const driver of DRIVERS)
      for (const result of RESULTS) {
        const label = `${driver} / ${result}`;
        const advice = chipAdvice({
          adapters: [{ maker: "nvidia", driver, result }],
          processor: null,
        });
        const units = nvidiaDriverUnits(driver);
        const wanted =
          (result === "encode_failed" || result === "cached_fail") &&
          units !== null &&
          units < 61_000;
        if (wanted) {
          shown++;
          expect(advice, label).toEqual({
            kind: "nvidia_driver",
            text: nvidiaLine(nvidiaDriverNumber(driver)!),
          });
        } else expect(advice, label).toBeNull();
      }
    expect(shown).toBeGreaterThan(0);
  });

  it("names `32.0.15.6094` as 560.94, and says nothing for a driver of 610 or newer that fails, or for one that cannot be read", () => {
    const failed = (driver: string) =>
      chipAdvice({
        adapters: [{ maker: "nvidia", driver, result: "encode_failed" }],
        processor: null,
      });
    expect(failed(OLD)?.text).toBe(nvidiaLine("560.94"));
    expect(failed(OLDER)?.text).toBe(nvidiaLine("551.23"));
    expect(failed(AT_FLOOR)).toBeNull();
    expect(failed(NEW)).toBeNull();
    expect(failed("garbage")).toBeNull();
    expect(failed("32.0.16.0999")?.text).toBe(nvidiaLine("609.99"));
  });

  it("shows the Intel line exactly for an Intel processor with graphics when the only adapters seen are another maker's", () => {
    const makerSets: ReadonlyArray<readonly ChipMaker[]> = [
      [],
      ["amd"],
      ["nvidia"],
      ["intel"],
      ["amd", "nvidia"],
      ["nvidia", "intel"],
      ["amd", "intel"],
      ["amd", "nvidia", "intel"],
    ];
    let shown = 0;
    for (const makers of makerSets)
      for (const processor of PROCESSORS) {
        const adapters = makers.map((maker) => ({ maker, driver: OLD, result: "passed" as const }));
        const advice = chipAdvice({ adapters, processor });
        const label = `${makers.join("+") || "none"} / ${processor}`;
        if (!intelWanted(adapters, processor)) {
          expect(advice, label).toBeNull();
          continue;
        }
        shown++;
        const seen =
          makers.includes("amd") && makers.includes("nvidia")
            ? "AMD and NVIDIA"
            : makers[0] === "amd"
              ? "AMD"
              : "NVIDIA";
        expect(advice, label).toEqual({ kind: "intel_graphics", text: intelLine(seen) });
      }
    expect(shown).toBe(3 * 1); // one Intel processor with graphics, with an AMD, an NVIDIA or both seen
  });

  it("shows the named rows and no others: i7-6700, i5-12400F, i7-13700KF, a Xeon and a Ryzen, next to an NVIDIA chip that passed", () => {
    const seen = (processor: string) =>
      chipAdvice({ adapters: [{ maker: "nvidia", driver: NEW, result: "passed" }], processor })
        ?.kind ?? null;
    expect(seen("Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz")).toBe("intel_graphics");
    expect(seen("12th Gen Intel(R) Core(TM) i5-12400F")).toBeNull();
    expect(seen("13th Gen Intel(R) Core(TM) i7-13700KF")).toBeNull();
    expect(seen("Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz")).toBeNull();
    expect(seen("AMD Ryzen 7 5800X 8-Core Processor")).toBeNull();
  });

  it("gives at most one line: the NVIDIA line first when both would apply", () => {
    const both: ChipAdviceFacts = {
      adapters: [{ maker: "nvidia", driver: OLD, result: "encode_failed" }],
      processor: "Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz",
    };
    expect(chipAdvice(both)).toEqual({ kind: "nvidia_driver", text: nvidiaLine("560.94") });
    // once the driver is new enough, the other hint is the one left
    expect(
      chipAdvice({ ...both, adapters: [{ maker: "nvidia", driver: NEW, result: "encode_failed" }] })
        ?.kind,
    ).toBe("intel_graphics");
  });

  it("names the person's own driver, the 610 the encoder needs, and the makers seen: no other fact (every sentence is one of two templates)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            maker: fc.constantFrom(...CHIP_MAKERS),
            driver: fc.constantFrom(...DRIVERS),
            result: fc.constantFrom(...RESULTS),
          }),
          { maxLength: 4 },
        ),
        fc.constantFrom(...PROCESSORS),
        (adapters, processor) => {
          const advice = chipAdvice({ adapters, processor });
          const old = nvidiaFacts(adapters);
          const makers = [...new Set(adapters.map((a) => a.maker))];
          const seenNames = ["amd", "nvidia"]
            .filter((m) => makers.includes(m as ChipMaker))
            .map((m) => (m === "amd" ? "AMD" : "NVIDIA"));
          if (old.length > 0) {
            // the lowest of the drivers that qualify
            const lowest = Math.min(...old);
            expect(advice?.kind).toBe("nvidia_driver");
            expect(advice?.text).toBe(
              nvidiaLine(`${Math.floor(lowest / 100)}.${String(lowest % 100).padStart(2, "0")}`),
            );
          } else if (intelWanted(adapters, processor)) {
            expect(advice).toEqual({
              kind: "intel_graphics",
              text: intelLine(seenNames.join(" and ")),
            });
          } else expect(advice).toBeNull();
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never promises a driver that exists, a card generation, a download or a site: the fixed words say a newer driver exists only if one does", () => {
    const forbidden =
      /kepler|maxwell|pascal|volta|turing|ampere|\bada\b|geforce|\bgtx\b|\brtx\b|quadro|radeon|http|www\.|\.com|\.exe|download|website|latest|will fix|guarantee|released/i;
    for (const sentence of [nvidiaLine("560.94"), intelLine("AMD"), intelLine("AMD and NVIDIA")]) {
      expect(sentence).not.toMatch(forbidden);
      // every number in a line is the person's own driver or the 610 the encoder needs
      for (const number of sentence.match(/\d+(?:\.\d+)?/g) ?? [])
        expect(["560.94", "610"]).toContain(number);
    }
    expect(nvidiaLine("560.94")).toContain(
      "If a newer driver exists for your card, updating it can make exports faster. If not,",
    );
  });

  it("answers, and never throws, for facts that are not what the type says", () => {
    for (const facts of [
      null,
      undefined,
      {},
      { adapters: null },
      { adapters: [null, 3, {}], processor: 5 },
      { adapters: [{ maker: "nvidia" }] },
      "x",
    ])
      expect(() => chipAdvice(facts as unknown as ChipAdviceFacts)).not.toThrow();
    expect(
      chipAdvice({ adapters: [{ maker: "nvidia" }] } as unknown as ChipAdviceFacts),
    ).toBeNull();
  });
});
