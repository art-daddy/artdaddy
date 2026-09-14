// No media-sized file may enter the webview heap.
//
// Measured, not theorised: importing a 428 MB clip by path drove the app's peak RSS up 3,543 MB
// - 8.3x the file - because the bytes cross the webview IPC boundary on the way in. A >1 GB file
// took a 16 GB machine to 96% and froze it. The previous fix taught the callers to avoid the
// hazard one at a time; this pins the RULE at the boundary instead, so a caller that has not
// learned it fails loudly rather than eating the machine.
import { describe, expect, it, vi } from "vitest";

import { MAX_HEAP_READ_BYTES, ProjectStoreAccess } from "./store";

const GB = 1024 * 1024 * 1024;

function fsWith(size: number | null, readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]))) {
  return {
    readBytes,
    stat: size === null ? undefined : vi.fn(async () => ({ isDirectory: false, size })),
    exists: async () => true,
    readTextFile: async () => "",
    writeTextFile: async () => {},
    mkdir: async () => {},
    readDir: async () => [],
    remove: async () => {},
    rename: async () => {},
    copyFile: async () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const store = (fs: unknown) => new ProjectStoreAccess("C:/proj", fs as never);

describe("whole-file reads have a ceiling", () => {
  it("REFUSES a media-sized file instead of pulling it through the boundary", async () => {
    const readBytes = vi.fn(async () => new Uint8Array(8));
    await expect(store(fsWith(2 * GB, readBytes)).readBytes("C:/proj/huge.mp4")).rejects.toThrow(
      /refusing to read/i,
    );
    // The point of the guard: the read never happened.
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("names the file and the limit, so the failure is actionable", async () => {
    await expect(store(fsWith(2 * GB)).readBytes("C:/proj/huge.mp4")).rejects.toThrow(
      /huge\.mp4[\s\S]*ceiling|ceiling[\s\S]*huge\.mp4/i,
    );
  });

  it("still reads the small sidecars the app genuinely needs", async () => {
    const readBytes = vi.fn(async () => new Uint8Array([7]));
    const out = await store(fsWith(12 * 1024, readBytes)).readBytes("C:/proj/internals/x.json");
    expect(out).toEqual(new Uint8Array([7]));
    expect(readBytes).toHaveBeenCalledOnce();
  });

  it("allows a file exactly at the ceiling and refuses one byte past it", async () => {
    await expect(store(fsWith(MAX_HEAP_READ_BYTES)).readBytes("C:/a")).resolves.toBeInstanceOf(
      Uint8Array,
    );
    await expect(store(fsWith(MAX_HEAP_READ_BYTES + 1)).readBytes("C:/a")).rejects.toThrow(
      /refusing/i,
    );
  });

  // The web build has no native probe. It must not become a silent hole in the ceiling, but it
  // also must not break the small reads that are all it is used for there.
  it("falls through when the platform cannot report a size", async () => {
    const readBytes = vi.fn(async () => new Uint8Array([9]));
    await expect(store(fsWith(null, readBytes)).readBytes("C:/a")).resolves.toEqual(
      new Uint8Array([9]),
    );
  });
});
