import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { HonestEstimate, RouteEstimatesRequest } from "./exportTypes3c";
import {
  __resetRouteEstimatesProvider,
  routeEstimatesNow,
  setRouteEstimatesProvider,
} from "./routeEstimatesPort";

const request = {
  workload: {} as RouteEstimatesRequest["workload"],
  settings: { resolution: undefined, quality: undefined, fps: undefined },
  explicit: { size: false, fps: false },
  chipMaker: null,
} satisfies RouteEstimatesRequest;

const good = (seconds: number): HonestEstimate => ({
  seconds,
  low: Math.max(1, Math.floor(seconds / 2)),
  high: seconds * 2,
  basis: "pc_check",
  bytes: null,
  muchLonger: false,
  family: "processor",
});
const NONE = { standard: null, quick: null, chip: null, faster: null };

afterEach(() => __resetRouteEstimatesProvider());

describe("the route estimates port", () => {
  it("gives no estimate for any way until a provider has registered, and never holds anything up", () => {
    expect(routeEstimatesNow(request)).toEqual(NONE);
  });

  it("passes a sane estimate through unchanged, per way", () => {
    setRouteEstimatesProvider(() => ({ standard: good(600), quick: good(240), chip: null }));
    expect(routeEstimatesNow(request)).toEqual({
      standard: good(600),
      quick: good(240),
      chip: null,
      faster: null,
    });
  });

  it("a throwing provider is no estimate, and a later good one works again", () => {
    setRouteEstimatesProvider(() => {
      throw new Error("boom");
    });
    expect(routeEstimatesNow(request)).toEqual(NONE);
    setRouteEstimatesProvider(() => ({ standard: good(90) }));
    expect(routeEstimatesNow(request).standard).toEqual(good(90));
  });

  it("judges each way on its own: one garbled estimate does not take the others", () => {
    setRouteEstimatesProvider(() => ({
      standard: good(600),
      quick: { ...good(100), low: 500 },
      chip: { ...good(100), basis: "oracle" },
      faster: { ...good(100), seconds: Number.NaN },
    }));
    expect(routeEstimatesNow(request)).toEqual({
      standard: good(600),
      quick: null,
      chip: null,
      faster: null,
    });
  });

  it("never throws and never returns a time that is not a whole number of seconds, whatever the provider says", () => {
    fc.assert(
      fc.property(fc.anything(), (answer) => {
        setRouteEstimatesProvider(() => answer as never);
        const out = routeEstimatesNow(request);
        for (const e of Object.values(out)) {
          if (e === null) continue;
          expect(Number.isFinite(e.seconds) && e.seconds >= 1).toBe(true);
          expect(e.low <= e.seconds && e.seconds <= e.high).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
