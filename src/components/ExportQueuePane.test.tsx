// The export list, driven through the real queue.
//
// The queue could always hold several exports, but nothing rendered it: the menu-bar badge shows
// the RUNNING job only, and a job left every surface the moment it settled. So the two things
// worth asserting are the two that were invisible — a WAITING job, and a job that already FAILED.
// A test that only checks the running row would pass on the old behaviour.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExportQueuePane from "./ExportQueuePane";
import { __resetExportQueue, submitExport, whenExportsSettle } from "../timeline/exportQueue";
import { useExportJob } from "../store/exportJob";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

vi.mock("../tools/genJobs", () => ({
  openProjectJobs: async () => ({
    begin: async () => `job-${Math.random().toString(36).slice(2, 8)}`,
    settle: async () => undefined,
  }),
}));
vi.mock("../store/jobNotes", () => ({ notifyJobSettled: () => undefined }));

const store = { projectDir: "/proj", rename: async () => undefined, remove: async () => undefined };

/** An encode that only finishes when we say so, so a QUEUED row is observable. */
function gated(): { run: (s: AbortSignal) => Promise<{ warnings?: string[] }>; open: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    run: async () => {
      await gate;
      return {};
    },
    open: () => release(),
  };
}

const submit = (filename: string, run: (s: AbortSignal) => Promise<{ warnings?: string[] }>) =>
  submitExport({
    store: store as Any,
    destPath: `/out/${filename}`,
    stagePath: `/out/${filename}`,
    filename,
    run,
  });

beforeEach(() => {
  __resetExportQueue();
  useExportJob.setState({ fraction: 0.5 } as Any);
});
afterEach(() => __resetExportQueue());

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

  it("KEEPS a failed export on the list, with its reason", async () => {
    await submit("bad.mp4", async () => {
      throw new Error("disk full");
    });
    await whenExportsSettle();
    render(<ExportQueuePane />);

    // The regression this exists for: the row used to disappear the instant it settled, so a
    // user who looked away never learned the export failed at all.
    expect(screen.getByText("bad.mp4")).toBeTruthy();
    expect(screen.getByText("disk full")).toBeTruthy();
  });

  it("keeps a completed export until it is dismissed", async () => {
    await submit("good.mp4", async () => ({}));
    await whenExportsSettle();
    render(<ExportQueuePane />);

    expect(screen.getByText("Completed")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("dismiss good.mp4"));
    expect(screen.queryByText("good.mp4")).toBeNull();
  });

  it("cancels a running export from its own row", async () => {
    const g = gated();
    let sawAbort = false;
    await submit("slow.mp4", async (signal) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
        g.open();
      });
      await g.run(signal);
      if (signal.aborted) throw new Error("export cancelled");
      return {};
    });
    render(<ExportQueuePane />);

    fireEvent.click(screen.getByLabelText("cancel slow.mp4"));
    await whenExportsSettle();
    expect(sawAbort).toBe(true);
    expect(screen.getByText("Cancelled")).toBeTruthy();
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
