import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { __testing, WAKING_AFTER_S, wakingLine } from "./waking";

const T0 = 1_700_000_000_000;

// UJ-082: the rules a launch screen's "Waking the server" line must keep, whatever the clock and the facts.
describe("the waking line on the launch screens", () => {
  it("is never shown when the screen is not waiting on the server, however long the app has been up", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7 * 24 * 3600 }), (upS) => {
        expect(
          wakingLine({ now: T0 + upS * 1000, launchedAtMs: T0, waitingOnServer: false }),
        ).toBeNull();
      }),
    );
  });

  it("is never shown before 3 s of waiting, and always from 3 s on, with the clock the person's own", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7 * 24 * 3600 * 1000 }), (upMs) => {
        const line = wakingLine({ now: T0 + upMs, launchedAtMs: T0, waitingOnServer: true });
        if (upMs < WAKING_AFTER_S * 1000) expect(line).toBeNull();
        else expect(line?.elapsedS).toBe(Math.floor(upMs / 1000));
      }),
    );
  });

  it("only ever counts up as time passes (the clock is not allowed to jump back on a screen change)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3_000, max: 3_600_000 }),
        fc.integer({ min: 0, max: 3_600_000 }),
        (upMs, laterMs) => {
          const first = wakingLine({ now: T0 + upMs, launchedAtMs: T0, waitingOnServer: true });
          const next = wakingLine({
            now: T0 + upMs + laterMs,
            launchedAtMs: T0,
            waitingOnServer: true,
          });
          expect(next!.elapsedS).toBeGreaterThanOrEqual(first!.elapsedS);
        },
      ),
    );
  });

  it("survives a clock that is not a number, and a clock behind the launch (no line, no throw)", () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, T0 - 10_000]) {
      expect(() => wakingLine({ now, launchedAtMs: T0, waitingOnServer: true })).not.toThrow();
      expect(wakingLine({ now, launchedAtMs: T0, waitingOnServer: true })).toBeNull();
    }
  });

  it("uses the app's own launch time unless a test says otherwise", () => {
    __testing.setLaunchedAt(T0);
    expect(wakingLine({ now: T0 + 10_000, waitingOnServer: true })?.elapsedS).toBe(10);
  });
});
