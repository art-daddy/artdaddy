// What a slow speech job says (S2-09): "Slow: this will take a while because {reason}. {advice}", and each
// reason only from a fact the app can read. The expected sentences here are not this module's own constants:
// the golden rows are the output of the mockup's own slowNote() (the code the owner's pictures were
// rendered from: build-window.mjs in lane L2's mockups folder, outside this repository), run over the grid
// once and frozen. The rules are then checked over EVERY combination of facts, including the ones the
// pictures never had (no backend known, a nonsense core count), because a green row says that row works.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { SpeechFacts } from "../store/speechJobs";
import {
  about,
  CANCEL_NOTE,
  lengthText,
  runningOn,
  slowNote,
  speedLine,
  speedText,
  type SlowReason,
} from "./slowNote";

function facts(over: Partial<SpeechFacts> = {}): SpeechFacts {
  return {
    backend: null,
    gpuHeld: false,
    noGpu: false,
    cores: null,
    threads: null,
    exportsBusy: false,
    ...over,
  };
}

// Frozen from the picture code: 12 distinct sentences over 48 combinations of backend, hold, cores and
// export. (Cores 1 is left out: the picture code wrote "only 1 processor cores", fixed here and tested below.)
const SENTENCES = [
  "Slow: this will take a while because speech is running on your processor (no graphics chip the app can use was found) and this PC has only 2 processor cores. Closing other programs helps a little.",
  "Slow: this will take a while because speech is running on your processor (no graphics chip the app can use was found) and an export is running at the same time. It should speed up when the export finishes.",
  "Slow: this will take a while because speech is running on your processor (no graphics chip the app can use was found) and this PC has only 3 processor cores. Closing other programs helps a little.",
  "Slow: this will take a while because speech is running on your processor (no graphics chip the app can use was found) and this PC has only 4 processor cores. Closing other programs helps a little.",
  "Slow: this will take a while because speech is running on your processor (no graphics chip the app can use was found). Closing other programs helps a little.",
  "Slow: this will take a while because the graphics chip stopped during an earlier transcription, so your processor is used for now and this PC has only 2 processor cores. Updating your graphics driver may fix this, and the app will try the chip again later.",
  "Slow: this will take a while because the graphics chip stopped during an earlier transcription, so your processor is used for now and an export is running at the same time. It should speed up when the export finishes.",
  "Slow: this will take a while because the graphics chip stopped during an earlier transcription, so your processor is used for now and this PC has only 3 processor cores. Updating your graphics driver may fix this, and the app will try the chip again later.",
  "Slow: this will take a while because the graphics chip stopped during an earlier transcription, so your processor is used for now and this PC has only 4 processor cores. Updating your graphics driver may fix this, and the app will try the chip again later.",
  "Slow: this will take a while because the graphics chip stopped during an earlier transcription, so your processor is used for now. Updating your graphics driver may fix this, and the app will try the chip again later.",
  "Slow: this will take a while on this PC.",
  "Slow: this will take a while because an export is running at the same time. It should speed up when the export finishes.",
];
// [backend, graphics chip held, cores, export running, index of the sentence]
const ROWS: ReadonlyArray<readonly ["cpu" | "gpu", boolean, number | null, boolean, number]> = [
  ["cpu", false, 2, false, 0],
  ["cpu", false, 2, true, 1],
  ["cpu", false, 3, false, 2],
  ["cpu", false, 3, true, 1],
  ["cpu", false, 4, false, 3],
  ["cpu", false, 4, true, 1],
  ["cpu", false, 5, false, 4],
  ["cpu", false, 5, true, 1],
  ["cpu", false, 8, false, 4],
  ["cpu", false, 8, true, 1],
  ["cpu", false, null, false, 4],
  ["cpu", false, null, true, 1],
  ["cpu", true, 2, false, 5],
  ["cpu", true, 2, true, 6],
  ["cpu", true, 3, false, 7],
  ["cpu", true, 3, true, 6],
  ["cpu", true, 4, false, 8],
  ["cpu", true, 4, true, 6],
  ["cpu", true, 5, false, 9],
  ["cpu", true, 5, true, 6],
  ["cpu", true, 8, false, 9],
  ["cpu", true, 8, true, 6],
  ["cpu", true, null, false, 9],
  ["cpu", true, null, true, 6],
  ["gpu", false, 2, false, 10],
  ["gpu", false, 2, true, 11],
  ["gpu", false, 3, false, 10],
  ["gpu", false, 3, true, 11],
  ["gpu", false, 4, false, 10],
  ["gpu", false, 4, true, 11],
  ["gpu", false, 5, false, 10],
  ["gpu", false, 5, true, 11],
  ["gpu", false, 8, false, 10],
  ["gpu", false, 8, true, 11],
  ["gpu", false, null, false, 10],
  ["gpu", false, null, true, 11],
  ["gpu", true, 2, false, 5],
  ["gpu", true, 2, true, 6],
  ["gpu", true, 3, false, 7],
  ["gpu", true, 3, true, 6],
  ["gpu", true, 4, false, 8],
  ["gpu", true, 4, true, 6],
  ["gpu", true, 5, false, 9],
  ["gpu", true, 5, true, 6],
  ["gpu", true, 8, false, 9],
  ["gpu", true, 8, true, 6],
  ["gpu", true, null, false, 9],
  ["gpu", true, null, true, 6],
];

describe("the sentence of the pictures", () => {
  it("is reproduced character for character on every row of the picture code's own output", () => {
    expect(ROWS).toHaveLength(48);
    for (const [backend, gpuHeld, cores, exportsBusy, at] of ROWS) {
      for (const noGpu of [false, true]) {
        const f = facts({ backend, gpuHeld, cores, exportsBusy, noGpu, threads: 2 });
        expect(slowNote(f).sentence, JSON.stringify(f)).toBe(SENTENCES[at]);
      }
    }
  });

  // The words of the five pictures that carry a slow note, as the owner read them.
  it.each([
    [
      "D-2 and D-4: no graphics chip, 4 cores, no export",
      facts({ backend: "cpu", cores: 4 }),
      "Slow: this will take a while because speech is running on your processor (no graphics chip the app can use was found) and this PC has only 4 processor cores. Closing other programs helps a little.",
    ],
    [
      "D-2b: no graphics chip with an export running",
      facts({ backend: "cpu", cores: 4, exportsBusy: true }),
      "Slow: this will take a while because speech is running on your processor (no graphics chip the app can use was found) and an export is running at the same time. It should speed up when the export finishes.",
    ],
    [
      "reasons sheet: the graphics chip is paused",
      facts({ backend: "cpu", gpuHeld: true, cores: 8 }),
      "Slow: this will take a while because the graphics chip stopped during an earlier transcription, so your processor is used for now. Updating your graphics driver may fix this, and the app will try the chip again later.",
    ],
    [
      "reasons sheet: an export is running",
      facts({ backend: "gpu", cores: 16, exportsBusy: true }),
      "Slow: this will take a while because an export is running at the same time. It should speed up when the export finishes.",
    ],
    [
      "reasons sheet: nothing the app can name",
      facts({ backend: "gpu", cores: 16 }),
      "Slow: this will take a while on this PC.",
    ],
  ])("%s", (_name, f, sentence) => {
    expect(slowNote(f).sentence).toBe(sentence);
  });

  // The owner's picture code puts the export's advice FIRST; ALIGNMENT 5.1 says "the first match" in
  // table order, which would give the processor advice here. The picture is what he accepted.
  it("gives the export's advice before the processor's when both could apply (the picture, not the table order)", () => {
    const n = slowNote(facts({ backend: "cpu", cores: 8, exportsBusy: true }));
    expect(n.advice).toBe("It should speed up when the export finishes.");
  });

  it("says the Cancel line the owner approved, naming the assistant and captions", () => {
    expect(CANCEL_NOTE).toBe(
      "Or cancel: the assistant and captions still transcribe just the parts they use, when they need them.",
    );
    expect(slowNote(facts()).cancelNote).toBe(CANCEL_NOTE);
  });

  it("says 'core' for one core: the picture code wrote '1 processor cores'", () => {
    const one = slowNote(facts({ backend: "cpu", cores: 1 }));
    expect(one.codes).toEqual(["no_gpu", "few_cores"]);
    expect(one.head).toContain("this PC has only 1 processor core.");
    expect(slowNote(facts({ backend: "cpu", cores: 2 })).head).toContain("only 2 processor cores.");
  });
});

// A reason is voiced only when its fact holds, and the fact a sentence leans on is the one it can read.
const PHRASE: Record<SlowReason, RegExp> = {
  gpu_paused: /the graphics chip stopped during an earlier transcription/,
  no_gpu: /no graphics chip the app can use was found/,
  few_cores: /this PC has only \d+ processor cores?\b/,
  busy: /an export is running at the same time/,
};
// A sentence that names a fact the app cannot read would be a guess (S2-09: on battery, asleep, hot).
const UNREADABLE = /batter|charger|plug|power|sleep|thermal|\bhot\b|overheat/i;

function checkRules(f: SpeechFacts): void {
  const why = JSON.stringify(f);
  const n = slowNote(f);
  const { codes } = n;

  expect(codes.length, `at most two reasons: ${why}`).toBeLessThanOrEqual(2);
  expect(new Set(codes).size, `no reason twice: ${why}`).toBe(codes.length);
  for (const code of Object.keys(PHRASE) as SlowReason[]) {
    expect(
      PHRASE[code].test(n.head),
      `${code} is in the sentence exactly when it is a code: ${why}`,
    ).toBe(codes.includes(code));
  }

  // Each code only when its own fact holds, and always when it does.
  expect(codes.includes("gpu_paused"), `gpu_paused iff the chip is held: ${why}`).toBe(f.gpuHeld);
  expect(codes.includes("busy"), `busy iff an export is queued or running: ${why}`).toBe(
    f.exportsBusy,
  );
  expect(
    codes.includes("no_gpu"),
    `no_gpu iff it runs on the processor with no hold ("is running on your processor" is only what backend can tell): ${why}`,
  ).toBe(!f.gpuHeld && f.backend === "cpu");
  const hasFirst = codes.includes("gpu_paused") || codes.includes("no_gpu");
  const fewCores =
    typeof f.cores === "number" && Number.isInteger(f.cores) && f.cores >= 1 && f.cores <= 4;
  expect(
    codes.includes("few_cores"),
    `few_cores iff a first reason exists, no export is running and the cores are 1 to 4: ${why}`,
  ).toBe(hasFirst && !f.exportsBusy && fewCores);
  if (codes.includes("few_cores")) {
    expect(codes[0], `few_cores is never the first reason: ${why}`).not.toBe("few_cores");
    expect(codes, `few_cores never comes with an export: ${why}`).not.toContain("busy");
  }

  // The sentence.
  if (codes.length) expect(n.head, why).toMatch(/^Slow: this will take a while because .+\.$/);
  else expect(n.head, why).toBe("Slow: this will take a while on this PC.");
  const advice = f.exportsBusy
    ? "It should speed up when the export finishes."
    : f.gpuHeld
      ? "Updating your graphics driver may fix this, and the app will try the chip again later."
      : codes.length
        ? "Closing other programs helps a little."
        : "";
  expect(
    n.advice,
    `the advice: an export's first, then the hold's, then the processor's: ${why}`,
  ).toBe(advice);
  expect(n.sentence, why).toBe(advice ? `${n.head} ${advice}` : n.head);
  expect(n.sentence, `no placeholder is left: ${why}`).not.toMatch(
    /[{}]|undefined|NaN|null|Infinity|\[object/,
  );
  expect(n.sentence, `nothing the app cannot read: ${why}`).not.toMatch(UNREADABLE);
  expect(n.cancelNote).toBe(CANCEL_NOTE);
}

describe("what a slow job may say, over every combination of facts", () => {
  it("walks backend (none, processor, chip) x hold x export x cores x noGpu and keeps every rule", () => {
    const backends: SpeechFacts["backend"][] = [null, "cpu", "gpu"];
    const cores: Array<number | null> = [null, 1, 2, 3, 4, 5, 8, 16, 0, -1, 2.5, NaN, Infinity];
    let walked = 0;
    for (const backend of backends)
      for (const gpuHeld of [false, true])
        for (const exportsBusy of [false, true])
          for (const noGpu of [false, true])
            for (const core of cores) {
              checkRules(facts({ backend, gpuHeld, exportsBusy, noGpu, cores: core }));
              walked += 1;
            }
    expect(walked).toBe(3 * 2 * 2 * 2 * 13);
  });

  it("holds for any facts at all (a property, with nonsense core counts)", () => {
    const arbFacts = fc.record({
      backend: fc.constantFrom<SpeechFacts["backend"]>(null, "cpu", "gpu"),
      gpuHeld: fc.boolean(),
      noGpu: fc.boolean(),
      cores: fc.oneof(fc.constant(null), fc.integer({ min: -3, max: 70 }), fc.double()),
      threads: fc.oneof(fc.constant(null), fc.integer({ min: -3, max: 70 })),
      exportsBusy: fc.boolean(),
    });
    fc.assert(fc.property(arbFacts, (f) => checkRules(f)));
  });

  it("never lets noGpu alone speak: it is a fact about the chip, the sentence is about where it runs", () => {
    for (const backend of [null, "gpu"] as const)
      expect(slowNote(facts({ backend, noGpu: true })).codes).toEqual([]);
  });
});

describe("about: how long is left, as the pictures write it", () => {
  // Frozen from the picture code's about(), for the lengths a chip says.
  it.each([
    [0, "about 1 s"],
    [0.4, "about 1 s"],
    [7.4, "about 7 s"],
    [44.5, "about 45 s"],
    [89, "about 89 s"],
    [89.6, "about 90 s"],
    [90, "about 2 min"],
    [119, "about 2 min"],
    [200, "about 3 min"],
    [360, "about 6 min"],
    [2080, "about 35 min"],
    [5399, "about 90 min"],
    [5400, "about 1 h 30 min"],
    [5430, "about 1 h 31 min"],
    [7200, "about 2 h 0 min"],
    [36000, "about 10 h 0 min"],
  ])("%s s is %s", (seconds, text) => {
    expect(about(seconds)).toBe(text);
  });

  // The picture code wrote "about 1 h 60 min" for 7199 s: a rounded-up hour must carry.
  it("carries a rounded-up hour: it never writes 60 minutes", () => {
    expect(about(7199)).toBe("about 2 h 0 min");
    expect(about(7170)).toBe("about 2 h 0 min");
    expect(about(7169)).toBe("about 1 h 59 min");
  });

  const seconds = (text: string): number => {
    const h = /^about (\d+) h (\d+) min$/.exec(text);
    if (h) return Number(h[1]) * 3600 + Number(h[2]) * 60;
    const m = /^about (\d+) min$/.exec(text);
    if (m) return Number(m[1]) * 60;
    const s = /^about (\d+) s$/.exec(text);
    if (s) return Number(s[1]);
    throw new Error(`not a length: ${text}`);
  };

  it("is always a length, never 60 minutes, within a rounding of what was asked, and never shorter for a longer wait", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e7, noNaN: true }),
        fc.double({ min: 0, max: 1e7, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const textLo = about(lo);
          const minutes = /^about \d+ h (\d+) min$/.exec(textLo)?.[1];
          if (minutes !== undefined) expect(Number(minutes)).toBeLessThan(60);
          expect(Math.abs(seconds(textLo) - lo)).toBeLessThanOrEqual(lo < 90 ? 1 : 30);
          expect(seconds(textLo)).toBeLessThanOrEqual(seconds(about(hi)));
        },
      ),
    );
  });

  it("is a length for numbers that are not lengths, and does not say a negative or unknown wait is long", () => {
    for (const bad of [NaN, -5, -Infinity]) expect(about(bad)).toBe("about 1 s");
    expect(about(Infinity)).toMatch(/^about \d+ h \d+ min$/);
  });

  it("is lengthText with 'about ' in front", () => {
    expect(lengthText(180)).toBe("3 min");
    expect(lengthText(45)).toBe("45 s");
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e7, noNaN: true }), (s) => {
        expect(about(s)).toBe(`about ${lengthText(s)}`);
      }),
    );
  });
});

describe("the speed rows", () => {
  it("say what the pictures say: 8.1x is 'about 7 s' a minute, 0.3x is 'about 3 min'", () => {
    expect(speedText(1 / 8.1)).toBe("8.1×");
    expect(speedLine(1 / 8.1)).toBe("8.1× (1 min of audio takes about 7 s)");
    expect(speedText(1 / 0.3)).toBe("0.3×");
    expect(speedLine(1 / 0.3)).toBe("0.3× (1 min of audio takes about 3 min)");
    expect(speedText(3.7)).toBe("0.3×"); // the field's median processor-only PC: 0.27 times real time
  });

  it("claim no speed until a rate is measured", () => {
    for (const bad of [null, 0, -1, NaN, Infinity, Number.MIN_VALUE]) {
      expect(speedLine(bad)).toBeNull();
      if (bad !== null) expect(speedText(bad)).toBeNull();
    }
  });

  it("is a number and a length for any measured rate, and a slower PC never reads as faster", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-3, max: 1e3, noNaN: true }),
        fc.double({ min: 1e-3, max: 1e3, noNaN: true }),
        (a, b) => {
          const [fast, slow] = a <= b ? [a, b] : [b, a];
          const line = speedLine(slow);
          expect(line).toMatch(
            /^\d+(\.\d+)?× \(1 min of audio takes about \d+( h \d+ min| min| s)\)$/,
          );
          expect(Number.parseFloat(speedText(slow) ?? "")).toBeLessThanOrEqual(
            Number.parseFloat(speedText(fast) ?? ""),
          );
        },
      ),
    );
  });
});

describe("runningOn", () => {
  it("names the processor with the threads of the cores it was given, or the graphics chip", () => {
    expect(runningOn(facts({ backend: "cpu", threads: 2, cores: 4 }))).toBe(
      "your processor, 2 of 4 cores",
    );
    expect(runningOn(facts({ backend: "cpu", threads: 8, cores: 16 }))).toBe(
      "your processor, 8 of 16 cores",
    );
    expect(runningOn(facts({ backend: "gpu", threads: 2, cores: 4 }))).toBe("your graphics chip");
  });

  it("says nothing it does not know: no backend is no answer, unknown threads or cores are left out", () => {
    expect(runningOn(facts({ backend: null, threads: 2, cores: 4 }))).toBeNull();
    expect(runningOn(facts({ backend: "cpu" }))).toBe("your processor");
    expect(runningOn(facts({ backend: "cpu", threads: 2 }))).toBe("your processor");
    expect(runningOn(facts({ backend: "cpu", cores: 4 }))).toBe("your processor");
    expect(runningOn(facts({ backend: "cpu", threads: 9, cores: 4 }))).toBe("your processor");
    expect(runningOn(facts({ backend: "cpu", threads: 1, cores: 1 }))).toBe(
      "your processor, 1 of 1 core",
    );
  });
});
