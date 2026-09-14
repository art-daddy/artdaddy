// Save As for a video export — the desktop path only.
//
// This lives in its own file because the behaviour is gated on `platform.name === "tauri"`,
// and the existing MenuBar suite runs as "web" (jsdom has no __TAURI_INTERNALS__). Every one
// of those tests passes without ever opening a save dialog, so none of them can see this
// feature break. Mocking the platform here is the whole point of the separation.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ed = {
  selection: null as string | null,
  clipboard: null as unknown,
  dirty: false,
  zoom: 40,
  playhead: 2,
  timeline: { canvas: { fps: 30 } },
  store: {
    projectDir: "C:/Users/me/AppData/Akaru/projects/Alpha Cut",
    downloadDir: async () => "C:/Users/test/Downloads",
  },
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
  projects: [],
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

// The desktop shell. Without this the whole feature is skipped.
vi.mock("../platform", () => ({
  platform: { name: "tauri", capabilities: {}, apiBaseUrl: "http://x" },
}));

const save = vi.fn(async () => "D:/Client Work/hero cut.mp4" as string | null);
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));

const runTool = vi.fn(async () => ({ ok: true, saved_to: "hero cut.mp4" }));
vi.mock("../tools/host", () => ({ openToolHost: () => ({ run: runTool }) }));

// Unrelated to Save As — just satisfies MenuBar's Clerk imports so it can mount.
import MenuBar from "./MenuBar";
import { useExportJob } from "../store/exportJob";

function renderBar() {
  return render(
    <MemoryRouter initialEntries={["/p/test"]}>
      <MenuBar />
    </MemoryRouter>,
  );
}

function openExport() {
  fireEvent.click(screen.getByRole("button", { name: "File" }));
  fireEvent.click(screen.getByText("Export Video (.mp4)\u2026"));
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
}

function startExport() {
  renderBar();
  openExport();
}

/** Tear the bar down and mount a fresh one — a second export in a NEW app session, which
 *  is the only way to prove the folder was persisted rather than held in component state. */
function restartExport() {
  cleanup();
  renderBar();
  openExport();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useExportJob.getState().reset();
  save.mockResolvedValue("D:/Client Work/hero cut.mp4");
  runTool.mockResolvedValue({ ok: true, saved_to: "hero cut.mp4" });
});

describe("Export Video → Save As", () => {
  it("renders to the folder the user picked, through the same export tool", async () => {
    startExport();
    await waitFor(() =>
      expect(runTool).toHaveBeenCalledWith(
        "export",
        expect.objectContaining({ output_path: "D:/Client Work/hero cut.mp4" }),
        expect.anything(),
      ),
    );
    // And the result names where it actually went. The old copy said "to Downloads"
    // unconditionally, which becomes a lie the moment the user chooses anywhere else.
    await waitFor(() =>
      expect(screen.getByText(/Saved to D:\/Client Work\/hero cut\.mp4/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Downloads/)).not.toBeInTheDocument();
  });

  it("cancelling the save dialog starts NO render and leaves no job behind", async () => {
    // The failure direction. `job.begin()` used to run before anything could refuse, so a
    // cancel here would strand the dialog in "preparing" with no ffmpeg attached to it and
    // no way to reach "done" — and `exportRunning()` would then refuse every later export.
    save.mockResolvedValue(null);
    startExport();
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(runTool).not.toHaveBeenCalled();
    expect(useExportJob.getState().phase).toBe("idle");
    // Still usable: a second attempt that goes through is not blocked by the cancelled one.
    save.mockResolvedValue("D:/Client Work/second.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(runTool).toHaveBeenCalledTimes(1));
  });

  it("pre-fills the project's name, then re-opens in the folder used last time", async () => {
    startExport();
    // First time: no memory, so the tool's own default (Downloads) with the project name.
    // The stem comes from the REAL rule in render.ts, not a copy — a local copy here would
    // agree with itself while drifting from what the agent produces.
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: "C:/Users/test/Downloads/Alpha Cut.mp4",
        }),
      ),
    );
    await waitFor(() => expect(runTool).toHaveBeenCalled());

    // Second time: opens where the last export landed, not back at Downloads.
    save.mockClear();
    restartExport();
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ defaultPath: "D:/Client Work/Alpha Cut.mp4" }),
      ),
    );
  });

  it("does not remember a folder for an export the user cancelled", async () => {
    save.mockResolvedValue(null);
    startExport();
    await waitFor(() => expect(save).toHaveBeenCalled());
    save.mockClear();
    save.mockResolvedValue("D:/Client Work/x.mp4");
    restartExport();
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ defaultPath: "C:/Users/test/Downloads/Alpha Cut.mp4" }),
      ),
    );
  });

  it("reports a save-dialog failure instead of silently exporting somewhere else", async () => {
    save.mockRejectedValue(new Error("dialog unavailable"));
    startExport();
    await waitFor(() => expect(screen.getByText(/dialog unavailable/)).toBeInTheDocument());
    expect(runTool).not.toHaveBeenCalled();
  });
});
