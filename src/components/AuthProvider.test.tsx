import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const removeTokenProvider = vi.fn();
  return {
    verify: vi.fn(),
    markLocked: vi.fn(),
    markOffline: vi.fn(),
    removeTokenProvider,
    setClerkTokenProvider: vi.fn(() => removeTokenProvider),
    identifyUser: vi.fn(),
    authStatus: "checking",
    authFailureCb: null as (() => void) | null,
    offAuth: vi.fn(),
    userId: null as string | null,
    userEmail: null as string | null,
    refreshDesktopSession: vi.fn(async () => ({
      status: "missing" as const,
      hasStoredSession: false as const,
    })),
    handleDeepLinkCallback: vi.fn(async () => ({ ok: true }) as { ok: boolean }),
    getAccessToken: vi.fn(() => null as string | null),
    getUserId: vi.fn(() => mocks.userId),
    getUserEmail: vi.fn(() => mocks.userEmail),
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
    markOffline: mocks.markOffline,
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
  getUserEmail: mocks.getUserEmail,
  refreshDesktopSession: mocks.refreshDesktopSession,
  handleDeepLinkCallback: mocks.handleDeepLinkCallback,
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
  vi.useRealTimers();
  mocks.authFailureCb = null;
  mocks.authStatus = "checking";
  mocks.hasStoredSession = false;
  mocks.userId = null;
  mocks.onOpenUrlCb = null;
  mocks.startUrls = null;
  mocks.platformName = "tauri";
  mocks.refreshDesktopSession.mockReset().mockResolvedValue({
    status: "missing",
    hasStoredSession: false,
  });
  mocks.handleDeepLinkCallback.mockReset().mockResolvedValue({ ok: true });
  mocks.getAccessToken.mockReset().mockReturnValue(null);
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

  it("shows a visible startup state rather than a black screen while checking", () => {
    mocks.authStatus = "checking";
    render(
      <AuthProvider>
        <span>editor</span>
      </AuthProvider>,
    );
    expect(screen.queryByText("editor")).not.toBeInTheDocument();
    expect(screen.queryByText(/sign in to continue/i)).not.toBeInTheDocument();
    expect(screen.getByText(/starting artdaddy/i)).toBeInTheDocument();
    expect(screen.getByText(/restoring your saved session/i)).toBeInTheDocument();
  });

  it("offers a retry when the OS keychain cannot be read", async () => {
    mocks.refreshDesktopSession.mockResolvedValue({
      status: "unavailable",
      hasStoredSession: null,
    });
    render(
      <AuthProvider>
        <span>editor</span>
      </AuthProvider>,
    );

    expect(await screen.findByText(/couldn't read your saved session/i)).toBeInTheDocument();
    screen.getByRole("button", { name: "Retry" }).click();
    await waitFor(() => expect(mocks.refreshDesktopSession).toHaveBeenCalledTimes(2));
    expect(mocks.markLocked).not.toHaveBeenCalled();
    screen.getByRole("button", { name: /sign in again/i }).click();
    expect(mocks.markLocked).toHaveBeenCalledOnce();
  });

  it("offers recovery controls even when the OS keychain call never settles", async () => {
    vi.useFakeTimers();
    mocks.refreshDesktopSession.mockReturnValue(new Promise<never>(() => undefined));
    render(
      <AuthProvider>
        <span>editor</span>
      </AuthProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByText(/couldn't read your saved session/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in again/i })).toBeInTheDocument();
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
    mocks.refreshDesktopSession.mockResolvedValue({
      status: "refreshed",
      hasStoredSession: true,
    });
    mocks.userId = "user_abc123";
    mocks.userEmail = "tester@example.com";
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    // The email is the point: an id alone cannot be traced back to the person who filed a
    // report, which is what made the first real crash take three days to attribute.
    await waitFor(() =>
      expect(mocks.identifyUser).toHaveBeenLastCalledWith("user_abc123", "tester@example.com"),
    );
  });

  it("identifies with null when nothing is stored (no lingering identity from a prior run)", async () => {
    mocks.refreshDesktopSession.mockResolvedValue({
      status: "missing",
      hasStoredSession: false,
    });
    mocks.userId = null;
    mocks.userEmail = null;
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.identifyUser).toHaveBeenLastCalledWith(null, null));
  });

  it("refreshes before re-verifying when the network returns while NOT unlocked", async () => {
    mocks.authStatus = "offline";
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.refreshDesktopSession).toHaveBeenCalled());
    mocks.verify.mockClear();
    mocks.refreshDesktopSession.mockClear();
    mocks.refreshDesktopSession.mockResolvedValue({
      status: "refreshed",
      hasStoredSession: true,
    });
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(mocks.refreshDesktopSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.verify).toHaveBeenCalledOnce());
  });

  it("does NOT refresh or re-verify on 'online' when already unlocked", async () => {
    mocks.authStatus = "unlocked";
    render(
      <AuthProvider>
        <span>x</span>
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.refreshDesktopSession).toHaveBeenCalled());
    mocks.verify.mockClear();
    mocks.refreshDesktopSession.mockClear();
    window.dispatchEvent(new Event("online"));
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.refreshDesktopSession).not.toHaveBeenCalled();
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
    expect(mocks.setStoredSession).toHaveBeenCalledWith(true);
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
    mocks.refreshDesktopSession.mockResolvedValue({
      status: "invalid",
      hasStoredSession: false,
    });
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
    mocks.refreshDesktopSession.mockResolvedValue({
      status: "refreshed",
      hasStoredSession: true,
    });
    mocks.authFailureCb?.();
    await waitFor(() => expect(mocks.verify).toHaveBeenCalledOnce());
    expect(mocks.markLocked).not.toHaveBeenCalled();
  });

  it("keeps local editing open when refresh infrastructure fails transiently", async () => {
    mocks.authStatus = "unlocked";
    render(
      <AuthProvider>
        <span>editor</span>
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.verify).toHaveBeenCalled());
    mocks.markLocked.mockClear();
    mocks.markOffline.mockClear();
    mocks.refreshDesktopSession.mockResolvedValue({
      status: "unavailable",
      hasStoredSession: true,
    });

    mocks.authFailureCb?.();

    await waitFor(() => expect(mocks.markOffline).toHaveBeenCalledOnce());
    expect(mocks.markLocked).not.toHaveBeenCalled();
    expect(screen.getByText("editor")).toBeInTheDocument();
  });

  it("ignores a refresh result superseded by a newer sign-in or explicit sign-out", async () => {
    mocks.authStatus = "unlocked";
    render(
      <AuthProvider>
        <span>editor</span>
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.verify).toHaveBeenCalled());
    mocks.markLocked.mockClear();
    mocks.markOffline.mockClear();
    mocks.setStoredSession.mockClear();
    mocks.refreshDesktopSession.mockClear();
    mocks.refreshDesktopSession.mockResolvedValue({
      status: "superseded",
      hasStoredSession: null,
    });

    mocks.authFailureCb?.();

    await waitFor(() => expect(mocks.refreshDesktopSession).toHaveBeenCalledOnce());
    expect(mocks.markLocked).not.toHaveBeenCalled();
    expect(mocks.markOffline).not.toHaveBeenCalled();
    expect(mocks.setStoredSession).not.toHaveBeenCalled();
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
