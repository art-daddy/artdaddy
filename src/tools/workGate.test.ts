import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetWorkGate,
  adoptTurn,
  backgroundTurn,
  backgroundWorkActive,
  lookWhisper,
  setExportsBusy,
  subscribeBackgroundWork,
  type BackgroundKind,
} from "./workGate";

afterEach(() => __resetWorkGate());

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Ask for a background turn and watch it: `got()` is the release once granted, else undefined. */
function ask(kind: BackgroundKind, signal?: AbortSignal) {
  let release: (() => void) | null | undefined;
  let settled = false;
  void backgroundTurn(kind, signal).then((r) => {
    release = r;
    settled = true;
  });
  return { got: () => release, settled: () => settled };
}

/** A look's whisper that runs until released; `started()` says whether it began. */
function look(signal?: AbortSignal) {
  let started = false;
  let finish!: () => void;
  const result = lookWhisper(async () => {
    started = true;
    await new Promise<void>((r) => (finish = r));
    return "words";
  }, signal);
  return { result, started: () => started, finish: () => finish() };
}

describe("the work gate (4i)", () => {
  // After a crash of the page, a job the dead page started is still at work in the app process: the
  // page that takes it over counts it, whatever else holds a turn, and the next of its kind waits.
  it("counts a job already at work at once, and the next of its kind waits for it", async () => {
    setExportsBusy(true); // nothing new may start...
    const adopted = adoptTurn("whisper"); // ...but a job already running is counted all the same
    setExportsBusy(false);
    const next = ask("whisper");
    const other = ask("loudness");
    await tick();
    expect([next.settled(), !!other.got()]).toEqual([false, true]);
    adopted();
    await tick();
    expect(!!next.got()).toBe(true);
  });

  it("forgets at a reset every turn and look taken before it (tests start clean)", async () => {
    const old = ask("whisper");
    await tick();
    const oldLook = look();
    await tick();
    __resetWorkGate();
    const held = ask("whisper");
    await tick();
    expect(!!held.got()).toBe(true);
    old.got()!(); // a release from before the reset frees nothing now
    oldLook.finish();
    await oldLook.result; // ...nor does the end of a look from before it
    const next = ask("whisper");
    const loud = ask("loudness");
    await tick();
    expect([next.settled(), !!loud.got()]).toEqual([false, true]);
  });
  it("starts no background job while an export is queued or running, and starts it once none is", async () => {
    setExportsBusy(true);
    const w = ask("whisper");
    const l = ask("loudness");
    await tick();
    expect([w.settled(), l.settled()]).toEqual([false, false]);
    setExportsBusy(false);
    await tick();
    expect(typeof w.got()).toBe("function");
    expect(typeof l.got()).toBe("function");
  });

  it("never stops a job already running when an export starts, and the next waits for both", async () => {
    const first = ask("whisper");
    await tick();
    const release = first.got()!;
    setExportsBusy(true);
    const next = ask("whisper");
    await tick();
    release(); // the running job ends on its own
    await tick();
    expect(next.settled()).toBe(false); // the export still holds the next one back
    setExportsBusy(false);
    await tick();
    expect(typeof next.got()).toBe("function");
  });

  it("runs one background whisper and one measurement at a time, the two side by side", async () => {
    const w1 = ask("whisper");
    const l1 = ask("loudness");
    const w2 = ask("whisper");
    const l2 = ask("loudness");
    await tick();
    expect([!!w1.got(), !!l1.got(), w2.settled(), l2.settled()]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    w1.got()!();
    await tick();
    expect([!!w2.got(), l2.settled()]).toEqual([true, false]);
    l1.got()!();
    await tick();
    expect(!!l2.got()).toBe(true);
  });

  it("releases a turn once, however often the release is called", async () => {
    const w1 = ask("whisper");
    await tick();
    const release = w1.got()!;
    const w2 = ask("whisper");
    await tick();
    release();
    await tick();
    const w3 = ask("whisper");
    release(); // again: must not free the turn w2 now holds
    await tick();
    expect([!!w2.got(), w3.settled()]).toEqual([true, false]);
  });

  it("runs a look's whisper at once while background work runs, and starts no background job until the look is over", async () => {
    const bg = ask("whisper");
    await tick();
    expect(!!bg.got()).toBe(true);
    const a = look();
    await tick();
    expect(a.started()).toBe(true); // a look never waits for the background
    bg.got()!();
    const next = ask("whisper");
    const measure = ask("loudness");
    await tick();
    expect([next.settled(), measure.settled()]).toEqual([false, false]);
    a.finish();
    expect(await a.result).toBe("words");
    await tick();
    expect([!!next.got(), !!measure.got()]).toEqual([true, true]);
  });

  it("runs looks' whispers one at a time, in the order asked", async () => {
    const a = look();
    const b = look();
    await tick();
    expect([a.started(), b.started()]).toEqual([true, false]);
    a.finish();
    await a.result;
    await tick();
    expect(b.started()).toBe(true);
    b.finish();
    expect(await b.result).toBe("words");
  });

  it("answers a look stopped while it waits at once, never runs it, and still holds the next look for the running one", async () => {
    const a = look();
    const stop = new AbortController();
    const b = look(stop.signal);
    const c = look();
    await tick();
    stop.abort();
    expect(await b.result).toBeNull();
    await tick();
    expect([a.started(), b.started(), c.started()]).toEqual([true, false, false]);
    a.finish();
    await a.result;
    await tick();
    expect(c.started()).toBe(true);
    c.finish();
    await c.result;
  });

  it("does not run a look already stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    const a = look(stop.signal);
    expect(await a.result).toBeNull();
    expect(a.started()).toBe(false);
  });

  it("lets a look that failed hand the turn to the next", async () => {
    const failed = lookWhisper(async () => {
      throw new Error("whisper-cli failed");
    });
    const b = look();
    await expect(failed).rejects.toThrow(/failed/);
    await tick();
    expect(b.started()).toBe(true);
    b.finish();
    await b.result;
  });

  it("drops a background job whose project closed while it waited, without taking the turn", async () => {
    setExportsBusy(true);
    const close = new AbortController();
    const dropped = ask("whisper", close.signal);
    close.abort();
    await tick();
    expect([dropped.settled(), dropped.got()]).toEqual([true, null]);
    setExportsBusy(false);
    const other = ask("whisper");
    await tick();
    expect(!!other.got()).toBe(true);
  });

  it("property: no background job starts while an export or a look is under way, never two of a kind; looks run one at a time, in order; and everything asked for runs", async () => {
    const op = fc.oneof(
      fc.record({ op: fc.constant("export" as const), on: fc.boolean() }),
      fc.record({
        op: fc.constant("ask" as const),
        kind: fc.constantFrom<BackgroundKind>("whisper", "loudness"),
      }),
      fc.record({ op: fc.constant("release" as const), pick: fc.nat() }),
      fc.record({ op: fc.constant("look" as const) }),
      fc.record({ op: fc.constant("finish" as const), pick: fc.nat() }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 40 }), async (ops) => {
        __resetWorkGate();
        let exporting = false;
        let looksActive = 0; // asked for and not yet finished running
        let looksRunning = 0;
        const held: Record<BackgroundKind, number> = { whisper: 0, loudness: 0 };
        const releases: Array<() => void> = [];
        const finishers: Array<() => void> = [];
        const lookStarts: number[] = [];
        const violations: string[] = [];
        let asked = 0;
        let granted = 0;
        let looksAsked = 0;
        const settle = async (): Promise<void> => {
          // The gate runs on promises alone, so draining the microtasks settles every hand-over.
          for (let i = 0; i < 30; i++) await Promise.resolve();
        };
        for (const o of ops) {
          if (o.op === "export") {
            exporting = o.on;
            setExportsBusy(o.on);
          } else if (o.op === "ask") {
            asked++;
            const kind = o.kind;
            void backgroundTurn(kind).then((release) => {
              if (!release) return;
              granted++;
              if (exporting) violations.push(`${kind} started during an export`);
              if (looksActive > 0) violations.push(`${kind} started during a look`);
              if (held[kind] > 0) violations.push(`two ${kind} at once`);
              held[kind]++;
              releases.push(() => {
                held[kind]--;
                release();
              });
            });
          } else if (o.op === "release" && releases.length) {
            releases.splice(o.pick % releases.length, 1)[0]();
          } else if (o.op === "look") {
            const n = looksAsked++;
            looksActive++;
            void lookWhisper(async () => {
              looksRunning++;
              if (looksRunning > 1) violations.push("two looks at once");
              lookStarts.push(n);
              await new Promise<void>((r) => finishers.push(r));
              looksRunning--;
              looksActive--;
            });
          } else if (o.op === "finish" && finishers.length) {
            finishers.splice(o.pick % finishers.length, 1)[0]();
          }
          await settle();
        }
        // Once nothing holds it back, everything asked for gets its turn.
        exporting = false;
        setExportsBusy(false);
        await settle();
        for (
          let i = 0;
          i < 400 && (finishers.length || releases.length || looksActive || granted < asked);
          i++
        ) {
          finishers.splice(0).forEach((f) => f());
          await settle();
          releases.splice(0).forEach((r) => r());
          await settle();
        }
        expect(violations).toEqual([]);
        expect([granted, lookStarts.length]).toEqual([asked, looksAsked]);
        expect(lookStarts).toEqual([...lookStarts].sort((a, b) => a - b));
      }),
      { numRuns: 150 },
    );
  }, 60_000);
});

// The PC check must never run beside a look's whisper or a background job, so it needs to read, and hear of, the gate's state.
describe("the background work the gate can be asked about", () => {
  it("is quiet until something takes a turn, and quiet again when it is given back, for each kind of work", async () => {
    expect(backgroundWorkActive()).toBe(false);
    for (const kind of ["whisper", "loudness"] as const) {
      const turn = ask(kind);
      await tick();
      expect(backgroundWorkActive(), kind).toBe(true);
      turn.got()!();
      expect(backgroundWorkActive(), kind).toBe(false);
    }
    const adopted = adoptTurn("whisper");
    expect(backgroundWorkActive()).toBe(true);
    adopted();
    expect(backgroundWorkActive()).toBe(false);
  });

  it("counts a look from the moment it is asked for, whether it runs or waits behind another, until it is over", async () => {
    const a = look();
    const b = look();
    await tick();
    expect([a.started(), b.started()]).toEqual([true, false]);
    expect(backgroundWorkActive()).toBe(true);
    a.finish();
    await a.result;
    await tick();
    expect(backgroundWorkActive()).toBe(true); // the one that waited now runs
    b.finish();
    await b.result;
    await tick();
    expect(backgroundWorkActive()).toBe(false);
  });

  it("does not count a look that was stopped while it waited, nor one that failed", async () => {
    const stop = new AbortController();
    const a = look();
    const b = look(stop.signal);
    await tick();
    stop.abort();
    expect(await b.result).toBeNull();
    a.finish();
    await a.result;
    await tick();
    expect(backgroundWorkActive()).toBe(false);
    await expect(
      lookWhisper(async () => {
        throw new Error("whisper-cli failed");
      }),
    ).rejects.toThrow(/failed/);
    expect(backgroundWorkActive()).toBe(false);
  });

  it("does not count a queued export: it holds work back and is not itself the work", () => {
    setExportsBusy(true);
    expect(backgroundWorkActive()).toBe(false);
  });

  it("tells a listener each time the answer can have changed, until it stops listening, and survives a listener that throws", async () => {
    const heard: boolean[] = [];
    const stop = subscribeBackgroundWork(() => heard.push(backgroundWorkActive()));
    const stopFailing = subscribeBackgroundWork(() => {
      throw new Error("a listener that fails");
    });
    const turn = ask("whisper");
    await tick();
    turn.got()!();
    const a = look();
    await tick();
    a.finish();
    await a.result;
    expect(heard).toEqual([true, false, true, false]);
    stop();
    const later = ask("loudness");
    await tick();
    later.got()!();
    expect(heard).toHaveLength(4);
    stopFailing();
  });

  it("forgets, at a reset, the work that was under way, and tells a listener so", async () => {
    const turn = ask("whisper");
    await tick();
    const heard: boolean[] = [];
    const stop = subscribeBackgroundWork(() => heard.push(backgroundWorkActive()));
    __resetWorkGate();
    expect(backgroundWorkActive()).toBe(false);
    expect(heard).toContain(false);
    turn.got()!(); // a release from before the reset changes nothing
    expect(backgroundWorkActive()).toBe(false);
    stop();
  });

  it("is true exactly while a look runs or waits or a job holds a turn (property)", async () => {
    const op = fc.oneof(
      fc.record({
        op: fc.constant("ask" as const),
        kind: fc.constantFrom<BackgroundKind>("whisper", "loudness"),
      }),
      fc.record({ op: fc.constant("release" as const), pick: fc.nat() }),
      fc.record({ op: fc.constant("look" as const) }),
      fc.record({ op: fc.constant("finish" as const), pick: fc.nat() }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
        __resetWorkGate();
        const releases: Array<() => void> = [];
        const finishers: Array<() => void> = [];
        let looksOpen = 0;
        let jobsHeld = 0;
        let asked = 0;
        let granted = 0;
        const settle = async (): Promise<void> => {
          for (let i = 0; i < 30; i++) await Promise.resolve();
        };
        for (const o of ops) {
          if (o.op === "ask") {
            asked++;
            void backgroundTurn(o.kind).then((release) => {
              if (!release) return;
              granted++;
              jobsHeld++;
              releases.push(() => {
                jobsHeld--;
                release();
              });
            });
          } else if (o.op === "look") {
            looksOpen++;
            const gate = new Promise<void>((resolve) => finishers.push(resolve));
            void lookWhisper(() => gate).then(() => looksOpen--);
          } else if (o.op === "release" && releases.length) {
            releases.splice(o.pick % releases.length, 1)[0]();
          } else if (o.op === "finish" && finishers.length) {
            finishers.splice(o.pick % finishers.length, 1)[0]();
          }
          await settle();
          expect(backgroundWorkActive()).toBe(looksOpen > 0 || jobsHeld > 0);
        }
        // Everything asked for runs and ends, so no waiter outlives this run to take a turn in the next one's gate.
        for (
          let i = 0;
          i < 400 && (finishers.length || releases.length || looksOpen > 0 || granted < asked);
          i++
        ) {
          finishers.splice(0).forEach((f) => f());
          await settle();
          releases.splice(0).forEach((r) => r());
          await settle();
          expect(backgroundWorkActive()).toBe(looksOpen > 0 || jobsHeld > 0);
        }
        expect(backgroundWorkActive()).toBe(false);
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});
