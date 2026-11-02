import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({
  isFocused: vi.fn(async () => false),
  requestUserAttention: vi.fn(async (_kind: unknown) => undefined),
}));
const shell = vi.hoisted(() => ({ name: "tauri" }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => win,
  UserAttentionType: { Critical: 1, Informational: 2 },
}));
vi.mock("../platform", () => ({ platform: shell }));

import { askForAttention } from "./attention";

beforeEach(() => {
  vi.clearAllMocks();
  shell.name = "tauri";
  win.isFocused.mockResolvedValue(false);
  win.requestUserAttention.mockResolvedValue(undefined);
});

describe("asking the system to draw the person's eye", () => {
  it("flashes the taskbar, gently, when the window is not in front", async () => {
    await askForAttention();
    expect(win.requestUserAttention).toHaveBeenCalledTimes(1);
    expect(win.requestUserAttention).toHaveBeenCalledWith(2); // Informational, never Critical
  });

  it("does nothing when the window is already in front", async () => {
    win.isFocused.mockResolvedValue(true);
    await askForAttention();
    expect(win.requestUserAttention).not.toHaveBeenCalled();
  });

  it("does nothing outside the desktop app", async () => {
    shell.name = "web";
    await askForAttention();
    expect(win.isFocused).not.toHaveBeenCalled();
    expect(win.requestUserAttention).not.toHaveBeenCalled();
  });

  it("is never a failure: a platform without it, or a window already gone, is nothing to report", async () => {
    win.requestUserAttention.mockRejectedValueOnce(new Error("not supported"));
    await expect(askForAttention()).resolves.toBeUndefined();
    win.isFocused.mockRejectedValueOnce(new Error("window gone"));
    await expect(askForAttention()).resolves.toBeUndefined();
  });
});

// A permission the window was never granted rejects the call, and the catch above would hide it: the hint
// would silently never appear. So the grant is checked against the real capability file.
describe("the desktop shell grants what the hint needs", () => {
  it("allows the window to request attention", () => {
    const file = path.resolve(__dirname, "../../src-tauri/capabilities/default.json");
    const capability = JSON.parse(readFileSync(file, "utf8")) as { permissions: unknown[] };
    expect(capability.permissions).toContain("core:window:allow-request-user-attention");
  });
});
