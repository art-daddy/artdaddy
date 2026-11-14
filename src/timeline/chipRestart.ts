// The graphics chip's reason to start an export again by itself: a row of the one table of automatic restarts (exportRestart.ts).
// A chip that fails an export is the one place a PC with a chip still ends in a failure, so it is started again once, on the processor's
// own encoder, as the same export. The rule is a pure function of the failure's facts: nothing here reads the PC, a switch or a clock.
import type { AutoRestartReason, RestartFacts, RowVerdict } from "./exportRestart";

export const CHIP_RESTART_REASON = "chip_failed";

const refuse = (why: "not_memory" | "no_route"): RowVerdict => ({ eligible: false, why });

/** Which failures a chip explains and a restart on the processor can do better for: a file that failed its check (it arrives at the very
 *  end, so there is no "too late"), a render failure whose own words name the chip's encoder, or a stop by the no-progress rule while the
 *  PC was IDLE (a driver that hangs uses no processor). Never a stop at the busy ceiling (the chip was working, and a restart would
 *  repeat most of that work on a slower encoder), a stop the rule did not make (the deadline), or anything the chip does not explain: a
 *  full disk, a missing source, a refused folder, memory (the memory rows' own). An export that did not run on a chip has none to blame,
 *  so no failure of it is this row's. */
export function chipRestartVerdict(facts: RestartFacts): RowVerdict {
  const { failure, attempt } = facts;
  if (attempt.chipMaker === null) return refuse("not_memory");
  if (failure.code === "time_limit") {
    if (failure.stopKind !== "idle") return refuse("no_route");
  } else if (failure.code === "render_failed" || failure.code === "unknown") {
    if (failure.namesChip !== true) return refuse("not_memory");
  } else if (failure.code !== "verification_failed") return refuse("not_memory");
  return { eligible: true, override: { processor: true } };
}

export const CHIP_RESTART_ROW: AutoRestartReason = {
  reason: CHIP_RESTART_REASON,
  owner: "3c",
  restarted: "processor",
  flag: "chip_restart",
  override: ["processor"],
  trigger: chipRestartVerdict,
  words: {
    gap: "The graphics chip stopped this export. Starting again on the processor…",
    after:
      "Started again on the processor because the graphics chip stopped the first try. It will take longer. Your export settings are kept.",
    // The restart runs on the processor, so what can stop it again is not the chip: the words are the plain ones.
    failedAgain: "Your PC ran short of memory. Close other programs and try again.",
    assistantNote:
      "The app restarted this export once by itself because the graphics chip stopped it. It is the same export (same job_id): do not start another.",
  },
  witnesses: ["C3", "C4", "C5"],
};
