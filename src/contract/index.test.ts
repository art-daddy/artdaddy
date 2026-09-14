// The contract is bundled, so the thing worth asserting is no longer "does the fetch recover" —
// it is that the committed catalog is REAL and complete. A bundle regenerated against a broken
// server, or hand-edited, would still import fine and only fail later at a user's tool call.
import { describe, expect, it } from "vitest";

import { allEffects, allTools, contractVersion, paramSchema, setContract, toolByName } from ".";
import catalog from "./catalog.json";
import { expensiveToolNames, paramsByTool, toolNames } from "./views";

describe("the bundled catalog", () => {
  it("is populated at import, with no load step to wait for", () => {
    // No await anywhere in this test: an empty catalog here means the app boots with no tools
    // and every MCP call answers "unknown tool".
    expect(allTools().length).toBeGreaterThan(0);
    expect(contractVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("carries descriptions and schemas, not just names", () => {
    // The old fetch existed because the bundle was names-only. If the committed file ever
    // regressed to that, an external agent would get an unusable tool list.
    const withDescription = allTools().filter((t) => t.description.trim().length > 20);
    expect(withDescription.length).toBe(allTools().length);

    const withSchema = allTools().filter((t) => paramSchema(t.name) !== undefined);
    expect(withSchema.length).toBeGreaterThan(allTools().length / 2);
  });

  it("agrees with the raw file it was generated from", () => {
    expect(allTools().length).toBe(catalog.tools.length);
    expect(catalog.count).toBe(catalog.tools.length);
    for (const t of catalog.tools) expect(toolByName(t.name)).toBeTruthy();
  });

  it("names every tool exactly once", () => {
    const names = toolNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks some tools expensive and not all of them", () => {
    // Both directions: an empty set silently disarms the approval gate, and a full one would
    // make every edit prompt for confirmation.
    const paid = expensiveToolNames();
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.length).toBeLessThan(allTools().length);
    for (const n of paid) expect(toolByName(n)?.expensive).toBe(true);
  });

  it("ships the effect registry the renderer clamps with", () => {
    expect(allEffects().length).toBeGreaterThan(0);
    for (const e of allEffects()) expect(typeof e.id).toBe("string");
  });

  it("derives param views for every offered tool", () => {
    expect(Object.keys(paramsByTool()).sort()).toEqual(toolNames());
  });
});

describe("setContract", () => {
  it("replaces the catalog so a test can drive a specific one", () => {
    setContract({
      version: "1.2.3",
      tools: [{ name: "apply_color", expensive: false, description: "adjust color" }],
    });
    expect(contractVersion()).toBe("1.2.3");
    expect(toolByName("apply_color")?.description).toBe("adjust color");
    expect(toolByName("add_clips")).toBeUndefined();

    setContract(catalog as Parameters<typeof setContract>[0]);
    expect(toolByName("add_clips")).toBeTruthy();
  });
});
