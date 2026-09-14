// Guards the playback hook's rAF glue. The Transport clock itself is unit-tested;
// what can only break HERE is the React binding: the transport surviving re-renders,
// the first frame not jumping by the whole rAF timestamp, and the loop actually
// being torn down (a leaked rAF keeps re-rendering the app forever after unmount).
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePlayback } from "./usePlayback";

let frames: ((ts: number) => void)[] = [];
let cancelled: number[] = [];

beforeEach(() => {
  frames = [];
  cancelled = [];
  vi.stubGlobal("requestAnimationFrame", (cb: (ts: number) => void) => {
    frames.push(cb);
    return frames.length; // 1-based handle
  });
  vi.stubGlobal("cancelAnimationFrame", (h: number) => {
    cancelled.push(h);
  });
});

afterEach(() => vi.unstubAllGlobals());

/** Deliver one animation frame at absolute timestamp `ts`. */
function frame(ts: number): void {
  const cb = frames.pop();
  if (!cb) throw new Error("no animation frame was scheduled");
  act(() => cb(ts));
}

describe("usePlayback", () => {
  it("starts paused at zero with the given duration", () => {
    const { result } = renderHook(() => usePlayback(10));
    expect(result.current).toMatchObject({ time: 0, playing: false, duration: 10 });
  });

  it("does not schedule a frame while paused", () => {
    renderHook(() => usePlayback(10));
    expect(frames).toHaveLength(0);
  });

  it("play starts the loop and pause tears it down", () => {
    const { result } = renderHook(() => usePlayback(10));
    act(() => result.current.play());
    expect(result.current.playing).toBe(true);
    expect(frames).toHaveLength(1);

    act(() => result.current.pause());
    expect(result.current.playing).toBe(false);
    expect(cancelled).toHaveLength(1);
  });

  it("toggle flips playing in both directions", () => {
    const { result } = renderHook(() => usePlayback(10));
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(false);
  });

  it("the FIRST frame does not advance time by the rAF timestamp", () => {
    // rAF hands an absolute page timestamp. Without the `last` guard the opening
    // frame would jump the playhead by however long the app had been running.
    const { result } = renderHook(() => usePlayback(60));
    act(() => result.current.play());
    frame(123_456);
    expect(result.current.time).toBe(0);
  });

  it("advances by the DELTA between frames, not the absolute timestamp", () => {
    const { result } = renderHook(() => usePlayback(60));
    act(() => result.current.play());
    frame(100_000);
    frame(100_500);
    expect(result.current.time).toBeCloseTo(0.5, 6);
    frame(101_000);
    expect(result.current.time).toBeCloseTo(1.0, 6);
  });

  it("keeps re-scheduling while playing", () => {
    const { result } = renderHook(() => usePlayback(60));
    act(() => result.current.play());
    frame(0);
    expect(frames).toHaveLength(1);
    frame(16);
    expect(frames).toHaveLength(1);
  });

  it("seek moves the playhead and re-renders", () => {
    const { result } = renderHook(() => usePlayback(60));
    act(() => result.current.seek(12.5));
    expect(result.current.time).toBeCloseTo(12.5, 6);
  });

  it("keeps the SAME transport across re-renders — a re-render never rewinds", () => {
    const { result, rerender } = renderHook(({ d }) => usePlayback(d), {
      initialProps: { d: 60 },
    });
    act(() => result.current.seek(9));
    rerender({ d: 60 });
    expect(result.current.time).toBeCloseTo(9, 6);
  });

  it("a duration change updates the clock without rewinding the playhead", () => {
    const { result, rerender } = renderHook(({ d }) => usePlayback(d), {
      initialProps: { d: 60 },
    });
    act(() => result.current.seek(9));
    rerender({ d: 120 });
    expect(result.current.duration).toBe(120);
    expect(result.current.time).toBeCloseTo(9, 6);
  });

  it("a SHRINKING duration clamps the playhead inside the new range", () => {
    const { result, rerender } = renderHook(({ d }) => usePlayback(d), {
      initialProps: { d: 60 },
    });
    act(() => result.current.seek(50));
    rerender({ d: 20 });
    expect(result.current.time).toBeLessThanOrEqual(20);
  });

  it("cancels the pending frame on unmount (no loop leaks past the component)", () => {
    const { result, unmount } = renderHook(() => usePlayback(60));
    act(() => result.current.play());
    expect(frames).toHaveLength(1);
    unmount();
    expect(cancelled.length).toBeGreaterThan(0);
  });

  it("stops scheduling once the transport reaches the end and pauses itself", () => {
    const { result } = renderHook(() => usePlayback(1));
    act(() => result.current.play());
    frame(1_000);
    frame(6_000); // 5s of delta against a 1s duration
    expect(result.current.playing).toBe(false);
    expect(result.current.time).toBeLessThanOrEqual(1);
  });

  it("a first frame at timestamp 0 is skipped, not treated as a delta", () => {
    // `last` doubles as the "no previous frame" marker, so a rAF timestamp of
    // exactly 0 costs one frame of motion. Harmless (only reachable at page load)
    // but pinned so a future change to the guard is a deliberate one.
    const { result } = renderHook(() => usePlayback(60));
    act(() => result.current.play());
    frame(0);
    frame(500);
    expect(result.current.time).toBe(0);
    frame(1_000);
    expect(result.current.time).toBeCloseTo(0.5, 6);
  });

  it("play while already playing does not stack a second loop", () => {
    const { result } = renderHook(() => usePlayback(60));
    act(() => result.current.play());
    act(() => result.current.play());
    expect(frames).toHaveLength(1);
  });
});
