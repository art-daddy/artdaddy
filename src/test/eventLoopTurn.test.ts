import { describe, expect, it } from "vitest";

// vitest's runner takes no turn of the event loop between tests that do not wait: a file of them is ONE turn however long it runs, and a worker call that waits for the runner's reply (onTaskUpdate)
// gives up after 60 s of it. Under the pre-push run's full parallel load a file of synchronous tests that takes 22 s alone ended the real run with "Timeout calling onTaskUpdate" although every test
// passed (16 Nov). src/test/setup.ts therefore takes one real turn of the loop after every test; this file fails when it stops doing so.
describe("the event loop turns between tests", () => {
  let scheduled = false;
  let ran = false;

  it("a test schedules work for the next turn of the loop and does not wait for it", () => {
    scheduled = true;
    setImmediate(() => {
      ran = true;
    });
    expect(ran).toBe(false);
  });

  it("the next test finds that work done", () => {
    // when the first test was filtered out there is nothing to find
    if (!scheduled) return;
    expect(ran).toBe(true);
  });
});
