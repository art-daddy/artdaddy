// Desktop health belongs to the native process, which records clean exits and observed
// renderer/panic failures. An unexplained leftover marker is not evidence of its cause.
// The web-only fallback retains the older heartbeat marker.
import { captureError } from "./sentry";
import { platform } from "../platform";
import { useAuth } from "../store/auth";
import { reportAppEvent } from "../api/appEvents";

const KEY = "artdaddy.session";
/** Ignore short incomplete web markers; native observations do not use this heuristic. */
const MIN_PLAUSIBLE_MS = 1_500;

interface NativeToken {
  launch_id: string;
  renderer_epoch: number;
}

interface NativeFailure {
  id: string;
  kind: string;
  at: number;
  eligible: boolean;
  session: {
    release: string;
    started_at: number;
    alive_at: number;
    context: {
      project_id?: string;
      user_id?: string;
      activity?: string;
      heap_mb?: number;
      heap_limit_mb?: number;
    };
  };
}

interface NativeStatus extends NativeToken {
  failures: NativeFailure[];
  storage_ok: boolean;
}

let updateNative: (() => void) | null = null;
let projectId = "";

interface Session {
  startedAt: number;
  /** Refreshed while the app runs, so the report can say how long it survived. */
  aliveAt: number;
  projectId?: string;
  release?: string;
  /** Last observed JS heap, MB; useful context, not a diagnosis. */
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
  updateNative?.();
}

/** Register a concurrent expensive activity without one job's cleanup hiding another one. */
export function beginSessionActivity(what: string): () => void {
  const token = Symbol(what);
  activities.set(token, what || "idle");
  activity = what || "idle";
  updateNative?.();
  return () => {
    activities.delete(token);
    activity = [...activities.values()].at(-1) ?? "idle";
    updateNative?.();
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
  noteNativeProject(projectId ?? "");
  if (platform.name === "tauri") return;
  const store = globalThis.localStorage as Storage | undefined;
  if (!store) return;
  const s = read(store);
  if (!s) return;
  write(store, { ...s, projectId: projectId || undefined, aliveAt: Date.now() });
}

function noteNativeProject(next: string): void {
  projectId = next;
  updateNative?.();
}

function installNativeCrashWatch(): () => void {
  let stopped = false;
  let token: NativeToken | null = null;
  let revision = 0;
  let sending = false;
  let nextAttempt = 0;
  let invoke: typeof import("@tauri-apps/api/core").invoke;
  const pending = new Map<string, NativeFailure>();
  const acknowledged = new Set<string>();
  const sentToSentry = new Set<string>();
  const synchronize = (): void => {
    if (stopped || !token) return;
    const auth = useAuth.getState();
    const memory = heap();
    const context = {
      project_id: projectId,
      user_id: auth.profile?.user_id ?? "",
      auth_state: auth.status,
      has_stored_session: auth.hasStoredSession,
      activity,
      heap_mb: memory.heapMb ?? null,
      heap_limit_mb: memory.heapLimitMb ?? null,
    };
    void invoke("runtime_health_update", { token, revision: ++revision, context }).catch(
      () => undefined,
    );
  };
  const drain = async (): Promise<void> => {
    const auth = useAuth.getState();
    if (sending || stopped || !token || Date.now() < nextAttempt || auth.status === "checking")
      return;
    sending = true;
    try {
      for (const failure of pending.values()) {
        if (stopped) break;
        const previous = failure.session.context;
        const current = useAuth.getState();
        const signedOut =
          current.status === "locked" ||
          (current.status === "offline" && !current.hasStoredSession);
        const differentOwner =
          previous.user_id &&
          current.profile?.user_id &&
          previous.user_id !== current.profile.user_id;
        if (!failure.eligible || signedOut || differentOwner) {
          failure.eligible = false;
        } else {
          if (!current.profile?.user_id) break;
          const context = {
            project_id: previous.project_id,
            previous_release: failure.session.release,
            activity: previous.activity ?? "idle",
            ran_for_ms: Math.max(0, failure.session.alive_at - failure.session.started_at),
            heap_mb: previous.heap_mb,
            heap_limit_mb: previous.heap_limit_mb,
            native_failure: failure.kind,
          };
          const ownerId = previous.user_id || current.profile.user_id;
          const outcome = await reportAppEvent("app_error", {
            projectId: previous.project_id,
            ownerId,
            ok: false,
            reason: `${failure.kind} after ${Math.round(context.ran_for_ms / 1000)}s during ${context.activity}`,
            via: failure.kind,
            eventId: failure.id,
            occurredAt: failure.at / 1000,
            onVerifiedSend: () => {
              if (!sentToSentry.has(failure.id)) {
                sentToSentry.add(failure.id);
                captureError(
                  new Error(
                    failure.kind === "unclean_exit"
                      ? "Previous native session ended unexpectedly; cause unknown"
                      : `Native failure: ${failure.kind}`,
                  ),
                  context,
                  ownerId,
                );
              }
            },
          });
          if (outcome === "unavailable") break;
        }
        if (stopped) break;
        if (await invoke<boolean>("runtime_health_ack", { token, ids: [failure.id] })) {
          acknowledged.add(failure.id);
          pending.delete(failure.id);
        }
      }
    } catch {
      // Native state remains available for a later attempt.
    } finally {
      sending = false;
      nextAttempt = Date.now() + 30_000;
    }
  };
  const onAuth = useAuth.subscribe((state) => {
    if (state.status === "locked" || (state.status === "offline" && !state.hasStoredSession)) {
      for (const failure of pending.values()) failure.eligible = false;
    }
    synchronize();
    nextAttempt = 0;
    void drain();
  });
  const beat = setInterval(() => {
    synchronize();
    if (stopped || !token) return;
    void invoke<NativeStatus | null>("runtime_health_status", { token })
      .then((status) => {
        if (stopped || !status || !Array.isArray(status.failures)) return;
        let added = false;
        for (const failure of status.failures) {
          if (acknowledged.has(failure.id)) continue;
          const previous = pending.get(failure.id);
          if (!previous) {
            pending.set(failure.id, failure);
            added = true;
          } else if (!failure.eligible) previous.eligible = false;
        }
        if (added) nextAttempt = 0;
        void drain();
      })
      .catch(() => undefined);
  }, 5_000);
  const sync = () => synchronize();
  updateNative = sync;
  void import("@tauri-apps/api/core")
    .then(async (core) => {
      invoke = core.invoke;
      const status = await invoke<NativeStatus>("runtime_health_begin");
      if (stopped) return;
      token = { launch_id: status.launch_id, renderer_epoch: status.renderer_epoch };
      for (const failure of status.failures) pending.set(failure.id, failure);
      synchronize();
      await drain();
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    clearInterval(beat);
    onAuth();
    if (updateNative === sync) updateNative = null;
  };
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
        likely_cause: "unknown",
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
  if (platform.name === "tauri") return installNativeCrashWatch();
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
