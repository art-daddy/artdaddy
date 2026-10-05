// Partial exports in flight, recorded app-wide so a launch can remove the ones a crash, a kill or
// a quit left behind (UJ-022). The export queue removes its own partial when an export settles;
// this covers only the exports that never got to. Best-effort throughout: the bookkeeping must
// never fail or delay an export, so every error here is swallowed.
import { APP_SESSION } from "../project/jobLedger";
import { joinPath, type FsLike } from "../tools/store";

interface Entry {
  path: string;
  /** The launch that wrote it. A sweep only removes another launch's partials: this launch's may
   *  belong to an export that is still running. */
  session: string;
}

interface Backend {
  fs: FsLike;
  root: string;
}

const FILE = "export-staging.json";
/** The only names a sweep will delete: the hidden `.<name>.<rand>.partial` siblings render.ts
 *  stages to. The list is a file, and a file can say anything. */
const STAGING_NAME = /^\.[^/\\]+\.[a-z0-9]{1,8}\.partial$/;

let backend: Promise<Backend | null> | null = null;
let tail: Promise<unknown> = Promise.resolve();

function getBackend(): Promise<Backend | null> {
  backend ??= (async () => {
    if (typeof window === "undefined" || !(window.__TAURI_INTERNALS__ ?? window.__TAURI__)) {
      return null; // no desktop bridge: no files to leave behind
    }
    try {
      const [{ TauriFs }, { dataRoot }] = await Promise.all([
        import("../tools/tauri"),
        import("../tools/dataRoot"),
      ]);
      return { fs: new TauriFs(), root: await dataRoot() };
    } catch {
      return null;
    }
  })();
  return backend;
}

/** Tests only: point the record at a fake fs, or back at the default with `null`. */
export function __setStagingBackend(b: Backend | null): void {
  backend = b ? Promise.resolve(b) : null;
  tail = Promise.resolve();
}

function isStagingPath(p: string): boolean {
  return STAGING_NAME.test(p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1));
}

async function read(b: Backend): Promise<Entry[]> {
  try {
    const raw = JSON.parse(await b.fs.readTextFile(joinPath(b.root, FILE))) as {
      staging?: unknown;
    };
    if (!Array.isArray(raw.staging)) return [];
    return raw.staging.filter(
      (e): e is Entry =>
        !!e &&
        typeof (e as Entry).path === "string" &&
        typeof (e as Entry).session === "string" &&
        isStagingPath((e as Entry).path),
    );
  } catch {
    return []; // absent or unreadable: nothing recorded
  }
}

async function write(b: Backend, entries: Entry[]): Promise<void> {
  await b.fs.writeTextFile(joinPath(b.root, FILE), JSON.stringify({ staging: entries }));
}

/** Read-modify-write the list, one at a time: two exports settling together must not drop each
 *  other's entries. */
function update<T>(
  fn: (b: Backend, entries: Entry[]) => Promise<[Entry[], T]>,
  none: T,
): Promise<T> {
  const run = tail.then(async () => {
    const b = await getBackend();
    if (!b) return none;
    try {
      const [next, out] = await fn(b, await read(b));
      await write(b, next);
      return out;
    } catch {
      return none;
    }
  });
  tail = run.catch(() => undefined);
  return run;
}

/** The run a partial belongs to. In the app that is the app process's run, which outlives a
 *  reload of the page while its export keeps writing (3h part 7); elsewhere, the page. */
async function currentSession(): Promise<string> {
  try {
    const { jobSupervisor } = await import("../tools/jobSupervisor");
    const sup = await jobSupervisor();
    if (sup) return await sup.launchId();
  } catch {
    /* no app process to ask */
  }
  return APP_SESSION;
}

/** Note a partial before ffmpeg starts writing it. */
export function recordStaging(path: string): Promise<void> {
  return update(async (_b, entries) => {
    const next = entries.filter((e) => e.path !== path);
    next.push({ path, session: await currentSession() });
    return [next, undefined];
  }, undefined);
}

/** Forget a partial that no longer exists (renamed into place, or removed). */
export function releaseStaging(path: string): Promise<void> {
  return update(
    async (_b, entries) => [entries.filter((e) => e.path !== path), undefined],
    undefined,
  );
}

/** Remove the partials earlier launches left behind. Returns the paths removed; one that cannot
 *  be removed yet (still open somewhere) stays listed for the next launch. */
export function sweepStaging(): Promise<string[]> {
  return update(async (b, entries) => {
    const session = await currentSession();
    const kept: Entry[] = [];
    const removed: string[] = [];
    for (const e of entries) {
      if (e.session === session) {
        kept.push(e);
        continue;
      }
      try {
        if (await b.fs.exists(e.path)) {
          if (!b.fs.remove) throw new Error("this filesystem cannot remove files");
          await b.fs.remove(e.path);
          removed.push(e.path);
        }
      } catch {
        kept.push(e);
      }
    }
    return [kept, removed];
  }, []);
}
