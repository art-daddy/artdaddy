// The updater compares against src-tauri/tauri.conf.json, but other files name the same version by
// hand. A lagging one stays invisible until a release build trips on it: the 0.21.7 Windows build
// died forty minutes in because installedWindow.ps1 still expected 0.21.6.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel));
const first = (text: string, pattern: RegExp) => pattern.exec(text)?.[1] ?? null;

const pins: Array<[string, () => string | null]> = [
  ["package.json", () => json("package.json").version],
  ["package-lock.json", () => json("package-lock.json").version],
  ["package-lock.json root package", () => json("package-lock.json").packages[""].version],
  ["mcpb/manifest.json", () => json("mcpb/manifest.json").version],
  [
    "src-tauri/Cargo.toml",
    () => first(read("src-tauri/Cargo.toml"), /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m),
  ],
  [
    "src-tauri/Cargo.lock",
    () => first(read("src-tauri/Cargo.lock"), /name = "artdaddy"\r?\nversion = "([^"]+)"/),
  ],
  [
    "scripts/qa/installedArtifact.mjs",
    () =>
      first(
        read("scripts/qa/installedArtifact.mjs"),
        /assert\.equal\(actual\.version, "([^"]+)"\)/,
      ),
  ],
  [
    "scripts/qa/installedWindow.ps1",
    () => {
      // The pin is a regex ('^0\.21\.7(?:\.0)?$'), so the dots are escaped in the file.
      const escaped = first(
        read("scripts/qa/installedWindow.ps1"),
        /-notmatch '\^([\d\\.]+)\(\?:\\\.0\)\?\$'/,
      );
      return escaped === null ? null : escaped.replace(/\\\./g, ".");
    },
  ],
];

describe("every file that names this build's version agrees with the updater's source", () => {
  const version = json("src-tauri/tauri.conf.json").version as string;

  it("has a version to compare against", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const [file, found] of pins) {
    it(file, () => {
      const value = found();
      expect(
        value,
        "no version pin found: did the file's shape change? update this table",
      ).not.toBe(null);
      expect(value).toBe(version);
    });
  }
});
