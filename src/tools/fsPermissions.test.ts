import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Drift guard between the fs calls the app MAKES and the permissions Tauri GRANTS.
//
// `stat` was imported and called for months while `fs:allow-stat` was absent from the capability.
// Nothing failed loudly: every call rejected, `byteSize` answered null, and each caller quietly
// took its degraded branch — inspect_timeline's render cache never once engaged, and it took
// exporting a real project to notice. Permissions are named in Rust-side JSON and the calls live
// in TS, so nothing but this test connects them.
const SRC = join(process.cwd(), "src");
const CAPABILITY = join(process.cwd(), "src-tauri", "capabilities", "default.json");

/** plugin-fs export -> the permission that authorises it, where the names differ. */
const ALIASES: Record<string, string> = {
  readFile: "read-file",
  writeFile: "write-file",
  readTextFile: "read-text-file",
  writeTextFile: "write-text-file",
  readDir: "read-dir",
  copyFile: "copy-file",
};

const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

describe("every fs call the app makes is permitted", () => {
  it("names a permission for each @tauri-apps/plugin-fs import", () => {
    const src = readFileSync(join(SRC, "tools", "tauri.ts"), "utf8");
    // `[^}]` so the match cannot start at an EARLIER import and swallow it — the plugin-shell
    // import sits directly above this one, and a lazy `[\s\S]*?` happily spans both.
    const block = /import\s*\{([^}]*?)\}\s*from\s*"@tauri-apps\/plugin-fs"/.exec(src);
    expect(block, "the plugin-fs import block moved — this guard is now blind").not.toBeNull();

    // `stat as fsStat` — the PERMISSION follows the real export, not the local alias.
    const imported = block![1]
      .split(",")
      .map((s) => /^\s*([A-Za-z_$][\w$]*)/.exec(s)?.[1] ?? "")
      .filter(Boolean);
    expect(imported.length).toBeGreaterThan(5);

    const granted = new Set(
      (JSON.parse(readFileSync(CAPABILITY, "utf8")).permissions as unknown[])
        .filter((p): p is string => typeof p === "string")
        .filter((p) => p.startsWith("fs:allow-")),
    );

    const missing = imported
      .map((name) => `fs:allow-${ALIASES[name] ?? kebab(name)}`)
      .filter((perm) => !granted.has(perm));
    expect(missing, "called but not permitted — the call will reject at runtime").toEqual([]);
  });

  it("still catches a permission being removed", () => {
    // Guards the guard: if the capability file were empty, the check above must not pass
    // vacuously because the import list happened to be empty too.
    const granted = (JSON.parse(readFileSync(CAPABILITY, "utf8")).permissions as unknown[]).filter(
      (p) => typeof p === "string" && p.startsWith("fs:allow-"),
    );
    expect(granted.length).toBeGreaterThan(5);
    expect(granted).toContain("fs:allow-stat");
  });
});
