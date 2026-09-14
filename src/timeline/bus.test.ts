import { describe, expect, it, vi } from "vitest";

import { _resetTimelineBus, emitTimelineChange, onTimelineChange } from "./bus";
import { emptyTimeline } from "./model";

describe("timeline bus", () => {
  it("delivers writes to subscribers with source + projectDir", () => {
    _resetTimelineBus();
    const tl = emptyTimeline();
    const seen: Array<{ tl: unknown; source: string; dir?: string }> = [];
    onTimelineChange((t, c) => seen.push({ tl: t, source: c.source, dir: c.projectDir }));
    emitTimelineChange(tl, "engine", "/proj");
    expect(seen).toHaveLength(1);
    expect(seen[0].tl).toBe(tl);
    expect(seen[0].source).toBe("engine");
    expect(seen[0].dir).toBe("/proj");
  });

  it("defaults the source to 'engine'", () => {
    _resetTimelineBus();
    const fn = vi.fn();
    onTimelineChange(fn);
    emitTimelineChange(emptyTimeline());
    expect(fn).toHaveBeenCalledWith(expect.anything(), { source: "engine", projectDir: undefined });
  });

  it("stops delivering after unsubscribe", () => {
    _resetTimelineBus();
    const fn = vi.fn();
    const off = onTimelineChange(fn);
    off();
    emitTimelineChange(emptyTimeline());
    expect(fn).not.toHaveBeenCalled();
  });

  it("isolates a throwing subscriber from the rest", () => {
    _resetTimelineBus();
    const good = vi.fn();
    onTimelineChange(() => {
      throw new Error("boom");
    });
    onTimelineChange(good);
    expect(() => emitTimelineChange(emptyTimeline())).not.toThrow();
    expect(good).toHaveBeenCalled();
  });

  it("_resetTimelineBus drops all subscribers", () => {
    const fn = vi.fn();
    onTimelineChange(fn);
    _resetTimelineBus();
    emitTimelineChange(emptyTimeline());
    expect(fn).not.toHaveBeenCalled();
  });
});
