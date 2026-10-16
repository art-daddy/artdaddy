import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const shell = vi.hoisted(() => ({ name: "tauri" }));
vi.mock("./index", () => ({ platform: shell }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { resolveExportResources } from "./host";

const UNKNOWN = { total_memory_bytes: null, available_memory_bytes: null,
  scratch_free_bytes: null, destination_free_bytes: null };

beforeEach(() => { invoke.mockReset(); shell.name = "tauri"; });
afterEach(() => vi.useRealTimers());

describe("local export resource snapshots", () => {
  it("preserves measured zero free space and sends the destination only to native IPC", async () => {
    const snapshot = { total_memory_bytes: 16 * 1024 ** 3, available_memory_bytes: 4 * 1024 ** 3,
      scratch_free_bytes: 0, destination_free_bytes: 100 * 1024 ** 3 };
    invoke.mockResolvedValue(snapshot);
    expect(await resolveExportResources("C:/qa/movie.mp4")).toEqual(snapshot);
    expect(invoke).toHaveBeenCalledWith("jobs_export_resources", { destination: "C:/qa/movie.mp4" });
  });

  it("keeps unavailable or malformed measurements unknown instead of claiming zero", async () => {
    invoke.mockRejectedValueOnce(new Error("native command unavailable"));
    expect(await resolveExportResources("C:/qa/movie.mp4")).toEqual(UNKNOWN);
    invoke.mockResolvedValueOnce({ total_memory_bytes: "16GB", available_memory_bytes: 50,
      scratch_free_bytes: -1, destination_free_bytes: Infinity });
    expect(await resolveExportResources("C:/qa/movie.mp4")).toEqual(UNKNOWN);
    invoke.mockResolvedValueOnce({ total_memory_bytes: 100, available_memory_bytes: 101,
      scratch_free_bytes: NaN, destination_free_bytes: Number.MAX_SAFE_INTEGER + 1 });
    expect(await resolveExportResources("C:/qa/movie.mp4")).toEqual({ ...UNKNOWN, total_memory_bytes: 100 });
  });

  it("does not query native resources for web or already-aborted requests", async () => {
    shell.name = "web";
    expect(await resolveExportResources("C:/qa/movie.mp4")).toEqual(UNKNOWN);
    shell.name = "tauri";
    const controller = new AbortController();
    controller.abort();
    expect(await resolveExportResources("C:/qa/movie.mp4", controller.signal)).toEqual(UNKNOWN);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("bounds a stalled query and does not adopt its late answer", async () => {
    vi.useFakeTimers();
    let complete!: (value: unknown) => void;
    invoke.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const pending = resolveExportResources("C:/qa/movie.mp4");
    await vi.advanceTimersByTimeAsync(2000);
    const snapshot = await pending;
    expect(snapshot).toEqual(UNKNOWN);
    complete({ total_memory_bytes: 16 * 1024 ** 3, available_memory_bytes: 8 * 1024 ** 3,
      scratch_free_bytes: 100, destination_free_bytes: 100 });
    await Promise.resolve();
    expect(snapshot).toEqual(UNKNOWN);
  });
});