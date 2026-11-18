// The Quality | Fast choice of the settings view, as outcomes: through the real view and the real stores, with the same two boundaries mocked as the other view tests (the app's look at the encoder and the PC the
// Graphics chip row asks). Every expected value is written out here from the owner's table (spec 3.1 and the 13-row table 3.5), never computed by the code under test:
//  (a) the row at mount and in every state: Quality checked, Fast not, the group named "export choice", no tooltip, no description;
//  (b) Fast picked by click and by keyboard: the lists show Fast's own values;
//  (c) what `onStart` receives over a table of project shapes and picks, for both choices;
//  (d) picking a choice resets what the person picked, the already checked one included;
//  (e) nothing is remembered between two openings; (f) the click works everything out again from the project at that moment;
//  (g) the click's own moves (the speed check told, the old Mode row said to be off screen), and Cancel;
//  (h) the Graphics chip row stays mounted behind the closed door and is told the SHOWN values; (i) the light-compression sentence is Quality's only;
//  (j) the keyboard: the Tab order with the row, the arrow keys, and Escape, which is the dialog's and not the view's.
// Mutants this file must kill: the first choice Fast; a pick of a choice that keeps the overrides; the already checked choice not resetting; every explicit flag false or true whatever was touched; Fast's `mode` from the look;
// a route key on Quality; the click reading what was last drawn; the chip row told the choice's own values; the sentence drawn with Fast chosen; the Frame rate list without Fast's own rate; a tooltip on the Fast radio;
// no `modeRowOnScreen(false)` at the click; Escape handled by the view.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import {
  processorName,
  resolveExportResources,
  runCapabilityProbe,
  type GraphicsAdapter,
} from "../platform/host";
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

/** The PC the Graphics chip row asks: these adapters, and nothing else to say. */
function pcWith(adapters: GraphicsAdapter[]): void {
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
  exportAsk.__resetExportAsk();
  __resetExportFlags();
  useEditor.setState({ timeline: null });
});

/** The open project's canvas, set the way the editor holds it. */
const setCanvas = (width: number, height: number, fps: number) =>
  useEditor.setState({ timeline: { ...emptyTimeline(), canvas: { width, height, fps } } });
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

type Size = "source" | "2160p" | "1440p" | "1080p" | "720p" | "480p";

/** One project shape with what the owner's table says of it. */
interface Shape {
  name: string;
  width: number;
  height: number;
  fps: number;
  /** Fast's own size and rate (`null`: the project's own rate), spec 3.1. Fast's quality is Medium everywhere. */
  own: { resolution: Size; fps: number | null };
  /** The Resolution list, in words; null where the row is not drawn (no smaller size). */
  sizes: string[] | null;
  /** The Frame rate list, in words, as Quality shows it; null where the row is not drawn. */
  rates: string[] | null;
  /** Fast's own rate where the ladder has none (72 gives 18): the entry Fast's list adds at its end. */
  fastExtraRate?: string;
  /** A size of the list that is not Fast's own: its words and what is sent. Null: none to pick. */
  size: { words: string; value: Size } | null;
  /** A lower rate of the list that is not Fast's own. Null: none to pick. */
  rate: { words: string; value: number } | null;
}

const SHAPES: Shape[] = [
  {
    name: "3840 x 2160 at 60",
    width: 3840,
    height: 2160,
    fps: 60,
    own: { resolution: "1080p", fps: 30 },
    sizes: ["Same as project (3840 x 2160)", "1440p", "1080p", "720p", "480p"],
    rates: ["Same as project (60 fps)", "50 fps", "30 fps", "25 fps", "24 fps"],
    size: { words: "720p", value: "720p" },
    rate: { words: "25 fps", value: 25 },
  },
  {
    name: "1920 x 1080 at 30",
    width: 1920,
    height: 1080,
    fps: 30,
    own: { resolution: "720p", fps: null },
    sizes: ["Same as project (1920 x 1080)", "720p", "480p"],
    rates: ["Same as project (30 fps)", "25 fps", "24 fps"],
    size: { words: "480p", value: "480p" },
    rate: { words: "24 fps", value: 24 },
  },
  {
    name: "1920 x 1080 at 24",
    width: 1920,
    height: 1080,
    fps: 24,
    own: { resolution: "720p", fps: null },
    sizes: ["Same as project (1920 x 1080)", "720p", "480p"],
    rates: null,
    size: { words: "480p", value: "480p" },
    rate: null,
  },
  {
    name: "1080 x 1920 at 30 (vertical)",
    width: 1080,
    height: 1920,
    fps: 30,
    own: { resolution: "720p", fps: null },
    sizes: ["Same as project (1080 x 1920)", "720p", "480p"],
    rates: ["Same as project (30 fps)", "25 fps", "24 fps"],
    size: { words: "480p", value: "480p" },
    rate: { words: "24 fps", value: 24 },
  },
  {
    name: "854 x 480 at 30",
    width: 854,
    height: 480,
    fps: 30,
    own: { resolution: "source", fps: null },
    sizes: null,
    rates: ["Same as project (30 fps)", "25 fps", "24 fps"],
    size: null,
    rate: { words: "24 fps", value: 24 },
  },
  {
    name: "1366 x 768 at 30 (odd short side)",
    width: 1366,
    height: 768,
    fps: 30,
    own: { resolution: "720p", fps: null },
    sizes: ["Same as project (1366 x 768)", "720p", "480p"],
    rates: ["Same as project (30 fps)", "25 fps", "24 fps"],
    size: { words: "480p", value: "480p" },
    rate: { words: "25 fps", value: 25 },
  },
  {
    name: "2560 x 1440 at 50",
    width: 2560,
    height: 1440,
    fps: 50,
    own: { resolution: "1080p", fps: 25 },
    sizes: ["Same as project (2560 x 1440)", "1080p", "720p", "480p"],
    rates: ["Same as project (50 fps)", "30 fps", "25 fps", "24 fps"],
    size: { words: "720p", value: "720p" },
    rate: { words: "30 fps", value: 30 },
  },
  {
    name: "1920 x 1080 at 72",
    width: 1920,
    height: 1080,
    fps: 72,
    own: { resolution: "720p", fps: 18 },
    sizes: ["Same as project (1920 x 1080)", "720p", "480p"],
    rates: ["Same as project (72 fps)", "60 fps", "50 fps", "30 fps", "25 fps", "24 fps"],
    fastExtraRate: "18 fps",
    size: { words: "480p", value: "480p" },
    rate: { words: "30 fps", value: 30 },
  },
];
/** Two more rows of the owner's table, for what Fast shows only. */
const MORE_OWN: Shape[] = [
  {
    name: "1280 x 720 at 25",
    width: 1280,
    height: 720,
    fps: 25,
    own: { resolution: "480p", fps: null },
    sizes: ["Same as project (1280 x 720)", "480p"],
    rates: ["Same as project (25 fps)", "24 fps"],
    size: null,
    rate: null,
  },
  {
    name: "7680 x 4320 at 30",
    width: 7680,
    height: 4320,
    fps: 30,
    own: { resolution: "2160p", fps: null },
    sizes: ["Same as project (7680 x 4320)", "2160p (4K)", "1440p", "1080p", "720p", "480p"],
    rates: ["Same as project (30 fps)", "25 fps", "24 fps"],
    size: null,
    rate: null,
  },
];
const byName = (name: string): Shape => SHAPES.find((shape) => shape.name.startsWith(name))!;
const UHD60 = byName("3840 x 2160");
const VERTICAL = byName("1080 x 1920");
const HD72 = byName("1920 x 1080 at 72");

type Choice = "quality" | "fast";
type Mounted = ReturnType<typeof mount>;

/** The view on a project (its canvas and the dialog's snapshot of it), with the stores as they are. */
function mount(shape: Shape, options: { workload?: boolean; fastChoice?: boolean } = {}) {
  setCanvas(shape.width, shape.height, shape.fps);
  const onStart = vi.fn<(settings: ExportSettings) => void>();
  const onCancel = vi.fn<() => void>();
  const user = userEvent.setup();
  const view = render(
    <ExportSettingsView
      workload={
        options.workload === false ? null : workloadOf(shape.width, shape.height, shape.fps)
      }
      onCancel={onCancel}
      onStart={onStart}
      fastChoice={options.fastChoice}
    />,
  );
  return { ...view, onStart, onCancel, user };
}

const radio = (name: "Quality" | "Fast") => screen.getByRole<HTMLInputElement>("radio", { name });
const group = () => screen.getByRole("radiogroup", { name: "export choice" });
const exportButton = () => screen.getByRole("button", { name: "Export" });
const resolutionBox = () =>
  screen.queryByRole("combobox", { name: "resolution", hidden: true }) as HTMLSelectElement | null;
const rateBox = () =>
  screen.queryByRole("combobox", { name: "frame rate", hidden: true }) as HTMLSelectElement | null;
const qualityBox = () =>
  screen.getByRole("combobox", { name: "quality", hidden: true }) as HTMLSelectElement;
const optionsOf = (box: HTMLElement | null): string[] | null =>
  box
    ? within(box)
        .getAllByRole("option", { hidden: true })
        .map((o) => o.textContent ?? "")
    : null;
const door = () => screen.getByRole("button", { name: "Advanced settings" });
const region = () => screen.getByTestId("export-advanced");
async function openDoor(view: Mounted): Promise<void> {
  if (door().getAttribute("aria-expanded") !== "true") await view.user.click(door());
}
/** A pick made the way a person makes it, by the words of the entry (Frame rate and Quality are behind the door). */
async function pickWords(
  view: Mounted,
  name: "resolution" | "frame rate" | "quality",
  words: string,
) {
  if (name !== "resolution") await openDoor(view);
  const box = screen.getByRole("combobox", { name });
  await view.user.selectOptions(box, within(box).getByRole("option", { name: words }));
}
/** What the three lists show now, as the values they hold (the rate select's "" is the project's own rate). */
function shownNow(): { resolution: string | null; rate: string | null; quality: string } {
  return {
    resolution: resolutionBox()?.value ?? null,
    rate: rateBox()?.value ?? null,
    quality: qualityBox().value,
  };
}
/** What the lists show where a choice starts, written out from the owner's table. */
function startOf(shape: Shape, choice: Choice) {
  const fast = choice === "fast";
  const resolution = shape.sizes === null ? null : fast ? shape.own.resolution : "source";
  const rate =
    shape.rates === null && !(fast && shape.fastExtraRate)
      ? null
      : fast && shape.own.fps !== null
        ? String(shape.own.fps)
        : "";
  return { resolution, rate, quality: "medium" };
}
/** The one object Export handed over, after pressing it once. */
async function press(view: Mounted): Promise<ExportSettings> {
  await view.user.click(exportButton());
  expect(view.onStart).toHaveBeenCalledTimes(1);
  return view.onStart.mock.calls[0][0];
}

describe("(a) the row at mount and in every state", () => {
  const expectRow = (checked: Choice) => {
    const row = group();
    // exactly two radios, named exactly Quality and Fast, in that order
    expect(within(row).getAllByRole("radio")).toHaveLength(2);
    expect(within(row).getAllByRole("radio")[0]).toBe(radio("Quality"));
    expect(within(row).getAllByRole("radio")[1]).toBe(radio("Fast"));
    expect(radio("Quality").checked).toBe(checked === "quality");
    expect(radio("Fast").checked).toBe(checked === "fast");
    // the plain word: no figure, no tooltip, no description, in the DOM hidden or not
    expect(row.textContent).toBe("QualityFast");
    expect(screen.queryAllByRole("tooltip", { hidden: true })).toHaveLength(0);
    expect(screen.queryByTestId("export-fast-tip")).toBeNull();
    expect(radio("Fast")).not.toHaveAttribute("aria-describedby");
    expect(radio("Quality")).not.toHaveAttribute("aria-describedby");
    expect(row.querySelector("[aria-describedby], [role='tooltip'], [title]")).toBeNull();
  };
  const STATES: [string, (view: Mounted) => Promise<void>, Choice][] = [
    ["at mount", async () => undefined, "quality"],
    ["with the door open", async (view) => openDoor(view), "quality"],
    ["after Fast is picked", async (view) => view.user.click(radio("Fast")), "fast"],
    [
      "after Fast is picked and the door opened",
      async (view) => {
        await view.user.click(radio("Fast"));
        await openDoor(view);
      },
      "fast",
    ],
    [
      "after Fast and a Resolution pick",
      async (view) => {
        await view.user.click(radio("Fast"));
        await pickWords(view, "resolution", "480p");
      },
      "fast",
    ],
    [
      "after Fast, then Quality again",
      async (view) => {
        await view.user.click(radio("Fast"));
        await view.user.click(radio("Quality"));
      },
      "quality",
    ],
  ];

  it.each(STATES)("%s", async (_name, act, checked) => {
    const view = mount(UHD60);
    await settle();
    await act(view);
    expectRow(checked);
  });

  it("is there for a project that cannot be read too (no canvas, no snapshot): Quality checked, nothing described", async () => {
    render(<ExportSettingsView workload={null} onCancel={vi.fn()} onStart={vi.fn()} />);
    await settle();
    expectRow("quality");
  });
});

describe("(b) Fast picked: the lists show Fast's own values", () => {
  it.each([...SHAPES, ...MORE_OWN])("by click on $name", async (shape) => {
    const view = mount(shape);
    await settle();
    // Quality's own start first: the project as it is, at Medium
    expect(shownNow()).toEqual(startOf(shape, "quality"));
    await view.user.click(radio("Fast"));
    expect(radio("Fast")).toBeChecked();
    expect(radio("Quality")).not.toBeChecked();
    expect(shownNow()).toEqual(startOf(shape, "fast"));
    // the lists themselves: Fast's list is Quality's, and gains Fast's own rate where the ladder has none (72 gives 18)
    expect(optionsOf(resolutionBox())).toEqual(shape.sizes);
    expect(optionsOf(rateBox())).toEqual(
      shape.fastExtraRate ? [...shape.rates!, shape.fastExtraRate] : shape.rates,
    );
    // what the selects show is what is on screen as words
    if (shape.sizes) {
      const shownWords = resolutionBox()!.selectedOptions[0].textContent;
      expect(shownWords).toBe(
        shape.own.resolution === "source"
          ? shape.sizes[0]
          : shape.own.resolution === "2160p"
            ? "2160p (4K)"
            : shape.own.resolution,
      );
    }
    expect(qualityBox().selectedOptions[0].textContent).toBe("Medium");
  });

  it.each([UHD60, VERTICAL, HD72])(
    "by keyboard on $name: the arrow key moves to Fast and picks it, and back to Quality",
    async (shape) => {
      const view = mount(shape);
      await settle();
      await view.user.tab();
      expect(document.activeElement).toBe(radio("Quality"));
      await view.user.keyboard("{ArrowRight}");
      expect(document.activeElement).toBe(radio("Fast"));
      expect(radio("Fast")).toBeChecked();
      expect(shownNow()).toEqual(startOf(shape, "fast"));
      await view.user.keyboard("{ArrowLeft}");
      expect(document.activeElement).toBe(radio("Quality"));
      expect(radio("Quality")).toBeChecked();
      expect(shownNow()).toEqual(startOf(shape, "quality"));
      await view.user.keyboard("{ArrowDown}");
      expect(radio("Fast")).toBeChecked();
      expect(shownNow()).toEqual(startOf(shape, "fast"));
      await view.user.keyboard("{ArrowUp}");
      expect(radio("Quality")).toBeChecked();
    },
  );

  it("Space on the Fast radio picks it the way the native group does", async () => {
    const view = mount(UHD60);
    await settle();
    await view.user.tab();
    await view.user.keyboard("{ArrowRight}");
    await view.user.keyboard("{ArrowLeft}");
    expect(radio("Quality")).toBeChecked();
    // focus moves without picking (a script moves it), then Space picks
    act(() => radio("Fast").focus());
    expect(radio("Quality")).toBeChecked();
    await view.user.keyboard(" ");
    expect(radio("Fast")).toBeChecked();
    expect(shownNow()).toEqual(startOf(UHD60, "fast"));
  });

  it("the Frame rate list holds Fast's own rate for either choice while the row is drawn (72 fps gives 18), and not without the row", async () => {
    const withRow = mount(HD72);
    await settle();
    expect(optionsOf(rateBox())).toEqual([...HD72.rates!, "18 fps"]);
    await withRow.user.click(radio("Fast"));
    expect(optionsOf(rateBox())).toEqual([...HD72.rates!, "18 fps"]);
    withRow.unmount();
    mount(HD72, { fastChoice: false });
    await settle();
    expect(optionsOf(rateBox())).toEqual(HD72.rates);
  });
});

interface Pick {
  name: string;
  size?: "same" | "list";
  rate?: "same" | "lower";
  quality?: "high" | "low";
}
const PICKS: Pick[] = [
  { name: "nothing" },
  { name: "Resolution Same as project", size: "same" },
  { name: "a Resolution from the list", size: "list" },
  { name: "Frame rate Same as project", rate: "same" },
  { name: "a lower Frame rate", rate: "lower" },
  { name: "Quality High", quality: "high" },
  { name: "Quality Low", quality: "low" },
  { name: "all three", size: "list", rate: "lower", quality: "low" },
];
/** Whether a person can make this pick on this shape with this choice: a pick needs its list, a "Same as project" pick needs the list to be showing something else (under Quality it already shows it). */
function possible(shape: Shape, choice: Choice, pick: Pick): boolean {
  if (
    pick.size === "same" &&
    !(choice === "fast" && shape.sizes !== null && shape.own.resolution !== "source")
  )
    return false;
  if (pick.size === "list" && shape.size === null) return false;
  if (
    pick.rate === "same" &&
    !(choice === "fast" && shape.rates !== null && shape.own.fps !== null)
  )
    return false;
  if (pick.rate === "lower" && shape.rate === null) return false;
  return true;
}
/** What Export must hand over: the choice's own values, each replaced by exactly what was picked, and the route with an explicit flag for exactly the levers that were touched. */
function expectedSent(shape: Shape, choice: Choice, pick: Pick): ExportSettings {
  const own = choice === "fast" ? shape.own : { resolution: "source" as Size, fps: null };
  const resolution: Size =
    pick.size === "same" ? "source" : pick.size === "list" ? shape.size!.value : own.resolution;
  const fps: number | null =
    pick.rate === "same" ? null : pick.rate === "lower" ? shape.rate!.value : own.fps;
  const quality = pick.quality ?? "medium";
  if (choice === "quality") return { resolution, quality, fps, mode: null };
  return {
    resolution,
    quality,
    fps,
    mode: null,
    route: {
      route: "quick",
      explicit: {
        size: pick.size !== undefined,
        fps: pick.rate !== undefined,
        quality: pick.quality !== undefined,
      },
    },
  };
}
async function makePicks(view: Mounted, shape: Shape, pick: Pick): Promise<void> {
  if (pick.size)
    await pickWords(view, "resolution", pick.size === "same" ? shape.sizes![0] : shape.size!.words);
  if (pick.rate)
    await pickWords(view, "frame rate", pick.rate === "same" ? shape.rates![0] : shape.rate!.words);
  if (pick.quality) await pickWords(view, "quality", pick.quality === "high" ? "High" : "Low");
}

describe("(c) what Export hands over, over the project shapes and the picks", () => {
  describe.each(SHAPES)("$name", (shape) => {
    describe.each<Choice>(["quality", "fast"])("%s", (choice) => {
      it.each(PICKS.filter((pick) => possible(shape, choice, pick)))("$name", async (pick) => {
        const view = mount(shape);
        await settle();
        if (choice === "fast") await view.user.click(radio("Fast"));
        await makePicks(view, shape, pick);
        const sent = await press(view);
        expect(sent).toStrictEqual(expectedSent(shape, choice, pick));
        // Quality sends no route key at all (not even an undefined one): the 0.28.0 object
        if (choice === "quality")
          expect(Object.keys(sent).sort()).toEqual(["fps", "mode", "quality", "resolution"]);
      });
    });
  });

  it("a size picked and then Fast's own size picked again is still the person's pick (explicit), and equal to the own value", async () => {
    const view = mount(UHD60);
    await settle();
    await view.user.click(radio("Fast"));
    await pickWords(view, "resolution", "720p");
    await pickWords(view, "resolution", "1080p");
    await pickWords(view, "frame rate", "25 fps");
    await pickWords(view, "frame rate", "30 fps");
    expect(await press(view)).toStrictEqual({
      resolution: "1080p",
      quality: "medium",
      fps: 30,
      mode: null,
      route: { route: "quick", explicit: { size: true, fps: true, quality: false } },
    });
  });

  it.each<[string, () => void]>([
    [
      "the app's look never answers",
      () => vi.mocked(decideExportEncoder).mockImplementation(() => new Promise(() => undefined)),
    ],
    [
      "the app's look fails",
      () =>
        vi.mocked(decideExportEncoder).mockImplementation(() => Promise.reject(new Error("no"))),
    ],
    [
      "the app's look wants the old Mode row",
      () =>
        vi.mocked(decideExportEncoder).mockImplementation(async () =>
          decision({
            showRow: true,
            defaultMode: "fast",
            reason: "over_minute",
            fullSeconds: 720,
            fastSeconds: 240,
          }),
        ),
    ],
    [
      "the app will use its lighter setting",
      () =>
        vi.mocked(decideExportEncoder).mockImplementation(async () => decision({ faster: true })),
    ],
  ])(
    "Fast leaves `mode` to the app (null) whatever the look says: %s; Quality sends what 0.28.0 sends",
    async (_name, arrange) => {
      arrange();
      const fast = mount(UHD60);
      await settle();
      await fast.user.click(radio("Fast"));
      const sentFast = await press(fast);
      expect(sentFast.mode).toBeNull();
      expect(sentFast.route).toEqual({
        route: "quick",
        explicit: { size: false, fps: false, quality: false },
      });
      fast.unmount();
      arrange();
      const quality = mount(UHD60);
      await settle();
      const sentQuality = await press(quality);
      expect(sentQuality).not.toHaveProperty("route");
      expect(Object.keys(sentQuality).sort()).toEqual(["fps", "mode", "quality", "resolution"]);
    },
  );

  it("Fast with no snapshot of the project (only the open canvas) sends Fast's own values and a null mode", async () => {
    const view = mount(UHD60, { workload: false });
    await settle();
    await view.user.click(radio("Fast"));
    expect(await press(view)).toStrictEqual({
      resolution: "1080p",
      quality: "medium",
      fps: 30,
      mode: null,
      route: { route: "quick", explicit: { size: false, fps: false, quality: false } },
    });
  });
});

describe("the app's look at the encoder is asked about what is shown, for either choice", () => {
  const lastAsked = () => vi.mocked(decideExportEncoder).mock.calls.at(-1)?.[0].settings;

  it("Fast on 4K at 60 is asked as 1080p at 30 at Medium, follows a pick, and Quality is asked as the project as it is", async () => {
    const view = mount(UHD60);
    await settle();
    expect(lastAsked()).toEqual({ resolution: "source", quality: "medium", fps: null });
    await view.user.click(radio("Fast"));
    await settle();
    expect(lastAsked()).toEqual({ resolution: "1080p", quality: "medium", fps: 30 });
    await pickWords(view, "resolution", "720p");
    await pickWords(view, "quality", "High");
    await settle();
    expect(lastAsked()).toEqual({ resolution: "720p", quality: "high", fps: 30 });
    await view.user.click(radio("Quality"));
    await settle();
    expect(lastAsked()).toEqual({ resolution: "source", quality: "medium", fps: null });
  });
});

describe("(d) picking a choice resets what the person picked", () => {
  it("Fast, then Resolution 480p and a lower rate and High, then Fast again (the already checked one): Fast's own values, nothing explicit", async () => {
    const view = mount(UHD60);
    await settle();
    await view.user.click(radio("Fast"));
    await pickWords(view, "resolution", "480p");
    await pickWords(view, "frame rate", "24 fps");
    await pickWords(view, "quality", "High");
    expect(shownNow()).toEqual({ resolution: "480p", rate: "24", quality: "high" });
    await view.user.click(radio("Fast"));
    expect(radio("Fast")).toBeChecked();
    expect(shownNow()).toEqual({ resolution: "1080p", rate: "30", quality: "medium" });
    expect(await press(view)).toStrictEqual({
      resolution: "1080p",
      quality: "medium",
      fps: 30,
      mode: null,
      route: { route: "quick", explicit: { size: false, fps: false, quality: false } },
    });
  });

  it("Fast with picks, then Quality: row 1 of the table (the project as it is, Medium), and what is sent is the 0.28.0 object", async () => {
    const view = mount(UHD60);
    await settle();
    await view.user.click(radio("Fast"));
    await pickWords(view, "resolution", "480p");
    await pickWords(view, "quality", "Low");
    await view.user.click(radio("Quality"));
    expect(shownNow()).toEqual({ resolution: "source", rate: "", quality: "medium" });
    expect(await press(view)).toStrictEqual({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: null,
    });
  });

  it("picks made under Quality are gone after Fast, and Fast then starts on its own values", async () => {
    const view = mount(UHD60);
    await settle();
    await pickWords(view, "resolution", "720p");
    await pickWords(view, "frame rate", "24 fps");
    await pickWords(view, "quality", "High");
    await view.user.click(radio("Fast"));
    expect(shownNow()).toEqual({ resolution: "1080p", rate: "30", quality: "medium" });
    expect(await press(view)).toStrictEqual({
      resolution: "1080p",
      quality: "medium",
      fps: 30,
      mode: null,
      route: { route: "quick", explicit: { size: false, fps: false, quality: false } },
    });
  });

  it("the already checked Quality resets the picks too", async () => {
    const view = mount(UHD60);
    await settle();
    await pickWords(view, "resolution", "720p");
    await pickWords(view, "quality", "Low");
    await view.user.click(radio("Quality"));
    expect(shownNow()).toEqual({ resolution: "source", rate: "", quality: "medium" });
    expect(await press(view)).toStrictEqual({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: null,
    });
  });

  it("Fast, Quality, Fast again: Fast's own values and no explicit flag, whatever was picked on the way", async () => {
    const view = mount(HD72);
    await settle();
    await view.user.click(radio("Fast"));
    await pickWords(view, "frame rate", "30 fps");
    await view.user.click(radio("Quality"));
    await pickWords(view, "resolution", "480p");
    await view.user.click(radio("Fast"));
    expect(shownNow()).toEqual({ resolution: "720p", rate: "18", quality: "medium" });
    expect(await press(view)).toStrictEqual({
      resolution: "720p",
      quality: "medium",
      fps: 18,
      mode: null,
      route: { route: "quick", explicit: { size: false, fps: false, quality: false } },
    });
  });
});

describe("(e) nothing is remembered between two openings", () => {
  it.each<[string, (view: Mounted) => Promise<void>]>([
    [
      "Fast with picks and the door open",
      async (view) => {
        await view.user.click(radio("Fast"));
        await pickWords(view, "resolution", "480p");
        await pickWords(view, "quality", "High");
      },
    ],
    [
      "Quality with picks and the door open",
      async (view) => {
        await pickWords(view, "frame rate", "24 fps");
        await pickWords(view, "quality", "Low");
      },
    ],
  ])(
    "after %s, the next opening is Quality, with no picks and the door closed",
    async (_name, act) => {
      const first = mount(UHD60);
      await settle();
      await act(first);
      first.unmount();
      const second = mount(UHD60);
      await settle();
      expect(radio("Quality")).toBeChecked();
      expect(radio("Fast")).not.toBeChecked();
      expect(door()).toHaveAttribute("aria-expanded", "false");
      expect(region()).toHaveAttribute("hidden");
      expect(shownNow()).toEqual({ resolution: "source", rate: "", quality: "medium" });
      expect(await press(second)).toStrictEqual({
        resolution: "source",
        quality: "medium",
        fps: null,
        mode: null,
      });
    },
  );
});

describe("(f) the click works everything out again from the project at that moment", () => {
  const FAST_ON_UHD60 = async () => {
    const view = mount(UHD60);
    await settle();
    await view.user.click(radio("Fast"));
    return view;
  };

  it("with no draw in between, Fast's own size and rate follow the project as it is now", async () => {
    const view = await FAST_ON_UHD60();
    expect(shownNow()).toEqual({ resolution: "1080p", rate: "30", quality: "medium" });
    const button = exportButton();
    act(() => {
      setCanvas(1920, 1080, 30);
      // not drawn again yet: the view still shows what it showed for 4K at 60
      expect(shownNow().resolution).toBe("1080p");
      button.click();
    });
    expect(view.onStart).toHaveBeenCalledTimes(1);
    expect(view.onStart.mock.calls[0][0]).toStrictEqual({
      resolution: "720p",
      quality: "medium",
      fps: null,
      mode: null,
      route: { route: "quick", explicit: { size: false, fps: false, quality: false } },
    });
  });

  it("with a draw in between it is the same", async () => {
    const view = await FAST_ON_UHD60();
    act(() => setCanvas(1920, 1080, 30));
    expect(shownNow()).toEqual({ resolution: "720p", rate: "", quality: "medium" });
    expect(await press(view)).toStrictEqual({
      resolution: "720p",
      quality: "medium",
      fps: null,
      mode: null,
      route: { route: "quick", explicit: { size: false, fps: false, quality: false } },
    });
  });

  it("a pick the project no longer holds drops its explicit flag at the click; the picks it still holds stay explicit", async () => {
    const view = await FAST_ON_UHD60();
    await pickWords(view, "resolution", "720p");
    await pickWords(view, "frame rate", "24 fps");
    await pickWords(view, "quality", "High");
    const button = exportButton();
    act(() => {
      // 1280 x 720 at 25: 720p is no smaller than the project now, 24 is still lower than 25
      setCanvas(1280, 720, 25);
      button.click();
    });
    expect(view.onStart.mock.calls[0][0]).toStrictEqual({
      resolution: "480p",
      quality: "high",
      fps: 24,
      mode: null,
      route: { route: "quick", explicit: { size: false, fps: true, quality: true } },
    });
  });

  it("the same with a draw in between: the dropped pick does not come back, and the kept ones are sent", async () => {
    const view = await FAST_ON_UHD60();
    await pickWords(view, "resolution", "720p");
    await pickWords(view, "frame rate", "24 fps");
    act(() => setCanvas(1280, 720, 25));
    expect(shownNow()).toEqual({ resolution: "480p", rate: "24", quality: "medium" });
    expect(await press(view)).toStrictEqual({
      resolution: "480p",
      quality: "medium",
      fps: 24,
      mode: null,
      route: { route: "quick", explicit: { size: false, fps: true, quality: false } },
    });
  });

  it("Quality too: the click sends the project as it is now, with no route", async () => {
    const view = mount(UHD60);
    await settle();
    await pickWords(view, "resolution", "720p");
    const button = exportButton();
    act(() => {
      setCanvas(1280, 720, 25);
      button.click();
    });
    expect(view.onStart.mock.calls[0][0]).toStrictEqual({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: null,
    });
  });
});

describe("(g) the click's own moves, for Fast as for Quality, and Cancel", () => {
  it.each<Choice>(["quality", "fast"])(
    "%s: the speed check is told once per click and not before, and the old Mode row is said to be off screen",
    async (choice) => {
      const hold = vi.spyOn(exportAsk, "holdExportAsk");
      const view = mount(UHD60);
      await settle();
      if (choice === "fast") await view.user.click(radio("Fast"));
      await pickWords(view, "quality", "Low");
      // picking, and choosing, are not asking
      expect(hold).not.toHaveBeenCalled();
      expect(exportAsk.exportAskedNow()).toBe(false);
      expect(useExportJob.getState().modeRowOnScreen).toBeNull();
      await view.user.click(exportButton());
      expect(hold).toHaveBeenCalledTimes(1);
      expect(exportAsk.exportAskedNow()).toBe(true);
      expect(useExportJob.getState().modeRowOnScreen).toBe(false);
      expect(view.onStart).toHaveBeenCalledTimes(1);
    },
  );

  it.each<Choice>(["quality", "fast"])(
    "%s: it says so even where the app wanted the old Mode row (which is never drawn)",
    async (choice) => {
      vi.mocked(decideExportEncoder).mockImplementation(async () =>
        decision({
          showRow: true,
          defaultMode: "fast",
          reason: "over_minute",
          fullSeconds: 720,
          fastSeconds: 240,
        }),
      );
      const view = mount(UHD60);
      await settle();
      if (choice === "fast") await view.user.click(radio("Fast"));
      expect(screen.queryByRole("radiogroup", { name: "export mode", hidden: true })).toBeNull();
      await view.user.click(exportButton());
      expect(useExportJob.getState().modeRowOnScreen).toBe(false);
    },
  );

  it.each<Choice>(["quality", "fast"])(
    "%s: Cancel hands over nothing, asks nothing and leaves the job's record alone",
    async (choice) => {
      const hold = vi.spyOn(exportAsk, "holdExportAsk");
      const view = mount(UHD60);
      await settle();
      if (choice === "fast") await view.user.click(radio("Fast"));
      await pickWords(view, "resolution", "720p");
      await view.user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(view.onCancel).toHaveBeenCalledTimes(1);
      expect(view.onStart).not.toHaveBeenCalled();
      expect(hold).not.toHaveBeenCalled();
      expect(useExportJob.getState().modeRowOnScreen).toBeNull();
      expect(exportAsk.exportAskedNow()).toBe(false);
    },
  );

  it("a second click sends a second, identical object (the view does not guard it; the dialog does)", async () => {
    const view = mount(UHD60);
    await settle();
    await view.user.click(radio("Fast"));
    await view.user.click(exportButton());
    await view.user.click(exportButton());
    expect(view.onStart).toHaveBeenCalledTimes(2);
    expect(view.onStart.mock.calls[1][0]).toStrictEqual(view.onStart.mock.calls[0][0]);
  });
});

describe("(h) the Graphics chip row stays mounted behind the closed door, in both choices, and is told the shown values", () => {
  const chipRow = () => screen.queryByTestId("chip-row");
  const chipGroup = () => screen.queryByRole("radiogroup", { name: "Graphics chip", hidden: true });

  it.each<Choice>(["quality", "fast"])(
    "%s: it is in the page behind the closed door and tested before anybody opens it",
    async (choice) => {
      pcWith([amd]);
      const view = mount(VERTICAL);
      if (choice === "fast") await view.user.click(radio("Fast"));
      await waitFor(() => expect(screen.getByTestId("chip-row-note")).toBeInTheDocument());
      expect(door()).toHaveAttribute("aria-expanded", "false");
      expect(region()).toHaveAttribute("hidden");
      expect(within(region()).getByTestId("chip-row")).toBeInTheDocument();
      expect(chipRow()).not.toBeVisible();
      const row = chipRow();
      // choosing again does not take it out and put it back
      await view.user.click(radio(choice === "fast" ? "Fast" : "Quality"));
      expect(chipRow()).toBe(row);
      expect(vi.mocked(runCapabilityProbe).mock.calls.length).toBeGreaterThan(0);
    },
  );

  it("is told the SHOWN values: Fast on 4K at 60 is tested as 1080p at 30 (a picture the chip serves), Quality on it as 4K at 60 (one it does not)", async () => {
    pcWith([amd]);
    const quality = mount(UHD60);
    await openDoor(quality);
    await settle();
    expect(chipGroup()).toBeNull();
    quality.unmount();
    const fast = mount(UHD60);
    await fast.user.click(radio("Fast"));
    await openDoor(fast);
    await waitFor(() => expect(chipGroup()).not.toBeNull());
    expect(screen.getByRole("radiogroup", { name: "Graphics chip" })).toBeVisible();
    // the person changes what is shown, and the row follows what is shown and not the choice's own values: back to the project's size and rate is 4K at 60 again
    await pickWords(fast, "resolution", "Same as project (3840 x 2160)");
    await settle();
    expect(chipGroup()).not.toBeNull(); // 4K at 30
    await pickWords(fast, "frame rate", "Same as project (60 fps)");
    await settle();
    expect(chipGroup()).toBeNull(); // 4K at 60
  });

  it("goes back to the choice's own values with the choice: Fast, then Quality, is 4K at 60 again", async () => {
    pcWith([amd]);
    const view = mount(UHD60);
    await view.user.click(radio("Fast"));
    await openDoor(view);
    await waitFor(() => expect(chipGroup()).not.toBeNull());
    await view.user.click(radio("Quality"));
    await settle();
    expect(chipGroup()).toBeNull();
  });
});

describe("(i) the light-compression sentence is Quality's only", () => {
  const SENTENCE =
    "To save time, ArtDaddy will use light compression; the picture may be slightly softer.";

  it("is drawn for Quality where the app's look says the lighter setting will be used, and never with Fast chosen, in either order", async () => {
    vi.mocked(decideExportEncoder).mockImplementation(async () => decision({ faster: true }));
    const view = mount(UHD60);
    await settle();
    await openDoor(view);
    expect(screen.getByText(SENTENCE)).toBeVisible();
    expect(screen.getAllByText(SENTENCE)).toHaveLength(1);
    await view.user.click(radio("Fast"));
    await settle();
    expect(screen.queryByText(SENTENCE)).toBeNull();
    expect(document.body.textContent).not.toContain("light compression");
    await view.user.click(radio("Quality"));
    await settle();
    expect(screen.getByText(SENTENCE)).toBeVisible();
  });

  it("is not drawn at all for Fast chosen first, door closed or open", async () => {
    vi.mocked(decideExportEncoder).mockImplementation(async () => decision({ faster: true }));
    const view = mount(UHD60);
    await view.user.click(radio("Fast"));
    await settle();
    expect(screen.queryByText(SENTENCE)).toBeNull();
    await openDoor(view);
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });

  it("is not drawn for Quality where the look does not say it", async () => {
    const view = mount(UHD60);
    await settle();
    await openDoor(view);
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });
});

describe("(j) the keyboard", () => {
  /** Presses Tab from the page's start until focus leaves the view, saying where it stopped each time. */
  async function tabStops(view: Mounted): Promise<string[]> {
    const stops: string[] = [];
    for (let presses = 0; presses < 20; presses += 1) {
      await view.user.tab();
      const element = document.activeElement;
      if (!element || element === document.body) return stops;
      stops.push(
        element instanceof HTMLInputElement && element.type === "radio"
          ? `radio ${element.closest("label")?.textContent?.trim() ?? ""}`
          : `${element.tagName.toLowerCase()} ${element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""}`,
      );
      if (document.getElementById("export-advanced")?.hasAttribute("hidden"))
        expect(region().contains(element)).toBe(false);
    }
    throw new Error(`Tab never left the view: ${stops.join(" > ")}`);
  }

  beforeEach(() => {
    const rule = document.createElement("style");
    rule.textContent = "[hidden] { display: none; }";
    rule.setAttribute("data-test-rule", "hidden");
    document.head.appendChild(rule);
  });
  afterEach(() => document.head.querySelector("[data-test-rule]")?.remove());

  it("the Tab order is the checked choice radio (one stop), Resolution, the door, Cancel, Export; nothing of the closed region", async () => {
    const view = mount(UHD60);
    await settle();
    expect(await tabStops(view)).toEqual([
      "radio Quality",
      "select resolution",
      "button Advanced settings",
      "button Cancel",
      "button Export",
    ]);
  });

  it("with Fast checked the one stop of the row is the Fast radio", async () => {
    const view = mount(UHD60);
    await settle();
    await view.user.click(radio("Fast"));
    // the click left focus on the radio: start again from the page's start
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await tabStops(view)).toEqual([
      "radio Fast",
      "select resolution",
      "button Advanced settings",
      "button Cancel",
      "button Export",
    ]);
  });

  it("on a project with no Resolution row the row is followed by the door", async () => {
    const view = mount(byName("854 x 480"));
    await settle();
    expect(await tabStops(view)).toEqual([
      "radio Quality",
      "button Advanced settings",
      "button Cancel",
      "button Export",
    ]);
  });

  it("goes back the same way with Shift+Tab, and the arrow keys moved the stop with the pick", async () => {
    const view = mount(UHD60);
    await settle();
    await view.user.tab();
    await view.user.keyboard("{ArrowRight}");
    expect(radio("Fast")).toBeChecked();
    await view.user.tab(); // Resolution
    await view.user.tab({ shift: true });
    expect(document.activeElement).toBe(radio("Fast"));
    await view.user.tab({ shift: true });
    expect(
      document.activeElement === document.body || !group().contains(document.activeElement),
    ).toBe(true);
  });

  it("opening the door with the keyboard changes nothing of what the row shows", async () => {
    const view = mount(UHD60);
    await settle();
    await view.user.click(radio("Fast"));
    await view.user.tab(); // from the Fast radio... or wherever focus was: walk to the door
    for (let presses = 0; presses < 6 && document.activeElement !== door(); presses += 1)
      await view.user.tab();
    expect(document.activeElement).toBe(door());
    await view.user.keyboard("{Enter}");
    expect(door()).toHaveAttribute("aria-expanded", "true");
    expect(radio("Fast")).toBeChecked();
    expect(shownNow()).toEqual({ resolution: "1080p", rate: "30", quality: "medium" });
  });

  it.each([
    "radio Quality",
    "radio Fast",
    "select resolution",
    "button Advanced settings",
    "button Cancel",
    "button Export",
  ])(
    "Escape pressed on %s is the dialog's: the view does not handle it, cancel it or stop it",
    async (where) => {
      const view = mount(UHD60);
      await settle();
      const reached: boolean[] = [];
      const watch = (event: KeyboardEvent): void => {
        if (event.key === "Escape") reached.push(event.defaultPrevented);
      };
      window.addEventListener("keydown", watch);
      try {
        const targets: Record<string, () => HTMLElement> = {
          "radio Quality": () => radio("Quality"),
          "radio Fast": () => radio("Fast"),
          "select resolution": () => resolutionBox()!,
          "button Advanced settings": () => door(),
          "button Cancel": () => screen.getByRole("button", { name: "Cancel" }),
          "button Export": () => exportButton(),
        };
        const target = targets[where];
        act(() => target().focus());
        await view.user.keyboard("{Escape}");
      } finally {
        window.removeEventListener("keydown", watch);
      }
      // the event went on to the dialog (the window here), untouched; the view did nothing with it
      expect(reached).toEqual([false]);
      expect(view.onCancel).not.toHaveBeenCalled();
      expect(view.onStart).not.toHaveBeenCalled();
      expect(radio("Quality")).toBeChecked();
      expect(useExportJob.getState().modeRowOnScreen).toBeNull();
    },
  );
});
