// The approval bar shows what a generation may cost, beside the buttons that allow it (UJ-047).
// The price is advice: it must never delay, block or break the buttons, and it is only ever asked about a call that holds
// credits, using only what the price depends on.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingApproval } from "../api/types";

const quoteHold = vi.hoisted(() => vi.fn());
vi.mock("../api/quote", () => ({ quoteHold }));

// Stable snapshot (same reference each call) so useSyncExternalStore does not loop.
const usage = vi.hoisted(() => ({ metered: true, used: 30, limit: 150, remaining: 120, over: false }));
vi.mock("../api/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/usage")>()),
  getUsage: () => usage,
  subscribeUsage: () => () => {},
}));

import ApprovalBar from "./ApprovalBar";

const VIDEO = { prompt: "a van", model: "veo-3.1", duration: 8 };

function pending(name: string, args: Record<string, unknown> = {}): PendingApproval {
  return { call_id: "c1", name, arguments: args, rationale: "", reasoning_summary: [] };
}

function bar(p: PendingApproval, onApprove = vi.fn(), onDeny = vi.fn()) {
  return <ApprovalBar pending={p} onApprove={onApprove} onDeny={onDeny} />;
}

const settle = () => act(async () => {});

beforeEach(() => {
  quoteHold.mockReset().mockResolvedValue({ credits: 96 });
  Object.assign(usage, { metered: true, used: 30, limit: 150, remaining: 120, over: false });
});

describe("the price beside the buttons", () => {
  it("says up to how many credits the generation may spend, and how many the person has left", async () => {
    render(bar(pending("generate_video", VIDEO)));
    expect(await screen.findByText("Up to 96 credits · you have 120 left")).toBeInTheDocument();
    expect(screen.getByText("Generate a video")).toBeInTheDocument();
    expect(screen.getByText(/spends your credits/)).toBeInTheDocument();
  });

  it("asks about what the tool will send, and carries nothing of the person's", async () => {
    render(bar(pending("generate_video", { ...VIDEO, prompt: "my private prompt", name: "secret-name" })));
    await screen.findByText(/Up to 96/);
    expect(quoteHold).toHaveBeenCalledTimes(1);
    const [inputs, signal] = quoteHold.mock.calls[0];
    expect(inputs).toEqual({ proxy: "generate_video", args: { backend_id: "veo-3.1-generate-001", duration: 8 } });
    expect(JSON.stringify(inputs)).not.toMatch(/private|secret/);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("shows only the price to an account with no limit", async () => {
    usage.limit = 0;
    usage.remaining = 0;
    render(bar(pending("generate_image", { prompt: "a car", count: 2 })));
    expect(await screen.findByText("Up to 96 credits")).toBeInTheDocument();
  });
});

describe("the price never gets in the way", () => {
  it("leaves Allow and Deny working before the price arrives, and if it never does", async () => {
    quoteHold.mockReturnValue(new Promise(() => {}));
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(bar(pending("generate_video", VIDEO), onApprove, onDeny));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Up to/)).not.toBeInTheDocument();
  });

  it("says nothing about price when the server has none", async () => {
    quoteHold.mockResolvedValue(null);
    render(bar(pending("generate_video", VIDEO)));
    await waitFor(() => expect(quoteHold).toHaveBeenCalled());
    await settle();
    expect(screen.queryByText(/Up to/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
  });

  it("does not break when asking fails", async () => {
    quoteHold.mockRejectedValue(new Error("boom"));
    render(bar(pending("generate_video", VIDEO)));
    await waitFor(() => expect(quoteHold).toHaveBeenCalled());
    await settle();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
  });
});

describe("it only asks about a call that holds credits", () => {
  it.each(["video_ask", "image_ask", "vision_describe", "find_content", "extract_style", "get_page_image", "download_video"])(
    "%s settles its real cost afterwards: no price, and nobody is asked",
    async (name) => {
      render(bar(pending(name, { prompt: "p", question: "q", url: "https://example.com/v.mp4" })));
      await settle();
      expect(quoteHold).not.toHaveBeenCalled();
      expect(screen.queryByText(/Up to/)).not.toBeInTheDocument();
    },
  );

  it("does not ask about a call the tool will refuse", async () => {
    render(bar(pending("generate_image", { prompt: "p", model: "no-such-model" })));
    await settle();
    expect(quoteHold).not.toHaveBeenCalled();
  });
});

describe("it asks again only when the price would change", () => {
  it("is the same question when only the prompt differs", async () => {
    const { rerender } = render(bar(pending("generate_image", { prompt: "a car", count: 2 })));
    await screen.findByText(/Up to 96/);
    rerender(bar(pending("generate_image", { prompt: "a completely different prompt", count: 2 })));
    await settle();
    expect(quoteHold).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Up to 96/)).toBeInTheDocument();
  });

  it("is a new question when the count changes, and the old price is not shown meanwhile", async () => {
    quoteHold.mockResolvedValueOnce({ credits: 96 }).mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = render(bar(pending("generate_image", { prompt: "a car", count: 2 })));
    await screen.findByText(/Up to 96/);
    rerender(bar(pending("generate_image", { prompt: "a car", count: 4 })));
    await settle();
    expect(quoteHold).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Up to 96/)).not.toBeInTheDocument();
  });

  it("drops a price that arrives after the question was withdrawn", async () => {
    let answer: (quote: { credits: number } | null) => void = () => {};
    quoteHold.mockReset().mockReturnValueOnce(new Promise((resolve) => (answer = resolve))).mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = render(bar(pending("generate_image", { prompt: "a car", count: 2 })));
    await waitFor(() => expect(quoteHold).toHaveBeenCalledTimes(1));
    rerender(bar(pending("generate_image", { prompt: "a car", count: 4 })));
    await settle();
    answer({ credits: 96 });
    await settle();
    expect(screen.queryByText(/Up to 96/)).not.toBeInTheDocument();
  });

  it("withdraws the question when the bar goes away", async () => {
    quoteHold.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(bar(pending("generate_video", VIDEO)));
    await waitFor(() => expect(quoteHold).toHaveBeenCalled());
    const signal = quoteHold.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
