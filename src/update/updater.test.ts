import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const captureError = vi.hoisted(() => vi.fn());
vi.mock("../observability/sentry", () => ({ captureError }));

const platform = { name: "tauri" as string };
vi.mock("../platform", () => ({
  get platform() {
    return platform;
  },
}));

import { checkForUpdate, downloadUpdate, installUpdate } from "./updater";

beforeEach(() => {
  invoke.mockReset();
  captureError.mockReset();
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
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
      scope: "updater",
      command: "check_for_update",
    });
  });

  it("never calls into Tauri on the web build", async () => {
    platform.name = "web";
    expect(await checkForUpdate()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("downloadUpdate", () => {
  it("returns the version only after the native download succeeds", async () => {
    invoke.mockResolvedValue("0.21.4");
    await expect(downloadUpdate()).resolves.toBe("0.21.4");
    expect(captureError).not.toHaveBeenCalled();
  });

  it("reports a native decoding failure without swallowing it or starting installation", async () => {
    invoke.mockRejectedValue("error decoding response body");
    await expect(downloadUpdate()).rejects.toBe("error decoding response body");
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "error decoding response body" }),
      { scope: "updater", command: "download_update" },
    );
    expect(invoke.mock.calls).toEqual([["download_update", undefined]]);
  });

  it("preserves the real update failure if error reporting also fails", async () => {
    const failure = new Error("signature mismatch");
    invoke.mockRejectedValue(failure);
    captureError.mockImplementation(() => {
      throw new Error("reporter unavailable");
    });
    await expect(downloadUpdate()).rejects.toBe(failure);
  });

  it("allows another download after a failed attempt", async () => {
    invoke.mockRejectedValueOnce("error decoding response body").mockResolvedValueOnce("0.21.4");
    await expect(downloadUpdate()).rejects.toBe("error decoding response body");
    await expect(downloadUpdate()).resolves.toBe("0.21.4");
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it("refuses on the web without invoking or reporting a native operation", async () => {
    platform.name = "web";
    await expect(downloadUpdate()).rejects.toThrow("desktop-only");
    expect(invoke).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });
});

describe("installUpdate", () => {
  it("propagates a failure — the user asked for this one, so silence would be wrong", async () => {
    invoke.mockRejectedValue(new Error("signature mismatch"));
    await expect(installUpdate()).rejects.toThrow("signature mismatch");
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
      scope: "updater",
      command: "install_update",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("refuses on the web build rather than pretending to install", async () => {
    platform.name = "web";
    await expect(installUpdate()).rejects.toThrow("desktop-only");
    expect(invoke).not.toHaveBeenCalled();
  });
});
