import { describe, expect, it } from "vitest";

import { evalTier1 } from "./oracle";
import type { Scenario } from "./types";
import type { Timeline } from "../timeline/model";

const tl = {} as Timeline;
const base: Scenario = { id: "s", title: "t", seed: () => tl, prompt: "p" };

describe("evalTier1", () => {
  it("passes when there is no assertion", () => {
    expect(evalTier1(base, tl)).toEqual({ passed: true, violations: [] });
  });

  it("passes when the assertion holds", () => {
    expect(evalTier1({ ...base, expect: () => undefined }, tl).passed).toBe(true);
  });

  it("fails with the thrown message when the assertion breaks", () => {
    const r = evalTier1(
      {
        ...base,
        expect: () => {
          throw new Error("outro not at 60");
        },
      },
      tl,
    );
    expect(r.passed).toBe(false);
    expect(r.violations).toEqual(["tier1: outro not at 60"]);
  });
});
