import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const platform = { name: "tauri" as string };
vi.mock("../platform", () => ({
  get platform() {
    return platform;
  },
}));

import { checkForUpdate, installUpdate } from "./updater";

beforeEach(() => {
  invoke.mockReset();
  platform.name = "tauri";
});

describe("checkForUpdate", () => {
  it("reports an available version", async () => {
    invoke.mockResolvedValue({ version: "0.2.0", current_version: "0.1.0", notes: "", date: "" });
    expect((await checkForUpdate())?.version).toBe("0.2.0");
  });

  it("returns null when already current", async () => {
    invoke.mockResolvedValue(null);
    expect(await checkForUpdate()).toBeNull();
  });

  // The rule that matters: an unreachable release host must never surface as an error
  // or the app becomes unusable whenever the update endpoint is down.
  it("swallows a check failure instead of breaking startup", async () => {
    invoke.mockRejectedValue(new Error("dns exploded"));
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("never calls into Tauri on the web build", async () => {
    platform.name = "web";
    expect(await checkForUpdate()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("installUpdate", () => {
  it("propagates a failure — the user asked for this one, so silence would be wrong", async () => {
    invoke.mockRejectedValue(new Error("signature mismatch"));
    await expect(installUpdate()).rejects.toThrow("signature mismatch");
  });

  it("refuses on the web build rather than pretending to install", async () => {
    platform.name = "web";
    await expect(installUpdate()).rejects.toThrow("desktop-only");
    expect(invoke).not.toHaveBeenCalled();
  });
});
