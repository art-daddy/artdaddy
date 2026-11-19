// The settings view without the choice row (`fastChoice` false): the Quality-only screen as it was before Fast was wired, except the D8 sentence (the line behind the door for the lighter setting says
// "light compression"). It must stay as it was, so it stays tested on its own:
//  - no group "export choice", no radio, no line under the door, whatever the project, the door or the picks;
//  - the Resolution row and the door are as before;
//  - the object handed to `onStart` has no route key whatever is picked, and equals, key for key, what the 0.28.0 dialog hands over for the same picks, the same PC and the same answer of the app.
// Mutants this file must kill: the row drawn although fastChoice is false; the line under the door drawn without the row; a route key on the object; the choice not Quality without the row.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { processorName, resolveExportResources, runCapabilityProbe } from "../platform/host";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { harness } from "../test/chipHarness";
import { __resetChipTests } from "../timeline/chipTest";
import { __resetExportAsk } from "../timeline/exportAsk";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { emptyTimeline } from "../timeline/model";
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

beforeEach(() => {
  localStorage.clear();
  __resetChipTests();
  __setExportFlag("quick_export", true);
  useExportJob.getState().reset();
  useExportJob.getState().setEngine("auto");
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  useEditor.setState({ timeline: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(async () => decision());
  const scripted = harness([]);
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
    adapters: [],
  });
  vi.mocked(processorName).mockReset();
  vi.mocked(processorName).mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  __resetExportAsk();
  __resetExportFlags();
  useEditor.setState({ timeline: null });
});

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
const setCanvas = (width: number, height: number, fps: number) =>
  useEditor.setState({ timeline: { ...emptyTimeline(), canvas: { width, height, fps } } });
const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));
const noop = (): void => undefined;
const region = () => screen.getByTestId("export-advanced");
const door = () => screen.getByRole("button", { name: "Advanced settings" });
const change = (name: "resolution" | "frame rate" | "quality", value: string) =>
  fireEvent.change(screen.getByRole("combobox", { name, hidden: true }), { target: { value } });

interface Shape {
  name: string;
  width: number;
  height: number;
  fps: number;
  /** The values of the Resolution list's entries; empty where the row is not drawn. */
  sizes: string[];
  rates: string[];
}
const SHAPES: Shape[] = [
  {
    name: "3840 x 2160 at 60",
    width: 3840,
    height: 2160,
    fps: 60,
    sizes: ["source", "1440p", "1080p", "720p", "480p"],
    rates: ["", "50", "30", "25", "24"],
  },
  {
    name: "1080 x 1920 at 30",
    width: 1080,
    height: 1920,
    fps: 30,
    sizes: ["source", "720p", "480p"],
    rates: ["", "25", "24"],
  },
  {
    name: "854 x 480 at 30",
    width: 854,
    height: 480,
    fps: 30,
    sizes: [],
    rates: ["", "25", "24"],
  },
  {
    name: "1920 x 1080 at 72",
    width: 1920,
    height: 1080,
    fps: 72,
    sizes: ["source", "720p", "480p"],
    rates: ["", "60", "50", "30", "25", "24"],
  },
];

describe("without the choice row (fastChoice false): what is not drawn", () => {
  it.each(SHAPES)(
    "$name: no group, no radio, no line under the door, door closed or open",
    async (shape) => {
      setCanvas(shape.width, shape.height, shape.fps);
      render(
        <ExportSettingsView
          workload={workloadOf(shape.width, shape.height, shape.fps)}
          onCancel={noop}
          onStart={noop}
          fastChoice={false}
        />,
      );
      await settle();
      const expectNone = () => {
        expect(
          screen.queryByRole("radiogroup", { name: "export choice", hidden: true }),
        ).toBeNull();
        expect(screen.queryAllByRole("radio", { hidden: true })).toHaveLength(0);
        expect(screen.queryByTestId("export-choice")).toBeNull();
        // the region holds the rows and nothing written under the door
        expect(region().querySelector("p")).toBeNull();
        expect(document.body.textContent).not.toMatch(
          /\bFast\b|quality\.$|frame rate, |One size smaller/,
        );
      };
      expectNone();
      fireEvent.click(door());
      await settle();
      expectNone();
      for (const size of ["720p", "480p"]) {
        if (shape.sizes.length > 0)
          fireEvent.change(screen.getByRole("combobox", { name: "resolution" }), {
            target: { value: size },
          });
        expectNone();
      }
    },
  );

  it("no project: the same", async () => {
    render(
      <ExportSettingsView workload={null} onCancel={noop} onStart={noop} fastChoice={false} />,
    );
    await settle();
    fireEvent.click(door());
    expect(screen.queryAllByRole("radio", { hidden: true })).toHaveLength(0);
    expect(region().querySelector("p")).toBeNull();
  });

  it("the Resolution row and the door are as before: the row where there is a smaller size, the door closed and named, the region behind it", async () => {
    setCanvas(3840, 2160, 60);
    render(
      <ExportSettingsView
        workload={workloadOf(3840, 2160, 60)}
        onCancel={noop}
        onStart={noop}
        fastChoice={false}
      />,
    );
    await settle();
    const box = screen.getByRole("combobox", { name: "resolution" });
    expect(Array.from((box as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
      "Same as project (3840 x 2160)",
      "1440p",
      "1080p",
      "720p",
      "480p",
    ]);
    expect(box).toHaveValue("source");
    expect(door()).toHaveAttribute("aria-expanded", "false");
    expect(region()).toHaveAttribute("hidden");
    // Quality is Medium and the rate is the project's own
    expect(screen.getByRole("combobox", { name: "quality", hidden: true })).toHaveValue("medium");
    expect(screen.getByRole("combobox", { name: "frame rate", hidden: true })).toHaveValue("");
  });
});

interface Picks {
  size?: string;
  rate?: string;
  quality?: string;
}

describe("without the choice row: what Export hands over", () => {
  const every = (shape: Shape): Picks[] => {
    const sizes: (string | undefined)[] = [undefined, ...shape.sizes];
    const rates: (string | undefined)[] = [undefined, ...shape.rates];
    const qualities: (string | undefined)[] = [undefined, "high", "medium", "low"];
    return sizes.flatMap((size) =>
      rates.flatMap((rate) => qualities.map((quality) => ({ size, rate, quality }))),
    );
  };

  it.each(SHAPES)(
    "$name: whatever is picked, the object is the 0.28.0 one: four keys and no route",
    (shape) => {
      for (const picks of every(shape)) {
        cleanup();
        setCanvas(shape.width, shape.height, shape.fps);
        const onStart = vi.fn<(settings: ExportSettings) => void>();
        render(
          <ExportSettingsView
            workload={workloadOf(shape.width, shape.height, shape.fps)}
            onCancel={noop}
            onStart={onStart}
            fastChoice={false}
          />,
        );
        if (picks.size !== undefined) change("resolution", picks.size);
        if (picks.rate !== undefined) change("frame rate", picks.rate);
        if (picks.quality !== undefined) change("quality", picks.quality);
        fireEvent.click(screen.getByRole("button", { name: "Export" }));
        expect(onStart).toHaveBeenCalledTimes(1);
        const sent = onStart.mock.calls[0][0];
        expect(Object.keys(sent).sort(), JSON.stringify(picks)).toEqual([
          "fps",
          "mode",
          "quality",
          "resolution",
        ]);
        expect(sent).not.toHaveProperty("route");
        // what was picked is what is sent, and what was not is the project's own at Medium
        expect(sent.resolution).toBe(picks.size ?? "source");
        expect(sent.fps).toBe(
          picks.rate === undefined || picks.rate === "" ? null : Number(picks.rate),
        );
        expect(sent.quality).toBe(picks.quality ?? "medium");
      }
    },
  );
});

describe("without the choice row: the same object as the 0.28.0 dialog hands over", () => {
  const LOOKS: [string, () => Promise<ExportEncoderDecision>][] = [
    ["the app answers with no row", async () => decision()],
    ["the app never answers", () => new Promise<ExportEncoderDecision>(() => undefined)],
    [
      "the app wants its old Mode row",
      async () =>
        decision({
          showRow: true,
          defaultMode: "fast",
          reason: "over_minute",
          fullSeconds: 720,
          fastSeconds: 240,
        }),
    ],
    ["the app will use its lighter setting", async () => decision({ faster: true })],
  ];
  const PICKS: Picks[] = [
    {},
    { size: "720p" },
    { rate: "24" },
    { quality: "high" },
    { quality: "low" },
    { size: "480p", rate: "25", quality: "low" },
  ];

  async function sentBy(
    side: "legacy" | "view",
    shape: Shape,
    picks: Picks,
  ): Promise<ExportSettings> {
    cleanup();
    localStorage.clear();
    __resetChipTests();
    useExportJob.getState().reset();
    useExportJob.getState().setEngine("auto");
    useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
    setCanvas(shape.width, shape.height, shape.fps);
    const onStart = vi.fn<(settings: ExportSettings) => void>();
    const workload = workloadOf(shape.width, shape.height, shape.fps);
    render(
      side === "legacy" ? (
        <ExportDialog open onCancel={noop} onStart={onStart} workload={workload} />
      ) : (
        <ExportSettingsView
          workload={workload}
          onCancel={noop}
          onStart={onStart}
          fastChoice={false}
        />
      ),
    );
    await settle();
    if (picks.size !== undefined) change("resolution", picks.size);
    if (picks.rate !== undefined) change("frame rate", picks.rate);
    if (picks.quality !== undefined) change("quality", picks.quality);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    return onStart.mock.calls[0][0];
  }

  describe.each(LOOKS)("%s", (_name, look) => {
    it.each(SHAPES.slice(0, 3))("$name", async (shape) => {
      vi.mocked(decideExportEncoder).mockImplementation(look);
      for (const picks of PICKS) {
        const wanted = {
          size: picks.size !== undefined && shape.sizes.includes(picks.size),
          rate: picks.rate !== undefined && shape.rates.includes(picks.rate),
        };
        // a pick the project's lists do not offer is not a pick a person can make
        const usable: Picks = {
          ...picks,
          size: wanted.size ? picks.size : undefined,
          rate: wanted.rate ? picks.rate : undefined,
        };
        const legacy = await sentBy("legacy", shape, usable);
        const view = await sentBy("view", shape, usable);
        expect(view, JSON.stringify(usable)).toStrictEqual(legacy);
        expect(Object.keys(view).sort()).toEqual(["fps", "mode", "quality", "resolution"]);
      }
    });
  });
});
