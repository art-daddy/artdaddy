import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ed = {
  selection: null as string | null,
  clipboard: null as unknown,
  dirty: false as boolean,
  zoom: 40,
  playhead: 2,
  timeline: { canvas: { fps: 30 } },
  undo: vi.fn(),
  redo: vi.fn(),
  copyClip: vi.fn(),
  pasteClip: vi.fn(),
  deleteClips: vi.fn(),
  duplicateClip: vi.fn(),
  splitClip: vi.fn(),
  setZoom: vi.fn(),
};
vi.mock("../store/editor", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useEditor: Object.assign((sel: any) => sel(ed), { getState: () => ed }),
}));

const proj = {
  projects: [{ id: "p1", name: "Alpha", path: "" }],
  create: vi.fn(),
  refresh: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  removePermanently: vi.fn(),
};
vi.mock("../store/projects", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useProjects: (sel?: any) => (sel ? sel(proj) : proj),
}));

// Clerk cannot run in this webview at all; MenuBar drives sign-in through the desktop-auth
// flow instead (system browser + deep-link handoff), gated on the same auth store ChatView uses.
const authState = vi.hoisted(() => ({
  status: "locked" as "locked" | "unlocked",
  markLocked: vi.fn(),
  profile: null as { display_name: string; email: string; image_url: string; user_id: string } | null,
}));
vi.mock("../store/auth", () => ({
  useAuth: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sel: any) => sel(authState),
    { getState: () => authState },
  ),
}));
const startDesktopSignIn = vi.hoisted(() => vi.fn());
const signOutDesktop = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../api/desktopAuth", () => ({ startDesktopSignIn, signOutDesktop }));

import MenuBar from "./MenuBar";
import { usePanes } from "../store/panes";
import { BRAND } from "../brand";
import { useExportJob } from "../store/exportJob";
import { unknownParams } from "../contract/params";

const runTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
  const unknown = unknownParams(name, args);
  return unknown.length
    ? { ok: false, error: `${name}: unknown param(s) ${unknown.join(", ")}` }
    : { ok: true, saved_to: "alpha.mp4" };
});
vi.mock("../tools/host", () => ({ openToolHost: () => ({ run: runTool }) }));

function Loc() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname}</div>;
}

function renderBar(path = "/p/test") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MenuBar />
      <Loc />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  ed.selection = null;
  ed.clipboard = null;
  ed.dirty = false;
  authState.status = "locked";
  useExportJob.getState().reset(); // a module-level job would leak a finished render between tests
  proj.create.mockResolvedValue({ id: "pNew" });
});

describe("MenuBar", () => {
  it("renders the top-level menus", () => {
    renderBar();
    for (const m of ["File", "Edit", "View", "Window", "Help"]) {
      expect(screen.getByRole("button", { name: m })).toBeInTheDocument();
    }
  });

  it("shows an Unsaved badge when the editor is dirty with a project open", () => {
    ed.dirty = true;
    renderBar("/p/test");
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  it("hides the Unsaved badge when the timeline is clean", () => {
    ed.dirty = false;
    renderBar("/p/test");
    expect(screen.queryByText("Unsaved")).not.toBeInTheDocument();
  });

  it("creates a project via File → New", async () => {
    renderBar("/");
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByText("New Project…"));
    fireEvent.change(screen.getByPlaceholderText(/Project name/), { target: { value: "Reel" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(proj.create).toHaveBeenCalledWith("Reel", "9:16", undefined, undefined),
    );
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/p/pNew"));
  });

  it("cancels the New dialog", () => {
    renderBar("/");
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByText("New Project…"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText(/Project name/)).not.toBeInTheDocument();
  });

  it("File → Export Video renders through the SAME `export` tool the agent uses", async () => {
    // The point of the assertion is the delegation: a second, menu-only renderer
    // would drift from the agent's. Asserting the menu item exists would not catch that.
    renderBar("/p/test");
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByText("Export Video (.mp4)…"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() =>
      expect(runTool).toHaveBeenCalledWith(
        "export",
        { resolution: "source", quality: "medium" },
        expect.anything(),
      ),
    );
    await waitFor(() => expect(screen.getByText(/Saved alpha\.mp4/)).toBeInTheDocument());
  });

  it("sends the chosen delivery settings, not the defaults", async () => {
    renderBar("/p/test");
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByText("Export Video (.mp4)…"));
    fireEvent.change(screen.getByLabelText("resolution"), { target: { value: "720p" } });
    fireEvent.change(screen.getByLabelText("quality"), { target: { value: "low" } });
    fireEvent.change(screen.getByLabelText("frame rate"), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() =>
      expect(runTool).toHaveBeenCalledWith(
        "export",
        expect.objectContaining({ resolution: "720p", quality: "low", fps: 24 }),
        expect.anything(),
      ),
    );
  });

  it("omits fps entirely when the project's own rate is kept", async () => {
    // Sending `fps: null` would fail the contract's integer type; the option must be absent.
    renderBar("/p/test");
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByText("Export Video (.mp4)…"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() =>
      expect(runTool).toHaveBeenCalledWith(
        "export",
        expect.not.objectContaining({ fps: expect.anything() }),
        expect.anything(),
      ),
    );
  });

  it("surfaces an export failure instead of reporting success", async () => {
    runTool.mockResolvedValueOnce({ ok: false, error: "no clips to render" } as never);
    renderBar("/p/test");
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByText("Export Video (.mp4)…"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(screen.getByText(/no clips to render/)).toBeInTheDocument());
  });

  it("export is disabled with no project open", () => {
    renderBar("/");
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    expect(screen.getByText("Export Video (.mp4)…").closest("button")).toBeDisabled();
  });

  it("opens an existing project, and renames/deletes from the Open dialog", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Beta");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderBar("/");
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByText("Open Project…"));
    expect(proj.refresh).toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("Rename"));
    expect(proj.rename).toHaveBeenCalledWith("p1", "Beta");
    fireEvent.click(screen.getByTitle("Delete"));
    await waitFor(() => expect(proj.remove).toHaveBeenCalledWith("p1"));
    fireEvent.click(screen.getByText("Alpha"));
    expect(screen.getByTestId("loc").textContent).toBe("/p/p1");
  });

  it("offers an explicit permanent delete when trashing fails (R12)", async () => {
    proj.remove.mockResolvedValueOnce({ trashFailed: true, error: "nope" });
    vi.spyOn(window, "confirm").mockReturnValue(true); // confirm BOTH the trash + permanent prompts
    renderBar("/");
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByText("Open Project…"));
    fireEvent.click(screen.getByTitle("Delete"));
    await waitFor(() => expect(proj.removePermanently).toHaveBeenCalledWith("p1"));
  });

  it("Edit menu runs the editor actions", () => {
    ed.selection = "c1";
    ed.clipboard = { clip: {} };
    renderBar("/p/test");
    const openEdit = () => fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    openEdit();
    fireEvent.click(screen.getByText("Undo"));
    expect(ed.undo).toHaveBeenCalled();
    openEdit();
    fireEvent.click(screen.getByText("Redo"));
    expect(ed.redo).toHaveBeenCalled();
    openEdit();
    fireEvent.click(screen.getByText("Copy"));
    expect(ed.copyClip).toHaveBeenCalledWith("c1");
    openEdit();
    fireEvent.click(screen.getByText("Paste"));
    expect(ed.pasteClip).toHaveBeenCalled();
    openEdit();
    fireEvent.click(screen.getByText("Delete"));
    expect(ed.deleteClips).toHaveBeenCalledWith(["c1"]);
    openEdit();
    fireEvent.click(screen.getByText("Duplicate"));
    expect(ed.duplicateClip).toHaveBeenCalledWith("c1");
    openEdit();
    fireEvent.click(screen.getByText("Split at Playhead"));
    expect(ed.splitClip).toHaveBeenCalledWith("c1", 60);
    openEdit();
    fireEvent.click(screen.getByText("Cut"));
    expect(ed.deleteClips).toHaveBeenCalledWith(["c1"]);
  });

  it("View menu zooms in and out", () => {
    renderBar("/p/test");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByText("Zoom In"));
    expect(ed.setZoom).toHaveBeenCalledWith(40 * 1.3);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByText("Zoom Out"));
    expect(ed.setZoom).toHaveBeenCalledWith(40 / 1.3);
  });

  it("Help → About opens and closes", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    fireEvent.click(screen.getByText(`About ${BRAND.displayName}`));
    expect(screen.getByText(/AI video editor/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText(/AI video editor/)).not.toBeInTheDocument();
  });

  // The server-override control used to live in the (now-deleted) legacy SignInDialog;
  // it moved into About so the capability survives Clerk becoming the only auth door.
  it("About → Server lets you point the app at a different backend", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    fireEvent.click(screen.getByText(`About ${BRAND.displayName}`));
    fireEvent.click(screen.getByText("Server"));
    fireEvent.change(screen.getByLabelText("Server address"), {
      target: { value: "https://staging.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this server" }));
    expect(screen.getByText(/Now using https:\/\/staging\.example\.com/)).toBeInTheDocument();
  });

  it("offers the profile and the way out from the account menu", () => {
    // Signing IN is no longer reachable from here: the app is gated, so a signed-out user
    // never sees the menu bar at all.
    authState.status = "unlocked";
    renderBar("/p/test");
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    expect(screen.getByRole("menuitem", { name: "Profile" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });

  it("shows a Sign out control that clears the session when signed in", async () => {
    authState.status = "unlocked";
    renderBar("/p/test");
    fireEvent.click(screen.getByRole("button", { name: /account/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(signOutDesktop).toHaveBeenCalledOnce());
    expect(authState.markLocked).toHaveBeenCalledOnce();
  });

  it("File → Close Project closes then navigates home", async () => {
    renderBar("/p/test");
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByText("Close Project"));
    // Close Project now goes through the controlled switch (close the current project first, then
    // navigate), so the home navigation lands a tick later.
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/"));
  });
});

// Driving the shipped app on macOS showed Cmd+0 toggling the library while Cmd+Alt+A and
// Cmd+Alt+0 did nothing at all. Option is a TEXT modifier there, so the browser reports
// e.key as "å"/"º" and matching on it could never fire. These press what macOS really sends.
describe("View shortcuts, on the keys each platform really sends", () => {
  const press = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  const ALL = { library: true, inspector: true, chat: true };

  beforeEach(() => usePanes.setState({ visible: { ...ALL } }));

  it("toggles the library on Ctrl+0, and back on Cmd+0", () => {
    renderBar();
    press({ ctrlKey: true, key: "0", code: "Digit0" });
    expect(usePanes.getState().visible.library).toBe(false);
    press({ metaKey: true, key: "0", code: "Digit0" });
    expect(usePanes.getState().visible.library).toBe(true);
  });

  it("toggles chat on Cmd+Alt+A although macOS reports the key as 'å'", () => {
    renderBar();
    press({ metaKey: true, altKey: true, key: "å", code: "KeyA" });
    expect(usePanes.getState().visible.chat).toBe(false);
    expect(usePanes.getState().visible.library).toBe(true);
  });

  it("toggles the inspector on Cmd+Alt+0 although macOS reports the key as 'º'", () => {
    renderBar();
    press({ metaKey: true, altKey: true, key: "º", code: "Digit0" });
    expect(usePanes.getState().visible.inspector).toBe(false);
    expect(usePanes.getState().visible.library).toBe(true); // Alt picks the inspector, not the library
  });

  it("does nothing without Ctrl or Cmd", () => {
    renderBar();
    press({ key: "0", code: "Digit0" });
    press({ altKey: true, key: "å", code: "KeyA" });
    expect(usePanes.getState().visible).toEqual(ALL);
  });
});
