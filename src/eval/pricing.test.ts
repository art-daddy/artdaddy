import { describe, expect, it } from "vitest";

import { Budget, costFromUsage } from "./pricing";

describe("costFromUsage", () => {
  it("prefers the server-provided cost_usd", () => {
    expect(costFromUsage("gpt-5.4", { cost_usd: 0.42, input_tokens: 1_000_000 })).toBe(0.42);
  });

  it("falls back to the pricing table when cost_usd is absent", () => {
    // gpt-5.4: $5/M in + $20/M out.
    expect(
      costFromUsage("gpt-5.4", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ).toBeCloseTo(25, 6);
    // gpt-5.4-mini: $0.25/M in + $2/M out.
    expect(
      costFromUsage("gpt-5.4-mini", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ).toBeCloseTo(2.25, 6);
  });

  it("resolves by prefix and returns 0 for an unknown model", () => {
    expect(costFromUsage("gpt-5.4-2026-01", { output_tokens: 1_000_000 })).toBeCloseTo(20, 6);
    expect(costFromUsage("mystery-model", { input_tokens: 1_000_000 })).toBe(0);
  });

  it("handles missing usage", () => {
    expect(costFromUsage("gpt-5.4", undefined)).toBe(0);
  });
});

describe("Budget", () => {
  it("accumulates spend and enforces the cap", () => {
    const b = new Budget(10);
    expect(b.exceeded()).toBe(false);
    b.add(4);
    b.add(3);
    expect(b.total).toBeCloseTo(7, 6);
    expect(b.remaining).toBeCloseTo(3, 6);
    b.add(5);
    expect(b.exceeded()).toBe(true);
    expect(b.remaining).toBe(0);
  });

  it("ignores non-finite / non-positive additions", () => {
    const b = new Budget(10);
    b.add(NaN);
    b.add(-5);
    b.add(Infinity);
    expect(b.total).toBe(0);
  });
});
