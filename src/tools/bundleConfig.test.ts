// The whisper runtime DLLs are a WINDOWS-ONLY resource: the mac build is static and ships no
// such folder. Tauri fails the build outright on a glob that matches nothing ("glob pattern
// resources/whisper/* path not found or didn't match any files"), so leaving it in the shared
// config made every macOS build impossible.
//
// Tauri merges tauri.windows.conf.json over the base one by JSON merge, which REPLACES arrays
// rather than appending. That makes the Windows list a second copy of the shared list, and a
// resource added to the base would silently vanish from Windows. This is the guard for that.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Not import.meta.url: vitest rewrites it to a root-relative URL, which resolved to C:\.
const read = (
  name: string,
): {
  bundle: {
    resources: string[];
    linux?: { appimage?: { bundleMediaFramework?: boolean } };
  };
} => JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri", name), "utf8"));

const WINDOWS_ONLY = ["resources/whisper/*"];

describe("bundle resources across platform configs", () => {
  it("keeps Windows-only resources out of the shared config", () => {
    // Any of these in the base config breaks the macOS and Linux builds, not just this one.
    expect(read("tauri.conf.json").bundle.resources).not.toContain(WINDOWS_ONLY[0]);
  });

  it("gives Windows everything the shared config has, plus its own", () => {
    const base = read("tauri.conf.json").bundle.resources;
    const win = read("tauri.windows.conf.json").bundle.resources;
    // Not a subset check: the override replaces the array, so a base entry missing here is
    // a resource Windows stops shipping.
    expect(win).toEqual([...base, ...WINDOWS_ONLY]);
  });

  it("ships the media framework the Linux preview needs", () => {
    expect(read("tauri.conf.json").bundle.linux?.appimage?.bundleMediaFramework).toBe(true);
  });
});
