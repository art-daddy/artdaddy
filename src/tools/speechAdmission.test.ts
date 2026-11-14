// The admission of a whole-file speech run that nobody asked for (S2-02), as rules that survive a
// rewrite: what it decides from this PC's own facts, that it decides NOTHING with the switch off, that
// an unknown length is a run, and that the record of what it decided is bounded and honest.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import {
  __resetSpeechSession,
  admissionSignature,
  admitWholeFile,
  isOnDemandThisSession,
  isSpeechDeferred,
  markCancelledByPerson,
  markOnDemandThisSession,
  SpeechDeferredError,
  wasCancelledByPerson,
} from "./speechAdmission";
import { GPU_RETRY_AFTER_MS, holdCpuOnly } from "./speechBackend";
import { recordSpeechRun } from "./speechPace";
import { CAP_S } from "./speechPlan";
import { __resetPlanLog, PLAN_LOG_KEEP, recentPlans, recordPlan } from "./speechPlanLog";

const HOUR_S = 3600;
const START = Date.UTC(2026, 10, 14, 12, 0, 0);

beforeEach(() => {
  localStorage.clear();
  __resetExportFlags();
  __resetPlanLog();
  __resetSpeechSession();
  vi.useFakeTimers({ now: START, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  __resetExportFlags();
});

/** The processor as a PC that has measured nothing runs it (3.7 s of work per audio second, 20 s to begin). */
const heldProcessor = (): void => holdCpuOnly(-1073740791, Date.now());
/** A PC whose latest runs were on its graphics chip. */
const chipPc = (): void => {
  recordSpeechRun(60, 10, "gpu");
  recordSpeechRun(60, 11, "gpu");
};

describe("what the admission decides", () => {
  it("leaves a 3-hour file out on a processor at its default pace, and says why, with the numbers", () => {
    heldProcessor();
    const got = admitWholeFile({ file: "talk.mp4", where: "indexer", audioS: 3 * HOUR_S });
    expect(got).toMatchObject({ plan: "ondemand", why: "cap", backend: "cpu", held: true });
    expect(got?.projectedS).toBeCloseTo(20 + 3.7 * 3 * HOUR_S, 6);
    expect(got?.capS).toBe(CAP_S);
    expect(recentPlans()).toEqual([
      {
        at: START,
        file: "talk.mp4",
        plan: "ondemand",
        why: "cap",
        projectedS: got?.projectedS,
        backend: "cpu",
        held: true,
        where: "indexer",
      },
    ]);
  });

  it("runs the same file on a graphics chip, whatever its length, and says what the chip projects", () => {
    chipPc();
    const got = admitWholeFile({ file: "talk.mp4", where: "boundary", audioS: 3 * HOUR_S });
    expect(got).toMatchObject({ plan: "whole", why: "ok", backend: "gpu", held: false });
    expect(got?.projectedS).toBeGreaterThan(0);
    expect(recentPlans().map((r) => [r.plan, r.why])).toEqual([["whole", "ok"]]);
  });

  it("runs a file whose length cannot be told, on the processor too: no length is never a reason to leave it", () => {
    heldProcessor();
    for (const unknown of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      __resetPlanLog();
      const got = admitWholeFile({ file: "x.mp4", where: "boundary", audioS: unknown });
      expect(got, String(unknown)).toMatchObject({ plan: "whole", why: "gpu_held" });
      expect(got?.projectedS).toBeNull();
    }
  });

  it("decides nothing, and writes nothing, with the switch off: 0.27.0 starts whatever its length", () => {
    heldProcessor();
    __setExportFlag("speech_cpu_cap", false);
    expect(admitWholeFile({ file: "talk.mp4", where: "indexer", audioS: 3 * HOUR_S })).toBeNull();
    expect(recentPlans()).toEqual([]);
  });

  it("follows the hold on the chip as it lapses: planned on the processor while held, on the chip after", () => {
    chipPc(); // this PC's runs were on its chip: the hold is what puts the processor in charge for a while
    heldProcessor();
    const planOf = (seconds: number) =>
      admitWholeFile({ file: "f.mp4", where: "boundary", audioS: seconds })!;
    // 2 minutes: 20 + 3.7 x 120 = 464 s, inside the cap. 20 minutes: 4,460 s, far over it.
    expect(planOf(120)).toMatchObject({ plan: "whole", why: "gpu_held" });
    expect(planOf(1200)).toMatchObject({ plan: "ondemand", why: "cap" });
    vi.setSystemTime(START + GPU_RETRY_AFTER_MS - 1);
    expect(planOf(1200), "never earlier than six hours").toMatchObject({ plan: "ondemand" });
    vi.setSystemTime(START + GPU_RETRY_AFTER_MS);
    expect(planOf(1200), "the chip is tried again").toMatchObject({
      plan: "whole",
      why: "ok",
      backend: "gpu",
      held: false,
    });
  });

  it("is a decision for any length and any pace, never a crash: a processor file is left out exactly when its projection passes the cap", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 400_000, noNaN: true }),
        fc.integer({ min: 12, max: 400 }),
        fc.integer({ min: 1, max: 60 }),
        (seconds, perTenth, startupS) => {
          localStorage.clear();
          __resetPlanLog();
          const rate = perTenth / 100;
          // One measured processor run on this PC: `audio` seconds took `startupS + rate x audio`.
          recordSpeechRun(100, startupS + rate * 100, "cpu", undefined, startupS);
          const got = admitWholeFile({ file: "f.mp4", where: "boundary", audioS: seconds });
          expect(got?.backend).toBe("cpu");
          const projected = startupS + rate * seconds;
          fc.pre(Math.abs(projected - CAP_S) > 1e-6); // the last digit of the rate is not the rule
          expect(got?.plan).toBe(projected > CAP_S ? "ondemand" : "whole");
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("what the indexer rereads before it asks again", () => {
  it("changes when the hold lapses, when this PC measures a pace, and when the switch moves; not otherwise", () => {
    heldProcessor();
    const first = admissionSignature();
    expect(admissionSignature(), "reading it changes nothing").toBe(first);
    vi.setSystemTime(START + 1000);
    expect(admissionSignature(), "time passing inside the hold is not a change").toBe(first);
    recordSpeechRun(120, 125, "cpu");
    const faster = admissionSignature();
    expect(faster).not.toBe(first);
    __setExportFlag("speech_cpu_cap", false);
    expect(admissionSignature()).not.toBe(faster);
    __resetExportFlags();
    vi.setSystemTime(START + GPU_RETRY_AFTER_MS);
    expect(admissionSignature()).not.toBe(faster);
  });
});

describe("the deferral is a typed outcome, not a failure", () => {
  it("is recognised by its code, whichever copy of the module made it, and carries the plan", () => {
    const error = new SpeechDeferredError({ why: "cap", projectedS: 4460, capS: CAP_S });
    expect(isSpeechDeferred(error)).toBe(true);
    expect(isSpeechDeferred({ code: "speech_deferred" })).toBe(true);
    for (const other of [null, undefined, "speech_deferred", new Error("x"), { code: "other" }])
      expect(isSpeechDeferred(other)).toBe(false);
    expect(error).toMatchObject({ expected: true, stopped: false });
    expect(error.admission).toEqual({ why: "cap", projectedS: 4460, capS: CAP_S });
    expect(new SpeechDeferredError(error.admission, { stopped: true }).stopped).toBe(true);
  });

  it("says in plain words that only the parts asked for are transcribed, in minutes, and names no queue", () => {
    const text = new SpeechDeferredError({ why: "cap", projectedS: 4460, capS: CAP_S }).message;
    expect(text).toMatch(/about 74 min/);
    expect(text).toMatch(/only the parts that are asked for/);
    expect(text).not.toMatch(/queue|background job|fail/i);
  });
});

describe("what this session remembers", () => {
  it("holds a cancelled file and a too-slow file apart, and forgets neither within the session", () => {
    expect([wasCancelledByPerson("a"), isOnDemandThisSession("a")]).toEqual([false, false]);
    markCancelledByPerson("a");
    markOnDemandThisSession("b");
    expect([wasCancelledByPerson("a"), isOnDemandThisSession("a")]).toEqual([true, false]);
    expect([wasCancelledByPerson("b"), isOnDemandThisSession("b")]).toEqual([false, true]);
  });

  it("is bounded: the oldest are forgotten first, the newest never", () => {
    for (let i = 0; i < 5_200; i++) markCancelledByPerson(`file-${i}`);
    expect(wasCancelledByPerson("file-0")).toBe(false);
    expect(wasCancelledByPerson("file-5199")).toBe(true);
    expect(wasCancelledByPerson("file-200")).toBe(true);
  });
});

describe("the plan log", () => {
  it("keeps the last 50 decisions, oldest first, whatever is written", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 180 }), (n) => {
        __resetPlanLog();
        for (let i = 0; i < n; i++)
          recordPlan({
            at: i,
            file: `f${i}`,
            plan: "whole",
            why: "ok",
            projectedS: i,
            backend: "gpu",
            held: false,
            where: "boundary",
          });
        const kept = recentPlans();
        expect(kept).toHaveLength(Math.min(n, PLAN_LOG_KEEP));
        expect(kept.map((r) => r.at)).toEqual(
          Array.from({ length: kept.length }, (_, i) => n - kept.length + i),
        );
      }),
    );
  });

  it("hands out copies: a reader cannot change what is kept", () => {
    recordPlan({
      at: 1,
      file: "a",
      plan: "whole",
      why: "ok",
      projectedS: null,
      backend: "gpu",
      held: false,
      where: "live",
    });
    recentPlans()[0].plan = "ondemand";
    expect(recentPlans()[0].plan).toBe("whole");
  });
});
