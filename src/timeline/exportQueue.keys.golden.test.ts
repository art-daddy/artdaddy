// The key set of the assistant's export list (`manage_exports`), frozen as the tree before the live time-left wiring answered it.
//
// A row says what is true of one export through fields that come and go with its state: a waiting export has its place in line, a running one its stage and
// progress, a finished one how long it took, a failed one why. The live time-left rule changes what `time_left_s` MEANS (the figure a person is shown, on a
// rounding grid, absent before the gate), never which fields a row has or what shape they are. The runs below feed the render a pace that the old reading
// and the new one both turn into a figure, so the whole key set is the same before and after, `time_left_s` included. The key sets were captured ONCE from the
// unchanged tree and are not to be regenerated to make this pass: a key that moves means the contract with the assistant moved.
import { describe, expect, it, vi } from "vitest";

import { cancelExport, listExportOutcomes } from "../timeline/exportQueue";
import { startRun, steady, useKit, waitBehind } from "../test/exportRunKit";

vi.mock("../api/exportEvents", () => ({ reportExport: vi.fn(async () => undefined) }));

useKit();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const keysOf = (row: Any): string[] => Object.keys(row).sort();
const rowOf = (id: string): Any => listExportOutcomes().find((r) => r.job_id === id);

/** The frozen key sets of a Quality export (the normal route, no graphics chip, the normal setting). */
const FROZEN = {
  waiting: ["elapsed_s", "expected_s", "filename", "job_id", "queue_position", "state"],
  preparing: ["elapsed_s", "expected_s", "filename", "job_id", "stage", "state"],
  rendering: [
    "elapsed_s",
    "expected_s",
    "filename",
    "job_id",
    "progress_percent",
    "stage",
    "state",
    "time_left_s",
  ],
  renderingSlowerThanExpected: [
    "elapsed_s",
    "expected_s",
    "filename",
    "job_id",
    "note",
    "progress_percent",
    "projected_total_s",
    "slower_than_expected",
    "stage",
    "state",
    "time_left_s",
  ],
  renderingWithAGuess: [
    "elapsed_s",
    "expected_guessed",
    "expected_s",
    "filename",
    "job_id",
    "progress_percent",
    "stage",
    "state",
    "time_left_s",
  ],
  checking: ["elapsed_s", "expected_s", "filename", "job_id", "stage", "state"],
  done: ["duration_s", "filename", "job_id", "media_ref", "state"],
  failed: ["duration_s", "error", "failure", "failure_code", "filename", "job_id", "state"],
};

describe("the assistant's export list: which fields a Quality export has in each state", () => {
  it("has the frozen key set for a waiting, a preparing, a rendering, a checking, a finished and a failed export", async () => {
    const seen: Record<keyof typeof FROZEN, string[]> = {
      waiting: [],
      preparing: [],
      rendering: [],
      renderingSlowerThanExpected: [],
      renderingWithAGuess: [],
      checking: [],
      done: [],
      failed: [],
    };

    // with an earlier export of the same length on this PC: the expectation comes from it, and the render keeps to it
    const first = await startRun({ history: 400 });
    const second = await waitBehind(first);
    seen.waiting = keysOf(rowOf(second));
    cancelExport(second, "assistant");
    seen.preparing = keysOf(rowOf(first.id));
    await first.to(100, steady(400));
    seen.rendering = keysOf(rowOf(first.id));
    expect(rowOf(first.id).time_left_s).toEqual(expect.any(Number));
    const release = first.holdTheCheck();
    const finished = first.end("finish");
    await vi.waitFor(() => expect(rowOf(first.id)?.stage).toBe("checking"));
    seen.checking = keysOf(rowOf(first.id));
    release();
    await finished;
    seen.done = keysOf(rowOf(first.id));

    // the same render, four times slower than that earlier export took: the slow banner's fields join the row
    const slow = await startRun({ history: 100, dest: "C:/out/slow.mp4" });
    await slow.to(100, steady(400));
    seen.renderingSlowerThanExpected = keysOf(rowOf(slow.id));
    expect(rowOf(slow.id).time_left_s).toEqual(expect.any(Number));
    await slow.end("finish");

    // nothing like it on this PC yet: the expectation is a guess, and says so
    const guessed = await startRun({ dest: "C:/out/guess.mp4" });
    await guessed.to(100, steady(400));
    seen.renderingWithAGuess = keysOf(rowOf(guessed.id));
    expect(rowOf(guessed.id).time_left_s).toEqual(expect.any(Number));
    await guessed.end("fail");
    seen.failed = keysOf(rowOf(guessed.id));

    expect(seen).toEqual(FROZEN);
  });
});
