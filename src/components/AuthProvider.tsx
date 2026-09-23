// Desktop auth wrapper. It restores a stored session in the background, re-locks only when
// refresh proves the session is absent/invalid, and re-checks when the network returns.
//
// Clerk's own SDK cannot run inside this webview at all (its origin is neither the verified
// web domain nor a browser Clerk trusts — see api/desktopAuth.ts), so sign-in happens in the
// system browser at the real https://artdaddy.app/auth origin and hands a one-time code back
// here via an `artdaddy://` deep link.
import { useEffect, useState } from "react";

import {
  getAccessToken as getDesktopAccessToken,
  getUserId as getDesktopUserId,
  getUserEmail as getDesktopUserEmail,
  handleDeepLinkCallback,
  refreshDesktopSession,
} from "../api/desktopAuth";
import { onAuthFailure, setClerkTokenProvider } from "../api/auth";
import { reportLaunchOnce } from "../api/appEvents";
import { identifyUser } from "../observability/sentry";
import { platform } from "../platform";
import { useAuth, isSignedOutGate, authBypassed } from "../store/auth";
import SignInScreen from "./SignInScreen";

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
    // A rotated/revoked access token 401s a live call every 30 minutes (its own lifetime) —
    // that must not force a fresh sign-in while the 60-day refresh token is still good, so try
    // a silent refresh first and only lock if THAT also fails.
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
    const removeProvider = setClerkTokenProvider(() => Promise.resolve(getDesktopAccessToken()));
    if (platform.name !== "tauri") {
      void useAuth.getState().verify();
      return removeProvider;
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
      offDeepLink?.();
    };
  }, []);

  useEffect(() => {
    if (platform.name !== "tauri") return;
    let cancelled = false;
    setRestoreUnavailable(false);
    void (async () => {
      let result = await refreshDesktopSession();
      if (cancelled) return;
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
