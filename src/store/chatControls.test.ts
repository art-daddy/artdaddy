import { describe, expect, it } from "vitest";

import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, PICKER_MODELS, effortsFor } from "./chatControls";

describe("the assistant's controls", () => {
  it("start on a model the picker offers, at an effort every model it offers accepts", () => {
    expect(PICKER_MODELS).toContain(DEFAULT_MODEL);
    for (const model of PICKER_MODELS) expect(effortsFor(model)).toContain(DEFAULT_EFFORT);
  });

  it("start at medium effort, and high is still one the person can pick, for every model", () => {
    expect(DEFAULT_EFFORT).toBe("medium");
    for (const model of PICKER_MODELS) expect(effortsFor(model)).toContain("high");
  });

  it("never offer an effort outside the list, and offer each model at least one", () => {
    for (const model of PICKER_MODELS) {
      const offered = effortsFor(model);
      expect(offered.length).toBeGreaterThan(0);
      for (const effort of offered) expect(EFFORTS).toContain(effort);
    }
  });
});
