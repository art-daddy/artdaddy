// Desktop auth wrapper. It restores a stored session in the background, re-locks only when
// refresh proves the session is absent/invalid, and re-checks when the network returns.
//
// Clerk's own SDK cannot run inside this webview at all (its origin is neither the verified
// web domain nor a browser Clerk trusts — see api/desktopAuth.ts), so sign-in happens in the
// system browser at the real https://artdaddy.app/auth origin and hands a one-time code back
// here via an `artdaddy://` deep link.
import { useEffect, useState } from "react";

import {
  ensureFreshAccessToken,
  getUserId as getDesktopUserId,
  getUserEmail as getDesktopUserEmail,
  handleDeepLinkCallback,
  refreshDesktopSession,
  renewAfterRejection,
  storedSessionKnown,
} from "../api/desktopAuth";
import { onAuthFailure, setClerkTokenProvider, setSessionRenewer } from "../api/auth";
import { reportLaunchOnce } from "../api/appEvents";
import { identifyUser } from "../observability/sentry";
import { platform } from "../platform";
import { useAuth, isSignedOutGate, authBypassed } from "../store/auth";
import SignInScreen from "./SignInScreen";

/** How long launch waits on the session before opening (offline) for one that is stored. */
const BOOT_PATIENCE_MS = 15_000;

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const status = useAuth((s) => s.status);
  const hasStoredSession = useAuth((s) => s.hasStoredSession);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [restoreUnavailable, setRestoreUnavailable] = useState(false);
  useEffect(() => {
    const restoreDesktopSession = async (): Promise<void> => {
      const result = await refreshDesktopSession();
      if (result.status === "superseded") return;
      if (result.hasStoredSession !== null) {
        useAuth.getState().setStoredSession(result.hasStoredSession);
      }
      if (result.status === "refreshed") void useAuth.getState().verify();
      else if (result.status === "missing" || result.status === "invalid")
        useAuth.getState().markLocked();
      else useAuth.getState().markOffline();
    };
    // A REVOKED token still 401s a live call, and that must not force a fresh sign-in while the
    // 60-day refresh token is good — so try a silent refresh first and only lock if THAT fails.
    // Ordinary EXPIRY no longer arrives here: the token provider renews before the request.
    const offAuth = onAuthFailure(() => {
      if (platform.name !== "tauri") {
        useAuth.getState().markLocked();
        return;
      }
      void restoreDesktopSession();
    });
    // An offline desktop process has no access token in memory. Refresh first when the network
    // returns; calling verify() directly would send no bearer token and falsely lock the user.
    const onOnline = () => {
      if (useAuth.getState().status === "unlocked") return;
      if (platform.name === "tauri") void restoreDesktopSession();
      else void useAuth.getState().verify();
    };
    window.addEventListener("online", onOnline);
    return () => {
      offAuth();
      window.removeEventListener("online", onOnline);
    };
  }, []);

  useEffect(() => {
    // Renews a spent token BEFORE the request carries it. Handing over whatever was in memory is
    // what made the first prompt after an idle spell fail for everyone, once, every time.
    // Under the local/e2e bypass no door may block, so a renewal that fails sends no token.
    const removeProvider = setClerkTokenProvider(
      authBypassed()
        ? () => ensureFreshAccessToken().catch(() => null)
        : () => ensureFreshAccessToken(),
    );
    const removeRenewer = setSessionRenewer((refused) => renewAfterRejection(refused));
    if (platform.name !== "tauri") {
      void useAuth.getState().verify();
      return () => {
        removeProvider();
        removeRenewer();
      };
    }
    let cancelled = false;
    let offDeepLink: (() => void) | undefined;
    void (async () => {
      const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
      const onUrls = async (urls: string[]) => {
        for (const url of urls) {
          const result = await handleDeepLinkCallback(url);
          if (result.ok) {
            useAuth.getState().setStoredSession(true);
            void useAuth.getState().verify();
            identifyUser(getDesktopUserId(), getDesktopUserEmail());
            if (getDesktopUserId()) reportLaunchOnce();
          }
        }
      };
      // BOTH paths are load-bearing: onOpenUrl catches a callback while the app is running,
      // getCurrent catches the one that COLD-STARTED it, which is the common case on Windows.
      const startUrls = await getCurrent();
      if (!cancelled && startUrls) void onUrls(startUrls);
      if (cancelled) return;
      // Unsubscribing is only possible once the await resolves, so a remount that happens
      // in between must tear this listener down itself or it stays registered forever.
      const off = await onOpenUrl((urls) => void onUrls(urls));
      if (cancelled) off();
      else offDeepLink = off;
    })();
    return () => {
      cancelled = true;
      removeProvider();
      removeRenewer();
      offDeepLink?.();
    };
  }, []);

  useEffect(() => {
    if (platform.name !== "tauri") return;
    let cancelled = false;
    setRestoreUnavailable(false);
    void (async () => {
      const restoring = refreshDesktopSession();
      let patience: ReturnType<typeof setTimeout> | undefined;
      let result = await Promise.race([
        restoring,
        new Promise<null>((resolve) => {
          patience = setTimeout(() => resolve(null), BOOT_PATIENCE_MS);
        }),
      ]);
      clearTimeout(patience);
      if (cancelled) return;
      if (result === null) {
        // The server is still waking (up to ~45 s, UJ-010): a stored session opens offline now,
        // and the renewal that carries on brings AI back by itself.
        if (storedSessionKnown() === true) {
          useAuth.getState().setStoredSession(true);
          useAuth.getState().markOffline();
        }
        result = await restoring;
        if (cancelled) return;
      }
      if (result.status === "superseded") {
        result = await refreshDesktopSession();
        if (cancelled) return;
      }
      if (result.hasStoredSession !== null) {
        useAuth.getState().setStoredSession(result.hasStoredSession);
      }
      if (result.status === "superseded") {
        setRestoreUnavailable(true);
        return;
      }
      if (result.status === "unavailable" && result.hasStoredSession === null) {
        setRestoreUnavailable(true);
        return;
      }
      if (result.status === "unavailable") useAuth.getState().markOffline();
      else if (result.status === "missing" || result.status === "invalid")
        useAuth.getState().markLocked();
      else void useAuth.getState().verify();
      identifyUser(getDesktopUserId(), getDesktopUserEmail()); // so an issue names a real person
      // Fired here rather than at startup: before the session restores there is nobody to
      // attribute the launch to, and an unattributed launch answers none of the questions
      // this marker exists for.
      if (getDesktopUserId()) reportLaunchOnce();
    })();
    return () => {
      cancelled = true;
    };
  }, [restoreAttempt]);

  useEffect(() => {
    if (status !== "checking") return;
    const timer = setTimeout(() => setRestoreUnavailable(true), 10_000);
    return () => clearTimeout(timer);
  }, [status, restoreAttempt]);

  if (authBypassed()) return <>{children}</>;
  if (status === "checking")
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg p-6 text-center">
        <div>
          <div className="text-lg font-semibold text-neutral-100">Starting ArtDaddy…</div>
          <div className="mt-2 text-sm text-neutral-400">
            {restoreUnavailable
              ? "ArtDaddy couldn't read your saved session."
              : "Restoring your saved session."}
          </div>
          {restoreUnavailable ? (
            <div className="mt-5 flex justify-center gap-3">
              <button
                type="button"
                className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-black"
                onClick={() => setRestoreAttempt((attempt) => attempt + 1)}
              >
                Retry
              </button>
              <button
                type="button"
                className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-200"
                onClick={() => useAuth.getState().markLocked()}
              >
                Sign in again
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  if (isSignedOutGate({ status, hasStoredSession }))
    return <SignInScreen offline={status === "offline"} />;
  return <>{children}</>;
}
