// T11 and K1 of the D2 UI spec (section 5 and risk K1 / finding F3): the Graphics chip row inside the closed door.
// The chip row's FIRST look decides what Quality sends (`mode` is null once the row has answered, "quality" while it has not), so the row must be MOUNTED while the door is closed and only hidden. This file holds:
//  - the row is inside the region `export-advanced`, drawn and asked (the capability probe ran) before anybody opened the door, and not visible until the door opens; no chip found: no row; no project: no row, no test;
//  - the row's note: the owner's sentence for "passed", the 0.28.0 words for the other four states (written out here, not read from chipRow.ts);
//  - Off is written to the per-PC switch (artdaddy.chipPref.v1), the row is still there in a view mounted again so that Off can be undone, and what Export sends is identical for Auto and Off;
//  - the orderings of the chip row's first look and the app's look (either first, either never, no chip at all): what Export sends equals what the 0.28.0 dialog sends at every press.
// Mutants this file must kill: the chip row rendered only while the door is open; the chip row unmounted and mounted again by the door; `mode` read from a chip row that is not mounted; Off changing the object; the 0.28.0
// "passed" note shown; a chip row drawn without a chip or without a project.
import { act, cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __setExportFlag, type ExportFlagName } from "../api/exportFlags";
import {
  processorName,
  resolveExportResources,
  runCapabilityProbe,
  type GraphicsAdapter,
} from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { amd, harness, type Behaviour } from "../test/chipHarness";
import { __resetChipTests, markChipSuspect } from "../timeline/chipTest";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import type { RenderWorkload } from "../timeline/renderPlan";
import ExportDialog, { type ExportSettings } from "./ExportDialog";
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

// The row's first look runs the real chip test, whose modules load on first use: where every test file runs at once that can take longer than the one second `waitFor` allows by default. A wait ends as
// soon as the note says what it should; this bounds only a note that never does.
configure({ asyncUtilTimeout: 10_000 });

const FLAGS: readonly ExportFlagName[] = [
  "chip_amd",
  "chip_nvidia",
  "chip_intel",
  "chip_default",
  "quick_export",
];
/** The per-PC switch's key, written out: a rename would orphan every person's stored Off. */
const CHIP_PREF = "artdaddy.chipPref.v1";

/** The chip row's note in each state. The passed one is this view's sentence (the chip is used whenever it passed); the others are 0.28.0's words. */
const NOTES = {
  checking: "Checking this PC's graphics chip\u2026",
  passed: "Auto: used on this PC. The file is usually larger and the picture can differ slightly.",
  notPassed:
    "Auto: not used. The graphics chip did not pass ArtDaddy's test on this PC, so exports use the processor.",
  setAside:
    "The graphics chip stopped an export on this PC, so it is set aside for a day. Try it again now",
  off: "Off: the graphics chip is not tested, offered or used on this PC. Everything runs on the processor.",
} as const;

type Resources = Awaited<ReturnType<typeof resolveExportResources>>;
const resourcesWith = (adapters: GraphicsAdapter[]): Resources => ({
  total_memory_bytes: null,
  available_memory_bytes: null,
  scratch_free_bytes: null,
  destination_free_bytes: null,
  budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
  adapters,
});

interface PcOptions {
  /** How the scripted ffmpeg behaves (a chip that fails its test, ...). */
  behaviour?: Behaviour;
  /** The chip's test (its probe commands) waits until this opens. */
  probeGate?: Promise<void>;
  /** The chip row's first look (its question to the PC) waits until this resolves. */
  resourcesGate?: Promise<Resources>;
}
function pcWith(adapters: GraphicsAdapter[], options: PcOptions = {}): void {
  const scripted = harness(adapters, options.behaviour ?? {});
  vi.mocked(runCapabilityProbe).mockReset();
  vi.mocked(runCapabilityProbe).mockImplementation(async (args, probeOptions) => {
    if (options.probeGate) await options.probeGate;
    return scripted.deps.probe(args, probeOptions);
  });
  vi.mocked(resolveExportResources).mockReset();
  vi.mocked(resolveExportResources).mockImplementation(
    () => options.resourcesGate ?? Promise.resolve(resourcesWith(adapters)),
  );
  vi.mocked(processorName).mockReset();
  vi.mocked(processorName).mockResolvedValue(null);
}

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
const wantsRow = (): ExportEncoderDecision =>
  decision({
    showRow: true,
    defaultMode: "fast",
    reason: "over_minute",
    fullSeconds: 720,
    fastSeconds: 240,
    facts: { encoder: "x264", chip: "amd", reason: "none", tests: [] },
  });

const PROJECT: RenderWorkload = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationSeconds: 120,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
};
/** What an untouched Export sends. */
const sent = (mode: "quality" | null): ExportSettings => ({
  resolution: "source",
  quality: "medium",
  fps: null,
  mode,
});

const noop = (): void => undefined;
const settleAll = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));
const note = () => screen.getByTestId("chip-row-note");
const door = () => screen.getByRole("button", { name: "Advanced settings" });
const region = () => screen.getByTestId("export-advanced");
const exportButton = () => screen.getByRole("button", { name: "Export" });
/** The chip's own test commands (as opposed to the PC's other probes). */
const chipCalls = () =>
  vi
    .mocked(runCapabilityProbe)
    .mock.calls.filter(([, options]) => options.kind.startsWith("chip-test"));
const lastSent = (onStart: { mock: { calls: unknown[][] } }): ExportSettings => {
  const calls = onStart.mock.calls;
  return calls[calls.length - 1][0] as ExportSettings;
};

/** A clean PC state and clean stores: the view starts every test from an opening with nothing remembered. */
function resetWorld(): void {
  for (const flag of FLAGS) __setExportFlag(flag, true);
  localStorage.clear();
  __resetChipTests();
  useEditor.setState({ timeline: null });
  useExportJob.getState().reset();
  useExportJob.getState().setEngine("auto");
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(async () => decision());
}

beforeEach(() => {
  resetWorld();
  pcWith([]);
});

const mount = (
  workload: RenderWorkload | null = PROJECT,
  onStart = vi.fn<(settings: ExportSettings) => void>(),
) => {
  const view = render(<ExportSettingsView workload={workload} onCancel={noop} onStart={onStart} />);
  return { ...view, onStart, user: userEvent.setup() };
};

describe("T11: the Graphics chip row sits inside the door, mounted while the door is closed", () => {
  it("is in the region, was asked about the PC before anybody pressed anything, and is not visible until the door opens", async () => {
    pcWith([amd]);
    const { user } = mount();
    await waitFor(() => expect(note().textContent).toBe(NOTES.passed));

    // nobody has clicked: the chip's test has run all the same (the row's first look is what Quality's `mode` waits for)
    expect(chipCalls().length).toBeGreaterThan(0);
    expect(door()).toHaveAttribute("aria-expanded", "false");
    expect(region()).toHaveAttribute("hidden");
    expect(within(region()).getByTestId("chip-row")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Graphics chip" })).toBeNull();
    expect(
      screen.getByRole("radiogroup", { name: "Graphics chip", hidden: true }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("chip-row")).not.toBeVisible();

    await user.click(door());
    expect(door()).toHaveAttribute("aria-expanded", "true");
    expect(region()).not.toHaveAttribute("hidden");
    expect(screen.getByRole("radiogroup", { name: "Graphics chip" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Auto" })).toBeChecked();
    expect(note()).toBeVisible();
  });

  it("is drawn nowhere on a PC with no chip, with the door closed or open, and tests nothing", async () => {
    pcWith([]);
    const { user } = mount();
    await settleAll();
    expect(screen.queryByTestId("chip-row")).toBeNull();
    await user.click(door());
    await settleAll();
    expect(screen.queryByTestId("chip-row")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Graphics chip", hidden: true })).toBeNull();
    expect(runCapabilityProbe).not.toHaveBeenCalled();
  });

  it("is drawn nowhere and tests nothing when there is no project to export", async () => {
    pcWith([amd]);
    const { user } = mount(null);
    await settleAll();
    await user.click(door());
    await settleAll();
    expect(screen.queryByTestId("chip-row")).toBeNull();
    expect(runCapabilityProbe).not.toHaveBeenCalled();
  });

  it("is not remounted or asked again by pressing the door: the first look is the one Quality's `mode` waits for", async () => {
    pcWith([amd]);
    const { user, onStart } = mount();
    await waitFor(() => expect(note().textContent).toBe(NOTES.passed));
    await settleAll();
    const asked = vi.mocked(resolveExportResources).mock.calls.length;
    const tested = chipCalls().length;
    const row = screen.getByTestId("chip-row");

    await user.click(door());
    await user.click(door());
    await user.click(door());
    await settleAll();
    expect(screen.getByTestId("chip-row")).toBe(row); // the same element: it was never taken out and put back
    expect(vi.mocked(resolveExportResources).mock.calls.length).toBe(asked);
    expect(chipCalls().length).toBe(tested);
    await user.click(exportButton());
    expect(lastSent(onStart)).toStrictEqual(sent(null));
  });
});

describe("T11: the chip row's note", () => {
  it("is the owner's sentence once the chip has passed its test", async () => {
    pcWith([amd]);
    mount();
    await waitFor(() => expect(note().textContent).toBe(NOTES.passed));
    expect(screen.queryByTestId("chip-row-hint")).toBeNull();
  });

  it("is 0.28.0's while the chip is being tested", async () => {
    pcWith([amd], { probeGate: new Promise<void>(() => undefined) });
    mount();
    await waitFor(() => expect(note().textContent).toBe(NOTES.checking));
    expect(screen.getByRole("radio", { name: "Auto", hidden: true })).toBeChecked();
  });

  it("is 0.28.0's where the chip did not pass its test", async () => {
    pcWith([amd], { behaviour: { chip: "fail" } });
    mount();
    await waitFor(() => expect(note().textContent).toBe(NOTES.notPassed));
  });

  it("is 0.28.0's where the chip stopped an export and is set aside, with its link", async () => {
    pcWith([amd]);
    const first = mount();
    await waitFor(() => expect(note().textContent).toBe(NOTES.passed));
    first.unmount();

    markChipSuspect(amd);
    mount();
    await waitFor(() => expect(note().textContent).toBe(NOTES.setAside));
    expect(
      screen.getByRole("button", { name: "Try it again now", hidden: true }),
    ).toBeInTheDocument();
  });

  it("is 0.28.0's where the person has switched the chip Off", async () => {
    pcWith([amd]);
    localStorage.setItem(CHIP_PREF, "off");
    mount();
    await waitFor(() => expect(note().textContent).toBe(NOTES.off));
    expect(screen.getByRole("radio", { name: "Off", hidden: true })).toBeChecked();
  });
});

describe("T11: Off is the person's per-PC switch and changes nothing that is sent", () => {
  it("writes the switch, is still drawn when the view is mounted again so that it can be undone, and Export sends the same object for Auto and Off", async () => {
    pcWith([amd]);
    const first = mount();
    await waitFor(() => expect(note().textContent).toBe(NOTES.passed));
    await settleAll();
    await first.user.click(exportButton());
    const withAuto = lastSent(first.onStart);

    await first.user.click(door());
    const asked = vi.mocked(decideExportEncoder).mock.calls.length;
    await first.user.click(screen.getByRole("radio", { name: "Off" }));
    expect(localStorage.getItem(CHIP_PREF)).toBe("off");
    await waitFor(() => expect(note().textContent).toBe(NOTES.off));
    // the app is asked about the encoder again when the switch changes, and its answer is in before Export is pressed
    await waitFor(() =>
      expect(vi.mocked(decideExportEncoder).mock.calls.length).toBeGreaterThan(asked),
    );
    await settleAll();
    await first.user.click(exportButton());
    const withOff = lastSent(first.onStart);

    expect(withAuto).toStrictEqual(sent(null));
    expect(withOff).toStrictEqual(withAuto);
    first.unmount();

    // a view mounted again: the person's Off is still there to be undone
    const second = mount();
    await waitFor(() => expect(note().textContent).toBe(NOTES.off));
    await second.user.click(door());
    expect(screen.getByRole("radio", { name: "Off" })).toBeChecked();
    await second.user.click(screen.getByRole("radio", { name: "Auto" }));
    expect(localStorage.getItem(CHIP_PREF)).toBeNull();
    await waitFor(() => expect(note().textContent).toBe(NOTES.passed));
    await settleAll();
    await second.user.click(exportButton());
    expect(lastSent(second.onStart)).toStrictEqual(withAuto);
  });

  it("shows the row where Off is stored even at a size the chip does not serve, so it can be undone", async () => {
    pcWith([amd]);
    localStorage.setItem(CHIP_PREF, "off");
    mount({ ...PROJECT, width: 3840, height: 2160, fps: 60 });
    await waitFor(() => expect(note().textContent).toBe(NOTES.off));
    expect(screen.getByRole("radio", { name: "Auto", hidden: true })).not.toBeChecked();
  });
});

type Side = "legacy" | "view";
type Step = "press" | "chip" | "look";
interface Ordering {
  name: string;
  adapters: GraphicsAdapter[];
  /** The app's look answers (wanting a row) at once, only when the "look" step comes, or never. */
  look: "now" | "late" | "never";
  /** The chip row's first look is answered at once, or only when the "chip" step comes. */
  chip: "now" | "late";
  steps: Step[];
  /** What `mode` each "press" sends, written out. */
  modes: ("quality" | null)[];
}

const ORDERINGS: Ordering[] = [
  {
    name: "the chip row answers after the look, which wanted a row",
    adapters: [amd],
    look: "now",
    chip: "late",
    steps: ["press", "chip", "press"],
    modes: ["quality", null],
  },
  {
    name: "the look answers after the chip row",
    adapters: [amd],
    look: "late",
    chip: "now",
    steps: ["press", "look", "press"],
    modes: ["quality", null],
  },
  {
    name: "the look answers first, then the chip row",
    adapters: [amd],
    look: "late",
    chip: "late",
    steps: ["press", "look", "press", "chip", "press"],
    modes: ["quality", "quality", null],
  },
  {
    name: "the chip row answers first, then the look",
    adapters: [amd],
    look: "late",
    chip: "late",
    steps: ["press", "chip", "press", "look", "press"],
    modes: ["quality", "quality", null],
  },
  {
    name: "both have answered",
    adapters: [amd],
    look: "now",
    chip: "now",
    steps: ["press"],
    modes: [null],
  },
  {
    name: "the look never answers although the chip row has",
    adapters: [amd],
    look: "never",
    chip: "now",
    steps: ["press"],
    modes: ["quality"],
  },
  {
    name: "a PC with no chip: the chip row has answered that there is nothing to draw, and the look wanted a row",
    adapters: [],
    look: "now",
    chip: "now",
    steps: ["press"],
    modes: [null],
  },
  {
    name: "a PC with no chip, the chip row's first look still out",
    adapters: [],
    look: "now",
    chip: "late",
    steps: ["press", "chip", "press"],
    modes: ["quality", null],
  },
];

/** One ordering on one side: the same PC, the same gates, Export pressed at each "press". Returns what each press sent. */
async function runOrdering(side: Side, ordering: Ordering): Promise<ExportSettings[]> {
  cleanup();
  resetWorld();
  let releaseChip: () => void = noop;
  let releaseLook: () => void = noop;
  const resourcesGate =
    ordering.chip === "late"
      ? new Promise<Resources>((resolve) => {
          releaseChip = () => resolve(resourcesWith(ordering.adapters));
        })
      : undefined;
  const lookGate =
    ordering.look === "late"
      ? new Promise<ExportEncoderDecision>((resolve) => {
          releaseLook = () => resolve(wantsRow());
        })
      : undefined;
  pcWith(ordering.adapters, { resourcesGate });
  vi.mocked(decideExportEncoder).mockImplementation(() =>
    ordering.look === "never"
      ? new Promise<ExportEncoderDecision>(() => undefined)
      : (lookGate ?? Promise.resolve(wantsRow())),
  );
  const onStart = vi.fn<(settings: ExportSettings) => void>();
  render(
    side === "legacy" ? (
      <ExportDialog open onCancel={noop} onStart={onStart} workload={PROJECT} />
    ) : (
      <ExportSettingsView workload={PROJECT} onCancel={noop} onStart={onStart} />
    ),
  );
  await settleAll();
  const user = userEvent.setup();
  const pressed: ExportSettings[] = [];
  for (const step of ordering.steps) {
    if (step === "chip") {
      releaseChip();
      await settleAll();
    } else if (step === "look") {
      releaseLook();
      await settleAll();
    } else {
      await user.click(exportButton());
      pressed.push(lastSent(onStart));
    }
  }
  return pressed;
}

describe("K1 / F3: the order in which the chip row's first look and the app's look answer decides `mode`, as in 0.28.0", () => {
  it.each(ORDERINGS)("$name", async (ordering) => {
    const legacy = await runOrdering("legacy", ordering);
    const view = await runOrdering("view", ordering);
    expect(legacy).toStrictEqual(ordering.modes.map((mode) => sent(mode)));
    expect(view).toStrictEqual(legacy);
  });

  it("is not changed by pressing the door while the chip row's first look is out", async () => {
    let release: () => void = noop;
    const gate = new Promise<Resources>((resolve) => {
      release = () => resolve(resourcesWith([amd]));
    });
    pcWith([amd], { resourcesGate: gate });
    vi.mocked(decideExportEncoder).mockImplementation(async () => wantsRow());
    const { user, onStart } = mount();
    await settleAll();
    await user.click(door());
    await user.click(door());
    await user.click(exportButton());
    expect(lastSent(onStart)).toStrictEqual(sent("quality"));
    release();
    await settleAll();
    await user.click(exportButton());
    expect(lastSent(onStart)).toStrictEqual(sent(null));
  });
});
