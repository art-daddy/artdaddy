// The export list, driven through the real queue.
//
// The queue could always hold several exports, but nothing rendered it: the menu-bar badge shows
// the RUNNING job only, and a job left every surface the moment it settled. So the two things
// worth asserting are the two that were invisible — a WAITING job, and a job that already FAILED.
// A test that only checks the running row would pass on the old behaviour.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExportQueuePane from "./ExportQueuePane";
import {
  __resetExportQueue,
  ExportRunError,
  listExportRecords,
  submitExport,
  whenExportsSettle,
  type ExportRecord,
} from "../timeline/exportQueue";
import { describeChipFailure, plainFailure } from "../timeline/exportWords";
import { useExportJob } from "../store/exportJob";
import { ENCODER_FAILURE_LOG, ENCODER_FAILURE_PIECES } from "../test/failureTexts";
import { ExportMemFs } from "../test/timelineKit";
import { ProjectStoreAccess } from "../tools/store";

vi.mock("../tools/genJobs", () => ({
  openProjectJobs: async () => ({
    begin: async () => `job-${Math.random().toString(36).slice(2, 8)}`,
    settle: async () => undefined,
  }),
}));
vi.mock("../store/jobNotes", () => ({ notifyJobSettled: () => undefined }));
// The queue is the real one. Rows a test makes up are for the cases it cannot make: a failed row with no text to read, and a row the
// chip stopped whose text says something else.
const made = vi.hoisted(() => ({ rows: null as ExportRecord[] | null }));
vi.mock("../timeline/exportQueue", async (importOriginal) => {
  const real = await importOriginal<typeof import("../timeline/exportQueue")>();
  return { ...real, listExportRecords: () => made.rows ?? real.listExportRecords() };
});

let fs: ExportMemFs;
let store: ProjectStoreAccess;
const pendingGates: Array<() => void> = [];

/** An encode that only finishes when we say so, so a QUEUED row is observable. */
function gated(): { run: (s: AbortSignal) => Promise<{ warnings?: string[] }>; open: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  pendingGates.push(release);
  return {
    run: async () => {
      await gate;
      return {};
    },
    open: () => release(),
  };
}

const submit = (filename: string, run: (s: AbortSignal) => Promise<{ warnings?: string[] }>) => {
  const requestFs = fs;
  return submitExport({
    store,
    dependencies: [],
    destPath: `/out/${filename}`,
    stagePath: `/out/${filename}.partial`,
    filename,
    run: async (signal) => {
      const result = await run(signal);
      await requestFs.writeTextFile(`/out/${filename}.partial`, `encoded ${filename}`);
      return result;
    },
  });
};

beforeEach(() => {
  __resetExportQueue();
  fs = new ExportMemFs();
  store = new ProjectStoreAccess("/proj", fs);
  useExportJob.setState({ fraction: 0.5 });
});
afterEach(async () => {
  made.rows = null;
  for (const release of pendingGates.splice(0)) release();
  await whenExportsSettle();
  __resetExportQueue();
});

describe("ExportQueuePane", () => {
  it("renders nothing until an export exists", () => {
    const { container } = render(<ExportQueuePane />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a job that is WAITING behind another, which no other surface does", async () => {
    const first = gated();
    await submit("one.mp4", first.run);
    await submit("two.mp4", async () => ({}));
    render(<ExportQueuePane />);

    expect(screen.getByText("one.mp4")).toBeTruthy();
    expect(screen.getByText("two.mp4")).toBeTruthy();
    expect(screen.getByText("Queued")).toBeTruthy();

    first.open();
    await whenExportsSettle();
  });

  it("KEEPS a failed export on the list, with its reason in the card's plain words", async () => {
    await submit("bad.mp4", async () => {
      throw new Error("disk full");
    });
    await whenExportsSettle();
    render(<ExportQueuePane />);

    // The regression this exists for: the row used to disappear the instant it settled, so a
    // user who looked away never learned the export failed at all.
    expect(screen.getByText("bad.mp4")).toBeTruthy();
    expect(screen.getByText(plainFailure("storage_full"))).toBeTruthy();
    // the failure's own text is what the pointer finds on the row, not what the row says
    expect(screen.queryByText("disk full")).toBeNull();
    expect(screen.getByText("bad.mp4").closest("li")).toHaveAttribute(
      "title",
      "/out/bad.mp4\ndisk full",
    );
  });

  it("says the card's sentence in the row, and keeps the path, the failure's text and the process's diagnostics in the hover text exactly as they were", async () => {
    const stderr = [
      "frame=  311 fps=29 q=-0.0 size=    4096KiB time=00:00:10.36",
      'native render resident: {"limit":8589934592,"sampled_peak":2147483648}',
    ].join("\n");
    await submit("bad.mp4", async () => {
      throw new ExportRunError(ENCODER_FAILURE_LOG, stderr);
    });
    await whenExportsSettle();
    render(<ExportQueuePane />);

    const row = screen.getByText("bad.mp4").closest("li")!;
    expect(within(row).getByText(plainFailure("render_failed"))).toBeTruthy();
    for (const piece of [...ENCODER_FAILURE_PIECES, "frame=  311", "sampled_peak"])
      expect(row.textContent, piece).not.toContain(piece);
    // the queue kept what the pointer finds: the file's path, the text of the failure, a blank line, the process's own diagnostics
    expect(listExportRecords()[0]).toMatchObject({
      state: "failed",
      destPath: "/out/bad.mp4",
      error: ENCODER_FAILURE_LOG,
      stderrTail: stderr,
    });
    expect(row).toHaveAttribute("title", `/out/bad.mp4\n${ENCODER_FAILURE_LOG}\n\n${stderr}`);
  });

  describe("for a row the test makes up", () => {
    const row = (over: Partial<ExportRecord>): ExportRecord => ({
      job_id: "made-1",
      filename: "made.mp4",
      destPath: "/out/made.mp4",
      projectDir: "/proj",
      state: "failed",
      startedAt: 1_000_000,
      ...over,
    });

    it("still says Failed, the label, for a failed row that has no text to read", () => {
      made.rows = [row({})];
      render(<ExportQueuePane />);
      const listed = screen.getByText("made.mp4").closest("li")!;
      expect(within(listed).getByText("Failed")).toBeTruthy();
      expect(listed.textContent).not.toContain(plainFailure("unknown"));
      expect(listed).toHaveAttribute("title", "/out/made.mp4");
    });

    it("says the card's sentence for a place with no Try again for a row the graphics chip stopped, whatever its text says", () => {
      made.rows = [row({ error: "ENOSPC: no space left on device", chipFailed: true })];
      render(<ExportQueuePane />);
      const listed = screen.getByText("made.mp4").closest("li")!;
      expect(within(listed).getByText(describeChipFailure("again"))).toBeTruthy();
      expect(listed.textContent).not.toContain(plainFailure("storage_full"));
    });

    it("says the plain sentence, and no label, for a failed row with text, and the label for the other ends", () => {
      made.rows = [
        row({ job_id: "a", filename: "a.mp4", error: "ENOSPC: no space left on device" }),
        row({ job_id: "b", filename: "b.mp4", state: "done" }),
        row({ job_id: "c", filename: "c.mp4", state: "cancelled" }),
        row({ job_id: "d", filename: "d.mp4", state: "queued" }),
      ];
      render(<ExportQueuePane />);
      const said = (name: string) => screen.getByText(name).closest("li")!.textContent ?? "";
      expect(said("a.mp4")).toContain(plainFailure("storage_full"));
      expect(said("a.mp4")).not.toContain("Failed");
      expect(said("b.mp4")).toContain("Completed");
      expect(said("c.mp4")).toContain("Cancelled");
      expect(said("d.mp4")).toContain("Queued");
    });
  });

  it("keeps a completed export until it is dismissed", async () => {
    await submit("good.mp4", async () => ({}));
    await whenExportsSettle();
    render(<ExportQueuePane />);

    expect(screen.getByText("Completed")).toBeTruthy();
    expect(await fs.readTextFile("/out/good.mp4")).toBe("encoded good.mp4");
    expect(await fs.exists("/out/good.mp4.partial")).toBe(false);
    fireEvent.click(screen.getByLabelText("dismiss good.mp4"));
    expect(screen.queryByText("good.mp4")).toBeNull();
  });

  it("cancels a running export from its own row", async () => {
    const g = gated();
    let sawAbort = false;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    await submit("slow.mp4", async (signal) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
        g.open();
      });
      started();
      await g.run(signal);
      if (signal.aborted) throw new Error("export cancelled");
      return {};
    });
    await running;
    render(<ExportQueuePane />);

    fireEvent.click(screen.getByLabelText("cancel slow.mp4"));
    await whenExportsSettle();
    expect(sawAbort).toBe(true);
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(await fs.exists("/out/slow.mp4")).toBe(false);
  });

  it("clears every settled row and leaves the unsettled one", async () => {
    await submit("done1.mp4", async () => ({}));
    await whenExportsSettle();
    const g = gated();
    await submit("still.mp4", g.run);
    render(<ExportQueuePane />);

    fireEvent.click(screen.getByText("Clear finished"));
    expect(screen.queryByText("done1.mp4")).toBeNull();
    expect(screen.getByText("still.mp4")).toBeTruthy();

    g.open();
    await whenExportsSettle();
  });
});
