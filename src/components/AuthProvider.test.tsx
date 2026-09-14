import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const removeTokenProvider = vi.fn();
  return {
    verify: vi.fn(),
    markLocked: vi.fn(),
    removeTokenProvider,
    setClerkTokenProvider: vi.fn(() => removeTokenProvider),
    identifyUser: vi.fn(),
    authStatus: "checking",
    authFailureCb: null as (() => void) | null,
    offAuth: vi.fn(),
    userId: null as string | null,
    refreshDesktopSession: vi.fn(async () => false),
    handleDeepLinkCallback: vi.fn(async () => ({ ok: true }) as { ok: boolean }),
    getAccessToken: vi.fn(() => null as string | null),
    getUserId: vi.fn(() => mocks.userId),
    hasStoredDesktopSession: vi.fn(async () => false),
    setStoredSession: vi.fn(),
    hasStoredSession: false,
    startDesktopSignIn: vi.fn(async () => ({ ok: true }) as { ok: boolean }),
    onOpenUrlCb: null as ((urls: string[]) => void) | null,
    offOpenUrl: vi.fn(),
    startUrls: null as string[] | null,
    platformName: "tauri" as "tauri" | "web",
  };
});

vi.mock("../platform", () => ({
  get platform() {
    return { name: mocks.platformName };
  },
}));

vi.mock("../store/auth", async () => {
  // The gate predicate comes from the REAL module: a copy here could agree with a broken
  // implementation, which is the drift this shared helper exists to prevent.
  const actual = await vi.importActual<typeof import("../store/auth")>("../store/auth");
  const state = () => ({
    verify: mocks.verify,
    markLocked: mocks.markLocked,
    setStoredSession: mocks.setStoredSession,
    status: mocks.authStatus,
    hasStoredSession: mocks.hasStoredSession,
    profile: null,
  });
  // The gate reads this as a HOOK (useAuth(selector)), not only via getState().
  const useAuth = (selector?: (s: ReturnType<typeof state>) => unknown) =>
    selector ? selector(state()) : state();
  useAuth.getState = state;
  return { useAuth, isSignedOutGate: actual.isSignedOutGate, authBypassed: actual.authBypassed };
});

vi.mock("../api/auth", () => ({
  setClerkTokenProvider: mocks.setClerkTokenProvider,
  onAuthFailure: (cb: () => void) => {
    mocks.authFailureCb = cb;
    return mocks.offAuth;
  },
}));

vi.mock("../api/desktopAuth", () => ({
  getAccessToken: mocks.getAccessToken,
  getUserId: mocks.getUserId,
  refreshDesktopSession: mocks.refreshDesktopSession,
  handleDeepLinkCallback: mocks.handleDeepLinkCallback,
  hasStoredDesktopSession: mocks.hasStoredDesktopSession,
  startDesktopSignIn: mocks.startDesktopSignIn,
}));

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: async () => mocks.startUrls,
  onOpenUrl: async (cb: (urls: string[]) => void) => {
    mocks.onOpenUrlCb = cb;
    return mocks.offOpenUrl;
  },
}));

vi.mock("../observability/sentry", () => ({ identifyUser: mocks.identifyUser }));

import AuthProvider from "./AuthProvider";

afterEach(() => {
  mocks.authFailureCb = null;
  mocks.authStatus = "checking";
  mocks.hasStoredSession = false;
  mocks.userId = null;
  mocks.onOpenUrlCb = null;
  mocks.startUrls = null;
  mocks.platformName = "tauri";
  mocks.refreshDesktopSession.mockReset().mockResolvedValue(false);
  mocks.handleDeepLinkCallback.mockReset().mockResolvedValue({ ok: true });
  mocks.getAccessToken.mockReset().mockReturnValue(null);
  mocks.hasStoredDesktopSession.mockReset().mockResolvedValue(false);
  vi.clearAllMocks();
});

describe("AuthProvider", () => {
  it("verifies the token on mount and shows the app once unlocked", async () => {
    mocks.authStatus = "unlocked";
    render(
      <AuthProvider>
        <span>editor</span>
      </AuthProvider>,
    );
    expect(mocks.setClerkTokenProvider).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.verify).toHaveBeenCalledOnce());
    expect(screen.getByText("editor")).toBeInTheDocument();
  });

  it("hides the app behind the sign-in screen when locked", () => {
    mocks.authStatus = "locked";
    render(
      <AuthProvider>
        <span>editor</span>
      </AuthProvider>,
    );
    expect(screen.queryByText("editor")).not.toBeInTheDocument();
    expect(screen.getByText(/sign in to continue/i)).toBeInTheDocument();
  });

  it("shows neither the app nor a sign-in prompt while still checking", () => {
    mocks.authStatus = "checking";
    render(
      <AuthProvider>
        <span>editor</span>
      </AuthProvider>,
    );
    // Flashing "sign in" at someone who IS signed in is the bug this prevents.
    expect(screen.queryByText("editor")).not.toBeInTheDocument();
    expect(screen.queryByText(/sign in to continue/i)).not.toBeInTheDocument();
  });

  it("keeps the editor usable offline when this device already holds a session", () => {
    // Timeline, preview and export are entirely local. An unreachable server — or an
    // Azure cold start — must not lock someone out of work that never needed the network.
    mocks.authStatus = "offline";
    mocks.hasStoredSession = true;
    render(
      <AuthProvider>
        <span>editor</span>
      </AuthProvider>,
    );
    expect(screen.getByText("editor")).toBeInTheDocument();
  });

  it("locks when offline with NO stored session, because it cannot tell who this is", () => {
    mocks.authStatus = "offline";
    mocks.hasStoredSession = false;
    render(
      <AuthProvider>
        <span>editor</span>
      </AuthProvider>,
    );
    expect(screen.queryByText("editor")).not.toBeInTheDocument();
    expect(screen.getByText(/can't reach the server/i)).toBeInTheDocument();
  });

  it("identifies the Sentry user once a stored desktop-auth session restores", async () => {
    mocks.refreshDesktopSession.mockResolvedValue(true);
    mocks.userId = "user_abc123";
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.identifyUser).toHaveBeenLastCalledWith("user_abc123"));
  });

  it("identifies with null when nothing is stored (no lingering identity from a prior run)", async () => {
    mocks.refreshDesktopSession.mockResolvedValue(false);
    mocks.userId = null;
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.identifyUser).toHaveBeenLastCalledWith(null));
  });

  it("re-verifies when the network returns ('online') while NOT unlocked", () => {
    mocks.authStatus = "offline";
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    mocks.verify.mockClear();
    window.dispatchEvent(new Event("online"));
    expect(mocks.verify).toHaveBeenCalledOnce();
  });

  it("does NOT re-verify on 'online' when already unlocked", () => {
    mocks.authStatus = "unlocked";
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    mocks.verify.mockClear();
    window.dispatchEvent(new Event("online"));
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("re-verifies the moment a deep-link callback completes sign-in (no reload needed)", async () => {
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.onOpenUrlCb).not.toBeNull());
    mocks.verify.mockClear();
    mocks.handleDeepLinkCallback.mockResolvedValue({ ok: true });
    await mocks.onOpenUrlCb!(["artdaddy://auth/callback?code=x&state=y"]);
    expect(mocks.verify).toHaveBeenCalledOnce();
  });

  it("does NOT re-verify when the deep-link callback fails (bad state, expired code, etc.)", async () => {
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.onOpenUrlCb).not.toBeNull());
    mocks.verify.mockClear();
    mocks.handleDeepLinkCallback.mockResolvedValue({ ok: false });
    await mocks.onOpenUrlCb!(["artdaddy://auth/callback?code=bad&state=y"]);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("skips the desktop-auth restore/deep-link plumbing entirely off the desktop shell", async () => {
    mocks.platformName = "web";
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.verify).toHaveBeenCalledOnce());
    expect(mocks.refreshDesktopSession).not.toHaveBeenCalled();
  });

  it("locks the AI on a live auth failure ONLY once a silent refresh also fails, and removes every listener on unmount", async () => {
    mocks.refreshDesktopSession.mockResolvedValue(false); // the 60-day refresh token is also dead
    const { unmount } = render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.verify).toHaveBeenCalled()); // let the boot-time restore settle first
    mocks.refreshDesktopSession.mockClear();
    mocks.markLocked.mockClear();
    mocks.authFailureCb?.();
    await waitFor(() => expect(mocks.markLocked).toHaveBeenCalledOnce());
    expect(mocks.refreshDesktopSession).toHaveBeenCalledOnce();
    unmount();
    expect(mocks.offAuth).toHaveBeenCalledOnce();
    expect(mocks.removeTokenProvider).toHaveBeenCalledOnce();
    mocks.verify.mockClear();
    window.dispatchEvent(new Event("online")); // the online listener was removed -> no re-verify
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("silently refreshes instead of locking when a live 401 hits but the 60-day refresh token is still good", async () => {
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.verify).toHaveBeenCalled()); // let the boot-time restore settle first
    mocks.verify.mockClear();
    mocks.markLocked.mockClear();
    mocks.refreshDesktopSession.mockResolvedValue(true);
    mocks.authFailureCb?.();
    await waitFor(() => expect(mocks.verify).toHaveBeenCalledOnce());
    expect(mocks.markLocked).not.toHaveBeenCalled();
  });

  it("locks immediately off the desktop shell, without attempting a refresh that has nowhere to read a token from", () => {
    mocks.platformName = "web";
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    mocks.authFailureCb?.();
    expect(mocks.markLocked).toHaveBeenCalledOnce();
    expect(mocks.refreshDesktopSession).not.toHaveBeenCalled();
  });
});
