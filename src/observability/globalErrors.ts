// Last-resort error boundaries for everything that escapes React's render tree:
// unhandled promise rejections (async handlers) and uncaught event-handler/resource
// errors. React RENDER errors are already caught by Sentry.ErrorBoundary (main.tsx);
// these two `window` listeners cover the rest, so an escaped async throw reaches
// Sentry instead of only the console.
//
// EXPECTED, handled control-flow errors (rate/credit limit, gate rejections) are
// skipped — they are outcomes a boundary already converted, not crashes.
import { ArtDaddyError, isExpected } from "../lib/errors";
import { reportAppError } from "../api/appEvents";
import { captureError } from "./sentry";

/** Wire the global `unhandledrejection` + `error` handlers onto `target` (the real
 *  window in production; a stub in tests). Idempotent per target is the caller's
 *  concern — call once at boot. */
export function installGlobalErrorHandlers(target: Window = window): void {
  const report = (err: unknown, scope: string): void => {
    if (isExpected(err)) return;
    const code = err instanceof ArtDaddyError ? err.code : undefined;
    captureError(err, code ? { scope, code } : { scope });
    // Sentry answers "what broke"; this answers "did a session end here". Sampling and the
    // actionable-event filter mean a Sentry issue is not a reliable funnel row.
    reportAppError(`${scope}: ${(err as Error)?.message ?? String(err)}`);
  };
  target.addEventListener("unhandledrejection", (e) => report(e.reason, "unhandledrejection"));
  target.addEventListener("error", (e) => report(e.error ?? e.message, "window.error"));
}
