// Library -> timeline dragging moved off HTML5 drag-and-drop because Tauri's own handler takes it
// over on Windows once file drops are enabled ("we replace the drag drop handler of WebView2").
// These assert the GESTURE's rules, which survive whatever the implementation does next.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { activeDrag, beginDrag, onDragChange } from "./dragSource";

const down = (x = 10, y = 10, button = 0) => ({ clientX: x, clientY: y, button });
const move = (x: number, y: number) =>
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y }));
const up = (x: number, y: number) =>
  window.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y }));

beforeEach(() => {
  document.body.innerHTML = "";
  up(0, 0); // make sure no drag survives from a previous test
});

describe("beginDrag", () => {
  it("does not start on a click — only once the pointer has actually moved", () => {
    // Without a threshold every click on a library tile would spawn a drag, and selecting
    // a clip to preview it would be impossible.
    beginDrag(down(), { ref: "library/a.mp4", name: "a.mp4" }, () => {});
    move(12, 12);
    expect(activeDrag()).toBeNull();
    up(12, 12);
  });

  it("carries the payload once past the threshold and clears it on release", () => {
    const seen: Array<{ ref: string } | null> = [];
    const off = onDragChange((p) => seen.push(p));
    beginDrag(down(), { ref: "library/a.mp4", name: "a.mp4" }, () => {});
    move(60, 60);
    expect(activeDrag()).toEqual({ ref: "library/a.mp4", name: "a.mp4" });
    up(60, 60);
    expect(activeDrag()).toBeNull();
    expect(seen.map((p) => p?.ref ?? null)).toEqual(["library/a.mp4", null]);
    off();
  });

  it("drops onto whatever is under the cursor at RELEASE, not where the drag began", () => {
    const lane = document.createElement("div");
    document.body.appendChild(lane);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(lane);
    const dropped: Array<{ el: HTMLElement | null; x: number }> = [];
    beginDrag(down(), { ref: "library/a.mp4", name: "a.mp4" }, (el, x) => dropped.push({ el, x }));
    move(60, 60);
    up(300, 120);
    expect(dropped).toEqual([{ el: lane, x: 300 }]);
    vi.restoreAllMocks();
  });

  it("does not fire the drop when the gesture never became a drag", () => {
    const dropped: unknown[] = [];
    beginDrag(down(), { ref: "library/a.mp4", name: "a.mp4" }, (el) => dropped.push(el));
    up(11, 11); // released without moving
    expect(dropped).toEqual([]);
  });

  it("ignores a non-primary button, so a right-click opens the menu instead", () => {
    beginDrag(down(10, 10, 2), { ref: "library/a.mp4", name: "a.mp4" }, () => {});
    move(60, 60);
    expect(activeDrag()).toBeNull();
  });

  it("the ghost cannot be hit-tested, or it would be the drop target", () => {
    // elementFromPoint runs at the cursor, and the ghost follows the cursor: a hit-testable
    // ghost would swallow every drop.
    beginDrag(down(), { ref: "library/a.mp4", name: "a.mp4" }, () => {});
    move(60, 60);
    const el = [...document.body.children].find((c) => c.textContent === "a.mp4") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.pointerEvents).toBe("none");
    up(60, 60);
    expect(document.body.textContent).not.toContain("a.mp4"); // and it is removed
  });

  it("a cancelled pointer (window blur, touch cancel) leaves nothing behind", () => {
    beginDrag(down(), { ref: "library/a.mp4", name: "a.mp4" }, () => {});
    move(60, 60);
    window.dispatchEvent(new PointerEvent("pointercancel"));
    expect(activeDrag()).toBeNull();
    expect(document.body.textContent).not.toContain("a.mp4");
  });
});
