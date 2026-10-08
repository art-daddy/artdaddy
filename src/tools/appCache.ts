// The app-wide cache: work that is expensive to redo and true of a FILE rather than of a project,
// namely transcripts and loudness figures (owner decisions 2026-10-04 and 2026-10-07). It lives
// outside every project (`<app cache dir>/cache`, see `appCacheRoot`), so a file two projects use
// is transcribed once, a duplicated or moved project keeps its transcripts, and a job can store its
// result after the project that asked for it has closed.
//
// Palmier's rule for a cache, which this follows: an explicit key, capacity, invalidation rule,
// replacement rule, lifecycle behaviour and stale-result policy.
//  - Key: the caller's. It names the file by its identity (`ProjectStoreAccess.fileIdentity`) plus
//    whatever else the value depends on (model, language, window, span). The key is stored in the
//    entry and checked on every read, so two keys that share a file name read as a miss, never as
//    each other's value.
//  - Capacity: 1 GB of entries.
//  - Replacement: least recently used first, down to 90% of the budget.
//  - Invalidation: none needed. A changed file has another identity, so its old entries are never
//    asked for again and age out.
//  - Lifecycle: one instance per folder, shared by every project and tool in the process (the app
//    runs as a single instance).
//  - Stale results: an entry that cannot be read is a miss; one that cannot be parsed is removed.
//    Nothing here throws: a cache that cannot answer is a miss, and the caller does the work.
import { shortHash } from "./hash";
import { atomicWriteText, type FsLike, joinPath } from "./store";
import { isStale, isTempName } from "./tempNames";

/** The owner's ceiling for the whole cache (2026-10-07). */
export const APP_CACHE_BUDGET_BYTES = 1024 ** 3;
/** Eviction stops here, so one new entry does not trigger a sweep per write. */
const AFTER_EVICTION = 0.9;
const INDEX = "index.json";
const FLUSH_DELAY_MS = 1000;

interface Usage {
  bytes: number;
  used: number;
}

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

export class AppCache {
  private usage: Map<string, Usage> | null = null;
  private loading: Promise<void> | null = null;
  private total = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Writes to the index and evictions run one at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fs: FsLike,
    readonly root: string,
    private readonly budget: number = APP_CACHE_BUDGET_BYTES,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The entry's place, relative to the root. The hash only spreads keys over file names; the key
   *  itself, kept in the entry, decides what the entry answers. */
  private relFor(namespace: string, key: string): string {
    return `${namespace}/${shortHash(key)}${shortHash(`${key}\u0001`)}.json`;
  }

  /** The value stored under `key`, or null. A hit counts as a use. Never throws: a cache that
   *  cannot answer is a miss, and the caller does the work. */
  async get<T>(namespace: string, key: string): Promise<T | null> {
    try {
      return await this.read<T>(namespace, key);
    } catch {
      return null;
    }
  }

  private async read<T>(namespace: string, key: string): Promise<T | null> {
    await this.load();
    const rel = this.relFor(namespace, key);
    let raw: string;
    try {
      raw = await this.fs.readTextFile(joinPath(this.root, rel));
    } catch {
      this.forget(rel); // evicted, or never written: not ours to count any more
      return null;
    }
    let entry: { key?: unknown; value?: unknown };
    try {
      entry = JSON.parse(raw) as { key?: unknown; value?: unknown };
    } catch {
      await this.drop(rel);
      return null;
    }
    if (entry.key !== key || entry.value === undefined) return null;
    const u = this.usage?.get(rel);
    if (u) u.used = this.now();
    else this.account(rel, utf8Bytes(raw));
    this.scheduleFlush();
    return entry.value as T;
  }

  /** Store `value` under `key`. False when it could not be written: the caller has its answer
   *  either way, and the next ask computes it again. Never throws. */
  async put(namespace: string, key: string, value: unknown): Promise<boolean> {
    try {
      await this.load();
      const rel = this.relFor(namespace, key);
      const raw = JSON.stringify({ key, value });
      await this.fs.mkdir(joinPath(this.root, namespace));
      await atomicWriteText(this.fs, joinPath(this.root, rel), raw);
      this.account(rel, utf8Bytes(raw));
      if (this.total > this.budget) await this.serial(() => this.evict(rel));
      this.scheduleFlush();
      return true;
    } catch {
      return false;
    }
  }

  /** Persist the record of what was used when, now. */
  flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    return this.serial(async () => {
      if (!this.usage) return;
      const entries: Record<string, Usage> = {};
      for (const [rel, u] of this.usage) entries[rel] = u;
      await atomicWriteText(
        this.fs,
        joinPath(this.root, INDEX),
        JSON.stringify({ version: 1, entries }),
      ).catch(() => undefined);
    });
  }

  /** Bytes held, as this instance counts them. */
  async size(): Promise<number> {
    await this.load();
    return this.total;
  }

  /** Forget pending work; for tests that reset between cases. */
  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private account(rel: string, bytes: number): void {
    if (!this.usage) return;
    const prev = this.usage.get(rel);
    this.total += bytes - (prev?.bytes ?? 0);
    this.usage.set(rel, { bytes, used: this.now() });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async drop(rel: string): Promise<void> {
    await this.fs.remove?.(joinPath(this.root, rel)).catch(() => undefined);
    this.forget(rel);
  }

  private forget(rel: string): void {
    const u = this.usage?.get(rel);
    if (!u) return;
    this.total -= u.bytes;
    this.usage?.delete(rel);
  }

  /** Least recently used out until the cache is back under its mark. The entry just written is
   *  the most recent, so it is never the one that goes, unless it alone is over the budget: then it
   *  goes, and nothing else does. */
  private async evict(keep: string): Promise<void> {
    if (!this.usage || this.total <= this.budget) return;
    if ((this.usage.get(keep)?.bytes ?? 0) > this.budget) {
      await this.drop(keep);
      if (this.total <= this.budget) return;
    }
    const mark = this.budget * AFTER_EVICTION;
    const oldest = [...this.usage.entries()]
      .filter(([rel]) => rel !== keep)
      .sort((a, b) => a[1].used - b[1].used);
    for (const [rel] of oldest) {
      if (this.total <= mark) break;
      await this.drop(rel);
    }
  }

  /** The record of use, read once. The folder decides what is held (an entry written just before
   *  a crash, and never recorded, still counts and can still be evicted); the index decides when
   *  each was last used, and a file it does not know is dated by when it was written. */
  private load(): Promise<void> {
    this.loading ??= (async () => {
      const recorded = new Map<string, Usage>();
      try {
        const raw = JSON.parse(await this.fs.readTextFile(joinPath(this.root, INDEX))) as {
          entries?: Record<string, Usage>;
        };
        for (const [rel, u] of Object.entries(raw.entries ?? {}))
          if (Number.isFinite(u?.bytes) && Number.isFinite(u?.used)) recorded.set(rel, u);
      } catch {
        /* no index yet, or unreadable: the folder alone says what is held */
      }
      let usage: Map<string, Usage>;
      try {
        usage = (await this.scan(recorded)) ?? recorded;
      } catch {
        usage = recorded; // the folder could not be read: go on what the index says
      }
      this.usage = usage;
      this.total = [...usage.values()].reduce((n, u) => n + u.bytes, 0);
      if (this.total > this.budget) await this.serial(() => this.evict(""));
    })();
    return this.loading;
  }

  /** What the folder holds, dated from `recorded` where it can be. Null when this filesystem
   *  cannot list a folder, and then the index is all there is to go on. */
  private async scan(recorded: Map<string, Usage>): Promise<Map<string, Usage> | null> {
    if (!this.fs.readDir || !this.fs.stat) return null;
    const usage = new Map<string, Usage>();
    const dirs = await this.fs.readDir(this.root).catch(() => []);
    for (const dir of dirs) {
      if (!dir.isDirectory) continue;
      const base = joinPath(this.root, dir.name);
      for (const f of await this.fs.readDir(base).catch(() => [])) {
        if (f.isDirectory) continue;
        const rel = `${dir.name}/${f.name}`;
        const path = joinPath(base, f.name);
        const known = recorded.get(rel);
        if (known && !isTempName(f.name)) {
          usage.set(rel, known);
          continue;
        }
        const st = await this.fs.stat(path).catch(() => null);
        if (!st) continue;
        const written = st.mtimeMs ?? 0;
        // A write that crashed between its temporary file and the rename leaves the temporary.
        if (isTempName(f.name)) {
          if (isStale(written, this.now())) await this.fs.remove?.(path).catch(() => undefined);
          continue;
        }
        usage.set(rel, { bytes: st.size, used: written });
      }
    }
    return usage;
  }
}

const caches = new Map<string, AppCache>();
const roots = new WeakMap<FsLike, Promise<string | null>>();

/** The one cache for the folder `fs` names, or null when this filesystem has no app cache (some
 *  test fakes): then nothing is kept between calls, which is slower and never wrong. */
export async function appCacheFor(fs: FsLike): Promise<AppCache | null> {
  let root = roots.get(fs);
  if (!root) {
    root = fs.cacheDir
      ? fs.cacheDir().then(
          (r) => (r ? r.replace(/\\/g, "/").replace(/\/+$/, "") : null),
          () => null,
        )
      : Promise.resolve(null);
    roots.set(fs, root);
  }
  const dir = await root;
  if (!dir) return null;
  let cache = caches.get(dir);
  if (!cache) {
    cache = new AppCache(fs, dir);
    caches.set(dir, cache);
  }
  return cache;
}

/** Tests only: drop every shared instance, so one case's entries never answer another's. */
export function _resetAppCaches(): void {
  for (const c of caches.values()) c.dispose();
  caches.clear();
}
