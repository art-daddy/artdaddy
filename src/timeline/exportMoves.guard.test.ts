// The Save to move (Phase 3, S3b) is ONE loop in ONE place, and this fails when a second way round it appears.
//
// A question about the room for the exported file can end with the person choosing another folder. The request that
// asked cannot be pointed somewhere else after the fact (the render command, the staging file and the reservation all
// derive from the destination), so it ends as an `ExportMoveRequest` and the call is made again at the folder. Whoever
// calls `exportTimelineTool` must do that again, or a person's choice becomes an error message. The one door that does
// (`exportTool`, the registry's `export`) is the only production caller; every other way in goes through it.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
    return [full];
  });
}

/** The shipped sources: not a test, not a smoke or end-to-end run, not a test fixture. */
const sources = (): string[] =>
  walk(SRC).filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.(test|spec|e2e)\.tsx?$/.test(file) &&
      !/[\\/](test|__e2e)[\\/.]/.test(file) &&
      !/__e2e\.ts$/.test(file),
  );
const rel = (file: string): string => path.relative(SRC, file).replace(/\\/g, "/");
/** A source with its comments taken out, so a sentence that names a function is not a use of it. */
const code = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const filesWith = (pattern: RegExp): string[] =>
  sources()
    .filter((file) => pattern.test(code(file)))
    .map(rel)
    .sort();

describe("the one loop that starts an export again where the person chose", () => {
  it("is the only place that reaches the whole-timeline export, apart from its own definition: not by name in any form", () => {
    // The name itself, not only a call: an alias (`const run = exportTimelineTool`), a destructured import or a
    // reference passed along would reach it without going through the loop just the same.
    expect(filesWith(/\bexportTimelineTool\b/)).toEqual([
      "timeline/exportItems.ts",
      "timeline/render.ts",
    ]);
  });

  it("calls it from inside the loop, and nowhere else in that file", () => {
    const source = code(path.join(SRC, "timeline", "exportItems.ts"));
    const uses = source.match(/\bexportTimelineTool\b/g) ?? [];
    expect(uses).toHaveLength(2); // the import, and the one call
    expect(source).toMatch(
      /runWithMoves\(\s*\(moved\)\s*=>[\s\S]{0,300}?exportTimelineTool\(args, ctx, retrying, moved\)/,
    );
  });

  it("is thrown in one place and caught in one place", () => {
    expect(filesWith(/new ExportMoveRequest\s*\(/)).toEqual(["timeline/exportQueue.ts"]);
    expect(filesWith(/instanceof ExportMoveRequest/)).toEqual(["timeline/exportItems.ts"]);
  });

  it("is the way every door reaches the exporter: the registry's `export` is the loop's own tool", () => {
    const ops = code(path.join(SRC, "timeline", "ops.ts"));
    expect(ops).toMatch(/register\("export",\s*\(args\)\s*=>\s*exportTool\(args, getCtx\(\)\)\)/);
    // and the card's Try again, which starts an export again from outside the turn, runs the same tool
    const render = code(path.join(SRC, "timeline", "render.ts"));
    expect(render).toMatch(/const \{ exportTool \} = await import\("\.\/exportItems"\)/);
  });
});
