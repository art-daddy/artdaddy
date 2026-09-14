// Full-screen sign-in gate. Unlike the old non-blocking banner this REPLACES the app, so it is
// the only thing a signed-out user can reach.
import { useState } from "react";

import { startDesktopSignIn } from "../api/desktopAuth";
import { BRAND } from "../brand";
import { platform } from "../platform";
import { useAuth } from "../store/auth";
import { Button } from "./ui";

/** `offline` = we hold no session AND cannot reach the server, so we cannot tell who this is.
 *  A device that DOES hold a session never gets here — it keeps working on local projects. */
export default function SignInScreen({ offline = false }: { offline?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verify = useAuth((s) => s.verify);
  const canSignIn = platform.name === "tauri";

  const signIn = async () => {
    setBusy(true);
    setError(null);
    const result = await startDesktopSignIn();
    // The browser stays open on success; this screen is replaced when the callback lands.
    if (!result.ok) setError("message" in result ? result.message : "Sign-in failed.");
    setBusy(false);
  };

  const retry = async () => {
    setBusy(true);
    setError(null);
    await verify();
    setBusy(false);
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-bg p-8">
      <div className="w-[420px] max-w-full">
        <header className="flex items-center gap-3">
          <img src="/icon.png" alt="" width={52} height={52} className="shrink-0 rounded-[13px]" />
          <div>
            <h1 className="text-2xl font-semibold text-ink">{BRAND.displayName}</h1>
            <p className="mt-0.5 text-sm text-ink-dim">{BRAND.tagline}</p>
          </div>
        </header>

        <section className="mt-6 rounded-lg border border-edge bg-surface p-5">
          {offline ? (
            <>
              <h2 className="text-sm font-semibold text-ink">Can&apos;t reach the server</h2>
              <p className="mt-1 text-sm text-ink-dim">
                Sign in needs a connection. Once you have signed in on this device, your projects
                stay available offline.
              </p>
              <Button variant="primary" className="mt-4 w-full" onClick={() => void retry()} disabled={busy}>
                {busy ? "Retrying…" : "Try again"}
              </Button>
            </>
          ) : canSignIn ? (
            <>
              <h2 className="text-sm font-semibold text-ink">Sign in to continue</h2>
              <p className="mt-1 text-sm text-ink-dim">
                Signing in opens your browser. Create an account there if you don&apos;t have one.
              </p>
              <Button
                variant="primary"
                className="mt-4 w-full"
                onClick={() => void signIn()}
                disabled={busy}
              >
                {busy ? "Opening your browser…" : "Log in or sign up"}
              </Button>
              {busy && (
                <button
                  className="mt-2 w-full text-xs text-ink-dim hover:text-ink"
                  onClick={() => void verify()}
                >
                  Already finished in the browser? Check again
                </button>
              )}
            </>
          ) : (
            <>
              <h2 className="text-sm font-semibold text-ink">Open the desktop app</h2>
              <p className="mt-1 text-sm text-ink-dim">
                Sign-in uses a system-browser handoff that only the desktop app can receive, so it
                cannot be completed here.
              </p>
            </>
          )}
          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        </section>
      </div>
    </div>
  );
}
