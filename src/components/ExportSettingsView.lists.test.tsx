// The lists the Quality / Fast view's settings view offers, and which rows it draws at all, read the way a person reads them: the names of the options in the Resolution select (in the normal view) and in the
// Frame rate select (behind the door), for every project of the spec's table; the faster-setting line behind the door; and everything the view must never draw. The expected words are written out here (an
// oracle), never read from the words file or computed by the model. The only boundaries mocked are the ones the dialog tests mock: the app's look at the encoder and the PC the Graphics chip row asks.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { processorName, resolveExportResources, runCapabilityProbe } from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { amd, harness } from "../test/chipHarness";
import { __resetChipTests } from "../timeline/chipTest";
import { __resetExportAsk } from "../timeline/exportAsk";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { emptyTimeline } from "../timeline/model";
import type { RenderWorkload } from "../timeline/renderPlan";
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

/** The PC the Graphics chip row asks: these adapters, and nothing else to say. */
function pcWith(adapters: (typeof amd)[]) {
  const scripted = harness(adapters);
  vi.mocked(runCapabilityProbe).mockReset();
  vi.mocked(runCapabilityProbe).mockImplementation((args, options) =>
    scripted.deps.probe(args, options),
  );
  vi.mocked(resolveExportResources).mockReset();
  vi.mocked(resolveExportResources).mockResolvedValue({
    total_memory_bytes: null,
    available_memory_bytes: null,
    scratch_free_bytes: null,
    destination_free_bytes: null,
    budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
    adapters,
  });
  vi.mocked(processorName).mockReset();
  vi.mocked(processorName).mockResolvedValue(null);
}

beforeEach(() => {
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
  __resetExportAsk();
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
const mount = (workload: RenderWorkload | null = null) =>
  render(<ExportSettingsView workload={workload} onCancel={vi.fn()} onStart={vi.fn()} />);

const resolutionBox = () => screen.queryByRole("combobox", { name: "resolution" });
const doorButton = () => screen.getByRole("button", { name: "Advanced settings" });
const optionNames = (box: HTMLElement) =>
  within(box)
    .getAllByRole("option")
    .map((option) => option.textContent);
/** The Frame rate select lives behind the door: closed, the region is hidden and nothing in it can be reached. */
const rateBox = () => screen.queryByRole("combobox", { name: "frame rate" });

interface Row {
  name: string;
  width: number;
  height: number;
  fps: number;
  /** The Resolution select's options, or null where the row is not drawn. */
  sizes: string[] | null;
  /** The Frame rate select's options, or null where the row is not drawn. */
  rates: string[] | null;
}

// The Quality column of the spec's table 3.1 (VIEW-CONTRACT section 5), plus a horizontal and a vertical 4K (sizes go by the SHORT side) and an odd canvas.
const ROWS: Row[] = [
  {
    name: "1080 x 1920 at 30 (vertical, the app's default project)",
    width: 1080,
    height: 1920,
    fps: 30,
    sizes: ["Same as project (1080 x 1920)", "720p", "480p"],
    rates: ["Same as project (30 fps)", "25 fps", "24 fps"],
  },
  {
    name: "3840 x 2160 at 60",
    width: 3840,
    height: 2160,
    fps: 60,
    sizes: ["Same as project (3840 x 2160)", "1440p", "1080p", "720p", "480p"],
    rates: ["Same as project (60 fps)", "50 fps", "30 fps", "25 fps", "24 fps"],
  },
  {
    name: "2560 x 1440 at 50",
    width: 2560,
    height: 1440,
    fps: 50,
    sizes: ["Same as project (2560 x 1440)", "1080p", "720p", "480p"],
    rates: ["Same as project (50 fps)", "30 fps", "25 fps", "24 fps"],
  },
  {
    name: "1280 x 720 at 25",
    width: 1280,
    height: 720,
    fps: 25,
    sizes: ["Same as project (1280 x 720)", "480p"],
    rates: ["Same as project (25 fps)", "24 fps"],
  },
  {
    name: "854 x 480 at 30 (no smaller size)",
    width: 854,
    height: 480,
    fps: 30,
    sizes: null,
    rates: ["Same as project (30 fps)", "25 fps", "24 fps"],
  },
  {
    name: "1920 x 1080 at 24 (no lower rate)",
    width: 1920,
    height: 1080,
    fps: 24,
    sizes: ["Same as project (1920 x 1080)", "720p", "480p"],
    rates: null,
  },
  {
    name: "7680 x 4320 at 30",
    width: 7680,
    height: 4320,
    fps: 30,
    sizes: ["Same as project (7680 x 4320)", "2160p (4K)", "1440p", "1080p", "720p", "480p"],
    rates: ["Same as project (30 fps)", "25 fps", "24 fps"],
  },
  {
    name: "1920 x 1080 at 30 (horizontal: the short side is the height)",
    width: 1920,
    height: 1080,
    fps: 30,
    sizes: ["Same as project (1920 x 1080)", "720p", "480p"],
    rates: ["Same as project (30 fps)", "25 fps", "24 fps"],
  },
  {
    name: "2160 x 3840 at 60 (vertical 4K: the short side is the width)",
    width: 2160,
    height: 3840,
    fps: 60,
    sizes: ["Same as project (2160 x 3840)", "1440p", "1080p", "720p", "480p"],
    rates: ["Same as project (60 fps)", "50 fps", "30 fps", "25 fps", "24 fps"],
  },
  {
    name: "1081 x 1921 at 30 (odd sides: the picture the export makes is even)",
    width: 1081,
    height: 1921,
    fps: 30,
    sizes: ["Same as project (1082 x 1922)", "1080p", "720p", "480p"],
    rates: ["Same as project (30 fps)", "25 fps", "24 fps"],
  },
  {
    name: "1920 x 1080 at 29.97 (a rate that is not whole)",
    width: 1920,
    height: 1080,
    fps: 29.97,
    sizes: ["Same as project (1920 x 1080)", "720p", "480p"],
    rates: ["Same as project (29.97 fps)", "25 fps", "24 fps"],
  },
];

describe("the lists and the rows the settings view draws, for every project", () => {
  describe.each(["the open project's canvas", "the dialog's snapshot of it"] as const)(
    "read from %s",
    (source) => {
      it.each(ROWS)("$name", async (row) => {
        if (source === "the open project's canvas") {
          setCanvas(row.width, row.height, row.fps);
          mount(null);
        } else {
          mount(workloadOf(row.width, row.height, row.fps));
        }
        await settle();
        // the Resolution row is in the normal view
        const sizes = resolutionBox();
        if (row.sizes === null) expect(sizes).toBeNull();
        else {
          expect(sizes).toBeVisible();
          expect(optionNames(sizes!)).toEqual(row.sizes);
          expect(sizes).toHaveValue("source");
        }
        // the Frame rate row is behind the door: nothing of it can be reached until the door is open
        expect(rateBox()).toBeNull();
        await userEvent.setup().click(doorButton());
        const rates = rateBox();
        if (row.rates === null) expect(rates).toBeNull();
        else {
          expect(rates).toBeVisible();
          expect(optionNames(rates!)).toEqual(row.rates);
          expect(rates).toHaveValue("");
        }
        // Quality is always offered, by names only, on Medium
        const quality = screen.getByRole("combobox", { name: "quality" });
        expect(optionNames(quality)).toEqual(["High", "Medium", "Low"]);
        expect(quality).toHaveValue("medium");
      });
    },
  );

  it("draws neither the Resolution row nor the Frame rate row when there is no project", async () => {
    mount(null);
    expect(resolutionBox()).toBeNull();
    await userEvent.setup().click(doorButton());
    expect(rateBox()).toBeNull();
    expect(screen.getByRole("combobox", { name: "quality" })).toHaveValue("medium");
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
  });

  it("never offers a size at or above the project's short side, whatever the shape", () => {
    // a vertical 1080 x 1920 project has a short side of 1080: 720p and 480p only
    setCanvas(1080, 1920, 30);
    const vertical = mount(null);
    expect(optionNames(resolutionBox()!)).not.toContain("1080p");
    expect(optionNames(resolutionBox()!)).not.toContain("1440p");
    vertical.unmount();
    // a horizontal 1920 x 1080 one has the same short side: the same two, not the sizes below its width
    setCanvas(1920, 1080, 30);
    mount(null);
    expect(optionNames(resolutionBox()!)).toEqual([
      "Same as project (1920 x 1080)",
      "720p",
      "480p",
    ]);
  });

  it("follows the project as it is now, not the snapshot the dialog took when it opened", () => {
    setCanvas(1280, 720, 25);
    mount(workloadOf(1920, 1080, 30));
    expect(optionNames(resolutionBox()!)).toEqual(["Same as project (1280 x 720)", "480p"]);
  });

  it("follows the project when it changes while the view is open", async () => {
    setCanvas(1920, 1080, 30);
    mount(null);
    expect(optionNames(resolutionBox()!)).toEqual([
      "Same as project (1920 x 1080)",
      "720p",
      "480p",
    ]);
    await userEvent.setup().click(doorButton());
    expect(optionNames(rateBox()!)).toEqual(["Same as project (30 fps)", "25 fps", "24 fps"]);
    act(() => setCanvas(854, 480, 24));
    expect(resolutionBox()).toBeNull();
    expect(rateBox()).toBeNull();
    act(() => setCanvas(3840, 2160, 60));
    expect(optionNames(resolutionBox()!)).toEqual([
      "Same as project (3840 x 2160)",
      "1440p",
      "1080p",
      "720p",
      "480p",
    ]);
    expect(optionNames(rateBox()!)).toEqual([
      "Same as project (60 fps)",
      "50 fps",
      "30 fps",
      "25 fps",
      "24 fps",
    ]);
  });
});

const FASTER =
  "To save time, ArtDaddy will use a faster setting; the picture may be slightly softer.";
const PROJECT = workloadOf(1080, 1920, 30);

describe("the faster-setting line", () => {
  const withLook = (answer: Partial<ExportEncoderDecision>) =>
    vi.mocked(decideExportEncoder).mockImplementation(async () => decision(answer));

  it("is behind the door, in 0.28.0's words, where the app will use the faster setting and no Mode row would be drawn", async () => {
    withLook({ faster: true });
    mount(PROJECT);
    await settle();
    // in the page but not on screen: the region is hidden while the door is closed
    expect(screen.getByText(FASTER)).not.toBeVisible();
    await userEvent.setup().click(doorButton());
    expect(screen.getByText(FASTER)).toBeVisible();
    expect(screen.getAllByText(FASTER)).toHaveLength(1);
  });

  it.each([
    ["an answer without it", () => withLook({})],
    [
      "an answer that wants a Mode row (which this view never draws)",
      () => withLook({ faster: true, showRow: true }),
    ],
    [
      "an answer that has not come",
      () => vi.mocked(decideExportEncoder).mockImplementation(() => new Promise(() => undefined)),
    ],
    [
      "a look that failed",
      () =>
        vi
          .mocked(decideExportEncoder)
          .mockImplementation(async () => Promise.reject(new Error("no"))),
    ],
  ])("is not drawn for %s, door open or closed", async (_name, arrange) => {
    arrange();
    mount(PROJECT);
    await settle();
    expect(screen.queryByText(FASTER)).toBeNull();
    await userEvent.setup().click(doorButton());
    expect(screen.queryByText(FASTER)).toBeNull();
  });

  it("is not drawn, and the app is not asked, with no project", async () => {
    withLook({ faster: true });
    mount(null);
    await settle();
    await userEvent.setup().click(doorButton());
    expect(screen.queryByText(FASTER)).toBeNull();
    expect(decideExportEncoder).not.toHaveBeenCalled();
  });

  it("goes with the answer: gone again once the app no longer says it", async () => {
    const answers: Partial<ExportEncoderDecision>[] = [{ faster: true }, {}];
    vi.mocked(decideExportEncoder).mockImplementation(async () => decision(answers.shift() ?? {}));
    mount(PROJECT);
    await settle();
    const user = userEvent.setup();
    await user.click(doorButton());
    expect(screen.getByText(FASTER)).toBeVisible();
    // a change the app is asked about again (the quality) brings the second answer
    await user.selectOptions(screen.getByRole("combobox", { name: "quality" }), "High");
    await settle();
    expect(screen.queryByText(FASTER)).toBeNull();
  });
});

describe("what the settings view never draws", () => {
  // Nothing of the 0.28.0 Mode row, estimate, "Never upscales" note or quality hints, nothing of the Fast choice and no question, in the whole page (hidden or not), door closed and open.
  const FORBIDDEN_TEXT: [string, RegExp][] = [
    ["Expected:", /Expected:/],
    ["a rough guess", /rough guess/i],
    ["Never upscales", /Never upscales/i],
    ["Full quality", /Full quality/],
    ["the word Fast", /\bFast\b/],
    ["would take", /would take/i],
    ["Near-lossless", /Near-lossless/],
    ["The usual delivery trade-off", /The usual delivery trade-off/],
    ["Small file, visible compression", /Small file, visible compression/],
    ["a time or a size (min, MB)", /\d\s*(min|MB)\b/i],
    ["the word example", /example/i],
    ["the question", /Are you sure\?/],
  ];
  const expectNothingOfIt = () => {
    for (const [name, words] of FORBIDDEN_TEXT)
      expect(document.body.textContent, name).not.toMatch(words);
    expect(screen.queryByLabelText("export estimate")).toBeNull();
    expect(screen.queryByTestId("estimate-much-longer")).toBeNull();
    for (const group of ["export mode", "export choice"])
      expect(screen.queryByRole("radiogroup", { name: group, hidden: true }), group).toBeNull();
    for (const name of ["Quality", "Fast", "Full quality"])
      expect(screen.queryByRole("radio", { name, hidden: true }), name).toBeNull();
    expect(screen.queryByRole("alertdialog", { hidden: true })).toBeNull();
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  };

  it.each([
    ["no project", () => mount(null)],
    ["a project", () => mount(PROJECT)],
    ["a 4K 60 project", () => mount(workloadOf(3840, 2160, 60))],
    [
      "an answer that wants the Mode row, with no chip on the PC",
      () => {
        vi.mocked(decideExportEncoder).mockImplementation(async () =>
          decision({
            showRow: true,
            defaultMode: "fast",
            reason: "over_minute",
            fullSeconds: 720,
            fastSeconds: 240,
          }),
        );
        return mount(PROJECT);
      },
    ],
    [
      "an answer for the faster setting",
      () => {
        vi.mocked(decideExportEncoder).mockImplementation(async () => decision({ faster: true }));
        return mount(PROJECT);
      },
    ],
  ])("is not in the page for %s, door closed or open", async (_name, show) => {
    show();
    await settle();
    expectNothingOfIt();
    await userEvent.setup().click(doorButton());
    await settle();
    expectNothingOfIt();
  });

  it("is not in the page where a chip has proven itself and the app wants the Mode row, with the chip row drawn", async () => {
    pcWith([amd]);
    vi.mocked(decideExportEncoder).mockImplementation(async () =>
      decision({
        showRow: true,
        defaultMode: "fast",
        reason: "over_minute",
        fullSeconds: 720,
        fastSeconds: 240,
      }),
    );
    mount(PROJECT);
    await userEvent.setup().click(doorButton());
    expect(await screen.findByRole("radiogroup", { name: "Graphics chip" })).toBeVisible();
    await settle();
    expectNothingOfIt();
  });

  it("holds exactly the words the normal view is allowed with the door closed: the row, the door and the two buttons", async () => {
    setCanvas(1080, 1920, 30);
    const view = mount(null);
    // the region behind the door is in the page but hidden; what a person sees is everything outside it
    const region = screen.getByTestId("export-advanced");
    expect(region).not.toBeVisible();
    const seen = view.container.cloneNode(true) as HTMLElement;
    seen.querySelector("[data-testid='export-advanced']")!.remove();
    expect(seen.textContent).toBe(
      "ResolutionSame as project (1080 x 1920)720p480pAdvanced settingsCancelExport",
    );
  });
});
