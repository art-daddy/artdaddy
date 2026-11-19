import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EXPORT_REASON_CODES, reasonOfError } from "../api/exportReason";
import { EXPORT_CHIPS, EXPORT_MODE_REASONS } from "../api/exportVocabulary";
import {
  ENCODER_FAILURE_LOG,
  ENCODER_FAILURE_PIECES,
  FAILURE_TEXT_ROWS,
  FAILURE_TEXTS,
  REASONS_WITHOUT_TEXT,
} from "../test/failureTexts";
import { totalExpectation, type Expectation } from "./exportOptions";
import { NO_TIME_LEFT, type TimeLeft } from "./exportTimeLeft";
import { STALL_LOG_SECONDS } from "./exportTrace";
import {
  canSaveElsewhere,
  describeChipFailure,
  describeDialogProgress,
  describeEncoder,
  describeExpected,
  describeExpectedForAssistant,
  describeFailureHere,
  describeLiveStatus,
  describeModeLines,
  describeQuietNote,
  describeResult,
  describeRung,
  describeStage,
  describeStageLine,
  describeTook,
  describeTryAgain,
  describeWaiting,
  expectationForAssistant,
  failureOf,
  ordinal,
  plainFailure,
  QUIET_BUSY_NOTE_SECONDS,
  QUIET_SECONDS,
  quietSeconds,
  SAVE_ELSEWHERE_LINE,
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
// What the rule (exportTimeLeft.ts) publishes for a render with 4 minutes left: 240 s is a figure of its rounding grid, and reads "about 4 min".
const FOUR_MIN: TimeLeft = { kind: "left", seconds: 240 };
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
    expect(describeLiveStatus(live({ timeLeft: FOUR_MIN }), T0 + 20_000)).toBe(
      "Rendering and encoding · 52% · about 4 min left",
    );
  });

  it("says 'still working' with the minutes in once a minute has passed, so the line changes at least every minute", () => {
    expect(
      describeLiveStatus(live({ lastMoveAt: T0 + 170_000, timeLeft: FOUR_MIN }), T0 + 185_000),
    ).toBe("Still working · 3 min in · Rendering and encoding · 52% · about 4 min left");
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

  it("calls a quiet render whose processors are busy 'still working', never 'no progress'; idle or unknown keep today's words", () => {
    const quiet = (busy: boolean | null | undefined) =>
      describeLiveStatus(
        live({ step: 2, steps: 13, fraction: 0.12, lastMoveAt: T0, busy }),
        T0 + 7 * 60_000,
      );
    expect(quiet(true)).toBe(
      "Still working · no new picture for 7 min · Rendering part 3 of 12 · 12%",
    );
    for (const idle of [false, null, undefined])
      expect(quiet(idle)).toBe("No progress for 7 min · Rendering part 3 of 12 · 12%");
    // Under a minute of quiet nothing is said either way, and busy changes nothing there.
    expect(describeLiveStatus(live({ busy: true }), T0 + 20_000)).toBe(
      describeLiveStatus(live({ busy: false }), T0 + 20_000),
    );
  });

  it("adds the grey line only for a render that is busy and has been quiet for five minutes, and promises nothing about the outcome", () => {
    const note = (busy: boolean | null | undefined, quietSeconds: number) =>
      describeQuietNote(live({ lastMoveAt: T0, busy }), T0 + quietSeconds * 1000);
    expect(note(true, QUIET_BUSY_NOTE_SECONDS - 1)).toBeNull();
    expect(note(true, QUIET_BUSY_NOTE_SECONDS)).toBe(
      "The processor is busy on a heavy part. You can cancel at any time.",
    );
    for (const idle of [false, null, undefined]) expect(note(idle, 3600)).toBeNull();
    expect(
      describeQuietNote(live({ stage: "checking", lastMoveAt: T0, busy: true }), T0 + 3600_000),
    ).toBeNull(); // checking the file and saving are not the render standing still
    expect(note(true, 3600)).not.toMatch(/pixel|picture|same|identical|faster/i);
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

  it("says no time left for a feed that carries no answer of the rule, whatever the render's own raw guess, the stage or the silence", () => {
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
          // The raw guess is the banner's and the assistant's projection, not the line's: the line says a time left only for an answer of the rule, and these feeds carry none.
          expect(describeLiveStatus(facts, now)).not.toContain(" left");
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

  it("says a stop at the ceiling of the no-progress rule starts again as it was, whatever setting it ran at, and promises nothing else", () => {
    for (const rung of [undefined, 0, 1, 2] as const)
      for (const last of [0, 1, 2]) {
        const line = describeTryAgain("time_limit", rung, last, true);
        expect(line).toBe("Try again starts it again with the same settings.");
        expect(line).not.toMatch(/gentler|lighter|less memory|faster|quicker/);
      }
    // The ceiling is a stop for time: any other reason keeps saying nothing about it.
    for (const reason of EXPORT_REASON_CODES) {
      if (reason === "memory_limit" || reason === "time_limit") continue;
      expect(describeTryAgain(reason, 0, 2, true)).toBe("");
    }
  });
});

describe("the encoder an export runs on, in words", () => {
  it("says nothing about the processor's normal setting, and what the graphics chip and the faster setting cost about the others", () => {
    expect(describeEncoder("x264", "none")).toBe("");
    for (const chip of ["amd", "nvidia", "intel"] as const) {
      // A job or a report from an app that chose the chip only for long exports still carries this reason: it keeps its own words.
      expect(describeEncoder(chip, "over_minute")).toBe(
        "Using your graphics chip to save time · the file is larger and the picture can differ slightly",
      );
      // Chosen because it passed its test for the picture's size: no saving is claimed, since none was measured.
      expect(describeEncoder(chip, "chip_default")).toBe(
        "Using your graphics chip · the file is larger and the picture can differ slightly",
      );
      // Picked by the person: no need to say why it is used.
      expect(describeEncoder(chip, "person")).toBe(
        "Using your graphics chip · the file is larger and the picture can differ slightly",
      );
    }
    expect(describeEncoder("x264_fast", "promise_line")).toBe(
      "Using light compression to save time · the picture may be slightly softer",
    );
  });

  it("never says anything half-made for a value it does not know", () => {
    for (const odd of [undefined, null, 7, Number.NaN, "x", "gpu", {}])
      expect(describeEncoder(odd as never, "over_minute")).toBe("");
    expect(describeEncoder("amd", undefined as never)).toMatch(/graphics chip/);
  });

  // The rule over the whole vocabulary of reasons (the list the report is cleaned against), so a reason added later is held to it too: only a job that says the chip was chosen for a long export is told it saves time.
  it("says the graphics chip saves time for the reason over_minute alone: every reason of the vocabulary, every maker", () => {
    expect(EXPORT_MODE_REASONS).toContain("chip_default");
    for (const chip of EXPORT_CHIPS)
      for (const reason of EXPORT_MODE_REASONS) {
        const line = describeEncoder(chip, reason);
        expect(line, `${chip} ${reason}`).toMatch(/^Using your graphics chip/);
        expect(line.includes("to save time"), `${chip} ${reason}`).toBe(reason === "over_minute");
      }
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

  // The chip is used whenever it passed, so the row starts on Fast for any length of export and the only thing said about it is what Fast costs; the sentence about a minute is for a decision that carries the old reason.
  it("selects Fast for the person where the chip is chosen for them, whatever the length, and says what Fast costs, never that the export is long", () => {
    for (const [fullSeconds, fastSeconds] of [
      [20, 8],
      [40, 15],
      [720, 240],
      [20, null],
      [null, null],
    ] as const) {
      const lines = describeModeLines(
        row({ defaultMode: "fast", reason: "chip_default", fullSeconds, fastSeconds }),
        null,
      );
      expect(lines.selected, `${fullSeconds}`).toBe("fast");
      expect(lines.note, `${fullSeconds}`).toBe(
        "The file will be larger and the picture can differ slightly from Full quality.",
      );
    }
  });

  it("says the over-a-minute sentence for the reason over_minute alone: every reason of the vocabulary, every start and every pick", () => {
    for (const reason of EXPORT_MODE_REASONS)
      for (const defaultMode of ["quality", "fast"] as const)
        for (const picked of [null, "quality", "fast"] as const) {
          const lines = describeModeLines(
            row({ reason, defaultMode, fullSeconds: 720, fastSeconds: 240 }),
            picked,
          );
          expect(
            /over a minute/.test(lines.note ?? ""),
            JSON.stringify({ reason, defaultMode, picked }),
          ).toBe(reason === "over_minute" && defaultMode === "fast" && picked === null);
        }
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
        fc.constantFrom("over_minute", "person", "promise_line", "none", "chip_default" as const),
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

// The Export dialog and its queue have no Try again button. They say the card's sentence for why an export stopped, and the card's
// sentence for a stop by the graphics chip that says what to do instead of pointing at a button; the text of the failure is not for them to say.
describe("what a place with no Try again button says about a failed export", () => {
  it("is the card's own sentence for every reason a text can be read as, and never the text", () => {
    // the table is every way a text can be read: the states that carry no text are the only reasons it does not have
    expect(EXPORT_REASON_CODES.filter((code) => !(code in FAILURE_TEXTS))).toEqual(
      REASONS_WITHOUT_TEXT,
    );
    for (const [code, text] of FAILURE_TEXT_ROWS) {
      expect(reasonOfError(text), `the text for ${code}`).toBe(code);
      const said = describeFailureHere(text, false);
      expect(said, code).toBe(plainFailure(code));
      // the line the card prints for the same failure
      expect(said, code).toBe(
        describeResult({ state: "failed", filename: "movie.mp4", elapsedMs: 1_000, error: text })
          .detail,
      );
      expect(said, code).not.toContain(text);
    }
    expect(describeFailureHere(undefined, false)).toBe(plainFailure("unknown"));
  });

  it("says nothing of a long log: its own sentence, with none of the log's pieces in it", () => {
    expect(reasonOfError(ENCODER_FAILURE_LOG)).toBe("render_failed");
    expect(ENCODER_FAILURE_LOG.length).toBeGreaterThan(1_000);
    const said = describeFailureHere(ENCODER_FAILURE_LOG, false);
    expect(said).toBe(plainFailure("render_failed"));
    for (const piece of ENCODER_FAILURE_PIECES) expect(said).not.toContain(piece);
  });

  it("is the card's sentence for a place with no Try again once the graphics chip stopped the export, whatever the text says", () => {
    const chip = describeChipFailure("again");
    for (const [code, text] of FAILURE_TEXT_ROWS)
      expect(describeFailureHere(text, true), code).toBe(chip);
    expect(describeFailureHere(undefined, true)).toBe(chip);
    // not the card's own chip sentence, which points at a Try again button this place does not have
    expect(chip).not.toBe(describeChipFailure("card"));
    expect(chip).not.toMatch(/try again/i);
  });

  it("is one of a closed list of sentences for any text at all, with the chip or without it", () => {
    const sentences = new Set<string>([
      ...EXPORT_REASON_CODES.map((code) => plainFailure(code)),
      describeChipFailure("again"),
    ]);
    // noise with the trigger words of every reason inside it, so each way of reading a text is met
    const texts = FAILURE_TEXT_ROWS.map(([, text]) => text);
    const failureText = fc.oneof(
      fc.string({ maxLength: 300 }),
      fc.constantFrom(...texts),
      fc
        .tuple(
          fc.string({ maxLength: 80 }),
          fc.constantFrom(...texts),
          fc.string({ maxLength: 80 }),
        )
        .map((parts) => parts.join("\n")),
    );
    fc.assert(
      fc.property(failureText, fc.boolean(), (text, chipFailed) => {
        expect(sentences.has(describeFailureHere(text, chipFailed))).toBe(true);
      }),
    );
  });
});

describe("Save somewhere else", () => {
  it("is offered after exactly the failures about the place the file was going, and no other", () => {
    const offered = EXPORT_REASON_CODES.filter((code) => canSaveElsewhere(code));
    expect(offered).toEqual(["storage_unavailable", "storage_full"]);
  });

  it("is said in plain words, with no code in them", () => {
    expect(SAVE_ELSEWHERE_LINE).toMatch(/somewhere else/i);
    expect(SAVE_ELSEWHERE_LINE).not.toMatch(
      /ffmpeg|_limit|_failed|_unavailable|_full|undefined|null/i,
    );
    expect(SAVE_ELSEWHERE_LINE.endsWith(".")).toBe(true);
  });

  it("is offered for a failure read off the text of a real one", () => {
    for (const text of ["ENOSPC: no space left on device", "Permission denied", "access is denied"])
      expect(canSaveElsewhere(failureOf(text).code), text).toBe(true);
    for (const text of [
      "Cannot allocate memory",
      "render failed",
      "no such file",
      "execution deadline expired",
    ])
      expect(canSaveElsewhere(failureOf(text).code), text).toBe(false);
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

describe("the stage line", () => {
  it("is the status line without the time left, so a panel that shows the time left on its own side says the stage once", () => {
    expect(describeStageLine(live(), T0 + 20_000)).toBe("Rendering and encoding · 52%");
    expect(describeStageLine(live({ stage: "checking" }), T0 + 185_000)).toBe(
      "Still working · 3 min in · Checking the file",
    );
    expect(describeStageLine(live({ lastMoveAt: T0 }), T0 + 75_000)).toBe(
      "No progress for 75 s · Rendering and encoding · 52%",
    );
    expect(describeStageLine(live({ stage: "queued" }), T0)).toBe("Waiting");
  });

  // The card says the whole line and the dialog says this front part: they can only disagree about an export
  // if this front part is not the front of the line.
  it("is always the front of the status line, whatever the export is doing", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("queued", "preparing", "rendering", "checking", "saving" as const),
        fc.oneof(fc.constant(null), fc.constantFrom(...garbage), fc.double({ min: 0, max: 1 })),
        fc.oneof(
          fc.constant(null),
          fc.constantFrom(...garbage),
          fc.integer({ min: 0, max: 9_999 }),
        ),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 5_000 }),
        (stage, fraction, etaSec, quiet, minutes) => {
          const now = T0 + minutes * 1000;
          const facts = live({ stage, fraction, etaSec, lastMoveAt: now - quiet * 1000 });
          const front = describeStageLine(facts, now);
          const whole = describeLiveStatus(facts, now);
          expect(whole.startsWith(front)).toBe(true);
          // What follows the front is only ever the time left.
          expect(whole.slice(front.length)).toMatch(/^( · .+ left)?$/);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("what an export is expected to take, in words", () => {
  const known = { seconds: 252, guessed: false, finalBytes: 120_000_000 };

  it("says how long and how big, from what this PC has measured", () => {
    expect(describeExpected(known)).toBe(
      "Expected: about 4 min, a file of about 120 MB, from earlier exports on this PC.",
    );
    expect(describeExpected({ ...known, finalBytes: null })).toBe(
      "Expected: about 4 min, from earlier exports on this PC.",
    );
  });

  it("is honest that it is a guess, and claims no size for one", () => {
    expect(describeExpected({ seconds: 30, guessed: true, finalBytes: null })).toBe(
      "Expected: under a minute. A rough guess: nothing like this has been exported on this PC yet.",
    );
    expect(describeExpected({ ...known, guessed: true })).toBe(
      "Expected: about 4 min. A rough guess: nothing like this has been exported on this PC yet.",
    );
  });

  it("says 'in all' for several files and claims no size for one file", () => {
    expect(describeExpected({ ...known, seconds: 360 }, "all")).toBe(
      "Expected: about 6 min in all, from earlier exports on this PC.",
    );
    expect(describeExpected({ ...known, seconds: 360, guessed: true }, "all")).toBe(
      "Expected: about 6 min in all. A rough guess: nothing like this has been exported on this PC yet.",
    );
  });

  it("says nothing when there is no time to say", () => {
    expect(describeExpected(null)).toBe("");
    expect(describeExpected(undefined)).toBe("");
    for (const seconds of [null, Number.NaN, Number.POSITIVE_INFINITY, -1])
      expect(describeExpected({ ...known, seconds })).toBe("");
  });

  it("is a whole sentence or nothing, whatever the numbers are", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.constantFrom(...garbage), fc.double({ min: 0, max: 1e7 })),
        fc.boolean(),
        fc.oneof(fc.constant(null), fc.constantFrom(...garbage), fc.double({ min: 0, max: 1e12 })),
        fc.constantFrom("file", "all" as const),
        (seconds, guessed, finalBytes, scope) => {
          const line = describeExpected({ seconds, guessed, finalBytes }, scope);
          const hasTime = seconds !== null && Number.isFinite(seconds) && seconds >= 0;
          expect(line === "").toBe(!hasTime);
          if (line) {
            expect(line).toMatch(/^Expected: (under a minute|about [^.]+?)( in all)?[,.]/);
            expect(line.endsWith(".")).toBe(true);
            expect(line).not.toMatch(/NaN|undefined|null|Infinity|\[object|-\d/);
            // A guess never names a size, and neither does a total.
            if (guessed || scope === "all") expect(line).not.toMatch(/a file of/);
            expect(line.includes("rough guess")).toBe(guessed);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

// What an assistant is told is what the chat card shows (decision of 19 Nov 2026): a time worked out from this PC's own earlier exports, in the card's
// words, and nothing for a guess from the size of the export: said aloud by an assistant, a guess reads as a promise.
describe("what an assistant is told of how long an export is expected to take", () => {
  const known = { seconds: 252, guessed: false, finalBytes: 120_000_000 };
  const measured = fc.double({ min: 0, max: 1e6, noNaN: true });
  const bytes = fc.oneof(fc.constant(null), fc.double({ min: 0, max: 1e12, noNaN: true }));

  it("is the card's own sentence for a time worked out from this PC's earlier exports", () => {
    expect(describeExpectedForAssistant(known)).toBe(
      "Expected: about 4 min, a file of about 120 MB, from earlier exports on this PC.",
    );
    expect(describeExpectedForAssistant({ ...known, seconds: 360 }, "all")).toBe(
      "Expected: about 6 min in all, from earlier exports on this PC.",
    );
  });

  it("is nothing for a guess, whatever it says and however it is asked", () => {
    expect(describeExpectedForAssistant({ seconds: 30, guessed: true, finalBytes: null })).toBe("");
    expect(describeExpectedForAssistant({ ...known, guessed: true })).toBe("");
    expect(describeExpectedForAssistant({ ...known, seconds: 360, guessed: true }, "all")).toBe("");
  });

  it("is nothing for no expectation, and for one that is not marked as measured", () => {
    expect(describeExpectedForAssistant(null)).toBe("");
    expect(describeExpectedForAssistant(undefined)).toBe("");
    const unmarked = { seconds: 252, finalBytes: null } as unknown as Expectation;
    expect(expectationForAssistant(unmarked)).toBeNull();
    expect(describeExpectedForAssistant(unmarked)).toBe("");
  });

  it("gives back the very expectation when it may be told, and never an edited one", () => {
    expect(expectationForAssistant(known)).toBe(known);
    expect(expectationForAssistant({ ...known, guessed: true })).toBeNull();
    expect(expectationForAssistant(null)).toBeNull();
  });

  it("says what the card says for a measured time and nothing for a guess, for any numbers", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.constantFrom(...garbage), fc.double({ min: 0, max: 1e7 })),
        fc.boolean(),
        fc.oneof(fc.constant(null), fc.constantFrom(...garbage), fc.double({ min: 0, max: 1e12 })),
        fc.constantFrom("file", "all" as const),
        (seconds, guessed, finalBytes, scope) => {
          const told = describeExpectedForAssistant({ seconds, guessed, finalBytes }, scope);
          if (guessed) expect(told).toBe("");
          else expect(told).toBe(describeExpected({ seconds, guessed, finalBytes }, scope));
          // The words of a guess are never in what an assistant is told.
          expect(told).not.toMatch(/rough guess|nothing like this/);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("tells the time of several files in all only when every one of them is measured", () => {
    const part = fc.record({ seconds: measured, guessed: fc.boolean(), finalBytes: bytes });
    fc.assert(
      fc.property(
        fc.array(fc.option(part, { nil: undefined }), { minLength: 0, maxLength: 6 }),
        (parts) => {
          const told = describeExpectedForAssistant(totalExpectation(parts), "all");
          const everyoneMeasured = parts.length > 0 && parts.every((p) => p && !p.guessed);
          if (everyoneMeasured)
            expect(told).toMatch(
              /^Expected: (under a minute|about [^.]+?) in all, from earlier exports on this PC\.$/,
            );
          else expect(told).toBe("");
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("what the Export dialog says about its own export", () => {
  const own = (over: Partial<LiveFacts> = {}, speed = 2.1) => ({ ...live(over), speed });
  // The dialog's own job, which is all it has before its export has an id, and which any export's progress can move. Its answer is another
  // export's ("under a minute left"): a panel that read it for an export with its own feed would say it, so every test below that expects the
  // feed's own words also shows it was the feed that was read.
  const job = {
    phase: "rendering" as const,
    fraction: 0.8,
    timeLeft: { kind: "left", seconds: 30 } as TimeLeft,
    speed: 3,
  };

  it("names the stage of the export's own feed with how far it is, and gives the speed and time left", () => {
    expect(
      describeDialogProgress(
        { own: own({ timeLeft: FOUR_MIN }), place: null, ...job },
        T0 + 20_000,
      ),
    ).toEqual({
      status: "Rendering and encoding · 52%",
      fraction: 0.52,
      speed: 2.1,
      timeLeft: "about 4 min left",
    });
  });

  it("names every stage an export goes through, never a bare percentage", () => {
    const said = (facts: Partial<LiveFacts>) =>
      describeDialogProgress({ own: own(facts), place: null, ...job }, T0 + 20_000).status;
    expect(said({ stage: "preparing", fraction: null })).toBe("Preparing · checking your clips");
    expect(said({ step: 1, steps: 4 })).toBe("Rendering part 2 of 3 · 52%");
    expect(said({ step: 3, steps: 4 })).toBe("Encoding · 52%");
    expect(said({ stage: "checking" })).toBe("Checking the file");
    expect(said({ stage: "saving" })).toBe("Saving");
  });

  it("says it is working, with the minutes in, as the card does, and when the render stops moving", () => {
    const at = (now: number, facts: Partial<LiveFacts> = {}) =>
      describeDialogProgress(
        { own: own({ timeLeft: FOUR_MIN, ...facts }), place: null, ...job },
        now,
      );
    expect(at(T0 + 185_000, { lastMoveAt: T0 + 170_000 }).status).toBe(
      "Still working · 3 min in · Rendering and encoding · 52%",
    );
    const stuck = at(T0 + 90_000);
    expect(stuck.status).toBe("No progress for 90 s · Rendering and encoding · 52%");
    expect(stuck.timeLeft).toBe(""); // no time left is promised for a render that is not moving, whatever the rule last said
    expect(at(T0 + 20_000).timeLeft).toBe("about 4 min left"); // the same feed, while it moves, does say it
  });

  it("gives no speed or time left outside the render", () => {
    for (const stage of ["preparing", "checking", "saving"] as const)
      expect(
        describeDialogProgress(
          { own: own({ stage, timeLeft: FOUR_MIN }), place: null, ...job },
          T0 + 20_000,
        ),
      ).toMatchObject({
        speed: null,
        timeLeft: "",
      });
  });

  // The failure direction: a menu export waiting behind another export is moved by THAT export's progress
  // (the dialog's job is moved by whichever render is running), and must not say it is 80% done.
  it("says it is waiting, and where, for an export that has not had its turn, never another export's percent", () => {
    expect(describeDialogProgress({ own: null, place: 2, ...job }, T0)).toEqual({
      status: "Waiting · 2nd in line",
      fraction: null, // the bar is not 80% either
      speed: null,
      timeLeft: "", // and no time left of the other export
    });
  });

  it("keeps the old words for a job that has no id yet (the moment before its export is admitted)", () => {
    const none = { own: null, place: null } as const;
    const said = (
      phase: "preparing" | "rendering",
      fraction: number | null,
      timeLeft: TimeLeft,
      speed: number,
    ) => describeDialogProgress({ ...none, phase, fraction, timeLeft, speed }, T0);
    expect(said("preparing", null, NO_TIME_LEFT, 0)).toEqual({
      status: "Preparing…",
      fraction: null,
      speed: null,
      timeLeft: "",
    });
    expect(said("rendering", null, NO_TIME_LEFT, 0).status).toBe("Starting…");
    // 120 s is the figure of the rounding grid that a job 90 s from its end is told (the grid has no 90).
    expect(said("rendering", 0.42, { kind: "left", seconds: 120 }, 2)).toEqual({
      status: "42%",
      fraction: 0.42,
      speed: 2,
      timeLeft: "about 2 min left",
    });
  });

  it("is never a half-made sentence, whatever the numbers are", () => {
    // What the job or the feed may hold: the rule's four answers, and what no rule would publish.
    const answers = [
      NO_TIME_LEFT,
      { kind: "left", seconds: 30 },
      FOUR_MIN,
      { kind: "left", seconds: 4500 },
      { kind: "finishing" },
      { kind: "longer" },
      ...garbage.map((seconds) => ({ kind: "left", seconds })),
      { kind: "left", seconds: 90 },
      { kind: "left" },
      { kind: "later" },
      null,
      "left",
    ] as unknown as TimeLeft[];
    for (const fraction of [...garbage, null, 0.5])
      for (const timeLeft of answers)
        for (const speed of [...garbage, 2])
          for (const stage of ["queued", "preparing", "rendering", "checking", "saving"] as const)
            for (const [feed, place] of [
              [own({ stage, fraction, timeLeft, lastMoveAt: T0 + 399_000 }, speed), null],
              [null, 3],
              [null, null],
            ] as const) {
              const said = describeDialogProgress(
                { own: feed, place, phase: "rendering", fraction, timeLeft, speed },
                T0 + 400_000,
              );
              expect(said.status).not.toMatch(/NaN|undefined|null|Infinity|-\d|\[object/);
              expect(said.status.length).toBeGreaterThan(0);
              // The time left is words that are one of the rule's four, or nothing.
              expect(said.timeLeft).toMatch(
                /^(|under a minute left|about \d+ min left|about \d+ h( \d+ min)? left|Finishing|taking longer than expected)$/,
              );
              if (said.speed !== null)
                expect(Number.isFinite(said.speed) && said.speed >= 0).toBe(true);
              if (said.fraction !== null)
                expect(said.fraction >= 0 && said.fraction <= 1).toBe(true);
            }
  });
});
