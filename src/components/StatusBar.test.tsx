// The status bar at the bottom of the window, tested through what a person sees and presses: the credits that are left
// (they were on the chat's footer line), the speech chip (it was in the top bar) and the background transcriptions
// that failed, with their exact error on hover and a Retry that reaches the indexer which owns the work.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stable snapshot (same reference each call) so useSyncExternalStore doesn't loop, which is also why the fields are
// flipped in place rather than the object being replaced.
const usageMock = vi.hoisted(() => ({
  metered: true,
  over: false,
  globalPaused: undefined as true | undefined,
  used: 10,
  limit: 100,
  remaining: 1_500_000,
  held: undefined as number | undefined,
}));
vi.mock("../api/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/usage")>()),
  getUsage: () => usageMock,
  subscribeUsage: () => () => {},
  refreshUsage: vi.fn(),
}));

import { DISCORD_URL } from "../lib/community";
import {
  __resetSpeechFailures,
  ENGINE_FAILURE_ID,
  registerSpeechRetrier,
  useSpeechFailures,
  type SpeechFailure,
} from "../store/speechFailures";
import { __resetSpeechJobs, useSpeechJobs } from "../store/speechJobs";
import StatusBar from "./StatusBar";

const OWNER = "indexer-1";

const failure = (over: Partial<SpeechFailure> = {}): SpeechFailure => ({
  id: "transcript\u0000library/interview.mp4",
  owner: OWNER,
  label: "interview.mp4",
  reason: "engine_failed",
  message: "Error: whisper-cli failed (code=-1073741819)",
  at: Date.now(),
  attempts: 1,
  willRetry: true,
  ...over,
});
const seed = (...all: SpeechFailure[]): void =>
  act(() => {
    for (const f of all) useSpeechFailures.getState().record(f);
  });
const item = (): HTMLElement => screen.getByTestId("speech-failure");

beforeEach(() => {
  usageMock.metered = true;
  usageMock.over = false;
  usageMock.globalPaused = undefined;
  usageMock.remaining = 1_500_000;
  usageMock.used = 10;
  usageMock.limit = 100;
  usageMock.held = undefined;
  __resetSpeechFailures();
  __resetSpeechJobs();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __resetSpeechFailures();
  __resetSpeechJobs();
});

describe("the credits that are left", () => {
  it("shows the balance on the right of the bar, with how much is used in its tooltip", () => {
    render(<StatusBar />);
    const credits = screen.getByText(/cr left/);
    expect(credits).toHaveAttribute("title", "10 / 100 credits used");
    expect(credits.closest(".ml-auto")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /join our discord/i })).not.toBeInTheDocument();
  });

  it("shows real fractional headroom without floating-point noise", () => {
    usageMock.remaining = 100 - 99.999;
    render(<StatusBar />);
    expect(screen.getByText("0.001 cr left")).toBeInTheDocument();
  });

  it("says in the tooltip how much of what is used is reserved for generations in progress", () => {
    Object.assign(usageMock, { used: 96, limit: 150, remaining: 54, held: 96 });
    render(<StatusBar />);
    expect(screen.getByText("54 cr left")).toHaveAttribute(
      "title",
      "96 / 150 credits used (96 reserved for generations in progress)",
    );
  });

  it("shows the shared pause without pretending the user's remaining credit is zero", () => {
    usageMock.over = true;
    usageMock.globalPaused = true;
    usageMock.remaining = 97;
    render(<StatusBar />);
    expect(screen.getByText("AI paused - 97 cr left")).toBeInTheDocument();
    expect(screen.queryByText(/0 cr/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /join our discord/i })).not.toBeInTheDocument();
  });

  // A bare "0" states the dead end and withholds the only way out of it. Asserted by clicking through to the
  // open, not by reading the label.
  it("turns into a way out once the balance is spent", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    Object.assign(usageMock, { over: true, used: 150, limit: 150, remaining: 0, held: 30 });
    render(<StatusBar />);
    const out = screen.getByRole("button", { name: /join our discord/i });
    expect(out).toHaveAttribute(
      "title",
      "150 / 150 credits used (30 reserved for generations in progress)",
    );
    fireEvent.click(out);
    return vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(DISCORD_URL, "_blank", "noopener,noreferrer"),
    );
  });

  it("shows nothing for an account that is not metered", () => {
    usageMock.metered = false;
    render(<StatusBar />);
    expect(screen.queryByText(/cr left/)).not.toBeInTheDocument();
  });
});

describe("the speech chip", () => {
  const seedRun = (): void =>
    act(() =>
      useSpeechJobs.getState().add({
        id: "a",
        purpose: "index",
        label: "Interview 2.mp4",
        work: [],
        spanS: 1200,
        phase: "running",
        stop: null,
        enqueuedAt: Date.now() - 60_000,
        startedAt: Date.now() - 60_000,
        firstWordsAt: Date.now() - 50_000,
        endedAt: null,
        doneS: 576,
        rate: 1 / 0.3,
        etaS: 2080,
        facts: {
          backend: "cpu",
          gpuHeld: false,
          noGpu: true,
          cores: 4,
          threads: 2,
          exportsBusy: false,
        },
      }),
    );

  it("draws nothing while no speech job is going", () => {
    render(<StatusBar />);
    expect(screen.queryByTestId("speech-chip")).not.toBeInTheDocument();
  });

  it("is on the left of the bar, and its popover opens upward, into the window and not off its edge", () => {
    seedRun();
    render(<StatusBar />);
    const chip = screen.getByTestId("speech-chip");
    expect(chip).toHaveTextContent("Transcribing 48% · slow: about 35 min left");
    expect(chip.closest('[data-testid="status-bar"]')).toBeInTheDocument();
    expect(chip.closest(".ml-auto")).toBeNull();
    fireEvent.click(chip);
    const popover = screen.getByTestId("speech-popover");
    expect(popover).toHaveClass("bottom-full");
    expect(popover).not.toHaveClass("mt-1");
  });
});

describe("a background transcription that failed", () => {
  it("says nothing while nothing failed", () => {
    render(<StatusBar />);
    expect(screen.queryByTestId("speech-failure")).not.toBeInTheDocument();
  });

  it("names the file in the bar, and shows the exact error and what happens next on hover", () => {
    seed(failure());
    render(<StatusBar />);
    expect(item()).toHaveTextContent("Transcription failed: interview.mp4");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.mouseEnter(item());
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("interview.mp4");
    expect(tip).toHaveTextContent("Error: whisper-cli failed (code=-1073741819)");
    expect(tip).toHaveTextContent(/Tried once\. It is tried again by itself/);
    fireEvent.mouseLeave(item());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("says when the app has stopped trying, so Retry is the only way", () => {
    seed(failure({ attempts: 3, willRetry: false }));
    render(<StatusBar />);
    fireEvent.mouseEnter(item());
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Tried 3 times, and then stopped/);
  });

  it("counts several, and lists the error of each", () => {
    seed(
      failure(),
      failure({ id: "b", label: "talk.m4a", message: "Error: file not found: talk.m4a" }),
    );
    render(<StatusBar />);
    expect(item()).toHaveTextContent("Transcription failed (2)");
    fireEvent.mouseEnter(item());
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("whisper-cli failed");
    expect(tip).toHaveTextContent("file not found: talk.m4a");
  });

  it("says the engine cannot start when that is the failure, and that nothing is transcribed until it does", () => {
    seed(
      failure({
        id: ENGINE_FAILURE_ID,
        label: null,
        reason: "engine_unavailable",
        message: "the speech engine could not start",
        attempts: 3,
        willRetry: false,
      }),
    );
    render(<StatusBar />);
    expect(item()).toHaveTextContent("Transcription is off: the speech engine cannot start");
    fireEvent.mouseEnter(item());
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Nothing is transcribed on this PC/);
  });

  it("keeps the details open when the headline is clicked, to read or copy them, until Escape", () => {
    seed(failure());
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId("speech-failure-headline"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("whisper-cli failed");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("Retry hands the work back to the indexer that owns it, and the notice goes as the work starts again", () => {
    const retry = vi.fn((f: SpeechFailure) => useSpeechFailures.getState().clear(f.owner, f.id));
    const off = registerSpeechRetrier(OWNER, retry);
    seed(failure());
    render(<StatusBar />);
    fireEvent.click(screen.getByRole("button", { name: "Retry transcription" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0][0].message).toContain("whisper-cli failed");
    expect(screen.queryByTestId("speech-failure")).not.toBeInTheDocument();
    off();
  });

  it("stays until the indexer starts the work again, and shows it again when that fails", () => {
    const retry = vi.fn();
    const off = registerSpeechRetrier(OWNER, retry);
    seed(failure());
    render(<StatusBar />);
    fireEvent.click(screen.getByRole("button", { name: "Retry transcription" }));
    // Pressing Retry only asks: the bar does not say it worked before the indexer has started it again.
    expect(retry).toHaveBeenCalledTimes(1);
    expect(item()).toHaveTextContent("Transcription failed: interview.mp4");
    // The indexer started it again and it failed again: it writes the failure again, with the attempts counted on.
    seed(failure({ attempts: 2 }));
    expect(useSpeechFailures.getState().failures).toHaveLength(1);
    fireEvent.mouseEnter(item());
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Tried 2 times/);
    off();
  });

  it("is closed by the cross, and starts nothing", () => {
    const retry = vi.fn();
    const off = registerSpeechRetrier(OWNER, retry);
    seed(failure());
    render(<StatusBar />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("speech-failure")).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
    off();
  });
});
