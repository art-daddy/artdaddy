// The registry of imports in flight (UJ-088): what the agent is told is still coming in. The rules, each one a way the agent could be misled:
//  - the rows exist the instant a batch starts (a message sent 43 ms after the drop was told "library: []"),
//  - a file's row is gone when ITS import settles (a file that is already in the library is never "still coming in"),
//  - nothing outlives its batch, however the batch ends, and nothing outlives 30 minutes,
//  - one batch can never remove another batch's rows, and one project never sees another's.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IMPORT_ROW_MAX_MS,
  importingRows,
  resetImportBatches,
  useImportJobs,
  withImportBatch,
  withImportJob,
} from "./importJobs";

const DIR = "C:/Users/me/AppData/projects/p1";
const OTHER = "C:/Users/me/AppData/projects/p2";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
}
const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined); // a rejection nobody awaited yet is not an unhandled one
  return { promise, resolve, reject };
};
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const names = (dir: string, now?: number) => importingRows(dir, now).map((r) => r.name);

beforeEach(() => {
  resetImportBatches();
  useImportJobs.setState({ jobs: [] });
});
afterEach(() => {
  resetImportBatches();
  useImportJobs.setState({ jobs: [] });
});

describe("withImportBatch", () => {
  it("knows the whole batch the instant it starts, before the door's first await", () => {
    const hold = deferred();
    const batch = withImportBatch(
      DIR,
      ["D:/shoot/a.mp4", "D:/shoot/b.mp4", "D:/shoot/c.mp4"],
      () => hold.promise,
    );
    expect(names(DIR)).toEqual(["a.mp4", "b.mp4", "c.mp4"]); // nothing has been awaited yet
    hold.resolve();
    return batch;
  });

  it("takes a file's row out when ITS import settles, so a file already in the library is not still coming in", async () => {
    const files = [deferred(), deferred(), deferred()];
    const paths = ["D:/a.mp4", "D:/b.mp4", "D:/c.mp4"];
    const finish = deferred();
    const batch = withImportBatch(DIR, paths, async (file) => {
      await Promise.all(
        paths.map((p, i) => file(p, () => files[i].promise).catch(() => undefined)),
      );
      await finish.promise;
    });
    files[1].resolve();
    await tick();
    expect(names(DIR)).toEqual(["a.mp4", "c.mp4"]);
    files[0].reject(new Error("unreadable")); // a failed import is not coming in either
    await tick();
    expect(names(DIR)).toEqual(["c.mp4"]);
    finish.resolve();
    files[2].resolve();
    await batch;
    expect(names(DIR)).toEqual([]);
  });

  it("clears every row when the batch ends, however it ends: a door that throws leaves no note behind", async () => {
    const never = deferred();
    const crashed = withImportBatch(DIR, ["D:/a.mp4", "D:/b.mp4"], async (file) => {
      void file("D:/a.mp4", () => never.promise);
      throw new Error("the door crashed");
    });
    await expect(crashed).rejects.toThrow("the door crashed");
    expect(names(DIR)).toEqual([]);
    expect(await withImportBatch(DIR, ["D:/a.mp4"], async () => "value")).toBe("value");
    expect(names(DIR)).toEqual([]);
  });

  it("returns the door's own value, and with nothing to register it only runs the door", async () => {
    expect(await withImportBatch(DIR, [], async (file) => file("x", async () => 7))).toBe(7);
    expect(
      await withImportBatch(null, ["D:/a.mp4"], async (file) => file("x", async () => 8)),
    ).toBe(8);
    expect(await withImportBatch(undefined, ["D:/a.mp4"], async () => 9)).toBe(9);
    expect(names(DIR)).toEqual([]);
  });

  it("never lets one batch remove another's rows, and a late settle of a finished batch is harmless", async () => {
    const holdA = deferred();
    const holdB = deferred();
    const fileA = deferred();
    let lateA: (() => Promise<void>) | null = null;
    const a = withImportBatch(DIR, ["D:/same.mp4", "D:/a.mp4"], async (file) => {
      lateA = () => file("D:/same.mp4", () => fileA.promise);
      await holdA.promise;
    });
    const b = withImportBatch(DIR, ["D:/same.mp4", "D:/b.mp4"], async () => holdB.promise);
    expect(names(DIR)).toEqual(["same.mp4", "a.mp4", "b.mp4"]); // one entry per path
    holdA.resolve();
    await a;
    expect(names(DIR)).toEqual(["same.mp4", "b.mp4"]); // B still imports the same path
    void lateA!(); // A's door settles a file after A has ended
    fileA.resolve();
    await tick();
    expect(names(DIR)).toEqual(["same.mp4", "b.mp4"]); // B's row is untouched
    holdB.resolve();
    await b;
    expect(names(DIR)).toEqual([]);
  });

  it("a path given twice in one batch is settled twice, one row each", async () => {
    const one = deferred();
    const two = deferred();
    const finish = deferred();
    const batch = withImportBatch(DIR, ["D:/x.mp4", "D:/x.mp4"], async (file) => {
      void file("D:/x.mp4", () => one.promise);
      void file("D:/x.mp4", () => two.promise);
      await finish.promise;
    });
    one.resolve();
    await tick();
    expect(names(DIR)).toEqual(["x.mp4"]); // the second copy is still in flight
    two.resolve();
    await tick();
    expect(names(DIR)).toEqual([]);
    finish.resolve();
    await batch;
  });

  it("keeps each project's imports to itself, whatever the spelling of its folder", () => {
    const hold = deferred();
    const batch = withImportBatch(
      "C:\\Users\\me\\AppData\\projects\\P1\\",
      ["D:/a.mp4"],
      () => hold.promise,
    );
    expect(names(DIR)).toEqual(["a.mp4"]);
    expect(names(OTHER)).toEqual([]);
    expect(names("")).toEqual([]);
    hold.resolve();
    return batch;
  });

  it("stops showing a row after 30 minutes: an import that hangs cannot leave a note up for good", async () => {
    const hold = deferred();
    const t0 = 1_000_000;
    const batch = withImportBatch(DIR, ["D:/hang.mp4"], () => hold.promise, t0);
    expect(names(DIR, t0 + IMPORT_ROW_MAX_MS)).toEqual(["hang.mp4"]);
    expect(names(DIR, t0 + IMPORT_ROW_MAX_MS + 1)).toEqual([]);
    // The next batch also drops it from memory, so a leak cannot grow.
    const next = withImportBatch(
      DIR,
      ["D:/new.mp4"],
      async () => undefined,
      t0 + IMPORT_ROW_MAX_MS + 5,
    );
    await next;
    expect(names(DIR, t0 + 1)).toEqual([]);
    hold.resolve();
    await batch;
  });

  it("carries the percent of the file the progress list is reading, and none before the first report", async () => {
    const hold = deferred();
    const batch = withImportBatch(DIR, ["D:/shoot/big.mp4"], async (file) => {
      await file("D:/shoot/big.mp4", () => withImportJob("D:/shoot/big.mp4", () => hold.promise));
    });
    expect(importingRows(DIR)[0].fraction).toBeNull();
    useImportJobs.getState().progress("D:\\shoot\\big.mp4", 25, 100); // the probe reports with the OS spelling
    expect(importingRows(DIR)[0].fraction).toBe(0.25);
    hold.resolve();
    await batch;
    expect(importingRows(DIR)).toEqual([]);
  });
});

// The same rules over any interleaving: a model of the registry, run against the real one, after every step.
describe("the registry over random interleavings", () => {
  const op = fc.oneof(
    fc.record({
      t: fc.constant("begin" as const),
      dir: fc.constantFrom(0 as const, 1 as const),
      paths: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 4 }),
    }),
    fc.record({
      t: fc.constant("settle" as const),
      batch: fc.nat(5),
      file: fc.nat(3),
      fail: fc.boolean(),
    }),
    fc.record({ t: fc.constant("end" as const), batch: fc.nat(5), fail: fc.boolean() }),
    fc.record({ t: fc.constant("tick" as const), ms: fc.integer({ min: 0, max: 40 * 60_000 }) }),
  );

  it("shows exactly the files whose import and batch are still going, newest 30 minutes only, and leaks nothing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
        resetImportBatches();
        const dirs = [DIR, OTHER];
        interface Live {
          dir: string;
          paths: string[];
          jobs: Deferred[];
          jobSettled: boolean[];
          done: Deferred;
          ended: boolean;
          addedAt: number;
          promise: Promise<unknown>;
        }
        const live: Live[] = [];
        let now = 5_000_000;
        // The model: a file is shown while some import of it in a batch of this project is unsettled, its batch has not ended, and it is under 30 minutes old.
        const expected = (dir: string): string[] => {
          const out = new Set<string>();
          for (const b of live) {
            if (b.dir !== dir || b.ended || now - b.addedAt > IMPORT_ROW_MAX_MS) continue;
            b.paths.forEach((p, i) => {
              if (!b.jobSettled[i]) out.add(p);
            });
          }
          return [...out].sort();
        };
        const check = () => {
          for (const dir of dirs)
            expect(
              importingRows(dir, now)
                .map((r) => r.name)
                .sort(),
            ).toEqual(expected(dir));
        };
        for (const o of ops) {
          if (o.t === "begin") {
            const paths = o.paths.map((n) => `f${n}.mp4`);
            const b: Live = {
              dir: dirs[o.dir],
              paths,
              jobs: paths.map(() => deferred()),
              jobSettled: paths.map(() => false),
              done: deferred(),
              ended: false,
              addedAt: now,
              promise: Promise.resolve(),
            };
            b.promise = withImportBatch(
              b.dir,
              paths.map((p) => `D:/shoot/${p}`),
              async (file) => {
                paths.forEach((p, i) => {
                  void file(`D:/shoot/${p}`, () => b.jobs[i].promise).catch(() => undefined);
                });
                await b.done.promise;
              },
              now,
            ).catch(() => undefined);
            live.push(b);
          } else if (o.t === "settle" && live.length) {
            const b = live[o.batch % live.length];
            const i = o.file % b.paths.length;
            b.jobSettled[i] = true;
            if (o.fail) b.jobs[i].reject(new Error("x"));
            else b.jobs[i].resolve();
          } else if (o.t === "end" && live.length) {
            const b = live[o.batch % live.length];
            b.ended = true;
            if (o.fail) b.done.reject(new Error("door crashed"));
            else b.done.resolve();
          } else if (o.t === "tick") {
            now += o.ms;
          }
          await tick();
          check();
        }
        // Everything ends: nothing may be left behind, in either project, ever.
        for (const b of live) {
          b.ended = true;
          b.done.resolve();
        }
        await Promise.all(live.map((b) => b.promise));
        await tick();
        check();
        expect(importingRows(DIR, now)).toEqual([]);
        expect(importingRows(OTHER, now)).toEqual([]);
      }),
      { numRuns: 120 },
    );
  });
});
