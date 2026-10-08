// The three events exist because a session that ENDS leaves no trace. Each is emitted from a
// path that only runs when something went wrong, which is exactly the kind of code that is
// never exercised by hand — so these assert the failure direction, not the happy one.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ signedIn: true }));

vi.mock("./config", () => ({ apiBase: () => "https://example.invalid" }));
vi.mock("./auth", () => ({
  hasSession: async () => session.signedIn,
  authedFetch: (url: string, init: RequestInit = {}) => fetch(url, init),
}));
vi.mock("../platform/host", () => ({
  hostInfo: () => ({ os: "windows", arch: "x86_64" }),
  resolveHostInfo: async () => undefined,
}));
vi.mock("../platform", () => ({ platform: { name: "tauri" } }));

import {
  __resetAppEvents,
  reportAppError,
  reportCreditsExhausted,
  reportMediaImport,
  resetCreditsExhausted,
} from "./appEvents";

const posted: Record<string, unknown>[] = [];

beforeEach(() => {
  __resetAppEvents();
  posted.length = 0;
  session.signedIn = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: { body: string }) => {
      posted.push(JSON.parse(init.body));
      return { ok: true } as Response;
    }),
  );
});

afterEach(() => {
  __resetAppEvents();
  vi.unstubAllGlobals();
});

const sent = async () => {
  await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
  return posted;
};

describe("media_import", () => {
  it("reports a refusal with the reason the guard gave", async () => {
    reportMediaImport(false, "p1", "'shot.png' can't be used as media: 6864x41754 is too large");
    const [ev] = await sent();
    expect(ev.event).toBe("media_import");
    expect(ev.ok).toBe(false);
    expect(String(ev.reason)).toContain("41754");
  });

  it("reports EVERY refusal, because each one is a different lost session", async () => {
    reportMediaImport(false, "p1", "first");
    reportMediaImport(false, "p1", "second");
    await vi.waitFor(() => expect(posted.length).toBe(2));
  });

  it("reports a success only once per project", async () => {
    // A hundred-file import must not spend the whole per-user beacon budget answering
    // a question one row already answers.
    for (let i = 0; i < 20; i++) reportMediaImport(true, "p1");
    await sent();
    expect(posted).toHaveLength(1);
    expect(posted[0].ok).toBe(true);
  });

  it("still reports a success for a DIFFERENT project", async () => {
    reportMediaImport(true, "p1");
    reportMediaImport(true, "p2");
    await vi.waitFor(() => expect(posted.length).toBe(2));
  });

  it("reports a recording that follows a file import", async () => {
    // Keyed on the project alone, the second of these produced NO row at all -- a recording
    // behind an earlier import left no trace, which is exactly why "did her recording ever
    // land?" could not be answered from the trace.
    reportMediaImport(true, "p1", "", "copy");
    reportMediaImport(true, "p1", "", "recording");
    await vi.waitFor(() => expect(posted.length).toBe(2));
    expect(posted.map((e) => e.via)).toEqual(["copy", "recording"]);
  });

  it("still costs ONE beacon for a folder full of files through the same door", async () => {
    for (let i = 0; i < 20; i++) reportMediaImport(true, "p1", "", "copy");
    await sent();
    expect(posted).toHaveLength(1);
  });
});

describe("credits_exhausted", () => {
  it("reports the wall once, not once per refusal", async () => {
    // A shot list produces a run of identical 402s; counting those would say the wall was
    // hit twenty times when the user hit it once.
    for (let i = 0; i < 20; i++) reportCreditsExhausted("user limit: 516/500");
    await sent();
    expect(posted).toHaveLength(1);
    expect(posted[0].event).toBe("credits_exhausted");
  });

  it("reports again for a new identity", async () => {
    reportCreditsExhausted("user limit: 516/500");
    await sent();
    resetCreditsExhausted();
    reportCreditsExhausted("user limit: 12/10");
    await vi.waitFor(() => expect(posted.length).toBe(2));
  });
});

describe("app_error", () => {
  it("carries the message, since a crash cannot describe itself later", async () => {
    reportAppError("unhandledrejection: heap exhausted", "p1");
    const [ev] = await sent();
    expect(ev.event).toBe("app_error");
    expect(ev.ok).toBe(false);
    expect(ev.reason).toBe("unhandledrejection: heap exhausted");
    expect(ev.project_id).toBe("p1");
  });

  it("ignores an empty reason rather than storing a blank row", async () => {
    reportAppError("");
    expect(posted).toHaveLength(0);
  });

  it("truncates rather than shipping an unbounded stack", async () => {
    reportAppError("x".repeat(5_000));
    const [ev] = await sent();
    expect(String(ev.reason)).toHaveLength(300);
  });
});

describe("attribution", () => {
  it("sends nothing when signed out — the server could not file it anyway", async () => {
    session.signedIn = false;
    reportMediaImport(false, "p1", "refused");
    reportAppError("boom");
    reportCreditsExhausted("wall");
    expect(posted).toHaveLength(0);
  });
});
