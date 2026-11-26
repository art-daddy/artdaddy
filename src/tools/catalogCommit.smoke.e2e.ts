// The library catalog is rewritten while other work reads it, and every read must still find what it
// holds. An export enters its output in the library after it is marked done, so the next export
// reads the catalog while that write lands. The catalog's one write (writeLibraryCatalog) commits by
// renaming a finished copy onto it. On Windows the e2e filesystem's rename was refused while a reader
// had the catalog open, the store then wrote the catalog in place, and a reader that came in during
// that write found it empty: in a parallel smoke run exportRungs.smoke.e2e.ts lost a clip's media
// ("not on disk") that way. The app's own rename is not refused there. Real files and real renames:
// a rename is never refused on Linux or macOS, so the case this guards only arises on Windows.
//   npx vitest run --config vitest.smoke.config.ts src/tools/catalogCommit.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ff,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeFs,
  openE2EDoc,
  resetE2EDocuments,
} from "./__e2e";
import { libraryCatalogPath, writeLibraryCatalog } from "./libraryCatalog";
import { joinPath } from "./store";

const ROOT = joinPath(os.tmpdir(), `artdaddy-catalog-commit-${process.pid}-${Date.now()}`);
/** Catalog writes while two readers read it: before the fix, on Windows, a few dozen were enough
 *  for reads to find the catalog empty. */
const WRITES = 40;

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

describe("the library catalog while it is rewritten", () => {
  it("resolves its media at every read, however often the catalog is replaced under the reads", async () => {
    const dir = joinPath(ROOT, "catalog");
    await nodeFs.mkdir(dir);
    await openE2EDoc(dir);
    const ctx = mkCtx(dir);
    const src = joinPath(dir, "src.mp4");
    await ff([
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=s=64x36:r=10:d=1",
      "-pix_fmt", "yuv420p", src,
    ]); // prettier-ignore
    const ref = await libRef(ctx, src, "video");
    const want = await ctx.store.resolveRef(ref);
    expect(want).toBeTruthy();
    const catalog: unknown = JSON.parse(await nodeFs.readTextFile(libraryCatalogPath(ctx.store)));

    let writing = true;
    let reads = 0;
    const misses: number[] = [];
    const read = async () => {
      while (writing) {
        reads++;
        if ((await ctx.store.resolveRef(ref)) !== want) misses.push(reads);
      }
    };
    const write = async () => {
      try {
        for (let i = 0; i < WRITES; i++)
          expect(await writeLibraryCatalog(ctx.store, catalog)).toBe(true);
      } finally {
        writing = false;
      }
    };
    await Promise.all([write(), read(), read()]);

    expect(reads, "reads made while the catalog was written").toBeGreaterThan(WRITES);
    expect(misses, "reads that did not find the media").toEqual([]);
    expect(JSON.parse(await nodeFs.readTextFile(libraryCatalogPath(ctx.store)))).toEqual(catalog);
  }, 180_000);
});
