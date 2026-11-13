// What the stage says while a preview copy is built (UJ-091).
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useProxyJobs } from "../store/proxyJobs";
import PreparingPill from "./PreparingPill";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const timeline = {
  tracks: [
    {
      clips: [
        { media_ref: "media_a", timeline_in: 0, timeline_out: 100 },
        { media_ref: "media_b", timeline_in: 100, timeline_out: 200 },
      ],
    },
  ],
} as Any;

const begin = (source: string, name: string, refs: string[]) =>
  act(() => useProxyJobs.getState().begin(source, name, refs, 0));
const report = (source: string, outMs: number, totalMs: number, speed: number, now: number) =>
  act(() => useProxyJobs.getState().progress(source, { outMs, totalMs, speed }, now));

beforeEach(() => useProxyJobs.setState({ jobs: [] }));

describe("PreparingPill", () => {
  it("says nothing when nothing is being prepared", () => {
    const { container } = render(<PreparingPill importing={false} timeline={timeline} frame={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the old line between files of a batch and for copies that report nothing", () => {
    render(<PreparingPill importing timeline={timeline} frame={0} />);
    expect(screen.getByText("Processing imported media…")).toBeInTheDocument();
  });

  it("names the file, the percent, the time left, and says editing can go on", () => {
    begin("library/media_a.mp4", "drone_0412.mov", ["media_a"]);
    report("library/media_a.mp4", 42_000, 100_000, 2, 5_000);
    render(<PreparingPill importing timeline={timeline} frame={0} />);
    expect(screen.getByRole("group", { name: "preparing preview" })).toBeInTheDocument();
    expect(screen.getByText(/Preparing preview of drone_0412\.mov/)).toBeInTheDocument();
    expect(screen.getByTestId("preparing-detail")).toHaveTextContent("42% · about 30 s left");
    expect(screen.getByText("You can keep editing.")).toBeInTheDocument();
    expect(screen.getByTestId("preparing-bar")).toHaveStyle({ width: "42%" });
    // a progress bar for a screen reader, not a live region that reads every change out
    expect(
      screen.getByRole("progressbar", { name: "Preparing preview of drone_0412.mov" }),
    ).toHaveAttribute("aria-valuenow", "42");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("Processing imported media…")).not.toBeInTheDocument();
  });

  it("follows the copy as it moves, and goes when the copy is done", () => {
    begin("library/media_a.mp4", "a.mov", ["media_a"]);
    report("library/media_a.mp4", 10_000, 100_000, 2, 5_000);
    const view = render(<PreparingPill importing timeline={timeline} frame={0} />);
    expect(screen.getByTestId("preparing-detail")).toHaveTextContent("10%");
    report("library/media_a.mp4", 80_000, 100_000, 2, 9_000);
    expect(screen.getByTestId("preparing-detail")).toHaveTextContent("80% · about 10 s left");
    act(() => useProxyJobs.getState().finish("library/media_a.mp4"));
    // the drain's flag is still up for the rest of the batch: the old line, not a gap
    expect(screen.getByText("Processing imported media…")).toBeInTheDocument();
    view.rerender(<PreparingPill importing={false} timeline={timeline} frame={0} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("with no length for the source shows no percent and no time, only what is being made", () => {
    begin("library/media_a.mp4", "odd.mov", ["media_a"]);
    report("library/media_a.mp4", 3_000, 0, 1, 9_000);
    render(<PreparingPill importing timeline={timeline} frame={0} />);
    expect(screen.getByText(/Preparing preview of odd\.mov/)).toBeInTheDocument();
    expect(screen.queryByTestId("preparing-detail")).not.toBeInTheDocument();
    expect(screen.getByTestId("preparing-bar").className).toContain("animate-pulse");
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow"); // indeterminate: no number to read out
  });

  it("with two copies at once names the one under the playhead, and says which of them it is", () => {
    begin("library/media_a.mp4", "first.mov", ["media_a"]);
    begin("library/media_b.mp4", "second.mov", ["media_b"]);
    const view = render(<PreparingPill importing timeline={timeline} frame={10} />);
    expect(screen.getByText(/Preparing preview of first\.mov/)).toBeInTheDocument();
    expect(screen.getByText(/\(1 of 2\)/)).toBeInTheDocument();
    view.rerender(<PreparingPill importing timeline={timeline} frame={150} />); // playhead on clip b
    expect(screen.getByText(/Preparing preview of second\.mov/)).toBeInTheDocument();
    expect(screen.getByText(/\(2 of 2\)/)).toBeInTheDocument();
    view.rerender(<PreparingPill importing timeline={timeline} frame={5000} />); // past every clip: the one that began first
    expect(screen.getByText(/Preparing preview of first\.mov/)).toBeInTheDocument();
  });
});
