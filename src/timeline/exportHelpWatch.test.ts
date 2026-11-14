// The slow banner as the queue's watch drives it: the facts it is handed every few seconds, what the person is shown, what Keep going records, and what the
// assistant's export list says about the same export. Played here with the watch's own rhythm and no queue, so every case is a fast, exact one; the journeys through the
// real queue, the card and the dialog are in exportQueue.help3c.test.ts and the component tests.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import recorded from "./__fixtures__/e1RecordedLines.json";
import { __resetFacts3c, factsForReport, factsOf3c } from "./exportFacts3c";
import { MAX_SLOW_BANNERS, SLOW_AFTER_SECONDS, type HelpView } from "./exportHelp";
import {
  __resetHelp3c,
  endHelp3c,
  helpOf3c,
  helpRowOf3c,
  keepGoing3c,
  lowerAdvice3c,
  noteHelpTick3c,
  subscribeHelp3c,
  withLowerAdvice3c,
  type HelpRecordFacts,
} from "./exportHelpWatch";
import type { LiveFacts } from "./exportWords";
import { quickAvailable } from "./quickAvailable";
import {
  ASSISTANT_SLOW_NOTE,
  ASSISTANT_SLOW_NOTE_NO_QUICK,
  KEEP_GOING_ENDED,
  KEEP_GOING_FINISHING,
} from "./routeWords";

vi.mock("./quickAvailable", () => ({ quickAvailable: vi.fn(() => false) }));

const START = 1_700_000_000_000;
const JOB = "job-1";
const TICK = 5;

const record = (over: Partial<HelpRecordFacts> = {}): HelpRecordFacts => ({
  estimate: { seconds: 100, basis: "history" },
  canRetry: true,
  ...over,
});

/** The live feed t seconds into a run whose pace projects `projection` seconds in all: the share done and the render's own time left follow from it,
 *  the way a steady ffmpeg reports them. */
const paced = (t: number, projection: number, over: Partial<LiveFacts> = {}): LiveFacts => ({
  stage: "rendering",
  startedAt: START,
  fraction: Math.min(1, t / projection),
  etaSec: Math.max(0, projection - t),
  step: null,
  steps: null,
  lastMoveAt: START + t * 1000,
  busy: true,
  ...over,
});

function tick(
  t: number,
  feed: LiveFacts | null,
  rec: HelpRecordFacts | undefined = record(),
  extra: { quickSeconds?: number | null } = {},
) {
  noteHelpTick3c(JOB, { record: rec, feed, ...extra }, START + t * 1000);
  return helpOf3c(JOB);
}

/** Every tick of the watch from 5 s to `to`, for a run whose projection at t is `projection(t)`. */
function replay(
  projection: (t: number) => number,
  to: number,
  rec: HelpRecordFacts = record(),
  extra: { quickSeconds?: number | null } = {},
) {
  const seen: Array<{ t: number; kind: string; view: HelpView | null }> = [];
  for (let t = TICK; t <= to; t += TICK) {
    const state = tick(t, paced(t, projection(t)), rec, extra);
    seen.push({ t, kind: state?.view.kind ?? "gone", view: state?.view ?? null });
  }
  return seen;
}

beforeEach(() => {
  vi.mocked(quickAvailable).mockReturnValue(false);
  __resetHelp3c();
  __resetFacts3c();
  __resetExportFlags();
});
afterEach(() => {
  __resetHelp3c();
  __resetFacts3c();
  __resetExportFlags();
});

describe("when the banner shows (B1)", () => {
  it("shows at the first tick that is 90 s in, 2 % done and on course for over three times its estimate, with the copy pack's words", () => {
    const seen = replay(() => 400, 180);
    const first = seen.find((s) => s.kind === "slow");
    expect(first?.t).toBe(SLOW_AFTER_SECONDS);
    expect(seen.filter((s) => s.t < SLOW_AFTER_SECONDS).every((s) => s.kind === "none")).toBe(true);
    expect(seen.filter((s) => s.t >= SLOW_AFTER_SECONDS).every((s) => s.kind === "slow")).toBe(
      true,
    );
    // the projection was over three times the estimate from the very first tick: the banner came within 180 s of that
    expect(first!.t - TICK).toBeLessThanOrEqual(180);
    // 90 s in with a projection of 400 s: 310 s left, against 100 s expected (Quick is not on offer, so it is not mentioned)
    const view = first!.view!;
    expect(view.lines).toEqual([
      "This PC is slower than expected: about 5 min left",
      "It was expected to take about 2 min.",
      "To go faster, cancel, use fewer layers or clips, and export again.",
    ]);
    expect(view.buttons).toEqual(["keep_going", "cancel"]);
    expect(view.projectedTotalSeconds).toBe(400);
  });

  it("waits for the projection to pass three times: a render that is only slow at first is not shown a banner until it is", () => {
    // 2.5 times the estimate for 150 s, then 4.5 times
    const seen = replay((t) => (t < 150 ? 250 : 450), 200);
    expect(seen.find((s) => s.kind === "slow")?.t).toBe(150);
    expect(seen.filter((s) => s.t < 150).every((s) => s.kind === "none")).toBe(true);
  });

  it("waits for 2 % of the project even when the projection is far over: 0.2 % a second against a 10,000 s projection reaches 2 % at 200 s", () => {
    const seen = replay(() => 10_000, 260);
    expect(seen.find((s) => s.kind === "slow")?.t).toBe(200);
    expect(seen.filter((s) => s.t < 200).every((s) => s.kind === "none")).toBe(true);
  });

  it("measures a single-step render by its own time left and a multi-step export by the share of the project produced", () => {
    // single step: 100 s in, half done, the render says 5,000 s left: the projection is 5,100 s whatever the share would say
    tick(100, paced(100, 5100, { fraction: 0.5 }));
    expect(helpOf3c(JOB)!.view.projectedTotalSeconds).toBe(5100);
    __resetHelp3c();
    // multi-step: the card's bar is scaled over twice the project, so 5 % of the bar is 10 % of the project: 100 s in is 1,000 s in all (its own time left is ignored)
    const parts = paced(100, 1000, { fraction: 0.05, etaSec: 5, step: 0, steps: 3 });
    expect(tick(100, parts)!.view.projectedTotalSeconds).toBe(1000);
    expect(helpOf3c(JOB)!.view.kind).toBe("slow");
    // once the final encode has begun the whole project is produced, and nothing is said
    const last = paced(900, 1000, { fraction: 0.9, step: 2, steps: 3 });
    expect(tick(900, last)!.view.kind).toBe("none");
  });

  it("holds a rough guess to 30 minutes and an estimate a PC check or earlier exports stood behind to three times", () => {
    const guess = record({ estimate: { seconds: 100, basis: "guess" } });
    expect(tick(300, paced(300, 1500), guess)!.view.kind).toBe("none");
    expect(tick(305, paced(305, 2000), guess)!.view.kind).toBe("slow");
    __resetHelp3c();
    const checked = record({ estimate: { seconds: 100, basis: "pc_check" } });
    expect(tick(300, paced(300, 1500), checked)!.view.kind).toBe("slow");
    // no estimate at all is held to 30 minutes too, and says nothing of what was expected
    __resetHelp3c();
    const none = record({ estimate: undefined });
    expect(tick(300, paced(300, 1500), none)!.view.kind).toBe("none");
    const view = tick(305, paced(305, 2000), none)!.view;
    expect(view.kind).toBe("slow");
    expect(view.lines.join(" ")).not.toMatch(/was expected/);
  });

  it("reads 0.27.0's own expectation when the new estimate is off: earlier exports are measured, a guess is a guess", () => {
    const history = { expected: { seconds: 100, guessed: false } };
    expect(tick(300, paced(300, 400), history)!.view.kind).toBe("slow");
    __resetHelp3c();
    const guessed = { expected: { seconds: 100, guessed: true } };
    expect(tick(300, paced(300, 400), guessed)!.view.kind).toBe("none");
  });

  it("shows nothing before there is a feed, or for a feed that cannot be read", () => {
    expect(tick(100, null)).toBeNull();
    noteHelpTick3c(
      JOB,
      { record: record(), feed: paced(100, 400, { startedAt: Number.NaN }) },
      START,
    );
    expect(helpOf3c(JOB)?.view.kind ?? "none").toBe("none");
  });
});

describe("no banner on a healthy export (B2)", () => {
  interface Line {
    row: string;
    variant: string;
    profile: string;
    frames: number;
    videoS: number;
    estimate: number;
    measured: number;
  }
  const LINES = recorded.lines as Line[];

  /** One run: `d` seconds before the process starts, `startup` more inside it before the first picture, then steady to `total`. The render's own time left is ffmpeg's: what is
   *  left at the speed since its own start, which is why a long start-up makes the first minutes look far slower than the run turns out to be. */
  const steady =
    (total: number, d: number, startup: number) =>
    (t: number): { fraction: number | null; etaSec: number | null } => {
      const begin = d + startup;
      if (total - begin < 1) return { fraction: null, etaSec: null };
      const share = Math.max(0, Math.min(1, (t - begin) / (total - begin)));
      return share > 0
        ? { fraction: share, etaSec: ((1 - share) / share) * (t - d) }
        : { fraction: null, etaSec: null };
    };
  const SHAPES: Array<{ d: number; startup: number }> = [
    { d: 0, startup: 0 },
    { d: 10, startup: 0 },
    { d: 0, startup: 10 },
    { d: 5, startup: 20 },
    { d: 10, startup: 30 },
  ];

  interface Replayed {
    firstBanner: number | null;
    /** The first tick at which the projection, as the app reads it, was over three times the estimate. */
    firstOver: number | null;
    overBefore90: boolean;
    overWithLittleDone: boolean;
  }
  function play(
    estimate: number,
    total: number,
    shape: { d: number; startup: number },
    basis: "history" | "pc_check" = "history",
    scale = 1,
  ): Replayed {
    __resetHelp3c();
    const at = steady(total, shape.d, shape.startup);
    const rec = record({ estimate: { seconds: estimate * scale, basis } });
    const out: Replayed = {
      firstBanner: null,
      firstOver: null,
      overBefore90: false,
      overWithLittleDone: false,
    };
    for (let t = TICK; t < total; t += TICK) {
      const { fraction, etaSec } = at(t);
      const feed: LiveFacts = {
        stage: fraction === null ? "preparing" : "rendering",
        startedAt: START,
        fraction,
        etaSec,
        step: null,
        steps: null,
        lastMoveAt: START + t * 1000,
        busy: true,
      };
      if (etaSec !== null && fraction !== null && t + etaSec > 3 * estimate * scale) {
        out.firstOver ??= t;
        if (t < SLOW_AFTER_SECONDS && fraction >= 0.02) out.overBefore90 = true;
        if (t >= SLOW_AFTER_SECONDS && fraction < 0.02) out.overWithLittleDone = true;
      }
      if (tick(t, feed, rec)?.view.kind === "slow") out.firstBanner ??= t;
    }
    return out;
  }

  const healthyLines = LINES.filter((line) => line.measured <= 2 * line.estimate);
  /** Long projects whose estimate was right to within 1.8 times, with the start-up each kind of project can have inside ffmpeg: the case the 2 % wait is for (a minute of start-up on a big project makes the share produced tiny for minutes). */
  const longProjects = [
    { estimate: 4000, measured: 7200, startups: [30, 60] },
    { estimate: 1500, measured: 2100, startups: [30] },
    { estimate: 600, measured: 800, startups: [30] },
  ];
  const everyHealthyRun = (): Array<[string, number, number, { d: number; startup: number }]> => [
    ...healthyLines.flatMap((line) =>
      SHAPES.map(
        (shape) =>
          [`${line.row} ${line.variant} ${line.profile}`, line.estimate, line.measured, shape] as [
            string,
            number,
            number,
            { d: number; startup: number },
          ],
      ),
    ),
    ...longProjects.flatMap((line) =>
      line.startups.map(
        (startup) =>
          [`a ${line.measured} s project`, line.estimate, line.measured, { d: 5, startup }] as [
            string,
            number,
            number,
            { d: number; startup: number },
          ],
      ),
    ),
  ];

  it("never shows one on any recorded run that finished within twice its estimate, whatever shape its start-up took, and the same for long projects", () => {
    const runs = everyHealthyRun();
    expect(runs.length).toBeGreaterThan(100);
    for (const [name, estimate, total, shape] of runs)
      for (const basis of ["history", "pc_check"] as const)
        expect(
          play(estimate, total, shape, basis).firstBanner,
          `${name} ${JSON.stringify(shape)}`,
        ).toBeNull();
  });

  it("has runs in it that the 90 s wait is for: healthy runs whose projection is over three times the estimate before 90 s, with the project 2 % done", () => {
    const early = everyHealthyRun().filter(
      ([, estimate, total, shape]) => play(estimate, total, shape).overBefore90,
    );
    expect(early.length).toBeGreaterThan(0);
  });

  it("has runs in it that the 2 % wait is for: healthy runs that are over three times the estimate after 90 s with less than 2 % produced", () => {
    const quiet = everyHealthyRun().filter(
      ([, estimate, total, shape]) => play(estimate, total, shape).overWithLittleDone,
    );
    expect(quiet.length).toBeGreaterThan(0);
  });

  it("would show one on that corpus if the line were 1.5 times the estimate: the corpus can tell a rule that is too eager", () => {
    // 1.5 times is three times against an estimate half the size
    const eager = everyHealthyRun().filter(
      ([, estimate, total, shape]) =>
        play(estimate, total, shape, "history", 0.5).firstBanner !== null,
    );
    expect(eager.length).toBeGreaterThan(0);
  });

  it("does show one, within 180 s of the projection passing three times, on every recorded run that was far over its estimate and long enough to say so", () => {
    const far = LINES.filter((line) => line.measured > 3.5 * line.estimate && line.measured >= 150);
    expect(far.length).toBeGreaterThan(5);
    for (const line of far) {
      const run = play(line.estimate, line.measured, { d: 0, startup: 0 });
      expect(run.firstBanner, `${line.row} ${line.profile}`).not.toBeNull();
      expect(run.firstBanner!).toBeGreaterThanOrEqual(SLOW_AFTER_SECONDS);
      expect(run.firstBanner! - run.firstOver!).toBeLessThanOrEqual(180);
    }
  });

  it("names its limit: a run that finishes at 1.4 times its estimate but spends a minute inside the process before its first picture is over three times by the time 2 % is made, and is shown the banner", () => {
    // 1,500 s said, 2,100 s taken, 60 s of start-up inside ffmpeg: ffmpeg's own time left counts that minute at every second after it, which at the first look after 2 %
    // makes the projection about 4,800 s against 4,500 s allowed. Nothing in the 90 s, 2 % and three-times rules can tell this from a slow run.
    const run = play(1500, 2100, { d: 5, startup: 60 });
    expect(run.firstBanner).toBe(110);
    // the same run with half the start-up is quiet
    expect(play(1500, 2100, { d: 5, startup: 30 }).firstBanner).toBeNull();
  });
});

describe("Keep going and the limit of two (B3)", () => {
  // 4 times the estimate, then 10 times, then 25 times
  const projection = (t: number) => (t < 200 ? 400 : t < 400 ? 1000 : 2500);

  it("is silenced until the projection doubles, shown once more, and never shown a third time", () => {
    const kinds = (from: number, to: number) => {
      const out: string[] = [];
      for (let t = from; t <= to; t += TICK) out.push(tick(t, paced(t, projection(t)))!.view.kind);
      return out;
    };
    expect(kinds(5, 90).at(-1)).toBe("slow");
    expect(keepGoing3c(JOB, "slow", "rendering")).toEqual({ ok: true });
    // 400 s projected when it was answered: nothing until 800 s
    expect(new Set(kinds(95, 195))).toEqual(new Set(["none"]));
    expect(helpOf3c(JOB)!.keptGoing).toBe(true);
    // the projection is 1,000 s from 200 s: more than double, so a second banner
    expect(kinds(200, 200)).toEqual(["slow"]);
    expect(keepGoing3c(JOB, "slow", "rendering")).toEqual({ ok: true });
    expect(new Set(kinds(205, 395))).toEqual(new Set(["none"]));
    // 2,500 s is more than double again, and it is a third time: never
    expect(MAX_SLOW_BANNERS).toBe(2);
    expect(new Set(kinds(400, 700))).toEqual(new Set(["none"]));
  });

  it("counts a banner once however many times Keep going is pressed on it", () => {
    for (let t = 5; t <= 90; t += TICK) tick(t, paced(t, projection(t)));
    expect(keepGoing3c(JOB, "slow", "rendering")).toEqual({ ok: true });
    expect(keepGoing3c(JOB, "slow", "rendering")).toEqual({ ok: true });
    expect(keepGoing3c(JOB, "slow", "rendering")).toEqual({ ok: true });
    // two extra presses did not use up the second banner
    for (let t = 95; t <= 195; t += TICK) tick(t, paced(t, projection(t)));
    expect(tick(200, paced(200, projection(200)))!.view.kind).toBe("slow");
  });

  it("answers a press on a banner that has gone by itself with nothing: the projection fell back before the click", () => {
    for (let t = 5; t <= 90; t += TICK) tick(t, paced(t, 400));
    expect(tick(95, paced(95, 250))!.view.kind).toBe("none");
    expect(keepGoing3c(JOB, "slow", "rendering")).toEqual({ ok: true });
    // not counted as an answer: the next time it is over three times it still shows
    expect(helpOf3c(JOB)!.keptGoing).toBe(false);
    expect(tick(100, paced(100, 450))!.view.kind).toBe("slow");
  });
});

describe("the click as the export ends (B5)", () => {
  it("refuses Keep going on a finishing or a finished export with a line, and leaves nothing behind", () => {
    for (let t = 5; t <= 90; t += TICK) tick(t, paced(t, 400));
    const before = helpOf3c(JOB);
    expect(keepGoing3c(JOB, "slow", "finishing")).toEqual({
      ok: false,
      line: KEEP_GOING_FINISHING,
    });
    // nothing was recorded: the banner is the first one still, and it was not answered
    expect(helpOf3c(JOB)).toEqual(before);
    expect(helpOf3c(JOB)).toMatchObject({ view: { kind: "slow" }, keptGoing: false });
    endHelp3c(JOB);
    expect(helpOf3c(JOB)).toBeNull();
    expect(keepGoing3c(JOB, "slow", "ended")).toEqual({ ok: false, line: KEEP_GOING_ENDED });
    // a click after the end made no state for an export that is gone
    expect(helpOf3c(JOB)).toBeNull();
    expect(KEEP_GOING_FINISHING).not.toBe(KEEP_GOING_ENDED);
  });

  it("takes the click that comes before the end, and the end then forgets it", () => {
    for (let t = 5; t <= 90; t += TICK) tick(t, paced(t, 400));
    expect(keepGoing3c(JOB, "slow", "rendering")).toEqual({ ok: true });
    expect(helpOf3c(JOB)!.keptGoing).toBe(true);
    endHelp3c(JOB);
    expect(helpOf3c(JOB)).toBeNull();
    expect(helpRowOf3c(JOB)).toBeNull();
  });
});

describe("with the verdict of the stall rule (B6)", () => {
  const quiet = (t: number, secondsQuiet: number, busy: boolean | null) =>
    paced(t, 100, {
      fraction: 0.4,
      etaSec: 60,
      lastMoveAt: START + (t - secondsQuiet) * 1000,
      busy,
    });

  it("says nothing of its own for a quiet render whose processors are busy: the card keeps its own Still working", () => {
    const state = tick(200, quiet(200, 120, true))!;
    expect(state.view.kind).toBe("none");
    expect(state.keptGoing).toBe(false);
  });

  it("says it has stopped moving for a quiet render whose processors are idle, with the stop it will meet, and without Quick", () => {
    const view = tick(200, quiet(200, 75, false))!.view;
    expect(view.kind).toBe("quiet");
    expect(view.lines).toEqual([
      "This export has stopped moving",
      "No progress for 75 s.",
      "ArtDaddy stops it if nothing moves for 3 minutes.",
    ]);
    expect(view.buttons).toEqual(["keep_going", "cancel"]);
  });

  it("says it has stopped moving, without the stop, when what the processors are doing cannot be read", () => {
    const view = tick(200, quiet(200, 75, null))!.view;
    expect(view.kind).toBe("quiet");
    expect(view.lines).toEqual(["This export has stopped moving", "No progress for 75 s."]);
  });

  it("waits for a minute of silence, and goes when the render moves again", () => {
    expect(tick(200, quiet(200, 59, false))!.view.kind).toBe("none");
    expect(tick(205, quiet(205, 60, false))!.view.kind).toBe("quiet");
    expect(tick(210, paced(210, 100, { busy: false }))!.view.kind).toBe("none");
  });

  it("is answered once with Keep going, and the stop it spoke of still stands: the banner does not come back", () => {
    expect(tick(200, quiet(200, 75, false))!.view.kind).toBe("quiet");
    expect(keepGoing3c(JOB, "quiet", "rendering")).toEqual({ ok: true });
    expect(tick(205, quiet(205, 80, false))!.view.kind).toBe("none");
    expect(helpOf3c(JOB)!.keptGoing).toBe(true);
  });

  it("is not the slow banner: a stopped render is not told how long is left, and the assistant's row does not call it slow", () => {
    tick(200, quiet(200, 75, false));
    expect(helpRowOf3c(JOB)).toBeNull();
  });
});

describe("the switch for the help (S2): read at every look, never remembered", () => {
  it("shows nothing at all from the first tick with the switch off", () => {
    __setExportFlag("export_help", false);
    for (let t = 5; t <= 200; t += TICK) expect(tick(t, paced(t, 400))!.view.kind).toBe("none");
    expect(helpRowOf3c(JOB)).toBeNull();
    expect(factsOf3c(JOB)?.help_shown).toBeUndefined();
    expect(lowerAdvice3c("memory_limit", false)).toBe("");
    expect(withLowerAdvice3c("Your PC ran short of memory.", "memory_limit", false)).toBe(
      "Your PC ran short of memory.",
    );
  });

  it("takes a flip in the middle of a run at once, and brings the banner back when the switch comes back", () => {
    for (let t = 5; t <= 90; t += TICK) tick(t, paced(t, 400));
    expect(helpOf3c(JOB)!.view.kind).toBe("slow");
    expect(helpRowOf3c(JOB)).not.toBeNull();
    __setExportFlag("export_help", false);
    // before the next tick: the look itself reads the switch
    expect(helpOf3c(JOB)!.view.kind).toBe("none");
    expect(helpRowOf3c(JOB)).toBeNull();
    expect(tick(95, paced(95, 400))!.view.kind).toBe("none");
    __setExportFlag("export_help", true);
    expect(helpOf3c(JOB)!.view.kind).toBe("slow");
  });

  it("leaves the advice off with the switch off, and on with it on", () => {
    expect(lowerAdvice3c("memory_limit", false)).toBe(
      "To use less memory, lower the picture size or frame rate, or export a shorter section.",
    );
    __setExportFlag("export_help", false);
    expect(lowerAdvice3c("memory_limit", false)).toBe("");
    expect(lowerAdvice3c("time_limit", false)).toBe("");
    expect(lowerAdvice3c("render_failed", true)).toBe("");
  });
});

describe("what is said about it afterwards", () => {
  it("notes `slow` once when the slow banner is first up and `quiet` once for the stopped-moving one, as a local record and nothing sent", () => {
    for (let t = 5; t <= 120; t += TICK) tick(t, paced(t, 400));
    expect(factsOf3c(JOB)?.help_shown).toEqual(["slow"]);
    const stopped = paced(300, 100, { fraction: 0.4, lastMoveAt: START + 200_000, busy: false });
    tick(300, stopped);
    tick(305, { ...stopped });
    expect(factsOf3c(JOB)?.help_shown).toEqual(["slow", "quiet"]);
    expect(factsForReport(JOB)).toBeUndefined();
  });

  it("notes nothing for a healthy run", () => {
    for (let t = 5; t <= 200; t += TICK) tick(t, paced(t, 190));
    expect(factsOf3c(JOB)).toBeUndefined();
  });

  it("tells the assistant the two facts and what to do with them, and only while the export is slower than said", () => {
    for (let t = 5; t <= 90; t += TICK) tick(t, paced(t, 400));
    expect(helpRowOf3c(JOB)).toEqual({
      fields: { slower_than_expected: true, projected_total_s: 400 },
      note: ASSISTANT_SLOW_NOTE_NO_QUICK,
    });
    expect(ASSISTANT_SLOW_NOTE_NO_QUICK).toBe(
      "This export is running slower than expected. Tell the person how long is left. Do not cancel it and start another.",
    );
    // silenced for the person, still true for the assistant
    expect(keepGoing3c(JOB, "slow", "rendering")).toEqual({ ok: true });
    expect(helpOf3c(JOB)!.view.kind).toBe("none");
    expect(helpRowOf3c(JOB)?.fields).toEqual({
      slower_than_expected: true,
      projected_total_s: 400,
    });
    // and gone when the export is no longer slower than said
    tick(95, paced(95, 250));
    expect(helpRowOf3c(JOB)).toBeNull();
  });

  it("names no Quick anywhere while Quick is not on offer: not in the lines, the buttons, the fields or the note", () => {
    for (let t = 5; t <= 90; t += TICK)
      tick(t, paced(t, 1200), record({ estimate: { seconds: 300, basis: "history" } }), {
        quickSeconds: 600,
      });
    const state = helpOf3c(JOB)!;
    expect(state.view.buttons).not.toContain("switch_to_quick");
    // what the person and the assistant are TOLD: the lines, the buttons, the names of the fields and the note
    const row = helpRowOf3c(JOB)!;
    expect(
      JSON.stringify([state.view.lines, state.view.buttons, Object.keys(row.fields), row.note]),
    ).not.toMatch(/quick/i);
  });
});

describe("with Quick on offer (the route side, once it is merged)", () => {
  beforeEach(() => vi.mocked(quickAvailable).mockReturnValue(true));
  const estimate = record({ estimate: { seconds: 300, basis: "history" } });
  const to90 = (quickSeconds: number | null | undefined, rec = estimate) => {
    for (let t = 5; t <= 90; t += TICK) tick(t, paced(t, 1200), rec, { quickSeconds });
    return helpOf3c(JOB)!;
  };

  it("offers Switch to Quick, in the copy pack's words, when Quick finishes at least 40 % sooner than what is left, and says so to the assistant", () => {
    // 90 s in, 1,110 s left: Quick at 600 s is 46 % sooner
    const state = to90(600);
    expect(state.view.lines).toEqual([
      "This PC is slower than expected: about 19 min left",
      "It was expected to take about 5 min.",
      "Quick export would take about 10 min, starting over.",
    ]);
    expect(state.view.buttons).toEqual(["switch_to_quick", "keep_going", "cancel"]);
    expect(helpRowOf3c(JOB)).toEqual({
      fields: {
        slower_than_expected: true,
        projected_total_s: 1200,
        quick_available: true,
        quick_expected_s: 600,
      },
      note: ASSISTANT_SLOW_NOTE,
    });
  });

  it("says Quick would not help, and offers no button, when it is not 40 % sooner", () => {
    const state = to90(900);
    expect(state.view.lines).toEqual([
      "This PC is slower than expected: about 19 min left",
      "It was expected to take about 5 min.",
      "Quick export would not be much faster than what is left. To go faster, cancel, use fewer layers or clips, and export again.",
    ]);
    expect(state.view.buttons).toEqual(["keep_going", "cancel"]);
    expect(helpRowOf3c(JOB)?.fields).toEqual({
      slower_than_expected: true,
      projected_total_s: 1200,
    });
  });

  it("offers nothing about Quick for an export that cannot be started again, or when Quick has no estimate", () => {
    const cases: Array<[string, HelpRecordFacts, number | null | undefined]> = [
      ["cannot be started again", record({ canRetry: false, estimate: estimate.estimate }), 600],
      ["no estimate (null)", estimate, null],
      ["no estimate (absent)", estimate, undefined],
    ];
    for (const [name, rec, quickSeconds] of cases) {
      __resetHelp3c();
      const state = to90(quickSeconds, rec);
      expect(state.view.buttons, name).toEqual(["keep_going", "cancel"]);
      expect(state.view.lines.join(" "), name).not.toMatch(/Quick/);
    }
  });

  it("says Quick in the advice for a slow failure and a chip failure, and not for a memory failure", () => {
    expect(lowerAdvice3c("time_limit", false)).toBe(
      "On this PC a lower picture size or frame rate, a shorter section, or Quick export is faster.",
    );
    expect(lowerAdvice3c("render_failed", true)).toBe(
      "To make that shorter, lower the picture size or frame rate, or use Quick export.",
    );
    expect(lowerAdvice3c("memory_limit", false)).not.toMatch(/quick/i);
  });
});

describe("the advice's own door, with Quick not on offer", () => {
  it("never names Quick: not for a slow failure, not for a chip failure, whatever the codes", () => {
    expect(lowerAdvice3c("time_limit", false)).toBe(
      "On this PC a lower picture size or frame rate, or a shorter section, is faster.",
    );
    expect(lowerAdvice3c("render_failed", true)).toBe(
      "To make that shorter, lower the picture size or frame rate.",
    );
    for (const code of ["memory_limit", "time_limit", "unknown", "render_failed"] as const)
      for (const chip of [true, false]) expect(lowerAdvice3c(code, chip)).not.toMatch(/quick/i);
  });

  it("adds its sentence after 0.27.0's, and leaves a failure it has nothing to say about exactly as it was", () => {
    expect(
      withLowerAdvice3c(
        "Your PC ran short of memory. Close other programs and try again.",
        "memory_limit",
        false,
      ),
    ).toBe(
      "Your PC ran short of memory. Close other programs and try again. To use less memory, lower the picture size or frame rate, or export a shorter section.",
    );
    for (const code of [
      "storage_full",
      "source_unavailable",
      "verification_failed",
      "unknown",
      "interrupted",
    ] as const)
      expect(withLowerAdvice3c("As it was.", code, false)).toBe("As it was.");
  });

  it("is only a door: it never throws", () => {
    expect(() => lowerAdvice3c(undefined as never, undefined)).not.toThrow();
    expect(lowerAdvice3c(undefined as never, undefined)).toBe("");
    expect(withLowerAdvice3c(undefined as never, "memory_limit", false)).toEqual(
      expect.any(String),
    );
  });
});

describe("what it holds, and what it tells", () => {
  it("tells whoever is watching when what is on screen changes, and not when a tick changes nothing", () => {
    const heard = vi.fn();
    const stop = subscribeHelp3c(heard);
    for (let t = 5; t < 90; t += TICK) tick(t, paced(t, 190));
    expect(heard).not.toHaveBeenCalled();
    tick(90, paced(90, 400));
    expect(heard).toHaveBeenCalledTimes(1);
    // the next tick of the same banner may word its numbers a little differently; what matters is that a repeat of the same tick says nothing
    tick(95, paced(95, 400));
    const calls = heard.mock.calls.length;
    tick(95, paced(95, 400));
    expect(heard.mock.calls.length).toBe(calls);
    keepGoing3c(JOB, "slow", "rendering");
    expect(heard.mock.calls.length).toBeGreaterThan(calls);
    stop();
    const after = heard.mock.calls.length;
    endHelp3c(JOB);
    expect(heard.mock.calls.length).toBe(after);
  });

  it("is not stopped by a listener that throws", () => {
    const quiet = vi.fn();
    subscribeHelp3c(() => {
      throw new Error("a render that threw");
    });
    subscribeHelp3c(quiet);
    expect(() => {
      for (let t = 5; t <= 90; t += TICK) tick(t, paced(t, 400));
    }).not.toThrow();
    expect(quiet).toHaveBeenCalled();
  });

  it("keeps one entry per running export and none after the render ends", () => {
    noteHelpTick3c("a", { record: record(), feed: paced(100, 400) }, START + 100_000);
    noteHelpTick3c("b", { record: record(), feed: paced(100, 400) }, START + 100_000);
    expect(helpOf3c("a")).not.toBeNull();
    endHelp3c("a");
    expect(helpOf3c("a")).toBeNull();
    expect(helpOf3c("b")).not.toBeNull();
    endHelp3c("a");
    endHelp3c("never-was");
    expect(helpOf3c("b")).not.toBeNull();
  });

  it("never throws and never shows a number that is not one, whatever the watch hands it", () => {
    const wild = fc.oneof(
      fc.double({ noNaN: false }),
      fc.integer(),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 1e300),
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
    );
    fc.assert(
      fc.property(
        fc.record({
          stage: fc.constantFrom("queued", "preparing", "rendering", "checking", "saving", "odd"),
          fraction: wild,
          etaSec: wild,
          step: wild,
          steps: wild,
          lastMoveAt: wild,
          busy: fc.constantFrom(true, false, null, undefined),
          startedAt: wild,
        }),
        fc.record(
          {
            expected: fc.record({ seconds: wild, guessed: fc.boolean() }),
            estimate: fc.record({
              seconds: wild,
              basis: fc.constantFrom("pc_check", "history", "guess", "odd"),
            }),
            canRetry: fc.boolean(),
          },
          { requiredKeys: [] },
        ),
        wild,
        (feed, rec, now) => {
          __resetHelp3c();
          noteHelpTick3c(JOB, { record: rec as never, feed: feed as never }, now as never);
          const state = helpOf3c(JOB);
          if (state === null) return;
          expect(["none", "slow", "quiet"]).toContain(state.view.kind);
          for (const line of state.view.lines)
            expect(line).not.toMatch(/NaN|Infinity|undefined|null|\[object/);
          const row = helpRowOf3c(JOB);
          if (row) {
            expect(Number.isInteger(row.fields.projected_total_s ?? 0)).toBe(true);
            expect(
              (row.fields.projected_total_s as number | undefined) ?? 0,
            ).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 300 },
    );
    expect(() => noteHelpTick3c(undefined as never, undefined as never)).not.toThrow();
    expect(() => keepGoing3c(undefined as never, "slow", "rendering")).not.toThrow();
  });
});
