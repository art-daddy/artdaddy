// The activity evidence: the one-line mark the app process prints, and the verdict (idle, busy or unknown) the "no
// progress" stop asks of the readings. A new PURE module, so: scripted processes whose outcome is what the person sees
// (a stop, or none), the edge of every threshold, and properties over the traces the ring can hold, checked against a
// second reading of the rule written differently and against what the generated process REALLY used.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_COUNTER_MAX,
  ACTIVITY_MARK_PREFIX,
  ACTIVITY_RING_CAPACITY,
  ACTIVITY_STALE_SECONDS,
  ActivityRing,
  IDLE_CPU_MS_PER_SECOND,
  IDLE_READ_BYTES,
  formatActivityMark,
  parseActivityMarks,
  quietVerdict,
  stripActivityMarks,
  type ActivityMark,
  type ActivityVerdict,
} from "./exportActivity";
import { quietSeconds, type LiveFacts, type LiveStageName } from "./exportWords";

const MIB = 1024 * 1024;
const STAGES: readonly LiveStageName[] = ["queued", "preparing", "rendering", "checking", "saving"];

/** One reading: when it arrived (seconds on the page's clock), then the two counters. */
type Row = readonly [t: number, cpuMs: number, readBytes: number];

const ringOf = (rows: readonly Row[], capacity?: number): ActivityRing => {
  const ring = new ActivityRing(capacity);
  for (const [t, cpuMs, readBytes] of rows) ring.push(t, { cpuMs, readBytes });
  return ring;
};

/** A mark every `every` seconds from 0 to `until`, from a process whose counters at second t are cpu(t) and read(t). */
const rhythm = (
  until: number,
  cpu: (t: number) => number,
  read: (t: number) => number = () => 0,
  every = 5,
): Row[] => {
  const rows: Row[] = [];
  for (let t = 0; t <= until; t += every) rows.push([t, cpu(t), read(t)]);
  return rows;
};

describe("ActivityRing on a scripted process", () => {
  /** What the ring says at each mark, fed as the page feeds it: the mark arrives, and the tick asks (`tickFirst`: the
   *  tick asks a moment before the mark lands). Also asked 2 s after each mark, between two marks. */
  const asked = (rows: readonly Row[], tickFirst: boolean) => {
    const ring = new ActivityRing();
    const at = new Map<number, ActivityVerdict>();
    const between = new Map<number, ActivityVerdict>();
    for (const [t, cpuMs, readBytes] of rows) {
      if (tickFirst) at.set(t, ring.verdict(t));
      ring.push(t, { cpuMs, readBytes });
      if (!tickFirst) at.set(t, ring.verdict(t));
      between.set(t + 2, ring.verdict(t + 2));
    }
    return { at, between };
  };

  it("calls a quiet process idle from t = 180 on the 5-second rhythm, and not before", () => {
    // 2 ms of processor a second: blocked on something, with its timers and its progress thread alive.
    const rows = rhythm(600, (t) => 2 * t);
    for (const tickFirst of [false, true]) {
      const { at, between } = asked(rows, tickFirst);
      for (const [t, verdict] of at) expect(verdict, `t = ${t}`).toBe(t < 180 ? "unknown" : "idle");
      for (const [t, verdict] of between)
        expect(verdict, `t = ${t}`).toBe(t < 180 ? "unknown" : "idle");
    }
  });

  it("calls a busy process busy once its window is covered, and never idle", () => {
    const { at } = asked(
      rhythm(600, (t) => 600 * t),
      false,
    );
    for (const [t, verdict] of at) expect(verdict, `t = ${t}`).toBe(t < 180 ? "unknown" : "busy");
  });

  it("calls a disk-bound process busy although its processor is nearly quiet", () => {
    // 5 ms of processor a second, 100 KiB a second from a slow drive: 18 MiB in a window.
    const { at } = asked(
      rhythm(
        400,
        (t) => 5 * t,
        (t) => 100 * 1024 * t,
      ),
      false,
    );
    for (const [t, verdict] of at) expect(verdict, `t = ${t}`).toBe(t < 180 ? "unknown" : "busy");
    // and the same drive reading almost nothing is idle
    const slow = asked(
      rhythm(
        400,
        (t) => 5 * t,
        (t) => 5 * t,
      ),
      false,
    );
    expect(slow.at.get(400)).toBe("idle");
  });

  it("goes unknown when the marks stop coming, however quiet the process was", () => {
    const ring = ringOf(rhythm(300, () => 0));
    expect(ring.verdict(300)).toBe("idle");
    expect(ring.verdict(300 + ACTIVITY_STALE_SECONDS)).toBe("idle");
    expect(ring.verdict(300 + ACTIVITY_STALE_SECONDS + 0.5)).toBe("unknown");
    expect(ring.verdict(900)).toBe("unknown");
  });

  it("needs a window that holds no hole after the marks come back", () => {
    // The sampler (or the PC) went away for 90 s, 300 to 390, in the middle of a quiet run. Asked as the run goes on, so
    // every reading is from the past of the time it is asked at.
    const returned = (until: number) =>
      ringOf([
        ...rhythm(300, () => 0),
        ...rhythm(until - 390, () => 0).map(([t]): Row => [t + 390, 0, 0]),
      ]);
    expect(returned(390).verdict(390)).toBe("unknown"); // the marks are back, the hole is inside the window
    expect(returned(500).verdict(500)).toBe("unknown");
    // the part of the hole still inside the window is 20 s once the window starts at 370
    expect(returned(549).verdict(549)).toBe("unknown");
    expect(returned(550).verdict(550)).toBe("idle");
  });

  it("is busy while a process that started silent is awake, and idle again one quiet window after it sleeps", () => {
    // Quiet to t = 100, a second of processor every second until t = 160, then quiet again.
    const cpu = (t: number) => (t <= 100 ? 0 : Math.min(t, 160) * 1000 - 100_000);
    const { at } = asked(rhythm(500, cpu), false);
    for (const t of [180, 200, 240]) expect(at.get(t), `t = ${t}`).toBe("busy");
    // the reading before the window's start (155) still holds the last 5 s of work: 5,000 ms
    expect(at.get(335)).toBe("busy");
    expect(at.get(340)).toBe("idle"); // 180 s after the last second of work
    expect(at.get(500)).toBe("idle");
  });

  it("starts again after clear(): nothing read before counts, and a fresh full window is needed", () => {
    const ring = ringOf(rhythm(300, () => 0));
    expect(ring.verdict(300)).toBe("idle");
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.verdict(300)).toBe("unknown");
    for (let t = 305; t < 485; t += 5) {
      ring.push(t, { cpuMs: 0, readBytes: 0 });
      expect(ring.verdict(t), `t = ${t}`).toBe("unknown");
    }
    ring.push(485, { cpuMs: 0, readBytes: 0 });
    expect(ring.verdict(485)).toBe("idle"); // 180 s after the first mark after the clear
  });

  it("keeps the newest readings only, and a window longer than they cover is unknown, never a guess", () => {
    const ring = ringOf(rhythm(1000, () => 0));
    expect(ring.size).toBe(ACTIVITY_RING_CAPACITY);
    // 48 readings 5 s apart reach back 235 s
    expect(ring.verdict(1000, 235)).toBe("idle");
    expect(ring.verdict(1000, 236)).toBe("unknown");
    expect(ring.verdict(1000, 600)).toBe("unknown");
    const small = ringOf(
      rhythm(1000, () => 0),
      10,
    );
    expect(small.size).toBe(10);
    expect(small.verdict(1000)).toBe("unknown");
    expect(small.verdict(1000, 45)).toBe("idle");
  });

  it("is not fooled by a flood of readings at one moment: they push the history out and cover nothing", () => {
    const ring = ringOf(rhythm(400, () => 0));
    for (let i = 0; i < 100; i++) ring.push(405, { cpuMs: 0, readBytes: 0 });
    expect(ring.size).toBe(ACTIVITY_RING_CAPACITY);
    expect(ring.verdict(405)).toBe("unknown");
  });
});

describe("the edges of the rule", () => {
  /** Quiet until `step`, then `cpu` ms and `read` bytes used in one go, then quiet again; asked at t = 180. */
  const usedAt = (step: number, cpu: number, read: number) =>
    ringOf(
      rhythm(
        180,
        (t) => (t >= step ? cpu : 0),
        (t) => (t >= step ? read : 0),
      ),
    );

  it("is idle one unit under each threshold and busy at it", () => {
    // 20 ms of processor for each of the 180 seconds, and 1 MiB read
    expect(usedAt(5, 3599, 0).verdict(180)).toBe("idle");
    expect(usedAt(5, 3600, 0).verdict(180)).toBe("busy");
    expect(usedAt(5, 0, 1_048_575).verdict(180)).toBe("idle");
    expect(usedAt(5, 0, 1_048_576).verdict(180)).toBe("busy");
  });

  it("needs both counters under their thresholds", () => {
    expect(usedAt(5, 3599, 1_048_575).verdict(180)).toBe("idle");
    expect(usedAt(5, 3600, 1_048_575).verdict(180)).toBe("busy");
    expect(usedAt(5, 3599, 1_048_576).verdict(180)).toBe("busy");
  });

  it("scales the processor threshold with the window, not the read threshold, and ignores use before the window", () => {
    expect(usedAt(125, 1199, 0).verdict(180, 60)).toBe("idle"); // 20 ms x 60 s
    expect(usedAt(125, 1200, 0).verdict(180, 60)).toBe("busy");
    expect(usedAt(125, 0, 1_048_575).verdict(180, 60)).toBe("idle");
    expect(usedAt(125, 0, 1_048_576).verdict(180, 60)).toBe("busy");
    expect(usedAt(5, 5_000_000, 5_000_000_000).verdict(180, 60)).toBe("idle");
  });

  it("is unknown until the readings reach the window's start", () => {
    const ring = ringOf(rhythm(175, () => 0));
    expect(ring.verdict(180)).toBe("idle"); // the reading at t = 0 is the start of the window
    expect(ring.verdict(179.9)).toBe("unknown"); // a window that began 0.1 s before the first reading
  });

  it("is unknown when no reading falls inside the window, however short the window", () => {
    const ring = ringOf(rhythm(100, () => 0));
    expect(ring.verdict(110, 10)).toBe("unknown"); // the newest reading is at 100: on the window's edge, not in it
    expect(ring.verdict(104, 10)).toBe("idle");
  });

  /** Quiet readings every 5 s to t = 100, then none for `hole` s, then every 5 s again; asked at `until`. */
  const withHole = (hole: number, until: number) =>
    ringOf([
      ...rhythm(100, () => 0),
      ...rhythm(until - 100 - hole, () => 0).map(([t]): Row => [t + 100 + hole, 0, 0]),
    ]);

  it("calls a window with a hole longer than the stale limit unknown, and one of exactly that limit fine", () => {
    expect(withHole(21, 200).verdict(200)).toBe("unknown");
    expect(withHole(20, 200).verdict(200)).toBe("idle");
    expect(withHole(90, 200).verdict(200)).toBe("unknown");
  });

  it("counts a hole only for the part of it that lies inside the window", () => {
    // 100 to 121 is the hole: it is a 20 s hole once the window starts at 101
    expect(withHole(21, 280).verdict(280)).toBe("unknown");
    expect(withHole(21, 281).verdict(281)).toBe("idle");
  });

  it("never calls a window idle when a counter went down inside it, whatever the difference says", () => {
    // A reader that started again: the counter falls. End minus start is negative here...
    const negative = ringOf(rhythm(180, (t) => (t < 90 ? 100_000 : 100)));
    expect(negative.verdict(180)).toBe("unknown");
    // ...and small and positive here, although the process used 85 s of processor before the fall.
    const hidden = ringOf(rhythm(180, (t) => (t < 90 ? t * 1000 : t - 90)));
    expect(hidden.verdict(180)).toBe("unknown");
    const reads = ringOf(
      rhythm(
        180,
        () => 0,
        (t) => (t < 90 ? 10 * MIB : 0),
      ),
    );
    expect(reads.verdict(180)).toBe("unknown");
    // one bad reading in the middle, the counters right again after it
    const blip = ringOf(rhythm(180, (t) => (t === 100 ? 0 : 50_000)));
    expect(blip.verdict(180)).toBe("unknown");
  });

  it("forgets a fall in a counter once the window has moved past it", () => {
    const rows = rhythm(190, (t) => (t < 10 ? 50_000 : 5));
    expect(ringOf(rows.slice(0, 38)).verdict(185)).toBe("unknown"); // the window starts at 5: the fall at 10 is inside
    expect(ringOf(rows).verdict(190)).toBe("idle"); // it starts at 10: the reading at 10 is already after the fall
  });

  it("keeps readings that share a time and judges them like any others", () => {
    // Twice the readings, so room for twice as many: a ring of 48 would hold only half the window.
    const doubled = (rows: Row[]) =>
      ringOf(
        rows.flatMap((row) => [row, row]),
        200,
      );
    expect(doubled(rhythm(180, () => 0)).verdict(180)).toBe("idle");
    expect(doubled(rhythm(175, () => 0)).verdict(179.9)).toBe("unknown");
    expect(doubled(rhythm(180, (t) => 600 * t)).verdict(180)).toBe("busy");
  });

  it("counts from the oldest of the readings that share the window's start time", () => {
    // Two readings at t = 0: the second one is already past 4,000 ms. The use between them is use inside the window.
    const ring = ringOf([[0, 0, 0], [0, 4000, 0], ...rhythm(180, () => 4000).slice(1)]);
    expect(ring.verdict(180)).toBe("busy");
  });

  it("starts again when the clock goes back, so nothing from before counts", () => {
    const ring = ringOf(rhythm(300, () => 0));
    expect(ring.verdict(300)).toBe("idle");
    ring.push(100, { cpuMs: 0, readBytes: 0 });
    expect(ring.size).toBe(1);
    expect(ring.verdict(100)).toBe("unknown");
    for (let t = 105; t <= 275; t += 5) ring.push(t, { cpuMs: 0, readBytes: 0 });
    expect(ring.verdict(275)).toBe("unknown");
    ring.push(280, { cpuMs: 0, readBytes: 0 });
    expect(ring.verdict(280)).toBe("idle"); // 180 s after the reading the ring started again from
  });

  it("is unknown when asked about a time before its newest reading", () => {
    const ring = ringOf(rhythm(300, () => 0));
    expect(ring.verdict(300)).toBe("idle");
    for (const now of [299, 0, -1e9]) expect(ring.verdict(now), `now = ${now}`).toBe("unknown");
  });

  it("answers a question that is not a number or a window that is not positive with unknown", () => {
    const ring = ringOf(rhythm(300, () => 0));
    for (const now of [NaN, Infinity, -Infinity]) expect(ring.verdict(now)).toBe("unknown");
    for (const window of [NaN, Infinity, -Infinity, 0, -180])
      expect(ring.verdict(300, window), `window = ${window}`).toBe("unknown");
    expect(new ActivityRing().verdict(300)).toBe("unknown"); // no mark ever arrived
  });

  it("drops a reading whose time or counters are not usable, and the rest are read as if it never came", () => {
    const rows = rhythm(300, (t) => t);
    const dirty = new ActivityRing();
    for (const [t, cpuMs, readBytes] of rows) {
      dirty.push(NaN, { cpuMs, readBytes });
      dirty.push(t, { cpuMs: NaN, readBytes });
      dirty.push(t, { cpuMs, readBytes: Infinity });
      dirty.push(t, { cpuMs: -1, readBytes });
      dirty.push(t, { cpuMs, readBytes: ACTIVITY_COUNTER_MAX + 2 });
      dirty.push(Infinity, { cpuMs, readBytes });
      dirty.push(t, { cpuMs, readBytes });
    }
    expect(dirty.size).toBe(ringOf(rows).size);
    expect(dirty.verdict(300)).toBe("idle");
  });
});

// A process described by what it REALLY did: spans of constant use. Rates that are multiples of 4 a second and times on
// a grid of quarter seconds keep every counter a whole number, so nothing here is rounded.
interface Span {
  seconds: number;
  cpuPerS: number;
  readPerS: number;
}
const usedBy = (spans: readonly Span[], t: number, pick: "cpuPerS" | "readPerS"): number => {
  let from = 0;
  let total = 0;
  for (const span of spans) {
    total += Math.max(0, Math.min(t, from + span.seconds) - from) * span[pick];
    from += span.seconds;
  }
  return total;
};

interface Trace {
  rows: Row[];
  now: number;
  window: number;
}

/** Traces of the shapes the ring meets: a cadence near 5 s, holes, doubled times, counters that fall, a clock asked
 *  early or late, and windows from short to the edge of what 48 readings cover. */
const traceArb: fc.Arbitrary<Trace> = fc
  .record({
    start: fc.integer({ min: -50, max: 1_000 }),
    scale: fc.constantFrom(0, 1, 4, 16, 64, 256),
    steps: fc.array(
      fc.record({
        gap: fc.constantFrom(4, 5, 5, 5, 5, 5, 6),
        cpu: fc.constantFrom(0, 0, 1, 2),
        read: fc.constantFrom(0, 0, 1, 3),
      }),
      { minLength: 40, maxLength: 80, size: "max" },
    ),
    holes: fc.array(fc.record({ at: fc.nat(79), gap: fc.constantFrom(0, 0, 20, 21, 30, 90) }), {
      maxLength: 2,
    }),
    falls: fc.array(
      fc.record({
        at: fc.nat(79),
        drop: fc.constantFrom(1, 100, 1_000_000),
        which: fc.constantFrom("cpu", "read"),
        stays: fc.boolean(),
      }),
      { maxLength: 1 },
    ),
    nowAfter: fc.constantFrom(-2, 0, 0, 3, 5, 5, 19, 20, 21, 40),
    window: fc.constantFrom(30, 60, 90, 180, 180, 180, 180, 235, 240),
  })
  .map(({ start, scale, steps, holes, falls, nowAfter, window }): Trace => {
    const rows: [number, number, number][] = [];
    let t = start;
    let cpu = 0;
    let read = 0;
    steps.forEach((step, i) => {
      t += holes.find((hole) => hole.at === i)?.gap ?? step.gap;
      cpu += step.cpu * scale;
      read += step.read * scale * 4096;
      rows.push([t, cpu, read]);
    });
    for (const fall of falls) {
      const first = Math.min(fall.at, rows.length - 1);
      for (let i = first; i < (fall.stays ? rows.length : first + 1); i++) {
        const [at, c, r] = rows[i];
        rows[i] =
          fall.which === "cpu"
            ? [at, Math.max(0, c - fall.drop), r]
            : [at, c, Math.max(0, r - fall.drop)];
      }
    }
    return { rows, now: t + nowAfter, window };
  });

/** The same rule as ActivityRing.verdict, written as a list of conditions over the readings instead of a walk through
 *  them, and summing the steps between readings instead of subtracting the ends. `rows` is all that was ever pushed. */
function reference(
  rows: readonly Row[],
  now: number,
  window: number,
  capacity = ACTIVITY_RING_CAPACITY,
): ActivityVerdict {
  const held = rows.slice(-capacity);
  const start = now - window;
  const before = held.filter(([t]) => t <= start);
  const inside = held.filter(([t]) => t > start);
  if (held.length === 0 || window <= 0) return "unknown";
  if (held.some(([t]) => t > now)) return "unknown";
  if (before.length === 0 || inside.length === 0) return "unknown";
  const knots = [start, ...inside.map(([t]) => t), now];
  if (knots.some((t, i) => i > 0 && t - knots[i - 1] > ACTIVITY_STALE_SECONDS)) return "unknown";
  const newestBefore = before[before.length - 1][0];
  const walk = held.slice(held.indexOf(before.filter(([t]) => t === newestBefore)[0]));
  const steps = walk
    .slice(1)
    .map((row, i) => ({ cpu: row[1] - walk[i][1], read: row[2] - walk[i][2] }));
  if (steps.some((step) => step.cpu < 0 || step.read < 0)) return "unknown";
  const cpu = steps.reduce((sum, step) => sum + step.cpu, 0);
  const read = steps.reduce((sum, step) => sum + step.read, 0);
  return cpu < IDLE_CPU_MS_PER_SECOND * window && read < IDLE_READ_BYTES ? "idle" : "busy";
}

describe("ActivityRing properties", () => {
  it("reaches idle, busy and unknown on the generated traces, and unknown for a falling counter alone, so the properties below are not vacuous", () => {
    const seen: Record<ActivityVerdict, number> = { idle: 0, busy: 0, unknown: 0 };
    let fallAlone = 0;
    for (const { rows, now, window } of fc.sample(traceArb, { numRuns: 600, seed: 1114 })) {
      const verdict = ringOf(rows).verdict(now, window);
      seen[verdict]++;
      // the same readings with every counter held at the highest it has been: no fall left in them
      let cpu = 0;
      let read = 0;
      const repaired = rows.map(([t, c, r]): Row => [
        t,
        (cpu = Math.max(cpu, c)),
        (read = Math.max(read, r)),
      ]);
      if (verdict === "unknown" && ringOf(repaired).verdict(now, window) !== "unknown") fallAlone++;
    }
    for (const verdict of ["idle", "busy", "unknown"] as const)
      expect(seen[verdict], `${verdict}: ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(40);
    expect(fallAlone, "unknown for a falling counter alone").toBeGreaterThanOrEqual(10);
  });

  it("says idle only when the process REALLY used less than the thresholds over the window (property)", () => {
    // The generated process is known second by second, so the use over the window is computed from its own history,
    // not from the ring's readings; the readings can only overstate it.
    const processArb = fc.record({
      spans: fc.array(
        fc.record({
          seconds: fc.integer({ min: 1, max: 150 }),
          cpuPerS: fc.constantFrom(0, 0, 0, 4, 8, 20, 40, 400, 4000),
          readPerS: fc.constantFrom(0, 0, 0, 0, 4, 1024, 4096, 1_048_576),
        }),
        { minLength: 1, maxLength: 6 },
      ),
      gaps: fc.array(fc.constantFrom(4, 4.25, 5, 5, 5, 5, 5.25, 6), {
        minLength: 40,
        maxLength: 90,
        size: "max",
      }),
      nowAfter: fc.constantFrom(0, 0, 1.5, 5, 10, 20),
      window: fc.constantFrom(30, 60, 90, 180, 180, 180, 235),
    });
    let idle = 0;
    fc.assert(
      fc.property(processArb, ({ spans, gaps, nowAfter, window }) => {
        let t = 0;
        const rows: Row[] = gaps.map((gap) => {
          t += gap;
          return [t, usedBy(spans, t, "cpuPerS"), usedBy(spans, t, "readPerS")];
        });
        const now = t + nowAfter;
        if (ringOf(rows).verdict(now, window) !== "idle") return;
        idle++;
        const cpu = usedBy(spans, t, "cpuPerS") - usedBy(spans, now - window, "cpuPerS");
        const read = usedBy(spans, t, "readPerS") - usedBy(spans, now - window, "readPerS");
        expect(cpu).toBeLessThan(IDLE_CPU_MS_PER_SECOND * window);
        expect(read).toBeLessThan(IDLE_READ_BYTES);
      }),
      { numRuns: 600 },
    );
    expect(idle, "the generated processes were never idle").toBeGreaterThan(20);
  });

  it("gives the verdict a second reading of the rule gives, on every trace (property)", () => {
    fc.assert(
      fc.property(traceArb, ({ rows, now, window }) => {
        expect(ringOf(rows).verdict(now, window)).toBe(reference(rows, now, window));
      }),
      { numRuns: 800 },
    );
  });

  it("reaches idle for a quiet process on any cadence between 4 and 6 s, once its readings cover the window (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            gap: fc.constantFrom(4, 4.25, 4.5, 5, 5.5, 5.75, 6),
            cpu: fc.constantFrom(0, 0, 1),
            read: fc.constantFrom(0, 0, 1000),
          }),
          { minLength: 48, maxLength: 70, size: "max" },
        ),
        fc.integer({ min: -1_000, max: 1_000 }),
        fc.constantFrom(0, 1, 2.5, 5),
        (steps, start, after) => {
          let t = start;
          let cpu = 0;
          let read = 0;
          const rows: Row[] = steps.map((step) => {
            t += step.gap;
            cpu += step.cpu;
            read += step.read;
            return [t, cpu, read];
          });
          expect(ringOf(rows).verdict(t + after)).toBe("idle");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("never turns busy into idle by adding use to the newest reading, and never turns idle into unknown (property)", () => {
    fc.assert(
      fc.property(
        traceArb,
        fc.constantFrom(0, 1, 100, 3600, 1e6),
        fc.constantFrom(0, 1, 1000, MIB, 1e9),
        ({ rows, now, window }, moreCpu, moreRead) => {
          const newest = rows[rows.length - 1];
          const more: Row[] = [
            ...rows.slice(0, -1),
            [newest[0], newest[1] + moreCpu, newest[2] + moreRead],
          ];
          const before = ringOf(rows).verdict(now, window);
          const after = ringOf(more).verdict(now, window);
          if (before === "busy") expect(after).toBe("busy");
          if (before === "idle") expect(after).not.toBe("unknown");
        },
      ),
      { numRuns: 800 },
    );
  });

  it("gives the same verdict when every time is moved by the same amount (property)", () => {
    fc.assert(
      fc.property(
        traceArb,
        fc.integer({ min: -100_000, max: 100_000 }),
        ({ rows, now, window }, shift) => {
          const moved = rows.map(([t, cpu, read]): Row => [t + shift, cpu, read]);
          expect(ringOf(moved).verdict(now + shift, window)).toBe(
            ringOf(rows).verdict(now, window),
          );
        },
      ),
      { numRuns: 800 },
    );
  });

  it("is unknown whenever the window is not covered or a hole is longer than the stale limit (property)", () => {
    fc.assert(
      fc.property(traceArb, ({ rows, now, window }) => {
        const held = rows.slice(-ACTIVITY_RING_CAPACITY);
        const start = now - window;
        const knots = [start, ...held.map(([t]) => t).filter((t) => t > start && t <= now), now];
        const notCovered = held[0][0] > start;
        const hole = knots.some((t, i) => i > 0 && t - knots[i - 1] > ACTIVITY_STALE_SECONDS);
        if (notCovered || hole) expect(ringOf(rows).verdict(now, window)).toBe("unknown");
      }),
      { numRuns: 800 },
    );
  });

  it("is not changed by readings that are not usable arriving between the usable ones (property)", () => {
    const badTime = fc.constantFrom(NaN, Infinity, -Infinity);
    const badCounter = fc.constantFrom(
      NaN,
      Infinity,
      -Infinity,
      -1,
      -1e9,
      ACTIVITY_COUNTER_MAX + 2,
      1e300,
    );
    const garbage: fc.Arbitrary<readonly [number, number, number]> = fc.oneof(
      fc.tuple(badTime, fc.nat(), fc.nat()),
      fc.tuple(fc.integer({ min: 0, max: 500 }), badCounter, fc.nat()),
      fc.tuple(fc.integer({ min: 0, max: 500 }), fc.nat(), badCounter),
    );
    fc.assert(
      fc.property(
        traceArb,
        fc.array(fc.tuple(fc.nat(79), garbage), { maxLength: 20 }),
        ({ rows, now, window }, bad) => {
          const dirty = new ActivityRing();
          rows.forEach(([t, cpuMs, readBytes], i) => {
            for (const [, [bt, bc, br]] of bad.filter(([at]) => at === i))
              dirty.push(bt, { cpuMs: bc, readBytes: br });
            dirty.push(t, { cpuMs, readBytes });
          });
          const clean = ringOf(rows);
          expect(dirty.size).toBe(clean.size);
          expect(dirty.verdict(now, window)).toBe(clean.verdict(now, window));
        },
      ),
      { numRuns: 400 },
    );
  });

  it("never throws on readings and questions that are numbers of any kind, and one reading is never enough (property)", () => {
    const anything = fc.double();
    fc.assert(
      fc.property(
        fc.array(fc.tuple(anything, anything, anything), { maxLength: 30 }),
        anything,
        anything,
        fc.integer({ min: -3, max: 100 }),
        (readings, now, window, capacity) => {
          const ring = new ActivityRing(capacity);
          for (const [t, cpuMs, readBytes] of readings) ring.push(t, { cpuMs, readBytes });
          expect(["idle", "busy", "unknown"]).toContain(ring.verdict(now, window));
          expect(ring.size).toBeLessThanOrEqual(Math.max(1, capacity));
          if (ring.size < 2) expect(ring.verdict(now, window)).toBe("unknown");
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("the activity mark", () => {
  const counter = fc.oneof(
    fc.integer({ min: 0, max: 100_000 }),
    fc.maxSafeNat(),
    fc.constantFrom(0, 1, ACTIVITY_COUNTER_MAX - 1, ACTIVITY_COUNTER_MAX),
  );
  const markArb: fc.Arbitrary<ActivityMark> = fc.record({ cpuMs: counter, readBytes: counter });

  it("is one line: the prefix, the processor ms, a comma, the bytes read, a newline", () => {
    expect(formatActivityMark({ cpuMs: 1234, readBytes: 5678 })).toBe(
      `${ACTIVITY_MARK_PREFIX}1234,5678\n`,
    );
    expect(ACTIVITY_MARK_PREFIX).toBe("artdaddy_cpu=");
  });

  it("brings a number that cannot be a counter to the nearest that can", () => {
    expect(formatActivityMark({ cpuMs: -5, readBytes: 2.9 })).toBe("artdaddy_cpu=0,2\n");
    expect(formatActivityMark({ cpuMs: NaN, readBytes: Infinity })).toBe("artdaddy_cpu=0,0\n");
    expect(formatActivityMark({ cpuMs: 1e300, readBytes: 0 })).toBe(
      `artdaddy_cpu=${ACTIVITY_COUNTER_MAX},0\n`,
    );
  });

  it("reads back what it wrote, and several marks in a chunk in the order they came (property)", () => {
    fc.assert(
      fc.property(fc.array(markArb, { maxLength: 8 }), (marks) => {
        expect(parseActivityMarks(marks.map(formatActivityMark).join(""))).toEqual(marks);
      }),
      { numRuns: 300 },
    );
  });

  it("reads marks and nothing else out of text around them, and takes out the marks and nothing else (property)", () => {
    // Text of the letters of the prefix and the characters a number, a line or a progress block is made of: whatever it
    // is, it is never a mark by itself, and a mark glued into the middle of it is still one.
    const noise = fc.string({
      unit: fc.constantFrom(..."artdycpu0123456789=,.-: \r\n"),
      maxLength: 30,
    });
    const piece = fc.oneof(
      noise.map((text) => ({ text }) as const),
      markArb.map((mark) => ({ mark }) as const),
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 12 }), (pieces) => {
        const text = pieces
          .map((p) => ("text" in p ? p.text : formatActivityMark(p.mark)))
          .join("");
        const kept = pieces.map((p) => ("text" in p ? p.text : "")).join("");
        const marks = pieces.flatMap((p) => ("mark" in p ? [p.mark] : []));
        expect(stripActivityMarks(text)).toBe(kept);
        expect(parseActivityMarks(text)).toEqual(marks);
      }),
      { numRuns: 500 },
    );
  });

  it("leaves text that holds no mark exactly as it is (property)", () => {
    fc.assert(
      fc.property(
        fc
          .string({ unit: "binary", maxLength: 200 })
          .filter((s) => !s.includes(ACTIVITY_MARK_PREFIX)),
        (text) => {
          expect(stripActivityMarks(text)).toBe(text);
          expect(parseActivityMarks(text)).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("skips what is not a well-formed mark without throwing, and leaves a line that is not shaped like one alone", () => {
    const notMarks = [
      "artdaddy_cpu=-1,2\n",
      "artdaddy_cpu=1.5,2\n",
      "artdaddy_cpu=1;2\n",
      "artdaddy_cpu=,2\n",
      "artdaddy_cpu=1,\n",
      "artdaddy_cpu=1,2",
      "artdaddy_cpu=1,2,3\n",
      "artdaddy_cpu=NaN,2\n",
      "artdaddy_cpu=1e9,2\n",
      "ARTDADDY_CPU=1,2\n",
      " artdaddy_cpu =1,2\n",
      `artdaddy_cpu=${"9".repeat(21)},2\n`,
    ];
    for (const line of notMarks) {
      expect(parseActivityMarks(line), JSON.stringify(line)).toEqual([]);
      expect(stripActivityMarks(line), JSON.stringify(line)).toBe(line);
    }
  });

  it("skips a counter above 2^53 but takes 2^53, and still takes the line out of the text", () => {
    const limit = String(ACTIVITY_COUNTER_MAX);
    expect(parseActivityMarks(`artdaddy_cpu=${limit},1\n`)).toEqual([
      { cpuMs: ACTIVITY_COUNTER_MAX, readBytes: 1 },
    ]);
    for (const absurd of ["9007199254740993", "9007199254740994", "99999999999999999999"]) {
      const line = `artdaddy_cpu=1,${absurd}\n`;
      expect(parseActivityMarks(line), absurd).toEqual([]);
      expect(stripActivityMarks(`out_time_us=40${line}00000\n`), absurd).toBe(
        "out_time_us=4000000\n",
      );
    }
  });

  it("reads leading zeros and a CRLF line end, which a Windows pipe may add", () => {
    expect(parseActivityMarks("artdaddy_cpu=007,000\r\nartdaddy_cpu=0,0\n")).toEqual([
      { cpuMs: 7, readBytes: 0 },
      { cpuMs: 0, readBytes: 0 },
    ]);
    expect(stripActivityMarks("a\nartdaddy_cpu=1,2\r\nb\n")).toBe("a\nb\n");
  });

  it("never throws on text of any kind, and everything it reads is a counter (property)", () => {
    const soup = fc
      .array(
        fc.constantFrom(
          ACTIVITY_MARK_PREFIX,
          "artdaddy_",
          "1",
          "0",
          "9007199254740992",
          "9007199254740993",
          "99999999999999999999",
          "123456789012345678901",
          ",",
          "\n",
          "\r",
          "-",
          " ",
          "x",
          ".",
        ),
        { maxLength: 30 },
      )
      .map((parts) => parts.join(""));
    fc.assert(
      fc.property(fc.oneof(soup, fc.string({ unit: "binary", maxLength: 300 })), (text) => {
        const marks = parseActivityMarks(text);
        for (const mark of marks)
          for (const value of [mark.cpuMs, mark.readBytes])
            expect(Number.isInteger(value) && value >= 0 && value <= ACTIVITY_COUNTER_MAX).toBe(
              true,
            );
        const stripped = stripActivityMarks(text);
        expect(stripped.length).toBeLessThanOrEqual(text.length);
        if (marks.length > 0) expect(stripped.length).toBeLessThan(text.length);
      }),
      { numRuns: 1_000 },
    );
  });

  it("takes time in proportion to the text, whatever the text is", () => {
    // Each of these is a megabyte built to make a pattern with nested or open-ended repeats back up over and over, or,
    // the last, to make taking out one mark put a new one together out of the pieces beside it, k times over (a
    // reader that took marks out until none were left would need k passes over the text).
    const mb = 1_000_000;
    const k = 50_000;
    const hostile = [
      ACTIVITY_MARK_PREFIX.repeat(mb / 13),
      ACTIVITY_MARK_PREFIX + "1".repeat(mb),
      `${ACTIVITY_MARK_PREFIX}1,${"1".repeat(mb)}`,
      `${ACTIVITY_MARK_PREFIX}${"1".repeat(mb / 2)},${"1".repeat(mb / 2)}`,
      `${ACTIVITY_MARK_PREFIX}1,1`.repeat(mb / 16),
      `${ACTIVITY_MARK_PREFIX}1,1\r`.repeat(mb / 17),
      `${"1,".repeat(1_000)}${ACTIVITY_MARK_PREFIX}`.repeat(mb / 2_013),
      "\r".repeat(mb),
      `${ACTIVITY_MARK_PREFIX}1,1${"\r".repeat(mb)}`,
      "artdaddy_cpu=1,1\n".repeat(mb / 17),
      `${"a".repeat(k)}artdaddy_cpu=1,2\n${"rtdaddy_cpu=1,2\n".repeat(k)}`,
    ];
    const started = performance.now();
    for (const text of hostile) {
      parseActivityMarks(text);
      stripActivityMarks(text);
    }
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("quietVerdict", () => {
  it("reads the feed's busy flag as busy, idle or unknown, and never guesses a missing one", () => {
    const live = { stage: "rendering" as const, lastMoveAt: 0 };
    expect(quietVerdict({ ...live, busy: true }, 0).verdict).toBe("busy");
    expect(quietVerdict({ ...live, busy: false }, 0).verdict).toBe("idle");
    expect(quietVerdict({ ...live, busy: null }, 0).verdict).toBe("unknown");
    expect(quietVerdict(live, 0).verdict).toBe("unknown");
  });

  it("counts the quiet only while preparing or rendering", () => {
    for (const stage of STAGES) {
      const counted = stage === "preparing" || stage === "rendering";
      const { quiet_for_s } = quietVerdict({ stage, lastMoveAt: 1_000, busy: true }, 91_000);
      expect(quiet_for_s, stage).toBe(counted ? 90 : 0);
    }
  });

  it("is the card's own count of quiet seconds for any stage and any clock (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STAGES),
        fc.double(),
        fc.double(),
        (stage, lastMoveAt, now) => {
          const live: LiveFacts = {
            stage,
            startedAt: 0,
            fraction: null,
            etaSec: null,
            step: null,
            steps: null,
            lastMoveAt,
          };
          expect(quietVerdict(live, now).quiet_for_s).toBe(quietSeconds(live, now));
        },
      ),
      { numRuns: 500 },
    );
  });
});
