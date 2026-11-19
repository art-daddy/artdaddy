// The Export dialog as a SHIPPED build has it. The unit suite's mode is "test", where nothing is held, so a green dialog suite says nothing about a build that holds `estimate_v2` and `pc_check`
// (api/exportFlags.ts, OFF_IN_THIS_BUILD) and no longer holds `quick_route`. Here the hold is ON (`__setHeldOffByBuild(true)`, as in a production build). The Quality | Fast choice is PARKED in this
// release: `FAST_CHOICE_OFFERED` (timeline/exportChoiceView.ts) is false, so the real dialog draws Quality alone whatever the server's switch says. The choice is parked, not deleted, so its wiring stays held:
// the first describe forces the constant on, as every other Fast test does (the real dialog without it is also held by ExportDialog.noChoiceConstant.test.tsx), and holds the real menu bar opening the dialog
// with the choice, a Fast pick reaching the tool host as the route slot with the flags of what the person set, and the server's switch taking the choice away. The last describe reads the constant as the
// build has it and holds what a person gets today. The tool host is a fake, as in MenuBar.fastWire.test.tsx; the same journey through the real export tool is in timeline/exportFast.journey.test.ts
// (case 3b) and exportFast.dialog.journey.test.tsx (D).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `forced` is the one switch between the two kinds of test below: true (the default, set before every test) holds the choice offered whatever the constant says, as the other Fast tests do with
// `FAST_CHOICE_OFFERED: true`; the last describe sets it false and the getter then hands back the constant as the build has it.
const choice = vi.hoisted(() => ({ forced: true }));
vi.mock("../timeline/exportChoiceView", async (importOriginal) => {
  const real = await importOriginal<typeof import("../timeline/exportChoiceView")>();
  return {
    ...real,
    get FAST_CHOICE_OFFERED() {
      return choice.forced ? true : real.FAST_CHOICE_OFFERED;
    },
  };
});

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
  choice.forced = true; // the last describe sets it false to read the constant as the build has it
  ed.selection = null;
  ed.clipboard = null;
  ed.dirty = false;
  ed.timeline = projectOf(1920, 1080, 30) as never;
  authState.status = "locked";
  localStorage.clear();
  // A shipped build: the hold is on and the server's switch for Fast is what the build and the server give it (no `__setExportFlag("quick_route", ...)`).
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

describe("the Export dialog of a shipped build, the parked Fast choice forced on (the hold on the estimate and the speed check; the Fast switch not held)", () => {
  it("is the state this file means: the estimate and the speed check are held off by the build, the Fast switch is not held and is on", () => {
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

// What a person gets TODAY: the constant is read as the build has it (false: the choice is parked, see exportChoiceView.ts), the hold is on, and the server's switch for Fast is on too.
// This is the shipped path through the real menu bar; ExportDialog.noChoiceConstant.test.tsx holds the same state at the dialog without the menu bar and the hold. The day the choice is offered
// again, the constant becomes true and this describe is the one that has to change (its Fast tests above already run with it on).
describe("the Export dialog of a shipped build as it is: the Fast choice is parked (FAST_CHOICE_OFFERED false)", () => {
  beforeEach(() => {
    choice.forced = false;
  });

  it("draws no Quality | Fast choice and no Mode row though the server's switch for Fast is on, and Export hands the tool host Quality's call with no route slot", async () => {
    expect(exportFlag("quick_route")).toBe(true);
    const user = await openExportDialog();
    const parked =
      "the shipped build draws the Fast choice: FAST_CHOICE_OFFERED is true again, so this describe is out of date";
    expect(screen.queryByRole("radiogroup", { name: "export choice" }), parked).toBeNull();
    expect(screen.queryByRole("radio", { name: "Fast" }), parked).toBeNull();
    expect(screen.queryByRole("radio", { name: "Quality" }), parked).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "export mode" })).toBeNull();
    expect(screen.queryByLabelText("export estimate")).toBeNull();
    // The dialog is still the dialog: its lists are there and Export is one button.
    expect(screen.getByLabelText("resolution")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(runTool).toHaveBeenCalledTimes(1));
    const [name, args, options] = runTool.mock.calls[0];
    await waitFor(() => expect(useExportJob.getState().phase).toBe("done"));
    expect(name).toBe("export");
    expect(args).toEqual({ resolution: "source", quality: "medium" });
    expect(options.exportRoute).toBeUndefined();
    expect(options.exportMode).toBeUndefined();
  });
});
