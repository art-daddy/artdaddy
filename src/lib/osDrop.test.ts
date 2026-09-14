// OS file drops route through Tauri now, so a drop carries PATHS and can be linked in place
// instead of copied. Two things can be silently wrong: the coordinate space (Tauri reports
// physical pixels, the DOM speaks CSS pixels) and which zone the drop is attributed to.
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Array<(e: { payload: unknown }) => void> = [];
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (fn: (e: { payload: unknown }) => void) => {
      listeners.push(fn);
      return Promise.resolve(() => {
        listeners.length = 0;
      });
    },
  }),
}));
let platformName = "tauri";
vi.mock("../platform", () => ({
  get platform() {
    return { name: platformName };
  },
}));

import { onOsDragOver, onOsDrop, startOsDropRouter, webOwnsFileDrops } from "./osDrop";

const emit = (payload: unknown) => listeners.forEach((fn) => fn({ payload }));

beforeEach(() => {
  listeners.length = 0;
  platformName = "tauri";
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// Who is allowed to CLAIM an OS file drag. On desktop the page claiming it is not a harmless
// duplicate: WKWebView then hands the page macOS's preview image instead of handing Tauri the
// file, so a dropped video imported as a .jpeg still. Windows hid it — WebView2's drag handler
// is replaced outright, so the page never saw the drag at all.
describe("webOwnsFileDrops", () => {
  it("is false on desktop, so no HTML5 handler can take the drop from Tauri", () => {
    platformName = "tauri";
    expect(webOwnsFileDrops()).toBe(false);
  });

  it("is true on web, where there is no native handler to defer to", () => {
    platformName = "web";
    expect(webOwnsFileDrops()).toBe(true);
  });
});

/** A zone that elementFromPoint will report for any coordinate. */
function zone(name: string): HTMLElement {
  const el = document.createElement("div");
  el.dataset.artdaddyDrop = name;
  document.body.appendChild(el);
  vi.spyOn(document, "elementFromPoint").mockReturnValue(el);
  return el;
}

describe("startOsDropRouter", () => {
  it("delivers dropped PATHS to the zone under the cursor", async () => {
    await startOsDropRouter();
    const el = zone("library");
    const got: string[][] = [];
    onOsDrop("library", (d) => got.push(d.paths));
    emit({ type: "drop", paths: ["D:/a.mp4", "D:/b.mp4"], position: { x: 10, y: 10 } });
    expect(got).toEqual([["D:/a.mp4", "D:/b.mp4"]]);
    expect(el.dataset.artdaddyDrop).toBe("library");
  });

  it("does NOT deliver to a zone the cursor is not over", async () => {
    // The failure direction: routing by anything other than the cursor would drop a file
    // onto whichever panel happened to subscribe first.
    await startOsDropRouter();
    zone("library");
    const track: string[][] = [];
    onOsDrop("track", (d) => track.push(d.paths));
    emit({ type: "drop", paths: ["D:/a.mp4"], position: { x: 10, y: 10 } });
    expect(track).toEqual([]);
  });

  it("converts physical pixels to CSS pixels", async () => {
    // Tauri reports device pixels. On a 150% display, using them raw lands the drop a third
    // of the way up the window -- on the wrong track, or on no track at all.
    const dpr = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    await startOsDropRouter();
    zone("track");
    const seen: Array<{ x: number; y: number }> = [];
    onOsDrop("track", (d) => seen.push({ x: d.x, y: d.y }));
    emit({ type: "drop", paths: ["D:/a.mp4"], position: { x: 600, y: 400 } });
    expect(seen).toEqual([{ x: 300, y: 200 }]);
    Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
  });

  it("reports hover and clears it on leave, so the highlight cannot stick", async () => {
    await startOsDropRouter();
    zone("library");
    const seen: Array<string | null> = [];
    onOsDragOver((d) => seen.push(d ? d.target : null));
    emit({ type: "over", position: { x: 5, y: 5 } });
    emit({ type: "leave" });
    expect(seen).toEqual(["library", null]);
  });

  it("ignores a drop that carries no paths", async () => {
    await startOsDropRouter();
    zone("library");
    const got: unknown[] = [];
    onOsDrop("library", (d) => got.push(d));
    emit({ type: "drop", paths: [], position: { x: 5, y: 5 } });
    expect(got).toEqual([]);
  });

  it("attributes a drop outside every zone to nothing", async () => {
    await startOsDropRouter();
    document.body.appendChild(document.createElement("div"));
    vi.spyOn(document, "elementFromPoint").mockReturnValue(document.body);
    const got: unknown[] = [];
    onOsDrop("library", (d) => got.push(d));
    emit({ type: "drop", paths: ["D:/a.mp4"], position: { x: 5, y: 5 } });
    expect(got).toEqual([]);
  });
});
