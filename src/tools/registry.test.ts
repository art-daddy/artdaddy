import { beforeAll, describe, expect, it } from "vitest";

import { setContract } from "../contract";
import { ClientToolRegistry } from "./registry";

// The dispatch boundary consults the LIVE contract to clamp ranges and to tell a
// strict-mode "unset" null from a null that means something.
beforeAll(() => {
  setContract({
    version: "test",
    tools: [
      {
        name: "strict_probe",
        parameters: {
          type: "object",
          properties: {
            width: { type: "integer" },
            height: { type: "integer" },
            aspect_ratio: { type: "string" },
            keep: { type: ["string", "null"] }, // declared nullable ON PURPOSE
            level: { type: "integer", minimum: 0, maximum: 10 },
          },
        },
      },
    ],
  });
});

describe("ClientToolRegistry", () => {
  it("registers, reports, and runs handlers", async () => {
    const r = new ClientToolRegistry();
    r.register("echo", (args) => ({ echoed: args }));
    expect(r.has("echo")).toBe(true);
    expect(r.names()).toEqual(["echo"]);
    expect(r.size).toBe(1);
    expect(await r.run("echo", { a: 1 })).toEqual({ echoed: { a: 1 } });
  });

  it("throws for an unregistered tool", async () => {
    await expect(new ClientToolRegistry().run("nope", {})).rejects.toThrow(/nope/);
  });

  it("rejects non-object args (null / array) before a handler can dereference them", async () => {
    const r = new ClientToolRegistry();
    r.register("echo", (args) => ({ echoed: args }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await r.run("echo", null as any)).toEqual({
      ok: false,
      error: "echo: arguments must be an object.",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await r.run("echo", [] as any)).toEqual({
      ok: false,
      error: "echo: arguments must be an object.",
    });
  });

  it("turns a throwing handler into a graceful { ok:false } (the dispatch boundary is crash-proof)", async () => {
    const r = new ClientToolRegistry();
    r.register("boom", () => {
      throw new Error("kaboom");
    });
    expect(await r.run("boom", {})).toEqual({ ok: false, error: "boom: kaboom" });
  });

  // The strip is one line in run(); without this test it could be deleted and the
  // whole suite would stay green while all 56 tools silently start seeing null again
  // (Number(null) === 0 -> a 0x0 canvas, a [0,0) window).
  it("STRIPS the nulls strict mode forces, so a handler never sees one", async () => {
    const r = new ClientToolRegistry();
    let seen: Record<string, unknown> | undefined;
    r.register("strict_probe", (args) => {
      seen = args;
      return { ok: true };
    });
    await r.run("strict_probe", { width: null, height: null, aspect_ratio: "16:9" });
    expect(seen).toEqual({ aspect_ratio: "16:9" });
    expect(Object.keys(seen!)).not.toContain("width");
  });

  it("does NOT strip a null the contract declares (null carries meaning there)", async () => {
    const r = new ClientToolRegistry();
    let seen: Record<string, unknown> | undefined;
    r.register("strict_probe", (args) => {
      seen = args;
      return { ok: true };
    });
    await r.run("strict_probe", { keep: null });
    expect(seen).toEqual({ keep: null });
  });

  it("strips before clamping, so an unset number is absent rather than clamped to the minimum", async () => {
    const r = new ClientToolRegistry();
    let seen: Record<string, unknown> | undefined;
    r.register("strict_probe", (args) => {
      seen = args;
      return { ok: true };
    });
    await r.run("strict_probe", { level: null });
    expect(seen).toEqual({}); // NOT { level: 0 }
  });
});
