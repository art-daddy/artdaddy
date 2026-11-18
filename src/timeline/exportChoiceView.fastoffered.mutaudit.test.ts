// A mutation audit (round 3) of the clamp's list. Fast's own rate off the ladder (72 fps gives 18, 64 and 32 give 16) is an entry of the Frame rate list only where the dialog offers Fast, so `clampOverrides`, `leversShown` and `resolveChoice` must each
// drop it where Fast is not offered and each keep it where it is. One example had been the only witness of `leversShown` without Fast (the random properties draw a pick of exactly this rate too rarely).
import { describe, expect, it } from "vitest";

import { clampOverrides, leversShown, resolveChoice } from "./exportChoiceView";
import { QUICK_BUNDLE, type ProjectFacts } from "./exportRoute";

const project = (fps: number): ProjectFacts => ({
  width: 1920,
  height: 1080,
  fps,
  durationSeconds: 360,
});
// [the project's rate, Fast's own rate there]: neither is on the ladder 60, 50, 30, 25, 24
const OFF_LADDER = [
  [72, 18],
  [64, 16],
  [32, 16],
] as const;

describe("Fast's own off-ladder rate is an entry of the Frame rate list only where Fast is offered", () => {
  it.each(OFF_LADDER)(
    "%i fps project (Fast's own rate %i): dropped by the clamp, by leversShown and by resolveChoice where Fast is not offered",
    (projectFps, own) => {
      const p = project(projectFps);
      expect(clampOverrides({ fps: own }, p, QUICK_BUNDLE, false)).toEqual({});
      expect(leversShown("quality", { fps: own }, p, QUICK_BUNDLE, false).fps).toBeNull();
      for (const choice of ["quality", "fast"] as const)
        expect(resolveChoice(choice, { fps: own }, p, QUICK_BUNDLE, false).kept).toEqual({});
      expect(resolveChoice("quality", { fps: own }, p, QUICK_BUNDLE, false).shown.fps).toBeNull();
    },
  );

  it.each(OFF_LADDER)(
    "%i fps project (Fast's own rate %i): kept by the clamp, by leversShown and by resolveChoice where Fast is offered, and by default",
    (projectFps, own) => {
      const p = project(projectFps);
      expect(clampOverrides({ fps: own }, p, QUICK_BUNDLE, true)).toEqual({ fps: own });
      expect(clampOverrides({ fps: own }, p)).toEqual({ fps: own });
      expect(leversShown("quality", { fps: own }, p, QUICK_BUNDLE, true).fps).toBe(own);
      for (const choice of ["quality", "fast"] as const)
        expect(resolveChoice(choice, { fps: own }, p, QUICK_BUNDLE, true).kept).toEqual({
          fps: own,
        });
      expect(resolveChoice("quality", { fps: own }, p, QUICK_BUNDLE, true).shown.fps).toBe(own);
    },
  );

  it("a rate of the ladder (24 fps at 72) is kept by all three whether or not Fast is offered", () => {
    const p = project(72);
    for (const offered of [true, false]) {
      expect(clampOverrides({ fps: 24 }, p, QUICK_BUNDLE, offered)).toEqual({ fps: 24 });
      expect(leversShown("quality", { fps: 24 }, p, QUICK_BUNDLE, offered).fps).toBe(24);
      expect(resolveChoice("quality", { fps: 24 }, p, QUICK_BUNDLE, offered).kept).toEqual({
        fps: 24,
      });
    }
  });
});
