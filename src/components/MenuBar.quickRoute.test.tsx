// The Export dialog opened through the real menu bar: the switch `quick_route` is read once, as the dialog opens, and decides which settings the dialog draws; what the new view starts is what the 0.28.0 dialog starts
// (the tool `export` is run with the same arguments and options, and no `exportRoute`); nothing the person picked survives the opening. The tool host is a fake, as in MenuBar.test.tsx, and the app's look at the
// encoder is answered by a stub, as in the dialog's own tests. The unit suite lifts the switch (it is ON unless a case turns it off), so every case here says which way it is.
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
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
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
  __resetExportFlags();
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

const renderBar = () =>
  render(
    <MemoryRouter initialEntries={["/p/test"]}>
      <MenuBar />
    </MemoryRouter>,
  );
const openFromMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "File" }));
  fireEvent.click(screen.getByText("Export Video (.mp4)\u2026"));
};
const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
const newView = () => screen.queryByRole("button", { name: "Advanced settings" });
const legacyView = () => screen.queryByRole("option", { name: /Near-lossless, large file/ });

describe("the menu bar decides which settings the Export dialog draws, once per opening", () => {
  it("draws the new view when the switch is on", () => {
    __setExportFlag("quick_route", true);
    renderBar();
    openFromMenu();
    expect(screen.getByRole("dialog", { name: "export video" })).toBeInTheDocument();
    expect(newView()).toBeInTheDocument();
    expect(legacyView()).toBeNull();
    expect(screen.getByRole("combobox", { name: "resolution" })).toHaveDisplayValue(
      "Same as project (1920 x 1080)",
    );
  });

  it("draws the 0.28.0 settings when the switch is off", () => {
    __setExportFlag("quick_route", false);
    renderBar();
    openFromMenu();
    expect(screen.getByRole("dialog", { name: "export video" })).toBeInTheDocument();
    expect(legacyView()).toBeInTheDocument();
    expect(newView()).toBeNull();
    expect(screen.getByRole("option", { name: /Near-lossless, large file/ })).toBeInTheDocument();
  });

  it("keeps the view an opening began with when the switch turns off under the open dialog, and reads the switch again at the next opening", async () => {
    __setExportFlag("quick_route", true);
    renderBar();
    openFromMenu();
    expect(newView()).toBeInTheDocument();

    __setExportFlag("quick_route", false); // the server turns it off while the dialog is open
    fireEvent.click(screen.getByRole("button", { name: "Edit" })); // the menu bar draws again
    expect(screen.getByText("Undo")).toBeInTheDocument(); // (it did: its Edit menu is open)
    expect(newView()).toBeInTheDocument();
    expect(legacyView()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    openFromMenu();
    expect(legacyView()).toBeInTheDocument();
    expect(newView()).toBeNull();

    __setExportFlag("quick_route", true); // and the other way: it comes back on under an open dialog
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Undo")).toBeInTheDocument();
    expect(legacyView()).toBeInTheDocument();
    expect(newView()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    openFromMenu();
    expect(newView()).toBeInTheDocument();
    expect(legacyView()).toBeNull();
    await settle();
  });

  it("starts every opening on the project's own settings: nothing picked in the last one is kept", async () => {
    __setExportFlag("quick_route", true);
    const user = userEvent.setup();
    renderBar();
    openFromMenu();
    await user.selectOptions(screen.getByRole("combobox", { name: "resolution" }), "720p");
    await user.click(newView()!);
    await user.selectOptions(screen.getByLabelText("quality"), "Low");
    expect(screen.getByRole("combobox", { name: "resolution" })).toHaveDisplayValue("720p");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    openFromMenu();
    expect(screen.getByRole("combobox", { name: "resolution" })).toHaveDisplayValue(
      "Same as project (1920 x 1080)",
    );
    expect(newView()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("quality")).toHaveDisplayValue("Medium");
    await settle();
  });
});

// Where the switch is read decides the FIRST draw of an opening, which a look at the screen after React has settled cannot see: read in an effect after the dialog opened, the first draw would show the
// last opening's view (and that view's look would ask the app) before the effect put it right. So what is on screen is written down each time the app is asked about the encoder.
describe("the first draw of an opening is the view the switch said at the click", () => {
  type Seen = { newView: boolean; legacyView: boolean };
  const NEW_VIEW: Seen = { newView: true, legacyView: false };
  const LEGACY_VIEW: Seen = { newView: false, legacyView: true };

  /** Open Export from the menu once for each entry (the switch set to it just before the click), cancel each time, and return what was on screen each time the app was asked, opening by opening. */
  async function askedAtEachOpening(switches: boolean[]): Promise<Seen[][]> {
    const onScreen: Seen[] = [];
    vi.mocked(decideExportEncoder).mockImplementation(async () => {
      onScreen.push({ newView: newView() !== null, legacyView: legacyView() !== null });
      return decision();
    });
    renderBar();
    const perOpening: Seen[][] = [];
    for (const quick of switches) {
      __setExportFlag("quick_route", quick);
      onScreen.length = 0;
      openFromMenu();
      await settle();
      perOpening.push([...onScreen]);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    }
    return perOpening;
  }

  it("on at one opening and off at the next: the app is asked once at each, from the view the switch said, and never first from the other one", async () => {
    expect(await askedAtEachOpening([true, false])).toEqual([[NEW_VIEW], [LEGACY_VIEW]]);
  });

  it("off at one opening and on at the next: the same, the other way round", async () => {
    expect(await askedAtEachOpening([false, true])).toEqual([[LEGACY_VIEW], [NEW_VIEW]]);
  });

  it("the same holds through a longer run of openings, with the switch repeating and changing", async () => {
    expect(await askedAtEachOpening([true, true, false, false, true])).toEqual([
      [NEW_VIEW],
      [NEW_VIEW],
      [LEGACY_VIEW],
      [LEGACY_VIEW],
      [NEW_VIEW],
    ]);
  });
});

// The 0.28.0 dialog is the oracle: for the same project, look and picks the tool `export` is run with the same arguments and options, and the new view adds nothing to them.
describe("Export from the new view runs the export tool as the 0.28.0 dialog does", () => {
  type Run = { args: Record<string, unknown>; options: Record<string, unknown> };

  /** Open Export from the menu in one view, make the picks, press Export and return what the tool was run with. */
  async function exportedIn(
    quick: boolean,
    pick: (user: ReturnType<typeof userEvent.setup>) => Promise<void> = async () => {},
  ): Promise<Run> {
    __setExportFlag("quick_route", quick);
    runTool.mockClear();
    useExportJob.getState().reset();
    const user = userEvent.setup();
    const view = renderBar();
    openFromMenu();
    await settle();
    await pick(user);
    await user.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(runTool).toHaveBeenCalledTimes(1));
    const [name, args, options] = runTool.mock.calls[0];
    expect(name).toBe("export");
    await waitFor(() => expect(useExportJob.getState().phase).toBe("done"));
    view.unmount();
    return { args, options };
  }

  const picksLegacy = async () => {
    fireEvent.change(screen.getByLabelText("resolution"), { target: { value: "720p" } });
    fireEvent.change(screen.getByLabelText("quality"), { target: { value: "low" } });
    fireEvent.change(screen.getByLabelText("frame rate"), { target: { value: "24" } });
  };
  const picksNew = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.selectOptions(screen.getByRole("combobox", { name: "resolution" }), "720p");
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
    await user.selectOptions(screen.getByLabelText("quality"), "Low");
    await user.selectOptions(screen.getByLabelText("frame rate"), "24 fps");
  };

  it("untouched: the project's own size, Medium, no frame rate at all, the app left to choose its encoder, and no route", async () => {
    const legacy = await exportedIn(false);
    const quick = await exportedIn(true);
    expect(legacy.args).toEqual({ resolution: "source", quality: "medium" });
    expect(quick.args).toEqual({ resolution: "source", quality: "medium" });
    expect("fps" in quick.args).toBe(false); // `fps: null` would fail the tool's integer type
    expect(quick.options.exportMode).toBeUndefined(); // the look had answered: nothing is the person's pick
    expect(legacy.options.exportMode).toBeUndefined();
    expect(quick.options).toMatchObject({ surface: "app", model: "", transcriptId: "" });
    expect("exportRoute" in quick.options).toBe(false);
    expect(Object.keys(quick.options).sort()).toEqual(Object.keys(legacy.options).sort());
  });

  it("with the person's picks: the size, the quality and the frame rate they chose", async () => {
    const legacy = await exportedIn(false, picksLegacy);
    const quick = await exportedIn(true, picksNew);
    expect(legacy.args).toEqual({ resolution: "720p", quality: "low", fps: 24 });
    expect(quick.args).toEqual({ resolution: "720p", quality: "low", fps: 24 });
    expect("exportRoute" in quick.options).toBe(false);
  });

  it("before the app has answered about the encoder: Full quality is asked for, in both views", async () => {
    vi.mocked(decideExportEncoder).mockReturnValue(new Promise(() => undefined));
    const legacy = await exportedIn(false);
    const quick = await exportedIn(true);
    expect(legacy.options.exportMode).toBe("quality");
    expect(quick.options.exportMode).toBe("quality");
    expect(quick.args).toEqual({ resolution: "source", quality: "medium" });
  });

  it("with no project figures for the dialog to read: the new view still exports, as Full quality, as the 0.28.0 dialog does", async () => {
    ed.timeline = null; // the menu bar has no workload to hand over
    const legacy = await exportedIn(false);
    const quick = await exportedIn(true);
    expect(legacy.args).toEqual({ resolution: "source", quality: "medium" });
    expect(quick.args).toEqual(legacy.args);
    expect(quick.options.exportMode).toBe("quality");
    expect(legacy.options.exportMode).toBe("quality");
  });
});
