import { describe, expect, it } from "vitest";

import { asProjectId, asSessionId, newSessionId, projectFail, projectOk } from "./types";

describe("project types (ADR-0001 seams)", () => {
  it("brands non-empty ids and rejects empty", () => {
    expect(asProjectId("p1")).toBe("p1");
    expect(asSessionId("s1")).toBe("s1");
    expect(() => asProjectId("")).toThrow();
    expect(() => asSessionId("")).toThrow();
  });

  it("mints a fresh session id each open (so a same-id reopen is distinguishable)", () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it("constructs ok/fail results as discriminated data", () => {
    expect(projectOk(42, 7)).toEqual({ ok: true, value: 42, revision: 7, persistence: "dirty" });
    expect(projectOk("x", 3, "durable")).toEqual({
      ok: true,
      value: "x",
      revision: 3,
      persistence: "durable",
    });
    expect(projectFail("conflict", "revision_mismatch", "stale revision", true)).toEqual({
      ok: false,
      kind: "conflict",
      code: "revision_mismatch",
      message: "stale revision",
      retryable: true,
    });
    // Defaults: non-retryable.
    expect(projectFail("closing", "project_closing", "closed")).toMatchObject({ retryable: false });
  });
});
