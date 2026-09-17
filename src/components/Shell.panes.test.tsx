// Hiding panels: the rule is other NLEs', and it is what stops the feature becoming a trap.
// Media / inspector / assistant can go; the PREVIEW and the TIMELINE cannot, because an editor you
// can hide leaves an empty window with no obvious way back.
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-resizable-panels", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PanelGroup: ({ children }: any) => <div>{children}</div>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Panel: ({ children }: any) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}));
vi.mock("./ProjectSidebar", () => ({ default: () => <div>library</div> }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("./StagePanel", () => ({ default: ({ projectId }: any) => <div>stage:{projectId}</div> }));
vi.mock("./ChatView", () => ({ default: () => <div>chat</div> }));
vi.mock("./Inspector", () => ({ default: () => <div>inspector</div> }));
vi.mock("./TimelineEditor", () => ({ default: () => <div>timeline</div> }));

// STABLE identities: Shell's activation effect depends on `open` and `navigate`, so a fresh
// function per render re-runs it forever, cancels itself, and the panes never reveal.
const navigate = vi.fn();
const openMock = vi.fn(() => Promise.resolve());
vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/projects", () => ({
  useProjects: (sel: any) => sel({ open: openMock }),
}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/chat", () => ({ useChat: (sel: any) => sel({}) }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/editor", () => ({ useEditor: (sel: any) => sel({}) }));
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
import { usePanes, type PaneId } from "../store/panes";

const ALL: Record<PaneId, boolean> = { library: true, inspector: true, chat: true };

const showProject = async () => {
  render(<Shell projectId="p1" />);
  await waitFor(() => expect(screen.getByText("timeline")).toBeInTheDocument());
};

beforeEach(() => {
  localStorage.clear();
  usePanes.setState({ visible: { ...ALL } });
});
afterEach(() => vi.clearAllMocks());

describe("hiding panels", () => {
  it("shows all three hideable panes by default", async () => {
    await showProject();
    for (const t of ["library", "inspector", "chat"])
      expect(screen.getByText(t)).toBeInTheDocument();
  });

  it.each([
    ["library", "library"],
    ["inspector", "inspector"],
    ["chat", "chat"],
  ] as const)("removes %s from the tree when hidden", async (id, text) => {
    usePanes.setState({ visible: { ...ALL, [id]: false } });
    await showProject();
    expect(screen.queryByText(text)).not.toBeInTheDocument();
  });

  // The rule, stated as an outcome: whatever the user hides, they can still edit.
  it("keeps the preview and the timeline no matter what is hidden", async () => {
    usePanes.setState({ visible: { library: false, inspector: false, chat: false } });
    await showProject();
    expect(screen.getByText("stage:p1")).toBeInTheDocument();
    expect(screen.getByText("timeline")).toBeInTheDocument();
  });
});

describe("pane visibility store", () => {
  it("survives a reload", () => {
    usePanes.getState().toggle("chat");
    expect(usePanes.getState().visible.chat).toBe(false);
    expect(JSON.parse(localStorage.getItem("artdaddy-panes-v1")!).chat).toBe(false);
  });

  it("brings everything back", () => {
    usePanes.setState({ visible: { library: false, inspector: false, chat: false } });
    usePanes.getState().showAll();
    expect(usePanes.getState().visible).toEqual(ALL);
  });

  it("ignores a stored id the View menu no longer offers, so nothing can hide unrecoverably", async () => {
    localStorage.setItem(
      "artdaddy-panes-v1",
      JSON.stringify({ chat: false, ghost: false, library: "nope" }),
    );
    vi.resetModules();
    const { usePanes: fresh } = await import("../store/panes");
    const v = fresh.getState().visible;
    expect(v.chat).toBe(false); // a real id is honoured
    expect(v.library).toBe(true); // a non-boolean is not
    expect("ghost" in v).toBe(false); // an unknown id never enters the state
  });
});
