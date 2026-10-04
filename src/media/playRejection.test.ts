import { beforeEach, describe, expect, it, vi } from "vitest";

const reportAppError = vi.hoisted(() => vi.fn());
vi.mock("../api/appEvents", () => ({ reportAppError }));

import { __resetPlayRejection, ignorePlayRejection } from "./playRejection";

beforeEach(() => {
  reportAppError.mockReset();
  __resetPlayRejection();
});

describe("ignorePlayRejection", () => {
  // Pausing, seeking or swapping the source while play() is pending rejects by design. It is
  // the single most common media rejection there is and means nothing went wrong.
  it("says nothing about a play interrupted by a pause", () => {
    ignorePlayRejection(new DOMException("interrupted by a call to pause()", "AbortError"));
    expect(reportAppError).not.toHaveBeenCalled();
  });

  // The opposite direction: a file the webview cannot decode must not vanish silently, or a
  // broken codec is indistinguishable from a user who never pressed play.
  it("reports a source the element genuinely cannot play", () => {
    ignorePlayRejection(
      new DOMException("The element has no supported sources.", "NotSupportedError"),
    );
    expect(reportAppError).toHaveBeenCalledTimes(1);
    expect(String(reportAppError.mock.calls[0][0])).toMatch(/no supported sources/);
  });

  // One user produced 24 of these in a session. The tenth answers nothing the first did not.
  it("reports an unplayable source once per session, not once per click", () => {
    for (let i = 0; i < 24; i++) {
      ignorePlayRejection(
        new DOMException("The element has no supported sources.", "NotSupportedError"),
      );
    }
    expect(reportAppError).toHaveBeenCalledTimes(1);
  });

  it("never throws, whatever it is handed", () => {
    expect(() => ignorePlayRejection(undefined)).not.toThrow();
    expect(() => ignorePlayRejection("a bare string")).not.toThrow();
  });

  // Gaps mutation testing found (2026-09-27).
  it("an interruption before a real failure does not use up the one report", () => {
    ignorePlayRejection(new DOMException("interrupted", "AbortError"));
    ignorePlayRejection(new DOMException("no supported sources", "NotSupportedError"));
    expect(reportAppError).toHaveBeenCalledTimes(1);
  });

  it("keeps the END of a long message, where the reason is", () => {
    const long = new Error(`${"path/".repeat(80)}The element has no supported sources.`);
    ignorePlayRejection(long);
    const msg = String(reportAppError.mock.calls[0][0]);
    expect(msg).toMatch(/no supported sources\.$/);
    expect(msg.length).toBeLessThan(200);
  });
});
