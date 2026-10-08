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
});
afterEach(() => {
  vi.unstubAllGlobals();
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
    await expect(reportAppEvent("launch")).resolves.toBeUndefined();
  });

  it("swallows a rejected request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    await expect(reportAppEvent("project_opened", { projectId: "p1" })).resolves.toBeUndefined();
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
    fresh.reportTranscription(run, T0);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });
});
