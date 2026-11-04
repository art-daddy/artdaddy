import { describe, expect, it } from "vitest";
import { EXPORT_TRACE_EVENTS, EXPORT_TRACE_MAX_EVENTS, cleanTrace } from "../api/exportVocabulary";
import {
  ENDING_RESERVE,
  ExportTrace,
  MAX_STALLS_LOGGED,
  RunWatch,
  STALL_LOG_SECONDS,
} from "./exportTrace";

function clockAt(start = 1_000_000) {
  let now = start;
  return { clock: () => now, advance: (ms: number) => void (now += ms) };
}

/** What ffmpeg prints for one progress block. */
const block = (frame: number, outMs: number, end = false) =>
  `frame=${frame}\nfps=30\nout_time_us=${outMs * 1000}\nspeed=1.0x\nprogress=${end ? "end" : "continue"}\n`;

describe("ExportTrace", () => {
  it("records states in order with the time since the request", () => {
    const t = clockAt();
    const trace = new ExportTrace(t.clock);
    trace.record("requested", "chat");
    t.advance(1500);
    trace.record("dialog_shown", "confirm");
    t.advance(2500);
    trace.record("dialog_choice", "continue");
    expect(trace.snapshot()).toEqual([
      { e: "requested", t: 0, v: "chat", n: 0, m: 0 },
      { e: "dialog_shown", t: 1500, v: "confirm", n: 0, m: 0 },
      { e: "dialog_choice", t: 4000, v: "continue", n: 0, m: 0 },
    ]);
  });

  it("hands out copies, so a caller cannot rewrite the story", () => {
    const trace = new ExportTrace();
    trace.record("requested", "menu");
    trace.snapshot()[0].v = "chat";
    expect(trace.snapshot()[0].v).toBe("menu");
  });

  it("never holds more than the report can carry, and always keeps room for how it ended", () => {
    const trace = new ExportTrace();
    for (let i = 0; i < 500; i++) trace.record("stage", "rendering", i);
    expect(trace.snapshot()).toHaveLength(EXPORT_TRACE_MAX_EVENTS - ENDING_RESERVE);
    expect(trace.droppedCount()).toBe(500 - (EXPORT_TRACE_MAX_EVENTS - ENDING_RESERVE));
    for (const ending of ["stall_detected", "guard_tripped", "cancelled", "outcome"] as const)
      expect(trace.record(ending, "failed")).toBe(true);
    const events = trace.snapshot();
    expect(events.at(-1)?.e).toBe("outcome");
    expect(events.length).toBeLessThanOrEqual(EXPORT_TRACE_MAX_EVENTS);
  });

  it("is a trace the report accepts whole, whatever was recorded", () => {
    // Every kind of event, many times: what the recorder holds survives the report's own cleaning
    // unchanged (nothing it records is ever dropped by the server's rules).
    const trace = new ExportTrace();
    for (let round = 0; round < 5; round++)
      for (const code of EXPORT_TRACE_EVENTS) trace.record(code, "", round, 2_147_483_647 + round);
    const events = trace.snapshot();
    expect(cleanTrace(events)).toEqual(events);
    expect(events.length).toBeLessThanOrEqual(EXPORT_TRACE_MAX_EVENTS);
    for (const event of events) {
      expect(Number.isInteger(event.n) && event.n >= 0).toBe(true);
      expect(event.m).toBeLessThanOrEqual(2_147_483_647);
    }
  });

  it("clamps numbers that are not numbers", () => {
    const trace = new ExportTrace();
    trace.record("stage", "", Number.NaN, Number.POSITIVE_INFINITY);
    trace.record("stage", "", -5, 1.6);
    expect(trace.snapshot().map((e) => [e.n, e.m])).toEqual([
      [0, 0],
      [0, 2],
    ]);
  });

  it("knows whether the last state is the one it is about to repeat", () => {
    const trace = new ExportTrace();
    expect(trace.lastIs("stage", "rendering")).toBe(false);
    trace.record("stage", "rendering");
    expect(trace.lastIs("stage", "rendering")).toBe(true);
    expect(trace.lastIs("stage", "saving")).toBe(false);
  });
});

describe("RunWatch", () => {
  function watch(totalMs = 60_000) {
    const t = clockAt();
    const trace = new ExportTrace(t.clock);
    return { t, trace, watch: new RunWatch(trace, totalMs, t.clock) };
  }

  it("notes the first movement as the rendering stage, once", () => {
    const { watch: w, trace } = watch();
    w.chunk(block(10, 400));
    w.chunk(block(20, 800));
    expect(trace.snapshot().filter((e) => e.e === "stage")).toEqual([
      { e: "stage", t: 0, v: "rendering", n: 0, m: 0 },
    ]);
  });

  it("reads progress split across chunks anywhere", () => {
    const { watch: w, t } = watch();
    const text = block(10, 400) + block(20, 800);
    for (let i = 0; i < text.length; i += 7) w.chunk(text.slice(i, i + 7));
    t.advance(3000);
    expect(w.percentReached()).toBe(1); // 800 ms of 60 s
  });

  it("does not take a repeated block for life: ffmpeg prints one every half second even when stuck", () => {
    const { watch: w, trace, t } = watch();
    w.chunk(block(100, 3300));
    for (let second = 0; second < 90; second++) {
      t.advance(1000);
      w.chunk(block(100, 3300)); // the same numbers again
      w.tick();
    }
    const stalls = trace.snapshot().filter((e) => e.e === "stall_detected");
    expect(stalls).toHaveLength(1);
    expect(stalls[0].n).toBeGreaterThanOrEqual(STALL_LOG_SECONDS);
    expect(stalls[0].m).toBe(6); // 3300 ms of 60 s
  });

  it("logs a stall once per gap, and again for the next gap", () => {
    const { watch: w, trace, t } = watch();
    w.chunk(block(1, 100));
    t.advance(70_000);
    w.tick();
    w.tick();
    expect(trace.snapshot().filter((e) => e.e === "stall_detected")).toHaveLength(1);
    w.chunk(block(2, 200)); // it moved again
    t.advance(65_000);
    w.tick();
    expect(trace.snapshot().filter((e) => e.e === "stall_detected")).toHaveLength(2);
  });

  it("logs nothing for an export that keeps moving, however long it takes", () => {
    const { watch: w, trace, t } = watch(3_600_000);
    for (let i = 1; i <= 2000; i++) {
      t.advance(5000);
      w.chunk(block(i * 10, i * 330));
      w.tick();
    }
    expect(trace.snapshot().filter((e) => e.e === "stall_detected")).toHaveLength(0);
    expect(w.finish()).toBe(5);
    expect(trace.snapshot().filter((e) => e.e === "heartbeat_gap")).toHaveLength(0);
  });

  it("counts a reset of the counters (the next step of a segmented render) as movement", () => {
    const { watch: w, trace, t } = watch();
    w.chunk(block(500, 16_000));
    t.advance(50_000);
    w.chunk(block(3, 100)); // a new step starts counting from the top
    t.advance(50_000);
    w.tick();
    expect(trace.snapshot().filter((e) => e.e === "stall_detected")).toHaveLength(0);
  });

  it("reports the longest gap at the end, and records it when it is worth a line", () => {
    const { watch: w, trace, t } = watch();
    w.chunk(block(1, 100));
    t.advance(12_000);
    w.chunk(block(2, 200));
    t.advance(3_000);
    w.chunk(block(3, 300));
    expect(w.finish()).toBe(12);
    expect(trace.snapshot().find((e) => e.e === "heartbeat_gap")).toMatchObject({ n: 12 });
  });

  it("counts a stall that was never followed by movement when the run ends", () => {
    const { watch: w, trace, t } = watch();
    w.chunk(block(1, 100));
    t.advance(130_000);
    expect(w.finish()).toBe(130);
    const events = trace.snapshot().map((e) => e.e);
    expect(events).toContain("stall_detected");
    expect(events).toContain("heartbeat_gap");
  });

  it("measures a slow start (no movement at all) from when the watch began", () => {
    const { watch: w, trace, t } = watch();
    t.advance(61_000);
    w.tick();
    expect(trace.snapshot()).toEqual([{ e: "stall_detected", t: 61_000, v: "", n: 61, m: 0 }]);
  });

  it("copes with a total length of zero and garbage in the stream", () => {
    const { watch: w, trace } = watch(0);
    w.chunk("garbage\n\u0000\nprogress=continue\n");
    w.chunk(block(5, 100));
    expect(w.percentReached()).toBe(0);
    expect(trace.snapshot().length).toBeGreaterThan(0);
  });

  it("keeps room for how an export ended when it stalls again and again", () => {
    // A thrashing export that trickles a frame a minute is the case the trace exists for: its stalls
    // must not use up the slots kept back for the guard, the cancel and the outcome.
    const { watch: w, trace, t } = watch();
    w.chunk(block(1, 100));
    for (let gap = 0; gap < 40; gap++) {
      t.advance((STALL_LOG_SECONDS + 5) * 1000);
      w.tick();
      w.chunk(block(gap + 2, (gap + 2) * 100));
    }
    expect(trace.snapshot().filter((e) => e.e === "stall_detected")).toHaveLength(
      MAX_STALLS_LOGGED,
    );
    expect(trace.record("stage", "checking")).toBe(true);
    expect(trace.record("stage", "saving")).toBe(true);
    expect(trace.record("guard_tripped", "resident")).toBe(true);
    expect(trace.record("cancelled", "person_card")).toBe(true);
    expect(trace.record("outcome", "failed")).toBe(true);
    expect(trace.snapshot().at(-1)?.e).toBe("outcome");
  });

  it("still says how long the longest silence was when more stalls happened than it records", () => {
    const { watch: w, trace, t } = watch();
    w.chunk(block(1, 100));
    for (let gap = 0; gap < 10; gap++) {
      t.advance(70_000);
      w.tick();
      w.chunk(block(gap + 2, (gap + 2) * 100));
    }
    t.advance(300_000); // the longest silence comes last, after the stall cap was reached
    expect(w.finish()).toBe(300);
    expect(trace.snapshot().find((e) => e.e === "heartbeat_gap")).toMatchObject({ n: 300 });
  });
});
