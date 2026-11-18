// The one consistency test between the real menu bar and the reference mapping the Fast dialog journeys use (`callOf` in src/test/fastDialogKit.ts): the journeys turn the object the settings view hands to
// onStart into the call of the `export` tool with that mapping, so the mapping has to be the menu bar's own. Here the real menu bar runs the same Fast pick (the tool host is a fake, as in
// MenuBar.quickRoute.test.tsx) and what it hands the host is compared with the mapping of the same settings view's object, and with the call written out by hand.
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
import ExportSettingsView from "./ExportSettingsView";
import type { ExportSettings } from "./ExportDialog";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { callOf } from "../test/fastDialogKit";
import { useExportJob } from "../store/exportJob";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { emptyTimeline } from "../timeline/model";
import { summarizeRenderWorkload } from "../timeline/renderPlan";

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
  __resetExportFlags();
  __setExportFlag("quick_route", true);
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
  useExportJob.getState().reset();
});

const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
type User = ReturnType<typeof userEvent.setup>;
/** A Fast pick that sets the rate and the quality and leaves the size to Fast. */
const picks = async (user: User) => {
  await user.click(screen.getByRole("radio", { name: "Fast" }));
  await user.click(screen.getByRole("button", { name: "Advanced settings" }));
  await user.selectOptions(screen.getByLabelText("frame rate"), "24 fps");
  await user.selectOptions(screen.getByLabelText("quality"), "High");
};

describe("the real menu bar makes the tool call of the Fast journeys' reference mapping", () => {
  it("a Fast pick of the rate and the quality: the arguments, the route slot and the encoder pick are the mapping's of the same settings view's object, and the hand-written call", async () => {
    // The settings view alone, on the same project: the object it hands to onStart.
    const onStart = vi.fn<(settings: ExportSettings) => void>();
    const workload = summarizeRenderWorkload(ed.timeline as never);
    const alone = render(
      <ExportSettingsView workload={workload} onCancel={() => undefined} onStart={onStart} />,
    );
    await settle();
    const aloneUser = userEvent.setup();
    await picks(aloneUser);
    await aloneUser.click(screen.getByRole("button", { name: "Export" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    const reference = callOf(onStart.mock.calls[0][0]);
    alone.unmount();

    // The real menu bar: Export from the File menu, the same picks, the host called by `exportVideo`.
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/p/test"]}>
        <MenuBar />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByText("Export Video (.mp4)\u2026"));
    await settle();
    await picks(user);
    await user.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(runTool).toHaveBeenCalledTimes(1));
    const [name, args, options] = runTool.mock.calls[0];
    await waitFor(() => expect(useExportJob.getState().phase).toBe("done"));

    expect(name).toBe("export");
    expect(args).toEqual(reference.args);
    expect(options.exportRoute).toEqual(reference.slot);
    expect(options.exportMode).toBe(reference.mode);
    // The call written out by hand: Fast's own size (720p of 1080p), the rate and quality the person picked, and the flags of what they set.
    expect(args).toEqual({ resolution: "720p", quality: "high", fps: 24 });
    expect(options.exportRoute).toEqual({
      route: "quick",
      explicit: { size: false, fps: true, quality: true },
    });
    expect(options.exportMode).toBeUndefined();
    expect(options).toMatchObject({ surface: "app", model: "", transcriptId: "" });
  });
});
