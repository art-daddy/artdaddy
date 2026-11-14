// The graphics chip's row of the table of automatic restarts: which failures a chip explains and a restart on the processor can do better
// for, and what every row of the table must respect on top of that. Decided through the real table (exportRestart.ts), not through the
// row alone, so a row that stopped being reached would show here.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EXPORT_REASON_CODES, type ExportReasonCode } from "../api/exportReason";
import { EXPORT_LIMITS } from "../api/exportVocabulary";
import { CHIP_RESTART_REASON, CHIP_RESTART_ROW } from "./chipRestart";
import { CHIP_MAKERS, type ChipMaker } from "./exportEncoder";
import {
  AUTO_RESTART_REASONS,
  REFUSAL_ORDER,
  decideRestart,
  eligibleReasons,
  restartRow,
  type RestartFacts,
  type RestartRefusal,
} from "./exportRestart";

const GIB = 1024 ** 3;

interface Over {
  failure?: Partial<RestartFacts["failure"]>;
  attempt?: Partial<RestartFacts["attempt"]>;
  progress?: Partial<RestartFacts["progress"]>;
  machine?: Partial<RestartFacts["machine"]>;
  request?: Partial<Omit<RestartFacts["request"], "flags">>;
  flags?: Record<string, boolean>;
}

/** A failed check of the file a chip made, at the very end of an export on that chip, with every condition for a restart met. */
function facts(over: Over = {}): RestartFacts {
  return {
    failure: {
      code: "verification_failed",
      guard: null,
      stopKind: null,
      stopSeconds: null,
      ...over.failure,
    },
    attempt: {
      number: 1,
      rung: 0,
      ladder: [0, 2],
      engine: "file-sequence-v1",
      encoder: "chip-amd",
      chipMaker: "amd",
      stickyRoute: null,
      ...over.attempt,
    },
    progress: {
      producedFraction: 1,
      elapsedSeconds: 600,
      activeSeconds: 590,
      expectedSeconds: 600,
      ...over.progress,
    },
    machine: { freeBytes: 8 * GIB, failedPeakBytes: null, limitBytes: null, ...over.machine },
    request: {
      retryClosureExists: true,
      snapshotUnchanged: true,
      aborted: false,
      autoRestartsUsed: 0,
      flags: {
        auto_restart: true,
        memory_restart: true,
        restart_streamed: true,
        plan_rung: true,
        chip_restart: true,
        ...over.flags,
      },
      ...over.request,
    },
    workload: null,
  };
}

const CHIP_FLAG_OFF = { chip_restart: false };

describe("the graphics chip's row of the table of automatic restarts", () => {
  it("is a row of the shipped table, after the memory rows, with the processor as its one change and its own switch", () => {
    expect(restartRow(CHIP_RESTART_REASON)).toBe(CHIP_RESTART_ROW);
    expect(AUTO_RESTART_REASONS.map((row) => row.reason)).toEqual([
      "memory_short",
      "memory_ceiling",
      "chip_failed",
    ]);
    expect(CHIP_RESTART_ROW).toMatchObject({
      restarted: "processor",
      flag: "chip_restart",
      override: ["processor"],
    });
    expect(Object.isFrozen(restartRow("chip_failed"))).toBe(true);
  });

  it("has the copy pack's words, none of which promises a picture, a likeness or a speed", () => {
    expect(CHIP_RESTART_ROW.words.gap).toBe(
      "The graphics chip stopped this export. Starting again on the processor…",
    );
    expect(CHIP_RESTART_ROW.words.after).toBe(
      "Started again on the processor because the graphics chip stopped the first try. It will take longer. Your export settings are kept.",
    );
    expect(CHIP_RESTART_ROW.words.assistantNote).toBe(
      "The app restarted this export once by itself because the graphics chip stopped it. It is the same export (same job_id): do not start another.",
    );
    const promises =
      /pixel|same (picture|image|look|quality)|identical|looks? the same|times (faster|slower|longer)|\d\s?[x×]\s|twice|half the time/i;
    for (const sentence of Object.values(CHIP_RESTART_ROW.words))
      expect(sentence).not.toMatch(promises);
  });

  it("restarts a failed check on the processor, from the normal setting, at any point of the export", () => {
    for (const producedFraction of [0, 0.1, 0.25, 0.5, 0.97, 1, Number.NaN])
      expect(
        decideRestart(facts({ progress: { producedFraction } })),
        String(producedFraction),
      ).toEqual({
        restart: true,
        reason: "chip_failed",
        override: { processor: true },
        restarted: "processor",
        routeM: 0,
        failedRungN: 0,
      });
  });
});

// Which failures restart, written out here and not read from the module: a failed check, a hang while the PC was idle, a render failure
// that names the chip's encoder: each on an export that ran on a chip. Nothing else.
const restartsOn = (
  code: ExportReasonCode,
  stopKind: "idle" | "ceiling" | null,
  namesChip: boolean,
) =>
  code === "verification_failed" ||
  (code === "time_limit" && stopKind === "idle") ||
  ((code === "render_failed" || code === "unknown") && namesChip);

describe("which failures the chip answers for", () => {
  const stops = [null, "idle", "ceiling"] as const;
  const makers: ReadonlyArray<ChipMaker | null> = [null, ...CHIP_MAKERS];

  it("restarts exactly the failures a chip explains, on an export that ran on a chip, and gives each other failure its own word", () => {
    let restarted = 0;
    for (const code of EXPORT_REASON_CODES)
      for (const stopKind of stops)
        for (const namesChip of [false, true])
          for (const chipMaker of makers) {
            const label = `${code} / ${stopKind} / names the chip ${namesChip} / ${chipMaker}`;
            const decision = decideRestart(
              facts({
                failure: { code, stopKind, stopSeconds: stopKind ? 200 : null, namesChip },
                attempt: { chipMaker, encoder: chipMaker ? `chip-${chipMaker}` : "x264-crf" },
              }),
            );
            if (code === "memory_limit") {
              // the memory rows' own: not the chip's, and no guard says which limit fired
              expect(decision, label).toEqual({ restart: false, why: "not_memory" });
              continue;
            }
            if (restartsOn(code, stopKind, namesChip) && chipMaker !== null) {
              restarted++;
              expect(decision, label).toMatchObject({ restart: true, reason: "chip_failed" });
              continue;
            }
            // the word is the row's own: "no route" where a chip ran the export and a hang stopped it in a way the processor cannot do better
            // for (the busy ceiling, a stop the rule did not make), "not memory" for any other failure and for an export that ran on no chip
            const word = chipMaker !== null && code === "time_limit" ? "no_route" : "not_memory";
            expect(decision, label).toEqual({ restart: false, why: word });
          }
    // a failed check (6 spellings of the rest), an idle hang (2), a named render failure of either code (3 + 3): on each of the 3 makers
    expect(restarted).toBe((6 + 2 + 3 + 3) * 3);
  });

  it("does not restart a stop at the busy ceiling, or a time limit the no-progress rule did not give", () => {
    for (const stopKind of ["ceiling", null] as const)
      expect(decideRestart(facts({ failure: { code: "time_limit", stopKind } }))).toEqual({
        restart: false,
        why: "no_route",
      });
    expect(
      decideRestart(facts({ failure: { code: "time_limit", stopKind: "idle", stopSeconds: 185 } })),
    ).toMatchObject({
      restart: true,
    });
  });

  it("does not restart a failure the chip does not explain: a full disk, a missing source, a refused folder, memory, a cancel, a decline", () => {
    for (const code of [
      "storage_full",
      "source_unavailable",
      "storage_unavailable",
      "memory_limit",
      "interrupted",
      "cancelled",
      "declined",
      "none",
    ] as const)
      for (const stopKind of stops)
        expect(
          decideRestart(facts({ failure: { code, stopKind, namesChip: true } })),
          `${code} ${stopKind}`,
        ).toEqual({
          restart: false,
          why: "not_memory",
        });
  });

  it("leaves a memory stop of an export on a chip to the memory rows, which keep the chip", () => {
    const stop = facts({
      failure: { code: "memory_limit", guard: "pc_floor", namesChip: true },
      progress: { producedFraction: 0.05 },
      machine: { freeBytes: 8 * GIB, failedPeakBytes: 1.2 * GIB, limitBytes: 3.5 * GIB },
      attempt: { ladder: [0, 1, 2] },
    });
    expect(decideRestart(stop)).toMatchObject({
      restart: true,
      reason: "memory_short",
      override: { rung: 1 },
    });
    expect(decideRestart(stop)).not.toHaveProperty("override.processor");
  });

  it("makes no failure eligible for two reasons: the table's order is never needed", () => {
    const accepted = new Set<string>();
    for (const code of EXPORT_REASON_CODES)
      for (const guard of [...EXPORT_LIMITS, null])
        for (const stopKind of stops)
          for (const namesChip of [false, true])
            for (const chipMaker of makers) {
              const eligible = eligibleReasons(
                facts({
                  failure: { code, guard, stopKind, namesChip },
                  attempt: { chipMaker, encoder: chipMaker ? `chip-${chipMaker}` : "x264-crf" },
                  progress: { producedFraction: 0.05 },
                  machine: {
                    freeBytes: 8 * GIB,
                    failedPeakBytes: 1.2 * GIB,
                    limitBytes: 3.5 * GIB,
                  },
                }),
              );
              for (const reason of eligible) accepted.add(reason);
              expect(
                eligible.length,
                `${code} / ${guard} / ${stopKind} / ${namesChip} / ${chipMaker}`,
              ).toBeLessThanOrEqual(1);
            }
    expect(accepted.has("chip_failed")).toBe(true); // not vacuous
    expect(accepted.has("memory_short")).toBe(true);
  });
});

describe("what every reason must respect, for the chip's row too", () => {
  const BREAKS: ReadonlyArray<[RestartRefusal, Over]> = [
    ["flag_off", { flags: { auto_restart: false } }],
    ["flag_off", { flags: CHIP_FLAG_OFF }],
    ["cancelled", { request: { aborted: true } }],
    ["second", { request: { autoRestartsUsed: 1 } }],
    ["no_closure", { request: { retryClosureExists: false } }],
    ["edited", { request: { snapshotUnchanged: false } }],
  ];

  it("refuses each broken condition with its own word", () => {
    for (const [why, over] of BREAKS)
      expect(decideRestart(facts(over)), JSON.stringify(over)).toEqual({ restart: false, why });
  });

  it("gives the first refusal in the table's order when several things are wrong at once", () => {
    for (let i = 0; i < BREAKS.length; i++)
      for (let j = i + 1; j < BREAKS.length; j++) {
        const [first, second] = [BREAKS[i], BREAKS[j]];
        const both = facts({
          flags: { ...first[1].flags, ...second[1].flags },
          request: { ...first[1].request, ...second[1].request },
        });
        const expected =
          REFUSAL_ORDER.indexOf(first[0]) <= REFUSAL_ORDER.indexOf(second[0])
            ? first[0]
            : second[0];
        expect(decideRestart(both), `${first[0]} and ${second[0]}`).toEqual({
          restart: false,
          why: expected,
        });
      }
  });

  it("is stopped by its own switch and by the master, and by no other row's switch", () => {
    expect(
      decideRestart(
        facts({ flags: { memory_restart: false, restart_streamed: false, plan_rung: false } }),
      ),
    ).toMatchObject({
      restart: true,
    });
    // and the memory rows are not stopped by the chip's switch
    const stop = facts({
      failure: { code: "memory_limit", guard: "pc_floor" },
      progress: { producedFraction: 0.05 },
      machine: { freeBytes: 8 * GIB, failedPeakBytes: 1.2 * GIB, limitBytes: 3.5 * GIB },
      attempt: { ladder: [0, 1, 2], chipMaker: null, encoder: "x264-crf" },
      flags: CHIP_FLAG_OFF,
    });
    expect(decideRestart(stop)).toMatchObject({ restart: true, reason: "memory_short" });
  });

  it("does not start a second automatic restart, whatever the count says it was or how the failure is spelled", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EXPORT_REASON_CODES),
        fc.constantFrom(...stopsOf()),
        fc.boolean(),
        fc.integer({ min: 1, max: 5 }),
        (code, stopKind, namesChip, used) => {
          const decision = decideRestart(
            facts({ failure: { code, stopKind, namesChip }, request: { autoRestartsUsed: used } }),
          );
          expect(decision.restart).toBe(false);
        },
      ),
    );
  });

  it("answers, and does not throw, for facts that are not facts", () => {
    fc.assert(
      fc.property(fc.anything(), (anything) => {
        expect(() => decideRestart(anything as RestartFacts)).not.toThrow();
        expect(decideRestart(anything as RestartFacts).restart).toBe(false);
      }),
    );
  });
});

function stopsOf(): ReadonlyArray<"idle" | "ceiling" | null> {
  return [null, "idle", "ceiling"];
}
