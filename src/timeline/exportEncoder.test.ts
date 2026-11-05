import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CHIP_MAKERS,
  CHIP_PREFERENCE,
  ENCODER_IDS,
  FAST_DEFAULT_SECONDS,
  FAST_MIN_SAVING,
  chipVideoArgs,
  chooseEncoder,
  encoderIdFor,
  sizeClassOf,
  type ChoiceInput,
  type ChipMaker,
  type ModeRequest,
  type Tier,
} from "./exportEncoder";

const TIERS: Tier[] = ["high", "medium", "low"];

describe("what each maker's chip is asked to do (the one table the export and the test both read)", () => {
  it("names the encoder of its own maker, and a pixel layout it takes", () => {
    expect(chipVideoArgs("amd", "medium")).toMatchObject({ codec: "h264_amf", pixFmt: "yuv420p" });
    expect(chipVideoArgs("nvidia", "medium")).toMatchObject({
      codec: "h264_nvenc",
      pixFmt: "yuv420p",
    });
    // Intel's encoder does not take yuv420p from ffmpeg's filter graph: it wants nv12, which is still 4:2:0.
    expect(chipVideoArgs("intel", "medium")).toMatchObject({ codec: "h264_qsv", pixFmt: "nv12" });
  });

  it("is the lab's measured ladder for AMD: qp 18, 24, 30 stand for High, Medium, Low", () => {
    // VMAF within one point of x264 CRF 18, 23, 28 on the owner's own clip (exporter document 19.7).
    for (const [tier, qp] of [
      ["high", "18"],
      ["medium", "24"],
      ["low", "30"],
    ] as const) {
      const { rate } = chipVideoArgs("amd", tier);
      for (const flag of ["-qp_i", "-qp_p", "-qp_b"]) expect(rate[rate.indexOf(flag) + 1]).toBe(qp);
      expect(rate).toEqual(
        expect.arrayContaining(["-usage", "transcoding", "-quality", "quality", "-rc", "cqp"]),
      );
    }
  });

  it("asks for constant quality, not a bitrate, from every maker", () => {
    expect(chipVideoArgs("nvidia", "medium").rate).toEqual(
      expect.arrayContaining(["-rc", "vbr", "-cq", "-b:v", "0"]),
    );
    expect(chipVideoArgs("intel", "medium").rate).toContain("-global_quality");
    for (const maker of CHIP_MAKERS)
      for (const tier of TIERS) {
        const { rate } = chipVideoArgs(maker, tier);
        expect(rate.length, `${maker} ${tier}`).toBeGreaterThan(0);
        expect(rate.every((part) => typeof part === "string" && part.length > 0)).toBe(true);
        // A fixed bitrate would make the file's quality depend on the picture: only NVIDIA's constant-quality mode
        // names a bitrate, and it is zero (no cap).
        const at = rate.indexOf("-b:v");
        if (at >= 0) expect(rate[at + 1], maker).toBe("0");
      }
  });

  it("never gets better as the tier goes down: High is the lowest quantiser number, Low the highest", () => {
    const number = (maker: ChipMaker, tier: Tier): number => {
      const { rate } = chipVideoArgs(maker, tier);
      const flag = ["-qp_i", "-cq", "-global_quality"].find((candidate) =>
        rate.includes(candidate),
      )!;
      return Number(rate[rate.indexOf(flag) + 1]);
    };
    for (const maker of CHIP_MAKERS) {
      expect(number(maker, "high"), maker).toBeLessThan(number(maker, "medium"));
      expect(number(maker, "medium"), maker).toBeLessThan(number(maker, "low"));
    }
  });

  it("answers the same twice and never hands out a list that can be changed for the next caller", () => {
    for (const maker of CHIP_MAKERS) {
      const first = chipVideoArgs(maker, "medium");
      first.rate.push("-evil");
      expect(chipVideoArgs(maker, "medium").rate).not.toContain("-evil");
    }
  });

  it("is a closed list of makers, with a preference that names each exactly once", () => {
    expect([...CHIP_PREFERENCE].sort()).toEqual([...CHIP_MAKERS].sort());
  });
});

describe("the encoder ids history is kept under", () => {
  it("has one id for each way an export can be encoded, and none twice", () => {
    expect(new Set(ENCODER_IDS).size).toBe(ENCODER_IDS.length);
    expect(ENCODER_IDS).toEqual(
      expect.arrayContaining([
        "x264-crf",
        "x264-crf-threads2",
        "x264-fast",
        "x264-fast-threads2",
        "chip-amd",
        "chip-nvidia",
        "chip-intel",
      ]),
    );
  });

  it("is today's id for today's exports, and a different one as soon as anything about the encoder differs", () => {
    expect(encoderIdFor({ kind: "x264", twoThreads: false })).toBe("x264-crf");
    expect(encoderIdFor({ kind: "x264", twoThreads: true })).toBe("x264-crf-threads2");
    expect(encoderIdFor({ kind: "x264_fast", twoThreads: false })).toBe("x264-fast");
    expect(encoderIdFor({ kind: "x264_fast", twoThreads: true })).toBe("x264-fast-threads2");
    for (const maker of CHIP_MAKERS) {
      expect(encoderIdFor({ kind: maker, twoThreads: false })).toBe(`chip-${maker}`);
      expect(encoderIdFor({ kind: maker, twoThreads: true })).toBe(`chip-${maker}`);
    }
    const ids = new Set<string>();
    for (const kind of ["x264", "x264_fast", ...CHIP_MAKERS] as const)
      for (const twoThreads of [false, true]) ids.add(encoderIdFor({ kind, twoThreads }));
    for (const id of ids) expect(ENCODER_IDS as readonly string[]).toContain(id);
  });
});

describe("which size class a picture is tested and used in", () => {
  it("puts a phone-sized picture, either way up, in the 1080p class and a 4K one in the other", () => {
    expect(sizeClassOf(1080, 1920, 30)).toBe("hd");
    expect(sizeClassOf(1920, 1080, 30)).toBe("hd");
    expect(sizeClassOf(1280, 720, 24)).toBe("hd");
    expect(sizeClassOf(2560, 1440, 30)).toBe("uhd");
    expect(sizeClassOf(2160, 3840, 30)).toBe("uhd");
    expect(sizeClassOf(3840, 2160, 30)).toBe("uhd");
    expect(sizeClassOf(2160, 1080, 30)).toBe("uhd"); // an ultra-wide: its long side is past the 1080p class's
  });

  it("is no class at all above what the chips were tested at, and for anything that is not a size", () => {
    expect(sizeClassOf(4096, 2304, 30)).toBeNull(); // more than the 4K class: no maker's limits were checked here
    expect(sizeClassOf(7680, 4320, 30)).toBeNull();
    for (const [w, h] of [
      [0, 100],
      [100, 0],
      [-1920, 1080],
      [Number.NaN, 1080],
      [1920, Number.POSITIVE_INFINITY],
    ])
      expect(sizeClassOf(w, h, 30), `${w}x${h}`).toBeNull();
  });

  // Found by review: a class by pixel count alone let a picture with a long side nobody tested (4000 by 500: two million
  // pixels, a "1080p-class" picture) and a frame rate nobody tested (4K at 60 needs more than H.264 level 5.2 gives) use a
  // chip that had proved itself at 1080 by 1920 and 30 frames a second.
  it("is no class for a long side, or a frame rate, past what each class was tested at", () => {
    expect(sizeClassOf(4000, 500, 30)).toBeNull();
    expect(sizeClassOf(500, 4000, 30)).toBeNull();
    expect(sizeClassOf(3840, 1080, 30)).toBe("uhd"); // within the 4K class's long side
    expect(sizeClassOf(1920, 1080, 60)).toBe("hd");
    expect(sizeClassOf(1920, 1080, 61)).toBeNull(); // 1080p120 and the like: not the 1080p class, and past the 4K class's rate
    expect(sizeClassOf(1920, 1080, 120)).toBeNull();
    expect(sizeClassOf(3840, 2160, 60)).toBeNull();
    expect(sizeClassOf(2560, 1440, 31)).toBeNull();
    for (const fps of [0, -30, Number.NaN, Number.POSITIVE_INFINITY])
      expect(sizeClassOf(1920, 1080, fps), `${fps} fps`).toBeNull();
  });

  it("only ever gets larger as the picture, or its frame rate, does", () => {
    const rank = (c: ReturnType<typeof sizeClassOf>) => (c === "hd" ? 1 : c === "uhd" ? 2 : 3);
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8000 }),
        fc.integer({ min: 2, max: 8000 }),
        fc.integer({ min: 1, max: 120 }),
        fc.integer({ min: 0, max: 2000 }),
        (w, h, fps, extra) => {
          expect(rank(sizeClassOf(w, h, fps))).toBeLessThanOrEqual(
            rank(sizeClassOf(w + extra, h, fps)),
          );
          expect(rank(sizeClassOf(w, h, fps))).toBeLessThanOrEqual(
            rank(sizeClassOf(w, h + extra, fps)),
          );
          expect(rank(sizeClassOf(w, h, fps))).toBeLessThanOrEqual(
            rank(sizeClassOf(w, h, fps + (extra % 90))),
          );
        },
      ),
    );
  });
});

const base: ChoiceInput = {
  request: "auto",
  chip: "amd",
  chipDefaultOn: true,
  fasterX264On: true,
  fullSeconds: 300,
  fullMeasured: true,
  fastSeconds: 100,
  durationSeconds: 60,
  promiseMultiple: 2,
};
const choose = (over: Partial<ChoiceInput> = {}) => chooseEncoder({ ...base, ...over });

describe("the one rule that decides the encoder", () => {
  it("shows Fast and selects it for an export that would take over a minute and that the chip would speed up", () => {
    expect(choose()).toMatchObject({
      encoder: "amd",
      showRow: true,
      defaultMode: "fast",
      reason: "over_minute",
    });
  });

  it("shows Fast but leaves Full selected for a short export, so short exports stay exactly as they are", () => {
    const short = choose({ fullSeconds: 40, fastSeconds: 15 });
    expect(short).toMatchObject({ encoder: "x264", showRow: true, defaultMode: "quality" });
    // The line is over a minute, not at it.
    expect(choose({ fullSeconds: FAST_DEFAULT_SECONDS, fastSeconds: 20 }).defaultMode).toBe(
      "quality",
    );
    expect(choose({ fullSeconds: FAST_DEFAULT_SECONDS + 1, fastSeconds: 20 }).defaultMode).toBe(
      "fast",
    );
  });

  it("does not show Fast where it would save less than a quarter of the time", () => {
    // 8K HEVC: decoding dominates, the chip gains almost nothing (the lab: 19.6 s against 21.2 s).
    const decodeBound = choose({ fullSeconds: 600, fastSeconds: 560 });
    expect(decodeBound).toMatchObject({ showRow: false, encoder: "x264" });
    const edge = choose({ fullSeconds: 400, fastSeconds: 400 * (1 - FAST_MIN_SAVING) });
    expect(edge.showRow).toBe(true); // exactly a quarter saved is enough
    expect(choose({ fullSeconds: 400, fastSeconds: 400 * (1 - FAST_MIN_SAVING) + 1 }).showRow).toBe(
      false,
    );
  });

  it("never shows or uses a chip that is not there, and falls back to the processor without a word", () => {
    for (const request of ["auto", "fast", "full"] as ModeRequest[]) {
      const none = choose({ chip: null, request, fullSeconds: 30, fastSeconds: null });
      expect(none).toMatchObject({ showRow: false, defaultMode: "quality" });
      expect(["x264", "x264_fast"]).toContain(none.encoder);
    }
  });

  it("gives the person what they chose, and never changes an explicit Full", () => {
    expect(choose({ request: "fast" })).toMatchObject({ encoder: "amd", reason: "person" });
    expect(choose({ request: "full" })).toMatchObject({ encoder: "x264", reason: "person" });
    // Full stays Full however slow, and with whatever flags.
    const slow = choose({
      request: "full",
      chip: null,
      fullSeconds: 100_000,
      fullMeasured: true,
      durationSeconds: 10,
    });
    expect(slow).toMatchObject({ encoder: "x264", reason: "person" });
    expect(slow.preset).toBeUndefined();
    // Fast asked for when the row is not on offer is the processor, not an error.
    expect(choose({ request: "fast", fullSeconds: 600, fastSeconds: 590 })).toMatchObject({
      encoder: "x264",
    });
  });

  it("does not choose Fast for the person when the switch for that is off, and still offers it", () => {
    const off = choose({ chipDefaultOn: false });
    expect(off).toMatchObject({ encoder: "x264", showRow: true, defaultMode: "quality" });
    expect(choose({ chipDefaultOn: false, request: "fast" }).encoder).toBe("amd");
  });

  it("uses the faster processor setting only for a slow export on a PC with no usable chip", () => {
    const slow = {
      chip: null,
      fastSeconds: null,
      durationSeconds: 100,
      promiseMultiple: 2,
      fullSeconds: 500,
    };
    expect(choose({ ...slow })).toMatchObject({
      encoder: "x264_fast",
      preset: "veryfast",
      reason: "promise_line",
    });
    // On the promise line it stays as it is.
    expect(choose({ ...slow, fullSeconds: 200 }).encoder).toBe("x264");
    expect(choose({ ...slow, fullSeconds: 201 }).encoder).toBe("x264_fast");
    // The heavier classes have more room before the line.
    expect(choose({ ...slow, promiseMultiple: 4, fullSeconds: 399 }).encoder).toBe("x264");
    // Switched off, or a usable chip that is simply not worth it, or an explicit Full.
    expect(choose({ ...slow, fasterX264On: false }).encoder).toBe("x264");
    expect(choose({ chip: "amd", fullSeconds: 600, fastSeconds: 590 }).encoder).toBe("x264");
    expect(choose({ ...slow, request: "full" }).encoder).toBe("x264");
  });

  it("does not take the quality down on a guess unless the guess is plainly over the line", () => {
    const slow = {
      chip: null,
      fastSeconds: null,
      durationSeconds: 100,
      promiseMultiple: 2,
      fullMeasured: false,
    };
    expect(choose({ ...slow, fullSeconds: 300 }).encoder).toBe("x264"); // over the line, but only a guess
    expect(choose({ ...slow, fullSeconds: 401 }).encoder).toBe("x264_fast"); // twice the line
    expect(choose({ ...slow, fullSeconds: 300, fullMeasured: true }).encoder).toBe("x264_fast");
  });

  it("never takes the quality down for an export that takes a minute or less, however far over the line it is", () => {
    // A two-second video guessed at twelve seconds is six times its length, and nobody gains from twelve seconds.
    const tiny = {
      chip: null,
      fastSeconds: null,
      durationSeconds: 2,
      promiseMultiple: 2,
      fullMeasured: true,
    };
    expect(choose({ ...tiny, fullSeconds: 12 }).encoder).toBe("x264");
    expect(choose({ ...tiny, fullSeconds: FAST_DEFAULT_SECONDS }).encoder).toBe("x264");
    expect(choose({ ...tiny, fullSeconds: FAST_DEFAULT_SECONDS + 1 }).encoder).toBe("x264_fast");
    // A short video that really takes long on this PC still gets it.
    expect(
      choose({ ...tiny, durationSeconds: 10, fullSeconds: 120, fullMeasured: true }).encoder,
    ).toBe("x264_fast");
  });

  it("never reads an estimate that is not a finite number as a saving", () => {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -5]) {
      expect(choose({ fullSeconds: bad, fastSeconds: bad })).toMatchObject({
        showRow: false,
        encoder: "x264",
      });
      expect(choose({ fullSeconds: 300, fastSeconds: bad }).showRow).toBe(false);
      expect(choose({ fullSeconds: bad, fastSeconds: 100 }).showRow).toBe(false);
      expect(choose({ request: "fast", fullSeconds: bad, fastSeconds: bad }).encoder).toBe("x264");
    }
  });

  it("decides nothing without an estimate", () => {
    const blind = choose({ fullSeconds: null, fastSeconds: null });
    expect(blind).toMatchObject({ showRow: false, encoder: "x264", defaultMode: "quality" });
    expect(choose({ chip: null, fullSeconds: null, fastSeconds: null }).encoder).toBe("x264");
  });

  const input = fc.record({
    request: fc.constantFrom<ModeRequest>("auto", "full", "fast"),
    chip: fc.constantFrom<ChipMaker | null>(null, "amd", "nvidia", "intel"),
    chipDefaultOn: fc.boolean(),
    fasterX264On: fc.boolean(),
    fullSeconds: fc.option(fc.double({ min: -10, max: Number.POSITIVE_INFINITY, noNaN: true }), {
      nil: null,
    }),
    fullMeasured: fc.boolean(),
    fastSeconds: fc.option(fc.double({ min: -10, max: Number.POSITIVE_INFINITY, noNaN: true }), {
      nil: null,
    }),
    durationSeconds: fc.double({ min: 0, max: 20_000, noNaN: true }),
    promiseMultiple: fc.constantFrom(2, 4),
  });

  it("obeys the rules of the document for every combination of facts", () => {
    fc.assert(
      fc.property(input, (facts) => {
        const c = chooseEncoder(facts);
        const full = facts.fullSeconds;
        const fast = facts.fastSeconds;
        const finite = (value: number | null): value is number =>
          value !== null && Number.isFinite(value);
        const saves =
          facts.chip !== null &&
          finite(full) &&
          finite(fast) &&
          full > 0 &&
          fast >= 0 &&
          fast <= full * (1 - FAST_MIN_SAVING);
        // The row is on offer exactly when a chip is proven and would save a quarter.
        expect(c.showRow).toBe(saves);
        // A chip runs only where the row is on offer, and only when it was chosen, by the person or by the rule.
        const chip = (CHIP_MAKERS as readonly string[]).includes(c.encoder);
        if (chip) {
          expect(c.showRow).toBe(true);
          expect(c.encoder).toBe(facts.chip);
        }
        // Full is never changed.
        if (facts.request === "full") {
          expect(c.encoder).toBe("x264");
          expect(c.preset).toBeUndefined();
        }
        // What the row starts on, and why.
        const selected =
          saves && facts.chipDefaultOn && full !== null && full > FAST_DEFAULT_SECONDS;
        expect(c.defaultMode).toBe(selected ? "fast" : "quality");
        if (facts.request === "auto") expect(chip).toBe(selected);
        // The faster setting is the processor's, with its own preset, and only when nothing else changed the plan.
        if (c.encoder === "x264_fast") {
          expect(c.preset).toBe("veryfast");
          expect(facts.request).toBe("auto");
          expect(facts.chip).toBeNull();
          expect(facts.fasterX264On).toBe(true);
          // Only where the time saved matters: an export that takes a minute or less keeps its quality.
          expect(full).toBeGreaterThan(FAST_DEFAULT_SECONDS);
        } else expect(c.preset).toBeUndefined();
        // The reason fits what happened.
        if (c.reason === "over_minute") expect(chip).toBe(true);
        if (c.reason === "promise_line") expect(c.encoder).toBe("x264_fast");
        if (c.reason === "person") expect(facts.request).not.toBe("auto");
      }),
      { numRuns: 1500 },
    );
  });

  it("does not change what it is given and answers the same twice", () => {
    const facts = { ...base };
    const frozen = structuredClone(facts);
    const once = chooseEncoder(facts);
    expect(facts).toEqual(frozen);
    expect(chooseEncoder(facts)).toEqual(once);
  });
});
