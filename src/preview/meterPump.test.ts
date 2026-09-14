// The shared meter pump. The invariant worth guarding is that N meters cost ONE loop and see the
// SAME elapsed time — two meters disagreeing about dt would decay at different rates on screen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { publishPreviewAudio, type PreviewAudio } from "./audioEngine";
import { FLOOR_DB } from "./meter";
import { MASTER, clearClipIndicators, resetMeterPump, subscribeMeter } from "./meterPump";

let frames: Array<(t: number) => void> = [];
let now = 0;
let rafCount = 0;
let liveLoops = 0;

const advance = (ms: number) => {
  now += ms;
  const due = frames;
  frames = [];
  for (const f of due) {
    liveLoops--; // this frame has fired; the callback schedules the next one
    f(now);
  }
};

/** Stand in for the engine: whatever levels the test wants to report. */
const engine = (levels: { master: [number, number]; tracks: Record<string, [number, number]> }) =>
  publishPreviewAudio({ levels: () => levels } as unknown as PreviewAudio);

beforeEach(() => {
  frames = [];
  now = 0;
  rafCount = 0;
  liveLoops = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    rafCount++;
    liveLoops++;
    frames.push(cb);
    return rafCount;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    liveLoops--;
  });
  engine({ master: [0, 0], tracks: {} });
});

afterEach(() => {
  resetMeterPump();
  publishPreviewAudio(null);
});

describe("meter pump", () => {
  it("runs ONE loop no matter how many meters are watching", () => {
    const a = subscribeMeter(MASTER, () => {});
    const b = subscribeMeter("a1", () => {});
    const c = subscribeMeter("a2", () => {});
    expect(rafCount).toBe(1); // one scheduled frame, not three
    advance(16);
    expect(rafCount).toBe(2); // ...and it reschedules once per frame
    a();
    b();
    c();
  });

  it("stops the loop when the last meter leaves, and restarts for a new one", () => {
    const off = subscribeMeter(MASTER, () => {});
    advance(16);
    expect(liveLoops).toBeGreaterThan(0);
    off();
    expect(liveLoops).toBe(0); // nothing on screen -> no work
    subscribeMeter("a1", () => {});
    expect(liveLoops).toBe(1);
  });

  it("gives every channel its OWN level, from one read", () => {
    engine({ master: [1, 1], tracks: { a1: [0.5, 0.5], a2: [0, 0] } });
    const seen: Record<string, number> = {};
    subscribeMeter(MASTER, (m) => (seen.master = m.left.db));
    subscribeMeter("a1", (m) => (seen.a1 = m.left.db));
    subscribeMeter("a2", (m) => (seen.a2 = m.left.db));
    advance(16);
    expect(seen.master).toBeCloseTo(0, 6);
    expect(seen.a1).toBeCloseTo(-6.02, 1);
    expect(seen.a2).toBe(FLOOR_DB);
  });

  it("reports left and right independently", () => {
    engine({ master: [1, 0], tracks: {} });
    let m = { l: 0, r: 0 };
    subscribeMeter(MASTER, (s) => (m = { l: s.left.db, r: s.right.db }));
    advance(16);
    expect(m.l).toBeCloseTo(0, 6);
    expect(m.r).toBe(FLOOR_DB);
  });

  it("reads a track the engine does not know about as silence, not as a crash", () => {
    engine({ master: [0, 0], tracks: {} });
    let db = 99;
    subscribeMeter("ghost", (m) => (db = m.left.db));
    advance(16);
    expect(db).toBe(FLOOR_DB);
  });

  it("survives having no engine published at all", () => {
    publishPreviewAudio(null);
    let called = false;
    subscribeMeter(MASTER, () => (called = true));
    expect(() => advance(16)).not.toThrow();
    expect(called).toBe(true);
  });

  it("does not dump the whole idle gap into the first frame after a restart", () => {
    // A pump that kept `last` across a stop would compute a multi-second dt on resume and
    // slam every meter to the floor in one frame.
    engine({ master: [1, 1], tracks: {} });
    const off = subscribeMeter(MASTER, () => {});
    advance(16);
    off();
    now += 60_000; // a minute paused
    let db = 99;
    subscribeMeter(MASTER, (m) => (db = m.left.db));
    advance(16);
    expect(db).toBeCloseTo(0, 6);
  });

  it("clears latched clip indicators only when asked", () => {
    engine({ master: [1.5, 1.5], tracks: {} });
    let clipped = false;
    subscribeMeter(MASTER, (m) => (clipped = m.left.clipped));
    advance(16);
    expect(clipped).toBe(true);
    engine({ master: [0, 0], tracks: {} });
    advance(16);
    expect(clipped).toBe(true); // silence alone does NOT clear it
    clearClipIndicators();
    advance(16);
    expect(clipped).toBe(false);
  });

  it("keeps a channel alive while any subscriber remains", () => {
    engine({ master: [1, 1], tracks: {} });
    let seen = 0;
    const off1 = subscribeMeter(MASTER, () => seen++);
    const off2 = subscribeMeter(MASTER, () => seen++);
    advance(16);
    expect(seen).toBe(2); // both notified from one read
    off1();
    seen = 0;
    advance(16);
    expect(seen).toBe(1);
    off2();
  });
});
