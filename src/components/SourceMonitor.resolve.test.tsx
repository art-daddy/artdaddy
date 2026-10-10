import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SourceMonitor from "./SourceMonitor";
import { highH264DecodesCorrectly } from "../preview/h264Support";
import { announceMediaDerived } from "../preview/mediaDerived";
import { proxyRel } from "../preview/proxyPaths";
import { clearSourceUrlCache, setAssetAccessGrant, setAssetUrlConverter } from "../preview/resolve";
import { MemFs } from "../test/timelineKit";
import { joinPath, ProjectStoreAccess } from "../tools/store";

const editor = vi.hoisted(() => ({ store: null as ProjectStoreAccess | null }));
vi.mock("../store/editor", () => ({
  useEditor: (selector: (state: typeof editor) => unknown) => selector(editor),
}));
vi.mock("../preview/h264Support", () => ({ highH264DecodesCorrectly: vi.fn() }));

const DIR = "C:/qa/source-monitor";
const SOURCE = "library/source.mp4";
const LIBRARY = joinPath(DIR, "internals", "library.json");
const PROXY = joinPath(DIR, proxyRel(SOURCE));

beforeEach(() => {
  clearSourceUrlCache();
  setAssetAccessGrant(async () => {});
  setAssetUrlConverter((file) => `asset://${file}`);
  vi.mocked(highH264DecodesCorrectly).mockResolvedValue(false);
});
afterEach(() => {
  cleanup();
  editor.store = null;
});

async function project(): Promise<MemFs> {
  const fs = new MemFs();
  await fs.writeTextFile(joinPath(DIR, SOURCE), "original media");
  await fs.writeTextFile(
    LIBRARY,
    JSON.stringify({ clips: [{ id: "media_source", kind: "video", path: SOURCE }] }),
  );
  editor.store = new ProjectStoreAccess(DIR, fs);
  return fs;
}

describe("Source Monitor runtime normalization", () => {
  it("uses a completed proxy on first open without presenting the invalid original", async () => {
    const fs = await project();
    await fs.writeTextFile(PROXY, "normalized media");
    const { container } = render(<SourceMonitor mediaRef="media_source" />);
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe(`asset://${PROXY}`),
    );
  });

  it("picks up a late proxy through the real resolver without changing library or source", async () => {
    const fs = await project();
    const libraryBefore = await fs.readTextFile(LIBRARY);
    const { container } = render(<SourceMonitor mediaRef="media_source" />);
    await screen.findByText("Couldn't resolve this file.");
    expect(container.querySelector("video")).toBeNull();

    await fs.writeTextFile(PROXY, "normalized media");
    act(() => announceMediaDerived(SOURCE));
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe(`asset://${PROXY}`),
    );
    expect(await fs.readTextFile(LIBRARY)).toBe(libraryBefore);
    expect(await fs.readTextFile(joinPath(DIR, SOURCE))).toBe("original media");
  });

  it("re-resolves an already-open source when its logical ref is relinked", async () => {
    const fs = await project();
    await fs.writeTextFile(PROXY, "normalized media");
    const { container } = render(<SourceMonitor mediaRef="media_source" />);
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe(`asset://${PROXY}`),
    );
    const nextSource = "library/relinked.mp4";
    const nextProxy = joinPath(DIR, proxyRel(nextSource));
    await fs.writeTextFile(joinPath(DIR, nextSource), "relinked media");
    await fs.writeTextFile(nextProxy, "relinked proxy");
    await fs.writeTextFile(
      LIBRARY,
      JSON.stringify({ clips: [{ id: "media_source", kind: "video", path: nextSource }] }),
    );
    act(() => clearSourceUrlCache());
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe(`asset://${nextProxy}`),
    );
    const player = container.querySelector("video");
    act(() => clearSourceUrlCache());
    await waitFor(() => expect(container.querySelector("video")).toBe(player));
  });
});
