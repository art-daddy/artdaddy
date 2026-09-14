import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ToolCalls from "./ToolCalls";
import { summarizeCall, type SummaryContext, type ToolCallView } from "./toolSummary";

const ctx: SummaryContext = { trackLabel: (id) => (id === "trk_a" ? "v1" : id) };

function call(name: string, args = {}, result?: Record<string, unknown>): ToolCallView {
  const { text, running, ok, error } = summarizeCall(name, args, result, ctx);
  return { name, args, result, text, running, ok, error };
}

/** The same call on a turn that has ENDED — Stop, a supersede, or a reload of history. */
function deadCall(name: string, args = {}): ToolCallView {
  const { text, running, ok, interrupted, error } = summarizeCall(
    name,
    args,
    undefined,
    ctx,
    false,
  );
  return { name, args, text, running, ok, interrupted, error };
}

describe("a call the turn never answered", () => {
  // Reported from production: spinners still turning long after the turn ended. A call was
  // rendered "in flight" purely because it had no result, so pressing Stop mid-tool left one
  // spinning forever — and since the transcript is persisted, reopening the project spun every
  // unanswered call in the whole history. Only a turn still streaming can have a live call.
  it("stops spinning once the turn is over", () => {
    const { container } = render(<ToolCalls calls={[deadCall("crop_image")]} ctx={ctx} />);
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("still spins while the turn IS live, so the fix did not just delete the spinner", () => {
    const { container } = render(<ToolCalls calls={[call("crop_image")]} ctx={ctx} />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("says it was stopped rather than claiming it succeeded", () => {
    render(<ToolCalls calls={[deadCall("crop_image")]} ctx={ctx} />);
    expect(screen.getByText(/stopped/i)).toBeInTheDocument();
    // A tick would be a lie: the crop never happened.
    expect(screen.queryByText("✓")).toBeNull();
  });

  it("is not counted as a failure — nothing reported an error", () => {
    render(<ToolCalls calls={[deadCall("export")]} ctx={ctx} />);
    expect(screen.queryByText("✗")).toBeNull();
  });
});

describe("ToolCalls", () => {
  it("shows a sentence, and neither the tool name nor its payload", () => {
    // The reported problem: `set_clip_properties` plus a JSON blob told the user nothing.
    const { container } = render(
      <ToolCalls
        calls={[
          call("set_clip_properties", { clip_ids: ["c1"], opacity: 0.5 }, { ok: true, updated: 1 }),
        ]}
        ctx={ctx}
      />,
    );

    expect(screen.getByText("Updated 1 clip")).toBeInTheDocument();
    expect(screen.queryByText("set_clip_properties")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("hides the payload rather than discarding it — one click brings it back", () => {
    const args = { clip_ids: ["c1"], opacity: 0.5 };
    render(
      <ToolCalls calls={[call("set_clip_properties", args, { ok: true, updated: 1 })]} ctx={ctx} />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("set_clip_properties")).toBeInTheDocument();
    expect(screen.getByText(/"opacity": 0\.5/)).toBeInTheDocument();
  });

  it("collapses again", () => {
    render(<ToolCalls calls={[call("get_timeline", {}, { ok: true })]} ctx={ctx} />);
    const toggle = screen.getByRole("button");

    fireEvent.click(toggle);
    expect(screen.getByText("get_timeline")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText("get_timeline")).toBeNull();
  });

  it("puts a failure's real message on screen without making the user expand", () => {
    // "Couldn't export the video" alone leaves them nowhere to go.
    render(
      <ToolCalls calls={[call("export", {}, { ok: false, error: "no such encoder" })]} ctx={ctx} />,
    );

    expect(screen.getByText("Couldn't export the video")).toBeInTheDocument();
    expect(screen.getByText("no such encoder")).toBeInTheDocument();
  });

  it("reads as in-progress while a call is still running", () => {
    render(<ToolCalls calls={[call("export", {})]} ctx={ctx} />);
    expect(screen.getByText("Exporting")).toBeInTheDocument();
  });

  it("shows one line for a folded run, and every call once expanded", () => {
    const calls = [
      call("add_clips", {}, { ok: true, count: 2, track_id: "trk_a" }),
      call("add_clips", {}, { ok: true, count: 3, track_id: "trk_a" }),
    ];
    render(<ToolCalls calls={calls} ctx={ctx} />);

    expect(screen.getByText("Added 5 clips to v1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText("add_clips")).toHaveLength(2);
  });

  it("renders nothing when there is nothing to say", () => {
    const { container } = render(<ToolCalls calls={[]} ctx={ctx} />);
    expect(container.firstChild).toBeNull();
  });
});
