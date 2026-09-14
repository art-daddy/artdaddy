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

/** Auth headers for a backend request — empty when Clerk has no session. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  if (!token) return {};
  return { Authorization: ["Bearer", token].join(" ") };
}

/** Check the current Clerk session against the server.
 *  - 200 (or an ungated server) -> true (unlocked)
 *  - 401 -> false (no/invalid session -> prompt sign-in)
 *  - network error / other (e.g. Clerk verification temporarily unavailable
 *    server-side) -> throws (can't currently tell -> offline, not locked). */
export async function verifyAccess(): Promise<boolean> {
  const token = await getAccessToken();
  const res = await fetch(`${apiBase()}/auth/verify`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
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
    const res = await fetch(`${apiBase()}/me`, { headers: await authHeaders() });
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
