import { describe, expect, it } from "vitest";

import { joinPath, type ProjectStoreAccess } from "../tools/store";
import { buildFeedbackBundle } from "./feedbackBundle";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DIR = "C:/proj/p1";
const PROJ = joinPath(DIR, "internals", "project.json");
const LIB = joinPath(DIR, "library.json");

function storeWith(files: Record<string, string>): ProjectStoreAccess {
  return {
    projectDir: DIR,
    exists: async (p: string) => p in files,
    readText: async (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
  } as Any;
}

describe("buildFeedbackBundle", () => {
  it("gathers transcript, timeline, and manifests", async () => {
    const store = storeWith({
      [PROJ]: JSON.stringify({ settings: { fps: 30 } }),
      [LIB]: JSON.stringify({ media: ["a"] }),
    });
    const b = await buildFeedbackBundle(store, [{ id: "r1" }], { canvas: {} });
    expect(b.transcript).toEqual([{ id: "r1" }]);
    expect(b.timeline).toEqual({ canvas: {} });
    expect(b.manifests).toEqual({ project: { settings: { fps: 30 } }, library: { media: ["a"] } });
  });

  it("skips missing or corrupt manifests", async () => {
    const store = storeWith({ [LIB]: "{bad json" });
    const b = await buildFeedbackBundle(store, [], null);
    expect(b.manifests).toBeUndefined();
    expect(b.timeline).toBeUndefined();
  });

  it("omits manifests when there is no store", async () => {
    const b = await buildFeedbackBundle(null, [{ id: "r1" }], { canvas: {} });
    expect(b.manifests).toBeUndefined();
    expect(b.transcript).toEqual([{ id: "r1" }]);
  });

  it("sheds manifests, then timeline, then trims the transcript when oversize", async () => {
    const big = "x".repeat(1_600_000);
    const store = storeWith({ [LIB]: JSON.stringify({ blob: big }) });
    const transcript = Array.from({ length: 60 }, (_, i) => ({ id: i, blob: "y".repeat(30_000) }));
    const b = await buildFeedbackBundle(store, transcript, { blob: big });
    expect(b.manifests).toBeUndefined();
    expect(b.timeline).toBeUndefined();
    expect(Array.isArray(b.transcript)).toBe(true);
    expect((b.transcript as unknown[]).length).toBe(20);
  });
});
