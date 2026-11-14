import { describe, expect, it } from "vitest";

import { checkFiles, type CheckFs } from "./pcCheckFiles";

/** A small in-memory file system with the four calls the port needs. */
function memoryFs(files: Record<string, number> = {}, folders: string[] = []) {
  const bytes = new Map(Object.entries(files));
  const dirs = new Set(folders);
  const calls: string[] = [];
  const fs: CheckFs = {
    mkdir: async (path) => void (calls.push(`mkdir ${path}`), dirs.add(path)),
    remove: async (path) => {
      calls.push(`remove ${path}`);
      if (!bytes.delete(path)) throw new Error("no such file");
    },
    rename: async (from, to) => {
      calls.push(`rename ${from} ${to}`);
      const size = bytes.get(from);
      if (size === undefined) throw new Error("no such file");
      bytes.delete(from);
      bytes.set(to, size);
    },
    stat: async (path) => {
      if (dirs.has(path)) return { isDirectory: true, size: 4096 };
      const size = bytes.get(path);
      if (size === undefined) throw new Error("no such file");
      return { isDirectory: false, size };
    },
  };
  return { fs, calls, bytes };
}

describe("the PC check's files port", () => {
  it("keeps the check's files in one folder of their own inside the cache, the same folder every time", async () => {
    const { fs } = memoryFs();
    const files = checkFiles(fs, async () => "C:/cache");
    expect(await files.dir()).toBe("C:/cache/pc-check");
    expect(await files.dir()).toBe("C:/cache/pc-check");
  });

  it("says a file's own size, and null for a file that is not there, a folder, or a read that failed", async () => {
    const { fs } = memoryFs({ "C:/cache/pc-check/reference.mp4": 123_456, "C:/cache/zero": 0 }, [
      "C:/cache/pc-check",
    ]);
    const files = checkFiles(fs, async () => "C:/cache");
    expect(await files.size("C:/cache/pc-check/reference.mp4")).toBe(123_456);
    expect(await files.size("C:/cache/zero")).toBe(0);
    expect(await files.size("C:/cache/pc-check/missing.mp4")).toBeNull();
    expect(await files.size("C:/cache/pc-check")).toBeNull();
    const broken = checkFiles(
      { ...fs, stat: async () => ({ isDirectory: false, size: Number.NaN }) },
      async () => "C:/cache",
    );
    expect(await broken.size("anything")).toBeNull();
  });

  it("makes, renames and removes through the file system, and lets its failure reach the probe, which stops without a record", async () => {
    const { fs, calls, bytes } = memoryFs({ "C:/cache/pc-check/part.mp4": 10 });
    const files = checkFiles(fs, async () => "C:/cache");
    await files.mkdir("C:/cache/pc-check");
    await files.rename("C:/cache/pc-check/part.mp4", "C:/cache/pc-check/reference.mp4");
    expect([...bytes.keys()]).toEqual(["C:/cache/pc-check/reference.mp4"]);
    await files.remove("C:/cache/pc-check/reference.mp4");
    expect(bytes.size).toBe(0);
    expect(calls).toEqual([
      "mkdir C:/cache/pc-check",
      "rename C:/cache/pc-check/part.mp4 C:/cache/pc-check/reference.mp4",
      "remove C:/cache/pc-check/reference.mp4",
    ]);
    await expect(files.remove("C:/cache/pc-check/reference.mp4")).rejects.toThrow();
  });
});
