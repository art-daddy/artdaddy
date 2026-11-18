// T12 of the D2 UI spec (section 5, cut down to the settings view of wave 1; paths of 4.5 and the Tab order of 4.2), driven with `userEvent` and the keyboard only, no pointer, in the two states of the view (without the
// choice row, `fastChoice` false: the Quality-only screen; and with it, the default, where the checked choice radio is the first and only stop of the row):
//  - the Tab order with the door closed is [(the choice radio,) Resolution (when drawn), the door, Cancel, Export] and nothing inside the closed region takes focus;
//  - with the door open (Enter or Space on the door, aria-expanded true) it is [(the choice radio,) Resolution, the door, Frame rate (when drawn), Quality, the chip radios as ONE stop (when drawn), Cancel, Export];
//  - a select's value changes with the arrow keys and what Export then sends is that value; the chip's radios move with the arrow keys; Enter on Export starts the export once; Cancel by keyboard calls onCancel.
// Mutants this file must kill: a positive tabindex; focus landing in the closed region; the door not a button or not toggling on Enter or Space; the chip radios as two stops; Export starting twice; Cancel starting an export.
// happy-dom has no user-agent style for the `hidden` attribute, which a browser applies as display none and which is what keeps an element out of the Tab order; the rule is installed here (and checked) so that the
// Tab order below is the browser's. It has no native keyboard action for a select either, so `arrow` below applies the browser's default action (the next or previous option, then `change`) unless the page cancelled the key.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const FLAGS: readonly ExportFlagName[] = [
  "chip_amd",
  "chip_nvidia",
  "chip_intel",
  "chip_default",
  "quick_export",
];
const CHIP_PREF = "artdaddy.chipPref.v1";
const CHIP_PASSED_NOTE =
  "Auto: used when it saves time. The file is usually larger and the picture can differ slightly.";

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

const answer: ExportEncoderDecision = {
  mode: "quality",
  reason: "none",
  showRow: false,
  defaultMode: "quality",
  fullSeconds: 40,
  fastSeconds: null,
  fullGuessed: true,
  tests: [],
  facts: { encoder: "x264", reason: "none", tests: [] },
};

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

const settleAll = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));

let browserRule: HTMLStyleElement;
beforeAll(() => {
  browserRule = document.createElement("style");
  browserRule.textContent = "[hidden] { display: none; }";
  document.head.appendChild(browserRule);
});
afterAll(() => browserRule.remove());

beforeEach(() => {
  for (const flag of FLAGS) __setExportFlag(flag, true);
  localStorage.clear();
  __resetChipTests();
  useEditor.setState({ timeline: null });
  useExportJob.getState().reset();
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(async () => answer);
  pcWith([]);
});

type User = ReturnType<typeof userEvent.setup>;

/** Whether the view under test draws the Quality | Fast row: set for each of the two states the tests below run in. */
let withRow = true;
const STATES = [
  { state: "without the choice row (fastChoice false)", row: false },
  { state: "with the choice row (the default)", row: true },
] as const;
/** The Tab stops of the Quality-only screen, with the choice row's one stop (the checked radio) in front where the state draws the row. */
const lead = (stops: string[]): string[] => (withRow ? ["radio Quality", ...stops] : stops);

/** The view with `userEvent` ready; the chip row (if the PC has a chip) has finished its first look, so the Tab order does not change under the test. */
async function mount(workload: RenderWorkload | null = DEFAULT, adapters: GraphicsAdapter[] = []) {
  pcWith(adapters);
  const onStart = vi.fn<(settings: ExportSettings) => void>();
  const onCancel = vi.fn<() => void>();
  render(
    <ExportSettingsView
      workload={workload}
      onCancel={onCancel}
      onStart={onStart}
      fastChoice={withRow}
    />,
  );
  if (adapters.length > 0)
    await waitFor(() =>
      expect(screen.getByTestId("chip-row-note").textContent).toBe(CHIP_PASSED_NOTE),
    );
  await settleAll();
  return { user: userEvent.setup(), onStart, onCancel };
}

const region = () => screen.getByTestId("export-advanced");
const door = () => screen.getByRole("button", { name: "Advanced settings" });

/** What holds focus, in words: "select resolution", "button Advanced settings", "radio Auto". */
function focused(): string {
  const element = document.activeElement;
  if (!element || element === document.body) return "nothing";
  if (element instanceof HTMLInputElement && element.type === "radio")
    return `radio ${element.closest("label")?.textContent?.trim() ?? ""}`;
  return `${element.tagName.toLowerCase()} ${element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""}`;
}

/** Presses Tab from the page's start until focus leaves the view again, and says where it stopped each time. With `opener`, that key is pressed on the door when it holds focus. While the region is
 *  closed nothing inside it may ever hold focus. */
async function tabThrough(user: User, opener?: "{Enter}" | " "): Promise<string[]> {
  const stops: string[] = [];
  for (let presses = 0; presses < 30; presses += 1) {
    await user.tab();
    if (document.activeElement === document.body) return stops;
    stops.push(focused());
    if (document.getElementById("export-advanced")?.hasAttribute("hidden"))
      expect(region().contains(document.activeElement)).toBe(false);
    if (opener && focused() === "button Advanced settings") await user.keyboard(opener);
  }
  throw new Error(`Tab never left the view: ${stops.join(" > ")}`);
}

/** Presses Tab until focus is on `target` (at most 10 presses): the way to a stop that does not depend on whether the state draws the choice row in front of it. */
async function tabTo(user: User, target: string): Promise<void> {
  for (let presses = 0; presses < 10; presses += 1) {
    await user.tab();
    if (focused() === target) return;
  }
  throw new Error(`Tab never reached ${target}; focus is on ${focused()}`);
}

/** The browser's default action for an arrow key on a focused select (see the note at the top). */
async function arrow(user: User, key: "ArrowDown" | "ArrowUp"): Promise<void> {
  const select = document.activeElement;
  if (!(select instanceof HTMLSelectElement)) throw new Error(`${focused()} is not a select`);
  let cancelled = false;
  const watch = (event: KeyboardEvent): void => {
    cancelled = event.defaultPrevented;
  };
  window.addEventListener("keydown", watch);
  await user.keyboard(`{${key}}`);
  window.removeEventListener("keydown", watch);
  if (cancelled) return;
  const next = Math.min(
    Math.max(select.selectedIndex + (key === "ArrowDown" ? 1 : -1), 0),
    select.options.length - 1,
  );
  if (next !== select.selectedIndex)
    fireEvent.change(select, { target: { value: select.options[next].value } });
}
/** The text of the option a select shows. */
const shown = (select: Element): string => {
  const box = select as HTMLSelectElement;
  return box.options[box.selectedIndex].textContent ?? "";
};

describe("the test environment keeps what the browser keeps out of the Tab order out of it", () => {
  it("treats an element with the hidden attribute as display none, as a browser does", async () => {
    render(
      <div>
        <button type="button">before</button>
        <div hidden>
          <button type="button">inside</button>
        </div>
        <button type="button">after</button>
      </div>,
    );
    const user = userEvent.setup();
    await user.tab();
    await user.tab();
    expect(document.activeElement?.textContent).toBe("after");
  });
});

describe.each(STATES)("$state", ({ row }) => {
  beforeEach(() => {
    withRow = row;
  });

  describe("T12: the Tab order of the settings view", () => {
    it("with the door closed: [the choice radio,] Resolution, the door, Cancel, Export, and nothing inside the closed region", async () => {
      const { user } = await mount(DEFAULT, [amd]);
      expect(region()).toHaveAttribute("hidden");
      expect(await tabThrough(user)).toEqual(
        lead(["select resolution", "button Advanced settings", "button Cancel", "button Export"]),
      );
    });

    it("with the door closed on a 480p project there is no Resolution stop", async () => {
      const { user } = await mount(sized(854, 480, 30));
      expect(await tabThrough(user)).toEqual(
        lead(["button Advanced settings", "button Cancel", "button Export"]),
      );
    });

    it("goes back the same way with Shift+Tab", async () => {
      const { user } = await mount(DEFAULT, [amd]);
      await tabThrough(user);
      await user.tab({ shift: true }); // from the page's start to the last stop
      expect(focused()).toBe("button Export");
      const back: string[] = [];
      const stops = row ? 4 : 3;
      for (let presses = 0; presses < stops; presses += 1) {
        await user.tab({ shift: true });
        back.push(focused());
      }
      expect(back).toEqual(
        row
          ? ["button Cancel", "button Advanced settings", "select resolution", "radio Quality"]
          : ["button Cancel", "button Advanced settings", "select resolution"],
      );
    });

    it.each<["Enter" | "Space", "{Enter}" | " "]>([
      ["Enter", "{Enter}"],
      ["Space", " "],
    ])(
      "with the door opened by %s: [the choice radio,] Resolution, the door, Frame rate, Quality, the chip radios as one stop, Cancel, Export",
      async (_key, opener) => {
        const { user } = await mount(DEFAULT, [amd]);
        expect(await tabThrough(user, opener)).toEqual(
          lead([
            "select resolution",
            "button Advanced settings",
            "select frame rate",
            "select quality",
            "radio Auto",
            "button Cancel",
            "button Export",
          ]),
        );
        expect(door()).toHaveAttribute("aria-expanded", "true");
        expect(region()).not.toHaveAttribute("hidden");
      },
    );

    it("with the door open on a 1080p project at 24 and no chip: no Frame rate and no chip stop", async () => {
      const { user } = await mount(sized(1920, 1080, 24));
      expect(await tabThrough(user, "{Enter}")).toEqual(
        lead([
          "select resolution",
          "button Advanced settings",
          "select quality",
          "button Cancel",
          "button Export",
        ]),
      );
    });
  });

  describe("T12: the door by keyboard", () => {
    it("opens and closes on Enter and on Space, keeps focus, and hides the region again", async () => {
      const { user } = await mount();
      await tabTo(user, "button Advanced settings");
      expect(door()).toHaveAttribute("aria-controls", "export-advanced");
      expect(door()).toHaveAttribute("aria-expanded", "false");

      for (const key of ["{Enter}", " "]) {
        await user.keyboard(key);
        expect(door()).toHaveAttribute("aria-expanded", "true");
        expect(region()).not.toHaveAttribute("hidden");
        expect(screen.getByRole("group", { name: "Advanced settings" })).toBeVisible();
        expect(focused()).toBe("button Advanced settings");
        await user.keyboard(key);
        expect(door()).toHaveAttribute("aria-expanded", "false");
        expect(region()).toHaveAttribute("hidden");
        expect(focused()).toBe("button Advanced settings");
      }
    });
  });

  describe("T12: values changed with the keyboard are the values Export sends", () => {
    it("the arrow keys change Resolution, Frame rate and Quality, and Enter on Export hands them over once", async () => {
      const { user, onStart } = await mount();
      await tabTo(user, "select resolution");
      expect(shown(document.activeElement as Element)).toBe("Same as project (1080 x 1920)");
      await arrow(user, "ArrowDown");
      expect(shown(document.activeElement as Element)).toBe("720p");

      await user.tab(); // the door
      await user.keyboard("{Enter}");
      await user.tab(); // Frame rate
      expect(focused()).toBe("select frame rate");
      await arrow(user, "ArrowDown");
      expect(shown(document.activeElement as Element)).toBe("25 fps");

      await user.tab(); // Quality
      expect(focused()).toBe("select quality");
      expect(shown(document.activeElement as Element)).toBe("Medium");
      await arrow(user, "ArrowUp");
      expect(shown(document.activeElement as Element)).toBe("High");
      await arrow(user, "ArrowDown");
      await arrow(user, "ArrowDown");
      expect(shown(document.activeElement as Element)).toBe("Low");

      await user.tab(); // Cancel
      await user.tab(); // Export
      expect(focused()).toBe("button Export");
      await settleAll();
      await user.keyboard("{Enter}");
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onStart.mock.calls[0][0]).toStrictEqual({
        resolution: "720p",
        quality: "low",
        fps: 25,
        mode: null,
      });
    });

    it("an arrow key the page cancels would not have changed the value (the helper is not a way round the page)", async () => {
      const { user } = await mount();
      await tabTo(user, "select resolution");
      const stop = (event: KeyboardEvent): void => event.preventDefault();
      window.addEventListener("keydown", stop);
      await arrow(user, "ArrowDown");
      window.removeEventListener("keydown", stop);
      expect(shown(document.activeElement as Element)).toBe("Same as project (1080 x 1920)");
    });

    it("Space on Export also hands the settings over once", async () => {
      const { user, onStart } = await mount();
      await tabThrough(user);
      await user.tab({ shift: true });
      expect(focused()).toBe("button Export");
      await user.keyboard(" ");
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onStart.mock.calls[0][0]).toStrictEqual({
        resolution: "source",
        quality: "medium",
        fps: null,
        mode: null,
      });
    });

    it("Cancel by keyboard calls onCancel and starts nothing", async () => {
      const { user, onStart, onCancel } = await mount();
      await tabTo(user, "select resolution");
      await user.tab(); // the door
      await user.tab(); // Cancel
      expect(focused()).toBe("button Cancel");
      await user.keyboard("{Enter}");
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onStart).not.toHaveBeenCalled();
    });
  });

  describe("T12: the chip radios are one stop and move with the arrow keys", () => {
    it("Down and Up move between Auto and Off, and the per-PC switch follows", async () => {
      const { user } = await mount(DEFAULT, [amd]);
      await tabTo(user, "select resolution");
      await user.tab(); // the door
      await user.keyboard("{Enter}");
      await user.tab(); // Frame rate
      await user.tab(); // Quality
      await user.tab(); // the chip radios: one stop, on the checked one
      expect(focused()).toBe("radio Auto");

      await user.keyboard("{ArrowDown}");
      expect(focused()).toBe("radio Off");
      expect(screen.getByRole("radio", { name: "Off" })).toBeChecked();
      expect(localStorage.getItem(CHIP_PREF)).toBe("off");

      await user.keyboard("{ArrowUp}");
      expect(focused()).toBe("radio Auto");
      expect(screen.getByRole("radio", { name: "Auto" })).toBeChecked();
      expect(localStorage.getItem(CHIP_PREF)).toBeNull();

      await user.tab(); // leaves the radios for Cancel: the group was one stop
      expect(focused()).toBe("button Cancel");
    });
  });
});
