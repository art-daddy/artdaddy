// UJ-088: the agent learns about a person's imports from ONE registry (store/importJobs.ts) that every door fills BEFORE its first await. A door that imports a file by
// reference without going through the registry is invisible to it: the person drops files, types at once, and the agent is told the library is empty again. The doors are
// components and a drop handler, so this walks the source for the one call that brings a file in by reference and fails when a call is not made through the batch's
// per-file wrapper (`file(path, () => withImportJob(path, () => importFileByReference(...)))`), the way a new door would be written by copying an old one without it.
// The behaviour of the registry itself, and of the doors in lib/upload.ts, is tested where they live; the lane drop is also proved in the replay (evidence for UJ-088).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(process.cwd(), "src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("every door that imports a file by reference registers it with the batch", () => {
  const sites: { file: string; line: number; wrapped: boolean }[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/importFileByReference\(/g)) {
      const at = m.index ?? 0;
      if (/function\s+$/.test(text.slice(Math.max(0, at - 16), at))) continue; // its definition
      const before = text.slice(Math.max(0, at - 220), at);
      sites.push({
        file: path.relative(SRC, file).replace(/\\/g, "/"),
        line: text.slice(0, at).split("\n").length,
        wrapped: /\bfile\(\s*[\w.]+,\s*\(\)\s*=>\s*withImportJob\(\s*[\w.]+,\s*\(\)\s*=>\s*$/.test(
          before,
        ),
      });
    }
  }

  it("finds the doors it is meant to guard (a walk that finds none would pass for any code)", () => {
    const files = new Set(sites.map((s) => s.file));
    expect([...files]).toEqual(
      expect.arrayContaining([
        "lib/upload.ts",
        "components/MenuBar.tsx",
        "components/TimelineEditor.tsx",
      ]),
    );
  });

  it("has no call made outside the batch's per-file wrapper", () => {
    expect(sites.filter((s) => !s.wrapped).map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });
});
