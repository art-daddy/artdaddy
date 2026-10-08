// The app cache's rules, asserted by what a reader gets back and what is left on the disk: the
// value stored under a key, never another key's; a bounded total, least recently used out; and
// a record of use that survives a restart and a crash.
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { AppCache, appCacheFor } from "./appCache";
import type { DirEntry, FsLike } from "./store";

const ROOT = "C:/cache/app";

/** A disk with folders, sizes and write times, as the cache sees one. */
class Disk implements FsLike {
  files = new Map<string, string>();
  written = new Map<string, number>();
  now = 1_000_000;
  failWrites = false;
  async exists(p: string): Promise<boolean> {
    return this.files.has(p);
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    if (this.failWrites) throw new Error("ENOSPC");
    this.files.set(p, c);
    this.written.set(p, this.now);
  }
  async mkdir(): Promise<void> {}
  async stat(p: string): Promise<{ isDirectory: boolean; size: number; mtimeMs?: number }> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return {
      isDirectory: false,
      size: new TextEncoder().encode(v).length,
      mtimeMs: this.written.get(p),
    };
  }
  async readDir(p: string): Promise<DirEntry[]> {
    const prefix = `${p}/`;
    const names = new Map<string, boolean>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0);
    }
    if (names.size === 0) throw new Error(`ENOENT ${p}`); // like a real one: no folder, no list
    return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`ENOENT ${from}`);
    this.files.set(to, v);
    this.written.set(to, this.written.get(from) ?? this.now);
    this.files.delete(from);
    this.written.delete(from);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
    this.written.delete(p);
  }
  entries(): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(`${ROOT}/ns/`));
  }
}

/** A cache whose clock the test moves, a tick per call. */
function cacheOn(disk: Disk, budget = 10_000): { cache: AppCache; tick: () => void } {
  let t = 0;
  const cache = new AppCache(disk, ROOT, budget, () => t);
  return { cache, tick: () => (t += 1) };
}

/** An entry's size on disk for a value of `n` characters under a one-letter key. */
const SIZE = (n: number) => JSON.stringify({ key: "a", value: "x".repeat(n) }).length;
/** Bytes the cache's entries take on the disk: the outcome the budget is about. */
const onDisk = (disk: Disk): number =>
  disk.entries().reduce((n, p) => n + new TextEncoder().encode(disk.files.get(p)!).length, 0);

describe("the app cache", () => {
  it("answers a key with what was stored under it, across instances", async () => {
    const disk = new Disk();
    const early = cacheOn(disk).cache;
    await early.size(); // started before the entry existed
    expect(await cacheOn(disk).cache.put("ns", "k", { words: ["hi"] })).toBe(true);
    expect(await cacheOn(disk).cache.get("ns", "k")).toEqual({ words: ["hi"] });
    expect(await early.get("ns", "k")).toEqual({ words: ["hi"] });
    expect(await cacheOn(disk).cache.get("ns", "other")).toBeNull();
    expect(await cacheOn(disk).cache.get("other-ns", "k")).toBeNull();
  });

  // The file name is a hash of the key. Whatever lands in a key's file under ANOTHER key (a
  // collision, or a format that moved) must read as a miss, never as this key's value.
  it("never answers a key with an entry stored under another", async () => {
    const disk = new Disk();
    const { cache } = cacheOn(disk);
    await cache.put("ns", "k", 1);
    const [file] = disk.entries();
    disk.files.set(file, JSON.stringify({ key: "not-k", value: 2 }));
    expect(await cache.get("ns", "k")).toBeNull();
    disk.files.set(file, JSON.stringify({ key: "k" })); // the key, and no value
    expect(await cache.get("ns", "k")).toBeNull();
  });

  // Transcription must never fail because its cache did: a cache that cannot answer is a miss.
  it("answers a miss, and keeps nothing, on a disk that fails every way", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("EIO");
    };
    const broken: FsLike = {
      exists: fail,
      readTextFile: fail,
      writeTextFile: fail,
      mkdir: fail,
      readDir: fail,
      stat: fail,
    };
    const cache = new AppCache(broken, ROOT, 1000, () => 0);
    expect(await cache.get("ns", "k")).toBeNull();
    expect(await cache.put("ns", "k", 1)).toBe(false);
    expect(await cache.size()).toBe(0);
  });

  // A file removed behind the cache's back (the user clearing the folder) must stop counting, or
  // the next write evicts what is really there to make room for what is not.
  it("stops counting an entry that went away behind its back", async () => {
    const disk = new Disk();
    const { cache, tick } = cacheOn(disk, Math.floor(SIZE(100) * 2.5));
    for (const k of ["b", "a"]) {
      tick();
      await cache.put("ns", k, "x".repeat(100));
    }
    const fileOfA = disk.entries()[1];
    disk.files.delete(fileOfA);
    expect(await cache.get("ns", "a")).toBeNull();
    tick();
    await cache.put("ns", "c", "x".repeat(100));
    expect(await cache.get("ns", "b")).not.toBeNull();
  });

  it("counts an entry written again once", async () => {
    const disk = new Disk();
    const { cache, tick } = cacheOn(disk, Math.floor(SIZE(100) * 2.5));
    for (const k of ["a", "a", "b"]) {
      tick();
      await cache.put("ns", k, "x".repeat(100));
    }
    expect(await cache.get("ns", "a")).not.toBeNull();
    expect(await cache.size()).toBe(2 * SIZE(100));
  });

  // Eviction stops at 90% of the budget; an entry that fits the budget but not the mark is kept.
  it("keeps the entry just written when it fits the budget, even past the mark", async () => {
    const disk = new Disk();
    const { cache, tick } = cacheOn(disk, 1000);
    tick();
    await cache.put("ns", "a", "x".repeat(50));
    tick();
    await cache.put("ns", "big", "x".repeat(930)); // about 950 bytes on disk: over 900, under 1000
    expect(await cache.get("ns", "big")).not.toBeNull();
    expect(await cache.get("ns", "a")).toBeNull();
  });

  // The record of use is written by a timer a moment after use, on the app's own clock.
  it("writes down what was used when, a moment after it was used", async () => {
    vi.useFakeTimers();
    try {
      const disk = new Disk();
      const budget = Math.floor(SIZE(100) * 2.5);
      vi.setSystemTime(1_000);
      const first = new AppCache(disk, ROOT, budget);
      await first.put("ns", "a", "x".repeat(100));
      vi.setSystemTime(2_000);
      await first.put("ns", "b", "x".repeat(100));
      vi.setSystemTime(3_000);
      await first.get("ns", "a");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(disk.files.has(`${ROOT}/index.json`)).toBe(true);
      first.dispose();

      vi.setSystemTime(4_000);
      const after = new AppCache(disk, ROOT, budget);
      await after.put("ns", "c", "x".repeat(100));
      expect(await after.get("ns", "b")).toBeNull();
      expect(await after.get("ns", "a")).not.toBeNull();
      after.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an entry it cannot read, and answers a miss", async () => {
    const disk = new Disk();
    const { cache } = cacheOn(disk);
    await cache.put("ns", "k", 1);
    const [file] = disk.entries();
    disk.files.set(file, "{ half a wr");
    expect(await cache.get("ns", "k")).toBeNull();
    expect(disk.entries()).toEqual([]);
  });

  it("reports a write it could not make, and keeps nothing half-written", async () => {
    const disk = new Disk();
    disk.failWrites = true;
    const { cache } = cacheOn(disk);
    expect(await cache.put("ns", "k", 1)).toBe(false);
    expect(await cache.get("ns", "k")).toBeNull();
    expect(disk.files.size).toBe(0);
  });

  it("keeps itself under its budget, least recently used out", async () => {
    const disk = new Disk();
    const { cache, tick } = cacheOn(disk, SIZE(100) * 3);
    for (const k of ["a", "b", "c"]) {
      tick();
      await cache.put("ns", k, "x".repeat(100));
    }
    tick();
    expect(await cache.get("ns", "a")).not.toBeNull(); // a is now the most recently used
    tick();
    await cache.put("ns", "d", "x".repeat(100));
    expect(onDisk(disk)).toBeLessThanOrEqual(SIZE(100) * 3);
    expect(await cache.get("ns", "b")).toBeNull(); // the least recently used went first
    expect(await cache.get("ns", "a")).not.toBeNull();
    expect(await cache.get("ns", "d")).not.toBeNull();
  });

  // The record of use is written a moment after the use. An entry written just before a crash is
  // on the disk but not in the record: it must still count, and still be evictable.
  it("counts what is on the disk after a restart, recorded or not", async () => {
    const disk = new Disk();
    const first = cacheOn(disk, SIZE(100) * 3);
    first.tick();
    await first.cache.put("ns", "a", "x".repeat(100));
    await first.cache.flush();
    first.tick();
    await first.cache.put("ns", "b", "x".repeat(100)); // never recorded: the app stopped here
    first.cache.dispose();

    const after = cacheOn(disk, SIZE(100) * 3);
    expect(await after.cache.size()).toBe(2 * SIZE(100));
    after.tick();
    await after.cache.put("ns", "c", "x".repeat(100));
    after.tick();
    await after.cache.put("ns", "d", "x".repeat(100));
    expect(onDisk(disk)).toBeLessThanOrEqual(SIZE(100) * 3);
  });

  // The record of use is what decides what goes first after a restart, not when files were written.
  it("remembers what was used when, across a restart", async () => {
    const disk = new Disk();
    const budget = Math.floor(SIZE(100) * 2.5); // two fit; a third makes exactly one go
    const first = cacheOn(disk, budget);
    for (const k of ["a", "b"]) {
      first.tick();
      await first.cache.put("ns", k, "x".repeat(100));
    }
    first.tick();
    await first.cache.get("ns", "a"); // a used after b was written
    await first.cache.flush();
    first.cache.dispose();

    const after = new AppCache(disk, ROOT, budget, () => 100);
    await after.put("ns", "c", "x".repeat(100));
    expect(await after.get("ns", "b")).toBeNull();
    expect(await after.get("ns", "a")).not.toBeNull();
  });

  it("does not believe a record of use with nonsense in it", async () => {
    const disk = new Disk();
    const { cache } = cacheOn(disk, SIZE(100) * 2);
    await cache.put("ns", "a", "x".repeat(100));
    const [file] = disk.entries();
    const rel = file.slice(ROOT.length + 1);
    disk.files.set(
      `${ROOT}/index.json`,
      JSON.stringify({ version: 1, entries: { [rel]: { bytes: "lots", used: 5 } } }),
    );
    const after = cacheOn(disk, SIZE(100) * 2);
    for (const k of ["b", "c", "d"]) {
      after.tick();
      await after.cache.put("ns", k, "x".repeat(100));
    }
    expect(onDisk(disk)).toBeLessThanOrEqual(SIZE(100) * 2);
  });

  it("starts by trimming a cache that is over its budget", async () => {
    const disk = new Disk();
    const roomy = cacheOn(disk, SIZE(100) * 10);
    for (const k of ["a", "b", "c", "d"]) {
      roomy.tick();
      await roomy.cache.put("ns", k, "x".repeat(100));
    }
    await roomy.cache.flush();
    await cacheOn(disk, SIZE(100) * 2).cache.size();
    expect(onDisk(disk)).toBeLessThanOrEqual(SIZE(100) * 2);
  });

  // One entry bigger than the whole cache cannot be kept; it must not empty the cache trying.
  it("keeps nothing bigger than its whole budget, and loses nothing else for it", async () => {
    const disk = new Disk();
    const { cache, tick } = cacheOn(disk, SIZE(100) * 3);
    for (const k of ["a", "b"]) {
      tick();
      await cache.put("ns", k, "x".repeat(100));
    }
    tick();
    await cache.put("ns", "huge", "x".repeat(400));
    expect(await cache.get("ns", "huge")).toBeNull();
    expect(await cache.get("ns", "a")).not.toBeNull();
    expect(await cache.get("ns", "b")).not.toBeNull();

    // ...even when what is held already sits between the mark and the budget.
    const full = new Disk();
    const near = cacheOn(full, 1000);
    for (const k of ["a", "b"]) {
      near.tick();
      await near.cache.put("ns", k, "x".repeat(448)); // 470 bytes each: 940, over the 900 mark
    }
    near.tick();
    await near.cache.put("ns", "huge", "x".repeat(1000));
    expect(await near.cache.get("ns", "a")).not.toBeNull();
    expect(await near.cache.get("ns", "b")).not.toBeNull();
  });

  it("clears out a write that crashed before its rename, once it is old", async () => {
    const disk = new Disk();
    disk.now = 0;
    disk.files.set(`${ROOT}/ns/0123.tmp-abc.json`, "{}");
    disk.written.set(`${ROOT}/ns/0123.tmp-abc.json`, 0);
    disk.files.set(`${ROOT}/ns/4567.tmp-def.json`, "{}");
    disk.written.set(`${ROOT}/ns/4567.tmp-def.json`, 11 * 60 * 1000);
    const cache = new AppCache(disk, ROOT, 10_000, () => 12 * 60 * 1000);
    expect(await cache.size()).toBe(0);
    expect(disk.files.has(`${ROOT}/ns/0123.tmp-abc.json`)).toBe(false); // 12 minutes old
    expect(disk.files.has(`${ROOT}/ns/4567.tmp-def.json`)).toBe(true); // may still be in flight
  });

  // Every store builds its own filesystem object; the app has ONE cache per folder, or two
  // records of use would each think the other's entries were not there.
  it("is one instance per folder, whichever filesystem object asks", async () => {
    const a = new Disk();
    const b = new Disk();
    const named = Object.assign(a, { cacheDir: async () => ROOT });
    const same = Object.assign(b, { cacheDir: async () => String.raw`C:\cache\app\\` });
    expect(await appCacheFor(named)).toBe(await appCacheFor(same));
    expect(await appCacheFor(new Disk())).toBeNull(); // no folder: nothing kept
  });

  it("holds, for any sequence of uses, its budget and least-recently-used order", async () => {
    const op = fc.oneof(
      fc.record({
        put: fc.constantFrom("a", "b", "c", "d", "e", "f"),
        n: fc.integer({ min: 1, max: 400 }),
      }),
      fc.record({ get: fc.constantFrom("a", "b", "c", "d", "e", "f") }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 40 }), async (ops) => {
        const budget = SIZE(400) * 3;
        const disk = new Disk();
        const { cache, tick } = cacheOn(disk, budget);
        const lastUse = new Map<string, number>();
        let clock = 0;
        for (const o of ops) {
          tick();
          clock += 1;
          if ("put" in o) {
            await cache.put("ns", o.put, "x".repeat(o.n));
            lastUse.set(o.put, clock);
          } else if ((await cache.get("ns", o.get)) !== null) lastUse.set(o.get, clock);
          expect(onDisk(disk)).toBeLessThanOrEqual(budget);
        }
        // What is still held was used more recently than anything that was evicted.
        const held: string[] = [];
        const gone: string[] = [];
        for (const k of lastUse.keys()) {
          const files = disk.entries().length;
          const hit = await cache.get("ns", k);
          (hit !== null ? held : gone).push(k);
          expect(disk.entries().length).toBe(files); // a read evicts nothing
        }
        const oldestHeld = Math.min(...held.map((k) => lastUse.get(k)!));
        for (const k of gone) expect(lastUse.get(k)!).toBeLessThan(oldestHeld);
      }),
      { numRuns: 120 },
    );
  });
});
