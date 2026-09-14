import { describe, expect, it } from "vitest";

import { AutosaveController } from "./AutosaveController";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("AutosaveController", () => {
  it("runs a scheduled save and flush resolves once it settles", async () => {
    let saves = 0;
    const a = new AutosaveController();
    a.schedule(async () => void saves++);
    expect(a.isSaving()).toBe(true);
    await a.flush();
    expect(saves).toBe(1);
    expect(a.isSaving()).toBe(false);
  });

  it("flush is a no-op when idle", async () => {
    const a = new AutosaveController();
    await expect(a.flush()).resolves.toBeUndefined();
    expect(a.isSaving()).toBe(false);
  });

  it("coalesces a BURST of schedules during one save into a single follow-up", async () => {
    let started = 0;
    const gates: Array<ReturnType<typeof deferred>> = [];
    const save = () => {
      started++;
      const d = deferred();
      gates.push(d);
      return d.promise;
    };
    const a = new AutosaveController();

    a.schedule(save); // starts save #1
    await flushMicrotasks();
    expect(started).toBe(1);

    // Three edits land WHILE save #1 is in flight — they collapse into ONE follow-up.
    a.schedule(save);
    a.schedule(save);
    a.schedule(save);
    expect(started).toBe(1); // still only #1 running

    gates[0].resolve(); // #1 completes -> ONE coalesced follow-up runs
    await flushMicrotasks();
    expect(started).toBe(2);

    gates[1].resolve(); // #2 completes, nothing queued -> drain idle
    await a.flush();
    expect(started).toBe(2);
    expect(a.isSaving()).toBe(false);
  });

  it("flush awaits the in-flight save AND its coalesced follow-up", async () => {
    const order: string[] = [];
    const d1 = deferred();
    const d2 = deferred();
    const gates = [d1, d2];
    let i = 0;
    const a = new AutosaveController();
    a.schedule(async () => {
      order.push("s1-start");
      await gates[i++].promise;
      order.push("s1-end");
    });
    a.schedule(async () => {
      order.push("s2-start");
      await gates[i++].promise;
      order.push("s2-end");
    });
    const flushed = a.flush().then(() => order.push("flushed"));
    await flushMicrotasks();
    d1.resolve();
    await flushMicrotasks();
    d2.resolve();
    await flushed;
    expect(order).toEqual(["s1-start", "s1-end", "s2-start", "s2-end", "flushed"]);
  });

  it("swallows a throwing save — the drain survives and later saves still run", async () => {
    let ran = 0;
    const a = new AutosaveController();
    a.schedule(async () => {
      ran++;
      throw new Error("disk full");
    });
    await expect(a.flush()).resolves.toBeUndefined(); // flush never rejects
    expect(ran).toBe(1);
    a.schedule(async () => void ran++); // controller is still usable after a failure
    await a.flush();
    expect(ran).toBe(2);
  });
});
