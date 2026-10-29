// What a problem report says about the app it came from: build, machine class, model, credit state and the last few
// failures' codes and request ids. Facts only: no message, prompt, path or project content, and never a reason to lose
// the report (every source is read defensively).
//
// reportContext.json is the sample the SERVER is tested against (it must store every field of it, unchanged, and the
// sample must exercise every field the server knows). This test pins the builder to that sample, so neither side can
// drift without one of the two tests failing.
import { beforeEach, describe, expect, it, vi } from "vitest";

import sample from "./__fixtures__/reportContext.json";

vi.mock("../platform/host", async (io) => ({
  ...(await io<typeof import("../platform/host")>()),
  hostInfo: () => ({ os: "windows", arch: "x86_64" }),
}));
vi.mock("../platform", async (io) => {
  const actual = await io<typeof import("../platform")>();
  return { ...actual, platform: { ...actual.platform, name: "tauri" } };
});
const usage = vi.hoisted(() => ({
  current: { metered: true, used: 150.83, limit: 150, remaining: 0, over: true } as Record<string, unknown>,
  fail: false,
}));
vi.mock("../api/usage", async (io) => ({
  ...(await io<typeof import("../api/usage")>()),
  getUsage: () => {
    if (usage.fail) throw new Error("usage store broke");
    return usage.current;
  },
}));

import { buildReportContext } from "./reportContext";
import { clearRecentFailures, noteFailure } from "./recentFailures";

beforeEach(() => {
  clearRecentFailures();
  usage.fail = false;
  usage.current = { metered: true, used: 150.83, limit: 150, remaining: 0, over: true };
  noteFailure({ where: "turn", code: "account_busy", requestId: "3f9c1a2b7d4e5f60", status: 429, at: 1793000000.5 });
  noteFailure({ where: "turn", code: "content_policy", requestId: "a1b2c3d4e5f60718", at: 1793000090 });
});

describe("buildReportContext", () => {
  it("is exactly the sample the server is tested against", () => {
    expect(buildReportContext({ model: "gpt-5.6-luna" })).toEqual(sample);
  });

  it("carries only the fields it declares (no free text can ride along)", () => {
    const context = buildReportContext({ model: "m" }) as unknown as Record<string, unknown>;
    expect(Object.keys(context).sort()).toEqual(["app_version", "arch", "credit", "failures", "model", "os", "shell", "surface"]);
    expect(Object.keys(context.credit as object).sort()).toEqual(["limit", "metered", "over", "paused", "remaining", "used"]);
    for (const failure of context.failures as object[]) {
      expect(Object.keys(failure).every((key) => ["at", "where", "code", "request_id", "status"].includes(key))).toBe(true);
    }
  });

  it("says the credit wall is a global pause when it is one", () => {
    usage.current = { metered: true, used: 5, limit: 100, remaining: 95, over: true, globalPaused: true };
    expect(buildReportContext({ model: "m" }).credit).toMatchObject({ over: true, paused: true });
  });

  it("lists failures oldest first and leaves out what a failure never had", () => {
    noteFailure({ where: "turn", code: "network", at: 1793000100 });
    const failures = buildReportContext({ model: "m" }).failures;
    expect(failures.map((f) => f.code)).toEqual(["account_busy", "content_policy", "network"]);
    expect(failures[2]).toEqual({ at: 1793000100, where: "turn", code: "network" });
  });

  it("names the surface when it is not the app", () => {
    expect(buildReportContext({ model: "m", surface: "mcp" }).surface).toBe("mcp");
  });

  it("never throws, whatever it cannot read: the report still goes out", () => {
    usage.fail = true;
    const context = buildReportContext({ model: "m" });
    expect(context.credit).toBeUndefined();
    expect(context).toMatchObject({ app_version: "artdaddy@test", os: "windows", model: "m" });
  });
});
