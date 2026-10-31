// A gate that lets one task through at a time, in arrival order, and lets a waiting task give up.
//
// Used for the app's big uploads: the server holds only one big request body at a time (a body costs about 7-8 times its
// size in memory and the container is small), so the app sends them one at a time too instead of firing four and having
// three turned away. What matters is that the gate can never wedge: a failing task, a task that throws at once, and a
// waiter that is told to stop all leave it usable for the next one.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { SerialGate } from "./serialGate";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SerialGate", () => {
  it("runs tasks one at a time, in the order they arrived", async () => {
    const gate = new SerialGate();
    const log: string[] = [];
    const holds = [deferred(), deferred(), deferred()];
    const runs = holds.map((hold, i) =>
      gate.run(async () => {
        log.push(`start ${i}`);
        await hold.promise;
        log.push(`end ${i}`);
        return i;
      }),
    );
    await tick();
    expect(log).toEqual(["start 0"]);
    holds[0].resolve();
    await tick();
    expect(log).toEqual(["start 0", "end 0", "start 1"]);
    holds[1].resolve();
    holds[2].resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(log).toEqual(["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]);
  });

  it("hands back what the task returned, and throws what the task threw", async () => {
    const gate = new SerialGate();
    expect(await gate.run(async () => 42)).toBe(42);
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  it("is not wedged by a task that fails, or one that throws before it awaits anything", async () => {
    const gate = new SerialGate();
    await expect(gate.run(() => Promise.reject(new Error("a")))).rejects.toThrow("a");
    await expect(
      gate.run(() => {
        throw new Error("b");
      }),
    ).rejects.toThrow("b");
    expect(await gate.run(async () => "still works")).toBe("still works");
  });

  it("lets a waiting task give up when told to stop, without running it and without blocking the next", async () => {
    const gate = new SerialGate();
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const stop = new AbortController();
    let ran = false;
    const second = gate.run(async () => {
      ran = true;
    }, stop.signal);
    const third = gate.run(async () => "third");
    const secondOutcome = second.catch((e: unknown) => e);
    await tick();
    stop.abort();
    expect(await secondOutcome).toMatchObject({ name: "AbortError" });
    hold.resolve();
    await first;
    expect(await third).toBe("third");
    expect(ran).toBe(false);
  });

  it("does not start a task whose signal is already stopped", async () => {
    const gate = new SerialGate();
    const stop = new AbortController();
    stop.abort();
    let ran = false;
    await expect(gate.run(async () => void (ran = true), stop.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(ran).toBe(false);
    expect(await gate.run(async () => "next")).toBe("next");
  });

  it("a task that is already running is not interrupted by its own signal (the task owns that)", async () => {
    const gate = new SerialGate();
    const stop = new AbortController();
    const result = await gate.run(async () => {
      stop.abort();
      return "finished";
    }, stop.signal);
    expect(result).toBe("finished");
  });

  it("a task that arrives at the very moment another one finishes still queues behind the one that was waiting", async () => {
    // The gate must stay closed through the hand-over: the waiter is let through a microtask later, and a task arriving in
    // between must not slip past it and run beside it.
    const gate = new SerialGate();
    const holdA = deferred();
    const holdB = deferred();
    let running = 0;
    let peak = 0;
    const track = async (hold?: { promise: Promise<void> }) => {
      running += 1;
      peak = Math.max(peak, running);
      await hold?.promise;
      running -= 1;
    };
    const a = gate.run(() => track(holdA));
    const b = gate.run(() => track(holdB));
    const c = a.then(() => gate.run(() => track()));
    await tick();
    holdA.resolve();
    await tick();
    expect(running).toBe(1); // B only: C is waiting for it
    holdB.resolve();
    await Promise.all([b, c]);
    expect(peak).toBe(1);
  });

  it("never runs two tasks at once and always finishes them all, whatever fails or stops", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            fail: fc.boolean(),
            stopEarly: fc.boolean(),
            steps: fc.integer({ min: 0, max: 3 }),
          }),
          { maxLength: 12 },
        ),
        async (specs) => {
          const gate = new SerialGate();
          let running = 0;
          let peak = 0;
          let completed = 0;
          const began = specs.map(() => false);
          const outcomes = specs.map((spec, index) => {
            const stop = new AbortController();
            const promise = gate.run(async () => {
              began[index] = true;
              running += 1;
              peak = Math.max(peak, running);
              for (let i = 0; i < spec.steps; i += 1) await Promise.resolve();
              running -= 1;
              completed += 1;
              if (spec.fail) throw new Error("fail");
            }, stop.signal);
            if (spec.stopEarly) stop.abort();
            return promise.then(
              () => "done",
              (e: Error) => e.name,
            );
          });
          const settled = await Promise.all(outcomes);
          expect(peak).toBeLessThanOrEqual(1);
          expect(running).toBe(0);
          expect(settled).toHaveLength(specs.length);
          expect(completed).toBe(settled.filter((s) => s !== "AbortError").length);
          // A task told to stop before it could begin never began, however close to its turn it was.
          specs.forEach((spec, index) => {
            if (spec.stopEarly) {
              expect(began[index]).toBe(false);
              expect(settled[index]).toBe("AbortError");
            }
          });
          expect(await gate.run(async () => "usable")).toBe("usable");
        },
      ),
      { numRuns: 200 },
    );
  });
});
