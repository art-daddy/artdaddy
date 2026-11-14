// The speech model is stated in ONE place, `modelManifest.ts`: its size, checksum, revision and the address it
// is pinned to. Every other file reads the table. This walks the source and fails on a second statement of any of
// them, which is how the two copies of the file name (a URL and a path, each derived from the model's key)
// drifted apart before the manifest existed.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MODEL_MANIFEST, PRIMARY_BASE } from "./modelManifest";

const SRC = path.resolve(__dirname, "..");
const TESTS = /\.(test|e2e|smoke|property|eval)\.tsx?$/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return /\.tsx?$/.test(e.name) && !TESTS.test(e.name) && !e.name.endsWith(".d.ts") ? [full] : [];
  });
}

describe("the speech model is stated once", () => {
  const files = sources(SRC).filter((f) => path.basename(f) !== "modelManifest.ts");

  it("reads the source it walks: this passes for nothing if the walk finds nothing", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => path.basename(f) === "transcribe.ts")).toBe(true);
  });

  it("has no other statement of any entry's checksum, revision or size, nor of the address it is fetched from", () => {
    const needles = Object.entries(MODEL_MANIFEST).flatMap(([key, e]) => [
      [`${key} checksum`, e.sha256],
      [`${key} revision`, e.revision],
      [`${key} size`, String(e.bytes)],
      [`${key} size`, e.bytes.toLocaleString("en-US").replace(/,/g, "_")],
    ]);
    needles.push(["the address", new URL(PRIMARY_BASE).host + new URL(PRIMARY_BASE).pathname]);
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const [what, needle] of needles)
        if (text.includes(needle)) found.push(`${path.relative(SRC, file)}: ${what}`);
    }
    expect(found).toEqual([]);
  });
});
