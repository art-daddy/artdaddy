// Report the crashes nobody was alive to report.
//
// Our worst failures kill the PROCESS: a 1.84 GB media read made the Rust side abort with
// 0xE0000008 (out of memory), and Windows Error Reporting logged it while Sentry showed a
// quiet week. Nothing inside the webview can report its own death — by the time it happens
// there is no JS left to run. So the app leaves a marker while it is running and looks for a
// stale one on the NEXT start: a marker that was never cleared means the previous session
// died without shutting down.
//
// That covers every way the app can vanish (out of memory, a native abort, Task Manager, a
// power cut), not just the ones we thought to catch, and needs no crash handler in Rust.
import { captureError } from "./sentry";

const KEY = "artdaddy.session";
/** Sessions shorter than this are almost certainly a launch failure rather than a crash. */
const MIN_PLAUSIBLE_MS = 1_500;

interface Session {
  startedAt: number;
  /** Refreshed while the app runs, so the report can say how long it survived. */
  aliveAt: number;
  projectId?: string;
  release?: string;
}

function read(store: Storage): Session | null {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    return typeof s.startedAt === "number" && typeof s.aliveAt === "number" ? (s as Session) : null;
  } catch {
    return null; // unreadable marker tells us nothing; treat as no previous session
  }
}

function write(store: Storage, s: Session): void {
  try {
    store.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full/disabled — crash detection is best-effort, never fatal */
  }
}

/** The project the session was in when it died, so a report points at the media involved. */
export function noteSessionProject(projectId: string | null | undefined): void {
  const store = globalThis.localStorage as Storage | undefined;
  if (!store) return;
  const s = read(store);
  if (!s) return;
  write(store, { ...s, projectId: projectId || undefined, aliveAt: Date.now() });
}

/**
 * Report a previous unclean exit (if any), then mark this session as running.
 * Returns what was reported, for the caller to log/test.
 */
export function startCrashWatch(
  opts: { release?: string; now?: () => number; storage?: Storage } = {},
): { reportedCrash: boolean; ranForMs?: number } {
  const store = opts.storage ?? (globalThis.localStorage as Storage | undefined);
  if (!store) return { reportedCrash: false };
  const now = opts.now ?? Date.now;
  const previous = read(store);

  let reportedCrash = false;
  let ranForMs: number | undefined;
  if (previous) {
    // A marker that outlived its process: the last session never got to clear it.
    ranForMs = Math.max(0, previous.aliveAt - previous.startedAt);
    if (ranForMs >= MIN_PLAUSIBLE_MS) {
      reportedCrash = true;
      captureError(new Error("Previous session ended without shutting down"), {
        ran_for_ms: ranForMs,
        project_id: previous.projectId,
        previous_release: previous.release,
        // Named so the cause is searchable next to the Windows/OS crash record.
        likely_cause: "process died (out of memory, native abort, or force-quit)",
      });
    }
  }

  const started = now();
  write(store, { startedAt: started, aliveAt: started, release: opts.release });
  return { reportedCrash, ranForMs };
}

/** Keep the "still alive" stamp fresh, and clear it on a clean shutdown. */
export function installCrashWatch(opts: { release?: string } = {}): () => void {
  const store = globalThis.localStorage as Storage | undefined;
  if (!store) return () => undefined;
  startCrashWatch(opts);

  const beat = setInterval(() => {
    const s = read(store);
    if (s) write(store, { ...s, aliveAt: Date.now() });
  }, 5_000);

  const clear = (): void => {
    try {
      store.removeItem(KEY);
    } catch {
      /* nothing useful to do while the window is going away */
    }
  };
  // pagehide covers the webview teardown that beforeunload can miss.
  addEventListener("beforeunload", clear);
  addEventListener("pagehide", clear);
  return () => {
    clearInterval(beat);
    removeEventListener("beforeunload", clear);
    removeEventListener("pagehide", clear);
    clear();
  };
}
