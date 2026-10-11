// A user who signed in and then produced nothing looked exactly like one who never came
// back. These two markers are the difference, so what matters is that they fire EXACTLY
// once for the thing they name — a launch beacon that repeats on every auth refresh, or a
// project marker that fires on a failed open, answers the question wrongly rather than not
// at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", async (io) => {
  const actual = await io<typeof import("./auth")>();
  return { ...actual, hasSession: vi.fn(async () => true) };
});
vi.mock("../platform/host", async (io) => {
  const actual = await io<typeof import("../platform/host")>();
  return {
    ...actual,
    resolveHostInfo: vi.fn(async () => ({ os: "windows", arch: "x86_64" })),
    hostInfo: () => ({ os: "windows", arch: "x86_64" }),
  };
});

import {
  __resetAppEvents,
  reportAppEvent,
  reportLaunchOnce,
  reportProjectOpened,
  reportTranscription,
} from "./appEvents";
import { hasSession, setClerkTokenProvider } from "./auth";
import { useAuth } from "../store/auth";
import { resolveHostInfo } from "../platform/host";

function captureFetch() {
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("{}", { status: 200 });
    }),
  );
  return calls;
}

beforeEach(() => {
  __resetAppEvents();
  useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
  setClerkTokenProvider(async () => "isolated-telemetry-session");
  vi.mocked(hasSession).mockResolvedValue(true);
  vi.mocked(resolveHostInfo).mockResolvedValue({ os: "windows", arch: "x86_64" });
});
afterEach(() => {
  __resetAppEvents();
  setClerkTokenProvider(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startup event delivery", () => {
  it("keeps a report pending when its delivery deadline expires", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("delivery timed out")), {
              once: true,
            });
          }),
      ),
    );
    const pending = reportAppEvent("app_error", { reason: "deadline witness" });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toBe("unavailable");
  });

  it.each([
    ["locked", true, "discarded", 0],
    ["offline", false, "discarded", 0],
    ["offline", true, "stored", 1],
    ["unlocked", false, "stored", 1],
  ] as const)(
    "keeps %s stored-session=%s reporting within its session",
    async (status, hasStoredSession, outcome, count) => {
      const requests: Record<string, unknown>[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init) => {
          requests.push(JSON.parse(init!.body as string));
          return new Response(JSON.stringify({ ok: true, status: "ok" }), { status: 200 });
        }),
      );
      useAuth.setState({ status, hasStoredSession });
      expect(await reportAppEvent("app_error", { reason: "session witness" })).toBe(outcome);
      expect(requests).toHaveLength(count);
    },
  );

  it.each([
    [200, { ok: false, status: "ok" }],
    [200, { ok: true, status: "disabled" }],
    [200, { ok: "true", status: "ok" }],
    [200, { status: "ok" }],
    [200, null],
    [503, { ok: true, status: "ok" }],
  ])("never confirms an invalid storage receipt (%s, %j)", async (status, receipt) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(receipt), { status: status as number })),
    );
    expect(await reportAppEvent("app_error", { reason: "native witness" })).toBe("unavailable");
  });

  it.each([
    [200, null],
    [200, {}],
    [200, { user_id: "" }],
    [200, { user_id: 42 }],
    [503, { user_id: "account_a" }],
  ])(
    "keeps native reports pending when account verification is invalid (%s, %j)",
    async (status, profile) => {
      useAuth.setState({ profile: { user_id: "account_a" } as never });
      const requests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url) => {
          requests.push(String(url));
          return new Response(JSON.stringify(profile), { status: status as number });
        }),
      );
      expect(
        await reportAppEvent("app_error", { ownerId: "account_a", reason: "native witness" }),
      ).toBe("unavailable");
      expect(requests.filter((url) => url.endsWith("/telemetry/app"))).toEqual([]);
    },
  );

  it("keeps valid native metadata and does not transmit the local ownership guard", async () => {
    useAuth.setState({ profile: { user_id: "account_a" } as never });
    const events: Record<string, unknown>[] = [];
    const verifiedSend = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).endsWith("/me"))
          return new Response(JSON.stringify({ user_id: "account_a" }), { status: 200 });
        events.push(JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ ok: true, status: "ok" }), { status: 200 });
      }),
    );
    expect(
      await reportAppEvent("app_error", {
        ownerId: "account_a",
        eventId: "native-0",
        occurredAt: 0,
        ok: false,
        via: "renderer_exited",
        projectId: "project_a",
        onVerifiedSend: verifiedSend,
      }),
    ).toBe("stored");
    expect(events).toEqual([
      expect.objectContaining({
        event_id: "native-0",
        occurred_at: 0,
        ok: false,
        via: "renderer_exited",
        project_id: "project_a",
      }),
    ]);
    expect(events[0]).not.toHaveProperty("ownerId");
    expect(events[0]).not.toHaveProperty("onVerifiedSend");
    expect(verifiedSend).toHaveBeenCalledTimes(1);
  });

  it("retains ordinary pending events when auth settles offline with a stored session", async () => {
    vi.useFakeTimers();
    const calls = captureFetch();
    useAuth.setState({ status: "checking", hasStoredSession: false });
    const pending = reportAppEvent("app_error", { reason: "startup witness" });
    useAuth.setState({ status: "offline", hasStoredSession: true });
    await pending;
    expect(calls).toHaveLength(1);
    expect(calls[0].reason).toBe("startup witness");
  });

  it("discards an event if auth settles offline without a stored session", async () => {
    const calls = captureFetch();
    useAuth.setState({ status: "checking", hasStoredSession: false });
    const pending = reportAppEvent("app_error", { reason: "startup witness" });
    useAuth.setState({ status: "offline", hasStoredSession: false });
    expect(await pending).toBe("discarded");
    expect(calls).toEqual([]);
  });

  it("does not send while no access token is available even if the UI remains unlocked", async () => {
    const calls = captureFetch();
    vi.mocked(hasSession).mockResolvedValue(false);
    expect(await reportAppEvent("app_error", { reason: "unavailable token" })).toBe("unavailable");
    expect(calls).toEqual([]);
  });

  it("refuses native-ID events without the required account and timestamp", async () => {
    const calls = captureFetch();
    expect(await reportAppEvent("app_error", { eventId: "native-1", occurredAt: 100 })).toBe(
      "discarded",
    );
    expect(await reportAppEvent("app_error", { eventId: "native-1", ownerId: "qa_account" })).toBe(
      "discarded",
    );
    expect(calls).toEqual([]);
  });

  it("refuses a native report when the token belongs to another account despite a stale profile", async () => {
    useAuth.setState({ profile: { user_id: "account_a" } as never });
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        sent.push(String(url));
        return new Response(
          JSON.stringify(
            String(url).endsWith("/me") ? { user_id: "account_b" } : { ok: true, status: "ok" },
          ),
          { status: 200 },
        );
      }),
    );
    expect(
      await reportAppEvent("app_error", { reason: "old native failure", ownerId: "account_a" }),
    ).toBe("discarded");
    expect(sent.filter((url) => url.endsWith("/telemetry/app"))).toEqual([]);
  });

  it("does not send a native report if the token changes after its account was verified", async () => {
    useAuth.setState({ profile: { user_id: "account_a" } as never });
    let tokenReads = 0;
    setClerkTokenProvider(async () => (++tokenReads === 1 ? "account-a-token" : "account-b-token"));
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        sent.push(String(url));
        return new Response(
          JSON.stringify(
            String(url).endsWith("/me") ? { user_id: "account_a" } : { ok: true, status: "ok" },
          ),
          { status: 200 },
        );
      }),
    );
    expect(
      await reportAppEvent("app_error", { reason: "old native failure", ownerId: "account_a" }),
    ).not.toBe("stored");
    expect(sent.filter((url) => url.endsWith("/telemetry/app"))).toEqual([]);
  });

  it("confirms storage only when the server reports a saved event", async () => {
    const responses = [
      { ok: false, status: "disabled" },
      { ok: false, status: "rate_limited" },
      { ok: true, status: "ok" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })),
    );
    expect(await reportAppEvent("app_error", { reason: "native failure" })).toBe("unavailable");
    expect(await reportAppEvent("app_error", { reason: "native failure" })).toBe("unavailable");
    expect(await reportAppEvent("app_error", { reason: "native failure" })).toBe("stored");
  });

  it("does not attribute a previous account's native report to the current account", async () => {
    const calls = captureFetch();
    useAuth.setState({ profile: { user_id: "current_account" } as never });
    const outcome = await reportAppEvent("app_error", {
      reason: "old native failure",
      ownerId: "previous_account",
    });
    expect(outcome).toBe("discarded");
    expect(calls).toEqual([]);
  });

  it("waits for the account identity before sending an owner-bound native report", async () => {
    vi.useFakeTimers();
    const calls = captureFetch();
    useAuth.setState({ status: "unlocked", profile: null });
    const pending = reportAppEvent("app_error", {
      reason: "previous failure",
      ownerId: "account_a",
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([]);
    useAuth.setState({ profile: { user_id: "account_b" } as never });
    expect(await pending).toBe("discarded");
    expect(calls).toEqual([]);
  });

  it("sends a crash event after sign-in resolves instead of losing it at startup", async () => {
    const calls = captureFetch();
    useAuth.setState({ status: "checking", hasStoredSession: false });
    setClerkTokenProvider(null);
    vi.mocked(hasSession).mockImplementation(async () => useAuth.getState().status === "unlocked");
    const delivery = reportAppEvent("app_error", {
      projectId: "project_1",
      reason: "process stopped",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([]);
    setClerkTokenProvider(async () => "restored-session");
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    await delivery;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      event: "app_error",
      project_id: "project_1",
      reason: "process stopped",
    });
  });

  it("discards a startup event when signed out and never sends it after a later sign-in", async () => {
    const calls = captureFetch();
    useAuth.setState({ status: "checking", hasStoredSession: false });
    vi.mocked(hasSession).mockImplementation(async () => useAuth.getState().status === "unlocked");
    const startup = reportAppEvent("app_error", { reason: "old session" });
    await Promise.resolve();
    await Promise.resolve();
    useAuth.setState({ status: "locked", hasStoredSession: false });
    await startup;
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    await reportAppEvent("project_opened", { projectId: "new_session" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ event: "project_opened", project_id: "new_session" });
  });

  it("bounds startup events instead of retaining an unlimited history", async () => {
    const calls = captureFetch();
    useAuth.setState({ status: "checking", hasStoredSession: false });
    const reports = Array.from({ length: 60 }, (_, index) =>
      reportAppEvent("app_error", { reason: `startup ${index}` }),
    );
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    await Promise.all(reports);
    expect(calls).toHaveLength(50);
    expect(calls.map((call) => call.reason)).toEqual(
      Array.from({ length: 50 }, (_, index) => `startup ${index}`),
    );
  });

  it("expires unresolved startup events and never revives them on later sign-in", async () => {
    vi.useFakeTimers();
    const calls = captureFetch();
    useAuth.setState({ status: "checking", hasStoredSession: false });
    const pending = reportAppEvent("app_error", { reason: "expired startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    await reportAppEvent("project_opened", { projectId: "current" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ event: "project_opened", project_id: "current" });
  });

  it("never sends an old event after sign-out while its token was being fetched", async () => {
    const calls = captureFetch();
    let finishToken!: (token: string) => void;
    let askedForToken = false;
    const token = new Promise<string>((resolve) => {
      finishToken = resolve;
    });
    setClerkTokenProvider(() => {
      askedForToken = true;
      return token;
    });
    const pending = reportAppEvent("app_error", { reason: "previous account" });
    await vi.waitFor(() => expect(askedForToken).toBe(true));
    useAuth.getState().markLocked();
    setClerkTokenProvider(async () => "next-account-session");
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    finishToken("previous-account-session");
    await pending;
    await reportAppEvent("project_opened", { projectId: "next_account" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ event: "project_opened", project_id: "next_account" });
  });

  it("keeps the event as raised even if its caller later changes the details", async () => {
    const calls = captureFetch();
    useAuth.setState({ status: "checking", hasStoredSession: false });
    const detail = { projectId: "original_project", reason: "original error" };
    const pending = reportAppEvent("app_error", detail);
    detail.projectId = "later_project";
    detail.reason = "later error";
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    await pending;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ project_id: "original_project", reason: "original error" });
  });

  it("cancels an event if sign-out happens while the desktop host is still resolving", async () => {
    const calls = captureFetch();
    let finishHost!: (host: Awaited<ReturnType<typeof resolveHostInfo>>) => void;
    vi.mocked(resolveHostInfo).mockReturnValue(
      new Promise((resolve) => {
        finishHost = resolve;
      }),
    );
    const pending = reportAppEvent("app_error", { reason: "closed session" });
    useAuth.getState().markLocked();
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    finishHost({ os: "windows", arch: "x86_64" });
    await pending;
    expect(calls).toEqual([]);
  });
});

describe("the launch marker", () => {
  it("reports the real OS, not the shell name", async () => {
    const calls = captureFetch();
    await reportAppEvent("launch");
    expect(calls[0].os).toBe("windows");
    expect(calls[0].os).not.toBe("tauri");
    expect(calls[0].arch).toBe("x86_64");
    expect(calls[0].event).toBe("launch");
  });

  it("carries no identity — the server decides who this is", async () => {
    // The body is client-controlled. A per-user metric the client attributes is not a metric.
    const calls = captureFetch();
    await reportAppEvent("launch");
    for (const k of ["user_id", "email", "user"]) expect(calls[0]).not.toHaveProperty(k);
  });

  it("fires once per process, however many times auth resolves", async () => {
    // Auth settles on a restored session AND again on a deep-link callback; a marker per
    // refresh would make one person look like a dozen launches.
    const calls = captureFetch();
    reportLaunchOnce();
    reportLaunchOnce();
    reportLaunchOnce();
    await vi.waitFor(() => expect(calls.length).toBe(1));
  });
});

describe("the project-opened marker", () => {
  it("fires once per project, not once per open", async () => {
    const calls = captureFetch();
    reportProjectOpened("p1");
    reportProjectOpened("p1");
    reportProjectOpened("p2");
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls.map((c) => c.project_id)).toEqual(["p1", "p2"]);
  });

  it("ignores an empty id rather than filing a nameless open", async () => {
    const calls = captureFetch();
    reportProjectOpened("");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
  });
});

describe("a beacon must never be visible to the user", () => {
  it("swallows a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(reportAppEvent("launch")).resolves.toBe("unavailable");
  });

  it("swallows a rejected request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    await expect(reportAppEvent("project_opened", { projectId: "p1" })).resolves.toBe(
      "unavailable",
    );
  });
});

// 4i part 4: which backend whisper ran on, and how fast. A sample, never a flood: every app event of
// a user shares one budget on the server, and the indexer can finish dozens of short clips a minute.
describe("the transcription sample", () => {
  const run = {
    backend: "vulkan",
    audioSeconds: 612.34,
    wallSeconds: 66.1,
    model: "small",
    threads: 8,
  };
  const T0 = 1_700_000_000_000;

  it("says which backend ran and how fast, and nothing about what was said", async () => {
    const calls = captureFetch();
    reportTranscription(run, T0);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      event: "transcription",
      via: "vulkan",
      reason: "audio_s=612.3 wall_s=66.1 x=9.26 model=small threads=8",
      project_id: "",
    });
  });

  it("sends one a minute at most", async () => {
    const calls = captureFetch();
    const at = [T0, T0 + 1_000, T0 + 59_999, T0 + 60_000, T0 + 61_000];
    // Each run its own length, so what went out says which runs it was.
    at.forEach((t, i) => reportTranscription({ ...run, audioSeconds: 100 + i }, t));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.map((c) => String(c.reason).split(" ")[0])).toEqual([
      "audio_s=100.0",
      "audio_s=103.0",
    ]);
  });

  it("sends none for a run too short to say how fast, and lets the next long one through", async () => {
    const calls = captureFetch();
    reportTranscription({ ...run, audioSeconds: 29.9 }, T0);
    reportTranscription({ ...run, audioSeconds: null }, T0);
    reportTranscription({ ...run, audioSeconds: 30 }, T0 + 1);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].reason).toMatch(/^audio_s=30\.0 /);
  });

  it("names a backend it was not told as unknown, and leaves out figures it does not have", async () => {
    const calls = captureFetch();
    reportTranscription(
      { backend: null, audioSeconds: 45, wallSeconds: null, model: null, threads: null },
      T0,
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect([calls[0].via, calls[0].reason]).toEqual(["unknown", "audio_s=45.0"]);
  });

  it("sends the first sample of a launch", async () => {
    const calls = captureFetch();
    vi.resetModules();
    const fresh = await import("./appEvents"); // as loaded at launch, never reset
    const freshAuth = await import("./auth");
    const freshState = await import("../store/auth");
    freshState.useAuth.setState({ status: "unlocked", hasStoredSession: true });
    freshAuth.setClerkTokenProvider(async () => "fresh-launch-session");
    fresh.reportTranscription(run, T0);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    fresh.__resetAppEvents();
    freshAuth.setClerkTokenProvider(null);
  });
});
