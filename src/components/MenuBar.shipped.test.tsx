// The Export dialog as a SHIPPED build has it. The unit suite's mode is "test", where nothing is held, so a green dialog suite says nothing about a build that holds `estimate_v2` and `pc_check`
// (api/exportFlags.ts, OFF_IN_THIS_BUILD) and no longer holds `quick_route`. Here the hold is ON (`__setHeldOffByBuild(true)`, as in a production build) and nothing is forced for the Fast choice:
// the real menu bar opens the dialog, the dialog draws the Quality | Fast choice, and a Fast pick reaches the tool host as the route slot with the flags of what the person set. The tool host
// is a fake, as in MenuBar.fastWire.test.tsx; the same journey through the real export tool is in timeline/exportFast.journey.test.ts (case 3b) and exportFast.dialog.journey.test.tsx (D).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ed = {
  selection: null as string | null,
  clipboard: null as unknown,
  dirty: false as boolean,
  zoom: 40,
  playhead: 2,
  timeline: null as unknown,
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

const authState = vi.hoisted(() => ({
  status: "locked" as "locked" | "unlocked",
  markLocked: vi.fn(),
  profile: null as null,
}));
vi.mock("../store/auth", () => ({
  useAuth: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sel: any) => sel(authState),
    { getState: () => authState },
  ),
}));
vi.mock("../api/desktopAuth", () => ({
  startDesktopSignIn: vi.fn(),
  signOutDesktop: vi.fn(async () => {}),
}));

type ToolCall = [name: string, args: Record<string, unknown>, options: Record<string, unknown>];
const runTool = vi.hoisted(() =>
  vi.fn<(...call: ToolCall) => Promise<{ ok: boolean; saved_to?: string }>>(),
);
vi.mock("../tools/host", () => ({ openToolHost: () => ({ run: runTool }) }));
vi.mock("../timeline/exportChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoice")>()),
  decideExportEncoder: vi.fn(),
}));

import MenuBar from "./MenuBar";
import {
  __resetExportFlags,
  __setExportFlag,
  __setHeldOffByBuild,
  exportFlag,
  isOffInThisBuild,
} from "../api/exportFlags";
import { useExportJob } from "../store/exportJob";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { emptyTimeline } from "../timeline/model";

/** What the app decided about the encoder, as the dialog is told: no chip, so no Mode row. */
const decision = (): ExportEncoderDecision => ({
  mode: "quality",
  reason: "none",
  showRow: false,
  defaultMode: "quality",
  fullSeconds: 40,
  fastSeconds: null,
  fullGuessed: true,
  tests: [],
  facts: { encoder: "x264", reason: "none", tests: [] },
});

/** A real timeline of the given canvas with one clip on it, so that the menu bar can read its workload as it does in the app. */
function projectOf(width: number, height: number, fps: number) {
  const timeline = emptyTimeline(width, height, fps);
  timeline.tracks = [
    {
      id: "video",
      kind: "video",
      z: 0,
      clips: [
        {
          id: "a",
          kind: "video",
          media_ref: "media_a",
          source_in: 0,
          source_out: 3600,
          timeline_in: 0,
          timeline_out: 3600,
        },
      ],
    },
  ];
  return timeline;
}

beforeEach(() => {
  ed.selection = null;
  ed.clipboard = null;
  ed.dirty = false;
  ed.timeline = projectOf(1920, 1080, 30) as never;
  authState.status = "locked";
  localStorage.clear();
  // A shipped build: the hold is on and nothing is forced for the Fast choice (no `__setExportFlag("quick_route", ...)`), so the switch is what the build and the server give it.
  __resetExportFlags();
  __setHeldOffByBuild(true);
  useExportJob.getState().reset();
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockResolvedValue(decision());
  runTool.mockReset();
  runTool.mockResolvedValue({ ok: true, saved_to: "alpha.mp4" });
});
afterEach(() => {
  cleanup();
  __resetExportFlags();
  __setHeldOffByBuild(null);
  useExportJob.getState().reset();
});

const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

/** The real menu bar with the Export dialog open, the way a person opens it. */
async function openExportDialog(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/p/test"]}>
      <MenuBar />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "File" }));
  fireEvent.click(screen.getByText("Export Video (.mp4)\u2026"));
  await settle();
  return user;
}

describe("the Export dialog of a shipped build (the hold on the estimate and the speed check, the Fast choice not held)", () => {
  it("is the state this file means: the estimate and the speed check are off, the Fast choice is on", () => {
    expect(isOffInThisBuild("estimate_v2")).toBe(true);
    expect(isOffInThisBuild("pc_check")).toBe(true);
    expect(exportFlag("estimate_v2")).toBe(false);
    expect(exportFlag("pc_check")).toBe(false);
    expect(isOffInThisBuild("quick_route")).toBe(false);
    expect(exportFlag("quick_route")).toBe(true);
  });

  it("draws the Quality | Fast choice with Quality selected, and no Mode row of the 0.28.0 dialog", async () => {
    await openExportDialog();
    const choice = screen.getByRole("radiogroup", { name: "export choice" });
    expect(choice).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Quality" })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: "Fast" })).toHaveProperty("checked", false);
    expect(screen.queryByRole("radiogroup", { name: "export mode" })).toBeNull();
    // The legacy dialog's time line is not drawn, and nothing of the held estimate shows in the dialog.
    expect(screen.queryByLabelText("export estimate")).toBeNull();
  });

  it("hands the tool host the route slot for a Fast pick, with the flags of what the person set, and no slot for Quality", async () => {
    // Fast on a 1080p project at 30: Fast's own size is 720p, the rate stays, Medium; nothing was set by the person.
    const user = await openExportDialog();
    await user.click(screen.getByRole("radio", { name: "Fast" }));
    await user.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(runTool).toHaveBeenCalledTimes(1));
    const [name, args, options] = runTool.mock.calls[0];
    await waitFor(() => expect(useExportJob.getState().phase).toBe("done"));
    expect(name).toBe("export");
    expect(args).toEqual({ resolution: "720p", quality: "medium" });
    expect(options.exportRoute).toEqual({
      route: "quick",
      explicit: { size: false, fps: false, quality: false },
    });
    expect(options.exportMode).toBeUndefined();

    // And the same project at Quality, in the same build state: the project's own size, no slot.
    cleanup();
    useExportJob.getState().reset();
    runTool.mockClear();
    const again = await openExportDialog();
    await again.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(runTool).toHaveBeenCalledTimes(1));
    const [, qualityArgs, qualityOptions] = runTool.mock.calls[0];
    expect(qualityArgs).toEqual({ resolution: "source", quality: "medium" });
    expect(qualityOptions.exportRoute).toBeUndefined();
  });

  it("goes back to the 0.28.0 dialog at the next opening when the server turns the Fast choice off", async () => {
    __setExportFlag("quick_route", false);
    await openExportDialog();
    expect(screen.queryByRole("radiogroup", { name: "export choice" })).toBeNull();
    expect(screen.getByLabelText("resolution")).toBeTruthy();
  });
});
