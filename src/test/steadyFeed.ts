// A render that makes the same share every second, played to the app's progress feed on a fake clock: what a test uses when it needs the live time-left rule
// (timeline/exportTimeLeft.ts) to have something to say. The rule says nothing until at least 20 s have been rendered and either 15 % is made or 60 s have
// passed, and reads the pace of the last 20 s, so one report is never enough: a test that wants "about 2 min left" plays a render long enough, and the
// figure it expects follows from the pace (a render of `total` seconds that is `t` seconds in has `total - t` seconds left).
import { vi } from "vitest";

export interface SteadyFeed {
  /** The length of the whole render in seconds: it is `t / total` made after `t` seconds. */
  total: number;
  /** The first and the last report, in seconds after `origin`. A report arrives every second, `from` included. */
  from: number;
  to: number;
  /** The fake clock's time (ms) at second 0. */
  origin: number;
}

/** One report: the share made and the frame count that goes with it (both change every second, so the render has moved). */
export interface SteadyReport {
  fraction: number;
  frame: number;
  /** Seconds after `origin`. */
  at: number;
}

/** The reports of a steady render, in order. */
export function steadyReports(feed: Pick<SteadyFeed, "total" | "from" | "to">): SteadyReport[] {
  const out: SteadyReport[] = [];
  for (let t = feed.from; t <= feed.to; t++)
    out.push({ at: t, fraction: Math.min(1, t / feed.total), frame: t * 30 });
  return out;
}

/** Plays a steady render: sets the fake clock to each report's second and hands the report over, so the report's own `Date.now()` is the second it is for.
 *  The clock is left at the last report. `Date` must be faked (`vi.useFakeTimers({ toFake: ["Date", ...] })`). */
export function playSteady(report: (r: SteadyReport) => void, feed: SteadyFeed): void {
  for (const r of steadyReports(feed)) {
    vi.setSystemTime(feed.origin + r.at * 1000);
    report(r);
  }
}
