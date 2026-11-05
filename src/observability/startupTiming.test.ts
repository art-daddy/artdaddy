import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_STARTUP_MS,
  __resetStartupTiming,
  beginStartupTiming,
  startupTimings,
} from "./startupTiming";

// The three readings that say where a slow start went: the process starting until the page is there (boot), the page
// loading its code (load), and the session being settled (auth). Their sum is the wait the person sat through.
beforeEach(() => __resetStartupTiming());

/** A page clock the test moves by hand, and a native process that answers with an age. */
function rig(age: number | null | "throws") {
  const clock = { now: 0 };
  return {
    clock,
    options: {
      now: () => clock.now,
      processAge: async () => {
        clock.now += 5; // the answer takes a moment to come back
        if (age === "throws") throw new Error("the command is not there");
        return age;
      },
    },
  };
}

describe("the start-up readings", () => {
  it("splits the wait into the process starting, the page loading and the session settling", async () => {
    const { clock, options } = rig(3_000);
    clock.now = 400; // the page's code starts to run 400 ms after the page began
    beginStartupTiming(options.now);
    clock.now = 2_400; // 2 s later the session has settled and the launch is reported
    // The process was 3 000 ms old when it answered; the page was 2 405 ms old then.
    expect(await startupTimings(options)).toEqual({ boot_ms: 595, load_ms: 400, auth_ms: 2_000 });
  });

  it("has no reading before the app's own code has begun to run", async () => {
    expect(await startupTimings(rig(1_000).options)).toBeNull();
  });

  it("has no reading where nobody can vouch for the process's age (not the desktop app, no answer, an error)", async () => {
    for (const age of [null, "throws"] as const) {
      const { clock, options } = rig(age);
      beginStartupTiming(options.now);
      clock.now = 1_000;
      expect(await startupTimings(options), String(age)).toBeNull();
    }
  });

  it("does not take a nonsense age for a reading", async () => {
    for (const age of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_VALUE * 2]) {
      __resetStartupTiming();
      const { clock, options } = rig(age);
      beginStartupTiming(options.now);
      clock.now = 1_000;
      expect(await startupTimings(options), String(age)).toBeNull();
    }
  });

  it("starts counting once: a second call does not move the start", async () => {
    const { clock, options } = rig(5_000);
    clock.now = 300;
    beginStartupTiming(options.now);
    clock.now = 900;
    beginStartupTiming(options.now);
    clock.now = 1_300;
    expect(await startupTimings(options)).toMatchObject({ load_ms: 300, auth_ms: 1_000 });
  });

  it("never reports a negative wait, whatever the clocks said (the page cannot start before its process)", async () => {
    const { clock, options } = rig(100); // the process says it is younger than the page
    clock.now = 400;
    beginStartupTiming(options.now);
    clock.now = 2_400;
    expect(await startupTimings(options)).toMatchObject({ boot_ms: 0 });
  });

  it("holds every reading inside what the server accepts, as a whole number", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0, max: 1e12, noNaN: true }),
        fc.double({ min: 0, max: 1e12, noNaN: true }),
        fc.double({ min: 0, max: 1e13, noNaN: true }),
        async (loadAt, authAt, age) => {
          __resetStartupTiming();
          const { clock, options } = rig(age);
          clock.now = loadAt;
          beginStartupTiming(options.now);
          clock.now = loadAt + authAt;
          const readings = await startupTimings(options);
          expect(readings).not.toBeNull();
          for (const value of Object.values(readings!)) {
            expect(Number.isInteger(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(MAX_STARTUP_MS);
          }
        },
      ),
    );
  });

  it("is exactly what happened for every wait inside the bound: nothing legitimate is rounded away", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 600_000 }),
        fc.integer({ min: 0, max: 600_000 }),
        fc.integer({ min: 0, max: 600_000 }),
        async (load, auth, boot) => {
          __resetStartupTiming();
          const clock = { now: load };
          const options = {
            now: () => clock.now,
            // answers at the instant it is asked, so the age the page sees is exact
            processAge: async () => boot + load + auth,
          };
          beginStartupTiming(options.now);
          clock.now = load + auth;
          expect(await startupTimings(options)).toEqual({
            boot_ms: boot,
            load_ms: load,
            auth_ms: auth,
          });
        },
      ),
    );
  });
});
