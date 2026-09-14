// The gate decides whether playback waits for the decoder. Both directions matter: not
// waiting is the reported bug (playhead runs over a frozen picture), and waiting forever
// would be worse than the bug it fixes.
import { describe, expect, it } from "vitest";

import { MAX_STALL_MS, StallGate } from "./stallGate";

describe("StallGate", () => {
  it("does not hold while frames are arriving", () => {
    const g = new StallGate();
    expect(g.hold(16)).toBe(false);
    expect(g.hold(16)).toBe(false);
  });

  it("holds the clock once the compositor runs dry", () => {
    const g = new StallGate();
    g.setStarved(true);
    expect(g.hold(16)).toBe(true);
  });

  it("gives up rather than freezing playback forever", () => {
    // A source that never decodes must not deadlock the transport. Past the ceiling the
    // clock runs again and the preview degrades to its old behaviour.
    const g = new StallGate(100);
    g.setStarved(true);
    let waited = 0;
    for (let i = 0; i < 1000 && g.hold(16); i++) waited += 16;
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(100 + 16);
    expect(g.hold(16)).toBe(false); // and it stays given up while still starved
  });

  it("waits the full ceiling, not one frame of it", () => {
    // An off-by-one that spends the budget in a single tick would make the fix inert.
    const g = new StallGate(MAX_STALL_MS);
    g.setStarved(true);
    let ticks = 0;
    while (g.hold(16) && ticks < 10_000) ticks++;
    expect(ticks * 16).toBeGreaterThanOrEqual(MAX_STALL_MS);
  });

  it("resumes immediately when frames arrive", () => {
    const g = new StallGate();
    g.setStarved(true);
    expect(g.hold(16)).toBe(true);
    g.setStarved(false);
    expect(g.hold(16)).toBe(false);
  });

  it("gives a later stall its own full budget", () => {
    // The failure direction: carrying an exhausted budget forward would make every stall
    // after the first one silently do nothing.
    const g = new StallGate(100);
    g.setStarved(true);
    while (g.hold(16));
    g.setStarved(false);
    g.setStarved(true);
    expect(g.hold(16)).toBe(true);
  });

  it("ignores a repeated starve report instead of restarting the wait", () => {
    // The worker is edge-triggered, but a duplicate must not renew the budget - that is
    // how a bounded wait turns back into an unbounded one.
    const g = new StallGate(100);
    g.setStarved(true);
    let ticks = 0;
    while (ticks < 1000) {
      g.setStarved(true);
      if (!g.hold(16)) break;
      ticks++;
    }
    expect(ticks * 16).toBeLessThanOrEqual(100 + 16);
  });

  it("reset() renews the budget without forgetting that we are starved", () => {
    // The bug this guards: the worker reports EDGES only. If pressing play cleared the
    // starved flag, a decoder that was already cold would never be reported again and the
    // clock would run straight through the stall - the original symptom, restored.
    const g = new StallGate(100);
    g.setStarved(true);
    while (g.hold(16));
    g.reset();
    expect(g.hold(16)).toBe(true);
  });

  it("cannot be starved of budget by a negative or absurd frame delta", () => {
    const g = new StallGate(100);
    g.setStarved(true);
    expect(g.hold(-1000)).toBe(true);
    expect(g.hold(NaN)).toBe(true);
  });
});
