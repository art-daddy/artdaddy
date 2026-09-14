import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/auth", () => ({ verifyAccess: vi.fn() }));
vi.mock("../api/usage", () => ({ refreshUsage: vi.fn(), clearUsage: vi.fn() }));

import { verifyAccess } from "../api/auth";
import { clearUsage, refreshUsage } from "../api/usage";
import { useAuth } from "./auth";

const mockVerify = vi.mocked(verifyAccess);
const mockRefresh = vi.mocked(refreshUsage);
const mockClear = vi.mocked(clearUsage);

beforeEach(() => {
  useAuth.setState({ status: "checking" });
  mockVerify.mockReset();
  mockRefresh.mockReset();
  mockClear.mockReset();
});

describe("useAuth", () => {
  it("verify -> unlocked when the token is accepted", async () => {
    mockVerify.mockResolvedValue(true);
    await useAuth.getState().verify();
    expect(useAuth.getState().status).toBe("unlocked");
  });

  it("verify -> locked when the token is rejected", async () => {
    mockVerify.mockResolvedValue(false);
    await useAuth.getState().verify();
    expect(useAuth.getState().status).toBe("locked");
  });

  it("verify -> offline when the server is unreachable (editing still works)", async () => {
    mockVerify.mockRejectedValue(new Error("network"));
    await useAuth.getState().verify();
    expect(useAuth.getState().status).toBe("offline");
  });

  it("markLocked locks and drops the balance", () => {
    useAuth.getState().markLocked();
    expect(useAuth.getState().status).toBe("locked");
  });
});

// The balance belongs to the identity. Before this, the meter only refreshed on
// mount and after a turn, so signing in mid-session showed nothing until reload.
describe("the credit balance follows the identity", () => {
  it("a revoked token DROPS the balance instead of leaving the old one on screen", () => {
    useAuth.getState().markLocked();
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("a restored token on boot fetches the balance", async () => {
    mockVerify.mockResolvedValue(true);
    await useAuth.getState().verify();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockClear).not.toHaveBeenCalled();
  });

  it("a rejected token on boot drops the balance", async () => {
    mockVerify.mockResolvedValue(false);
    await useAuth.getState().verify();
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("going OFFLINE keeps the last known balance — the identity did not change", async () => {
    mockVerify.mockRejectedValue(new Error("network"));
    await useAuth.getState().verify();
    expect(mockClear).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
