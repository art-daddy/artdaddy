// A user who signed in and then produced nothing looked exactly like one who never came
// back. These two markers are the difference, so what matters is that they fire EXACTLY
// once for the thing they name — a launch beacon that repeats on every auth refresh, or a
// project marker that fires on a failed open, answers the question wrongly rather than not
// at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", async (io) => {
  const actual = await io<typeof import("./auth")>();
  return { ...actual, authHeaders: vi.fn(async () => ({ Authorization: "Bearer t" })) };
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
    await expect(reportAppEvent("project_opened", "p1")).resolves.toBeUndefined();
  });
});
