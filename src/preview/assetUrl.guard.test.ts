// Only one module may turn a file on disk into a URL the webview fetches (UJ-027).
//
// preview/resolve.ts is where a path becomes an asset URL, and where the preview is first given
// access to the file when the project's library holds it. A second place calling convertFileSrc
// would hand out URLs for files nothing opened, and they would play black on a second drive after
// a restart - the bug this door exists to close.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const DOOR = "preview/resolve.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$|\.e2e\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("asset URLs", () => {
  it("are made in one place, which opens the file to the preview first", () => {
    const offenders = walk(SRC)
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"))
      .filter((rel) => rel !== DOOR && /convertFileSrc/.test(readFileSync(join(SRC, rel), "utf8")));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(SRC, DOOR), "utf8")).toMatch(/convertFileSrc/);
  }, 30_000);
});
