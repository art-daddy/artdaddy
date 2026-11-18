// What a person is told about the time left of a running export, read where it is said: the chat card's line and the Export dialog's right side, drawn side by side
// from the real queue, the real live feed and the real components on a fake clock. Every feed is played the way the producers report it (a report a second) and
// carries the raw guess they publish held at a constant 90 s, which nothing on screen may follow. Every expected word is worked out by hand from the rule
// (timeline/exportTimeLeft.ts): nothing until 20 s have been rendered and either 15 % is made or 60 s have passed; then the pace of the last 20 s on a rounding grid
// (the nearest minute to 10 min, the nearest 5 minutes to an hour), kept while the raw time stays inside its cell widened by a quarter; "Finishing" from 90 %;
// "taking longer than expected" once the average pace implies a total over one and a half times the first figure's.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExportCard from "./ExportCard";
import ExportDialog from "./ExportDialog";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { __setExportConfirmationForTests } from "../lib/confirm";
import * as host from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { ExportMemFs } from "../test/timelineKit";
import type { RestartLink } from "../timeline/exportAttempts";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "../timeline/exportOptions";
import {
  __resetExportQueue,
  listExportOutcomes,
  listExportRecords,
  submitExport,
  whenExportsSettle,
  type ExportSubmission,
} from "../timeline/exportQueue";
import { ProjectStoreAccess } from "../tools/store";

vi.mock("../tools/genJobs", () => ({
  openProjectJobs: async () => ({
    begin: async () => `job-${Math.random().toString(36).slice(2, 8)}`,
    settle: async () => undefined,
  }),
}));
vi.mock("../store/jobNotes", () => ({ notifyJobSettled: () => undefined }));
vi.mock("../lib/attention", () => ({ askForAttention: vi.fn(async () => undefined) }));

const ORIGIN = 5_000_000;
const GB = 1e9;

// An export as the tool plans a real one, and what this PC has measured of it: 150 s and 48 MB.
const WORKLOAD = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 120,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
};
const DESCRIPTOR = {
  workload: WORKLOAD,
  output: { width: 1920, height: 1080, fps: 30 },
  quality: "medium",
  engine: "file-sequence-v1" as const,
  encoder: "x264-crf" as const,
  revision: EXPORT_SPEED_REVISION,
};
const MEASURED: ExportCalibration = {
  ...DESCRIPTOR,
  elapsedSeconds: 150,
  finalBytes: 48_000_000,
  memoryBytes: null,
  temporaryBytes: null,
};

let fs: ExportMemFs;
let store: ProjectStoreAccess;
const gates: Array<() => void> = [];

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  gates.push(release);
  return { wait: () => gate, open: () => release() };
}

beforeEach(() => {
  __resetExportQueue();
  fs = new ExportMemFs();
  store = new ProjectStoreAccess("/proj", fs);
  useExportJob.getState().reset();
  useExportJob.setState({ live: null, finishing: {}, calibrations: [] });
  useEditor.setState({ projectId: "p", store });
  vi.useFakeTimers({ now: ORIGIN, toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(async () => {
  cleanup();
  for (const release of gates.splice(0)) release();
  await whenExportsSettle();
  __resetExportQueue();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __setExportConfirmationForTests(null);
  __resetExportFlags();
  useExportJob.setState({ calibrations: [] });
  useEditor.setState({ projectId: null, store: null });
});

/** An export that runs until it is told to end, and then finishes or fails. It is begun by the Export menu (no chat turn asked), so the dialog follows it too. */
async function launch(
  filename: string,
  over: { fails?: boolean; described?: boolean; restart?: RestartLink } = {},
): Promise<{ sub: ExportSubmission; end: () => void }> {
  const g = gated();
  const sub = await submitExport({
    store,
    dependencies: [],
    destPath: `/out/${filename}`,
    stagePath: `/out/${filename}.partial`,
    filename,
    ...(over.described
      ? {
          workload: WORKLOAD,
          meta: {
            duration_s: 120,
            width: 1920,
            height: 1080,
            fps: 30,
            quality: "medium",
            project_id: "",
            calibration: DESCRIPTOR,
          },
        }
      : {}),
    ...(over.restart ? { restart: over.restart } : {}),
    run: async () => {
      await g.wait();
      if (over.fails) throw new Error("ffmpeg render failed (code=1)");
      await fs.writeTextFile(`/out/${filename}.partial`, `encoded ${filename}`);
      return {};
    },
  });
  // An export at the head of the queue begins its run a moment after it is submitted: let it.
  if (sub.queue_position === 0)
    for (let turn = 0; turn < 50 && useExportJob.getState().live?.jobId !== sub.job_id; turn++)
      await Promise.resolve();
  return { sub, end: g.open };
}

const dialog = () => <ExportDialog open onCancel={() => {}} onStart={() => {}} />;
/** A PC with room to spare, so the pre-start check asks nothing (an export the app starts again by itself is refused when it would have to). */
function aRoomyPc() {
  __setExportConfirmationForTests(async () => "continue");
  vi.spyOn(host, "resolveExportResources").mockResolvedValue({
    total_memory_bytes: 16 * GB,
    available_memory_bytes: 12 * GB,
    scratch_free_bytes: 500 * GB,
    destination_free_bytes: 500 * GB,
    local_fast_candidate: false,
    budgets: { memoryBytes: 8 * GB, temporaryBytes: 18 * GB, executionSeconds: 28_800 },
  });
}
/** The export on screen the way a person has it: the card above the chat and the Export dialog, both on the same export. */
async function watched(over: Parameters<typeof launch>[1] = {}) {
  useExportJob.getState().begin(null);
  const run = await launch("film.mp4", over);
  act(() => useExportJob.getState().attach(run.sub.job_id));
  render(
    <>
      {dialog()}
      <ExportCard />
    </>,
  );
  return run;
}
const toStage = (jobId: string, stage: "preparing" | "rendering" | "checking" | "saving") =>
  act(() => useExportJob.getState().setLiveStage(jobId, stage));

const at = (t: number) => ORIGIN + t * 1000;
/** A report of the render `t` seconds into the run, `fraction` of it made. The frame count follows the share (a render that moved); the raw guess is a constant 90 s. */
function reportAt(
  t: number,
  fraction: number,
  over: Partial<Parameters<ReturnType<typeof useExportJob.getState>["update"]>[0]> = {},
) {
  vi.setSystemTime(at(t));
  act(() =>
    useExportJob.getState().update({
      phase: "rendering",
      fraction,
      frame: Math.round(fraction * 10_000),
      speed: 2,
      etaSec: 90,
      ...over,
    }),
  );
}
/** The render says nothing until `t` seconds in: the clock goes on and the line is redrawn on its own ten-second beat. */
const idleTo = (t: number) =>
  act(() => {
    vi.setSystemTime(at(t - 10));
    vi.advanceTimersByTime(10_000);
  });

const cardLine = () => screen.getByTestId("export-card-status").textContent ?? "";
const dialogStatus = () => screen.getByTestId("export-status").textContent ?? "";
const dialogPace = () => screen.getByTestId("export-pace").textContent ?? "";
/** The words about the time left on the card: what follows the percent. */
function cardWords(): string {
  const parts = cardLine().split(" · ");
  const percent = parts.findIndex((part) => /^\d+%$/.test(part));
  return percent < 0 ? "" : parts.slice(percent + 1).join(" · ");
}
/** The words about the time left in the dialog: what follows the speed multiple. */
function dialogWords(): string {
  const parts = dialogPace().split(" · ");
  return (/×$/.test(parts[0]) ? parts.slice(1) : parts).join(" · ");
}
/** The figure the assistant's export list gives for the running export, in seconds (absent when the card says no figure). */
const assistantSeconds = () =>
  listExportOutcomes().find((row) => row.state === "running")?.time_left_s;
/** One answer, three places: the card's line, the dialog's right side and the assistant's list say the same thing. */
function expectSaid(words: string, seconds?: number) {
  expect({ card: cardWords(), dialog: dialogWords(), assistant: assistantSeconds() }).toEqual({
    card: words,
    dialog: words,
    assistant: seconds,
  });
}

describe("the speed on the Export dialog's right side", () => {
  it("is printed alone, exactly as 0.28.0 printed it, until the rule has a time to say, and is followed by the time when it has", async () => {
    const run = await watched();
    toStage(run.sub.job_id, "rendering");
    // A render of 200 s in all, a report every second. Before the gate (15 % made and 20 s rendered: second 30 here) there is no time to say: just the speed.
    for (let t = 1; t <= 29; t++) {
      reportAt(t, t / 200);
      expect(dialogPace()).toBe("2.0×");
    }
    // Second 30: 15 % made, 29 s rendered, 170 s left at the pace of the last 20 s: the nearest minute is 3.
    reportAt(30, 30 / 200);
    expect(dialogPace()).toBe("2.0× · about 3 min left");
    expect(cardLine()).toMatch(/ · 15% · about 3 min left$/);
  });

  it.each([
    [2.04, "2.0×"],
    [0.96, "1.0×"],
    [3.26, "3.3×"],
    [12.34, "12.3×"],
  ])(
    "prints a speed of %s as %s, with nothing after it before a time is said",
    async (speed, text) => {
      const run = await watched();
      toStage(run.sub.job_id, "rendering");
      reportAt(1, 0.005, { speed });
      expect(dialogPace()).toBe(text);
      expect(dialogPace()).not.toMatch(/left|Calculating|·/);
    },
  );

  it("is shown during the render and nowhere else, and not at all while the render has no speed", async () => {
    const run = await watched();
    // A report that carries a speed before the render's own stage says nothing of it.
    reportAt(1, 0.005);
    expect(dialogPace()).toBe("");
    toStage(run.sub.job_id, "rendering");
    expect(dialogPace()).toBe("2.0×");
    // A render with no speed (0) prints no multiple, and the figure is not held back for it.
    reportAt(2, 0.01, { speed: 0 });
    expect(dialogPace()).toBe("");
    reportAt(3, 0.015, { speed: 2 });
    expect(dialogPace()).toBe("2.0×");
    // The render is over: the file is checked, then saved. No speed, and no time, in either.
    for (let t = 4; t <= 30; t++) reportAt(t, t / 200);
    expect(dialogPace()).toBe("2.0× · about 3 min left");
    toStage(run.sub.job_id, "checking");
    expect(dialogPace()).toBe("");
    toStage(run.sub.job_id, "saving");
    expect(dialogPace()).toBe("");
  });
});

describe("the same words on the card, in the dialog and in the assistant's list", () => {
  // One feed, three moments of it that matter: a steady render of 200 s in all for the first minute, then a pace a tenth as fast.
  const fractionAt = (t: number) => (t <= 60 ? t / 200 : 0.3 + 0.0005 * (t - 60));

  it("says nothing before the gate, a figure after it, and, when the pace falls well away from it, that it is taking longer, then Finishing from 90 %", async () => {
    const run = await watched();
    toStage(run.sub.job_id, "rendering");
    for (let t = 1; t <= 100; t++) {
      reportAt(t, fractionAt(t));
      if (t === 10 || t === 29) expectSaid(""); // 28 s rendered but 14.5 % made: the gate is shut
      // 30 s in: 15 % made, 29 s rendered, 170 s left (the nearest minute: 3 min). 45 s in: 155 s left, still inside the figure's cell widened by a quarter.
      if (t === 30 || t === 45) expectSaid("about 3 min left", 180);
      // 80 s in: the last 20 s made 0.01 of the render, so 0.69 / 0.0005 = 1,380 s are left: the nearest 5 minutes is 25 min. 90 s in: 1,370 s, inside that cell's margin.
      if (t === 80 || t === 90) expectSaid("about 25 min left", 1500);
      // 100 s in: 99 s rendered for 0.315 made implies a total of 314 s, over one and a half times the 200 s the first figure implied: from second 95 on.
      if (t === 100) expectSaid("taking longer than expected");
    }
    // The render then comes on in a rush: 92 % made. "Finishing" replaces it, in all three places.
    reportAt(101, 0.92);
    expectSaid("Finishing");
  });

  it("says the same in all three places in every second of a feed, whatever it is", async () => {
    const run = await watched();
    toStage(run.sub.job_id, "rendering");
    const seen = new Set<string>();
    for (let t = 1; t <= 101; t++) {
      reportAt(t, t === 101 ? 0.92 : fractionAt(t));
      expect(dialogWords(), `dialog at ${t} s`).toBe(cardWords());
      const seconds = assistantSeconds();
      if (seconds !== undefined) expect(cardWords(), `list at ${t} s`).toMatch(/^about .+ left$/);
      else expect(cardWords(), `list at ${t} s`).not.toMatch(/^about .+ left$/);
      seen.add(cardWords());
    }
    // The feed went through every kind of answer, so the check above was made on each of them.
    expect(seen).toContain("");
    expect(seen).toContain("about 3 min left");
    expect(seen).toContain("taking longer than expected");
    expect(seen).toContain("Finishing");
  });
});

describe("after Finishing", () => {
  it("never says a number again, on either surface, even when the feed goes backwards, restarts from a small share or settles into a clean pace", async () => {
    const run = await watched();
    toStage(run.sub.job_id, "rendering");
    // A render of 200 s in all: the gate opens at 30 s, 90 % is made at 180 s.
    for (let t = 1; t <= 180; t++) reportAt(t, t / 200);
    expectSaid("Finishing");
    // The feed goes backwards, to a fifth ...
    reportAt(181, 0.5);
    expectSaid("Finishing");
    reportAt(182, 0.2);
    expectSaid("Finishing");
    // ... and then makes a clean pace from there (0.004 a second: the pace of a render with about 200 s left, which is what a rule that had forgotten would say).
    for (let u = 1; u <= 60; u++) {
      reportAt(182 + u, 0.2 + 0.004 * u);
      expectSaid("Finishing");
      expect(cardWords()).not.toMatch(/\d/);
      expect(dialogPace()).not.toMatch(/left/);
    }
  });
});

describe("a render that makes no report", () => {
  // A render of 1,000 s in all: 15 % made at 150 s, so the gate opens there with 850 s left (the nearest 5 minutes is 15 min).
  it("says no time, on either surface, once a minute has passed without one, and the figure is back when the render moves again", async () => {
    const run = await watched();
    toStage(run.sub.job_id, "rendering");
    for (let t = 1; t <= 160; t++) reportAt(t, t / 1000);
    expectSaid("about 15 min left", 900); // 840 s left: inside the cell of 15 min (750 s to 1,050 s) widened by a quarter
    // 50 s of silence is not yet a stall.
    idleTo(210);
    expectSaid("about 15 min left", 900);
    expect(cardLine()).not.toMatch(/No progress/);
    // 62 s of silence is: the card says so, and neither says a time.
    idleTo(222);
    expectSaid("");
    expect(cardLine()).toBe("No progress for 62 s · Rendering and encoding · 16%");
    expect(dialogStatus()).toBe("No progress for 62 s · Rendering and encoding · 16%");
    expect(dialogPace()).toBe("2.0×");
    // It moves again, at the pace it had. The pace is read over the last 20 s of its own reports, so it takes that long to be read again (the first reports after the
    // silence are not asserted); 40 s on, 0.2 made, 800 s left: the nearest 5 minutes is 15 min.
    for (let u = 1; u <= 40; u++) reportAt(222 + u, 0.16 + u / 1000);
    expectSaid("about 15 min left", 900);
    expect(cardLine()).not.toMatch(/No progress/);
  });

  it("says no time either when it keeps printing the same block, and the figure is back when it makes a new picture", async () => {
    const run = await watched();
    toStage(run.sub.job_id, "rendering");
    for (let t = 1; t <= 160; t++) reportAt(t, t / 1000);
    expectSaid("about 15 min left", 900);
    // The same share and the same frame, every five seconds, for 65 s.
    for (let t = 165; t <= 225; t += 5) reportAt(t, 0.16);
    idleTo(226);
    expectSaid("");
    expect(cardLine()).toMatch(/^No progress for 6\d s · Rendering and encoding · 16%$/);
    for (let u = 1; u <= 40; u++) reportAt(226 + u, 0.16 + u / 1000);
    expectSaid("about 15 min left", 900);
  });
});

describe("what the card says about what the export was expected to take", () => {
  const expectedLine = () => screen.queryByTestId("export-card-expected")?.textContent ?? null;
  const HISTORY = "Expected: about 3 min, a file of about 48 MB, from earlier exports on this PC.";
  beforeEach(() => {
    __setExportFlag("estimate_v2", false);
    aRoomyPc();
  });

  /** The line under the status at the start, before the rule has a time to say, when it says a figure and when it says "Finishing"; a render of 100 s in all. */
  async function linesAcrossARun(calibrations: ExportCalibration[]) {
    useExportJob.setState({ calibrations });
    const run = await launch("film.mp4", { described: true });
    render(<ExportCard />);
    const record = listExportRecords().find((r) => r.filename === "film.mp4")!;
    toStage(run.sub.job_id, "rendering");
    const lines: Array<string | null> = [expectedLine()];
    for (let t = 1; t <= 95; t++) {
      reportAt(t, t / 100);
      if (t === 5) lines.push(expectedLine());
      if (t === 40) {
        lines.push(expectedLine());
        expect(cardLine()).toMatch(/ · 40% · about 1 min left$/); // the card is alive and says its own time
      }
    }
    lines.push(expectedLine());
    expect(cardLine()).toMatch(/ · 95% · Finishing$/);
    return { lines, record };
  }

  it("leaves a guess out, at the start and all through the run", async () => {
    const { lines, record } = await linesAcrossARun([]);
    expect(record.expected).toMatchObject({ guessed: true }); // it was admitted with a guess: the card is what leaves it out
    expect(lines).toEqual([null, null, null, null]);
    expect(screen.queryByText(/rough guess/i)).toBeNull();
  });

  it("keeps what this PC measured of its own earlier exports, at the start and all through the run", async () => {
    const { lines, record } = await linesAcrossARun([MEASURED]);
    expect(record.expected).toMatchObject({ guessed: false });
    expect(lines).toEqual([HISTORY, HISTORY, HISTORY, HISTORY]);
  });
});

describe("an export the app starts again", () => {
  it("starts the second attempt's rule afresh: nothing of the first attempt's Finishing is said of it, on the card or in the dialog, and its own gate is its own", async () => {
    useExportJob.getState().begin(null);
    aRoomyPc();
    const first = await launch("film.mp4", { fails: true, described: true });
    act(() => useExportJob.getState().attach(first.sub.job_id));
    render(
      <>
        {dialog()}
        <ExportCard />
      </>,
    );
    toStage(first.sub.job_id, "rendering");
    // Attempt 1: a render of 100 s in all that is 95 s in. The card and the dialog say Finishing.
    for (let t = 1; t <= 95; t++) reportAt(t, t / 100);
    expectSaid("Finishing");
    expect(screen.getByText("Exporting “film.mp4”")).toBeVisible();

    // It fails, and the app starts the export again as its second attempt (the same export, the dialog still holds the first attempt's id).
    first.end();
    await whenExportsSettle();
    const second = await launch("film.mp4", {
      described: true,
      restart: {
        kind: "auto",
        from: first.sub.job_id,
        meta: { reason: "memory_short", restarted: "gentler_setting" },
      },
    });
    expect(screen.getByText("Exporting “film.mp4” · attempt 2")).toBeVisible();
    toStage(second.sub.job_id, "rendering");
    // Attempt 2 is a render of 200 s in all, reported from 100 s on the clock. Until its own gate (15 % made and 20 s rendered: its 30th second) it says nothing, and
    // never Finishing; then its own figure (170 s left: the nearest minute is 3).
    for (let u = 1; u <= 29; u++) {
      reportAt(100 + u, u / 200);
      expect(dialogWords(), `dialog ${u} s into attempt 2`).toBe("");
      expect(cardWords(), `card ${u} s into attempt 2`).toBe("");
    }
    reportAt(130, 30 / 200);
    expect(cardWords()).toBe("about 3 min left");
    expect(dialogWords()).toBe("about 3 min left");
    expect(dialogPace()).toBe("2.0× · about 3 min left");
    // It does make it to 90 %: its own Finishing.
    for (let u = 31; u <= 180; u++) reportAt(100 + u, u / 200);
    expectSaid("Finishing");
  });
});

describe("a render made in parts", () => {
  // Two parts and then the final encode: 0.005 of the render a second to 30 %, again to 60 %, then 0.002 a second in the encode, which is the render's own pace there.
  const STEPS = 3;
  const fractionAt = (t: number) =>
    t <= 60 ? 0.005 * t : t <= 120 ? 0.3 + 0.005 * (t - 60) : 0.6 + 0.002 * (t - 120);
  const stepAt = (t: number) => (t <= 60 ? 0 : t <= 120 ? 1 : 2);

  it("says no time at any part before the last, on either surface, and a figure at the final encode once its own gate has passed", async () => {
    const run = await watched();
    toStage(run.sub.job_id, "rendering");
    for (let t = 1; t <= 140; t++) {
      reportAt(t, fractionAt(t), { step: stepAt(t), steps: STEPS });
      // 60 s of the first part at a pace that would have said a figure, then a whole second part: nothing; and nothing in the first 19 s of the encode either.
      expectSaid("");
      if (t === 60) {
        expect(cardLine()).toMatch(/Rendering part 1 of 2 · 30%$/);
        expect(dialogStatus()).toMatch(/Rendering part 1 of 2 · 30%$/);
      }
      if (t === 120) expect(cardLine()).toMatch(/Rendering part 2 of 2 · 60%$/);
      if (t === 140) expect(cardLine()).toMatch(/Encoding · 64%$/);
    }
    // 141 s: 20 s of the encode have been rendered and 64.2 % is made, at 0.002 a second: 358 s / 2 = 179 s left, the nearest minute is 3. Its own gate, not the parts'.
    reportAt(141, fractionAt(141), { step: 2, steps: STEPS });
    expectSaid("about 3 min left", 180);
    expect(dialogPace()).toBe("2.0× · about 3 min left");
  });
});
