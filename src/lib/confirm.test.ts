// The shipped app skipped EVERY destructive confirmation. Tauri v2 replaces `window.confirm`
// with an async shim targeting `plugin:dialog|confirm`, a command tauri-plugin-dialog 2.7 does
// not implement, so it was denied by the ACL and the Promise always rejected. A Promise is
// truthy, so `if (!window.confirm(...))` never returned and the app trashed projects, deleted
// tracks and discarded unsaved work with no prompt. Sentry: "Command plugin:dialog|confirm not
// allowed by ACL", 20+ events.
//
// These assert the OUTCOME the destructive callers depend on -- a real boolean, false whenever
// the user was not actually asked -- and the repo-wide rule that would have caught the bug.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const dialogConfirm = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: (...a: unknown[]) => dialogConfirm(...a) }));

const asTauri = (on: boolean) => {
  if (on) window.__TAURI_INTERNALS__ = {};
  else delete window.__TAURI_INTERNALS__;
};

const load = async () => (await import("./confirm")).confirmDestructive;

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

describe("no caller may reach for window.confirm", () => {
  // The rule, not the four sites: under Tauri that global is an async shim, so ANY synchronous
  // use of it is a destructive action running unasked. This fails on the next one added.
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });

  it("finds none outside lib/confirm.ts", () => {
    const offenders = walk(join(__dirname, "..")).filter(
      (f) =>
        !/[\\/]lib[\\/]confirm\.(ts|test\.ts)$/.test(f) &&
        /\bwindow\.confirm\s*\(/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
