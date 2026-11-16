import fc from "fast-check";
import { describe, expect, it } from "vitest";

import * as estimateWords from "./estimateWords";
import {
  CHECKING_LINE,
  CHECK_AGAIN_LABEL,
  MEMORY_PREDICTION_FACT,
  MUCH_LONGER_LINE,
  RANGE_RATIO,
  UNREAD_SOURCES_LINE,
  describeCheckDay,
  describeEstimateLine,
  describeHeavyProject,
  describeMuchLonger,
  describeSpeedCheck,
  type EstimateWordsInput,
} from "./estimateWords";
import { describeExportTime } from "./exportOptions";
import { describeExpected } from "./exportWords";
import { ESTIMATE_BASES, PC_CLASSES } from "./exportTypes3c";

const estimate = (over: Partial<EstimateWordsInput> = {}): EstimateWordsInput => ({
  seconds: 3000,
  low: 2700,
  high: 3300,
  basis: "pc_check",
  bytes: null,
  ...over,
});

describe("the estimate line: the owner's copy, with the record's own numbers", () => {
  it("says a time from a check of this PC, as a single number when the range is narrow", () => {
    expect(describeEstimateLine(estimate())).toBe(
      "Expected: about 50 min, from a quick check of this PC's speed.",
    );
  });

  it("says a range when the estimate is unsure", () => {
    expect(describeEstimateLine(estimate({ seconds: 5000, low: 3000, high: 7200 }))).toBe(
      "Expected: 50 min to 2 h, from a quick check of this PC's speed.",
    );
  });

  it("says a time from earlier exports, with the file this PC measured: today's words, exactly", () => {
    const line = describeEstimateLine(
      estimate({ basis: "history", seconds: 3120, low: 3000, high: 3200, bytes: 480e6 }),
    );
    expect(line).toBe(
      "Expected: about 52 min, a file of about 480 MB, from earlier exports on this PC.",
    );
    // ... which is what 0.27.0's own function says for the same export.
    expect(line).toBe(describeExpected({ seconds: 3120, guessed: false, finalBytes: 480e6 }));
    expect(
      describeEstimateLine(estimate({ basis: "history", seconds: 3120, low: 3000, high: 3200 })),
    ).toBe(describeExpected({ seconds: 3120, guessed: false, finalBytes: null }));
  });

  it("says a rough guess is one, before any check and when the check could not finish", () => {
    const guess = estimate({ basis: "guess", seconds: 480, low: 120, high: 900 });
    expect(describeEstimateLine({ ...guess, low: 400, high: 500 })).toBe(
      "Expected: about 8 min. A rough guess: this PC's speed has not been checked yet.",
    );
    expect(
      describeEstimateLine({ ...guess, seconds: 3000, low: 2800, high: 3200 }, "unfinished"),
    ).toBe(
      "Expected: about 50 min. A rough guess: the speed check could not finish, so this PC is treated as slower than most.",
    );
    for (const pcClass of PC_CLASSES.filter((c) => c !== "unfinished"))
      expect(describeEstimateLine({ ...guess, low: 400, high: 500 }, pcClass)).toContain(
        "has not been checked yet",
      );
  });

  it("shows a single number up to a ratio of 1.8 between the ends, and a range beyond it", () => {
    expect(RANGE_RATIO).toBe(1.8);
    const at = (high: number) => describeEstimateLine(estimate({ seconds: 1500, low: 1000, high }));
    expect(at(1800)).toBe("Expected: about 25 min, from a quick check of this PC's speed.");
    expect(at(1801)).toBe("Expected: 17 min to 30 min, from a quick check of this PC's speed.");
  });

  it("says a range of times that read alike as one, and a first end under a minute as it is", () => {
    expect(describeEstimateLine(estimate({ seconds: 20, low: 10, high: 30 }))).toBe(
      "Expected: under a minute, from a quick check of this PC's speed.",
    );
    expect(describeEstimateLine(estimate({ seconds: 100, low: 30, high: 200 }))).toBe(
      "Expected: under a minute to 3 min, from a quick check of this PC's speed.",
    );
  });

  it("says nothing where there is no estimate, and never prints what is not a time", () => {
    for (const none of [null, undefined]) expect(describeEstimateLine(none)).toBe("");
    for (const seconds of [Number.NaN, Number.POSITIVE_INFINITY, -1])
      for (const basis of ESTIMATE_BASES)
        expect(describeEstimateLine(estimate({ seconds, basis }))).toBe("");
    // An unusable range falls back to the single number rather than to nothing.
    for (const [low, high] of [
      [Number.NaN, 100],
      [0, 100],
      [100, 50],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    ])
      expect(describeEstimateLine(estimate({ seconds: 3000, low, high }))).toBe(
        "Expected: about 50 min, from a quick check of this PC's speed.",
      );
    expect(() => describeEstimateLine({} as never)).not.toThrow();
  });
});

describe("the estimate line: over every estimate", () => {
  const time = fc.oneof(
    fc.integer({ min: 1, max: 400_000 }),
    fc.constantFrom(1, 44, 45, 59, 60, 3599, 3600, Number.NaN, Number.POSITIVE_INFINITY, -2, 0),
  );
  const input = fc.record({
    seconds: time,
    low: time,
    high: time,
    basis: fc.constantFrom(...ESTIMATE_BASES),
    bytes: fc.oneof(fc.integer({ min: 0, max: 3e10 }), fc.constantFrom(null, Number.NaN, -1)),
    pcClass: fc.constantFrom(...PC_CLASSES),
  });

  it("never hides a rough guess, and never calls anything else one", () => {
    fc.assert(
      fc.property(input, ({ pcClass, ...e }) => {
        const line = describeEstimateLine(e, pcClass);
        if (line === "") return;
        expect(line.includes("A rough guess:")).toBe(e.basis === "guess");
      }),
      { numRuns: 2000 },
    );
  });

  it("says the record's own time: the one number the single form shows is the central value", () => {
    fc.assert(
      fc.property(input, ({ pcClass, ...e }) => {
        const line = describeEstimateLine(e, pcClass);
        const single = describeExportTime(e.seconds);
        const wide =
          Number.isFinite(e.low) &&
          Number.isFinite(e.high) &&
          e.low > 0 &&
          e.high > e.low &&
          e.high / e.low > RANGE_RATIO;
        if (!single) expect(line).toBe("");
        else if (!wide) expect(line).toContain(`Expected: ${single}`);
        else expect(line.startsWith("Expected: ")).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it("shows a range exactly when the ends are more than 1.8 apart and read differently, and never anything that is not a number", () => {
    fc.assert(
      fc.property(input, ({ pcClass, ...e }) => {
        const line = describeEstimateLine(e, pcClass);
        expect(line).not.toMatch(/NaN|Infinity|undefined|null|\[object/);
        if (line === "") return;
        const wide =
          Number.isFinite(e.low) &&
          Number.isFinite(e.high) &&
          e.low > 0 &&
          e.high > e.low &&
          e.high / e.low > RANGE_RATIO;
        const ends = [describeExportTime(e.low), describeExportTime(e.high)];
        const reads =
          ends[0] !== "" &&
          ends[1] !== "" &&
          ends[0].replace(/^about /, "") !== ends[1].replace(/^about /, "");
        expect(/Expected: [^,.]* to /.test(line)).toBe(wide && reads);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("the amber lines and the check's lines", () => {
  it("warns that an estimate could be much longer, in the words that fit why", () => {
    expect(describeMuchLonger({ muchLonger: true })).toBe(
      "This project is heavier than what the check measured, so it could take much longer.",
    );
    expect(describeMuchLonger({ muchLonger: true }, { sourcesUnread: true })).toBe(
      "ArtDaddy has not read some of your clips yet, so this could take much longer.",
    );
    expect(describeMuchLonger({ muchLonger: false }, { sourcesUnread: true })).toBe(
      UNREAD_SOURCES_LINE,
    );
    expect(describeMuchLonger({ muchLonger: false })).toBeNull();
    expect(describeMuchLonger(null)).toBeNull();
    expect(describeMuchLonger(undefined, undefined)).toBeNull();
    expect(MUCH_LONGER_LINE).toContain("much longer");
  });

  it("says a project is heavy, and offers Quick only where Quick is on offer", () => {
    expect(describeHeavyProject({ seconds: 3600, quickSeconds: 1500, quickOffered: true })).toBe(
      "This project is heavy for this PC: about 1 h. Quick export would take about 25 min; lowering the picture size or frame rate also helps.",
    );
    expect(describeHeavyProject({ seconds: 3600, quickSeconds: 1500, quickOffered: false })).toBe(
      "This project is heavy for this PC: about 1 h. To go faster, lower the picture size or frame rate, or export a shorter section.",
    );
    expect(describeHeavyProject({ seconds: 3600, quickSeconds: null, quickOffered: true })).toBe(
      "This project is heavy for this PC: about 1 h. To go faster, lower the picture size or frame rate, or export a shorter section.",
    );
    expect(
      describeHeavyProject({ seconds: null, quickSeconds: 1500, quickOffered: true }),
    ).toBeNull();
    expect(
      describeHeavyProject({ seconds: Number.NaN, quickSeconds: 1, quickOffered: false }),
    ).toBeNull();
    expect(describeHeavyProject(undefined as never)).toBeNull();
  });

  it("says while the check runs, and what it found afterwards, with a link to make it again", () => {
    expect(CHECKING_LINE).toBe("Checking this PC's speed… (about 10 seconds)");
    expect(CHECK_AGAIN_LABEL).toBe("Check again");
    expect(MEMORY_PREDICTION_FACT).toBe("Worked out from the size and number of your clips");
    expect(describeSpeedCheck("fast", "today")).toBe("Speed check: fast · today · Check again");
    expect(describeSpeedCheck("ok", "yesterday")).toBe("Speed check: OK · yesterday · Check again");
    expect(describeSpeedCheck("weak", "3 days ago")).toBe(
      "Speed check: slow · 3 days ago · Check again",
    );
    expect(describeSpeedCheck("ok")).toBe("Speed check: OK · Check again");
    expect(describeSpeedCheck("unfinished", "today")).toBe(
      "Speed check: could not finish · treated as slower than most · Check again",
    );
    expect(describeSpeedCheck("unknown", "today")).toBe("");
    expect(describeSpeedCheck("weird" as never, "today")).toBe("");
  });

  it("says of a check that could not finish only what is true of a PC that was busy and of one that is merely slow", () => {
    const line = describeSpeedCheck("unfinished", "today");
    // A PC that needs longer than the check's box is slow, not busy: the line gives no cause.
    expect(line).not.toMatch(/busy/i);
    expect(line).toMatch(/could not finish/);
    // The card says the same of the same state in the same words, wherever it says it.
    const guess = describeEstimateLine(
      estimate({ basis: "guess", seconds: 3000, low: 2800, high: 3200 }),
      "unfinished",
    );
    for (const said of [line, guess]) {
      expect(said).toContain("could not finish");
      expect(said).toContain("treated as slower than most");
      expect(said).not.toMatch(/busy/i);
    }
    // The link is the last part of the line: the component cuts it off the end to put the button there.
    expect(line.endsWith(` · ${CHECK_AGAIN_LABEL}`)).toBe(true);
  });
});

describe("describeCheckDay: the day a check was made, by the calendar", () => {
  const at = (day: number, hour = 12, minute = 0, month = 10) =>
    new Date(2026, month, day, hour, minute).getTime();
  it("is today, yesterday, so many days ago, and over a month ago", () => {
    const now = at(14, 12);
    expect(describeCheckDay(at(14, 0, 1), now)).toBe("today");
    expect(describeCheckDay(at(13, 23, 59), now)).toBe("yesterday");
    expect(describeCheckDay(at(11, 8), now)).toBe("3 days ago");
    expect(describeCheckDay(at(14, 12, 0, 9), now)).toBe("over a month ago"); // 14 October is 31 days before 14 November
  });

  it("counts calendar days, not hours: two minutes across midnight is yesterday", () => {
    expect(describeCheckDay(at(13, 23, 59), at(14, 0, 1))).toBe("yesterday");
    expect(describeCheckDay(at(14, 0, 0), at(14, 23, 59))).toBe("today");
  });

  it("says over a month ago past thirty days, and today for a clock that ran backwards", () => {
    const now = at(14, 12);
    expect(describeCheckDay(at(15, 12, 0, 9), now)).toBe("30 days ago");
    expect(describeCheckDay(at(14, 12, 0, 9), now)).toBe("over a month ago");
    expect(describeCheckDay(at(20, 12), now)).toBe("today");
  });

  it("says nothing for a time that is not one", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1e300, undefined, null, "x"])
      expect(describeCheckDay(bad as never, at(14))).toBe("");
    for (const bad of [Number.NaN, 1e300]) expect(describeCheckDay(at(14), bad)).toBe("");
  });
});

// A promise of the same picture or of a speed multiple is not ours to make (the owner's rule): nothing this module can say may contain one.
const BANNED: RegExp[] = [
  /same pixels?/i,
  /\bidentical\b/i,
  /same quality/i,
  /same picture/i,
  /same look/i,
  /exactly the same/i,
  /bit[- ]?(for[- ]?bit|identical|perfect)/i,
  /byte[- ]for[- ]byte/i,
  /\blossless\b/i,
  /\bno (loss|difference)\b/i,
  /\d\s*(x|×)\s*(faster|quicker|speed)/i,
  /\d+(\.\d+)?\s*times\s+(as\s+)?(fast|faster|quick|quicker|more quickly)/i,
  /\b(twice|double|triple|half)\s+(as\s+)?(fast|the speed)/i,
  /\b(two|three|four|five|ten)\s+times\s+(as\s+)?(fast|faster|quick|quicker)/i,
];
const GARBAGE = /\bNaN\b|\bInfinity\b|\bundefined\b|\bnull\b|\[object|\bobject Object/;

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) strings(item, into);
  return into;
}

describe("nothing here promises the same pixels or a speed multiple, or prints what is not a number", () => {
  const time = fc.oneof(
    fc.integer({ min: 0, max: 400_000 }),
    fc.constantFrom(null, Number.NaN, Number.POSITIVE_INFINITY, -1, 44, 45, 3600),
  );
  const estimateArb = fc.record({
    seconds: time,
    low: time,
    high: time,
    basis: fc.constantFrom(...ESTIMATE_BASES),
    bytes: fc.oneof(fc.integer({ min: 0, max: 3e10 }), fc.constantFrom(null, Number.NaN)),
  });
  const day = fc.constantFrom("", "today", "yesterday", "3 days ago", "over a month ago");

  // Every function the module exports, with a generator of the inputs it is given: a function added to the module without a row here
  // fails the walk below, so nothing can be said that this test has not scanned.
  const scanned: Record<string, fc.Arbitrary<unknown[]>> = {
    describeEstimateLine: fc.tuple(estimateArb, fc.constantFrom(...PC_CLASSES, undefined)),
    describeMuchLonger: fc.tuple(
      fc.record({ muchLonger: fc.boolean() }),
      fc.record({ sourcesUnread: fc.boolean() }),
    ),
    describeHeavyProject: fc.tuple(
      fc.record({ seconds: time, quickSeconds: time, quickOffered: fc.boolean() }),
    ),
    describeSpeedCheck: fc.tuple(fc.constantFrom(...PC_CLASSES), day),
    describeCheckDay: fc.tuple(
      fc.integer({ min: 0, max: 4e12 }),
      fc.integer({ min: 0, max: 4e12 }),
    ),
  };

  it("holds for everything every function returns, over generated inputs", () => {
    for (const [name, inputs] of Object.entries(scanned)) {
      const fn = (estimateWords as unknown as Record<string, (...args: unknown[]) => unknown>)[
        name
      ];
      fc.assert(
        fc.property(inputs, (args) => {
          for (const text of strings(fn(...args))) {
            for (const banned of BANNED) expect(text).not.toMatch(banned);
            expect(text).not.toMatch(GARBAGE);
          }
        }),
        { numRuns: 400 },
      );
    }
  });

  it("holds for every sentence the module keeps as a constant", () => {
    const constants = Object.entries(estimateWords).filter(
      ([, value]) => typeof value === "string",
    );
    expect(constants.length).toBeGreaterThan(0);
    for (const [, value] of constants) {
      for (const banned of BANNED) expect(value as string).not.toMatch(banned);
      expect(value as string).not.toMatch(GARBAGE);
    }
  });

  it("is a walk of the whole module: every function it exports is one of those scanned", () => {
    const exported = Object.entries(estimateWords)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual(Object.keys(scanned).sort());
  });

  it("would catch a promise of the kind it forbids", () => {
    for (const promise of [
      "the same pixels as Full quality",
      "an identical picture",
      "the same quality, faster",
      "3x faster",
      "about 2 times faster than full quality",
      "twice as fast",
      "three times quicker",
    ])
      expect(BANNED.some((banned) => banned.test(promise))).toBe(true);
    // ... and lets the owner's own sentence about this PC's pace through: that is a measurement, not a promise.
    expect(
      BANNED.some((banned) => banned.test("a plain video takes about 9 times its length here")),
    ).toBe(false);
  });
});
