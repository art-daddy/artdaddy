// What a person is told about the time left of a running export. The rule (exportTimeLeft.ts) publishes one answer per export run: nothing yet, a figure
// of its rounding grid, "finishing", or "taking longer than expected". The words place decides what of that may be said right now (the stage, a render that
// went quiet, the parts of a render made in parts, an answer that is not one the rule gives) and says it; the chat card's line and the Export dialog's
// right side both read it. Each test asserts the words a person reads, and the rules that hold whatever the feed holds.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { describeExportTime } from "./exportOptions";
import { IMPLAUSIBLE_SECONDS, NO_TIME_LEFT, roundTimeLeft, type TimeLeft } from "./exportTimeLeft";
import {
  describeDialogProgress,
  describeLiveStatus,
  describeStage,
  describeStageLine,
  describeTimeLeft,
  QUIET_SECONDS,
  shownTimeLeftSeconds,
  timeLeftNow,
  type LiveFacts,
} from "./exportWords";

const NOW = 9_000_000;
const left = (seconds: number): TimeLeft => ({ kind: "left", seconds });
const FINISHING: TimeLeft = { kind: "finishing" };
const LONGER: TimeLeft = { kind: "longer" };
const STAGES = ["queued", "preparing", "rendering", "checking", "saving"] as const;

// A render that made a picture a second ago, 40 % made, with 4 minutes left by the rule. Its raw pace (`etaSec`, 5 s left) is a decoy: the words never use it.
const feed = (over: Partial<LiveFacts> = {}): LiveFacts => ({
  stage: "rendering",
  startedAt: NOW - 30_000,
  fraction: 0.4,
  etaSec: 5,
  step: null,
  steps: null,
  lastMoveAt: NOW - 1_000,
  timeLeft: left(240),
  ...over,
});
// What the dialog has besides the export's own feed: its own job's numbers, which another export's progress can move. The job's answer here is another
// export's ("under a minute left"), so a panel that read it for an export with a feed would say it.
const view = (own: LiveFacts | null, over: Record<string, unknown> = {}) => ({
  own: own && { ...own, speed: 2.1 },
  place: null,
  phase: "rendering" as const,
  fraction: 0.8,
  timeLeft: left(30),
  speed: 3,
  ...over,
});
// The words that end a line that says something about the time left, and what no line may ever contain.
const TIME_PHRASE = /(under a minute left|about [^·]+ left|Finishing|taking longer than expected)$/;
const HALF_MADE = /NaN|undefined|null|Infinity|-\d|\[object/;

describe("the time left, in words", () => {
  it.each([
    [30, "under a minute left"],
    [60, "about 1 min left"],
    [240, "about 4 min left"],
    [600, "about 10 min left"],
    [900, "about 15 min left"],
    [3600, "about 1 h left"],
    [4500, "about 1 h 15 min left"],
  ])("says a figure of %i s as '%s', on the card and in the dialog", (seconds, words) => {
    expect(describeTimeLeft(left(seconds))).toBe(words);
    const facts = feed({ timeLeft: left(seconds) });
    expect(describeLiveStatus(facts, NOW)).toBe(`Rendering and encoding · 40% · ${words}`);
    expect(describeDialogProgress(view(facts), NOW).timeLeft).toBe(words);
  });

  it("says the other answers in their own words, and nothing for none", () => {
    expect(describeTimeLeft(FINISHING)).toBe("Finishing");
    expect(describeTimeLeft(LONGER)).toBe("taking longer than expected");
    expect(describeTimeLeft(NO_TIME_LEFT)).toBe("");
  });

  it("is the card's line after its front, and the dialog's right side, in the same words for the same feed at the same moment", () => {
    const cases: Array<[TimeLeft, string]> = [
      [left(240), "about 4 min left"],
      [FINISHING, "Finishing"],
      [LONGER, "taking longer than expected"],
      [NO_TIME_LEFT, ""],
    ];
    for (const [answer, words] of cases) {
      const facts = feed({ timeLeft: answer });
      const front = describeStageLine(facts, NOW);
      expect(front).toBe("Rendering and encoding · 40%");
      expect(describeLiveStatus(facts, NOW)).toBe(words ? `${front} · ${words}` : front);
      expect(describeDialogProgress(view(facts), NOW)).toMatchObject({
        status: front,
        timeLeft: words,
      });
    }
  });

  it("is what the feed's own rule says, never the raw pace and never another export's answer", () => {
    // A raw pace of 5 s left, an answer of none: nothing is said.
    expect(describeLiveStatus(feed({ timeLeft: NO_TIME_LEFT }), NOW)).toBe(
      "Rendering and encoding · 40%",
    );
    // A feed with no field for an answer at all (a hand-built one): nothing is said either.
    expect(describeLiveStatus(feed({ timeLeft: undefined }), NOW)).toBe(
      "Rendering and encoding · 40%",
    );
    // The dialog's own job says "under a minute left", the export's feed says 4 minutes: the feed is read.
    expect(describeDialogProgress(view(feed()), NOW).timeLeft).toBe("about 4 min left");
    // Only without a feed is the job read, and then in the same words.
    expect(describeDialogProgress(view(null), NOW).timeLeft).toBe("under a minute left");
  });
});

describe("the stage rule: the time left is said only while the render is under way", () => {
  const stored: Array<[TimeLeft, string]> = [
    [left(240), "about 4 min left"],
    [FINISHING, "Finishing"],
    [LONGER, "taking longer than expected"],
  ];

  it("says nothing while the export waits, is prepared, or its file is checked or saved, even with an answer stored", () => {
    for (const [answer, words] of stored) {
      // The same feed in the render says it: what makes the silence below mean something.
      expect(describeLiveStatus(feed({ timeLeft: answer }), NOW).endsWith(` · ${words}`)).toBe(
        true,
      );
      for (const stage of ["queued", "preparing", "checking", "saving"] as const) {
        const facts = feed({ stage, timeLeft: answer });
        expect(timeLeftNow(facts, NOW), stage).toEqual(NO_TIME_LEFT);
        expect(shownTimeLeftSeconds(facts, NOW), stage).toBeNull();
        expect(describeLiveStatus(facts, NOW), stage).not.toMatch(TIME_PHRASE);
        expect(describeDialogProgress(view(facts), NOW).timeLeft, stage).toBe("");
      }
    }
  });

  it("does not read the dialog's own job as saying anything outside the render either", () => {
    const job = (phase: "preparing" | "rendering", timeLeft: TimeLeft) =>
      describeDialogProgress(view(null, { phase, timeLeft }), NOW).timeLeft;
    expect(job("preparing", left(240))).toBe("");
    expect(job("rendering", left(240))).toBe("about 4 min left");
    expect(job("rendering", FINISHING)).toBe("Finishing");
    expect(job("rendering", LONGER)).toBe("taking longer than expected");
    // An export waiting in line says its place and none of another export's time.
    expect(describeDialogProgress(view(null, { place: 2 }), NOW).timeLeft).toBe("");
  });
});

describe("the quiet rule: a render that made no new picture for a minute is not told how long is left", () => {
  const answers: TimeLeft[] = [left(240), FINISHING, LONGER];

  it("does not say a stored answer once the silence reaches a minute, and says it again when a picture arrives", () => {
    for (const answer of answers) {
      const quietFor = (seconds: number) =>
        feed({ timeLeft: answer, lastMoveAt: NOW - seconds * 1000 });
      expect(timeLeftNow(quietFor(QUIET_SECONDS - 1), NOW)).toEqual(answer);
      for (const seconds of [QUIET_SECONDS, QUIET_SECONDS + 1, 600, 86_400]) {
        const facts = quietFor(seconds);
        expect(timeLeftNow(facts, NOW), `${seconds} s`).toEqual(NO_TIME_LEFT);
        expect(shownTimeLeftSeconds(facts, NOW)).toBeNull();
        expect(describeLiveStatus(facts, NOW)).not.toMatch(TIME_PHRASE);
        expect(describeDialogProgress(view(facts), NOW).timeLeft).toBe("");
      }
      // The render made a picture just now.
      expect(timeLeftNow(feed({ timeLeft: answer, lastMoveAt: NOW }), NOW)).toEqual(answer);
    }
  });

  it("is said exactly while the silence is under a minute, whatever the clock says (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7200 }), (seconds) => {
        const said = timeLeftNow(feed({ lastMoveAt: NOW - seconds * 1000 }), NOW).kind === "left";
        expect(said).toBe(seconds < QUIET_SECONDS);
      }),
      { numRuns: 300 },
    );
  });
});

describe("a render made in parts: only its final encode has a time left to say", () => {
  it("says nothing at a part before the last, and the stored answer at the last", () => {
    const answers: Array<[TimeLeft, string]> = [
      [left(240), "about 4 min left"],
      [FINISHING, "Finishing"],
      [LONGER, "taking longer than expected"],
    ];
    for (const [answer, words] of answers) {
      for (const [step, steps] of [
        [0, 2],
        [0, 3],
        [1, 3],
        [0, 13],
        [11, 13],
      ] as const) {
        const facts = feed({ step, steps, timeLeft: answer });
        expect(timeLeftNow(facts, NOW), `part ${step} of ${steps}`).toEqual(NO_TIME_LEFT);
        expect(shownTimeLeftSeconds(facts, NOW)).toBeNull();
        expect(describeLiveStatus(facts, NOW)).not.toMatch(TIME_PHRASE);
        expect(describeDialogProgress(view(facts), NOW).timeLeft).toBe("");
      }
      for (const [step, steps] of [
        [1, 2],
        [2, 3],
        [12, 13],
      ] as const) {
        const facts = feed({ step, steps, timeLeft: answer });
        expect(timeLeftNow(facts, NOW), `part ${step} of ${steps}`).toEqual(answer);
        expect(describeLiveStatus(facts, NOW).endsWith(` · ${words}`)).toBe(true);
        expect(describeDialogProgress(view(facts), NOW).timeLeft).toBe(words);
      }
    }
  });

  it("is a normal render when there is one step, or the numbers cannot be a part of a render", () => {
    const odd: Array<[number | null, number | null]> = [
      [null, null],
      [0, 1],
      [0, 0],
      [0, -3],
      [-1, 5],
      [5, 5],
      [99, 5],
      [1.5, 5],
      [2, 5.5],
      [Number.NaN, 5],
      [2, Number.NaN],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [null, 5],
      [2, null],
    ];
    for (const [step, steps] of odd) {
      const facts = feed({ step, steps });
      expect(describeStage(facts), `${step} of ${steps}`).toBe("Rendering and encoding");
      expect(timeLeftNow(facts, NOW), `${step} of ${steps}`).toEqual(left(240));
    }
  });

  it("is silent exactly when the stage line says 'Rendering part N of M', whatever the numbers (property)", () => {
    const count = fc.oneof(
      fc.constant(null),
      fc.integer({ min: -3, max: 20 }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 0.5),
    );
    fc.assert(
      fc.property(count, count, (step, steps) => {
        const facts = feed({ step, steps });
        const silent = timeLeftNow(facts, NOW).kind === "none";
        expect(silent).toBe(/^Rendering part \d+ of \d+$/.test(describeStage(facts)));
      }),
      { numRuns: 500 },
    );
  });
});

describe("a stored answer is checked before it is said", () => {
  const junk: Array<[string, unknown]> = [
    ["a kind the rule does not have", { kind: "soon", seconds: 240 }],
    ["a kind in other letters", { kind: "LEFT", seconds: 240 }],
    ["a kind that is not text", { kind: 5, seconds: 240 }],
    ["no kind", { seconds: 240 }],
    ["a figure of 92 s, which is not on the grid", left(92)],
    ["a figure of 90 s, between two grid figures", left(90)],
    ["a figure of 1 s", left(1)],
    ["a figure of 0 s", left(0)],
    ["a negative figure", left(-30)],
    ["a figure that is not a number", left(Number.NaN)],
    ["an infinite figure", left(Number.POSITIVE_INFINITY)],
    ["a figure of 1e12 s", left(1e12)],
    ["a figure above two days, though on the grid", left(IMPLAUSIBLE_SECONDS + 900)],
    ["a figure given as text", { kind: "left", seconds: "240" }],
    ["a missing figure", { kind: "left" }],
    ["a figure that is null", { kind: "left", seconds: null }],
    ["text", "left"],
    ["a bare number", 240],
    ["true", true],
    ["null", null],
    ["undefined", undefined],
    ["a list", ["left", 240]],
  ];

  it.each(junk)("reads %s as nothing, and says nothing of it", (_name, stored) => {
    const facts = feed({ timeLeft: stored as TimeLeft });
    expect(timeLeftNow(facts, NOW)).toEqual(NO_TIME_LEFT);
    expect(shownTimeLeftSeconds(facts, NOW)).toBeNull();
    expect(describeLiveStatus(facts, NOW)).toBe("Rendering and encoding · 40%");
    expect(describeDialogProgress(view(facts), NOW).timeLeft).toBe("");
    // The dialog's own job is checked the same way.
    expect(describeDialogProgress(view(null, { timeLeft: stored }), NOW).timeLeft).toBe("");
  });

  it("says the greatest time it believes: two days on the grid", () => {
    expect(timeLeftNow(feed({ timeLeft: left(IMPLAUSIBLE_SECONDS) }), NOW)).toEqual(
      left(IMPLAUSIBLE_SECONDS),
    );
  });

  it("says every figure of the rounding grid as itself, and no number that is not on it (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: IMPLAUSIBLE_SECONDS }), (raw) => {
        const figure = roundTimeLeft(raw);
        expect(timeLeftNow(feed({ timeLeft: left(figure) }), NOW)).toEqual(left(figure));
        if (raw !== figure)
          expect(timeLeftNow(feed({ timeLeft: left(raw) }), NOW)).toEqual(NO_TIME_LEFT);
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.double({ min: -1e3, max: 1e7 }), (seconds) => {
        const said = timeLeftNow(feed({ timeLeft: left(seconds) }), NOW);
        if (said.kind === "left") {
          expect(said.seconds).toBe(seconds);
          expect(roundTimeLeft(seconds)).toBe(seconds);
          expect(seconds > 0 && seconds <= IMPLAUSIBLE_SECONDS).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("the figure the assistant's export list is given", () => {
  it("is the figure of the card's words, in whole seconds on the rounding grid", () => {
    for (const seconds of [30, 60, 120, 240, 600, 900, 3600, 4500, 5400]) {
      const facts = feed({ timeLeft: left(seconds) });
      const shown = shownTimeLeftSeconds(facts, NOW);
      expect(shown).toBe(seconds);
      expect(roundTimeLeft(shown!)).toBe(shown);
      expect(describeLiveStatus(facts, NOW).endsWith(` · ${describeExportTime(shown!)} left`)).toBe(
        true,
      );
    }
  });

  it("is nothing for an answer that is not a figure", () => {
    for (const answer of [FINISHING, LONGER, NO_TIME_LEFT])
      expect(shownTimeLeftSeconds(feed({ timeLeft: answer }), NOW)).toBeNull();
  });
});

describe("whatever the feed holds", () => {
  const count = fc.oneof(
    fc.constant(null),
    fc.integer({ min: -3, max: 20 }),
    fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 1e18),
  );
  const answer = fc.oneof(
    fc.constant(NO_TIME_LEFT),
    fc.integer({ min: 0, max: 200_000 }).map((raw) => left(roundTimeLeft(raw))),
    fc.constant(FINISHING),
    fc.constant(LONGER),
    // What no rule would publish.
    fc
      .tuple(
        fc.constantFrom<unknown>("left", "finishing", "longer", "none", "soon", 5, null),
        fc.oneof(fc.double(), fc.integer(), fc.string(), fc.constant(undefined)),
      )
      .map(([kind, seconds]) => ({ kind, seconds })),
    fc.anything(),
    fc.constant(undefined),
  );
  const facts = fc
    .record({
      stage: fc.constantFrom(...STAGES),
      startedAt: fc.integer({ min: 0, max: NOW + 10_000 }),
      fraction: fc.oneof(
        fc.constant(null),
        fc.double({ min: -1, max: 2 }),
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY),
      ),
      etaSec: fc.oneof(fc.constant(null), fc.double(), fc.integer({ min: 0, max: 9_999 })),
      step: count,
      steps: count,
      lastMoveAt: fc.integer({ min: NOW - 400_000, max: NOW + 5_000 }),
      busy: fc.constantFrom(true, false, null, undefined),
      timeLeft: answer,
    })
    .map((record) => record as unknown as LiveFacts);
  const now = fc.integer({ min: NOW - 1_000, max: NOW + 900_000 });

  it("gives a line that is never a half-made sentence and has a time-left phrase exactly when timeLeftNow has something to say", () => {
    fc.assert(
      fc.property(facts, now, (feedFacts, moment) => {
        const line = describeLiveStatus(feedFacts, moment);
        expect(line).not.toMatch(HALF_MADE);
        expect(line.length).toBeGreaterThan(0);
        expect(TIME_PHRASE.test(line)).toBe(timeLeftNow(feedFacts, moment).kind !== "none");
      }),
      { numRuns: 1500 },
    );
  });

  it("gives the card and the dialog the same line for the same feed at the same moment", () => {
    fc.assert(
      fc.property(facts, now, (feedFacts, moment) => {
        const line = describeLiveStatus(feedFacts, moment);
        const panel = describeDialogProgress(view(feedFacts), moment);
        expect(line).toBe(panel.timeLeft ? `${panel.status} · ${panel.timeLeft}` : panel.status);
        expect(panel.timeLeft === "").toBe(!TIME_PHRASE.test(line));
      }),
      { numRuns: 1000 },
    );
  });

  it("gives the assistant a figure of the grid or nothing, and the figure is the one in the card's words", () => {
    fc.assert(
      fc.property(facts, now, (feedFacts, moment) => {
        const shown = shownTimeLeftSeconds(feedFacts, moment);
        const line = describeLiveStatus(feedFacts, moment);
        if (shown === null) expect(/(under a minute|about [^·]+) left$/.test(line)).toBe(false);
        else {
          expect(roundTimeLeft(shown)).toBe(shown);
          expect(shown > 0 && shown <= IMPLAUSIBLE_SECONDS).toBe(true);
          expect(line.endsWith(` · ${describeExportTime(shown)} left`)).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe("the speed on the dialog's panel", () => {
  const answers = [NO_TIME_LEFT, left(240), FINISHING, LONGER, left(92), null, undefined, "soon"];

  it("is the render's multiple while rendering and nothing elsewhere, whatever the time left says", () => {
    for (const answer of answers)
      for (const stage of STAGES) {
        const panel = describeDialogProgress(
          view(feed({ stage, timeLeft: answer as TimeLeft })),
          NOW,
        );
        expect(panel.speed, `${stage} with ${JSON.stringify(answer)}`).toBe(
          stage === "rendering" ? 2.1 : null,
        );
      }
  });

  it("is still there when the rule has no time left to say", () => {
    expect(describeDialogProgress(view(feed({ timeLeft: NO_TIME_LEFT })), NOW)).toMatchObject({
      speed: 2.1,
      timeLeft: "",
    });
    // A render that went quiet, and a part before the last: the time left goes, the speed stays.
    expect(describeDialogProgress(view(feed({ lastMoveAt: NOW - 120_000 })), NOW)).toMatchObject({
      speed: 2.1,
      timeLeft: "",
    });
    expect(describeDialogProgress(view(feed({ step: 0, steps: 3 })), NOW)).toMatchObject({
      speed: 2.1,
      timeLeft: "",
    });
  });

  it("is the job's multiple while it renders and nothing while it prepares, before the export has a feed, whatever the job's answer", () => {
    for (const answer of answers) {
      const job = (phase: "preparing" | "rendering") =>
        describeDialogProgress(view(null, { phase, timeLeft: answer, speed: 2 }), NOW).speed;
      expect(job("rendering")).toBe(2);
      expect(job("preparing")).toBeNull();
    }
  });
});
