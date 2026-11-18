// The slow banner and the failure advice on the chat card, driven through the real queue, the real live feed and the clock the card is redrawn by. What matters is what a person sees: the words of the
// copy pack, the buttons that are there and the ones that are not (Quick is held back: nothing here may name it), what Keep going does, and what a failed export says to lower.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExportCard from "./ExportCard";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { __setExportConfirmationForTests } from "../lib/confirm";
import * as host from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { __resetExportQuestions } from "../store/exportQuestionHost";
import { formatActivityMark } from "../timeline/exportActivity";
import { EXPORT_SPEED_REVISION } from "../timeline/exportOptions";
import { KEEP_GOING_LAST_NOTE } from "../timeline/routeWords";
import {
  __resetExportQueue,
  listExportRecords,
  offerExportRetry,
  submitExport,
  whenExportsSettle,
} from "../timeline/exportQueue";
import { FakeJobs } from "../test/fakeJobs";
import { ExportMemFs } from "../test/timelineKit";
import { ProjectStoreAccess } from "../tools/store";

vi.mock("../tools/genJobs", () => ({
  openProjectJobs: async () => ({
    begin: async () => `job-${Math.random().toString(36).slice(2, 8)}`,
    settle: async () => undefined,
  }),
}));
vi.mock("../store/jobNotes", () => ({ notifyJobSettled: () => undefined }));
vi.mock("../lib/attention", () => ({ askForAttention: vi.fn(async () => undefined) }));
vi.mock("../lib/pickFolder", () => ({ pickFolder: vi.fn(async () => null) }));

const GB = 1e9;
const NOW = 5_000_000;
const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };
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
/** What this PC has measured of that export: 300 s, so the card says "about 5 min" and the banner holds the render to three times that. */
const MEASURED = {
  ...DESCRIPTOR,
  elapsedSeconds: 300,
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

const metaOf = (over: Record<string, unknown> = {}) => ({
  duration_s: 120,
  width: 1920,
  height: 1080,
  fps: 30,
  quality: "medium",
  project_id: "",
  calibration: DESCRIPTOR,
  ...over,
});

function start(
  filename: string,
  run: (signal: AbortSignal) => Promise<unknown>,
  over: { described?: boolean; encoder?: "amd" } = {},
) {
  return submitExport({
    store,
    dependencies: [],
    destPath: `/out/${filename}`,
    stagePath: `/out/${filename}.partial`,
    filename,
    origin: AGENT,
    ...(over.described === false ? {} : { workload: WORKLOAD }),
    meta: metaOf(
      over.encoder
        ? {
            choice: {
              encoder: over.encoder,
              reason: "over_minute",
              tests: [],
              adapter: { maker: "amd" as const, device: "15bf", driver: "32.0.1" },
            },
          }
        : {},
    ),
    run: async (signal) => {
      await run(signal);
      await fs.writeTextFile(`/out/${filename}.partial`, `encoded ${filename}`);
      return {};
    },
  }).then(async (sub) => {
    if (sub.queue_position === 0)
      for (let turn = 0; turn < 50 && useExportJob.getState().live?.jobId !== sub.job_id; turn++)
        await Promise.resolve();
    return sub;
  });
}

const report = (over: Partial<Parameters<ReturnType<typeof useExportJob.getState>["update"]>[0]>) =>
  act(() => useExportJob.getState().update({ phase: "rendering", ...over }));
const liveId = () => useExportJob.getState().live!.jobId;
const toRendering = () => act(() => useExportJob.getState().setLiveStage(liveId(), "rendering"));
const banner = () => screen.queryByRole("group", { name: "slow export" });
const stopped = () => screen.queryByRole("group", { name: "export stopped moving" });
const status = () => screen.getByTestId("export-card-status").textContent ?? "";
const KEPT = "Keeping going. ArtDaddy will tell you again if it gets much slower.";

/** The render at second `t`, on course for `total` seconds in all: what ffmpeg's cumulative speed gives. */
const paced = (total: number, t: number) => ({
  fraction: t / total,
  etaSec: Math.max(0, total - t),
  frame: Math.max(1, t),
  speed: 1,
});
/** Play the watch's own rhythm from `from` to `to` seconds into the run: the render reports, five seconds pass, the queue's watch looks. */
function play(from: number, to: number, total: number | null) {
  for (let t = from + 5; t <= to; t += 5) {
    if (total !== null) report(paced(total, t));
    act(() => void vi.advanceTimersByTime(5000));
  }
}

beforeEach(() => {
  __resetExportQueue();
  __resetExportQuestions();
  __resetExportFlags();
  fs = new ExportMemFs();
  store = new ProjectStoreAccess("/proj", fs);
  useExportJob.getState().reset();
  useExportJob.setState({ live: null, finishing: {}, calibrations: [MEASURED] });
  useEditor.setState({ projectId: "p", store });
  __setExportConfirmationForTests(async () => "continue");
  vi.spyOn(host, "resolveExportResources").mockResolvedValue({
    total_memory_bytes: 16 * GB,
    available_memory_bytes: 12 * GB,
    scratch_free_bytes: 500 * GB,
    destination_free_bytes: 500 * GB,
    local_fast_candidate: false,
    budgets: { memoryBytes: 8 * GB, temporaryBytes: 18 * GB, executionSeconds: 28_800 },
  });
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(async () => {
  cleanup();
  for (const release of gates.splice(0)) release();
  await whenExportsSettle();
  __resetExportQueue();
  __resetExportQuestions();
  __resetExportFlags();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __setExportConfirmationForTests(null);
  useExportJob.setState({ calibrations: [] });
  useEditor.setState({ projectId: null, store: null });
});

describe("the slow banner on the card (B1)", () => {
  it("shows, 90 s in and 2 % done, in the copy pack's words, with Keep going and Cancel and no mention of Quick, and not before", async () => {
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    toRendering();
    // a render on course for 1,170 s against the 300 s this PC measured for it
    play(0, 85, 1170);
    expect(banner()).toBeNull();
    expect(status()).toMatch(/Rendering and encoding · 7%/);
    play(85, 90, 1170);
    const shown = banner();
    expect(shown).not.toBeNull();
    expect(
      within(shown!).getByText("This PC is slower than expected: about 18 min left"),
    ).toBeVisible();
    expect(within(shown!).getByText("It was expected to take about 5 min.")).toBeVisible();
    expect(
      within(shown!).getByText(
        "To go faster, cancel, use fewer layers or clips, and export again.",
      ),
    ).toBeVisible();
    expect(
      within(shown!)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Keep going", "Cancel"]);
    // Quick is held back: not a word of it anywhere on the card
    expect(screen.getByRole("region", { name: "exports" }).textContent).not.toMatch(/quick/i);
    g.open();
  });

  it("says nothing on a healthy export, however long it is watched", async () => {
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    toRendering();
    play(0, 280, 290); // 290 s against 300 s measured
    expect(banner()).toBeNull();
    expect(stopped()).toBeNull();
    g.open();
  });

  it("says it again, once, when the projection doubles after Keep going, and never a third time (B3)", async () => {
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    toRendering();
    play(0, 90, 1170);
    fireEvent.click(within(banner()!).getByRole("button", { name: "Keep going" }));
    expect(banner()).toBeNull();
    expect(screen.getByText(KEPT)).toBeVisible();
    // the same pace for a long while: silenced
    play(90, 300, 1170);
    expect(banner()).toBeNull();
    expect(screen.getByText(KEPT)).toBeVisible();
    // the pace falls away: 2,500 s in all is more than twice 1,170 s
    play(300, 305, 2500);
    expect(banner()).not.toBeNull();
    expect(screen.queryByText(KEPT)).toBeNull();
    fireEvent.click(within(banner()!).getByRole("button", { name: "Keep going" }));
    // and once more, far over: it is a third time, which can never come, so the line that stays must not promise it
    play(305, 600, 9000);
    expect(banner()).toBeNull();
    expect(screen.queryByText(KEPT)).toBeNull();
    expect(screen.getByTestId("slow-banner-kept").textContent).toBe(KEEP_GOING_LAST_NOTE);
    g.open();
  });

  it("goes with the export: nothing of it is left on the card once the export has finished", async () => {
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    toRendering();
    play(0, 90, 1170);
    expect(banner()).not.toBeNull();
    g.open();
    await whenExportsSettle();
    expect(banner()).toBeNull();
    expect(screen.queryByText(KEPT)).toBeNull();
    expect(screen.getByText(/^Exported “one.mp4”/)).toBeVisible();
  });

  it("cancels the export from the banner, as the card's own Cancel does", async () => {
    const g = gated();
    await start("one.mp4", async (signal) => {
      signal.addEventListener("abort", () => g.open());
      await g.wait();
      if (signal.aborted) throw new Error("export cancelled");
    });
    render(<ExportCard />);
    toRendering();
    play(0, 90, 1170);
    fireEvent.click(within(banner()!).getByRole("button", { name: "Cancel" }));
    await whenExportsSettle();
    expect(listExportRecords()[0].state).toBe("cancelled");
    expect(banner()).toBeNull();
    expect(screen.getByText("Export cancelled")).toBeVisible();
  });

  it("is not drawn for an export that is being cancelled", async () => {
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    toRendering();
    play(0, 90, 1170);
    expect(banner()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "cancel one.mp4" }));
    // the queue says it is cancelling once the delivery owner has taken the cancel
    await act(async () => {
      for (let turn = 0; turn < 50; turn++) await Promise.resolve();
    });
    expect(listExportRecords()[0].cancelling).toBe(true);
    expect(banner()).toBeNull();
    expect(status()).toBe("Cancelling…");
    g.open();
  });
});

describe("with the verdict of the stall rule (B6)", () => {
  it("says the export has stopped moving, with what it has to do, when nothing can be read of what the processors are doing", async () => {
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    toRendering();
    play(0, 100, 400);
    // the render stands still from 100 s: ffmpeg prints the same block over and over (its last report was made at 95 s)
    play(100, 170, null);
    const shown = stopped();
    expect(shown).not.toBeNull();
    expect(within(shown!).getByText("This export has stopped moving")).toBeVisible();
    expect(within(shown!).getByText("No progress for 75 s.")).toBeVisible();
    expect(shown!.textContent).not.toMatch(/ArtDaddy stops it/);
    expect(shown!.textContent).not.toMatch(/quick/i);
    expect(
      within(shown!)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Keep going", "Cancel"]);
    // Keep going answers it for good: it is the same silence, and the app's own stop still stands
    fireEvent.click(within(shown!).getByRole("button", { name: "Keep going" }));
    expect(stopped()).toBeNull();
    play(170, 200, null);
    expect(stopped()).toBeNull();
    g.open();
  });

  it("goes when the render moves again", async () => {
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    toRendering();
    play(0, 100, 400);
    play(100, 170, null);
    expect(stopped()).not.toBeNull();
    play(170, 175, 400);
    expect(stopped()).toBeNull();
    g.open();
  });

  describe("with the app process reporting what the processors do", () => {
    async function supervised() {
      const jobs = new FakeJobs();
      const finish = gated();
      const sub = await submitExport({
        store,
        dependencies: [],
        destPath: "/out/two.mp4",
        stagePath: "/out/two.mp4.partial",
        filename: "two.mp4",
        origin: AGENT,
        workload: WORKLOAD,
        meta: metaOf(),
        supervisor: jobs,
        run: async (_signal, id) => {
          await jobs.submit({ id, lane: "measurement", program: "ffmpeg", args: [], meta: {} });
          await finish.wait();
          jobs.exit(id, 0, "");
          await fs.writeTextFile("/out/two.mp4.partial", "encoded");
          return {};
        },
      });
      for (let turn = 0; turn < 200 && !jobs.started.includes(sub.job_id); turn++)
        await Promise.resolve();
      expect(jobs.started).toContain(sub.job_id);
      return { jobs, id: sub.job_id, finish };
    }
    const block = (frame: number, outMs: number) =>
      `frame=${frame}\nfps=30\nout_time_us=${outMs * 1000}\nspeed=1.0x\nprogress=continue\n`;
    /** A render that moves for `moving` seconds and then stands still to `until`, the processors using `cpu` ms every five seconds. */
    function playSupervised(
      run: { jobs: FakeJobs; id: string },
      moving: number,
      until: number,
      cpu: number,
    ) {
      let used = 0;
      for (let t = 5; t <= until; t += 5) {
        if (t <= moving) {
          run.jobs.stdout(run.id, block(t, t * 1000));
          report(paced(400, t));
        }
        used += cpu;
        run.jobs.stdout(run.id, formatActivityMark({ cpuMs: used, readBytes: 0 }));
        act(() => void vi.advanceTimersByTime(5000));
      }
    }

    it("keeps the app's own words for a quiet render whose processors are busy, and adds none of its own", async () => {
      const run = await supervised();
      render(<ExportCard />);
      playSupervised(run, 200, 280, 7_500);
      expect(status()).toMatch(/^Still working · no new picture for 8\d s · /);
      expect(stopped()).toBeNull();
      expect(banner()).toBeNull();
      expect(screen.getByRole("region", { name: "exports" }).textContent).not.toMatch(
        /stopped moving/,
      );
      run.finish.open();
    });

    it("says the export has stopped moving, and that the app stops it at three minutes, when the processors are idle too", async () => {
      __setExportFlag("stall_stop", false);
      const run = await supervised();
      render(<ExportCard />);
      playSupervised(run, 100, 200, 5);
      expect(status()).toMatch(/^No progress for 1\d\d s · /);
      const shown = stopped();
      expect(shown).not.toBeNull();
      expect(within(shown!).getByText("This export has stopped moving")).toBeVisible();
      expect(
        within(shown!).getByText(/^No progress for 1\d\d s\.$|^No progress for \d min\.$/),
      ).toBeVisible();
      expect(
        within(shown!).getByText("ArtDaddy stops it if nothing moves for 3 minutes."),
      ).toBeVisible();
      run.finish.open();
    });
  });
});

describe("the switch for the help (S2)", () => {
  it("draws nothing of its own with the switch off: 0.27.0's card, line for line, while the render is slow and while it stands still", async () => {
    __setExportFlag("export_help", false);
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    toRendering();
    play(0, 120, 1170);
    expect(banner()).toBeNull();
    expect(screen.queryByText(KEPT)).toBeNull();
    // 0.27.0 said "about 18 min left" here from the raw pace (1,170 s in all, 120 s in). The rule's own reading: the render made 5 s of its 1,170 s every 5 s,
    // so the gate opened at 60 s rendered (a share under 15 %) with 1,105 s left, which is 20 min on the 5-minute grid; 1,050 s left at the last report is
    // still inside that figure's cell widened by a quarter, so the figure holds.
    expect(status()).toBe(
      "Still working · 2 min in · Rendering and encoding · 10% · about 20 min left",
    );
    play(120, 200, null);
    expect(stopped()).toBeNull();
    expect(status()).toMatch(/^No progress for 8\d s · Rendering and encoding · 10%$/);
    g.open();
  });

  it("takes a flip in the middle of a run at once: the banner goes with the switch, and is back with it", async () => {
    const g = gated();
    await start("one.mp4", g.wait);
    render(<ExportCard />);
    toRendering();
    play(0, 100, 1170);
    expect(banner()).not.toBeNull();
    act(() => __setExportFlag("export_help", false));
    play(100, 105, 1170);
    expect(banner()).toBeNull();
    act(() => __setExportFlag("export_help", true));
    play(105, 110, 1170);
    expect(banner()).not.toBeNull();
    g.open();
  });
});

describe("what to lower after a failure, on the card (A1)", () => {
  const MEMORY = "Error while filtering: Cannot allocate memory";
  const DRIVER =
    "native render failed: [h264_amf @ 0000028f] Error submitting video frame to the encoder";
  const ADVICE = /lower the picture size|a lower picture size|shorter section/;
  const failing = (error: string, over: { encoder?: "amd" } = {}) =>
    start(
      "one.mp4",
      async () => {
        throw new Error(error);
      },
      over,
    );

  it("adds, after the plain sentence and Try again's line, what to lower for a memory failure", async () => {
    const sub = await failing(MEMORY);
    offerExportRetry(sub.job_id, async () => ({ ok: true }));
    await whenExportsSettle();
    render(<ExportCard />);
    const advice =
      "To use less memory, lower the picture size or frame rate, or export a shorter section.";
    const lines = screen
      .getByText("Export stopped")
      .parentElement!.textContent!.replace(/Try again$/, "");
    expect(lines).toBe(
      [
        "Export stopped",
        "one.mp4",
        "Your PC ran short of memory. Close other programs and try again.",
        "Try again uses a gentler setting: it needs less memory and may take longer.",
        advice,
      ].join(""),
    );
  });

  it("adds, for an export that ran too long or stopped moving, the sentence without Quick", async () => {
    await failing("export deadline exceeded");
    await whenExportsSettle();
    render(<ExportCard />);
    expect(
      screen.getByText(
        "On this PC a lower picture size or frame rate, or a shorter section, is faster.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("The export took longer than ArtDaddy allows, or stopped making progress."),
    ).toBeVisible();
  });

  it("adds, when the graphics chip stopped it and nothing started it again, what makes that shorter", async () => {
    __setExportFlag("chip_restart", false);
    await failing(DRIVER, { encoder: "amd" });
    await whenExportsSettle();
    render(<ExportCard />);
    expect(
      screen.getByText(
        "The graphics chip stopped this export. Export it again and the processor will be used, which takes longer.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("To make that shorter, lower the picture size or frame rate."),
    ).toBeVisible();
  });

  it.each([
    ["a drive that ran out of room", "ENOSPC: no space left on device"],
    ["a clip that could not be read", "ENOENT: no such file or directory"],
    ["a folder that would not take the file", "Permission denied: destination unavailable"],
    ["a file that did not pass its check", "verification failed: frame count mismatch"],
    ["a render that failed", "ffmpeg render failed (code=1)"],
    ["an interruption", "interrupted by a restart"],
    ["a cause nobody knows", "something odd"],
  ])(
    "says nothing to lower for %s: when the cause is not known no advice is given",
    async (_name, error) => {
      await failing(error);
      await whenExportsSettle();
      render(<ExportCard />);
      expect(screen.getByText("Export stopped")).toBeVisible();
      expect(screen.getByRole("region", { name: "exports" }).textContent).not.toMatch(ADVICE);
      expect(screen.getByRole("region", { name: "exports" }).textContent).not.toMatch(/quick/i);
    },
  );

  it("says 0.27.0's words, and only those, with the switch off", async () => {
    __setExportFlag("export_help", false);
    await failing(MEMORY);
    await whenExportsSettle();
    render(<ExportCard />);
    expect(
      screen.getByText("Your PC ran short of memory. Close other programs and try again."),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: "exports" }).textContent).not.toMatch(ADVICE);
  });

  it("never names Quick, for any failure, while Quick is not on offer", async () => {
    for (const error of [MEMORY, "export deadline exceeded", "ENOSPC: no space left on device"]) {
      __resetExportQueue();
      cleanup();
      await failing(error);
      await whenExportsSettle();
      render(<ExportCard />);
      expect(screen.getByRole("region", { name: "exports" }).textContent).not.toMatch(/quick/i);
    }
  });
});
