import { describe, expect, it } from "vitest";

import { isSafeProjectId, safeProjectDir } from "./dataRoot";

describe("isSafeProjectId", () => {
  it("accepts a strict lowercase-ascii slug (the generated id form)", () => {
    for (const ok of ["p1", "my_video_a3f9c2", "project_000000", "a", "con_1a2b3c"])
      expect(isSafeProjectId(ok)).toBe(true);
  });
  it("rejects separators, dot segments, empties, and non-strings", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "../evil", "/abs", "x/"])
      expect(isSafeProjectId(bad)).toBe(false);
    for (const bad of [null, undefined, 42, {}])
      expect(isSafeProjectId(bad as unknown)).toBe(false);
  });
  it("rejects non-slug shapes: uppercase, hyphen, unicode, space, trailing dot, over-long (RF9)", () => {
    for (const bad of ["Proj-123", "my-proj", "caf\u00e9", "good.", "good ", "...", "a".repeat(65)])
      expect(isSafeProjectId(bad)).toBe(false);
  });
  it("rejects Windows reserved device names (RF9)", () => {
    for (const bad of ["nul", "con", "aux", "prn", "com1", "lpt9", "NUL", "Com3"])
      expect(isSafeProjectId(bad)).toBe(false);
  });
});

describe("safeProjectDir", () => {
  it("throws on any unsafe id before touching the filesystem", async () => {
    for (const bad of ["..", "../evil", "a/b", ""]) {
      await expect(safeProjectDir(bad)).rejects.toThrow(/unsafe project id/);
    }
  });
});
