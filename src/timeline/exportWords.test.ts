import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EXPORT_REASON_CODES } from "../api/exportReason";
import { STALL_LOG_SECONDS } from "./exportTrace";
import {
  describeChipFailure,
  describeEncoder,
  describeLiveStatus,
  describeModeLines,
  describeResult,
  describeRung,
  describeStage,
  describeTook,
  describeTryAgain,
  describeWaiting,
  failureOf,
  ordinal,
  plainFailure,
  QUIET_SECONDS,
  quietSeconds,
  timeLeftSeconds,
  type LiveFacts,
  type ModeView,
} from "./exportWords";

const T0 = 1_000_000;
const live = (over: Partial<LiveFacts> = {}): LiveFacts => ({
  stage: "rendering",
  startedAt: T0,
  fraction: 0.52,
  etaSec: 240,
  step: null,
  steps: null,
  lastMoveAt: T0,
  ...over,
});
const garbage = [Number.NaN, Number.POSITIVE_INFINITY, -5, 0, 1e18] as const;

describe("when the card says there is no progress", () => {
  it("is the same silence the report logs as a stall", () => {
    expect(QUIET_SECONDS).toBe(STALL_LOG_SECONDS);
  });

  it("counts real seconds since the render last moved, and only while it is preparing or rendering", () => {
    expect(quietSeconds(live({ lastMoveAt: T0 }), T0 + 75_400)).toBe(75);
    expect(quietSeconds(live({ lastMoveAt: T0 }), T0 - 5_000)).toBe(0);
    expect(quietSeconds(live({ stage: "checking", lastMoveAt: T0 }), T0 + 500_000)).toBe(0);
    expect(quietSeconds(live({ stage: "saving", lastMoveAt: T0 }), T0 + 500_000)).toBe(0);
    expect(quietSeconds(live({ stage: "preparing", lastMoveAt: T0 }), T0 + 90_000)).toBe(90);
  });
});

describe("the step an export is at, in words", () => {
  it.each([
    [live({ stage: "preparing" }), "Preparing · checking your clips"],
    [live({ stage: "rendering" }), "Rendering and encoding"],
    [live({ stage: "rendering", step: 2, steps: 13 }), "Rendering part 3 of 12"],
    [live({ stage: "rendering", step: 12, steps: 13 }), "Encoding"],
    [live({ stage: "checking" }), "Checking the file"],
    [live({ stage: "saving" }), "Saving"],
    [live({ stage: "queued" }), "Waiting"],
  ])("%j", (facts, words) => {
    expect(describeStage(facts)).toBe(words);
  });

  it("never names a part number it cannot stand behind", () => {
    for (const step of [null, -1, Number.NaN, 99]) {
      const words = describeStage(live({ stage: "rendering", step, steps: 5 }));
      expect(words).not.toMatch(/NaN|undefined|-|part 0|part 100/);
    }
    expect(describeStage(live({ stage: "rendering", step: 1, steps: 1 }))).toBe(
      "Rendering and encoding",
    );
  });
});

describe("the status line", () => {
  it("tells a fresh render's stage, how far it is and how long is left", () => {
    expect(describeLiveStatus(live(), T0 + 20_000)).toBe(
      "Rendering and encoding · 52% · about 4 min left",
    );
  });

  it("says 'still working' with the minutes in once a minute has passed, so the line changes at least every minute", () => {
    expect(describeLiveStatus(live({ lastMoveAt: T0 + 170_000 }), T0 + 185_000)).toBe(
      "Still working · 3 min in · Rendering and encoding · 52% · about 4 min left",
    );
  });

  it("says it too while the file is being checked or saved, which also go on for minutes on a long export", () => {
    expect(describeLiveStatus(live({ stage: "checking" }), T0 + 185_000)).toBe(
      "Still working · 3 min in · Checking the file",
    );
    expect(describeLiveStatus(live({ stage: "saving" }), T0 + 185_000)).toBe(
      "Still working · 3 min in · Saving",
    );
    // Under a minute in there is nothing to count yet.
    expect(describeLiveStatus(live({ stage: "checking" }), T0 + 20_000)).toBe("Checking the file");
  });

  it("says there is no progress, how long, and which step, and does not promise a retry", () => {
    const line = describeLiveStatus(
      live({ step: 2, steps: 13, fraction: 0.38, lastMoveAt: T0 }),
      T0 + 75_000,
    );
    expect(line).toBe("No progress for 75 s · Rendering part 3 of 12 · 38%");
    // A retry is something a later phase will do; this line must not claim it.
    expect(line).not.toMatch(/retry|gentler/i);
    expect(describeLiveStatus(live({ lastMoveAt: T0 }), T0 + 200_000)).toContain(
      "No progress for 3 min",
    );
  });

  it("does not give a time left while the render is not moving", () => {
    expect(describeLiveStatus(live({ lastMoveAt: T0 }), T0 + 90_000)).not.toContain("left");
  });

  it("gives no percentage outside the render", () => {
    for (const stage of ["preparing", "checking", "saving"] as const)
      expect(describeLiveStatus(live({ stage, fraction: 0.99 }), T0 + 5_000)).not.toContain("%");
  });

  it("has a different line a minute later whenever the export is still going, in any stage", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("preparing", "rendering", "checking", "saving" as const),
        fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 0, max: 600 }),
        (stage, fraction, wait, minutes) => {
          // It keeps moving, so the silence never reaches the stall line: what changes is the clock.
          const facts = (now: number) =>
            live({ stage, fraction, lastMoveAt: now - (wait % 30_000) });
          const at = T0 + 60_000 + minutes * 60_000;
          expect(describeLiveStatus(facts(at), at)).not.toBe(
            describeLiveStatus(facts(at + 60_000), at + 60_000),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it("is never a half-made sentence, whatever the numbers are", () => {
    for (const fraction of [...garbage, null, 0.5])
      for (const etaSec of [...garbage, null, 90])
        for (const stage of ["queued", "preparing", "rendering", "checking", "saving"] as const) {
          // It moved a second ago: what is under test is the numbers, not the silence.
          const facts = live({ stage, fraction, etaSec, lastMoveAt: T0 + 399_000 });
          const line = describeLiveStatus(facts, T0 + 400_000);
          expect(line).not.toMatch(/NaN|undefined|null|Infinity|-\d|\[object/);
          expect(line.length).toBeGreaterThan(0);
        }
  });
});

describe("how long is left, as a number", () => {
  it("is what the render thinks while it is moving", () => {
    expect(timeLeftSeconds(live({ etaSec: 92 }), T0 + 20_000)).toBe(92);
    expect(timeLeftSeconds(live({ etaSec: 0 }), T0 + 20_000)).toBe(0);
  });

  it("is nothing when the render is not under way, has stopped moving, or the number cannot be a time", () => {
    for (const stage of ["queued", "preparing", "checking", "saving"] as const)
      expect(timeLeftSeconds(live({ stage, etaSec: 92 }), T0 + 20_000)).toBeNull();
    expect(timeLeftSeconds(live({ etaSec: 92, lastMoveAt: T0 }), T0 + 90_000)).toBeNull();
    for (const etaSec of [null, Number.NaN, Number.POSITIVE_INFINITY, -1, 48 * 3600 + 1])
      expect(timeLeftSeconds(live({ etaSec }), T0 + 20_000)).toBeNull();
  });

  it("is the same answer the status line gives: it says a time left exactly when there is one", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("queued", "preparing", "rendering", "checking", "saving" as const),
        fc.oneof(
          fc.constant(null),
          fc.constantFrom(...garbage),
          fc.integer({ min: 0, max: 200_000 }),
        ),
        fc.integer({ min: 0, max: 400 }),
        (stage, etaSec, quiet) => {
          const now = T0 + 500_000;
          const facts = live({ stage, etaSec, lastMoveAt: now - quiet * 1000 });
          const said = describeLiveStatus(facts, now).includes(" left");
          const left = timeLeftSeconds(facts, now);
          // A time can round to nothing worth saying (under a second), but a said time is always a number.
          if (said) expect(left).not.toBeNull();
          if (left === null) expect(said).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("the setting an export runs at, in words", () => {
  it("says nothing about the normal setting, and why and what it costs about the others", () => {
    expect(describeRung(0)).toBe("");
    expect(describeRung(1)).toBe(
      "Using a gentler setting to fit this PC's memory · it may take a little longer",
    );
    expect(describeRung(2)).toBe(
      "Using the gentlest setting to fit this PC's memory · it will take longer",
    );
  });

  it("never says anything half-made for a value it does not know", () => {
    for (const odd of [undefined, null, -1, 7, Number.NaN, "x"])
      expect(describeRung(odd as never)).toBe("");
  });
});

describe("what Try again will do, in words", () => {
  it("says a gentler setting is coming, and what it costs, after a failure for lack of memory or time", () => {
    for (const reason of ["memory_limit", "time_limit"] as const) {
      for (const rung of [undefined, 0, 1] as const) {
        const line = describeTryAgain(reason, rung);
        expect(line).toMatch(/gentler setting/);
        expect(line).toMatch(/less memory/);
        expect(line).toMatch(/longer/);
      }
    }
  });

  it("says plainly when the lightest setting this export has was already the one that failed, rather than promising a lighter run", () => {
    for (const reason of ["memory_limit", "time_limit"] as const) {
      // The gentlest rung, an export with only one gentler rung that failed at it, and one with none at all
      // (the streamed engine, or the switch for rungs off).
      for (const [failed, last] of [
        [2, 2],
        [1, 1],
        [0, 0],
      ] as const) {
        const line = describeTryAgain(reason, failed, last);
        expect(line).toMatch(/already running at its lightest setting/);
        expect(line).not.toMatch(/less memory/);
      }
      // One rung short of the lightest, it is still a gentler one.
      expect(describeTryAgain(reason, 0, 1)).toMatch(/gentler setting/);
      expect(describeTryAgain(reason, 1, 2)).toMatch(/gentler setting/);
    }
  });

  it("says nothing for a failure a gentler setting does not touch", () => {
    for (const reason of EXPORT_REASON_CODES) {
      if (reason === "memory_limit" || reason === "time_limit") continue;
      for (const rung of [undefined, 0, 1, 2] as const)
        expect(describeTryAgain(reason, rung)).toBe("");
    }
  });
});

describe("the encoder an export runs on, in words", () => {
  it("says nothing about the processor's normal setting, and what the graphics chip and the faster setting cost about the others", () => {
    expect(describeEncoder("x264", "none")).toBe("");
    for (const chip of ["amd", "nvidia", "intel"] as const) {
      expect(describeEncoder(chip, "over_minute")).toBe(
        "Using your graphics chip to save time · the file is larger and the picture can differ slightly",
      );
      // Picked by the person: no need to say why it is used.
      expect(describeEncoder(chip, "person")).toBe(
        "Using your graphics chip · the file is larger and the picture can differ slightly",
      );
    }
    expect(describeEncoder("x264_fast", "promise_line")).toBe(
      "Using a faster setting to save time · the picture may be slightly softer",
    );
  });

  it("never says anything half-made for a value it does not know", () => {
    for (const odd of [undefined, null, 7, Number.NaN, "x", "gpu", {}])
      expect(describeEncoder(odd as never, "over_minute")).toBe("");
    expect(describeEncoder("amd", undefined as never)).toMatch(/graphics chip/);
  });

  it("says what happened and what Try again will do when the graphics chip stopped an export, for the card and for the assistant", () => {
    expect(describeChipFailure("card")).toBe(
      "The graphics chip stopped this export. Try again uses the processor instead, which takes longer.",
    );
    expect(describeChipFailure("assistant")).toBe(
      "The graphics chip stopped this export before it finished. It is set aside for a day: export again and the processor is used, which takes longer.",
    );
    // An export with no Try again (a clip on its own, or one a restarted app finished): the person is told what to do.
    expect(describeChipFailure("again")).toBe(
      "The graphics chip stopped this export. Export it again and the processor will be used, which takes longer.",
    );
  });
});

describe("what the Export dialog says about the mode, in words", () => {
  const row = (over: Partial<ModeView> = {}): ModeView => ({
    showRow: true,
    defaultMode: "quality",
    reason: "none",
    faster: false,
    fullSeconds: 40,
    fastSeconds: 15,
    ...over,
  });

  it("says nothing, and selects Full quality, until the app has looked", () => {
    expect(describeModeLines(null, null)).toEqual({
      selected: "quality",
      hint: null,
      note: null,
      alternative: null,
      faster: null,
    });
    expect(describeModeLines(null, "fast").selected).toBe("quality"); // a pick with no row is no pick
  });

  it("offers Fast beside Full for a short export, with what Fast would save and no note", () => {
    const lines = describeModeLines(row(), null);
    expect(lines.selected).toBe("quality");
    // Measured with the real chip on real footage (exporter document 19.9): 1.0 to 1.9 times quicker, so "usually", not "much".
    expect(lines.hint).toBe(
      "Fast uses your graphics chip: usually quicker, and the file is usually larger.",
    );
    expect(lines.alternative).toBe("Fast would take under a minute.");
    expect(lines.note).toBeNull();
    expect(lines.faster).toBeNull();
  });

  it("selects Fast for the person for an export over a minute, says why, and says what Full would take", () => {
    const lines = describeModeLines(
      row({ defaultMode: "fast", reason: "over_minute", fullSeconds: 720, fastSeconds: 240 }),
      null,
    );
    expect(lines.selected).toBe("fast");
    expect(lines.note).toBe(
      "Fast is selected because this export would take over a minute on this PC (about 12 min). The file will be larger and the picture can differ slightly. Choose Full quality for the smallest file.",
    );
    expect(lines.alternative).toBe("Full quality would take about 12 min.");
  });

  it("follows what the person picked over what the app selected, either way", () => {
    const long = row({
      defaultMode: "fast",
      reason: "over_minute",
      fullSeconds: 720,
      fastSeconds: 240,
    });
    const full = describeModeLines(long, "quality");
    expect(full.selected).toBe("quality");
    expect(full.note).toBeNull();
    expect(full.alternative).toBe("Fast would take about 4 min.");
    const fast = describeModeLines(row({ fullSeconds: 720, fastSeconds: 240 }), "fast");
    expect(fast.selected).toBe("fast");
    expect(fast.note).toBe(
      "The file will be larger and the picture can differ slightly from Full quality.",
    );
    expect(fast.note).not.toMatch(/is selected because/); // the person picked it: nothing to explain
  });

  it("says the faster setting will be used only where there is no row and the app will use it", () => {
    expect(describeModeLines(row({ showRow: false, faster: true }), null).faster).toBe(
      "To save time, ArtDaddy will use a faster setting; the picture may be slightly softer.",
    );
    expect(describeModeLines(row({ showRow: false, faster: false }), null).faster).toBeNull();
    expect(describeModeLines(row({ showRow: true, faster: true }), null).faster).toBeNull();
  });

  it("selects Fast only where the row is shown, and never says half of a sentence", () => {
    const seconds = fc.option(fc.double({ min: -5, max: 100_000, noNaN: false }), { nil: null });
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom<"quality" | "fast">("quality", "fast"),
        fc.constantFrom("over_minute", "person", "promise_line", "none" as const),
        fc.boolean(),
        seconds,
        seconds,
        fc.option(fc.constantFrom<"quality" | "fast">("quality", "fast"), { nil: null }),
        (showRow, defaultMode, reason, faster, fullSeconds, fastSeconds, picked) => {
          const lines = describeModeLines(
            { showRow, defaultMode, reason, faster, fullSeconds, fastSeconds },
            picked,
          );
          if (lines.selected === "fast") expect(showRow).toBe(true);
          for (const line of [lines.hint, lines.note, lines.alternative, lines.faster])
            if (line !== null) expect(line).not.toMatch(/NaN|undefined|Infinity|null|\(\)/);
          // Nothing about Fast is said where the row is not shown.
          if (!showRow) {
            expect(lines.hint).toBeNull();
            expect(lines.note).toBeNull();
            expect(lines.alternative).toBeNull();
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("waiting in the queue", () => {
  it("counts the place in line", () => {
    expect(describeWaiting(1)).toBe("Waiting · 1st in line");
    expect(describeWaiting(2)).toBe("Waiting · 2nd in line");
    expect(describeWaiting(3)).toBe("Waiting · 3rd in line");
    expect(describeWaiting(0)).toBe("Waiting");
    expect(describeWaiting(Number.NaN)).toBe("Waiting");
  });

  it("gets every ordinal right", () => {
    const cases: Array<[number, string]> = [
      [1, "1st"],
      [2, "2nd"],
      [3, "3rd"],
      [4, "4th"],
      [10, "10th"],
      [11, "11th"],
      [12, "12th"],
      [13, "13th"],
      [21, "21st"],
      [22, "22nd"],
      [23, "23rd"],
      [101, "101st"],
      [111, "111th"],
    ];
    for (const [n, text] of cases) expect(ordinal(n)).toBe(text);
  });
});

describe("the reason an export stopped, in plain words", () => {
  it("has a sentence for every reason the report knows, without jargon or codes", () => {
    for (const code of EXPORT_REASON_CODES) {
      const sentence = plainFailure(code);
      expect(sentence.length, code).toBeGreaterThan(0);
      expect(sentence).not.toMatch(/ffmpeg|stderr|_limit|_failed|_unavailable|undefined|null/i);
      expect(sentence.endsWith(".")).toBe(true);
    }
  });

  it("reads the reason off the text of a failure, with the rule the report uses", () => {
    expect(failureOf("Error while filtering: Cannot allocate memory")).toEqual({
      code: "memory_limit",
      plain: plainFailure("memory_limit"),
    });
    expect(failureOf("No space left on device").code).toBe("storage_full");
    expect(failureOf(undefined).code).toBe("unknown");
    expect(failureOf("").plain).toBe(plainFailure("unknown"));
  });

  it("tells the person what to do about the ones they can fix", () => {
    expect(plainFailure("memory_limit")).toMatch(/close other programs/i);
    expect(plainFailure("storage_full")).toMatch(/free up/i);
  });
});

describe("the result line", () => {
  it("says what was exported and how long it took", () => {
    expect(describeResult({ state: "done", filename: "movie.mp4", elapsedMs: 252_000 })).toEqual({
      title: "Exported “movie.mp4”",
      detail: "Took 4 min 12 s",
    });
  });

  it("says plainly why an export stopped", () => {
    expect(
      describeResult({
        state: "failed",
        filename: "movie.mp4",
        elapsedMs: 5_000,
        error: "Cannot allocate memory",
      }),
    ).toEqual({ title: "Export stopped", detail: plainFailure("memory_limit") });
  });

  it("says a cancelled export was cancelled, and does not invent a reason", () => {
    expect(describeResult({ state: "cancelled", filename: "movie.mp4", elapsedMs: 1_000 })).toEqual(
      { title: "Export cancelled", detail: "" },
    );
  });

  it("writes a duration the way a person says it", () => {
    expect(describeTook(0)).toBe("under a second");
    expect(describeTook(45_000)).toBe("45 s");
    expect(describeTook(60_000)).toBe("1 min");
    expect(describeTook(252_000)).toBe("4 min 12 s");
    expect(describeTook(3_600_000)).toBe("1 h");
    expect(describeTook(3_780_000)).toBe("1 h 3 min");
    for (const bad of garbage) expect(describeTook(bad)).not.toMatch(/NaN|Infinity|undefined|-/);
  });
});
