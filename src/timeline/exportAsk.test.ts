// "An export is being asked": the signal the PC check stops for. The rules: it is on from the start of a request to its end, however many requests overlap, it can be ended twice without harm, and a pending
// check-first question does not count (otherwise the question could never start the check it offers).
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetExportAsk,
  beginExportAsk,
  exportAskedNow,
  holdExportAsk,
  subscribeExportAsk,
  suspendExportAsk,
} from "./exportAsk";

afterEach(() => {
  vi.useRealTimers();
  __resetExportAsk();
});

describe("an export is being asked", () => {
  it("is on from the start of a request to its end, and for as long as any request is", () => {
    expect(exportAskedNow()).toBe(false);
    const first = beginExportAsk();
    expect(exportAskedNow()).toBe(true);
    const second = beginExportAsk();
    first();
    expect(exportAskedNow()).toBe(true);
    second();
    expect(exportAskedNow()).toBe(false);
  });

  it("ending a request twice ends it once: another request's ask is not ended by it", () => {
    const first = beginExportAsk();
    const second = beginExportAsk();
    first();
    first();
    expect(exportAskedNow()).toBe(true);
    second();
    expect(exportAskedNow()).toBe(false);
  });

  it("a pending check-first question does not count as an export being asked, and the request counts again once it is answered", () => {
    const asked = beginExportAsk();
    const question = suspendExportAsk();
    expect(exportAskedNow()).toBe(false);
    question();
    expect(exportAskedNow()).toBe(true);
    asked();
    expect(exportAskedNow()).toBe(false);
  });

  it("a suspension is over when the last request ends: one that is never released cannot make a later request not count", () => {
    const first = beginExportAsk();
    suspendExportAsk();
    expect(exportAskedNow()).toBe(false);
    first();
    const later = beginExportAsk();
    expect(exportAskedNow()).toBe(true);
    later();
  });

  it("a suspension outside any request asks nothing, and never makes a later request not count", () => {
    const question = suspendExportAsk();
    expect(exportAskedNow()).toBe(false);
    const asked = beginExportAsk();
    expect(exportAskedNow()).toBe(true);
    question();
    expect(exportAskedNow()).toBe(true);
    asked();
  });

  it("the click holds the check off for a while, until the request takes over or the time is up", () => {
    vi.useFakeTimers();
    const release = holdExportAsk(1000);
    expect(exportAskedNow()).toBe(true);
    const request = beginExportAsk();
    vi.advanceTimersByTime(1000);
    // the hold ran out but the request itself is still being asked
    expect(exportAskedNow()).toBe(true);
    request();
    expect(exportAskedNow()).toBe(false);
    release();
    expect(exportAskedNow()).toBe(false);
    const again = holdExportAsk(5000);
    again();
    expect(exportAskedNow()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(exportAskedNow()).toBe(false);
  });

  it("tells whoever listens when it changes, and a listener that throws is not heard from again by the others", () => {
    const heard: boolean[] = [];
    subscribeExportAsk(() => {
      throw new Error("a listener broke");
    });
    subscribeExportAsk(() => heard.push(exportAskedNow()));
    const asked = beginExportAsk();
    asked();
    expect(heard).toEqual([true, false]);
  });

  it("is on exactly when a request is open that no pending question has set aside, over any order of begins, ends and suspensions (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("begin", "end", "suspend", "resume"), { maxLength: 40 }),
        (steps) => {
          __resetExportAsk();
          // a plain model: requests open, questions set aside (each belongs to the requests that were open when it was made)
          const open: (() => void)[] = [];
          let epoch = 0;
          const held: { release: () => void; epoch: number }[] = [];
          let aside = 0;
          for (const step of steps) {
            if (step === "begin") open.push(beginExportAsk());
            else if (step === "end") {
              const ended = open.shift();
              ended?.();
              if (ended && open.length === 0) {
                epoch++;
                aside = 0;
              }
            } else if (step === "suspend") {
              const release = suspendExportAsk();
              if (open.length > 0) {
                held.push({ release, epoch });
                aside++;
              }
            } else {
              const next = held.shift();
              next?.release();
              if (next && next.epoch === epoch) aside--;
            }
            expect(exportAskedNow()).toBe(open.length - aside > 0);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
