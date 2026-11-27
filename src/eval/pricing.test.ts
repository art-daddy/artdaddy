import { describe, expect, it } from "vitest";

import { Budget, costFromUsage } from "./pricing";

describe("costFromUsage", () => {
  it("takes the server's cost_usd", () => {
    expect(costFromUsage({ cost_usd: 0.42, input_tokens: 1_000_000 })).toBe(0.42);
  });

  // The old fallback priced a model it did not know at $0, so every round of a model newer than
  // its table counted as free and the cap could not stop a run.
  it("never reads a round that used tokens and reported no cost as free", () => {
    expect(costFromUsage({ input_tokens: 1_000_000 })).toBeNull();
    expect(costFromUsage({ output_tokens: 1 })).toBeNull();
    expect(costFromUsage({ input_tokens: 10, output_tokens: 5, cost_usd: 0 })).toBeNull();
    expect(costFromUsage({ input_tokens: 10, cost_usd: Number.NaN })).toBeNull();
  });

  it("is zero for a round that used nothing", () => {
    expect(costFromUsage(undefined)).toBe(0);
    expect(costFromUsage({})).toBe(0);
    expect(costFromUsage({ input_tokens: 0, output_tokens: 0 })).toBe(0);
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
    expect(() => b.startRound()).toThrow(/exhausted/);
  });

  it("ignores non-finite / non-positive additions", () => {
    const b = new Budget(10);
    b.add(NaN);
    b.add(-5);
    b.add(Infinity);
    expect(b.total).toBe(0);
  });

  it("stops for good once something was spent that it cannot count", () => {
    const b = new Budget(2);
    b.stop("a round reported no cost");
    b.stop("a later reason");
    expect(b.exceeded()).toBe(true);
    expect(b.stopped).toBe("a round reported no cost");
    expect(() => b.startRound()).toThrow(/no cost/);
    expect(b.remaining).toBe(2);
  });
});
