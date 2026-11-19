// T3 and T4 of the D2 UI spec (section 5): the words of the settings view, as a whole-screen WHITELIST and not a search, and the words that must never be drawn. Both run in the two states of the view:
// without the choice row (`fastChoice` false: the Quality-only screen, which must stay as it was) and with it (the default).
// T3: with the door closed the visible text of the view is exactly (the words "Quality" and "Fast" of the choice row where it is drawn,) Resolution (where the list has two entries), the select's own text, "Advanced
//     settings", Cancel and Export; with the door open it gains only the line under the door (the row's state, where a project can be read), the light-compression line (where the app's look says it will use that
//     setting), Frame rate and its select (where drawn), Quality and Medium, and the chip row where a chip was found. The expected lists are written out below, by hand, for each project.
// T4: nothing of the "never drawn" list is in the DOM at all, hidden or not, closed or open, on Quality and on Fast: the Mode row, the estimate line, "Never upscales", the 0.28.0 quality hints, any figure of minutes or
//     MB, any speed figure, any tooltip, the question, and EVERY retired name. With the row the radiogroup "export choice" with exactly the radios "Quality" and "Fast" is allowed; without it, neither exists.
// Mutants this file must kill: an extra sentence in the normal view; the 0.28.0 Mode row, estimate or hints drawn; a Resolution row for a project with no smaller size; the light-compression line drawn where the look does
// not want it; a figure or a tooltip on Fast; the row drawn with fastChoice false.
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import { retiredIn } from "../test/retiredNames";
import { __resetChipTests } from "../timeline/chipTest";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import type { RenderWorkload } from "../timeline/renderPlan";
import ChoiceRow from "./ChoiceRow";
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
/** A chip has proven itself and the export is long: the app wants the old Mode row, on Fast (with its hint, its amber note, its "would take" line). */
const wantsRow = (): ExportEncoderDecision =>
  decision({
    showRow: true,
    defaultMode: "fast",
    reason: "over_minute",
    fullSeconds: 720,
    fastSeconds: 240,
    facts: { encoder: "x264", chip: "amd", reason: "none", tests: [] },
  });
/** A chip has passed for the picture's size, whatever the length: the app chooses it for the person (`chip_default`), the Mode row is on offer and starts on Fast. */
const chipChosen = (): ExportEncoderDecision =>
  decision({
    mode: "fast",
    chip: "amd",
    showRow: true,
    defaultMode: "fast",
    reason: "chip_default",
    fullSeconds: 40,
    fastSeconds: 15,
    facts: { encoder: "amd", chip: "amd", reason: "chip_default", tests: [] },
  });

const sized = (width: number, height: number, fps: number): RenderWorkload => ({
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
const DEFAULT = sized(1080, 1920, 30);

const LIGHT_LINE =
  "To save time, ArtDaddy will use light compression; the picture may be slightly softer.";
const CHIP_PASSED_NOTE =
  "Auto: used on this PC. The file is usually larger and the picture can differ slightly.";

const settleAll = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));
const noop = (): void => undefined;

/** The view, on a PC with these chips, with the app's answer to the encoder look; settled, with the door closed. `row` false is the Quality-only screen (`fastChoice` false). */
async function show(
  workload: RenderWorkload | null,
  look: ExportEncoderDecision = decision(),
  adapters: GraphicsAdapter[] = [],
  row = true,
) {
  localStorage.clear();
  __resetChipTests();
  useEditor.setState({ timeline: null });
  useExportJob.getState().reset();
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  pcWith(adapters);
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(async () => look);
  const view = render(
    <ExportSettingsView workload={workload} onCancel={noop} onStart={noop} fastChoice={row} />,
  );
  await settleAll();
  return { ...view, user: userEvent.setup() };
}

/** The two states of the view: the Quality-only screen (no row) and the default one (the row first, a line behind the door). */
const STATES = [
  { state: "without the choice row (fastChoice false)", row: false },
  { state: "with the choice row (the default)", row: true },
] as const;
const ROW_WORDS = ["Quality", "Fast"];
/** The line under the door at the start of a Quality export of a project that can be read. */
const START_LINE = "Project size and frame rate, Medium quality.";
/** The words of the Quality-only screen with the door closed, as the state draws them: the choice row's two words come first. */
const closedOf = (words: string[], row: boolean): string[] =>
  row ? [...ROW_WORDS, ...words] : words;
/** The words with the door open: the line under the door follows the door where the row is drawn and a project can be read, then `extra` (the light-compression line), then the rows. */
function openOf(
  words: string[],
  row: boolean,
  hasProject: boolean,
  extra: string[] = [],
): string[] {
  const at = words.indexOf("Advanced settings") + 1;
  const behind = row && hasProject ? [START_LINE] : [];
  return closedOf([...words.slice(0, at), ...behind, ...extra, ...words.slice(at)], row);
}

const door = () => screen.getByRole("button", { name: "Advanced settings" });

/** What a person can read in `root`, in order: the text of everything that is drawn (not `hidden`, not display none), a select as the option it shows, and nothing without a letter or a digit in it (a drawn
 *  triangle on the door is not a word). */
function visibleWords(root: Element): string[] {
  const words: string[] = [];
  const read = (element: Element): void => {
    if (element.hasAttribute("hidden") || window.getComputedStyle(element).display === "none")
      return;
    if (element.tagName === "SELECT") {
      const select = element as HTMLSelectElement;
      const shown = select.options[select.selectedIndex];
      if (shown) words.push((shown.textContent ?? "").trim());
      return;
    }
    let run = "";
    const flush = (): void => {
      const text = run.replace(/\s+/g, " ").trim();
      if (/[\p{L}\p{N}]/u.test(text)) words.push(text);
      run = "";
    };
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 3) run += child.textContent ?? "";
      else if (child.nodeType === 1) {
        flush();
        read(child as Element);
      }
    }
    flush();
  };
  read(root);
  return words;
}

/** The options of a select by its accessible name, hidden or not. Null where the select is not in the DOM at all. */
function optionsOf(name: string): string[] | null {
  const select = screen.queryByRole("combobox", { name, hidden: true });
  if (!select) return null;
  return within(select)
    .getAllByRole("option", { hidden: true })
    .map((option) => option.textContent ?? "");
}

beforeEach(() => {
  for (const flag of FLAGS) __setExportFlag(flag, true);
});

interface Project {
  name: string;
  workload: RenderWorkload | null;
  /** Visible words with the door closed. */
  closed: string[];
  /** Visible words with the door open. */
  open: string[];
  /** The options of each select, by accessible name; null: the select is not drawn at all. */
  resolution: string[] | null;
  rate: string[] | null;
}

const PROJECTS: Project[] = [
  {
    name: "the default project, 1080 x 1920 at 30",
    workload: DEFAULT,
    closed: [
      "Resolution",
      "Same as project (1080 x 1920)",
      "Advanced settings",
      "Cancel",
      "Export",
    ],
    open: [
      "Resolution",
      "Same as project (1080 x 1920)",
      "Advanced settings",
      "Frame rate",
      "Same as project (30 fps)",
      "Quality",
      "Medium",
      "Cancel",
      "Export",
    ],
    resolution: ["Same as project (1080 x 1920)", "720p", "480p"],
    rate: ["Same as project (30 fps)", "25 fps", "24 fps"],
  },
  {
    name: "a 4K project at 60",
    workload: sized(3840, 2160, 60),
    closed: [
      "Resolution",
      "Same as project (3840 x 2160)",
      "Advanced settings",
      "Cancel",
      "Export",
    ],
    open: [
      "Resolution",
      "Same as project (3840 x 2160)",
      "Advanced settings",
      "Frame rate",
      "Same as project (60 fps)",
      "Quality",
      "Medium",
      "Cancel",
      "Export",
    ],
    resolution: ["Same as project (3840 x 2160)", "1440p", "1080p", "720p", "480p"],
    rate: ["Same as project (60 fps)", "50 fps", "30 fps", "25 fps", "24 fps"],
  },
  {
    name: "a 480p project at 30 (no Resolution row)",
    workload: sized(854, 480, 30),
    closed: ["Advanced settings", "Cancel", "Export"],
    open: [
      "Advanced settings",
      "Frame rate",
      "Same as project (30 fps)",
      "Quality",
      "Medium",
      "Cancel",
      "Export",
    ],
    resolution: null,
    rate: ["Same as project (30 fps)", "25 fps", "24 fps"],
  },
  {
    name: "a 1080p project at 24 (no Frame rate row)",
    workload: sized(1920, 1080, 24),
    closed: [
      "Resolution",
      "Same as project (1920 x 1080)",
      "Advanced settings",
      "Cancel",
      "Export",
    ],
    open: [
      "Resolution",
      "Same as project (1920 x 1080)",
      "Advanced settings",
      "Quality",
      "Medium",
      "Cancel",
      "Export",
    ],
    resolution: ["Same as project (1920 x 1080)", "720p", "480p"],
    rate: null,
  },
  {
    name: "no project",
    workload: null,
    closed: ["Advanced settings", "Cancel", "Export"],
    open: ["Advanced settings", "Quality", "Medium", "Cancel", "Export"],
    resolution: null,
    rate: null,
  },
];

describe.each(STATES)(
  "T3: the visible words of the view are exactly the whitelist, $state",
  ({ row }) => {
    describe.each(PROJECTS)("$name", (project) => {
      it("shows, with the door closed, only the Resolution row, the door, Cancel and Export (and the choice row where it is drawn)", async () => {
        const { container } = await show(project.workload, decision(), [], row);
        expect(door()).toHaveAttribute("aria-expanded", "false");
        expect(visibleWords(container)).toEqual(closedOf(project.closed, row));
      });

      it("adds, with the door open, only the line under the door, Frame rate, Quality and their selects", async () => {
        const { container, user } = await show(project.workload, decision(), [], row);
        await user.click(door());
        expect(door()).toHaveAttribute("aria-expanded", "true");
        expect(visibleWords(container)).toEqual(
          openOf(project.open, row, project.workload !== null),
        );
      });

      it("offers exactly these sizes and rates (never one at or above the project's) and the three qualities by name", async () => {
        await show(project.workload, decision(), [], row);
        expect(optionsOf("resolution")).toEqual(project.resolution);
        expect(optionsOf("frame rate")).toEqual(project.rate);
        expect(optionsOf("quality")).toEqual(["High", "Medium", "Low"]);
      });
    });

    it("shows nothing of what a found chip adds while the door is closed, and the chip row's words once it is open", async () => {
      const { container, user } = await show(DEFAULT, decision(), [amd], row);
      await waitFor(() =>
        expect(screen.getByTestId("chip-row-note").textContent).toBe(CHIP_PASSED_NOTE),
      );
      expect(visibleWords(container)).toEqual(closedOf(PROJECTS[0].closed, row));
      await user.click(door());
      expect(visibleWords(container)).toEqual([
        ...(row ? ROW_WORDS : []),
        "Resolution",
        "Same as project (1080 x 1920)",
        "Advanced settings",
        ...(row ? [START_LINE] : []),
        "Frame rate",
        "Same as project (30 fps)",
        "Quality",
        "Medium",
        "Graphics chip",
        "Auto",
        "Off",
        CHIP_PASSED_NOTE,
        "Cancel",
        "Export",
      ]);
    });

    it("says nothing of a chip that was not found, and the chip row's words are not in the DOM at all", async () => {
      const { container, user } = await show(DEFAULT, decision(), [], row);
      await user.click(door());
      expect(visibleWords(container)).toEqual(openOf(PROJECTS[0].open, row, true));
      expect(container.textContent).not.toContain("Graphics chip");
    });

    it("draws the light-compression line, first behind the door (after the line under the door where there is one), only where the app's look says it will use that setting", async () => {
      const { container, user } = await show(DEFAULT, decision({ faster: true }), [], row);
      await screen.findByText(LIGHT_LINE);
      expect(visibleWords(container)).toEqual(closedOf(PROJECTS[0].closed, row));
      await user.click(door());
      expect(visibleWords(container)).toEqual([
        ...(row ? ROW_WORDS : []),
        "Resolution",
        "Same as project (1080 x 1920)",
        "Advanced settings",
        ...(row ? [START_LINE] : []),
        LIGHT_LINE,
        "Frame rate",
        "Same as project (30 fps)",
        "Quality",
        "Medium",
        "Cancel",
        "Export",
      ]);
    });

    it.each<[string, ExportEncoderDecision]>([
      ["an ordinary answer", decision()],
      [
        "an answer that wants the old Mode row (the row is never drawn, so the line has nothing to say either)",
        wantsRow(),
      ],
    ])("draws no light-compression line for %s", async (_name, look) => {
      const { container, user } = await show(DEFAULT, look, [], row);
      expect(container.textContent).not.toContain(LIGHT_LINE);
      await user.click(door());
      expect(container.textContent).not.toContain(LIGHT_LINE);
      expect(visibleWords(container)).toEqual(openOf(PROJECTS[0].open, row, true));
    });
  },
);

/** Words and names that must be nowhere in the DOM, hidden or not, in either state and on either choice (the spec's T4 list). The word Fast is the choice row's alone (checked separately). */
const NEVER_IN_TEXT: RegExp[] = [
  /Expected:/,
  /rough guess/i,
  /Never upscales/i,
  /would take/i,
  /Near-lossless/,
  /The usual delivery trade-off/,
  /Small file, visible compression/,
  /example/i,
  /Are you sure\?/,
  /Full quality/,
  /Fast uses your graphics chip/,
  /Fast is selected because/,
  /smallest file/,
  /\d\s*(min|MB|GB)\b/,
  // a speed figure, bracketed or not, and what a tooltip or a spoken figure would say
  /\(\s*\d+(\.\d+)?\s*x\s*\)/,
  /\b\d+(\.\d+)?x\b/,
  /speed-up/i,
  /times faster/i,
];
const NEVER_AS_NAME = [
  "export mode",
  "export estimate",
  "export-mode",
  "export-question",
  "export-fast-tip",
  "estimate-much-longer",
];

/** Every text node of the page, one per line: element boundaries are word boundaries (textContent would glue "Fast" and a word that follows it into one). */
function pageLines(node: Node = document.body): string[] {
  if (node.nodeType === 3) return [node.textContent ?? ""];
  return Array.from(node.childNodes).flatMap((child) => pageLines(child));
}

/** What must be nowhere in the page. `row` is whether this state draws the choice row: then the group "export choice" with exactly the radios "Quality" and "Fast" is there, and the word Fast is nowhere else. */
function expectNeverDrawn(row: boolean): void {
  // by role and name (hidden elements included)
  expect(screen.queryByRole("radiogroup", { name: "export mode", hidden: true })).toBeNull();
  expect(screen.queryAllByRole("radio", { name: "Full quality", hidden: true })).toHaveLength(0);
  expect(screen.queryAllByRole("alertdialog", { hidden: true })).toHaveLength(0);
  expect(screen.queryAllByRole("tooltip", { hidden: true })).toHaveLength(0);
  expect(screen.queryByLabelText("export estimate")).toBeNull();
  const groups = screen.queryAllByRole("radiogroup", { name: "export choice", hidden: true });
  const radios = screen.queryAllByRole("radio", { name: /fast|quality/i, hidden: true });
  if (row) {
    expect(groups).toHaveLength(1);
    expect(within(groups[0]).getAllByRole("radio", { hidden: true })).toHaveLength(2);
    const quality = within(groups[0]).getByRole("radio", { name: "Quality", hidden: true });
    const fast = within(groups[0]).getByRole("radio", { name: "Fast", hidden: true });
    expect(radios).toEqual([quality, fast]);
    // no figure, no tooltip, nothing that describes the Fast radio
    expect(fast).not.toHaveAttribute("aria-describedby");
    expect(groups[0].querySelector("[aria-describedby]")).toBeNull();
    // the word Fast belongs to the row alone
    const rest = document.body.cloneNode(true) as HTMLElement;
    rest.querySelector("[data-testid='export-choice']")?.remove();
    expect(rest.textContent).not.toMatch(/\bFast\b/);
  } else {
    expect(groups).toHaveLength(0);
    expect(radios).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/\bFast\b/);
  }
  // by text, over everything in the document
  const text = document.body.textContent ?? "";
  for (const never of NEVER_IN_TEXT) expect(text).not.toMatch(never);
  // no retired name anywhere in the page text, in any state (read line by line, so that a name cannot hide by standing next to another word)
  expect(retiredIn(pageLines().join("\n"))).toEqual([]);
  // by every name an element can carry
  const carried = Array.from(document.body.querySelectorAll("*")).flatMap((element) =>
    ["aria-label", "title", "data-testid", "name", "id"].map((attribute) =>
      element.getAttribute(attribute),
    ),
  );
  for (const name of NEVER_AS_NAME) expect(carried).not.toContain(name);
  if (!row)
    for (const name of ["export choice", "export-choice"]) expect(carried).not.toContain(name);
  expect(retiredIn(carried.filter((name) => name !== null).join("\n"))).toEqual([]);
  // the quality hints are not part of an option's name either
  for (const option of screen.queryAllByRole("option", { hidden: true }))
    expect(option.textContent).not.toMatch(/ — |Near-lossless|trade-off|visible compression/);
}

describe("T4: what is never drawn, hidden or not, closed or open", () => {
  const LOOKS: [string, ExportEncoderDecision, GraphicsAdapter[]][] = [
    ["an answer that wants the old Mode row, on a PC with no chip row", wantsRow(), []],
    ["an answer that wants the old Mode row, on a PC with a chip", wantsRow(), [amd]],
    ["an answer that chooses the chip for the person, on a PC with no chip row", chipChosen(), []],
    ["an answer that chooses the chip for the person, on a PC with a chip", chipChosen(), [amd]],
    ["an answer for the app's lighter setting", decision({ faster: true }), []],
    ["an ordinary answer", decision(), [amd]],
  ];
  // The three states of the view: no row (the Quality-only screen), the row on Quality (the start), the row on Fast (picked by the person).
  const CHOICES = [
    { name: "without the choice row", row: false, fast: false },
    { name: "with the choice row, on Quality", row: true, fast: false },
    { name: "with the choice row, on Fast", row: true, fast: true },
  ] as const;

  describe.each(CHOICES)("$name", ({ row, fast }) => {
    const choose = async (user: ReturnType<typeof userEvent.setup>) => {
      if (!fast) return;
      await user.click(screen.getByRole("radio", { name: "Fast" }));
      await settleAll();
      expect(screen.getByRole("radio", { name: "Fast" })).toBeChecked();
    };

    describe.each(LOOKS)("with %s", (_name, look, adapters) => {
      it.each<[string, RenderWorkload | null]>([
        ["the default project", DEFAULT],
        [
          "a 4K project at 60 (where the old dialog draws its Mode row for a chip it cannot use)",
          sized(3840, 2160, 60),
        ],
        ["no project", null],
      ])("for %s, with the door closed", async (_project, workload) => {
        const { user } = await show(workload, look, adapters, row);
        await choose(user);
        expectNeverDrawn(row);
      });

      it("with the door open", async () => {
        const { user } = await show(DEFAULT, look, adapters, row);
        await choose(user);
        await user.click(door());
        expectNeverDrawn(row);
      });
    });
  });

  it("is not satisfied by an empty screen: the check does see the 0.28.0 dialog's words", async () => {
    // the same checks, pointed at a page that does carry them, must fail: a guard that cannot fail guards nothing
    render(
      <div>
        <div role="radiogroup" aria-label="export mode">
          <label>
            <input type="radio" name="m" /> Full quality
          </label>
          <label>
            <input type="radio" name="m" /> Fast
          </label>
        </div>
        <p aria-label="export estimate">Expected: about 12 min</p>
      </div>,
    );
    expect(() => expectNeverDrawn(false)).toThrow();
    expect(() => expectNeverDrawn(true)).toThrow();
  });

  it("does see a figure, a tooltip and a description on the Fast label, and a row where there must be none", () => {
    const row = (figure: number | null) => (
      <ChoiceRow choice="quality" figure={figure} onPick={noop} closeTip={{ current: null }} />
    );
    // the clean row passes the check for the state that draws it, and fails it for the state that does not
    const clean = render(row(null));
    expect(() => expectNeverDrawn(true)).not.toThrow();
    expect(() => expectNeverDrawn(false)).toThrow();
    clean.unmount();
    // the row with a figure (the brackets, the tooltip, the spoken words, the description) fails it
    render(row(4));
    expect(() => expectNeverDrawn(true)).toThrow();
  });

  it("does see a retired name, in the text and in a name an element carries", () => {
    const clean = render(
      <div>
        <ChoiceRow choice="quality" figure={null} onPick={noop} closeTip={{ current: null }} />
        <p>Quick export</p>
      </div>,
    );
    expect(() => expectNeverDrawn(true)).toThrow();
    clean.unmount();
    render(
      <div>
        <ChoiceRow choice="quality" figure={null} onPick={noop} closeTip={{ current: null }} />
        <button type="button" aria-label="use the faster setting" />
      </div>,
    );
    expect(() => expectNeverDrawn(true)).toThrow();
  });
});
