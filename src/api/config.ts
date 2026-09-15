// Which backend the app talks to. VITE_API_BASE_URL is frozen into the bundle at
// build time, so it can only ever be the DEFAULT: a shipped desktop app has no .env
// and its server may move between alpha builds. The stored override wins and is read
// at call time — never captured at import — so a change takes effect on the next
// request without a rebuild.
const STORAGE_KEY = "artdaddy.api_base";

/** Trailing slashes off, so `${base}/path` can never produce a double slash. */
function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

// Not a secret — the build inlines it, so it is readable from any installed app. Committing it
// means a build with no .env still reaches a real server, and every route there requires a
// session, so an unsigned caller gets 401 rather than anything we pay for.
const PRODUCTION_API =
  "https://akaru-server.ambitioustree-4d826744.centralindia.azurecontainerapps.io";

const BUILD_DEFAULT = normalize(import.meta.env.VITE_API_BASE_URL ?? PRODUCTION_API);

function readStored(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && v.trim() ? normalize(v) : null;
  } catch {
    return null; // non-DOM (tests) / storage disabled
  }
}

let override: string | null = readStored();
const listeners = new Set<(base: string) => void>();

/** The backend origin for the NEXT request. Call it per request — do not cache it. */
export function apiBase(): string {
  return override ?? BUILD_DEFAULT;
}

/** What the build shipped, for "reset to default" and for showing the user. */
export function defaultApiBase(): string {
  return BUILD_DEFAULT;
}

export function isApiBaseOverridden(): boolean {
  return override !== null;
}

/** Reject anything that isn't an absolute http(s) origin. A bare host or a typo'd
 *  scheme would otherwise resolve against the page and fail as a confusing 404. */
export function validateApiBase(url: string): string | null {
  const raw = url.trim();
  if (!raw) return "Enter a server address.";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "That isn't a valid address — include http:// or https://";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "The address must start with http:// or https://";
  }
  return null;
}

/** Point the app at a different backend (null restores the build default).
 *  Notifies subscribers so state minted by the OLD server can be discarded. */
export function setApiBase(url: string | null): void {
  if (url !== null) {
    const problem = validateApiBase(url);
    if (problem) throw new Error(problem);
  }
  const next = url === null ? null : normalize(url);
  if (next === override) return;
  override = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore storage errors (private mode / non-DOM) */
  }
  for (const fn of listeners) fn(apiBase());
}

/** Subscribe to server changes. The auth module uses this to drop a token minted by
 *  a different server — it is meaningless there, and must never be sent onward. */
export function onApiBaseChange(fn: (base: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
