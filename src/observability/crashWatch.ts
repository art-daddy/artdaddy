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
  /** JS heap at the last heartbeat, MB. The whole point: it separates a renderer that ran out
   *  of memory from a native side that aborted, and the marker is the only evidence that
   *  survives the process. */
  heapMb?: number;
  heapLimitMb?: number;
  /** What the app was doing when it last checked in — an export is a very different suspect
   *  from an idle window. */
  activity?: string;
}

/** Chromium-only and deliberately untyped elsewhere: WebView2 is Chromium, so this is present
 *  where our crashes happen, and absent (harmlessly) in tests and on Safari. */
function heap(): { heapMb?: number; heapLimitMb?: number } {
  const m = (
    performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
  ).memory;
  if (!m) return {};
  return {
    heapMb: Math.round(m.usedJSHeapSize / 1e6),
    heapLimitMb: Math.round(m.jsHeapSizeLimit / 1e6),
  };
}

let activity = "idle";
const activities = new Map<symbol, string>();

/** Name the expensive thing currently under way ("export", "transcribe", "render"). Reported
 *  with the next crash, so "it dies during export" stops being a guess. */
export function noteSessionActivity(what: string): void {
  activity = what || "idle";
}

/** Register a concurrent expensive activity without one job's cleanup hiding another one. */
export function beginSessionActivity(what: string): () => void {
  const token = Symbol(what);
  activities.set(token, what || "idle");
  activity = what || "idle";
  return () => {
    activities.delete(token);
    activity = [...activities.values()].at(-1) ?? "idle";
  };
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
        // The last heartbeat before the process vanished — this is what says whether it ran
        // out of memory, and what it was busy with when it did.
        heap_mb: previous.heapMb,
        heap_limit_mb: previous.heapLimitMb,
        heap_pct:
          previous.heapMb && previous.heapLimitMb
            ? Math.round((previous.heapMb / previous.heapLimitMb) * 100)
            : undefined,
        activity: previous.activity,
        // Named so the cause is searchable next to the Windows/OS crash record.
        likely_cause: "process died (out of memory, native abort, or force-quit)",
      });
      // The same fact as a funnel row. A process that died reported nothing while it was
      // dying, so the session simply stops -- this is the only place that end can be dated,
      // and it names what the app was busy with when it happened.
      void import("../api/appEvents")
        .then((m) =>
          m.reportAppError(
            `unclean exit after ${Math.round(ranForMs! / 1000)}s during ${previous.activity ?? "idle"}` +
              (previous.heapMb ? ` (heap ${previous.heapMb}MB)` : ""),
            previous.projectId ?? "",
          ),
        )
        .catch(() => undefined);
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
    if (s) write(store, { ...s, aliveAt: Date.now(), activity, ...heap() });
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
