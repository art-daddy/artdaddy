// What the assistant's export list says about the time left of a running export (`manage_exports`, `time_left_s`), played the way the app plays it: a supervised export on a fake clock whose
// render reports how far it is. The live time-left rule (exportTimeLeft.ts) decides what may be said; the chat card's line and this list read its answer, so every test here looks at what a row
// says and at the card's own line for the same feed at the same moment, and never at how either is built.
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { __setExportFlag } from "../api/exportFlags";
import { liveFeedOf, useExportJob, type ExportLive } from "../store/exportJob";
import {
  feedOf,
  fresh,
  startRun,
  startRunAgain,
  steady,
  useKit,
  waitBehind,
  type Said,
} from "../test/exportRunKit";
import { describeExportTime } from "./exportOptions";
import { __resetFacts3c } from "./exportFacts3c";
import { cancelExport, listExportOutcomes } from "./exportQueue";
import {
  cellOf,
  FINISHING_FROM,
  IMPLAUSIBLE_SECONDS,
  roundTimeLeft,
} from "./exportTimeLeft";
import { describeLiveStatus, QUIET_SECONDS } from "./exportWords";

vi.mock("../api/exportEvents", () => ({ reportExport: vi.fn(async () => undefined) }));

useKit(__resetFacts3c);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const rowOf = (id: string): Any => listExportOutcomes().find((r) => r.job_id === id);
/** The chat card's line for the export, as the card reads the feed of the export's live attempt. */
const cardOf = (id: string): string => {
  const feed = liveFeedOf(useExportJob.getState(), id);
  return feed ? describeLiveStatus(feed, Date.now()) : "";
};
const keysOf = (row: Any): string[] => Object.keys(row).sort();

/** A figure the card could say: the rounding grid's, a whole number of seconds that is in its own cell. */
const onTheGrid = (x: unknown): boolean =>
  typeof x === "number" &&
  Number.isInteger(x) &&
  x > 0 &&
  x <= IMPLAUSIBLE_SECONDS &&
  roundTimeLeft(x) === x &&
  cellOf(x).lo <= x &&
  x < cellOf(x).hi;

/** The row never has a field that is missing, not a number, or below zero. */
function expectSaneRow(row: Any): void {
  for (const [key, value] of Object.entries(row)) {
    expect(value, `${key} of ${JSON.stringify(row)}`).not.toBeUndefined();
    if (typeof value === "number") {
      expect(Number.isFinite(value), `${key} of ${JSON.stringify(row)}`).toBe(true);
      expect(value, `${key} of ${JSON.stringify(row)}`).toBeGreaterThanOrEqual(0);
    }
  }
}

const FIGURE_PHRASE = /^(?:under a minute|about .+) left$/;

/** What the export's row and its card say at this moment, with the rule that they say the same thing: the row has a time left exactly when the card's line ends in a figure, and the
 *  figure is the card's words. Also that the figure is on the grid and the row has no broken field. */
function look(id: string): { row: Any; card: string; left: number | undefined } {
  const row = rowOf(id);
  expect(row, `a row for ${id}`).toBeDefined();
  const card = cardOf(id);
  const last = card.split(" · ").at(-1) ?? "";
  const said = FIGURE_PHRASE.test(last) ? last : null;
  expectSaneRow(row);
  if (row.time_left_s === undefined) {
    expect(said, `the card says "${card}" but the row has no time left`).toBeNull();
  } else {
    expect(onTheGrid(row.time_left_s), `time_left_s ${row.time_left_s} is not on the grid`).toBe(
      true,
    );
    expect(said, `the row says ${row.time_left_s} s left`).toBe(
      `${describeExportTime(row.time_left_s)} left`,
    );
  }
  return { row, card, left: row.time_left_s };
}

/** The key set of a running export's row while it renders, as the frozen key sets of exportQueue.keys.golden.test.ts have it (that file pins them to the tree before the live time-left
 *  rule), without `time_left_s`: the rule may only add that one field. */
const RENDERING_KEYS = [
  "elapsed_s",
  "expected_s",
  "filename",
  "job_id",
  "progress_percent",
  "stage",
  "state",
];
const PREPARING_KEYS = ["elapsed_s", "expected_s", "filename", "job_id", "stage", "state"];
const CHECKING_KEYS = PREPARING_KEYS;

/** The rule, as the owner stated it, for a render that reports at second 1, 2, 3 ...: the card may say a time left once 5 s of pictures are behind it (the first report, at second 1, is the first
 *  picture) and not once 90 % is made. */
const mayHaveFigure = (t: number, share: number): boolean => t - 1 >= 5 && share < FINISHING_FROM;

describe("when a running export first has a time left to say", () => {
  /** A steady render of `total` seconds, a report every second, looked at after each. */
  async function played(total: number, until: number) {
    const run = await startRun({ history: total });
    expect(keysOf(look(run.id).row)).toEqual(PREPARING_KEYS); // nothing reported yet: the frozen preparing set
    const feed = feedOf(run);
    const seen: Array<{ t: number; left: number | undefined; keys: string[] }> = [];
    for (let t = 1; t <= until; t++) {
      await feed.to(t, steady(total));
      const { row, left } = look(run.id);
      seen.push({ t, left, keys: keysOf(row) });
    }
    await run.end("finish");
    return seen;
  }

  const expectGate = (seen: Awaited<ReturnType<typeof played>>, total: number) => {
    for (const { t, left, keys } of seen) {
      const present = mayHaveFigure(t, t / total);
      expect(left !== undefined, `${t} s into a render of ${total} s`).toBe(present);
      // the rule adds `time_left_s` and nothing else: the row has the frozen key set, with that one field exactly when there is a figure
      expect(keys, `${t} s`).toEqual(
        present ? [...RENDERING_KEYS, "time_left_s"].sort() : RENDERING_KEYS,
      );
    }
  };

  it("says its first figure 5 s after the first picture, however little is made by then (a render of 100 s in all)", async () => {
    const seen = await played(100, 89);
    expectGate(seen, 100);
    // the first figure: 6 s in (the first picture at 1 s, 5 s of pictures, 6 % made), 94 s left at the pace of those 5 s, and the nearest whole minute to that is 2 min = 120 s
    expect(seen.find((s) => s.left !== undefined)).toMatchObject({ t: 6, left: 120 });
    // 4 s of pictures at 5 s: nothing
    expect(seen.find((s) => s.t === 5)?.left).toBeUndefined();
  });

  it("does not wait for 15 % or for a minute (a render of 1000 s in all)", async () => {
    const seen = await played(1000, 300);
    expectGate(seen, 1000);
    // the first figure: 6 s in (0.6 % made), 994 s left; over 10 min the grid is 5 minutes, so the nearest is 15 min = 900 s
    expect(seen.find((s) => s.left !== undefined)).toMatchObject({ t: 6, left: 900 });
    // 20 s and a minute were rendered long before the earlier gate would have opened: the figure had been there for a long time
    expect(seen.find((s) => s.t === 40)?.left).toBeDefined();
  });

  it("says its figure in a short render too: a fifth of a render of 50 s made in 10 s, and 'under a minute' from the 6th second", async () => {
    const seen = await played(50, 44);
    expectGate(seen, 50);
    expect(seen.find((s) => s.t === 5)?.left).toBeUndefined(); // 4 s of pictures
    expect(seen.find((s) => s.left !== undefined)).toMatchObject({ t: 6, left: 30 }); // 44 s left: the figure 30 is "under a minute"
  });
});

describe("what the row and the card say stand together", () => {
  it("is Finishing from 90 % and never a number again, whatever the render does after", async () => {
    const run = await startRun({ history: 100 });
    const feed = feedOf(run);
    await feed.to(89, steady(100));
    // 11 s left: "under a minute", which is the figure 30 on the grid
    expect(look(run.id).left).toBe(30);
    expect(look(run.id).card).toMatch(/ · under a minute left$/);
    await feed.to(90, steady(100));
    expect(look(run.id).left).toBeUndefined();
    expect(look(run.id).card).toMatch(/ · Finishing$/);
    await feed.to(100, steady(100));
    expect(look(run.id).card).toMatch(/ · Finishing$/);
    // a share that goes backwards, or a long wait on the last tenth, does not bring a number back
    feed.say({ fraction: 0.5, etaSec: 50 });
    expect(look(run.id).card).toMatch(/ · Finishing$/);
    await feed.to(130, (t) => ({ fraction: 0.5 + (t - 100) * 0.001, etaSec: 50 }));
    expect(look(run.id).card).toMatch(/ · Finishing$/);
    await run.end("finish");
    expect(rowOf(run.id)).toMatchObject({ state: "done" });
  });

  it("says nothing once the render has made no new picture for a minute, and a figure again when it moves", async () => {
    __setExportFlag("stall_stop", false); // the app's own stop is held off, so that the minute can be looked at
    const run = await startRun({ history: 1000 });
    const feed = feedOf(run, "idle");
    await feed.to(300, steady(1000));
    expect(look(run.id).left).toBeDefined();
    await feed.wait(QUIET_SECONDS - 1);
    expect(look(run.id).left).toBeDefined(); // 59 s of silence: a figure from a minute ago is still news
    await feed.wait(1);
    expect(look(run.id).left).toBeUndefined();
    expect(look(run.id).row).toMatchObject({ stalled_for_s: QUIET_SECONDS });
    await feed.wait(10);
    expect(look(run.id).left).toBeUndefined();
    // the render moves on: a new picture, and the time left is back
    feed.say({ fraction: 0.31, etaSec: 690 });
    expect(look(run.id).left).toBeDefined();
    expect(look(run.id).row).not.toHaveProperty("stalled_for_s");
    await run.end("fail");
  });

  it("says nothing while the file is checked or saved, even though the render had a figure when it ended", async () => {
    const run = await startRun({ history: 400 });
    const feed = feedOf(run);
    await feed.to(160, steady(400));
    expect(look(run.id).left).toBeDefined();
    const release = run.holdTheCheck();
    const finished = run.end("finish");
    await vi.waitFor(() => expect(rowOf(run.id)?.stage).toBe("checking"));
    const checking = look(run.id);
    expect(checking.left).toBeUndefined();
    expect(keysOf(checking.row)).toEqual(CHECKING_KEYS); // the frozen checking set
    useExportJob.getState().setLiveStage(run.id, "saving");
    expect(look(run.id).left).toBeUndefined();
    expect(rowOf(run.id).stage).toBe("saving");
    release();
    await finished;
    expect(rowOf(run.id)).toMatchObject({ state: "done" });
    expect(rowOf(run.id)).not.toHaveProperty("time_left_s");
  });

  it("says nothing at a part before the last of a render made in parts, and a figure at the final encode once 5 s of its own pictures have passed", async () => {
    const run = await startRun();
    const feed = feedOf(run);
    // two parts of 30 % each, then the final encode from 60 % at a fifth of a percent a second (each part's own clock starts with its first report)
    const parted = (t: number): Said =>
      t <= 60
        ? { fraction: 0.005 * t, step: 0, steps: 3 }
        : t <= 120
          ? { fraction: 0.3 + 0.005 * (t - 60), step: 1, steps: 3 }
          : { fraction: 0.6 + 0.002 * (t - 120), step: 2, steps: 3 };
    const seen: Array<{ t: number; left: number | undefined; card: string }> = [];
    for (let t = 1; t <= 269; t++) {
      await feed.to(t, parted);
      const { left, card } = look(run.id);
      seen.push({ t, left, card });
    }
    // 120 s of rendering and half the video made in the two parts: no figure
    expect(seen.filter((s) => s.t <= 125 && s.left !== undefined)).toEqual([]);
    expect(seen.find((s) => s.t === 100)?.card).toMatch(/Rendering part 2 of 2 · /);
    // the final encode starts at 121 s; its own 5 s of pictures pass at 126 s, with 61.2 % made and 0.002 a second: 0.388 / 0.002 = 194 s left, which is 3 min on the grid
    expect(seen.find((s) => s.t === 130)?.card).toMatch(/Encoding · /);
    expect(seen.find((s) => s.left !== undefined)).toMatchObject({ t: 126, left: 180 });
    expect(seen.filter((s) => s.t >= 126).every((s) => s.left !== undefined)).toBe(true);
    await run.end("finish");
  });

  it("says 'taking longer than expected' and no number from the moment the average pace has fallen past one and a half times the one at its reference point, for good", async () => {
    const run = await startRun();
    const feed = feedOf(run);
    // a render of 100 s that slows to a fifth of its pace at 30 s, and speeds up again at 80 s
    const slowing = (t: number): Said => ({
      fraction: t <= 30 ? t / 100 : t <= 80 ? 0.3 + 0.002 * (t - 30) : 0.4 + 0.01 * (t - 80),
      etaSec: 100 - t,
    });
    let first: number | null = null;
    for (let t = 1; t <= 125; t++) {
      await feed.to(t, slowing);
      const { left, card } = look(run.id);
      const longer = card.endsWith(" · taking longer than expected");
      if (longer && first === null) first = t;
      if (first !== null) {
        expect(longer, `${t} s: once said, said for good`).toBe(true);
        expect(left, `${t} s`).toBeUndefined();
      } else if (t >= 6) expect(left, `${t} s, before the slow-down is felt`).toBeDefined();
    }
    // the alarm took its reference at 21 s with 20 s rendered and a fifth made (a total of 100 s, though a figure had been said since 6 s); the average pace passes 150 s at 51 s: 50 s over the 33.2 % made
    expect(first).toBe(51);
    await run.end("finish");
  });
});

describe("the slow banner and the assistant's projected total keep the render's own raw pace", () => {
  const NOTE_SLOW =
    "This export is running slower than expected. Tell the person how long is left. Do not cancel it and start another.";

  it("for a steady render the banner's fields are what the raw pace gives (the whole render, 400 s), and the time left is the grid figure of the same share", async () => {
    const run = await startRun({ history: 100 });
    await run.to(85, steady(400));
    expect(rowOf(run.id)).not.toHaveProperty("slower_than_expected");
    await run.to(90, steady(400));
    expect(rowOf(run.id)).toMatchObject({
      state: "running",
      slower_than_expected: true,
      projected_total_s: 400,
      note: NOTE_SLOW,
      // 310 s left at 90 s of 400: the figure is on the grid of whole minutes, the projection is not
      time_left_s: 300,
    });
    await run.end("finish");
  });

  it("when the render's raw guess and the share disagree, the banner follows the guess and the time left follows the share", async () => {
    const run = await startRun({ history: 100 });
    // the share says 400 s in all; the render's own guess (start-up counted) says 80 s less is left
    await run.to(90, (t) => ({ fraction: t / 400, etaSec: 400 - t - 80 }));
    // banner: 90 s rendered plus 230 s left by the guess = 320 s in all, over three times the 100 s said. Time left: 310 s by the share, 300 s on the grid (the guess would say 240)
    expect(rowOf(run.id)).toMatchObject({
      slower_than_expected: true,
      projected_total_s: 320,
      note: NOTE_SLOW,
      time_left_s: 300,
    });
    await run.end("finish");
  });
});

describe("an export the app starts again", () => {
  it.each([
    ["Finishing", 95, "steady", / · Finishing$/],
    ["taking longer than expected", 80, "slowing", / · taking longer than expected$/],
  ] as const)(
    "starts the rule afresh for the new attempt: what the first attempt ended on (%s) is not carried over",
    async (_words, until, kind, ended) => {
      const kit = await fresh();
      const first = await startRun({ kit, history: 100 });
      const one = feedOf(first);
      const slowing = (t: number): Said => ({
        fraction: t <= 30 ? t / 100 : 0.3 + 0.002 * (t - 30),
        etaSec: 100 - t,
      });
      await one.to(until, kind === "steady" ? steady(100) : slowing);
      expect(look(first.id).left).toBeUndefined();
      expect(look(first.id).card).toMatch(ended);
      await first.end("fail");

      const second = await startRunAgain(first, kit);
      // one export to the assistant: the first attempt's id, on its second attempt, with nothing yet said of its time
      expect(rowOf(first.id)).toMatchObject({ state: "running", attempt: 2, stage: "preparing" });
      expect(look(first.id).left).toBeUndefined();
      expect(look(first.id).card).not.toMatch(ended);

      // a render of 310 s in all: its first figure at 6 s (5 s of pictures, 1.9 % made), 304 s left, which is 5 min on the grid
      const two = feedOf(second);
      const seen: Array<{ t: number; left: number | undefined }> = [];
      for (let t = 1; t <= 100; t++) {
        await two.to(t, steady(310));
        const { left, card } = look(first.id);
        expect(card, `${t} s into the new attempt`).not.toMatch(/Finishing$|taking longer/);
        seen.push({ t, left });
      }
      expect(seen.filter((s) => s.t <= 5 && s.left !== undefined)).toEqual([]);
      expect(seen.find((s) => s.left !== undefined)).toMatchObject({ t: 6, left: 300 });
      expect(seen.filter((s) => s.t >= 6).every((s) => s.left !== undefined)).toBe(true);
      expect(rowOf(first.id)).toMatchObject({ attempt: 2 });
      await second.end("finish");
    },
  );
});

describe("the export that begins while the previous one is still being checked", () => {
  it("has a rule of its own: it never inherits the 'Finishing' the previous export ended on, and the previous one still has no time left", async () => {
    const first = await startRun({ history: 100 });
    const secondId = await waitBehind(first); // queued behind the first, in the app process's line
    const one = feedOf(first);
    await one.to(95, steady(100));
    expect(look(first.id).card).toMatch(/ · Finishing$/);
    const release = first.holdTheCheck();
    const ended = first.end("finish"); // its render is over and its file is being checked: the second one's turn comes
    await vi.waitFor(() => expect(first.jobs.started).toContain(secondId));
    await vi.waitFor(() => expect(rowOf(first.id)?.stage).toBe("checking"));

    // a render of 310 s in all: its first figure at 6 s (5 s of pictures, 1.9 % made), 304 s left, which is 5 min on the grid
    const two = feedOf({ id: secondId, jobs: first.jobs });
    const seen: Array<{ t: number; left: number | undefined }> = [];
    for (let t = 1; t <= 60; t++) {
      await two.to(t, steady(310));
      const { left, card } = look(secondId);
      expect(card, `${t} s into the second export`).not.toMatch(/Finishing$/);
      expect(look(first.id).left, "the export still being checked").toBeUndefined();
      seen.push({ t, left });
    }
    expect(seen.filter((s) => s.t <= 5 && s.left !== undefined)).toEqual([]);
    expect(seen.find((s) => s.left !== undefined)).toMatchObject({ t: 6, left: 300 });
    // `end` waits for every export to settle, and the second one only ends when it is cancelled
    cancelExport(secondId, "assistant");
    release();
    await ended;
  });
});

describe("what the store holds is read through the rule's own shapes", () => {
  it("says no time left at a part before the last, nor for an answer that is not a figure on the grid, whatever the store holds", async () => {
    const run = await startRun({ history: 400 });
    const feed = feedOf(run);
    await feed.to(160, steady(400));
    const held = look(run.id).left;
    expect(held).toBeDefined();
    const forge = (patch: Record<string, unknown>) =>
      useExportJob.setState((s) => ({ live: { ...s.live!, ...patch } as ExportLive }));
    // the figure the rule gave, found at a part before the last of a render made in parts: not said; at the final encode: said
    forge({ step: 0, steps: 3 });
    expect(look(run.id).left).toBeUndefined();
    forge({ step: 2, steps: 3 });
    expect(look(run.id).left).toBe(held);
    forge({ step: null, steps: null });
    // answers the rule cannot give: a figure off the grid, not a number, below zero, over two days, a kind it does not have
    const bad = [
      { kind: "left", seconds: 130 },
      { kind: "left", seconds: Number.NaN },
      { kind: "left", seconds: -60 },
      { kind: "left", seconds: 0 },
      { kind: "left", seconds: 49 * 3600 },
      { kind: "soon" },
      null,
      120,
    ];
    for (const timeLeft of bad) {
      forge({ timeLeft });
      expect(look(run.id).left, JSON.stringify(timeLeft)).toBeUndefined();
    }
    forge({ timeLeft: { kind: "left", seconds: 120 } });
    expect(look(run.id).left).toBe(120); // a figure on the grid is said
    await run.end("fail");
  });
});

describe("whatever the render reports, a row never says a time left that cannot be one", () => {
  it("is on the grid, whole, and the row has no broken field, for feeds that go backwards, repeat, jump, are not numbers, and stop for a while, in any stage", async () => {
    __setExportFlag("stall_stop", false); // the app's own stop is held off: a feed may be silent for a minute and more
    const run = await startRun();
    const feed = feedOf(run);
    let figures = 0;
    const garbage = fc.constantFrom(Number.NaN, Infinity, -Infinity, -1, -0.5, 0, 1e-12);
    const beat = fc.record({
      dt: fc.oneof(
        { weight: 12, arbitrary: fc.integer({ min: 0, max: 5000 }) },
        { weight: 1, arbitrary: fc.integer({ min: 5000, max: 90_000 }) },
      ),
      // a render that mostly goes forward, now and then goes back or jumps
      bump: fc.oneof(
        { weight: 15, arbitrary: fc.double({ min: -0.01, max: 0.03, noNaN: true }) },
        { weight: 1, arbitrary: fc.double({ min: -0.5, max: 0.5, noNaN: true }) },
      ),
      wild: fc.oneof(
        { weight: 12, arbitrary: fc.constant(null) },
        { weight: 1, arbitrary: garbage },
      ),
      eta: fc.constantFrom(null, 0, 90, 49 * 3600 + 1, Number.NaN, Infinity, -3),
      stage: fc.oneof(
        { weight: 3, arbitrary: fc.constant(null) },
        { weight: 1, arbitrary: fc.constantFrom("preparing", "checking", "saving") },
      ),
      part: fc.oneof(
        { weight: 3, arbitrary: fc.constant(null) },
        {
          weight: 1,
          arbitrary: fc.record({
            step: fc.integer({ min: -1, max: 4 }),
            steps: fc.integer({ min: 0, max: 4 }),
          }),
        },
      ),
    });
    // chaos 0: a share that only goes forward and back a little; 1: also reports that are not a share; 2: also a stage that is not the render's and the parts of a render made in
    // parts, each for one report only
    const feeds = fc.record({
      chaos: fc.integer({ min: 0, max: 2 }),
      beats: fc.array(beat, { minLength: 5, maxLength: 40 }),
    });
    const STEADY = {
      chaos: 0,
      beats: Array.from({ length: 40 }, () => ({
        dt: 3000,
        bump: 0.02,
        wild: null,
        eta: null,
        stage: null,
        part: null,
      })),
    };
    await fc.assert(
      fc.asyncProperty(feeds, async (plan) => {
        // a new feed for the same export: the rule starts afresh, as it does for an attempt
        useExportJob.getState().beginLive(run.id);
        useExportJob.getState().setLiveStage(run.id, "rendering");
        let share = 0;
        let frame = 1;
        for (const b of plan.beats) {
          await vi.advanceTimersByTimeAsync(b.dt);
          share = Math.min(1, Math.max(0, share + b.bump));
          const stage = plan.chaos >= 2 ? b.stage : null;
          const part = plan.chaos >= 2 ? b.part : null;
          if (stage !== null) useExportJob.getState().setLiveStage(run.id, stage);
          feed.say({
            fraction: plan.chaos >= 1 && b.wild !== null ? b.wild : share,
            frame: frame++,
            etaSec: b.eta,
            step: part ? part.step : null,
            steps: part ? part.steps : null,
          });
          const { left } = look(run.id);
          if (left !== undefined) figures++;
          if (stage !== null) useExportJob.getState().setLiveStage(run.id, "rendering");
        }
      }),
      { numRuns: 40, examples: [[STEADY]] },
    );
    // a property over feeds that never reach a figure would prove nothing
    expect(figures).toBeGreaterThan(0);
    await run.end("fail");
  });
});
