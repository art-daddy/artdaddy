// The Export dialog opened through the real menu bar: the switch `quick_route` is read once, as the dialog opens, and decides which settings the dialog draws; what the new view starts for Quality is what the 0.28.0 dialog
// starts (the tool `export` is run with the same arguments and options, and no `exportRoute` key at all); Fast, picked in the new view, adds exactly one key, `exportRoute` (the route and which of the size, the frame rate
// and the quality the person touched), and its arguments are the values the dialog showed; nothing the person picked survives the opening. The tool host is a fake, as in MenuBar.test.tsx, and the app's look at the
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

// Fast, picked in the new view of the dialog the menu bar opened. The three rows are read off the screen just before Export is pressed, and the arguments the tool gets are held to them: what is on screen is what is
// sent. The expected values are written out for each project (spec 3.1), never worked out here. The route is the one extra key of Fast's options, and no other export carries it.
type User = ReturnType<typeof userEvent.setup>;
type Canvas = readonly [width: number, height: number, fps: number];
type Lever = "size" | "rate" | "quality";
type Pick = readonly [lever: Lever, option: string];
type Rows = { size: string | null; rate: string | null; quality: string | null };
type Called = { args: Record<string, unknown>; options: Record<string, unknown>; rows: Rows };
type Explicit = { size: boolean; fps: boolean; quality: boolean };

const rowBox = (lever: Lever): HTMLElement | null =>
  lever === "size"
    ? screen.queryByRole("combobox", { name: "resolution" })
    : screen.queryByLabelText(lever === "rate" ? "frame rate" : "quality");
/** The words of the entry a row has selected, null where the row is not drawn. */
const selectedWords = (lever: Lever): string | null =>
  (rowBox(lever) as HTMLSelectElement | null)?.selectedOptions[0]?.textContent ?? null;
const fastRadio = () => screen.getByRole("radio", { name: "Fast" });
const qualityRadio = () => screen.getByRole("radio", { name: "Quality" });
const choiceRow = () => screen.queryByRole("radiogroup", { name: "export choice" });
const withoutSignal = (options: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(options).filter(([key]) => key !== "signal"));

/** Make the picks in the new view; the door is opened first for the rows behind it. */
async function pickRows(user: User, picks: readonly Pick[]) {
  if (picks.some(([lever]) => lever !== "size"))
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
  for (const [lever, option] of picks) await user.selectOptions(rowBox(lever)!, option);
}

/** Open Export from the menu on a project with this canvas (the switch as given), make the picks, press Export (`clicks` times) and return the ONE call the export tool got, with the rows as read just before. */
async function exportedOn(
  canvas: Canvas,
  quick: boolean,
  pick: (user: User) => Promise<void> = async () => {},
  clicks: 1 | 2 = 1,
): Promise<Called> {
  ed.timeline = projectOf(...canvas) as never;
  __setExportFlag("quick_route", quick);
  runTool.mockClear();
  useExportJob.getState().reset();
  const user = userEvent.setup();
  const view = renderBar();
  openFromMenu();
  await settle();
  await pick(user);
  const rows = {
    size: selectedWords("size"),
    rate: selectedWords("rate"),
    quality: selectedWords("quality"),
  };
  const button = screen.getByRole("button", { name: "Export" });
  if (clicks === 2) await user.dblClick(button);
  else await user.click(button);
  await waitFor(() => expect(runTool).toHaveBeenCalled());
  await waitFor(() => expect(useExportJob.getState().phase).toBe("done"));
  await settle();
  expect(runTool, "one press of Export is one call of the tool").toHaveBeenCalledTimes(1);
  const [name, args, options] = runTool.mock.calls[0];
  expect(name).toBe("export");
  view.unmount();
  return { args, options, rows };
}

const NOTHING_TOUCHED: Explicit = { size: false, fps: false, quality: false };
/** The keys of the options the 0.28.0 dialog runs the tool with. */
const OPTION_KEYS = ["exportMode", "model", "signal", "surface", "transcriptId"];
const UHD60: Canvas = [3840, 2160, 60];
const HD30: Canvas = [1920, 1080, 30];

const FAST_RUNS: {
  name: string;
  canvas: Canvas;
  picks: readonly Pick[];
  rows: Rows;
  args: Record<string, unknown>;
  explicit: Explicit;
}[] = [
  {
    name: "untouched on 1920 x 1080 at 30: one size down, the project's own rate, Medium",
    canvas: HD30,
    picks: [],
    rows: { size: "720p", rate: "Same as project (30 fps)", quality: "Medium" },
    args: { resolution: "720p", quality: "medium" },
    explicit: NOTHING_TOUCHED,
  },
  {
    name: "untouched on 3840 x 2160 at 60: 1080p, 30 frames a second, Medium",
    canvas: UHD60,
    picks: [],
    rows: { size: "1080p", rate: "30 fps", quality: "Medium" },
    args: { resolution: "1080p", quality: "medium", fps: 30 },
    explicit: NOTHING_TOUCHED,
  },
  {
    name: "untouched on 854 x 480 at 30: nothing smaller to offer, so the project's own size, and no Resolution row",
    canvas: [854, 480, 30],
    picks: [],
    rows: { size: null, rate: "Same as project (30 fps)", quality: "Medium" },
    args: { resolution: "source", quality: "medium" },
    explicit: NOTHING_TOUCHED,
  },
  {
    name: "Resolution Same as project picked on 1920 x 1080 at 30: the size is the person's",
    canvas: HD30,
    picks: [["size", "Same as project (1920 x 1080)"]],
    rows: {
      size: "Same as project (1920 x 1080)",
      rate: "Same as project (30 fps)",
      quality: "Medium",
    },
    args: { resolution: "source", quality: "medium" },
    explicit: { size: true, fps: false, quality: false },
  },
  {
    name: "Frame rate Same as project picked on 3840 x 2160 at 60: no rate is sent, and the rate is the person's",
    canvas: UHD60,
    picks: [["rate", "Same as project (60 fps)"]],
    rows: { size: "1080p", rate: "Same as project (60 fps)", quality: "Medium" },
    args: { resolution: "1080p", quality: "medium" },
    explicit: { size: false, fps: true, quality: false },
  },
  {
    name: "a rate above Fast's own picked on 3840 x 2160 at 60: the pick is what is sent",
    canvas: UHD60,
    picks: [["rate", "50 fps"]],
    rows: { size: "1080p", rate: "50 fps", quality: "Medium" },
    args: { resolution: "1080p", quality: "medium", fps: 50 },
    explicit: { size: false, fps: true, quality: false },
  },
  {
    name: "Quality High picked on 1920 x 1080 at 30: only the quality is the person's",
    canvas: HD30,
    picks: [["quality", "High"]],
    rows: { size: "720p", rate: "Same as project (30 fps)", quality: "High" },
    args: { resolution: "720p", quality: "high" },
    explicit: { size: false, fps: false, quality: true },
  },
  {
    name: "all three picked on 3840 x 2160 at 60: every lever is the person's",
    canvas: UHD60,
    picks: [
      ["size", "480p"],
      ["rate", "24 fps"],
      ["quality", "Low"],
    ],
    rows: { size: "480p", rate: "24 fps", quality: "Low" },
    args: { resolution: "480p", quality: "low", fps: 24 },
    explicit: { size: true, fps: true, quality: true },
  },
];

describe("Fast, picked in the new view, runs the export tool with the route and the values the dialog showed", () => {
  it.each(FAST_RUNS)("$name", async ({ canvas, picks, rows, args, explicit }) => {
    const run = await exportedOn(canvas, true, async (user) => {
      await user.click(fastRadio());
      await pickRows(user, picks);
    });
    expect(run.rows).toStrictEqual(rows);
    expect(run.args).toStrictEqual(args); // exactly these keys: no `fps` where the rate is the project's own
    expect(run.options.exportRoute).toStrictEqual({ route: "quick", explicit });
    expect(run.options.exportMode).toBeUndefined(); // the app decides the encoder at the click
    // The route is the ONE key Fast adds to what the 0.28.0 dialog runs the tool with.
    expect(Object.keys(run.options).sort()).toEqual([...OPTION_KEYS, "exportRoute"].sort());
    expect(run.options).toMatchObject({ surface: "app", model: "", transcriptId: "" });
  });

  it("leaves the encoder to the tool also before the app has answered about it, where Quality asks for Full quality", async () => {
    vi.mocked(decideExportEncoder).mockReturnValue(new Promise(() => undefined));
    const fast = await exportedOn(HD30, true, async (user) => void (await user.click(fastRadio())));
    const quality = await exportedOn(HD30, true);
    expect(fast.options.exportMode).toBeUndefined();
    expect(fast.options.exportRoute).toStrictEqual({ route: "quick", explicit: NOTHING_TOUCHED });
    expect(quality.options.exportMode).toBe("quality");
    expect("exportRoute" in quality.options).toBe(false);
  });

  it("hands the tool the route the open dialog reported even when the switch has turned off since: the tool reads the switch at the click, the menu bar does not", async () => {
    const run = await exportedOn(HD30, true, async (user) => {
      await user.click(fastRadio());
      __setExportFlag("quick_route", false); // the server turns it off under the open dialog
    });
    expect(run.options.exportRoute).toStrictEqual({ route: "quick", explicit: NOTHING_TOUCHED });
    expect(run.args).toStrictEqual({ resolution: "720p", quality: "medium" });
  });

  it("Fast, a pick, Quality, Fast again: each choice puts its own values back, so the last Fast sends its own, with nothing marked as picked", async () => {
    const run = await exportedOn(UHD60, true, async (user) => {
      await user.click(fastRadio());
      await pickRows(user, [["size", "480p"]]);
      await user.click(qualityRadio());
      await user.click(fastRadio());
    });
    expect(run.rows).toStrictEqual({ size: "1080p", rate: "30 fps", quality: "Medium" });
    expect(run.args).toStrictEqual({ resolution: "1080p", quality: "medium", fps: 30 });
    expect(run.options.exportRoute).toStrictEqual({ route: "quick", explicit: NOTHING_TOUCHED });
  });

  it("works the settings out again from the project as it is at the click: a project that shrank under the open dialog gets Fast's own values for its new size", async () => {
    const run = await exportedOn(UHD60, true, async (user) => {
      await user.click(fastRadio());
      ed.timeline = projectOf(1280, 720, 25) as never; // the project is changed while the dialog is open
    });
    expect(run.args).toStrictEqual({ resolution: "480p", quality: "medium" });
    expect(run.options.exportRoute).toStrictEqual({ route: "quick", explicit: NOTHING_TOUCHED });
  });

  it("drops a size pick that a project which shrank no longer holds, with its mark as the person's: Fast's own size is sent", async () => {
    const run = await exportedOn(UHD60, true, async (user) => {
      await user.click(fastRadio());
      await pickRows(user, [["size", "1440p"]]);
      ed.timeline = projectOf(1920, 1080, 30) as never; // 1440p is above this project
    });
    expect(run.args).toStrictEqual({ resolution: "720p", quality: "medium" });
    expect(run.options.exportRoute).toStrictEqual({ route: "quick", explicit: NOTHING_TOUCHED });
  });

  it("pressing Export twice in a row starts one export, with the route (off the app: in the shipped app the Save As box comes before the export begins)", async () => {
    const run = await exportedOn(
      HD30,
      true,
      async (user) => void (await user.click(fastRadio())),
      2,
    );
    expect(run.options.exportRoute).toStrictEqual({ route: "quick", explicit: NOTHING_TOUCHED });
  });
});

// The 0.28.0 dialog is the oracle for Quality: the same project and picks give the same call, key for key, and the route key is not there, not even with the value undefined.
describe("a Quality export, and an export from the 0.28.0 dialog, run the export tool without any route", () => {
  const legacyPicks = async () => {
    fireEvent.change(screen.getByLabelText("resolution"), { target: { value: "720p" } });
    fireEvent.change(screen.getByLabelText("quality"), { target: { value: "low" } });
    fireEvent.change(screen.getByLabelText("frame rate"), { target: { value: "24" } });
  };
  const newPicks = async (user: User) =>
    pickRows(user, [
      ["size", "720p"],
      ["rate", "24 fps"],
      ["quality", "Low"],
    ]);

  it.each([
    {
      name: "untouched on 1920 x 1080 at 30",
      canvas: HD30,
      args: { resolution: "source", quality: "medium" },
      touched: false,
    },
    {
      name: "untouched on 3840 x 2160 at 60",
      canvas: UHD60,
      args: { resolution: "source", quality: "medium" },
      touched: false,
    },
    {
      name: "with the three picks on 3840 x 2160 at 60",
      canvas: UHD60,
      args: { resolution: "720p", quality: "low", fps: 24 },
      touched: true,
    },
  ])(
    "$name: the new view's call is the 0.28.0 dialog's, with no exportRoute key",
    async ({ canvas, args, touched }) => {
      const legacy = await exportedOn(canvas, false, touched ? legacyPicks : undefined);
      const quality = await exportedOn(canvas, true, touched ? newPicks : undefined);
      expect(legacy.args).toStrictEqual(args);
      expect(quality.args).toStrictEqual(args);
      expect("exportRoute" in quality.options).toBe(false);
      expect("exportRoute" in legacy.options).toBe(false);
      expect(Object.keys(quality.options).sort()).toEqual(OPTION_KEYS);
      expect(Object.keys(legacy.options).sort()).toEqual(OPTION_KEYS);
      expect(withoutSignal(quality.options)).toStrictEqual(withoutSignal(legacy.options));
    },
  );

  it("Fast and then Quality again: no route, and Quality's own values whatever was picked on Fast in between", async () => {
    const run = await exportedOn(UHD60, true, async (user) => {
      await user.click(fastRadio());
      await pickRows(user, [
        ["size", "480p"],
        ["quality", "High"],
      ]);
      await user.click(qualityRadio());
    });
    expect(run.rows).toStrictEqual({
      size: "Same as project (3840 x 2160)",
      rate: "Same as project (60 fps)",
      quality: "Medium",
    });
    expect(run.args).toStrictEqual({ resolution: "source", quality: "medium" });
    expect("exportRoute" in run.options).toBe(false);
    expect(Object.keys(run.options).sort()).toEqual(OPTION_KEYS);
  });

  it("with the switch off at the opening the dialog is the 0.28.0 one: no Quality | Fast row, and what it starts has no route", async () => {
    const run = await exportedOn(UHD60, false, async () => {
      expect(choiceRow()).toBeNull();
      expect(screen.queryByRole("radio", { name: "Fast" })).toBeNull();
      expect(screen.queryByRole("radio", { name: "Quality" })).toBeNull();
    });
    expect("exportRoute" in run.options).toBe(false);
    expect(run.options.exportMode).toBeUndefined();
  });

  it("with the switch on the row is drawn, Quality checked, once per opening, and Fast is never checked by the dialog itself", async () => {
    __setExportFlag("quick_route", true);
    const user = userEvent.setup();
    renderBar();
    openFromMenu();
    expect(screen.getAllByRole("radiogroup", { name: "export choice" })).toHaveLength(1);
    expect(qualityRadio()).toBeChecked();
    expect(fastRadio()).not.toBeChecked();
    await user.click(fastRadio());
    expect(fastRadio()).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    openFromMenu(); // the next opening starts on Quality again
    expect(qualityRadio()).toBeChecked();
    expect(fastRadio()).not.toBeChecked();
    await settle();
  });
});
