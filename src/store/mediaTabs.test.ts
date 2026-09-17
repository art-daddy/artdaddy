// The preview tab strip's rules, as outcomes rather than a restatement of the reducer.
//
// The one that matters: browsing the library must not bury the strip. A click that
// opened a permanent tab every time is the failure this exists to prevent, so most of
// these challenge the direction where a tab SURVIVES when it should not, and the
// direction where one is LOST when it should not be.
import { beforeEach, describe, expect, it } from "vitest";

import { useEditor } from "./editor";

const refs = () => useEditor.getState().mediaTabs.map((t) => t.ref);
const st = () => useEditor.getState();

beforeEach(() => useEditor.setState({ mediaTabs: [], activeMediaTab: null }));

describe("preview tabs", () => {
  it("starts on the live preview with nothing else open", () => {
    expect(refs()).toEqual([]);
    expect(st().activeMediaTab).toBeNull();
  });

  it("shows what was clicked", () => {
    st().openMediaTab("a.mp4");
    expect(refs()).toEqual(["a.mp4"]);
    expect(st().activeMediaTab).toBe("a.mp4");
  });

  it("browsing the library leaves ONE tab behind, not one per click", () => {
    for (const r of ["a.mp4", "b.mp4", "c.mp4", "d.mp4"]) st().openMediaTab(r);
    expect(refs()).toEqual(["d.mp4"]);
    expect(st().activeMediaTab).toBe("d.mp4");
  });

  it("a kept tab survives the next click; the transient one is still recycled", () => {
    st().openMediaTab("keep.mp4", { pin: true });
    st().openMediaTab("a.mp4");
    st().openMediaTab("b.mp4");
    expect(refs()).toEqual(["keep.mp4", "b.mp4"]);
  });

  it("keeping the tab you are on stops it being recycled", () => {
    st().openMediaTab("a.mp4");
    st().openMediaTab("a.mp4", { pin: true }); // double-click on the tab
    st().openMediaTab("b.mp4");
    expect(refs()).toEqual(["a.mp4", "b.mp4"]);
  });

  it("re-opening something already open moves to it instead of duplicating it", () => {
    st().openMediaTab("a.mp4", { pin: true });
    st().openMediaTab("b.mp4", { pin: true });
    st().setActiveMediaTab(null);
    st().openMediaTab("a.mp4");
    expect(refs()).toEqual(["a.mp4", "b.mp4"]);
    expect(st().activeMediaTab).toBe("a.mp4");
  });

  it("a click never silently un-keeps a tab", () => {
    st().openMediaTab("a.mp4", { pin: true });
    st().openMediaTab("a.mp4"); // plain click on a kept tab
    st().openMediaTab("b.mp4");
    expect(refs()).toEqual(["a.mp4", "b.mp4"]);
  });

  describe("closing", () => {
    beforeEach(() => {
      for (const r of ["a.mp4", "b.mp4", "c.mp4"]) st().openMediaTab(r, { pin: true });
    });

    it("lands on the right neighbour", () => {
      st().setActiveMediaTab("b.mp4");
      st().closeMediaTab("b.mp4");
      expect(refs()).toEqual(["a.mp4", "c.mp4"]);
      expect(st().activeMediaTab).toBe("c.mp4");
    });

    it("lands on the left neighbour when there is nothing to the right", () => {
      st().setActiveMediaTab("c.mp4");
      st().closeMediaTab("c.mp4");
      expect(st().activeMediaTab).toBe("b.mp4");
    });

    it("falls back to the live preview when the last tab goes", () => {
      for (const r of ["a.mp4", "b.mp4", "c.mp4"]) st().closeMediaTab(r);
      expect(refs()).toEqual([]);
      expect(st().activeMediaTab).toBeNull();
    });

    it("closing a tab you are NOT on leaves you where you are", () => {
      st().setActiveMediaTab("c.mp4");
      st().closeMediaTab("a.mp4");
      expect(st().activeMediaTab).toBe("c.mp4");
    });

    it("closing something that is not open changes nothing", () => {
      st().setActiveMediaTab("b.mp4");
      st().closeMediaTab("ghost.mp4");
      expect(refs()).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
      expect(st().activeMediaTab).toBe("b.mp4");
    });
  });

  // A ref that is not in the strip has nothing to render, so selecting it would leave the
  // preview showing a clip with no tab — the state the strip exists to make impossible.
  it("cannot be pointed at a clip that has no tab", () => {
    st().openMediaTab("a.mp4");
    st().setActiveMediaTab("never-opened.mp4");
    expect(st().activeMediaTab).toBe("a.mp4");
  });

  it("goes back to the live preview on demand", () => {
    st().openMediaTab("a.mp4");
    st().setActiveMediaTab(null);
    expect(st().activeMediaTab).toBeNull();
    expect(refs()).toEqual(["a.mp4"]); // switching away does not close anything
  });
});
