// The tab strip, tested through what a user can see and click.
//
// The rule that must survive a rewrite: the live preview is always reachable. An editor
// whose program monitor can be closed — or pushed off by a library you browsed — is the
// trap this strip exists to avoid, so the closable/pinned asymmetry is asserted directly.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useEditor } from "../store/editor";
import PreviewTabs from "./PreviewTabs";

const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);

beforeEach(() =>
  useEditor.setState({ mediaTabs: [], activeMediaTab: null, mediaNames: {} }),
);

describe("PreviewTabs", () => {
  it("offers the live preview first, and alone, with nothing else open", () => {
    render(<PreviewTabs />);
    expect(tabNames()).toEqual(["Live preview"]);
    expect(screen.getByRole("tab", { name: "Live preview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("keeps the live preview first and un-closable no matter what is open", () => {
    useEditor.setState({
      mediaTabs: [{ ref: "m_1", transient: false }],
      activeMediaTab: "m_1",
      mediaNames: { m_1: "beach.mp4" },
    });
    render(<PreviewTabs />);
    expect(tabNames()).toEqual(["Live preview", "beach.mp4"]);
    expect(screen.queryByLabelText(/close Live preview/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("close beach.mp4")).toBeInTheDocument();
  });

  it("names a tab from the catalog, not from the opaque library id the ref carries", () => {
    useEditor.setState({
      mediaTabs: [{ ref: "media_97a96bef9baa", transient: true }],
      activeMediaTab: "media_97a96bef9baa",
      mediaNames: { media_97a96bef9baa: "interview take 3.mov" },
    });
    render(<PreviewTabs />);
    expect(screen.getByRole("tab", { name: /interview take 3\.mov/ })).toBeInTheDocument();
  });

  it("falls back to the file name when the catalog has not answered yet", () => {
    useEditor.setState({
      mediaTabs: [{ ref: "library/sub/clip.mp4", transient: true }],
      activeMediaTab: "library/sub/clip.mp4",
    });
    render(<PreviewTabs />);
    expect(screen.getByRole("tab", { name: /clip\.mp4/ })).toBeInTheDocument();
  });

  it("switches back to the live preview without closing anything", () => {
    useEditor.setState({
      mediaTabs: [{ ref: "m_1", transient: false }],
      activeMediaTab: "m_1",
      mediaNames: { m_1: "beach.mp4" },
    });
    render(<PreviewTabs />);
    fireEvent.click(screen.getByRole("tab", { name: "Live preview" }));
    expect(useEditor.getState().activeMediaTab).toBeNull();
    expect(useEditor.getState().mediaTabs).toHaveLength(1);
  });

  it("closing the tab you are on returns to a tab that exists", () => {
    useEditor.setState({
      mediaTabs: [{ ref: "m_1", transient: false }],
      activeMediaTab: "m_1",
      mediaNames: { m_1: "beach.mp4" },
    });
    render(<PreviewTabs />);
    fireEvent.click(screen.getByLabelText("close beach.mp4"));
    expect(useEditor.getState().mediaTabs).toEqual([]);
    expect(useEditor.getState().activeMediaTab).toBeNull();
  });

  // The visible half of the anti-spam rule: a transient tab is marked as such, so the user
  // can tell which one the next click will take away.
  it("marks the recycled tab apart from a kept one", () => {
    useEditor.setState({
      mediaTabs: [
        { ref: "m_1", transient: false },
        { ref: "m_2", transient: true },
      ],
      activeMediaTab: "m_2",
      mediaNames: { m_1: "kept.mp4", m_2: "browsing.mp4" },
    });
    render(<PreviewTabs />);
    const kept = screen.getByRole("tab", { name: "kept.mp4" });
    const browsing = screen.getByRole("tab", { name: /browsing\.mp4/ });
    expect(browsing.className).toContain("italic");
    expect(kept.className).not.toContain("italic");
  });

  it("double-clicking a tab keeps it through the next library click", () => {
    useEditor.setState({
      mediaTabs: [{ ref: "m_1", transient: true }],
      activeMediaTab: "m_1",
      mediaNames: { m_1: "beach.mp4" },
    });
    render(<PreviewTabs />);
    fireEvent.doubleClick(screen.getByRole("tab", { name: /beach\.mp4/ }));
    useEditor.getState().openMediaTab("m_2");
    expect(useEditor.getState().mediaTabs.map((t) => t.ref)).toEqual(["m_1", "m_2"]);
  });

  it("marks exactly one tab selected", () => {
    useEditor.setState({
      mediaTabs: [
        { ref: "m_1", transient: false },
        { ref: "m_2", transient: false },
      ],
      activeMediaTab: "m_2",
      mediaNames: { m_1: "a.mp4", m_2: "b.mp4" },
    });
    render(<PreviewTabs />);
    const strip = screen.getByRole("tablist");
    const on = within(strip)
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("aria-selected") === "true");
    expect(on.map((t) => t.textContent)).toEqual(["b.mp4"]);
  });
});
