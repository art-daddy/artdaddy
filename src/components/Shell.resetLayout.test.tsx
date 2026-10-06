// Reset Panel Layout used to reload the page, which release builds now refuse. Real panels, in
// their BROWSER build: vitest resolves the node build, which neither saves nor keyboard-resizes.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "react-resizable-panels",
  // @ts-expect-error -- the browser build ships no .d.ts of its own; the package's types describe it.
  () => import("../../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.esm.js"),
);
vi.mock("./ProjectSidebar", () => ({ default: () => <div>library</div> }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("./StagePanel", () => ({ default: ({ projectId }: any) => <div>stage:{projectId}</div> }));
vi.mock("./ChatView", () => ({ default: () => <div>chat</div> }));
vi.mock("./Inspector", () => ({ default: () => <div>inspector</div> }));
vi.mock("./TimelineEditor", () => ({ default: () => <div>timeline</div> }));

// STABLE identities: Shell's activation effect depends on `open` and `navigate`.
const navigate = vi.fn();
const openMock = vi.fn(() => Promise.resolve());
vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});
vi.mock("../store/projects", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useProjects: (sel: any) => sel({ open: openMock }),
}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/chat", () => ({ useChat: (sel: any) => sel({}) }));
vi.mock("../store/editor", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useEditor: (sel: any) => sel({ selectedIds: [] }),
}));
vi.mock("../tools/host", () => ({
  openToolHost: () => ({ ready: Promise.resolve() }),
  closeToolHost: () => undefined,
}));
vi.mock("../project/documentRegistry", () => ({
  projectDocuments: {
    open: () => Promise.resolve({}),
    close: () => Promise.resolve(),
    whenIdle: () => Promise.resolve(),
    firstCloseFailed: () => undefined,
  },
}));

import Shell from "./Shell";
import { usePanes } from "../store/panes";

const OUTER = "react-resizable-panels:artdaddy-layout-v4";

const sizes = (root: HTMLElement): number[] =>
  [...root.querySelectorAll("[data-panel-size]")].map((e) =>
    Number(e.getAttribute("data-panel-size")),
  );

async function showProject() {
  const r = render(<Shell projectId="p1" />);
  await waitFor(() => expect(screen.getByText("timeline")).toBeInTheDocument());
  return r;
}

/** Widen the assistant pane the way a keyboard user does: the handle between it and the editor. */
function widenAssistant(root: HTMLElement): void {
  const handles = [...root.querySelectorAll<HTMLElement>("[data-panel-resize-handle-id]")];
  const handle = handles[handles.length - 1];
  handle.focus();
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
}

beforeEach(() => {
  localStorage.clear();
  usePanes.setState({ visible: { library: true, inspector: false, chat: true } });
});
afterEach(() => vi.clearAllMocks());

describe("Reset Panel Layout", () => {
  it("puts the panels back to their default sizes in place, and they stay there", async () => {
    const { container, unmount } = await showProject();
    const defaults = sizes(container);
    expect(defaults.length).toBeGreaterThan(0);
    widenAssistant(container);
    await waitFor(() => expect(sizes(container)).not.toEqual(defaults));

    act(() => usePanes.getState().resetLayout());

    // The same page, no reload: the panels lay themselves out from their own defaults.
    await waitFor(() => expect(sizes(container)).toEqual(defaults));
    expect(screen.getByText("timeline")).toBeInTheDocument();

    // And the next launch does not bring the dragged sizes back.
    await new Promise((r) => setTimeout(r, 150)); // the library saves on a 100 ms debounce
    unmount();
    const again = await showProject();
    expect(sizes(again.container)).toEqual(defaults);
  });

  it("forgets every saved panel size and nothing else", () => {
    localStorage.setItem(OUTER, "{}");
    localStorage.setItem("react-resizable-panels:artdaddy-top-v1", "{}");
    localStorage.setItem("artdaddy-panes-v1", JSON.stringify({ chat: false }));
    localStorage.setItem("unrelated", "keep");
    act(() => usePanes.getState().resetLayout());
    expect(localStorage.getItem(OUTER)).toBeNull();
    expect(localStorage.getItem("react-resizable-panels:artdaddy-top-v1")).toBeNull();
    // Which panes are SHOWN is a separate choice (View -> Show All Panels), and survives.
    expect(localStorage.getItem("artdaddy-panes-v1")).not.toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });
});
