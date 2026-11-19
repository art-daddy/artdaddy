// T2 of the D2 UI spec (section 5, invariant I2): Quality sends what 0.28.0 sends. The 0.28.0 dialog (`ExportDialog` rendered WITHOUT the prop `quickRoute`) is the frozen oracle: every scenario runs through it and
// through the new settings view with the same PC, the same answer of the app, the same chip row and the same picks, Export is pressed in each, and what `onStart` received is compared (strictly: a `route` key, even an
// undefined one, is a difference). The old Mode row is never drawn in the new view, so what the export job store says about it (`modeRowOnScreen`) differs on purpose in exactly the scenarios where 0.28.0 draws the row.
// Mutants this file must kill: `mode` computed as if a Mode row were drawn; the chip row unmounted behind the closed door; `modeRowOnScreen` left unset or true; a pick not sent; a `route` key on the object;
// an answer that counts after the history of this PC's exports changed under it (`answer.history === calibrations` dropped); one that counts after the person changed the Graphics chip switch (`chipEpoch` left out
// of the question's key).
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
import { amd, harness } from "../test/chipHarness";
import { __resetChipTests } from "../timeline/chipTest";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "../timeline/exportOptions";
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

const FLAGS: readonly ExportFlagName[] = [
  "chip_amd",
  "chip_nvidia",
  "chip_intel",
  "chip_default",
  "quick_export",
];

type Resources = Awaited<ReturnType<typeof resolveExportResources>>;
const resourcesWith = (adapters: GraphicsAdapter[]): Resources => ({
  total_memory_bytes: null,
  available_memory_bytes: null,
  scratch_free_bytes: null,
  destination_free_bytes: null,
  budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
  adapters,
});

/** A PC with these graphics chips and a scripted ffmpeg; `gate` holds the chip row's first look (its question to the PC) until it is released. */
function pcWith(adapters: GraphicsAdapter[], gate?: Promise<Resources>): void {
  const scripted = harness(adapters);
  vi.mocked(runCapabilityProbe).mockReset();
  vi.mocked(runCapabilityProbe).mockImplementation((args, options) =>
    scripted.deps.probe(args, options),
  );
  vi.mocked(resolveExportResources).mockReset();
  vi.mocked(resolveExportResources).mockImplementation(
    () => gate ?? Promise.resolve(resourcesWith(adapters)),
  );
  vi.mocked(processorName).mockReset();
  vi.mocked(processorName).mockResolvedValue(null);
}

/** What the app decided about the encoder: no chip and no row, unless a test says otherwise. */
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
/** A chip has proven itself and the export is long: the app wants the old Mode row, on Fast. */
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
const sized = (width: number, height: number, fps: number): RenderWorkload => ({
  ...PROJECT,
  width,
  height,
  fps,
});
const UHD_60 = sized(3840, 2160, 60);
/** A picture no size class holds (above 60 frames a second): the Graphics chip row is not drawn for it. */
const UHD_120 = sized(3840, 2160, 120);
const SD_30 = sized(854, 480, 30);

/** One run this PC has measured for the project above: what the history of exports holds after a background export (the shape the 0.28.0 dialog's own tests use). */
const EARLIER_EXPORT: ExportCalibration = {
  workload: PROJECT,
  output: { width: 1920, height: 1080, fps: 30 },
  quality: "medium",
  engine: "file-sequence-v1",
  encoder: "x264-crf",
  revision: EXPORT_SPEED_REVISION,
  elapsedSeconds: 150,
  finalBytes: 48_000_000,
  memoryBytes: null,
  temporaryBytes: null,
};

/** What an untouched Export sends: the project's own size and rate at Medium, and `mode` as the app's look leaves it. */
const sent = (over: Partial<ExportSettings> = {}): ExportSettings => ({
  resolution: "source",
  quality: "medium",
  fps: null,
  mode: null,
  ...over,
});

interface Picks {
  /** A size preset by its name, e.g. "720p". */
  size?: string;
  rate?: number;
  quality?: "high" | "medium" | "low";
}
interface Press {
  /** What Export must send, written out. */
  sent: ExportSettings;
  /** Whether the 0.28.0 dialog draws its own Mode row when Export is pressed (the new view never does). */
  legacyDrawsModeRow: boolean;
}
interface Scenario {
  name: string;
  workload: RenderWorkload | null;
  adapters: GraphicsAdapter[];
  /** The app's answer to the encoder look, as often as it is asked. */
  look: () => Promise<ExportEncoderDecision>;
  /** What the app says to every question after the first (the first is `look`'s): the answer in hand is then for settings, a history or a chip switch that have since changed. */
  thenLook?: () => Promise<ExportEncoderDecision>;
  /** Something that happens after the app has answered and before Export is pressed. */
  between?: Between;
  /** The chip row's first look waits until it is released after the first press: one press in the gap, one after. */
  chipGate?: boolean;
  picks?: Picks;
  presses: Press[];
}

/** The history of this PC's exports gets a new record, or the person switches the Graphics chip Off. */
type Between = "history" | "chip-off";

const answers = (decided: () => ExportEncoderDecision) => async () => decided();
const never = () => new Promise<ExportEncoderDecision>(() => undefined);

const SCENARIOS: Scenario[] = [
  {
    name: "the look answered with no row",
    workload: PROJECT,
    adapters: [],
    look: answers(decision),
    presses: [{ sent: sent(), legacyDrawsModeRow: false }],
  },
  {
    name: "the look wants a row and no chip row exists: 0.28.0 draws its Mode row and the person leaves it alone",
    workload: PROJECT,
    adapters: [],
    look: answers(wantsRow),
    presses: [{ sent: sent(), legacyDrawsModeRow: true }],
  },
  {
    name: "the look wants a row and the chip row has answered",
    workload: PROJECT,
    adapters: [amd],
    look: answers(wantsRow),
    presses: [{ sent: sent(), legacyDrawsModeRow: false }],
  },
  {
    name: "the gap: the look wants a row and the chip row has not answered yet; then it has",
    workload: PROJECT,
    adapters: [amd],
    look: answers(wantsRow),
    chipGate: true,
    presses: [
      { sent: sent({ mode: "quality" }), legacyDrawsModeRow: false },
      { sent: sent(), legacyDrawsModeRow: false },
    ],
  },
  {
    name: "the look never answers",
    workload: PROJECT,
    adapters: [],
    look: never,
    presses: [{ sent: sent({ mode: "quality" }), legacyDrawsModeRow: false }],
  },
  {
    name: "the look never answers although the chip row has",
    workload: PROJECT,
    adapters: [amd],
    look: never,
    presses: [{ sent: sent({ mode: "quality" }), legacyDrawsModeRow: false }],
  },
  {
    name: "the look fails",
    workload: PROJECT,
    adapters: [],
    look: () => Promise.reject(new Error("the app could not say")),
    presses: [{ sent: sent({ mode: "quality" }), legacyDrawsModeRow: false }],
  },
  {
    name: "no workload",
    workload: null,
    adapters: [amd],
    look: answers(wantsRow),
    presses: [{ sent: sent({ mode: "quality" }), legacyDrawsModeRow: false }],
  },
  {
    name: "the app will use its faster setting (a decision with the faster flag, no row)",
    workload: PROJECT,
    adapters: [],
    look: answers(() => decision({ faster: true })),
    presses: [{ sent: sent(), legacyDrawsModeRow: false }],
  },
  {
    name: "the default project, 1080 x 1920 at 30, on a PC with a chip",
    workload: PROJECT,
    adapters: [amd],
    look: answers(decision),
    presses: [{ sent: sent(), legacyDrawsModeRow: false }],
  },
  {
    name: "3840 x 2160 at 60",
    workload: UHD_60,
    adapters: [amd],
    look: answers(decision),
    presses: [{ sent: sent(), legacyDrawsModeRow: false }],
  },
  {
    name: "3840 x 2160 at 60 where the look wants a row and the chip is served at that size (class uhd60): 0.28.0 draws the chip row and not its Mode row",
    workload: UHD_60,
    adapters: [amd],
    look: answers(wantsRow),
    presses: [{ sent: sent(), legacyDrawsModeRow: false }],
  },
  {
    name: "3840 x 2160 at 120 where the look wants a row and no class holds that picture: 0.28.0 draws its Mode row",
    workload: UHD_120,
    adapters: [amd],
    look: answers(wantsRow),
    presses: [{ sent: sent(), legacyDrawsModeRow: true }],
  },
  {
    name: "854 x 480 at 30",
    workload: SD_30,
    adapters: [amd],
    look: answers(decision),
    presses: [{ sent: sent(), legacyDrawsModeRow: false }],
  },
  {
    name: "a smaller size is picked",
    workload: PROJECT,
    adapters: [],
    look: answers(decision),
    picks: { size: "720p" },
    presses: [{ sent: sent({ resolution: "720p" }), legacyDrawsModeRow: false }],
  },
  {
    name: "a lower rate is picked",
    workload: PROJECT,
    adapters: [],
    look: answers(decision),
    picks: { rate: 24 },
    presses: [{ sent: sent({ fps: 24 }), legacyDrawsModeRow: false }],
  },
  {
    name: "another quality is picked: High",
    workload: PROJECT,
    adapters: [amd],
    look: answers(decision),
    picks: { quality: "high" },
    presses: [{ sent: sent({ quality: "high" }), legacyDrawsModeRow: false }],
  },
  {
    name: "another quality is picked: Low",
    workload: PROJECT,
    adapters: [],
    look: answers(decision),
    picks: { quality: "low" },
    presses: [{ sent: sent({ quality: "low" }), legacyDrawsModeRow: false }],
  },
  {
    name: "a size, a rate and a quality are picked together",
    workload: PROJECT,
    adapters: [],
    look: answers(decision),
    picks: { size: "480p", rate: 25, quality: "low" },
    presses: [
      {
        sent: sent({ resolution: "480p", fps: 25, quality: "low" }),
        legacyDrawsModeRow: false,
      },
    ],
  },
  {
    name: "the three picks on 3840 x 2160 at 60",
    workload: UHD_60,
    adapters: [],
    look: answers(decision),
    picks: { size: "1080p", rate: 30, quality: "high" },
    presses: [
      {
        sent: sent({ resolution: "1080p", fps: 30, quality: "high" }),
        legacyDrawsModeRow: false,
      },
    ],
  },
  {
    name: "a pick made while the look has not answered",
    workload: PROJECT,
    adapters: [],
    look: never,
    picks: { size: "720p" },
    presses: [{ sent: sent({ resolution: "720p", mode: "quality" }), legacyDrawsModeRow: false }],
  },
  {
    name: "a size pick that moves the chip row from 4K at 60 (class uhd60) to 1080p at 60 (class hd) and the look wants a row",
    workload: UHD_60,
    adapters: [amd],
    look: answers(wantsRow),
    picks: { size: "1080p" },
    presses: [{ sent: sent({ resolution: "1080p" }), legacyDrawsModeRow: false }],
  },
  {
    name: "a size and a rate pick that bring the chip row back (1080p at 60 is served, 4K at 120 is not) and the look wants a row",
    workload: UHD_120,
    adapters: [amd],
    look: answers(wantsRow),
    picks: { size: "1080p", rate: 60 },
    presses: [{ sent: sent({ resolution: "1080p", fps: 60 }), legacyDrawsModeRow: false }],
  },
  {
    name: "the history of this PC's exports changes after the app has answered, and Export is pressed before it answers again",
    workload: PROJECT,
    adapters: [],
    look: answers(decision),
    thenLook: never,
    between: "history",
    presses: [{ sent: sent({ mode: "quality" }), legacyDrawsModeRow: false }],
  },
  {
    name: "the person switches the Graphics chip Off after the app has answered, and Export is pressed before it answers again",
    workload: PROJECT,
    adapters: [amd],
    look: answers(decision),
    thenLook: never,
    between: "chip-off",
    presses: [{ sent: sent({ mode: "quality" }), legacyDrawsModeRow: false }],
  },
];

/** The settings object has these four keys and no others: no `route`, not even an undefined one. */
const KEYS = ["fps", "mode", "quality", "resolution"];

type Side = "legacy" | "view";
/** How the new view is drawn: without the choice row (`fastChoice` false), with it (the default), or with it after Fast was picked and Quality picked again: nothing may stay of the detour. */
type ViewState = "no row" | "row" | "row after Fast, then Quality again";
const VIEW_STATES: ViewState[] = ["no row", "row", "row after Fast, then Quality again"];
type User = ReturnType<typeof userEvent.setup>;
interface Played {
  sent: ExportSettings;
  calls: number;
  modeRowOnScreen: boolean | null;
  modeRowDrawn: boolean;
}

const settleAll = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));
const noop = (): void => undefined;

/** The three picks as each side offers them: the 0.28.0 dialog has all three selects in its settings block (option values), the new view has Frame rate and Quality behind the door (option names). */
async function pick(user: User, side: Side, picks: Picks): Promise<void> {
  const choose = async (select: string, value: string, name: string): Promise<void> => {
    const box = screen.getByRole("combobox", { name: select });
    if (side === "legacy") await user.selectOptions(box, value);
    else await user.selectOptions(box, within(box).getByRole("option", { name }));
  };
  if (side === "view" && (picks.rate !== undefined || picks.quality !== undefined))
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
  if (picks.size !== undefined) await choose("resolution", picks.size, picks.size);
  if (picks.rate !== undefined) await choose("frame rate", String(picks.rate), `${picks.rate} fps`);
  if (picks.quality !== undefined) {
    const names = { high: "High", medium: "Medium", low: "Low" };
    await choose("quality", picks.quality, names[picks.quality]);
  }
}

/** What happens between the app's answer and the press of Export: on both sides the answer in hand is then stale, and the new question is out. The chip switch is behind the door in the new view and in the settings block of 0.28.0. */
async function happen(user: User, side: Side, what: Between): Promise<void> {
  if (what === "history") {
    await act(async () => {
      useExportJob.setState({ calibrations: [EARLIER_EXPORT] });
    });
    return;
  }
  if (side === "view") await user.click(screen.getByRole("button", { name: "Advanced settings" }));
  await user.click(await screen.findByRole("radio", { name: "Off" }));
}

/** One side of a scenario from a clean PC and clean stores: shown, settled, picked, then Export pressed once (twice in the gap scenario). `state` is how the new view is drawn (ignored for the 0.28.0 dialog). */
async function play(side: Side, scenario: Scenario, state: ViewState = "row"): Promise<Played[]> {
  cleanup();
  localStorage.clear();
  __resetChipTests();
  useEditor.setState({ timeline: null });
  useExportJob.getState().reset();
  useExportJob.getState().setEngine("auto");
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  let release: () => void = noop;
  const gate = scenario.chipGate
    ? new Promise<Resources>((resolve) => {
        release = () => resolve(resourcesWith(scenario.adapters));
      })
    : undefined;
  pcWith(scenario.adapters, gate);
  let asked = 0;
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(() =>
    asked++ > 0 && scenario.thenLook ? scenario.thenLook() : scenario.look(),
  );

  const onStart = vi.fn<(settings: ExportSettings) => void>();
  render(
    side === "legacy" ? (
      <ExportDialog open onCancel={noop} onStart={onStart} workload={scenario.workload} />
    ) : (
      <ExportSettingsView
        workload={scenario.workload}
        onCancel={noop}
        onStart={onStart}
        fastChoice={state !== "no row"}
      />
    ),
  );
  await settleAll();
  if (side === "legacy" && scenario.presses[0].legacyDrawsModeRow)
    await screen.findByRole("radiogroup", { name: "export mode" });
  const user = userEvent.setup();
  if (side === "view" && state === "row after Fast, then Quality again") {
    await user.click(screen.getByRole("radio", { name: "Fast" }));
    await user.click(screen.getByRole("radio", { name: "Quality" }));
    await settleAll();
  }
  if (scenario.picks) {
    await pick(user, side, scenario.picks);
    await settleAll();
  }
  if (scenario.between) {
    await happen(user, side, scenario.between);
    await settleAll();
  }

  const played: Played[] = [];
  const press = async (): Promise<void> => {
    const modeRowDrawn = screen.queryByRole("radiogroup", { name: "export mode" }) !== null;
    useExportJob.setState({ modeRowOnScreen: null });
    await user.click(screen.getByRole("button", { name: "Export" }));
    const calls = onStart.mock.calls;
    played.push({
      sent: calls[calls.length - 1][0],
      calls: calls.length,
      modeRowOnScreen: useExportJob.getState().modeRowOnScreen,
      modeRowDrawn,
    });
  };
  await press();
  if (scenario.chipGate) {
    release();
    await settleAll();
    await press();
  }
  return played;
}

beforeEach(() => {
  for (const flag of FLAGS) __setExportFlag(flag, true);
});

describe("Quality sends what the 0.28.0 dialog sends", () => {
  // The 0.28.0 side of a scenario does not depend on how the new view is drawn: it is played once and compared with each state.
  const oracle = new Map<Scenario, Promise<Played[]>>();
  const legacyOf = (scenario: Scenario): Promise<Played[]> => {
    if (!oracle.has(scenario)) oracle.set(scenario, play("legacy", scenario));
    return oracle.get(scenario)!;
  };

  describe.each(VIEW_STATES)("the new view, %s", (state) => {
    it.each(SCENARIOS)("$name", async (scenario) => {
      const legacy = await legacyOf(scenario);
      const view = await play("view", scenario, state);

      // each Export press hands over exactly once; the written-out values hold for the oracle (so two empty runs cannot agree) and the new view equals it, strictly
      expect(legacy.map((played) => played.calls)).toEqual(scenario.presses.map((_, i) => i + 1));
      expect(view.map((played) => played.calls)).toEqual(scenario.presses.map((_, i) => i + 1));
      expect(legacy.map((played) => played.sent)).toStrictEqual(
        scenario.presses.map((press) => press.sent),
      );
      expect(view.map((played) => played.sent)).toStrictEqual(legacy.map((played) => played.sent));
      for (const played of view) expect(Object.keys(played.sent).sort()).toEqual(KEYS);

      scenario.presses.forEach((press, i) => {
        // the one intended difference: 0.28.0 says it showed its Mode row where it drew it; the new view never draws it and says so
        expect(legacy[i].modeRowDrawn).toBe(press.legacyDrawsModeRow);
        expect(legacy[i].modeRowOnScreen).toBe(press.legacyDrawsModeRow);
        expect(view[i].modeRowDrawn).toBe(false);
        expect(view[i].modeRowOnScreen).toBe(false);
        // and everywhere else the two agree
        if (!press.legacyDrawsModeRow)
          expect(view[i].modeRowOnScreen).toBe(legacy[i].modeRowOnScreen);
      });
    });
  });
});

describe("the one intended difference: the old Mode row", () => {
  const drawn = SCENARIOS.filter((scenario) =>
    scenario.presses.some((press) => press.legacyDrawsModeRow),
  );

  it("is part of the scenarios that matter (a table that lost them would test nothing)", () => {
    expect(drawn.length).toBeGreaterThanOrEqual(2);
  });

  describe.each(VIEW_STATES)("the new view, %s", (state) => {
    it.each(drawn)(
      "is drawn by 0.28.0 and never by the new view, which still sends what 0.28.0 sends: $name",
      async (scenario) => {
        const legacy = await play("legacy", scenario);
        expect(screen.getByRole("radio", { name: "Fast" })).toBeChecked();
        expect(screen.getByRole("radio", { name: "Full quality" })).not.toBeChecked();
        const view = await play("view", scenario, state);
        expect(screen.queryByRole("radiogroup", { name: "export mode", hidden: true })).toBeNull();
        expect(screen.queryByRole("radio", { name: "Full quality", hidden: true })).toBeNull();
        if (state === "no row") {
          expect(screen.queryByRole("radio", { name: "Fast", hidden: true })).toBeNull();
        } else {
          // the radio named Fast is the choice row's: it is the person's pick and it is not the old Mode row's, which started on Fast
          const group = screen.getByRole("radiogroup", { name: "export choice" });
          expect(within(group).getByRole("radio", { name: "Quality" })).toBeChecked();
          expect(within(group).getByRole("radio", { name: "Fast" })).not.toBeChecked();
        }
        expect(legacy[0].modeRowOnScreen).toBe(true);
        expect(view[0].modeRowOnScreen).toBe(false);
        expect(view[0].sent).toStrictEqual(legacy[0].sent);
        expect(view[0].sent.mode).toBeNull();
      },
    );
  });
});
