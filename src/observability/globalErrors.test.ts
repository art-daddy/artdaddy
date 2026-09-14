import { describe, it, expect, vi, beforeEach } from "vitest";

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock("./sentry", () => ({ captureError: captureMock }));

import { installGlobalErrorHandlers } from "./globalErrors";
import { RateLimitError } from "../api/http";
import { ProjectClosingError } from "../project/MutationGate";
import { ApiError } from "../api/client";

/** A minimal Window stand-in that records the handlers so a test can fire them. */
function fakeWindow() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const win = {
    addEventListener: (type: string, h: (e: unknown) => void) => {
      handlers[type] = h;
    },
  } as unknown as Window;
  return { win, handlers };
}

describe("installGlobalErrorHandlers", () => {
  beforeEach(() => captureMock.mockReset());

  it("reports an UNEXPECTED unhandled rejection to Sentry", () => {
    const { win, handlers } = fakeWindow();
    installGlobalErrorHandlers(win);
    handlers.unhandledrejection({ reason: new Error("kaboom") });
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0][1]).toMatchObject({ scope: "unhandledrejection" });
  });

  it("SKIPS an expected control-flow rejection (rate limit, gate close)", () => {
    const { win, handlers } = fakeWindow();
    installGlobalErrorHandlers(win);
    handlers.unhandledrejection({ reason: new RateLimitError() });
    handlers.unhandledrejection({ reason: new ProjectClosingError() });
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("reports a non-expected ArtDaddyError and forwards its code", () => {
    const { win, handlers } = fakeWindow();
    installGlobalErrorHandlers(win);
    handlers.unhandledrejection({ reason: new ApiError(500, "boom") });
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0][1]).toMatchObject({
      scope: "unhandledrejection",
      code: "http",
    });
  });

  it("reports an uncaught window error (error event)", () => {
    const { win, handlers } = fakeWindow();
    installGlobalErrorHandlers(win);
    handlers.error({ error: new Error("uncaught"), message: "uncaught" });
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0][1]).toMatchObject({ scope: "window.error" });
  });
});
