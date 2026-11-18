// The line behind the door of the settings view, as an OUTCOME against what Export hands over: for every combination of the choice and the picks (every entry of the Resolution list, of the Frame rate list and the three
// qualities) on six project shapes, the door is opened, the line is read, Export is pressed, and the line must be TRUE of the object `onStart` received. The truth is written here from the owner's words, not from the
// code under test: "Project size and frame rate" iff the size is the project's own and no rate was set; "One size smaller" iff the size sent is the largest of 2160p, 1080p, 720p and 480p that lies strictly below the
// project's short side; "up to 30 frames a second" iff the project runs above 30 and what is sent (the project's own rate, cut to a whole number, where none is set) is at most 30; the quality word is the sent quality's;
// nothing about the encoder, ever. The owner's five examples are checked word for word.
// Mutants this file must kill: a line built from the choice's own values instead of the shown ones; a clause that is always, or never, written; the quality of the bundle instead of the shown one; the project's rate not
// looked at; a line written for no project; a line drawn without the row (fastChoice false); a word about the encoder.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

beforeEach(() => {
  localStorage.clear();
  __resetChipTests();
  __setExportFlag("quick_export", true);
  useExportJob.getState().reset();
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

interface Shape {
  name: string;
  width: number;
  height: number;
  fps: number;
  /** The values of the Resolution list's entries (the first is the project's own size); empty where the row is not drawn. */
  sizes: string[];
  /** The values of the Frame rate list's entries as Quality shows them (the first, "", is the project's own rate); empty where the row is not drawn. */
  rates: string[];
  /** Fast's own rate where it is not in that list: the entry Fast's list adds. */
  fastRate?: string;
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
    name: "1920 x 1080 at 24",
    width: 1920,
    height: 1080,
    fps: 24,
    sizes: ["source", "720p", "480p"],
    rates: [],
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
    fastRate: "18",
  },
  {
    name: "1366 x 768 at 30",
    width: 1366,
    height: 768,
    fps: 30,
    sizes: ["source", "720p", "480p"],
    rates: ["", "25", "24"],
  },
];

type Choice = "quality" | "fast";
interface Picks {
  size?: string;
  rate?: string;
  quality?: string;
}

const setCanvas = (width: number, height: number, fps: number) =>
  useEditor.setState({ timeline: { ...emptyTimeline(), canvas: { width, height, fps } } });
const workloadOf = (shape: Shape): RenderWorkload => ({
  width: shape.width,
  height: shape.height,
  fps: shape.fps,
  durationSeconds: 120,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
});
const region = () => screen.getByTestId("export-advanced");
/** The one line behind the door that says what the export will be: the first paragraph of the region. */
const lineBehindDoor = (): string | null => region().querySelector("p")?.textContent ?? null;
const change = (name: "resolution" | "frame rate" | "quality", value: string) =>
  fireEvent.change(screen.getByRole("combobox", { name, hidden: true }), { target: { value } });

interface Played {
  line: string | null;
  paragraphs: number;
  sent: ExportSettings;
}
/** One opening of the view: the choice, the door opened, the picks, the line read, Export pressed once. */
function play(shape: Shape, choice: Choice, picks: Picks = {}): Played {
  setCanvas(shape.width, shape.height, shape.fps);
  const onStart = vi.fn<(settings: ExportSettings) => void>();
  const view = render(
    <ExportSettingsView workload={workloadOf(shape)} onCancel={vi.fn()} onStart={onStart} />,
  );
  if (choice === "fast") fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
  fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
  if (picks.size !== undefined) change("resolution", picks.size);
  if (picks.rate !== undefined) change("frame rate", picks.rate);
  if (picks.quality !== undefined) change("quality", picks.quality);
  const line = lineBehindDoor();
  const paragraphs = region().querySelectorAll("p").length;
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(onStart).toHaveBeenCalledTimes(1);
  const sent = onStart.mock.calls[0][0];
  view.unmount();
  return { line, paragraphs, sent };
}

// ---- The truth of the line, written from the owner's words ----
/** The sizes "one size smaller" can name, largest first, by their short side. */
const RUNGS: { name: string; short: number }[] = [
  { name: "2160p", short: 2160 },
  { name: "1080p", short: 1080 },
  { name: "720p", short: 720 },
  { name: "480p", short: 480 },
];
const QUALITY_WORD = { high: "High", medium: "Medium", low: "Low" } as const;

function says(shape: Shape, sent: ExportSettings) {
  const below = RUNGS.filter((rung) => rung.short < Math.min(shape.width, shape.height))[0];
  const rate = sent.fps ?? Math.floor(shape.fps);
  return {
    projectSizeAndRate: sent.resolution === "source" && sent.fps === null,
    oneSizeSmaller:
      sent.resolution !== "source" && below !== undefined && sent.resolution === below.name,
    upTo30: shape.fps > 30 && rate <= 30,
    quality: QUALITY_WORD[sent.quality],
  };
}
/** The whole line as the owner writes it: the clauses that are true, joined by commas, the first letter a capital, a full stop. */
function truthLine(shape: Shape, sent: ExportSettings): string {
  const truth = says(shape, sent);
  const clauses = [
    ...(truth.projectSizeAndRate ? ["Project size and frame rate"] : []),
    ...(truth.oneSizeSmaller ? ["One size smaller"] : []),
    ...(truth.upTo30 ? ["up to 30 frames a second"] : []),
    `${truth.quality} quality`,
  ];
  const text = clauses.join(", ");
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

function expectTrue(shape: Shape, played: Played): void {
  const { line, sent } = played;
  expect(line, "a line is drawn behind the door").not.toBeNull();
  const truth = says(shape, sent);
  // each clause is there exactly where it is true of what was received
  expect(line!.includes("Project size and frame rate")).toBe(truth.projectSizeAndRate);
  expect(line!.includes("One size smaller")).toBe(truth.oneSizeSmaller);
  expect(/up to 30 frames a second/i.test(line!)).toBe(truth.upTo30);
  expect(line!.includes(`${truth.quality} quality`)).toBe(true);
  // the whole line, as written
  expect(line).toBe(truthLine(shape, sent));
  // never a word about the encoder, the speed or the old names
  expect(line).not.toMatch(/compression|chip|graphics|processor|faster|quick|full/i);
  // one line only: the light-compression sentence is not drawn here (the app's look did not say it)
  expect(played.paragraphs).toBe(1);
}

/** Every entry of a lever, and "untouched" (undefined). */
const entries = (values: string[]): (string | undefined)[] => [undefined, ...values];

describe("the line is true of what Export hands over: every pick of every lever, for both choices", () => {
  describe.each(SHAPES)("$name", (shape) => {
    describe.each<Choice>(["quality", "fast"])("%s", (choice) => {
      const rates = shape.fastRate ? [...shape.rates, shape.fastRate] : shape.rates;

      // the Resolution list's entries against the Frame rate list's entries (untouched included)
      it("over every Resolution entry and every Frame rate entry", () => {
        for (const size of entries(shape.sizes))
          for (const rate of entries(rates)) {
            const played = play(shape, choice, { size, rate });
            try {
              expectTrue(shape, played);
            } catch (error) {
              throw new Error(
                `${choice} on ${shape.name} with size ${size} and rate ${rate} sent ${JSON.stringify(played.sent)} and said "${played.line}": ${String(error)}`,
              );
            }
          }
      });

      // each of the three qualities (and none) with every Resolution entry, then with every Frame rate entry
      it("over every quality, with every Resolution entry and with every Frame rate entry", () => {
        for (const quality of entries(["high", "medium", "low"])) {
          for (const size of entries(shape.sizes))
            expectTrue(shape, play(shape, choice, { size, quality }));
          for (const rate of entries(rates))
            expectTrue(shape, play(shape, choice, { rate, quality }));
        }
      });

      it("over the three levers together: the largest and the smallest of each", () => {
        const first = (list: string[]) => (list.length > 1 ? list[1] : undefined);
        const last = (list: string[]) => (list.length > 1 ? list[list.length - 1] : undefined);
        for (const picks of [
          { size: first(shape.sizes), rate: first(rates), quality: "high" },
          { size: last(shape.sizes), rate: last(rates), quality: "low" },
          { size: shape.sizes[0], rate: rates[0], quality: "low" },
        ])
          expectTrue(shape, play(shape, choice, picks));
      });
    });
  });
});

describe("the owner's examples, word for word", () => {
  it("4K at 60, Fast: One size smaller, up to 30 frames a second, Medium quality.", () => {
    expect(play(SHAPES[0], "fast").line).toBe(
      "One size smaller, up to 30 frames a second, Medium quality.",
    );
  });
  it("1080 x 1920 at 30, Fast: One size smaller, Medium quality.", () => {
    expect(play(SHAPES[1], "fast").line).toBe("One size smaller, Medium quality.");
  });
  it("Quality at the start: Project size and frame rate, Medium quality.", () => {
    for (const shape of SHAPES)
      expect(play(shape, "quality").line, shape.name).toBe(
        "Project size and frame rate, Medium quality.",
      );
  });
  it("4K at 60, Fast, then Resolution Same as project: Up to 30 frames a second, Medium quality.", () => {
    expect(play(SHAPES[0], "fast", { size: "source" }).line).toBe(
      "Up to 30 frames a second, Medium quality.",
    );
  });
  it("Quality High: Project size and frame rate, High quality.", () => {
    expect(play(SHAPES[0], "quality", { quality: "high" }).line).toBe(
      "Project size and frame rate, High quality.",
    );
  });
  it("Fast with its rate set back to the project's own: the cap clause goes (the shown values, not the choice's, are described)", () => {
    expect(play(SHAPES[0], "fast", { rate: "" }).line).toBe("One size smaller, Medium quality.");
    expect(play(SHAPES[0], "fast", { rate: "" }).sent).toMatchObject({
      resolution: "1080p",
      fps: null,
    });
  });
  it("Fast on 72 fps: the line says 'up to 30 frames a second', not the 18 Fast sends (the project is above 30 and 18 is at most 30)", () => {
    expect(play(SHAPES[4], "fast").line).toBe(
      "One size smaller, up to 30 frames a second, Medium quality.",
    );
  });
});

describe("where the line is and is not", () => {
  it("is in the region behind the door: not visible while the door is closed, visible once it is open", () => {
    setCanvas(3840, 2160, 60);
    render(
      <ExportSettingsView workload={workloadOf(SHAPES[0])} onCancel={vi.fn()} onStart={vi.fn()} />,
    );
    expect(lineBehindDoor()).toBe("Project size and frame rate, Medium quality.");
    expect(screen.getByText("Project size and frame rate, Medium quality.")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect(screen.getByText("Project size and frame rate, Medium quality.")).toBeVisible();
  });

  it("follows the choice and the picks live: it changes with each of them and comes back with them", () => {
    setCanvas(3840, 2160, 60);
    render(
      <ExportSettingsView workload={workloadOf(SHAPES[0])} onCancel={vi.fn()} onStart={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    const seen = [lineBehindDoor()];
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    seen.push(lineBehindDoor());
    change("resolution", "source");
    seen.push(lineBehindDoor());
    change("quality", "low");
    seen.push(lineBehindDoor());
    fireEvent.click(screen.getByRole("radio", { name: "Quality" }));
    seen.push(lineBehindDoor());
    expect(seen).toEqual([
      "Project size and frame rate, Medium quality.",
      "One size smaller, up to 30 frames a second, Medium quality.",
      "Up to 30 frames a second, Medium quality.",
      "Up to 30 frames a second, Low quality.",
      "Project size and frame rate, Medium quality.",
    ]);
  });

  it("is not drawn for no project (nothing to describe), with either choice", () => {
    render(<ExportSettingsView workload={null} onCancel={vi.fn()} onStart={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect(region().querySelector("p")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    expect(region().querySelector("p")).toBeNull();
  });

  it("is not drawn without the choice row (fastChoice false), whatever is picked", () => {
    setCanvas(3840, 2160, 60);
    render(
      <ExportSettingsView
        workload={workloadOf(SHAPES[0])}
        onCancel={vi.fn()}
        onStart={vi.fn()}
        fastChoice={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    change("resolution", "720p");
    change("quality", "high");
    expect(region().querySelector("p")).toBeNull();
  });
});
