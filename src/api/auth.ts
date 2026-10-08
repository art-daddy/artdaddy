// Clerk is the only door: the client installs a live token provider (Clerk's
// getToken) and sends its JWT as `Authorization: Bearer <token>` on every backend
// call. The app re-verifies against the server whenever Clerk's sign-in state
// changes, so a signed-out user (or a revoked session) re-prompts.
import { apiBase, onApiBaseChange } from "./config";

type TokenProvider = () => Promise<string | null>;
let clerkTokenProvider: TokenProvider | null = null;

/** Install Clerk's live token source. Cleanup cannot remove a newer provider. */
export function setClerkTokenProvider(provider: TokenProvider | null): () => void {
  clerkTokenProvider = provider;
  return () => {
    if (clerkTokenProvider === provider) clerkTokenProvider = null;
  };
}

/** The current Clerk JWT, or null when there is no session. */
export async function getAccessToken(): Promise<string | null> {
  const token = await clerkTokenProvider?.();
  return token?.trim() || null;
}

/** True when a token can be had: a beacon sends nothing rather than a guaranteed 401. */
export async function hasSession(): Promise<boolean> {
  return (await getAccessToken()) !== null;
}

type SessionRenewer = (refused: string | null) => Promise<boolean>;
let sessionRenewer: SessionRenewer | null = null;

/** Install how a refused session is renewed (true = a different token is now held). Cleanup
 *  cannot remove a newer renewer. */
export function setSessionRenewer(renewer: SessionRenewer | null): () => void {
  sessionRenewer = renewer;
  return () => {
    if (sessionRenewer === renewer) sessionRenewer = null;
  };
}

type Send = (url: string, init: RequestInit) => Promise<Response>;

/** The one way a request carries the session's token. The server checks it before doing any work,
 *  so a 401 means nothing ran: renew and send the same request once more (UJ-010). */
export async function authedFetch(
  url: string,
  init: RequestInit = {},
  send: Send = (u, i) => fetch(u, i),
): Promise<Response> {
  const attempt = async () => {
    const token = await getAccessToken();
    const headers = {
      ...(init.headers as Record<string, string> | undefined),
      ...(token ? { Authorization: ["Bearer", token].join(" ") } : {}),
    };
    return { token, res: await send(url, { ...init, headers }) };
  };
  const first = await attempt();
  if (first.res.status !== 401 || !sessionRenewer) return first.res;
  if (!(await sessionRenewer(first.token).catch(() => false))) return first.res;
  await first.res.body?.cancel().catch(() => undefined);
  return (await attempt()).res;
}

/** Check the current Clerk session against the server.
 *  - 200 (or an ungated server) -> true (unlocked)
 *  - 401 -> false (no/invalid session -> prompt sign-in)
 *  - network error / other (e.g. Clerk verification temporarily unavailable
 *    server-side) -> throws (can't currently tell -> offline, not locked). */
export async function verifyAccess(): Promise<boolean> {
  const res = await authedFetch(`${apiBase()}/auth/verify`);
  if (res.status === 401) return false;
  if (res.status === 404) return true; // server has no gate endpoint -> open
  if (!res.ok) throw new Error(`verify ${res.status}`);
  return true;
}

export interface Profile {
  user_id: string;
  email: string;
  display_name: string;
  image_url: string;
  metered: boolean;
}

/** Who the signed-in user is. Null means "couldn't tell right now" — a 503 or an
 *  outage must not be rendered as a signed-out user; only /auth/verify decides that. */
export async function fetchProfile(): Promise<Profile | null> {
  try {
    const res = await authedFetch(`${apiBase()}/me`);
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<Profile>;
    return {
      user_id: String(j.user_id ?? ""),
      email: String(j.email ?? ""),
      display_name: String(j.display_name ?? ""),
      image_url: String(j.image_url ?? ""),
      metered: Boolean(j.metered),
    };
  } catch {
    return null;
  }
}

// Mid-session revocation: any 401 from a live backend call re-locks the app. The
// gate subscribes; request wrappers just call notifyAuthFailure() on a 401.
type Listener = () => void;
const listeners = new Set<Listener>();

export function onAuthFailure(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifyAuthFailure(): void {
  for (const fn of [...listeners]) fn();
}

// Pointing the app at a different server means the CURRENT Clerk session's token
// (minted for the old server) means nothing there — re-lock the UI so the app
// re-verifies against the new server rather than silently appearing signed in.
onApiBaseChange(() => {
  notifyAuthFailure();
});
