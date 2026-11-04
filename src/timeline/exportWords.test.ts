import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EXPORT_REASON_CODES } from "../api/exportReason";
import { STALL_LOG_SECONDS } from "./exportTrace";
import {
  describeLiveStatus,
  describeResult,
  describeStage,
  describeTook,
  describeWaiting,
  failureOf,
  ordinal,
  plainFailure,
  QUIET_SECONDS,
  quietSeconds,
  timeLeftSeconds,
  type LiveFacts,
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
