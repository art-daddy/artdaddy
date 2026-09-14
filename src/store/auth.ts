// Auth status as a store the app reads. Sign-in is now required to use the app at all, so
// AuthProvider renders a sign-in screen instead of the editor while this is `locked`.
// `offline` is deliberately NOT locked: a device that already holds a session keeps working
// on local projects (timeline / preview / export are entirely local), with AI disabled until
// the server is reachable again. Without that, an unreachable server — or a cold start —
// would lock someone out of work that never needed the network.
import { create } from "zustand";

import { fetchProfile, verifyAccess, type Profile } from "../api/auth";
import { clearUsage, refreshUsage } from "../api/usage";

export type AuthStatus = "checking" | "unlocked" | "locked" | "offline";

interface AuthState {
  /** unlocked = signed in; locked = must sign in; offline = server unreachable. */
  status: AuthStatus;
  /** Identity behind the avatar/profile page. Null until /me answers. */
  profile: Profile | null;
  /** This device holds a stored session it just cannot verify. Only meaningful with
   *  `offline`: it is what separates "you are signed in, the server is down" from
   *  "we have no idea who you are". */
  hasStoredSession: boolean;
  /** Re-verify the current session against the server. */
  verify: () => Promise<void>;
  /** A live 401 (rotated / revoked token) calls this. */
  markLocked: () => void;
  setStoredSession: (has: boolean) => void;
}

export const useAuth = create<AuthState>((set) => ({
  status: "checking",
  profile: null,
  hasStoredSession: false,
  verify: async () => {
    // ONLY the gate check decides the status. A failure loading the profile or the balance is
    // cosmetic and must never read as "the server is unreachable" and lock the app.
    let ok: boolean;
    try {
      ok = await verifyAccess();
    } catch {
      set({ status: "offline" }); // server unreachable — local editing still works
      return;
    }
    set({ status: ok ? "unlocked" : "locked" });
    // The balance belongs to the identity, so every transition that changes who
    // we are must move it — not just the meter's mount. Signing in mid-session
    // left the readout blank until a reload; a revoked token left the previous
    // account's credits on screen. The profile behind the avatar is the same.
    if (!ok) {
      clearUsage();
      set({ profile: null });
      return;
    }
    try {
      void refreshUsage();
      const profile = await fetchProfile();
      if (profile) set({ profile });
    } catch {
      /* identity is known; the decoration around it can wait for the next verify */
    }
  },
  markLocked: () => {
    set({ status: "locked", profile: null, hasStoredSession: false });
    clearUsage();
  },
  setStoredSession: (has) => set({ hasStoredSession: has }),
}));

/** Local/e2e escape hatch. It lives HERE, not in AuthProvider, because it has to mean the same
 *  thing at every door: the UI gate honoured it while the MCP bridge did not, so an agent was
 *  refused by an app that looked signed in. vite.config.ts refuses a production build with it
 *  set, so it cannot reach a release. */
const E2E_AUTH_BYPASS = import.meta.env.VITE_E2E_AUTH_BYPASS === "1";

/** True when the local/e2e bypass is compiled in, so no door should block. */
export function authBypassed(): boolean {
  return E2E_AUTH_BYPASS;
}

/** True when the sign-in screen is showing INSTEAD of the app. AuthProvider renders from this and
 *  the MCP bridge asks it before waiting on a Shell that cannot mount, so the rule has one owner. */
export function isSignedOutGate(
  s: Pick<AuthState, "status" | "hasStoredSession"> = useAuth.getState(),
): boolean {
  if (E2E_AUTH_BYPASS) return false;
  return s.status === "locked" || (s.status === "offline" && !s.hasStoredSession);
}
