import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signOutDesktop: vi.fn(async () => {}),
  markLocked: vi.fn(),
  verify: vi.fn(),
  refreshUsage: vi.fn(),
  usage: { metered: true, used: 40, limit: 100, remaining: 60, over: false },
  auth: {
    status: "unlocked" as "unlocked" | "offline",
    profile: {
      user_id: "user_abc",
      email: "alice@example.com",
      display_name: "Alice Example",
      image_url: "",
      metered: true,
    } as null | Record<string, unknown>,
  },
}));

vi.mock("../api/desktopAuth", () => ({ signOutDesktop: mocks.signOutDesktop }));
vi.mock("../api/usage", () => ({
  getUsage: () => mocks.usage,
  subscribeUsage: () => () => {},
  refreshUsage: mocks.refreshUsage,
}));
vi.mock("../store/auth", () => ({
  useAuth: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sel: any) => sel({ ...mocks.auth, markLocked: mocks.markLocked, verify: mocks.verify }),
    { getState: () => ({ ...mocks.auth, markLocked: mocks.markLocked, verify: mocks.verify }) },
  ),
}));

import ProfilePage from "./ProfilePage";

const renderPage = () =>
  render(
    <MemoryRouter>
      <ProfilePage />
    </MemoryRouter>,
  );

afterEach(() => {
  mocks.auth.status = "unlocked";
  mocks.usage = { metered: true, used: 40, limit: 100, remaining: 60, over: false };
  vi.clearAllMocks();
});

describe("ProfilePage", () => {
  it("shows who is signed in", () => {
    renderPage();
    expect(screen.getByText("Alice Example")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
  });

  it("shows the balance from the same store the chat meter reads", () => {
    renderPage();
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(mocks.refreshUsage).toHaveBeenCalled();
  });

  it("says so rather than showing zeroes when the account is not metered", () => {
    mocks.usage = { metered: false, used: 0, limit: 0, remaining: 0, over: false };
    renderPage();
    expect(screen.getByText(/not metered/i)).toBeInTheDocument();
    // A zero balance and "no balance" are different things; never render one as the other.
    expect(screen.queryByText("Remaining")).not.toBeInTheDocument();
  });

  it("signs out and hands back to the gate", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mocks.signOutDesktop).toHaveBeenCalledOnce());
    expect(mocks.markLocked).toHaveBeenCalledOnce();
  });

  it("still renders the last known identity while offline", () => {
    mocks.auth.status = "offline";
    renderPage();
    expect(screen.getByText("Alice Example")).toBeInTheDocument();
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });
});
