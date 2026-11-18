// Mutation audit of the Quality | Fast view model: `leversShown` is an exported function in its own right and must read the same bundle as the clamp it calls. Through `resolveChoice` the bundle is
// read twice (the resolver clamps with it first), so only a direct call can tell a `leversShown` that lost the bundle from one that kept it.
import { describe, expect, it } from "vitest";

import { leversShown } from "./exportChoiceView";
import { QUICK_BUNDLE, type ProjectFacts, type QuickBundle } from "./exportRoute";

const P72: ProjectFacts = { width: 1920, height: 1080, fps: 72, durationSeconds: 360 };
// A cap of 10 halves 72 to 36, 18 and then 9: Fast's own rate is 9 here, where under the real bundle (a cap of 30) it is 18.
const CAPPED: QuickBundle = { ...QUICK_BUNDLE, maxFps: 10 };

describe("leversShown reads the bundle it is given, in the list its picks are checked against", () => {
  it("shows a pick that only the bundle's own list holds (9 at 72 fps under a cap of 10), as Quality's pick and as Fast's", () => {
    expect(leversShown("quality", { fps: 9 }, P72, CAPPED).fps).toBe(9);
    expect(leversShown("fast", { fps: 9 }, P72, CAPPED).fps).toBe(9);
  });

  it("drops a pick that only the default bundle's list holds (18 at 72 fps): Quality falls back to the project's rate, Fast to its own rate under the bundle (9)", () => {
    expect(leversShown("quality", { fps: 18 }, P72, CAPPED).fps).toBeNull();
    expect(leversShown("fast", { fps: 18 }, P72, CAPPED).fps).toBe(9);
  });

  it("is the same list for the real bundle: 18 at 72 fps is held, 9 is not", () => {
    expect(leversShown("quality", { fps: 18 }, P72).fps).toBe(18);
    expect(leversShown("quality", { fps: 9 }, P72).fps).toBeNull();
  });
});
