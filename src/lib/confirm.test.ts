// The shipped app skipped EVERY destructive confirmation. Tauri v2 replaces `window.confirm`
// with an async shim targeting `plugin:dialog|confirm`, a command tauri-plugin-dialog 2.7 does
// not implement, so it was denied by the ACL and the Promise always rejected. A Promise is
// truthy, so `if (!window.confirm(...))` never returned and the app trashed projects, deleted
// tracks and discarded unsaved work with no prompt. Sentry: "Command plugin:dialog|confirm not
// allowed by ACL", 20+ events.
//
// These assert the OUTCOME the destructive callers depend on -- a real boolean, false whenever
// the user was not actually asked -- and the repo-wide rule that would have caught the bug.
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setExportConfirmationForTests } from "./confirm";

const dialogConfirm = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: (...a: unknown[]) => dialogConfirm(...a) }));

const asTauri = (on: boolean) => {
  if (on) window.__TAURI_INTERNALS__ = {};
  else delete window.__TAURI_INTERNALS__;
};

const load = async () => (await import("./confirm")).confirmDestructive;
beforeEach(() => __setExportConfirmationForTests(null));

afterEach(() => {
  asTauri(false);
  vi.restoreAllMocks();
  dialogConfirm.mockReset();
});

describe("confirmDestructive", () => {
  it("is false when the dialog cannot be shown, so the destructive branch never runs", async () => {
    asTauri(true);
    dialogConfirm.mockRejectedValue(new Error("Command plugin:dialog|confirm not allowed by ACL"));
    await expect((await load())("wipe it?")).resolves.toBe(false);
  });

  it("returns the user's actual answer under Tauri, both ways", async () => {
    asTauri(true);
    const confirmDestructive = await load();
    dialogConfirm.mockResolvedValue(false);
    expect(await confirmDestructive("wipe it?")).toBe(false);
    dialogConfirm.mockResolvedValue(true);
    expect(await confirmDestructive("wipe it?")).toBe(true);
  });

  it("never resolves to a truthy non-boolean (the shape that caused the bug)", async () => {
    asTauri(true);
    dialogConfirm.mockResolvedValue(false);
    const answer = await (await load())("wipe it?");
    expect(typeof answer).toBe("boolean");
    expect(answer).toBe(false);
  });

  it("uses the browser's own confirm when not under Tauri", async () => {
    asTauri(false);
    const spy = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await (await load())("wipe it?")).toBe(false);
    expect(spy).toHaveBeenCalledWith("wipe it?");
  });
});

describe("export confirmation", () => {
  it("uses explicit continue/cancel labels and returns the actual user choice", async () => {
    asTauri(true);
    const { confirmExport } = await import("./confirm");
    dialogConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await confirmExport("Memory may not fit", true)).toBe("continue");
    expect(dialogConfirm).toHaveBeenLastCalledWith("Memory may not fit", {
      title: "Export check",
      kind: "warning",
      okLabel: "Continue anyway",
      cancelLabel: "Cancel",
    });
    expect(await confirmExport("About three minutes", false)).toBe("cancel");
    expect(dialogConfirm).toHaveBeenLastCalledWith("About three minutes", {
      title: "Export check",
      kind: "info",
      okLabel: "Continue",
      cancelLabel: "Cancel",
    });
  });

  it("does not admit an export when the dialog fails or returns a truthy non-boolean", async () => {
    asTauri(true);
    const { confirmExport } = await import("./confirm");
    dialogConfirm.mockRejectedValueOnce(new Error("dialog unavailable"));
    expect(await confirmExport("Check export", true)).toBe("unavailable");
    for (const invalid of ["true", {}, 1, null, undefined]) {
      dialogConfirm.mockResolvedValueOnce(invalid);
      expect(await confirmExport("Check export", true)).toBe("unavailable");
    }
  });

  it("uses a real browser boolean without treating a Promise as consent", async () => {
    asTauri(false);
    const { confirmExport } = await import("./confirm");
    vi.spyOn(window, "confirm").mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await confirmExport("Check export", true)).toBe("continue");
    expect(await confirmExport("Check export", true)).toBe("cancel");
  });
});

describe("no caller may reach for window.confirm", () => {
  // The rule, not the four sites: under Tauri that global is an async shim, so ANY synchronous
  // use of it is a destructive action running unasked. This fails on the next one added.
  it("finds none outside lib/confirm.ts", async () => {
    const root = join(__dirname, "../..");
    const candidates = spawnSync(
      "git",
      [
        "grep",
        "--no-index",
        "--no-exclude-standard",
        "-a",
        "-l",
        "-z",
        "-F",
        "window.confirm",
        "--",
        "src",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect([0, 1].includes(candidates.status ?? -1), candidates.stderr).toBe(true);
    const files = candidates.stdout
      .split("\0")
      .filter(
        (file) => /\.(ts|tsx)$/.test(file) && !/[\\/]lib[\\/]confirm\.(ts|test\.ts)$/.test(file),
      )
      .map((file) => join(root, file));
    const offenders: string[] = [];
    for (let start = 0; start < files.length; start += 32) {
      const checked = await Promise.all(
        files
          .slice(start, start + 32)
          .map(async (file) => ({
            file,
            unsafe: /\bwindow\.confirm\s*\(/.test(await fs.readFile(file, "utf8")),
          })),
      );
      offenders.push(...checked.filter((result) => result.unsafe).map((result) => result.file));
    }
    expect(offenders).toEqual([]);
  });
});
