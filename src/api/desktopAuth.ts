// Clerk's SDK cannot run inside the Tauri webview at all: its origin is neither the verified
// web domain nor a browser Clerk trusts, so `pk_live_` rejects every request from it outright
// (see the "Production Keys are only allowed for domain" error). The fix is the RFC 8252
// native-app pattern, applied to the whole sign-in (not just OAuth): the system browser runs a
// completely normal Clerk login at the real https://artdaddy.app/auth origin, then a short-lived
// one-time code is handed back to this app via a deep link and traded (with PKCE) for this
// app's OWN access/refresh tokens. This module never talks to Clerk directly.
import { platform } from "../platform";
import {
  type AuthReason,
  isAuthId,
  markSignedInBefore,
  newAuthId,
  reportAuthStep,
  resetInstallId,
} from "./authEvents";
import { apiBase } from "./config";
import { SessionRenewalUnavailableError } from "./http";

const DESKTOP_AUTH_URL = "https://artdaddy.app/auth";
const DEEP_LINK_PREFIX = "artdaddy://auth/callback";
const KEYCHAIN_TIMEOUT_MS = 8_000;
// Outlasts the server waking from zero (18-43 s measured). Never retried: the refresh token is
// one-time, and re-sending one the server already rotated revokes the whole session.
const REFRESH_TIMEOUT_MS = 90_000;

/** A failed callback also says why, as the same closed word that is reported (api/authEvents.ts), so the screen can
 *  tell the person in plain words without ever reading the message, which is for developers. */
type Outcome = { ok: true } | { ok: false; message: string; reason?: AuthReason<"callback"> };
export type DesktopSessionRefresh =
  | { status: "refreshed"; hasStoredSession: true }
  | { status: "missing" | "invalid"; hasStoredSession: false }
  | { status: "unavailable"; hasStoredSession: true | null }
  | { status: "superseded"; hasStoredSession: null };

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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

/** `attempt` names this try in what is reported about it (api/authEvents.ts). It is random, not derived from the
 *  state or the verifier, and a record saved by an app that predates it has none. */
type Pending = { verifier: string; state: string; at: number; attempt?: string };

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
/** When the held token arrived, on both of this PC's clocks, and how long it lives. */
let tokenLife: { wallAt: number; monoAt: number; lifetimeMs: number } | null = null;
let desiredRefreshToken: string | null = null;
/** Whether the keychain holds a session, once anything has read or written it; null before. */
let storedSession: boolean | null = null;
let sessionGeneration = 0;
let refreshBlocked = false;
let keychainMutation: Promise<void> = Promise.resolve();

function mutateKeychain<T>(run: () => Promise<T>): Promise<T> {
  const started = keychainMutation.then(run, run);
  keychainMutation = started.then(
    () => undefined,
    () => undefined,
  );
  return started;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** True/false once the keychain has answered: the app can open offline for a stored session while
 *  its renewal waits for the server. */
export function storedSessionKnown(): boolean | null {
  return storedSession;
}

/** Refresh this long before the token actually dies, so a slow request cannot start valid and
 *  arrive expired. */
const EXPIRY_SKEW_MS = 60_000;

/** The access token the NEXT request should carry, refreshing first when the one we hold is
 *  spent.
 *
 *  The token lives ~30 minutes and nothing used to renew it until a real request came back 401.
 *  That made the first prompt after any idle period fail for everyone, every time: the 401
 *  triggered the refresh, the refresh worked, and the request that paid for it was discarded —
 *  "it failed, then the same prompt worked". Concurrent callers join one refresh, because the
 *  stored token is one-time and rotates. */
export async function ensureFreshAccessToken(): Promise<string | null> {
  if (accessToken && !expiringWithin(EXPIRY_SKEW_MS)) return accessToken;
  if (!onDesktop()) return accessToken;
  const result = await refreshDesktopSession();
  // The renewal's own token is the newest the server issued, so it goes even when its life cannot
  // be read; an older one goes only while it still lives.
  if (accessToken && (result.status === "refreshed" || !expiringWithin(0))) return accessToken;
  // A spent token is never sent, and no token reads to the server as "signed out".
  if (result.status === "unavailable") throw new SessionRenewalUnavailableError();
  return null;
}

/** The server refused `used`: true when the token held now is a different one, renewing first
 *  unless a newer token already replaced it. The local clock's verdict does not count here. */
export async function renewAfterRejection(used: string | null): Promise<boolean> {
  if (!onDesktop()) return false;
  if (!accessToken || accessToken === used) await refreshDesktopSession();
  return accessToken !== null && accessToken !== used;
}

/** True when the held token is absent, of unknown life, or dies inside `ms`, timed from its
 *  arrival on whichever of this PC's clocks ran further: the wall clock counts through sleep, the
 *  monotonic one through a clock set back. Never the server's `exp` against this PC's wall clock:
 *  a PC two hours slow kept a 30-minute token for two and a half hours that way (UJ-010). */
function expiringWithin(ms: number): boolean {
  if (!accessToken || !tokenLife) return true;
  const elapsed = Math.max(Date.now() - tokenLife.wallAt, performance.now() - tokenLife.monoAt);
  return tokenLife.lifetimeMs - elapsed <= ms;
}

/** What the server said the token lives, else its own `exp - iat` (one clock, so no skew). */
function lifetimeMs(tokens: { access_token: string; expires_in?: unknown }): number | null {
  const stated = Number(tokens.expires_in);
  if (Number.isFinite(stated) && stated > 0) return stated * 1000;
  const { iat, exp } = claimsOf(tokens.access_token);
  return typeof iat === "number" && typeof exp === "number" && exp > iat
    ? (exp - iat) * 1000
    : null;
}

/** Claims from the current access token, for Sentry correlation and expiry only — this reads the
 *  JWT payload without verifying its signature, which is fine here since it is never used for
 *  authorization (the backend still verifies the token itself on every request). */
function claims(): { sub?: string; email?: string; exp?: number; iat?: number } {
  return accessToken ? claimsOf(accessToken) : {};
}

function claimsOf(token: string): { sub?: string; email?: string; exp?: number; iat?: number } {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as { sub?: string; email?: string; exp?: number; iat?: number };
  } catch {
    return {};
  }
}

export function getUserId(): string | null {
  return claims().sub ?? null;
}

/** Empty for a token minted before the server carried the claim; it appears on the next refresh. */
export function getUserEmail(): string | null {
  return claims().email ?? null;
}

const onDesktop = (): boolean => platform.name === "tauri";

export async function startDesktopSignIn(): Promise<Outcome> {
  if (!onDesktop()) return { ok: false, message: "Sign-in needs the desktop app." };
  // This is the explicit way out of a signed-out state. It invalidates any old refresh result
  // while the browser owns the new authentication attempt.
  sessionGeneration += 1;
  const { verifier, challenge } = await generatePkcePair();
  const state = generateState();
  // Names this try for what is reported about it. The sign-in page reads it back from the address so that the
  // page's steps and the app's steps of one try can be followed together. It is random and secret-free.
  const attempt = newAuthId();
  const url = new URL(DESKTOP_AUTH_URL);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("attempt", attempt);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_desktop_auth", { url: url.toString() });
    refreshBlocked = false;
    writePending({ verifier, state, at: Date.now(), attempt });
    reportAuthStep("start", { ok: true, attempt });
    return { ok: true };
  } catch (e) {
    // Nothing was actually opened — a later callback must not be attributed to this attempt.
    writePending(null);
    reportAuthStep("start", { ok: false, reason: "open_failed", attempt });
    return { ok: false, message: e instanceof Error ? e.message : "couldn't open the browser" };
  }
}

type ExchangeFailure = Extract<
  AuthReason<"callback">,
  "exchange_network" | "exchange_rejected" | "exchange_server" | "exchange_unreadable"
>;
type ExchangeResult =
  { ok: true; tokens: TokenReply } | { ok: false; message: string; reason: ExchangeFailure };

type TokenReply = { access_token: string; refresh_token: string; expires_in?: number };

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
    return {
      ok: false,
      message: `couldn't reach the server at ${apiBase()} (${why})`,
      reason: "exchange_network",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      message: `the server rejected the sign-in code (${res.status})`,
      reason: res.status >= 500 ? "exchange_server" : "exchange_rejected",
    };
  }
  try {
    return {
      ok: true,
      tokens: (await res.json()) as TokenReply,
    };
  } catch {
    return {
      ok: false,
      message: "the server's reply could not be read",
      reason: "exchange_unreadable",
    };
  }
}

/** Persist a rotated refresh token before trusting the access token that came with it: a pair
 *  this process cannot durably store is not a session it can promise to keep — the previous
 *  refresh token was already invalidated server-side the moment this exchange happened, so a
 *  failed write here leaves NO usable refresh token for the next launch either way. */
async function commitTokens(
  tokens: TokenReply,
  expectedGeneration = sessionGeneration,
): Promise<boolean> {
  return mutateKeychain(async () => {
    if (sessionGeneration !== expectedGeneration) return false;
    desiredRefreshToken = tokens.refresh_token;
    const { invoke } = await import("@tauri-apps/api/core");
    const storing = invoke("store_refresh_token", { token: tokens.refresh_token });
    try {
      await withTimeout(storing, KEYCHAIN_TIMEOUT_MS);
    } catch {
      // The native call cannot be cancelled. If it completes late, reconcile the keychain with
      // the newest desired session: clear after sign-out, or restore a newer sign-in token that
      // this stale write overwrote.
      void storing
        .then(() =>
          mutateKeychain(async () => {
            const current = await withTimeout(
              invoke("load_refresh_token") as Promise<string | null>,
              KEYCHAIN_TIMEOUT_MS,
            );
            if (current !== tokens.refresh_token) return;
            if (desiredRefreshToken) {
              if (desiredRefreshToken !== current) {
                await withTimeout(
                  invoke("store_refresh_token", { token: desiredRefreshToken }),
                  KEYCHAIN_TIMEOUT_MS,
                );
              }
            } else {
              await withTimeout(invoke("clear_refresh_token", undefined), KEYCHAIN_TIMEOUT_MS);
            }
          }),
        )
        .catch(() => undefined);
      return false;
    }
    // signOutDesktop increments synchronously before joining this queue. If it started while
    // the keychain write was in flight, it owns the final state and will clear this token next.
    if (sessionGeneration !== expectedGeneration) return false;
    accessToken = tokens.access_token;
    storedSession = true;
    const life = lifetimeMs(tokens);
    tokenLife =
      life === null ? null : { wallAt: Date.now(), monoAt: performance.now(), lifetimeMs: life };
    return true;
  });
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
    reportAuthStep("callback", { ok: false, reason: "error" });
    return { ok: false, message: `sign-in failed: ${why}`, reason: "error" };
  }
}

async function completeDeepLinkCallback(url: string): Promise<Outcome> {
  const expectedGeneration = sessionGeneration;
  const attempt = readPending();
  // Consume the attempt up front: whatever happens next, THIS callback gets exactly one try —
  // a retry (accidental or malicious replay) must find nothing pending.
  writePending(null);
  // How long the try had been going, and its id, for the one report every way out of here makes. Only the
  // reason is reported, never the message: a message can carry an address or a reply from the server.
  // The sign-in page passes its own attempt id back in the link, so a tab that finishes AFTER the person pressed
  // "Log in" a second time is reported as the attempt it belongs to and not as the newer one.
  const linkedAttempt = ((): string | undefined => {
    try {
      const linked = new URL(url).searchParams.get("attempt");
      return isAuthId(linked) ? linked : undefined;
    } catch {
      return undefined;
    }
  })();
  const elapsed = (): number | undefined => (attempt ? Date.now() - attempt.at : undefined);
  const fail = (reason: AuthReason<"callback">, message: string): Outcome => {
    reportAuthStep("callback", {
      ok: false,
      reason,
      attempt: linkedAttempt ?? attempt?.attempt,
      ms: elapsed(),
    });
    return { ok: false, message, reason };
  };
  if (!attempt) return fail("no_attempt", "no sign-in attempt in progress");
  if (!url.startsWith(DEEP_LINK_PREFIX)) return fail("unrecognized", "unrecognized callback");
  const params = new URL(url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return fail("missing_params", "callback missing code or state");
  if (state !== attempt.state) return fail("state_mismatch", "state mismatch");
  const exchanged = await exchangeCode(code, attempt.verifier);
  if (!exchanged.ok) return fail(exchanged.reason, exchanged.message);
  if (sessionGeneration !== expectedGeneration || refreshBlocked) {
    return fail("cancelled", "sign-in was cancelled");
  }
  // A deliberate sign-in is a new session authority. It supersedes any stale boot refresh
  // before that refresh can clear or commit against the newly authenticated identity.
  const signInGeneration = ++sessionGeneration;
  if (!(await commitTokens(exchanged.tokens, signInGeneration))) {
    return fail("not_saved", "signed in, but the session could not be saved");
  }
  markSignedInBefore();
  reportAuthStep("callback", {
    ok: true,
    attempt: linkedAttempt ?? attempt.attempt,
    ms: elapsed(),
  });
  return { ok: true };
}

/** The one native read of the saved session, kept apart from its caller's patience.
 *
 *  On macOS the read blocks behind a permission dialog until a person answers it. After an update
 *  that is every launch: the new build is a different code identity to the keychain, and the answer
 *  can take longer than KEYCHAIN_TIMEOUT_MS. The call cannot be cancelled, so asking again opens a
 *  SECOND dialog, and an "Allow" that is not "Always Allow" answers only the request it was shown
 *  for. So at most one read is open per session, a later attempt joins it, and an answer that
 *  arrives after an attempt stopped waiting is kept for the next attempt, which uses it once. */
type StoredRead = { generation: number; promise: Promise<string | null>; abandoned: boolean };
let storedRead: StoredRead | null = null;
let lateAnswer: { generation: number; token: string | null } | null = null;

function startStoredRead(
  invoke: (command: string) => Promise<unknown>,
  generation: number,
): StoredRead {
  let read!: StoredRead;
  const promise = Promise.resolve(invoke("load_refresh_token") as Promise<string | null>).then(
    (token) => {
      if (storedRead === read) storedRead = null;
      // Nobody is waiting any more. Only the session this was asked for may use the answer.
      if (read.abandoned && sessionGeneration === generation) lateAnswer = { generation, token };
      return token;
    },
    (error: unknown) => {
      if (storedRead === read) storedRead = null;
      throw error;
    },
  );
  read = { generation, promise, abandoned: false };
  return read;
}

function waitForStoredToken(
  invoke: (command: string) => Promise<unknown>,
  generation: number,
): Promise<string | null> {
  if (lateAnswer && lateAnswer.generation !== generation) lateAnswer = null;
  if (lateAnswer) {
    const { token } = lateAnswer;
    lateAnswer = null;
    return Promise.resolve(token);
  }
  const read =
    storedRead?.generation === generation ? storedRead : startStoredRead(invoke, generation);
  storedRead = read;
  read.abandoned = false;
  return new Promise<string | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      read.abandoned = true;
      reject(new Error("timed out"));
    }, KEYCHAIN_TIMEOUT_MS);
    void read.promise.then(
      (token) => {
        clearTimeout(timer);
        resolve(token);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let refreshInFlight: { generation: number; promise: Promise<DesktopSessionRefresh> } | null = null;

/** Restore a session from the OS keychain, rotating the refresh token on success.
 *
 * Refresh tokens are one-time and rotate on every success, so every caller MUST join the same
 * in-flight request. Otherwise two simultaneous 401s submit the same token: one rotation wins,
 * the other receives 401 and clears the newly valid session.
 *
 * Only a definitive 401 discards the stored token. A keychain delay, 503, malformed response,
 * timeout, or dropped connection is `unavailable`, never "signed out". */
export function refreshDesktopSession(): Promise<DesktopSessionRefresh> {
  if (refreshBlocked) {
    return Promise.resolve({ status: "missing", hasStoredSession: false });
  }
  if (refreshInFlight?.generation === sessionGeneration) return refreshInFlight.promise;
  const generation = sessionGeneration;
  const started = refreshDesktopSessionOnce(generation);
  const entry = { generation, promise: started };
  refreshInFlight = entry;
  void started.finally(() => {
    if (refreshInFlight === entry) refreshInFlight = null;
  });
  return started;
}

async function refreshDesktopSessionOnce(
  expectedGeneration: number,
): Promise<DesktopSessionRefresh> {
  let hasStoredSession: true | null = null;
  const superseded = (): DesktopSessionRefresh => ({
    status: "superseded",
    hasStoredSession: null,
  });
  // A saved session that could not be renewed just now. The cause is reported as a word (never a message), and
  // only when this is still the current session's own refresh: one overtaken by a newer sign-in failed nothing.
  const unavailable = (cause: AuthReason<"refresh">): DesktopSessionRefresh => {
    if (sessionGeneration !== expectedGeneration) return superseded();
    reportAuthStep("refresh", { ok: false, reason: cause });
    return { status: "unavailable", hasStoredSession };
  };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const stored = await waitForStoredToken(invoke, expectedGeneration);
    if (sessionGeneration !== expectedGeneration) return superseded();
    storedSession = Boolean(stored);
    if (!stored) {
      desiredRefreshToken = null;
      return { status: "missing", hasStoredSession: false };
    }
    desiredRefreshToken = stored;
    hasStoredSession = true;
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${apiBase()}/auth/desktop/refresh`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: stored }),
        },
        REFRESH_TIMEOUT_MS,
      );
    } catch (e) {
      // The 90 s allowance ran out (an abort), or the connection never held.
      return unavailable(e instanceof Error && e.name === "AbortError" ? "timeout" : "network");
    }
    if (sessionGeneration !== expectedGeneration) return superseded();
    if (res.status === 401) {
      const cleared = await mutateKeychain(async () => {
        if (sessionGeneration !== expectedGeneration) return false;
        const current = await withTimeout(
          invoke("load_refresh_token") as Promise<string | null>,
          KEYCHAIN_TIMEOUT_MS,
        );
        if (current !== stored) return false;
        await withTimeout(invoke("clear_refresh_token", undefined), KEYCHAIN_TIMEOUT_MS);
        accessToken = null;
        tokenLife = null;
        desiredRefreshToken = null;
        storedSession = false;
        return true;
      });
      if (cleared) {
        reportAuthStep("refresh", { ok: false, reason: "rejected" });
        return { status: "invalid", hasStoredSession: false };
      }
      return unavailable("keychain");
    }
    if (!res.ok) return unavailable("server_error");
    const tokens = (await res.json()) as TokenReply;
    if (sessionGeneration !== expectedGeneration) return superseded();
    if (await commitTokens(tokens, expectedGeneration)) {
      // Whoever's session this is has signed in on this machine before, which an app that predates the flag
      // never recorded.
      markSignedInBefore();
      return { status: "refreshed", hasStoredSession: true };
    }
    return unavailable("not_saved");
  } catch {
    // Before a saved token was read, this is the keychain (it did not answer, or refused); after, it is a reply
    // that could not be read or something the code did not expect.
    return unavailable(hasStoredSession === null ? "keychain" : "error");
  }
}

/** Sign out. Tells the server to revoke the refresh FAMILY first, because clearing the
 *  keychain alone leaves the token usable for the rest of its 60 days by anyone who lifted
 *  it. The local clear still happens if that call fails — refusing to sign out because the
 *  network is down would be worse — so an offline sign-out is best-effort server-side. */
export async function signOutDesktop(): Promise<void> {
  // Supersede any refresh/code exchange before it can commit, then serialize the clear after a
  // keychain write that may already be in flight. Sign-out is the final session mutation.
  refreshBlocked = true;
  sessionGeneration += 1;
  desiredRefreshToken = null;
  lateAnswer = null;
  storedSession = false;
  writePending(null);
  // A new person at this machine must not inherit the previous one's install id.
  resetInstallId();
  const stored = await mutateKeychain(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    let stored: string | null = null;
    try {
      stored = await withTimeout(
        invoke("load_refresh_token") as Promise<string | null>,
        KEYCHAIN_TIMEOUT_MS,
      );
    } catch {
      stored = null;
    }
    accessToken = null;
    tokenLife = null;
    try {
      await withTimeout(invoke("clear_refresh_token", undefined), KEYCHAIN_TIMEOUT_MS);
    } catch {
      // The in-memory session is still gone and the native delete may complete late.
    }
    return stored;
  });
  if (!stored) return;
  try {
    await fetchWithTimeout(
      `${apiBase()}/auth/desktop/revoke`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: stored }),
      },
      5_000,
    );
  } catch {
    // The local session is already gone; an offline revoke remains best-effort.
  }
}
