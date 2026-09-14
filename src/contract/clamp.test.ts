import { beforeAll, describe, expect, it } from "vitest";

import { setContract } from ".";
import { clampArgs } from "./clamp";

// The contract is pulled at runtime; seed the in-memory catalog for the tests.
beforeAll(() => {
  setContract({
    version: "test",
    tools: [
      {
        name: "apply_color",
        parameters: {
          properties: {
            exposure: { minimum: -3, maximum: 3 },
            saturation: { minimum: 0, maximum: 3 },
            masterCurve: { items: { items: { minimum: 0, maximum: 1 } } },
          },
        },
      },
    ],
  });
});

describe("clampArgs (contract-driven)", () => {
  it("clamps numeric args to the contract min/max", () => {
    // apply_color: exposure -3..3, saturation 0..3.
    const r = clampArgs("apply_color", {
      clip_ids: ["a"],
      exposure: 99,
      saturation: -5,
      contrast: 1.2,
    });
    expect(r.exposure).toBe(3);
    expect(r.saturation).toBe(0);
    expect(r.contrast).toBe(1.2); // already in range -> untouched
  });
  it("clamps nested curve points to 0..1", () => {
    const r = clampArgs("apply_color", {
      clip_ids: ["a"],
      masterCurve: [
        [-1, 2],
        [0.5, 0.5],
      ],
    }) as {
      masterCurve: number[][];
    };
    expect(r.masterCurve).toEqual([
      [0, 1],
      [0.5, 0.5],
    ]);
  });
  it("is a no-op for params with no declared range (strings, ids)", () => {
    const r = clampArgs("apply_color", { clip_ids: ["a"], lut: "/x.cube" });
    expect(r).toEqual({ clip_ids: ["a"], lut: "/x.cube" });
  });
  it("leaves unknown tools and unschema'd params untouched", () => {
    expect(clampArgs("not_a_tool", { x: 999 })).toEqual({ x: 999 });
  });
});
