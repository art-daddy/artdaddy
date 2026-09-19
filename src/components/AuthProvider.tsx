// Non-blocking auth wrapper. It NEVER hides the editor: it restores a stored desktop-auth
// session in the background, re-locks on a live 401, re-checks when the network returns.
// The AI panel reads useAuth to enable/disable itself. (F11: gate the AI, not the app.)
//
// Clerk's own SDK cannot run inside this webview at all (its origin is neither the verified
// web domain nor a browser Clerk trusts — see api/desktopAuth.ts), so sign-in happens in the
// system browser at the real https://artdaddy.app/auth origin and hands a one-time code back
// here via an `artdaddy://` deep link.
import { useEffect } from "react";

import {
  getAccessToken as getDesktopAccessToken,
  getUserId as getDesktopUserId,
  getUserEmail as getDesktopUserEmail,
  handleDeepLinkCallback,
  hasStoredDesktopSession,
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
  useEffect(() => {
    // A rotated/revoked access token 401s a live call every 30 minutes (its own lifetime) —
    // that must not force a fresh sign-in while the 60-day refresh token is still good, so try
    // a silent refresh first and only lock if THAT also fails.
    const offAuth = onAuthFailure(() => {
      if (platform.name !== "tauri") {
        useAuth.getState().markLocked();
        return;
      }
      void (async () => {
        const restored = await refreshDesktopSession();
        if (restored) void useAuth.getState().verify();
        else useAuth.getState().markLocked();
      })();
    });
    // When the network returns, re-verify so AI re-enables without a manual click.
    const onOnline = () => {
      if (useAuth.getState().status !== "unlocked") void useAuth.getState().verify();
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
    void (async () => {
      // Try a stored session before touching the network gate, so a returning user isn't
      // shown "locked" for the split second before the keychain read resolves.
      await refreshDesktopSession();
      if (cancelled) return;
      // Read AFTER the refresh: a 401 there clears the token, and this is what decides
      // whether an unreachable server locks the app or merely disables AI.
      useAuth.getState().setStoredSession(await hasStoredDesktopSession());
      if (cancelled) return;
      void useAuth.getState().verify();
      identifyUser(getDesktopUserId(), getDesktopUserEmail()); // so an issue names a real person
      // Fired here rather than at startup: before the session restores there is nobody to
      // attribute the launch to, and an unattributed launch answers none of the questions
      // this marker exists for.
      if (getDesktopUserId()) reportLaunchOnce();
    })();
    let offDeepLink: (() => void) | undefined;
    void (async () => {
      const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
      const onUrls = async (urls: string[]) => {
        for (const url of urls) {
          const result = await handleDeepLinkCallback(url);
          if (result.ok) {
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

  // A blank screen while the keychain + /auth/verify resolve, rather than flashing the
  // sign-in screen at someone who is already signed in.
  if (authBypassed()) return <>{children}</>;
  if (status === "checking") return <div className="h-full w-full bg-bg" />;
  if (isSignedOutGate({ status, hasStoredSession }))
    return <SignInScreen offline={status === "offline"} />;
  return <>{children}</>;
}
