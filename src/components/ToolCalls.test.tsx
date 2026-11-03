import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CreditLimitError } from "../api/usage";
import { DISCORD_URL } from "../lib/community";
import { ClientToolRegistry } from "../tools/registry";
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

/** A call that has its answer, as the chat builds the row for it. */
function answered(name: string, result: Record<string, unknown>): ToolCallView {
  const { text, running, ok, interrupted, pending, error } = summarizeCall(name, {}, result, ctx);
  return { name, args: {}, result, text, running, ok, interrupted, pending, error };
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

describe("a call that Stop ended", () => {
  const stoppedByThePerson = { ok: false, error: "cancelled" };

  it("shows the neutral stopped mark: not the cross that means failed, not the tick that means done", () => {
    render(<ToolCalls calls={[answered("inspect_media", stoppedByThePerson)]} ctx={ctx} />);
    expect(screen.getByTitle("stopped before it finished")).toBeInTheDocument();
    expect(screen.queryByText("✗")).toBeNull();
    expect(screen.queryByText("✓")).toBeNull();
    expect(screen.getByText("Looking at media — stopped")).toBeInTheDocument();
  });

  it("does not print an error line under it, or the word the tools answer with", () => {
    const { container } = render(
      <ToolCalls calls={[answered("inspect_media", stoppedByThePerson)]} ctx={ctx} />,
    );
    expect(container.querySelector(".text-red-300\\/80")).toBeNull();
    expect(screen.queryByText("cancelled")).toBeNull();
    expect(screen.queryByText(/Couldn't/)).toBeNull();
  });

  it("does not change how a real failure looks", () => {
    render(
      <ToolCalls
        calls={[answered("inspect_media", { ok: false, error: "disk full" })]}
        ctx={ctx}
      />,
    );
    expect(screen.getByText("✗")).toBeInTheDocument();
    expect(screen.getByText("Couldn't look at media")).toBeInTheDocument();
    expect(screen.getByText("disk full")).toBeInTheDocument();
  });
});

describe("a call that is still going in the background", () => {
  const waiting = {
    ok: false,
    pending: true,
    status: "in_progress",
    error: "Captions were NOT added: the speech is still being transcribed.",
  };

  it("shows a neutral mark: not the tick that means done, and not the cross that means failed", () => {
    render(<ToolCalls calls={[answered("add_captions", waiting)]} ctx={ctx} />);
    expect(screen.queryByText("✓")).toBeNull();
    expect(screen.queryByText("✗")).toBeNull();
    expect(screen.getByText("…")).toBeInTheDocument();
    expect(screen.getByText(/not finished yet/)).toBeInTheDocument();
  });

  it("does not print the sentence written for the model", () => {
    render(<ToolCalls calls={[answered("add_captions", waiting)]} ctx={ctx} />);
    expect(screen.queryByText(/Captions were NOT added/)).toBeNull();
  });

  it("is not hidden behind a failure elsewhere in the same run", () => {
    render(
      <ToolCalls
        calls={[
          answered("add_captions", waiting),
          answered("export", { ok: false, error: "disk full" }),
        ]}
        ctx={ctx}
      />,
    );
    expect(screen.getByText("✗")).toBeInTheDocument();
    expect(screen.queryByText("…")).toBeNull();
  });
});

describe("a call stopped at its time limit", () => {
  const modelSentence =
    "video_find_moment did not finish within 5 minutes and was stopped. Nothing was changed. Do not repeat the same call: tell the user it took too long.";
  const timedOut = { ok: false, timed_out: true, bound_s: 300, error: modelSentence };

  it("tells the person what happened in plain words, without the tool's identifier or our instructions to the model", () => {
    render(<ToolCalls calls={[answered("video_find_moment", timedOut)]} ctx={ctx} />);
    expect(screen.getByText("✗")).toBeInTheDocument();
    expect(
      screen.getByText("It took longer than 5 minutes, so it was stopped. Nothing was changed."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/video_find_moment/)).toBeNull();
    expect(screen.queryByText(/Do not repeat/)).toBeNull();
  });

  it("leaves the model's own sentence untouched: the row is for the person, the result for the model", () => {
    answered("video_find_moment", timedOut);
    expect(timedOut.error).toBe(modelSentence);
  });
});

describe("a call that ran out of credits", () => {
  it("preserves an unaffordable request explanation after registry serialization", async () => {
    const registry = new ClientToolRegistry().register("generate_image", () => {
      throw new CreditLimitError({
        used: 99,
        limit: 100,
        remaining: 1,
        requested: 3,
        scope: "user",
      });
    });
    const result = (await registry.run("generate_image", {})) as Record<string, unknown>;
    render(<ToolCalls calls={[call("generate_image", {}, result)]} ctx={ctx} />);
    expect(screen.getByText(/3 credits.*1 credit remains/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /discord/i })).not.toBeInTheDocument();
  });
  // Through the REAL registry from the REAL error: a hand-written string would agree with the
  // matcher whether or not the text that reaches this row still carries the mark.
  async function outOfCredits(): Promise<ToolCallView> {
    const reg = new ClientToolRegistry().register("generate_image", () => {
      throw new CreditLimitError({ used: 500, limit: 500 });
    });
    return call(
      "generate_image",
      {},
      (await reg.run("generate_image", {})) as Record<string, unknown>,
    );
  }

  it("offers the Discord, and the offer actually opens it", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<ToolCalls calls={[await outOfCredits()]} ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: /join our discord/i }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(DISCORD_URL, "_blank", "noopener,noreferrer"),
    );
    open.mockRestore();
  });

  it("shows a person a sentence, not the instructions written for the model", async () => {
    render(<ToolCalls calls={[await outOfCredits()]} ctx={ctx} />);
    expect(screen.getByText(/out of credits/i)).toBeInTheDocument();
    expect(screen.queryByText(/do not retry/i)).not.toBeInTheDocument();
  });

  it("keeps the offer once the row is expanded", async () => {
    render(<ToolCalls calls={[await outOfCredits()]} ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByRole("button", { name: /join our discord/i })).toBeInTheDocument();
  });

  it("is not offered for a failure more credits cannot fix", () => {
    render(
      <ToolCalls
        calls={[call("generate_image", {}, { ok: false, error: "content filter" })]}
        ctx={ctx}
      />,
    );
    expect(screen.queryByRole("button", { name: /discord/i })).not.toBeInTheDocument();
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
