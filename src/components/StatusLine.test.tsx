import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLiveWait, trackSpeechWait, useLiveWait } from "../store/liveWait";
import { clearModelDownload, reportModelDownload } from "../store/modelDownload";
import StatusLine from "./StatusLine";

const live = () => useLiveWait.getState();
const spinning = (container: HTMLElement): boolean =>
  container.querySelector(".animate-spin") !== null;
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
  resetLiveWait();
  clearModelDownload();
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  resetLiveWait();
  clearModelDownload();
});

describe("StatusLine: what the person sees while a turn runs", () => {
  it("falls back to a plain 'working…' when nothing is known to be running, with no clock", () => {
    const { container } = render(<StatusLine />);
    expect(screen.getByRole("status").textContent).toBe("working…");
    expect(spinning(container)).toBe(true);
    expect(container.textContent).not.toMatch(/\d:\d\d/);
  });

  it("names the model's wait, adds a clock after a few seconds, and says it is slow after half a minute", () => {
    act(() => live().roundStarted(Date.now()));
    act(() => live().roundSent());
    const { container } = render(<StatusLine />);
    expect(screen.getByRole("status").textContent).toBe("Thinking…");
    expect(container.textContent).not.toMatch(/\d:\d\d/);

    tick(4_000);
    expect(container.textContent).toContain("0:04");
    expect(container.textContent).not.toMatch(/longer than usual/);

    tick(27_000);
    expect(container.textContent).toContain("0:31");
    expect(container.textContent).toMatch(/The AI is taking longer than usual/);
    expect(container.textContent).toMatch(/press Stop at any time/);
  });

  it("names a running tool in the chat's own words, and counts the others running beside it", () => {
    act(() => {
      live().callStarted("a", "add_captions", Date.now());
      live().callStarted("b", "inspect_media", Date.now());
    });
    render(<StatusLine />);
    expect(screen.getByRole("status").textContent).toBe("Captioning the audio (+1 more)…");
  });

  it("advances the clock every second without anything else happening", () => {
    act(() => live().callStarted("a", "video_ask", Date.now()));
    const { container } = render(<StatusLine />);
    tick(5_000);
    expect(container.textContent).toContain("0:05");
    tick(1_000);
    expect(container.textContent).toContain("0:06");
    tick(54_000);
    expect(container.textContent).toContain("1:00");
    expect(container.textContent).toMatch(/Still working on this/);
  });

  it("follows the turn as it moves from the model to a tool and back", () => {
    act(() => live().roundStarted(Date.now()));
    render(<StatusLine />);
    expect(screen.getByRole("status").textContent).toBe("Getting ready…");
    act(() => live().roundWriting());
    expect(screen.getByRole("status").textContent).toBe("Writing…");
    act(() => {
      live().roundEnded();
      live().callStarted("a", "get_transcript", Date.now());
    });
    expect(screen.getByRole("status").textContent).toBe("Reading the transcript…");
    act(() => {
      live().callEnded("a");
      live().roundStarted(Date.now());
    });
    expect(screen.getByRole("status").textContent).toBe("Getting ready…");
  });

  it("measures each wait from its own start, not from when the line appeared", () => {
    const began = Date.now() - 125_000; // the tool started two minutes ago; the line mounts now
    act(() => live().callStarted("a", "video_find_moment", began));
    const { container } = render(<StatusLine />);
    expect(container.textContent).toContain("2:05");
    expect(container.textContent).toMatch(/Still working on this/);
  });

  it("when it is waiting on the person, says so, shows no spinner, and never claims to be working", () => {
    act(() => live().approvalAsked(Date.now()));
    const { container } = render(<StatusLine />);
    expect(screen.getByRole("status").textContent).toBe("Waiting for your OK…");
    expect(spinning(container)).toBe(false);
    tick(5 * 60_000);
    expect(container.textContent).toContain("5:00");
    expect(container.textContent).not.toMatch(/Still working|longer than usual/);
  });

  it("stops its timer when it goes away", () => {
    act(() => live().callStarted("a", "video_ask", Date.now()));
    const { unmount } = render(<StatusLine />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("while the request itself is waiting", () => {
    it("says it is reconnecting, then goes back to thinking when the connection is back", () => {
      act(() => {
        live().roundStarted(Date.now());
        live().roundSent();
        live().roundNoted("reconnecting");
      });
      render(<StatusLine />);
      expect(screen.getByRole("status").textContent).toBe("Reconnecting…");
      act(() => live().roundNoted(null));
      expect(screen.getByRole("status").textContent).toBe("Thinking…");
    });

    it("says it is waiting for the last request, and why, from the first second", () => {
      act(() => {
        live().roundStarted(Date.now());
        live().roundSent();
        live().roundNoted("busy");
      });
      const { container } = render(<StatusLine />);
      expect(screen.getByRole("status").textContent).toBe("Waiting for your last request…");
      expect(container.textContent).toMatch(/last request is still finishing/);
    });
  });

  describe("while a tool waits for speech to be transcribed", () => {
    const MIB = 1024 * 1024;

    it("says it is transcribing the audio, not captioning, and goes back to its own words after", async () => {
      act(() => live().callStarted("a", "add_captions", Date.now()));
      render(<StatusLine />);
      expect(screen.getByRole("status").textContent).toBe("Captioning the audio…");

      let done!: () => void;
      act(() => {
        void trackSpeechWait("add_captions", new Promise<void>((r) => (done = r)));
      });
      expect(screen.getByRole("status").textContent).toBe("Transcribing the audio…");

      await act(async () => {
        done();
        await Promise.resolve();
      });
      expect(screen.getByRole("status").textContent).toBe("Captioning the audio…");
    });

    it("says the speech model is downloading, once, and why: it only happens the first time", () => {
      act(() => {
        live().callStarted("a", "add_captions", Date.now());
        live().speechWaitStarted(1, "add_captions");
        reportModelDownload(10 * MIB, 465 * MIB);
      });
      const { container } = render(<StatusLine />);
      expect(screen.getByRole("status").textContent).toBe(
        "Downloading the speech model (one time)…",
      );
      expect(container.textContent).toMatch(
        /This only happens when you start the app for the first time/,
      );
      act(() => clearModelDownload());
      expect(screen.getByRole("status").textContent).toBe("Transcribing the audio…");
      expect(container.textContent).not.toMatch(/first time/);
    });

    it("does not say a tool is transcribing when it is not the one waiting for speech", () => {
      act(() => {
        live().callStarted("a", "video_ask", Date.now());
        live().speechWaitStarted(1, "add_captions");
        reportModelDownload(10 * MIB, 465 * MIB);
      });
      render(<StatusLine />);
      expect(screen.getByRole("status").textContent).toBe("Watching a video…");
    });
  });
});
