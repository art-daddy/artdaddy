// What the Quality / Fast view's settings view hands to onStart when Export is pressed, and what it does at the click: the object (exactly four keys, never a route), the values the person picked on the
// selects they see, the clamps when the project shrinks under the open view, and the moves made at the click (the speed check told, the old Mode row said to be off screen). The expected objects are written out
// here (an oracle), never computed by the model. The only boundaries mocked are the ones the dialog tests mock: the app's look at the encoder and the PC the Graphics chip row asks.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { processorName, resolveExportResources, runCapabilityProbe } from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { amd, harness } from "../test/chipHarness";
import { __resetChipTests } from "../timeline/chipTest";
import * as exportAsk from "../timeline/exportAsk";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { emptyTimeline } from "../timeline/model";
import type { RenderWorkload } from "../timeline/renderPlan";
import type { ExportSettings } from "./ExportDialog";
import ExportSettingsView from "./ExportSettingsView";

vi.mock("../timeline/exportChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoice")>()),
  decideExportEncoder: vi.fn(),
}));
vi.mock("../platform/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/host")>()),
  runCapabilityProbe: vi.fn(),
  resolveExportResources: vi.fn(),
  processorName: vi.fn(),
}));
vi.mock("../tools/dataRoot", () => ({ appCacheRoot: async () => "C:/cache" }));
vi.mock("../tools/tauri", () => ({
  TauriFs: class {
    async mkdir(): Promise<void> {}
    async remove(): Promise<void> {}
  },
}));

const decision = (over: Partial<ExportEncoderDecision> = {}): ExportEncoderDecision => ({
  mode: "quality",
  reason: "none",
  showRow: false,
  defaultMode: "quality",
  fullSeconds: 40,
  fastSeconds: null,
  fullGuessed: true,
  tests: [],
  facts: { encoder: "x264", reason: "none", tests: [] },
  ...over,
});
/** The app's answer when a chip has proven itself and the export is long: it wants the old Mode row, which this view never draws. */
const wantsRow = (): ExportEncoderDecision =>
  decision({
    showRow: true,
    defaultMode: "fast",
    reason: "over_minute",
    fullSeconds: 720,
    fastSeconds: 240,
    facts: { encoder: "x264", chip: "amd", reason: "none", tests: [] },
  });

type Resources = Awaited<ReturnType<typeof resolveExportResources>>;
const resourcesWith = (adapters: (typeof amd)[]): Resources => ({
  total_memory_bytes: null,
  available_memory_bytes: null,
  scratch_free_bytes: null,
  destination_free_bytes: null,
  budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
  adapters,
});
/** The PC the Graphics chip row asks: these adapters, and nothing else to say. */
function pcWith(adapters: (typeof amd)[]) {
  const scripted = harness(adapters);
  vi.mocked(runCapabilityProbe).mockReset();
  vi.mocked(runCapabilityProbe).mockImplementation((args, options) =>
    scripted.deps.probe(args, options),
  );
  vi.mocked(resolveExportResources).mockReset();
  vi.mocked(resolveExportResources).mockResolvedValue(resourcesWith(adapters));
  vi.mocked(processorName).mockReset();
  vi.mocked(processorName).mockResolvedValue(null);
}

// The real hold lets go after 30 s: in a long file that would end the hold of a later test under it. Every hold the view makes is let go at the end of its own test.
const realHold = exportAsk.holdExportAsk;
const holds: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(exportAsk, "holdExportAsk").mockImplementation((ms) => {
    const release = realHold(ms);
    holds.push(release);
    return release;
  });
  localStorage.clear();
  __resetChipTests();
  __setExportFlag("quick_export", true);
  useExportJob.getState().reset();
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  useEditor.setState({ timeline: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(async () => decision());
  pcWith([]);
});
afterEach(() => {
  cleanup();
  for (const release of holds.splice(0)) release();
  exportAsk.__resetExportAsk();
  __resetExportFlags();
  useEditor.setState({ timeline: null });
});

/** The open project's canvas, set the way the editor holds it (`emptyTimeline` rounds the rate, so it is written straight into the canvas). */
const setCanvas = (width: number, height: number, fps: number) =>
  useEditor.setState({ timeline: { ...emptyTimeline(), canvas: { width, height, fps } } });
/** What the dialog snapshotted when it opened. */
const workloadOf = (width: number, height: number, fps: number): RenderWorkload => ({
  width,
  height,
  fps,
  durationSeconds: 120,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
});

const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

function mount(workload: RenderWorkload | null = null) {
  const onStart = vi.fn<(settings: ExportSettings) => void>();
  const onCancel = vi.fn<() => void>();
  const user = userEvent.setup();
  const view = render(
    <ExportSettingsView workload={workload} onCancel={onCancel} onStart={onStart} />,
  );
  return { ...view, onStart, onCancel, user };
}
type Mounted = ReturnType<typeof mount>;

const exportButton = () => screen.getByRole("button", { name: "Export" });
type Box = "resolution" | "frame rate" | "quality";
const box = (name: Box) => screen.getByRole("combobox", { name });
const openDoor = async (user: Mounted["user"]) => {
  const door = screen.getByRole("button", { name: "Advanced settings" });
  if (door.getAttribute("aria-expanded") !== "true") await user.click(door);
};
/** A pick made the way a person makes it: on the select they see, by the words of its entry (Frame rate and Quality are behind the door). */
async function choose(view: Mounted, name: Box, entry: string) {
  if (name !== "resolution") await openDoor(view.user);
  await view.user.selectOptions(box(name), entry);
}
/** One object the view handed over (checked: exactly four keys, never a route). */
function sentBy(onStart: Mock<(settings: ExportSettings) => void>, call = 0): ExportSettings {
  const calls = onStart.mock.calls;
  expect(calls.length).toBeGreaterThan(call);
  const sent = calls[call][0];
  expect(Object.keys(sent).sort()).toEqual(["fps", "mode", "quality", "resolution"]);
  expect(sent).not.toHaveProperty("route");
  return sent;
}

interface Project {
  name: string;
  width: number;
  height: number;
  fps: number;
}
// The eight rows of the spec's table 3.1, an odd canvas and a rate that is not whole.
const PROJECTS: Project[] = [
  { name: "1080 x 1920 at 30", width: 1080, height: 1920, fps: 30 },
  { name: "3840 x 2160 at 60", width: 3840, height: 2160, fps: 60 },
  { name: "2560 x 1440 at 50", width: 2560, height: 1440, fps: 50 },
  { name: "1280 x 720 at 25", width: 1280, height: 720, fps: 25 },
  { name: "854 x 480 at 30", width: 854, height: 480, fps: 30 },
  { name: "1920 x 1080 at 24", width: 1920, height: 1080, fps: 24 },
  { name: "7680 x 4320 at 30", width: 7680, height: 4320, fps: 30 },
  { name: "1081 x 1921 at 30", width: 1081, height: 1921, fps: 30 },
  { name: "1920 x 1080 at 29.97", width: 1920, height: 1080, fps: 29.97 },
];

describe("what Export hands over when nothing was changed", () => {
  it.each(PROJECTS)(
    "$name: the project as it is, at Medium, and the app decides how",
    async (p) => {
      // the open project's canvas, and no workload: nothing was asked of the app, so Quality is what is sent
      setCanvas(p.width, p.height, p.fps);
      const open = mount(null);
      await settle();
      await open.user.click(exportButton());
      expect(open.onStart).toHaveBeenCalledTimes(1);
      expect(sentBy(open.onStart)).toStrictEqual({
        resolution: "source",
        quality: "medium",
        fps: null,
        mode: "quality",
      });
      open.unmount();

      // the dialog's snapshot alone, the app has answered and offers nothing to choose: nothing is the person's pick
      useEditor.setState({ timeline: null });
      const snapshot = mount(workloadOf(p.width, p.height, p.fps));
      await settle();
      await snapshot.user.click(exportButton());
      expect(sentBy(snapshot.onStart)).toStrictEqual({
        resolution: "source",
        quality: "medium",
        fps: null,
        mode: null,
      });
    },
  );

  it("with no project at all: the same, on Quality", async () => {
    const view = mount(null);
    await settle();
    await view.user.click(exportButton());
    expect(sentBy(view.onStart)).toStrictEqual({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: "quality",
    });
  });
});

describe("what Export hands over once the person has picked", () => {
  type Step = [Box, string];
  interface Case {
    name: string;
    project: [number, number, number];
    steps: Step[];
    sent: {
      resolution: ExportSettings["resolution"];
      quality: ExportSettings["quality"];
      fps: number | null;
    };
  }
  const CASES: Case[] = [
    {
      name: "a size",
      project: [1080, 1920, 30],
      steps: [["resolution", "720p"]],
      sent: { resolution: "720p", quality: "medium", fps: null },
    },
    {
      name: "the smallest size",
      project: [1080, 1920, 30],
      steps: [["resolution", "480p"]],
      sent: { resolution: "480p", quality: "medium", fps: null },
    },
    {
      name: "a rate",
      project: [1080, 1920, 30],
      steps: [["frame rate", "24 fps"]],
      sent: { resolution: "source", quality: "medium", fps: 24 },
    },
    {
      name: "the other rate",
      project: [1080, 1920, 30],
      steps: [["frame rate", "25 fps"]],
      sent: { resolution: "source", quality: "medium", fps: 25 },
    },
    {
      name: "High",
      project: [1080, 1920, 30],
      steps: [["quality", "High"]],
      sent: { resolution: "source", quality: "high", fps: null },
    },
    {
      name: "Low",
      project: [1080, 1920, 30],
      steps: [["quality", "Low"]],
      sent: { resolution: "source", quality: "low", fps: null },
    },
    {
      name: "a size, a rate and a quality together",
      project: [1080, 1920, 30],
      steps: [
        ["resolution", "720p"],
        ["frame rate", "24 fps"],
        ["quality", "High"],
      ],
      sent: { resolution: "720p", quality: "high", fps: 24 },
    },
    {
      name: "4K at 60: a size and the rate below the project's",
      project: [3840, 2160, 60],
      steps: [
        ["resolution", "1440p"],
        ["frame rate", "50 fps"],
      ],
      sent: { resolution: "1440p", quality: "medium", fps: 50 },
    },
    {
      name: "4K at 60: a rate and Low",
      project: [3840, 2160, 60],
      steps: [
        ["frame rate", "25 fps"],
        ["quality", "Low"],
      ],
      sent: { resolution: "source", quality: "low", fps: 25 },
    },
    {
      name: "8K: the 4K preset",
      project: [7680, 4320, 30],
      steps: [["resolution", "2160p (4K)"]],
      sent: { resolution: "2160p", quality: "medium", fps: null },
    },
    {
      name: "an odd canvas: 1080p, which is below its even picture of 1082 x 1922",
      project: [1081, 1921, 30],
      steps: [["resolution", "1080p"]],
      sent: { resolution: "1080p", quality: "medium", fps: null },
    },
    {
      name: "29.97: 25",
      project: [1920, 1080, 29.97],
      steps: [["frame rate", "25 fps"]],
      sent: { resolution: "source", quality: "medium", fps: 25 },
    },
    {
      name: "a size, then Same as project again: the project's own size",
      project: [1080, 1920, 30],
      steps: [
        ["resolution", "720p"],
        ["resolution", "Same as project (1080 x 1920)"],
      ],
      sent: { resolution: "source", quality: "medium", fps: null },
    },
    {
      name: "a rate, then Same as project again: no rate of its own",
      project: [1080, 1920, 30],
      steps: [
        ["frame rate", "24 fps"],
        ["frame rate", "Same as project (30 fps)"],
      ],
      sent: { resolution: "source", quality: "medium", fps: null },
    },
    {
      name: "High, then Medium again",
      project: [1080, 1920, 30],
      steps: [
        ["quality", "High"],
        ["quality", "Medium"],
      ],
      sent: { resolution: "source", quality: "medium", fps: null },
    },
  ];

  describe.each([
    ["no workload was given", false, "quality"],
    ["the app has answered and offers nothing to choose", true, null],
  ] as const)("%s", (_look, withWorkload, mode) => {
    it.each(CASES)("$name", async (c) => {
      const [width, height, fps] = c.project;
      setCanvas(width, height, fps);
      const view = mount(withWorkload ? workloadOf(width, height, fps) : null);
      await settle();
      for (const [name, entry] of c.steps) await choose(view, name, entry);
      // what the selects show is what is sent
      await view.user.click(exportButton());
      expect(sentBy(view.onStart)).toStrictEqual({ ...c.sent, mode });
    });
  });

  it("shows on the selects what it sends", async () => {
    setCanvas(3840, 2160, 60);
    const view = mount(null);
    await choose(view, "resolution", "1080p");
    await choose(view, "frame rate", "30 fps");
    await choose(view, "quality", "Low");
    expect(box("resolution")).toHaveValue("1080p");
    expect(box("frame rate")).toHaveValue("30");
    expect(box("quality")).toHaveValue("low");
    await view.user.click(exportButton());
    expect(sentBy(view.onStart)).toStrictEqual({
      resolution: "1080p",
      quality: "low",
      fps: 30,
      mode: "quality",
    });
  });
});

describe("what Export does at the click", () => {
  it("tells the speed check an export is being asked, once per click and not before", async () => {
    const hold = vi.spyOn(exportAsk, "holdExportAsk");
    setCanvas(1080, 1920, 30);
    const view = mount(null);
    await settle();
    await choose(view, "resolution", "720p");
    await choose(view, "quality", "High");
    // picking is not asking
    expect(hold).not.toHaveBeenCalled();
    expect(exportAsk.exportAskedNow()).toBe(false);
    await view.user.click(exportButton());
    expect(hold).toHaveBeenCalledTimes(1);
    expect(exportAsk.exportAskedNow()).toBe(true);
    expect(view.onStart).toHaveBeenCalledTimes(1);
    await view.user.click(exportButton());
    expect(hold).toHaveBeenCalledTimes(2);
    expect(view.onStart).toHaveBeenCalledTimes(2);
  });

  it("says the old Mode row was not on screen, and only when Export is pressed", async () => {
    setCanvas(1080, 1920, 30);
    const view = mount(workloadOf(1080, 1920, 30));
    await settle();
    await choose(view, "quality", "Low");
    expect(useExportJob.getState().modeRowOnScreen).toBeNull();
    await view.user.click(exportButton());
    expect(useExportJob.getState().modeRowOnScreen).toBe(false);
  });

  it("says it even where the app wanted the Mode row, which is never drawn here", async () => {
    vi.mocked(decideExportEncoder).mockImplementation(async () => wantsRow());
    const view = mount(workloadOf(1080, 1920, 30));
    await settle();
    expect(screen.queryByRole("radiogroup", { name: "export mode", hidden: true })).toBeNull();
    await view.user.click(exportButton());
    expect(useExportJob.getState().modeRowOnScreen).toBe(false);
  });

  it("Cancel hands over nothing, asks nothing and leaves the job's record alone", async () => {
    const hold = vi.spyOn(exportAsk, "holdExportAsk");
    const view = mount(workloadOf(1080, 1920, 30));
    await settle();
    await view.user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(view.onCancel).toHaveBeenCalledTimes(1);
    expect(view.onStart).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    expect(useExportJob.getState().modeRowOnScreen).toBeNull();
  });
});

describe("what Export hands over as `mode`: the app's look decides, exactly as 0.28.0 does", () => {
  const PROJECT = workloadOf(1080, 1920, 30);
  const click = async (view: Mounted) => {
    await view.user.click(exportButton());
    return sentBy(view.onStart, view.onStart.mock.calls.length - 1);
  };

  it("leaves it to the app (null) once the app has answered for what is on screen", async () => {
    const view = mount(PROJECT);
    await settle();
    expect((await click(view)).mode).toBeNull();
  });

  it("sends Quality while the app's answer has not come, and while it never will", async () => {
    vi.mocked(decideExportEncoder).mockImplementation(() => new Promise(() => undefined));
    const view = mount(PROJECT);
    await settle();
    expect((await click(view)).mode).toBe("quality");
  });

  it("sends Quality when the look failed: nobody was offered anything", async () => {
    vi.mocked(decideExportEncoder).mockImplementation(async () => Promise.reject(new Error("no")));
    const view = mount(PROJECT);
    await settle();
    expect((await click(view)).mode).toBe("quality");
  });

  it("sends Quality for an answer that was made for other settings, until the app has answered for these", async () => {
    vi.mocked(decideExportEncoder)
      .mockImplementationOnce(async () => decision())
      .mockImplementation(() => new Promise(() => undefined));
    const view = mount(PROJECT);
    await settle();
    expect((await click(view)).mode).toBeNull();
    await choose(view, "quality", "High");
    await settle();
    expect((await click(view)).mode).toBe("quality");
  });

  it("asks the app about the shown settings, and again when they change", async () => {
    setCanvas(1080, 1920, 30);
    const view = mount(PROJECT);
    await settle();
    expect(vi.mocked(decideExportEncoder).mock.calls.at(-1)?.[0].settings).toEqual({
      resolution: "source",
      quality: "medium",
      fps: null,
    });
    await choose(view, "resolution", "720p");
    await choose(view, "frame rate", "24 fps");
    await choose(view, "quality", "Low");
    await settle();
    const asked = vi.mocked(decideExportEncoder).mock.calls.at(-1)?.[0];
    expect(asked?.settings).toEqual({ resolution: "720p", quality: "low", fps: 24 });
    expect(asked?.workload).toEqual(PROJECT);
    expect(asked?.request).toBe("auto");
  });

  it("does not choose for the person while the Graphics chip row has not answered, and does once it has", async () => {
    // the app wants a Mode row (a chip proved itself) and the chip row's own first look is out
    let answer!: (resources: Resources) => void;
    const gate = new Promise<Resources>((resolve) => (answer = resolve));
    vi.mocked(resolveExportResources).mockImplementation(() => gate);
    vi.mocked(decideExportEncoder).mockImplementation(async () => wantsRow());
    const view = mount(PROJECT);
    await settle();
    expect((await click(view)).mode).toBe("quality");
    await act(async () => answer(resourcesWith([])));
    await settle();
    expect((await click(view)).mode).toBeNull();
  });
});

describe("what the Graphics chip row is told", () => {
  it("is the picture Export will deliver, so the chip is tested where the export runs: a pick on a 4K 60 project brings the row", async () => {
    pcWith([amd]);
    const view = mount(workloadOf(3840, 2160, 60));
    await openDoor(view.user);
    await settle();
    // 4K at 60 frames a second is a picture no chip is asked about
    expect(screen.queryByRole("radiogroup", { name: "Graphics chip" })).toBeNull();
    // at 30 it is one, so the row is drawn for the picture the export will make
    await view.user.selectOptions(box("frame rate"), "30 fps");
    expect(await screen.findByRole("radiogroup", { name: "Graphics chip" })).toBeVisible();
    // and back at the project's own rate it is not again
    await view.user.selectOptions(box("frame rate"), "Same as project (60 fps)");
    await settle();
    expect(screen.queryByRole("radiogroup", { name: "Graphics chip" })).toBeNull();
  });

  it("follows the size too: 1080p of a 4K project at 60 is a picture the chip serves", async () => {
    pcWith([amd]);
    const view = mount(workloadOf(3840, 2160, 60));
    await openDoor(view.user);
    await settle();
    expect(screen.queryByRole("radiogroup", { name: "Graphics chip" })).toBeNull();
    await view.user.selectOptions(box("resolution"), "1080p");
    expect(await screen.findByRole("radiogroup", { name: "Graphics chip" })).toBeVisible();
  });

  it("is not drawn, and no chip is tested, with no project", async () => {
    pcWith([amd]);
    const view = mount(null);
    await openDoor(view.user);
    await settle();
    expect(screen.queryByTestId("chip-row")).toBeNull();
    expect(runCapabilityProbe).not.toHaveBeenCalled();
  });
});

describe("a project that shrinks while the view is open", () => {
  interface Shrink {
    name: string;
    from: [number, number, number];
    steps: [Box, string][];
    /** The Resolution select's value after the steps. */
    shows: string;
    to: [number, number, number];
    sent: { resolution: ExportSettings["resolution"]; fps: number | null };
  }
  const SHRINKS: Shrink[] = [
    {
      name: "1080 x 1920 at 30 down to 1280 x 720 at 25: 720p is no smaller than 720, 25 is no lower than 25",
      from: [1080, 1920, 30],
      steps: [
        ["resolution", "720p"],
        ["frame rate", "25 fps"],
      ],
      shows: "720p",
      to: [1280, 720, 25],
      sent: { resolution: "source", fps: null },
    },
    {
      name: "4K at 60 down to 1920 x 1080 at 30: 1080p and 30 are the project's own now",
      from: [3840, 2160, 60],
      steps: [
        ["resolution", "1080p"],
        ["frame rate", "30 fps"],
      ],
      shows: "1080p",
      to: [1920, 1080, 30],
      sent: { resolution: "source", fps: null },
    },
    {
      name: "4K at 60 down to 1440p at 50: both picks are still smaller than the project",
      from: [3840, 2160, 60],
      steps: [
        ["resolution", "1080p"],
        ["frame rate", "30 fps"],
      ],
      shows: "1080p",
      to: [2560, 1440, 50],
      sent: { resolution: "1080p", fps: 30 },
    },
    {
      name: "1440p at 50 down to 854 x 480 at 30: the size goes, the lower rate stays",
      from: [2560, 1440, 50],
      steps: [
        ["resolution", "720p"],
        ["frame rate", "24 fps"],
      ],
      shows: "720p",
      to: [854, 480, 30],
      sent: { resolution: "source", fps: 24 },
    },
    {
      name: "8K at 30 down to 4K at 30: the 4K preset is the project's own size now",
      from: [7680, 4320, 30],
      steps: [
        ["resolution", "2160p (4K)"],
        ["frame rate", "25 fps"],
      ],
      shows: "2160p",
      to: [3840, 2160, 30],
      sent: { resolution: "source", fps: 25 },
    },
    {
      name: "1080p at 30 down to 854 x 480 at 24: 480p and 24 are the project's own now",
      from: [1920, 1080, 30],
      steps: [
        ["resolution", "480p"],
        ["frame rate", "24 fps"],
      ],
      shows: "480p",
      to: [854, 480, 24],
      sent: { resolution: "source", fps: null },
    },
  ];
  // What a preset is, as the list names its short side: written here, so that the rule "never at or above the project" is checked against numbers and not against the model.
  const SHORT = { "2160p": 2160, "1440p": 1440, "1080p": 1080, "720p": 720, "480p": 480 } as const;
  const neverAtOrAbove = (sent: ExportSettings, to: [number, number, number]) => {
    if (sent.resolution !== "source")
      expect(SHORT[sent.resolution]).toBeLessThan(Math.min(to[0], to[1]));
    if (sent.fps !== null) expect(sent.fps).toBeLessThan(to[2]);
  };
  const startOn = async (c: Shrink) => {
    setCanvas(...c.from);
    const view = mount(null);
    await settle();
    for (const [name, entry] of c.steps) await choose(view, name, entry);
    return view;
  };

  it.each(SHRINKS)("$name", async (c) => {
    const view = await startOn(c);
    act(() => setCanvas(...c.to));
    await view.user.click(exportButton());
    const sent = sentBy(view.onStart);
    expect(sent).toStrictEqual({ ...c.sent, quality: "medium", mode: "quality" });
    neverAtOrAbove(sent, c.to);
  });

  it.each(SHRINKS)("sent at the click even with no draw in between: $name", async (c) => {
    const view = await startOn(c);
    const button = exportButton();
    act(() => {
      setCanvas(...c.to);
      // the project has changed but the view has not been drawn again: it still shows the pick, so what is sent comes from the project as it is now and not from what was last drawn
      expect(box("resolution")).toHaveValue(c.shows);
      button.click();
    });
    const sent = sentBy(view.onStart);
    expect(sent).toStrictEqual({ ...c.sent, quality: "medium", mode: "quality" });
    neverAtOrAbove(sent, c.to);
  });

  it.each(SHRINKS.filter((c) => c.sent.resolution === "source" || c.sent.fps === null))(
    "a pick the project no longer held does not come back when it grows again: $name",
    async (c) => {
      const view = await startOn(c);
      act(() => setCanvas(...c.to));
      act(() => setCanvas(...c.from));
      // the lever that was dropped shows the project's own value again, not the pick; the other one is still the person's
      expect(box("resolution")).toHaveValue(c.sent.resolution === "source" ? "source" : c.shows);
      expect(box("frame rate")).toHaveValue(c.sent.fps === null ? "" : String(c.sent.fps));
      await view.user.click(exportButton());
      expect(sentBy(view.onStart)).toStrictEqual({ ...c.sent, quality: "medium", mode: "quality" });
    },
  );

  it("keeps a pick the project still holds when it shrinks and grows", async () => {
    setCanvas(3840, 2160, 60);
    const view = mount(null);
    await choose(view, "resolution", "1080p");
    await choose(view, "frame rate", "30 fps");
    await choose(view, "quality", "High");
    act(() => setCanvas(2560, 1440, 50));
    act(() => setCanvas(3840, 2160, 60));
    expect(box("resolution")).toHaveValue("1080p");
    expect(box("frame rate")).toHaveValue("30");
    await view.user.click(exportButton());
    expect(sentBy(view.onStart)).toStrictEqual({
      resolution: "1080p",
      quality: "high",
      fps: 30,
      mode: "quality",
    });
  });

  it("sends only the project's own size and rate when the project can no longer be read", async () => {
    setCanvas(1920, 1080, 30);
    const view = mount(null);
    await settle();
    await choose(view, "resolution", "720p");
    await choose(view, "frame rate", "24 fps");
    await choose(view, "quality", "Low");
    act(() => useEditor.setState({ timeline: null }));
    await view.user.click(exportButton());
    // no project to hold a size or a rate against: the quality is the person's own and nothing else is claimed
    expect(sentBy(view.onStart)).toStrictEqual({
      resolution: "source",
      quality: "low",
      fps: null,
      mode: "quality",
    });
  });
});
