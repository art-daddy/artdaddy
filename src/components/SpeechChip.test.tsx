// The top-bar chip for a speech job (S2-04 = D), tested through what a person sees and can press: the
// words of each state (the owner's pictures), when the chip shows (a run once it has lasted 15 s, a
// stopped one at once, a waiting one only when an export is why), what Cancel reaches, and what the
// clock is allowed to keep running. Time is faked: the chip's 1-second tick is part of what is tested.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSpeechJobs,
  registerCanceller,
  useSpeechJobs,
  type SpeechFacts,
  type SpeechJob,
  type SpeechPurpose,
} from "../store/speechJobs";
import { CANCEL_NOTE } from "../tools/slowNote";
import SpeechChip from "./SpeechChip";

const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);
const FILE = "Interview 2.mp4";
const state = () => useSpeechJobs.getState();

type Over = Partial<Omit<SpeechJob, "facts">> & { facts?: Partial<SpeechFacts> };
// A run that has been going for 20 s with nothing measured; every test starts from it.
function job(id: string, over: Over = {}): SpeechJob {
  const { facts, ...rest } = over;
  return {
    id,
    purpose: "index",
    label: FILE,
    spanS: 1200,
    phase: "running",
    stop: null,
    enqueuedAt: T0 - 20_000,
    startedAt: T0 - 20_000,
    firstWordsAt: T0 - 15_000,
    endedAt: null,
    doneS: 0,
    rate: null,
    etaS: null,
    ...rest,
    facts: {
      backend: "gpu",
      gpuHeld: false,
      noGpu: false,
      cores: 4,
      threads: 2,
      exportsBusy: false,
      ...facts,
    },
  };
}
// The numbers of the owner's pictures: `pct` of `spanS` seconds done at `speed` times real time.
const measured = (spanS: number, pct: number, speed: number) => {
  const doneS = (spanS * pct) / 100;
  return { spanS, doneS, rate: 1 / speed, etaS: (spanS - doneS) / speed };
};
const FAST = measured(1800, 40, 8.1); // D-1: "Transcribing 40% · about 2 min left"
const SLOW = measured(1200, 48, 0.3); // D-2a: "... slow: about 35 min left"
const SPAN = measured(180, 40, 0.3); // D-4: a request's run over 3 minutes of the file
const CPU4 = { backend: "cpu", cores: 4, threads: 2 } as const;

const seed = (...jobs: SpeechJob[]) =>
  act(() => {
    for (const j of jobs) state().add(j);
  });
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });
const chip = () => screen.getByTestId("speech-chip");
const popover = () => screen.getByTestId("speech-popover");
const openPopover = () => {
  fireEvent.click(chip());
  return within(popover());
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  __resetSpeechJobs();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __resetSpeechJobs();
});

describe("when the chip shows", () => {
  it("draws nothing, and starts no timer, while there is no job", () => {
    const { container } = render(<SpeechChip />);
    expect(container).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a run that is going only once it has lasted 15 s: a short transcription never flickers a chip in", () => {
    seed(job("a", { startedAt: T0, enqueuedAt: T0, ...FAST }));
    render(<SpeechChip />);
    expect(screen.queryByTestId("speech-chip")).toBeNull();
    advance(14_900);
    expect(screen.queryByTestId("speech-chip")).toBeNull();
    advance(200);
    expect(chip()).toBeInTheDocument();
  });

  it("never shows a run that ends within 15 s, and leaves no timer behind", () => {
    render(<SpeechChip />);
    seed(job("a", { startedAt: T0, enqueuedAt: T0, ...FAST }));
    expect(screen.queryByTestId("speech-chip")).toBeNull();
    advance(8_000);
    expect(screen.queryByTestId("speech-chip")).toBeNull();
    act(() => state().end("a", "done", Date.now()));
    advance(30_000);
    expect(screen.queryByTestId("speech-chip")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a run that was already going for a while the moment it is mounted", () => {
    seed(job("a", { startedAt: T0 - 60_000, ...FAST }));
    render(<SpeechChip />);
    expect(chip()).toBeInTheDocument();
  });

  it.each<SpeechPurpose>(["index", "captions", "look", "transcript"])(
    "shows a %s run once it has lasted 15 s: Cancel must reach what a request started too",
    (purpose) => {
      render(<SpeechChip />);
      seed(job("a", { purpose, startedAt: T0, enqueuedAt: T0, ...SPAN }));
      expect(screen.queryByTestId("speech-chip")).toBeNull();
      advance(15_100);
      expect(chip()).toBeInTheDocument();
    },
  );

  it("shows a stopped job at once, even with a run that is too young to show beside it", () => {
    seed(
      job("young", { startedAt: T0, enqueuedAt: T0, ...FAST }),
      job("gone", { phase: "stopped", stop: "cancelled", endedAt: T0 - 1_000 }),
    );
    render(<SpeechChip />);
    expect(chip()).toHaveTextContent("Transcription stopped");
  });

  it("shows a waiting job only while an export is why it waits", () => {
    seed(job("w", { phase: "waiting", startedAt: null, facts: { exportsBusy: false } }));
    render(<SpeechChip />);
    expect(screen.queryByTestId("speech-chip")).toBeNull();
    act(() => state().patch("w", { facts: { exportsBusy: true } }));
    expect(chip().textContent).toBe("Transcription waiting for the export");
    act(() => state().patch("w", { facts: { exportsBusy: false } }));
    expect(screen.queryByTestId("speech-chip")).toBeNull();
  });

  it("shows the run that was started first when two are going", () => {
    seed(
      job("late", { startedAt: T0 - 20_000, label: "Late.mp4", ...FAST }),
      job("early", { startedAt: T0 - 40_000, label: "Early.mp4", ...FAST }),
    );
    render(<SpeechChip />);
    expect(openPopover().getByText("Transcribing Early.mp4")).toBeInTheDocument();
  });
});

describe("what the chip says", () => {
  const CASES: ReadonlyArray<[string, SpeechJob, string]> = [
    ["a fast run (D-1)", job("a", FAST), "Transcribing 40% · about 2 min left"],
    [
      "a slow run (D-2a)",
      job("a", { ...SLOW, facts: CPU4 }),
      "Transcribing 48% · slow: about 35 min left",
    ],
    [
      "a run a request started (D-4)",
      job("a", { ...SPAN, purpose: "captions", facts: CPU4 }),
      "Transcribing 40% · slow: about 6 min left",
    ],
    [
      "an engine that has said no word yet",
      job("a", { phase: "starting", firstWordsAt: null }),
      "Transcribing · starting",
    ],
    ["words coming, nothing measured yet", job("a", { doneS: 36 }), "Transcribing 3%"],
    ["a run whose length is not known", job("a", { spanS: null, doneS: 36 }), "Transcribing…"],
    [
      "a run that waits for an export",
      job("a", { phase: "waiting", startedAt: null, facts: { exportsBusy: true } }),
      "Transcription waiting for the export",
    ],
    [
      "a run the person stopped (D-3)",
      job("a", { phase: "stopped", stop: "cancelled", endedAt: T0 }),
      "Transcription stopped",
    ],
    [
      "a run the live check stopped",
      job("a", { phase: "stopped", stop: "too_slow", endedAt: T0 }),
      "Transcription stopped",
    ],
  ];
  it.each(CASES)("%s", (_name, j, text) => {
    seed(j);
    render(<SpeechChip />);
    expect(chip().textContent).toBe(text);
  });

  it("claims no time before audio moves: no time left while starting, none until etaS is measured", () => {
    seed(job("a", { phase: "starting", firstWordsAt: null }));
    render(<SpeechChip />);
    expect(chip().textContent).not.toMatch(/left|about|slow/);
    act(() => state().patch("a", { phase: "running", doneS: 60 }));
    expect(chip().textContent).toBe("Transcribing 5%");
    act(() => state().patch("a", { ...FAST }));
    expect(chip().textContent).toBe("Transcribing 40% · about 2 min left");
  });

  it("never says more than 100%", () => {
    seed(job("a", { spanS: 600, doneS: 612 }));
    render(<SpeechChip />);
    expect(chip().textContent).toBe("Transcribing 100%");
  });

  // Slow is "slower than real time": a rate (seconds of work per second of audio) over 1.
  it.each([
    [0.12, false],
    [0.99, false],
    [1, false],
    [1.01, true],
    [3.3, true],
  ])("rate %s: slow is %s, in the colour, the dot and the word", (rate, slow) => {
    seed(job("a", { spanS: 1200, doneS: 600, rate, etaS: 600 * rate }));
    render(<SpeechChip />);
    const dot = chip().querySelector("[aria-hidden]");
    expect(chip().classList.contains("text-amber-400"), "amber text").toBe(slow);
    expect(chip().classList.contains("text-accent"), "accent text").toBe(!slow);
    expect(dot?.classList.contains("animate-pulse"), "a pulsing dot is the fast one").toBe(!slow);
    expect(chip().textContent?.includes("slow:"), "the word").toBe(slow);
  });

  it("is grey, with no pulse, once it has stopped or while it waits", () => {
    seed(job("a", { phase: "stopped", stop: "cancelled", endedAt: T0 }));
    render(<SpeechChip />);
    expect(chip()).toHaveClass("text-neutral-400");
    expect(chip().querySelector("[aria-hidden]")).not.toHaveClass("animate-pulse");
  });

  it("keeps the top bar whole in a narrow window: the chip is the one item that gives way, and its text is cut", () => {
    // happy-dom has no layout, so this pins the classes that do it; the real layout was measured in Edge.
    seed(job("a", { ...SLOW, facts: CPU4, label: "A".repeat(200) }));
    render(<SpeechChip />);
    const box = chip().parentElement;
    expect(box?.className).toMatch(/\bmax-w-\[[\d.]+rem\]/);
    expect(box).toHaveClass("!shrink");
    expect(chip()).toHaveClass("w-full", "min-w-0");
    expect(chip().querySelector(".truncate")?.textContent).toBe(
      "Transcribing 48% · slow: about 35 min left",
    );
    const title = openPopover().getByText(`Transcribing ${"A".repeat(200)}`);
    expect(title).toHaveClass("truncate", "min-w-0");
  });
});

describe("the popover", () => {
  it("says, for a fast run, what it is, how far, how fast and where, and nothing about slowness (D-1b)", () => {
    seed(job("a", FAST));
    render(<SpeechChip />);
    const p = openPopover();
    expect(screen.getByRole("dialog", { name: "transcription" })).toBe(popover());
    expect(p.getByText("Transcribing Interview 2.mp4")).toBeInTheDocument();
    expect(p.getByText("40% · about 2 min left")).toBeInTheDocument();
    expect(p.getByRole("progressbar", { name: "transcription progress" })).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
    expect(p.getByText("Speed")).toBeInTheDocument();
    expect(p.getByText("8.1× (1 min of audio takes about 7 s)")).toBeInTheDocument();
    expect(p.getByText("Running on")).toBeInTheDocument();
    expect(p.getByText("your graphics chip")).toBeInTheDocument();
    expect(p.queryByText(/^Slow:/)).toBeNull();
    expect(p.queryByText(CANCEL_NOTE)).toBeNull();
    expect(p.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("adds the amber note and the Cancel line for a slow run on the processor (D-2)", () => {
    seed(job("a", { ...SLOW, facts: CPU4 }));
    render(<SpeechChip />);
    const p = openPopover();
    const note = p.getByText(
      "Slow: this will take a while because speech is running on your processor (no graphics chip the app can use was found) and this PC has only 4 processor cores. Closing other programs helps a little.",
    );
    expect(note).toHaveClass("text-amber-300");
    expect(p.getByText(CANCEL_NOTE)).toBeInTheDocument();
    expect(p.getByText("48% · about 35 min left")).toBeInTheDocument();
    expect(p.getByText("0.3× (1 min of audio takes about 3 min)")).toBeInTheDocument();
    expect(p.getByText("your processor, 2 of 4 cores")).toBeInTheDocument();
  });

  it("names the export when one runs at the same time (D-2b)", () => {
    seed(job("a", { ...SLOW, facts: { ...CPU4, exportsBusy: true } }));
    render(<SpeechChip />);
    expect(
      openPopover().getByText(
        "Slow: this will take a while because speech is running on your processor (no graphics chip the app can use was found) and an export is running at the same time. It should speed up when the export finishes.",
      ),
    ).toBeInTheDocument();
  });

  it("says nothing about why when no reason is a fact: 'on this PC'", () => {
    seed(job("a", { ...SLOW, facts: { backend: "gpu", cores: 16 } }));
    render(<SpeechChip />);
    expect(openPopover().getByText("Slow: this will take a while on this PC.")).toBeInTheDocument();
  });

  it.each<[SpeechPurpose, number | null, string]>([
    ["index", 1200, "Transcribing Interview 2.mp4"],
    ["captions", 180, "Captions: 3 min of Interview 2.mp4"],
    ["look", 180, "Transcribing 3 min of Interview 2.mp4"],
    ["transcript", 180, "Transcribing 3 min of Interview 2.mp4"],
    ["captions", 45, "Captions: 45 s of Interview 2.mp4"],
    ["captions", null, "Captions: Interview 2.mp4"],
    ["look", null, "Transcribing Interview 2.mp4"],
  ])("titles a %s run over %s s by what it is for: %s", (purpose, spanS, title) => {
    seed(job("a", { purpose, spanS, doneS: 0 }));
    render(<SpeechChip />);
    expect(openPopover().getByText(title)).toBeInTheDocument();
  });

  it("shows no speed row before the rate is measured, and no time before etaS is known", () => {
    seed(job("a", { phase: "starting", firstWordsAt: null, facts: { backend: null } }));
    render(<SpeechChip />);
    const p = openPopover();
    expect(p.getByText("starting…")).toBeInTheDocument();
    expect(p.queryByText("Speed")).toBeNull();
    expect(p.queryByText("Running on")).toBeNull();
    expect(popover().textContent).not.toMatch(/left|about|%/);
    expect(p.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    act(() => state().patch("a", { phase: "running", doneS: 120, facts: { backend: "cpu" } }));
    expect(p.getByText("10%")).toBeInTheDocument();
    expect(p.queryByText("Speed")).toBeNull();
    expect(popover().textContent).not.toMatch(/left|about/);
    expect(p.getByText("your processor, 2 of 4 cores")).toBeInTheDocument();

    act(() => state().patch("a", { rate: 2, etaS: 2160 }));
    expect(p.getByText("0.5× (1 min of audio takes about 2 min)")).toBeInTheDocument();
    expect(p.getByText("10% · about 36 min left")).toBeInTheDocument();
  });

  it("says how many more wait, and not the one it shows", () => {
    seed(job("a", FAST));
    render(<SpeechChip />);
    const p = openPopover();
    expect(p.queryByText(/more waiting/)).toBeNull();
    seed(
      job("w1", { phase: "waiting", startedAt: null }),
      job("w2", { phase: "waiting", startedAt: null }),
    );
    expect(p.getByText("2 more waiting")).toBeInTheDocument();
    act(() => state().dismiss("w1"));
    expect(p.getByText("1 more waiting")).toBeInTheDocument();
  });

  it("tells a waiting job what it waits for, and offers no Cancel for a run that has not started", () => {
    seed(
      job("a", { phase: "waiting", startedAt: null, facts: { exportsBusy: true } }),
      job("b", { phase: "waiting", startedAt: null }),
    );
    render(<SpeechChip />);
    const p = openPopover();
    expect(screen.getByRole("dialog", { name: "transcription waiting" })).toBe(popover());
    expect(p.getByText("Transcribing Interview 2.mp4")).toBeInTheDocument();
    expect(p.getByText("waiting for the export")).toBeInTheDocument();
    expect(p.getByText("1 more waiting")).toBeInTheDocument();
    expect(p.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("opens and closes like the account menu: a click, Escape (focus goes back), a click away", () => {
    seed(job("a", FAST));
    render(<SpeechChip />);
    expect(chip()).toHaveAttribute("aria-haspopup", "dialog");
    expect(chip()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("speech-popover")).toBeNull();

    fireEvent.click(chip());
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    expect(popover()).toHaveAttribute("role", "dialog");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("speech-popover")).toBeNull();
    expect(chip()).toHaveAttribute("aria-expanded", "false");
    expect(chip()).toHaveFocus();

    fireEvent.click(chip());
    fireEvent.click(screen.getByTestId("speech-popover-backdrop"));
    expect(screen.queryByTestId("speech-popover")).toBeNull();

    fireEvent.click(chip());
    fireEvent.click(chip());
    expect(screen.queryByTestId("speech-popover")).toBeNull();
  });

  it("closes with its job, and does not open by itself for the next one", () => {
    seed(job("a", FAST));
    render(<SpeechChip />);
    fireEvent.click(chip());
    act(() => state().dismiss("a"));
    expect(screen.queryByTestId("speech-chip")).toBeNull();
    expect(screen.queryByTestId("speech-popover")).toBeNull();
    seed(job("b", FAST));
    expect(chip()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("speech-popover")).toBeNull();
  });
});

describe("Cancel", () => {
  it("reaches the job it is shown for and no other", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerCanceller("a", first);
    registerCanceller("b", second);
    seed(
      job("a", { startedAt: T0 - 40_000, ...FAST }),
      job("b", { startedAt: T0 - 20_000, label: "Other.mp4", ...FAST }),
    );
    render(<SpeechChip />);
    fireEvent.click(openPopover().getByRole("button", { name: "Cancel" }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("reaches the other job when that is the one shown", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerCanceller("a", first);
    registerCanceller("b", second);
    seed(
      job("a", { startedAt: T0 - 20_000, ...FAST }),
      job("b", { startedAt: T0 - 40_000, label: "Other.mp4", ...FAST }),
    );
    render(<SpeechChip />);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("is offered while the engine is starting too", () => {
    const cancel = vi.fn();
    registerCanceller("a", cancel);
    seed(job("a", { phase: "starting", firstWordsAt: null }));
    render(<SpeechChip />);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  // The engine's side of Cancel: its canceller stops the run and ends the job as cancelled.
  it("ends in 'Transcription stopped', which the popover explains and which is gone after 8 s (D-3)", () => {
    registerCanceller("a", () => state().end("a", "cancelled", Date.now()));
    seed(job("a", { ...SLOW, facts: CPU4 }));
    render(<SpeechChip />);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(chip().textContent).toBe("Transcription stopped");
    const p = within(screen.getByRole("dialog", { name: "transcription stopped" }));
    expect(p.getByText("Stopped transcribing Interview 2.mp4.")).toBeInTheDocument();
    expect(
      p.getByText(
        "It will be transcribed when needed: the assistant and captions read only the parts they use, at that moment.",
      ),
    ).toBeInTheDocument();
    expect(p.queryByRole("button", { name: "Cancel" })).toBeNull();

    advance(7_900);
    expect(chip().textContent).toBe("Transcription stopped");
    advance(200);
    expect(screen.queryByTestId("speech-chip")).toBeNull();
    expect(screen.queryByTestId("speech-popover")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("explains a run the live check stopped: it would have taken too long on this PC", () => {
    seed(job("a", { ...SLOW, facts: CPU4 }));
    render(<SpeechChip />);
    act(() => state().end("a", "too_slow", Date.now()));
    expect(
      openPopover().getByText(
        "Stopped transcribing Interview 2.mp4: it would have taken too long on this PC.",
      ),
    ).toBeInTheDocument();
  });
});

describe("the clock", () => {
  it("runs one tick while there is any job, even one that is too young to show, and none otherwise", () => {
    const view = render(<SpeechChip />);
    expect(vi.getTimerCount()).toBe(0);
    seed(job("a", { startedAt: T0, enqueuedAt: T0, ...FAST }));
    expect(vi.getTimerCount()).toBe(1);
    seed(job("b", FAST));
    expect(vi.getTimerCount()).toBe(1);
    act(() => state().dismiss("a"));
    expect(vi.getTimerCount()).toBe(1);
    act(() => state().dismiss("b"));
    expect(vi.getTimerCount()).toBe(0);
    seed(job("c", FAST));
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears a stopped job off the list itself, so a list that only held it goes quiet", () => {
    render(<SpeechChip />);
    seed(job("a", { phase: "stopped", stop: "cancelled", endedAt: Date.now() }));
    expect(state().jobs).toHaveLength(1);
    advance(8_100);
    expect(state().jobs).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
