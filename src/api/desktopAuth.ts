// Clerk's SDK cannot run inside the Tauri webview at all: its origin is neither the verified
// web domain nor a browser Clerk trusts, so `pk_live_` rejects every request from it outright
// (see the "Production Keys are only allowed for domain" error). The fix is the RFC 8252
// native-app pattern, applied to the whole sign-in (not just OAuth): the system browser runs a
// completely normal Clerk login at the real https://artdaddy.app/auth origin, then a short-lived
// one-time code is handed back to this app via a deep link and traded (with PKCE) for this
// app's OWN access/refresh tokens. This module never talks to Clerk directly.
import { platform } from "../platform";
import { apiBase } from "./config";

const DESKTOP_AUTH_URL = "https://artdaddy.app/auth";
const DEEP_LINK_PREFIX = "artdaddy://auth/callback";

type Outcome = { ok: true } | { ok: false; message: string };

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh RFC 7636 PKCE pair. The verifier never leaves this process until the token exchange. */
export async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: toBase64Url(digest) };
}

/** A fresh, unguessable per-attempt value; the ONLY defense against a stray or CSRF'd callback. */
export function generateState(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

// The one in-flight attempt. A new startDesktopSignIn() call replaces it outright, so an older
// attempt's callback can never complete a newer one and vice versa — only the LAST state wins.
//
// PERSISTED, not just in memory: on Windows the deep link COLD-STARTS the app when it is not
// running, so the callback routinely arrives in a process that never ran startDesktopSignIn().
// An in-memory-only attempt is null exactly then, and sign-in could never complete — which is
// also why it survived unit tests, where one module instance does both halves.
const PENDING_KEY = "artdaddy.desktop_auth_pending";
const PENDING_TTL_MS = 10 * 60 * 1000;

type Pending = { verifier: string; state: string; at: number };

function readPending(): Pending | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Pending;
    if (!p?.verifier || !p?.state) return null;
    // A stale attempt must not linger: the server's code expires in 120s anyway, and an old
    // verifier sitting here is a credential with no purpose.
    if (!(typeof p.at === "number") || Date.now() - p.at > PENDING_TTL_MS) {
      localStorage.removeItem(PENDING_KEY);
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

function writePending(p: Pending | null): void {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* storage disabled — sign-in then only works while the process lives */
  }
}

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

/** The `sub` claim from the current access token, for Sentry correlation only — this reads the
 *  JWT payload without verifying its signature, which is fine here since it is never used for
 *  authorization (the backend still verifies the token itself on every request). */
export function getUserId(): string | null {
  if (!accessToken) return null;
  try {
    const payload = accessToken.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return (JSON.parse(json) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
}

const onDesktop = (): boolean => platform.name === "tauri";

/** Whether this device holds a refresh token. Answers without touching the network, which is
 *  what lets an offline launch tell "signed in, server unreachable" from "not signed in". */
export async function hasStoredDesktopSession(): Promise<boolean> {
  if (!onDesktop()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return Boolean((await invoke("load_refresh_token")) as string | null);
  } catch {
    return false;
  }
}

export async function startDesktopSignIn(): Promise<Outcome> {
  if (!onDesktop()) return { ok: false, message: "Sign-in needs the desktop app." };
  const { verifier, challenge } = await generatePkcePair();
  const state = generateState();
  const url = new URL(DESKTOP_AUTH_URL);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_desktop_auth", { url: url.toString() });
    writePending({ verifier, state, at: Date.now() });
    return { ok: true };
  } catch (e) {
    // Nothing was actually opened — a later callback must not be attributed to this attempt.
    writePending(null);
    return { ok: false, message: e instanceof Error ? e.message : "couldn't open the browser" };
  }
}

type ExchangeResult =
  | { ok: true; tokens: { access_token: string; refresh_token: string } }
  | { ok: false; message: string };

async function exchangeCode(code: string, verifier: string): Promise<ExchangeResult> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/auth/desktop/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier }),
    });
  } catch (e) {
    // Unreachable backend. This threw straight out of the callback before, where nothing was
    // catching it, so sign-in failed with no message and no state change at all.
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `couldn't reach the server at ${apiBase()} (${why})` };
  }
  if (!res.ok) {
    return { ok: false, message: `the server rejected the sign-in code (${res.status})` };
  }
  try {
    return {
      ok: true,
      tokens: (await res.json()) as { access_token: string; refresh_token: string },
    };
  } catch {
    return { ok: false, message: "the server's reply could not be read" };
  }
}

/** Persist a rotated refresh token before trusting the access token that came with it: a pair
 *  this process cannot durably store is not a session it can promise to keep — the previous
 *  refresh token was already invalidated server-side the moment this exchange happened, so a
 *  failed write here leaves NO usable refresh token for the next launch either way. */
async function commitTokens(tokens: {
  access_token: string;
  refresh_token: string;
}): Promise<boolean> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("store_refresh_token", { token: tokens.refresh_token });
  } catch {
    return false;
  }
  accessToken = tokens.access_token;
  return true;
}

/** Handle a deep link the OS delivered to this process. Every rejection path below is load-
 *  bearing: a stray, replayed, or mismatched callback must never reach the backend.
 *  Never throws: its caller is a fire-and-forget OS event handler, so a rejection here is not
 *  reported anywhere — it just leaves the user staring at an unchanged "Log in" button. */
export async function handleDeepLinkCallback(url: string): Promise<Outcome> {
  try {
    return await completeDeepLinkCallback(url);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `sign-in failed: ${why}` };
  }
}

async function completeDeepLinkCallback(url: string): Promise<Outcome> {
  const attempt = readPending();
  // Consume the attempt up front: whatever happens next, THIS callback gets exactly one try —
  // a retry (accidental or malicious replay) must find nothing pending.
  writePending(null);
  if (!attempt) return { ok: false, message: "no sign-in attempt in progress" };
  if (!url.startsWith(DEEP_LINK_PREFIX)) return { ok: false, message: "unrecognized callback" };
  const params = new URL(url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return { ok: false, message: "callback missing code or state" };
  if (state !== attempt.state) return { ok: false, message: "state mismatch" };
  const exchanged = await exchangeCode(code, attempt.verifier);
  if (!exchanged.ok) return { ok: false, message: exchanged.message };
  if (!(await commitTokens(exchanged.tokens))) {
    return { ok: false, message: "signed in, but the session could not be saved" };
  }
  return { ok: true };
}

/** Restore a session from the OS keychain on boot, rotating the refresh token on success.
 *  Only a definitive 401 (the backend's own "invalid or expired refresh token" answer) ever
 *  discards the stored token — a 503, a malformed response, or the request itself failing
 *  (offline) all mean "couldn't tell right now", never "this token is bad", and must leave it
 *  in place for a later retry to use. Never throws: a boot-time caller must be able to move on
 *  to its own next step (verify()) regardless of what went wrong here. */
export async function refreshDesktopSession(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const stored = (await invoke("load_refresh_token")) as string | null;
    if (!stored) return false;
    let res: Response;
    try {
      res = await fetch(`${apiBase()}/auth/desktop/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: stored }),
      });
    } catch {
      return false;
    }
    if (res.status === 401) {
      await invoke("clear_refresh_token", undefined);
      return false;
    }
    if (!res.ok) return false;
    const tokens = (await res.json()) as { access_token: string; refresh_token: string };
    return await commitTokens(tokens);
  } catch {
    return false;
  }
}

/** Sign out. Tells the server to revoke the refresh FAMILY first, because clearing the
 *  keychain alone leaves the token usable for the rest of its 60 days by anyone who lifted
 *  it. The local clear still happens if that call fails — refusing to sign out because the
 *  network is down would be worse — so an offline sign-out is best-effort server-side. */
export async function signOutDesktop(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  let stored: string | null = null;
  try {
    stored = (await invoke("load_refresh_token")) as string | null;
  } catch {
    stored = null;
  }
  if (stored) {
    try {
      await fetch(`${apiBase()}/auth/desktop/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: stored }),
        // Sign-out must not hang on an unreachable server; the local clear below still runs.
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // offline, or the server took too long: fall through and still clear locally
    }
  }
  accessToken = null;
  await invoke("clear_refresh_token", undefined);
}
