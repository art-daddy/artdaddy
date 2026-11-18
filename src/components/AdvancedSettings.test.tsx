// The "Advanced settings" door of the Export dialog's Quality / Fast view (design D2) and the region behind it, driven as a person drives it (the pointer, Tab, Enter) and read as a screen reader reads it (role
// and accessible name). The expected words are written out here, never read from the words file. The Graphics chip row inside is the real one over a scripted PC and a scripted ffmpeg, with the boundary mocked as
// ChipRow.test.tsx and ExportDialog.chipRow.test.tsx mock it. The component is controlled, so a case that needs the door to open uses `Live`, which holds the state the view holds.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { __setExportFlag, type ExportFlagName } from "../api/exportFlags";
import {
  processorName,
  resolveExportResources,
  runCapabilityProbe,
  type GraphicsAdapter,
} from "../platform/host";
import { amd, harness, type Behaviour } from "../test/chipHarness";
import { CHIP_PREF_KEY } from "../timeline/chipPref";
import { __resetChipTests, markChipSuspect } from "../timeline/chipTest";
import type { ExportResolution } from "../timeline/exportOptions";
import AdvancedSettings, { type AdvancedSettingsProps } from "./AdvancedSettings";

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

// A browser takes an element with the `hidden` attribute out of sight and out of the tab order by its own style sheet; happy-dom has none, so user-event would Tab straight into it. This is that one rule.
let browserRule: HTMLStyleElement;
beforeAll(() => {
  browserRule = document.createElement("style");
  browserRule.textContent = "[hidden] { display: none; }";
  document.head.append(browserRule);
});
afterAll(() => browserRule.remove());

const NOTES = {
  passed:
    "Auto: used when it saves time. The file is usually larger and the picture can differ slightly.",
  checking: "Checking this PC's graphics chip\u2026",
  not_passed:
    "Auto: not used. The graphics chip did not pass ArtDaddy's test on this PC, so exports use the processor.",
  set_aside:
    "The graphics chip stopped an export on this PC, so it is set aside for a day. Try it again now",
  off: "Off: the graphics chip is not tested, offered or used on this PC. Everything runs on the processor.",
} as const;
const SUMMARY = "Project size and frame rate, Medium quality.";
const FASTER =
  "To save time, ArtDaddy will use light compression; the picture may be slightly softer.";

const RATES_60: AdvancedSettingsProps["rates"] = [
  { value: null, label: "Same as project (60 fps)" },
  { value: 50, label: "50 fps" },
  { value: 30, label: "30 fps" },
  { value: 25, label: "25 fps" },
  { value: 24, label: "24 fps" },
];
const QUALITIES: AdvancedSettingsProps["qualities"] = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

function props(over: Partial<AdvancedSettingsProps> = {}): AdvancedSettingsProps {
  return {
    open: false,
    onToggle: () => undefined,
    fasterLine: null,
    rates: RATES_60,
    fps: null,
    onFps: () => undefined,
    qualities: QUALITIES,
    quality: "medium",
    onQuality: () => undefined,
    chip: null,
    ...over,
  };
}

/** The chip row's basis as the view hands it over, with spies for what the row tells the view. */
function chipProps(
  over: {
    workload?: { width: number; height: number; fps: number };
    resolution?: ExportResolution;
    fps?: number | null;
  } = {},
) {
  return {
    workload: over.workload ?? { width: 1920, height: 1080, fps: 30 },
    resolution: over.resolution ?? ("source" as ExportResolution),
    fps: over.fps ?? null,
    onChange: vi.fn<() => void>(),
    onDrawn: vi.fn<(drawn: boolean) => void>(),
  };
}

/** The door between two buttons (the rest of a dialog's tab order), holding the open state as the view does. */
function Live({
  startOpen = false,
  toggled,
  ...over
}: Partial<AdvancedSettingsProps> & { startOpen?: boolean; toggled?: () => void }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <button type="button">before</button>
      <AdvancedSettings
        {...props(over)}
        open={open}
        onToggle={() => {
          toggled?.();
          setOpen((was) => !was);
        }}
      />
      <button type="button">after</button>
    </>
  );
}

type Resources = Awaited<ReturnType<typeof resolveExportResources>>;
const resourcesWith = (adapters: GraphicsAdapter[]): Resources => ({
  total_memory_bytes: null,
  available_memory_bytes: null,
  scratch_free_bytes: null,
  destination_free_bytes: null,
  budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
  adapters,
});

/** A PC with these chips and an ffmpeg that behaves as told; `gate` holds the chip's test until it is opened. */
function pc(adapters: GraphicsAdapter[], behaviour: Behaviour = {}, gate?: Promise<void>) {
  const scripted = harness(adapters, behaviour);
  vi.mocked(runCapabilityProbe).mockReset();
  vi.mocked(runCapabilityProbe).mockImplementation(async (args, options) => {
    if (gate) await gate;
    return scripted.deps.probe(args, options);
  });
  vi.mocked(resolveExportResources).mockReset();
  vi.mocked(resolveExportResources).mockResolvedValue(resourcesWith(adapters));
  vi.mocked(processorName).mockReset();
  vi.mocked(processorName).mockResolvedValue(null);
}

beforeEach(() => {
  localStorage.clear();
  __resetChipTests();
  for (const flag of FLAGS) __setExportFlag(flag, true);
  vi.mocked(runCapabilityProbe).mockReset();
  vi.mocked(resolveExportResources).mockReset();
});
/** Opens the chip test that a case holds back; run after every case so none is left waiting. */
let release: (() => void) | null = null;
afterEach(() => {
  release?.();
  release = null;
  cleanup();
  for (const flag of FLAGS) __setExportFlag(flag, true);
});

const door = () => screen.getByRole("button", { name: "Advanced settings" });
const region = () => screen.getByTestId("export-advanced");
const rateBox = () => screen.getByRole("combobox", { name: "frame rate" });
const qualityBox = () => screen.getByRole("combobox", { name: "quality" });
const note = () => screen.getByTestId("chip-row-note");
const optionTexts = (box: HTMLElement) =>
  within(box)
    .getAllByRole("option")
    .map((option) => option.textContent);
const chipCalls = () =>
  vi
    .mocked(runCapabilityProbe)
    .mock.calls.filter(([, options]) => options.kind.startsWith("chip-test"));
const sizesTested = () =>
  chipCalls().flatMap(([args]) => args.filter((part) => part.includes("size=")));
const settled = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
/** True when each element comes before the next in the page, which is the order a person reads and tabs them. */
const inOrder = (...els: Element[]) =>
  els.slice(1).every((el, i) => {
    const earlier = els[i];
    return (
      earlier !== undefined &&
      (earlier.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    );
  });
async function tabThrough(user: UserEvent, count: number): Promise<(Element | null)[]> {
  const stops: (Element | null)[] = [];
  for (let n = 0; n < count; n++) {
    await user.tab();
    stops.push(document.activeElement);
  }
  return stops;
}

describe("the door", () => {
  it("is a button named Advanced settings that says whether it is open and what it controls", () => {
    const view = render(<AdvancedSettings {...props({ open: false })} />);
    expect(door()).toHaveAttribute("aria-expanded", "false");
    expect(door()).toHaveAttribute("aria-controls", "export-advanced");
    expect(document.getElementById("export-advanced")).toBe(region());
    view.rerender(<AdvancedSettings {...props({ open: true })} />);
    expect(door()).toHaveAttribute("aria-expanded", "true");
    expect(door()).toHaveAttribute("aria-controls", "export-advanced");
  });

  it("tells the view each time it is pressed, once, and does not open itself", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<AdvancedSettings {...props({ onToggle })} />);
    await user.click(door());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(door()).toHaveAttribute("aria-expanded", "false"); // the view decides, and this one did not
    await user.dblClick(door());
    expect(onToggle).toHaveBeenCalledTimes(3);
  });

  it("opens and closes the region as the view flips it, by the pointer and by Enter and Space", async () => {
    const user = userEvent.setup();
    render(<Live />);
    expect(region()).not.toBeVisible();
    await user.click(door());
    expect(door()).toHaveAttribute("aria-expanded", "true");
    expect(region()).toBeVisible();
    await user.click(door());
    expect(door()).toHaveAttribute("aria-expanded", "false");
    expect(region()).not.toBeVisible();
    act(() => door().focus());
    await user.keyboard("{Enter}");
    expect(region()).toBeVisible();
    await user.keyboard(" ");
    expect(region()).not.toBeVisible();
  });

  it("names the region it opens after itself, so a screen reader hears a group called Advanced settings", () => {
    const view = render(<AdvancedSettings {...props({ open: false })} />);
    expect(screen.queryByRole("group", { name: "Advanced settings" })).toBeNull(); // closed: not in the tree
    view.rerender(<AdvancedSettings {...props({ open: true })} />);
    expect(screen.getByRole("group", { name: "Advanced settings" })).toBe(region());
  });
});

describe("the region behind a closed door", () => {
  const everything = {
    summary: SUMMARY,
    fasterLine: FASTER,
  };

  it("is in the page all the time, hidden by the HTML attribute and not by a class that sets display", () => {
    const view = render(<AdvancedSettings {...props({ ...everything })} />);
    expect(region()).toHaveAttribute("hidden");
    expect(region()).not.toBeVisible();
    // a class that sets display would win over `hidden` in a browser
    for (const display of [
      "flex",
      "inline-flex",
      "grid",
      "inline-grid",
      "block",
      "inline-block",
      "contents",
      "table",
    ])
      expect(region().className.split(/\s+/), display).not.toContain(display);
    view.rerender(<AdvancedSettings {...props({ ...everything, open: true })} />);
    expect(region()).not.toHaveAttribute("hidden");
    expect(region()).toBeVisible();
  });

  it("shows no word of what is behind it, and a screen reader finds no control in it", () => {
    const view = render(<AdvancedSettings {...props({ ...everything })} />);
    for (const words of [SUMMARY, FASTER, "Frame rate", "Quality"])
      expect(screen.getByText(words), words).not.toBeVisible();
    expect(screen.queryAllByRole("combobox")).toEqual([]);
    expect(screen.getAllByRole("combobox", { hidden: true })).toHaveLength(2);
    view.rerender(<AdvancedSettings {...props({ ...everything, open: true })} />);
    for (const words of [SUMMARY, FASTER, "Frame rate", "Quality"])
      expect(screen.getByText(words), words).toBeVisible();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });

  it("is not on the way of Tab, forwards or backwards: the door is followed by what follows the door", async () => {
    pc([amd]); // a chip is found, so its radios are in the region as well
    const user = userEvent.setup();
    render(<Live chip={chipProps()} />);
    await waitFor(() => expect(screen.getByTestId("chip-row")).toBeInTheDocument());
    const before = screen.getByRole("button", { name: "before" });
    const after = screen.getByRole("button", { name: "after" });
    act(() => before.focus());
    const forwards = await tabThrough(user, 2);
    expect(forwards[0]).toBe(door());
    expect(forwards[1]).toBe(after);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(door());
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(before);
  });

  it("lets nothing in it take focus, however it is asked, and lets everything take it once the door is open", async () => {
    pc([amd]);
    const user = userEvent.setup();
    render(<Live chip={chipProps()} />);
    await waitFor(() => expect(screen.getByTestId("chip-row")).toBeInTheDocument());
    const controls = [...region().querySelectorAll<HTMLElement>("select, input, button")];
    expect(controls).toHaveLength(4); // Frame rate, Quality, and the chip's Auto and Off
    for (const control of controls) {
      act(() => control.focus());
      expect(document.activeElement, "closed").not.toBe(control);
    }
    await user.click(door());
    for (const control of controls) {
      act(() => control.focus());
      expect(document.activeElement, "open").toBe(control);
    }
  });
});

describe("the rows", () => {
  it("draws the summary, the faster-setting line, Frame rate, Quality and the chip row in that order", async () => {
    pc([amd]);
    render(
      <AdvancedSettings
        {...props({ open: true, summary: SUMMARY, fasterLine: FASTER, chip: chipProps() })}
      />,
    );
    const chipRow = await screen.findByTestId("chip-row");
    expect(
      inOrder(
        screen.getByText(SUMMARY),
        screen.getByText(FASTER),
        rateBox(),
        qualityBox(),
        chipRow,
      ),
    ).toBe(true);
    for (const el of [
      screen.getByText(SUMMARY),
      screen.getByText(FASTER),
      rateBox(),
      qualityBox(),
      chipRow,
    ])
      expect(el).toBeVisible();
  });

  it("takes Tab through Frame rate, Quality and the chip row's one stop, in that order", async () => {
    pc([amd]);
    const user = userEvent.setup();
    render(<Live startOpen chip={chipProps()} />);
    await screen.findByRole("radiogroup", { name: "Graphics chip" });
    act(() => screen.getByRole("button", { name: "before" }).focus());
    const stops = await tabThrough(user, 5);
    const expected: [string, Element][] = [
      ["the door", door()],
      ["Frame rate", rateBox()],
      ["Quality", qualityBox()],
      [
        "the chip row (Auto is checked, so Off is not a stop)",
        screen.getByRole("radio", { name: "Auto" }),
      ],
      ["what follows", screen.getByRole("button", { name: "after" })],
    ];
    expected.forEach(([what, el], i) => expect(stops[i], what).toBe(el));
  });

  describe("Frame rate", () => {
    it("is not drawn when the list holds one entry or none: there is nothing to choose", () => {
      for (const rates of [
        [],
        [{ value: null, label: "Same as project (24 fps)" }],
      ] satisfies AdvancedSettingsProps["rates"][]) {
        const view = render(<AdvancedSettings {...props({ open: true, rates })} />);
        expect(screen.queryByText("Frame rate")).toBeNull();
        expect(screen.queryByRole("combobox", { name: "frame rate" })).toBeNull();
        expect(qualityBox()).toBeVisible(); // the region is open and the rest is there
        view.unmount();
      }
    });

    it("is drawn from two entries up, with the labels it is given, in the order given, and the shown rate selected", () => {
      const view = render(
        <AdvancedSettings
          {...props({
            open: true,
            rates: [
              { value: null, label: "Same as project (30 fps)" },
              { value: 25, label: "25 fps" },
            ],
          })}
        />,
      );
      expect(screen.getByText("Frame rate")).toBeVisible();
      expect(optionTexts(rateBox())).toEqual(["Same as project (30 fps)", "25 fps"]);
      expect(rateBox()).toHaveDisplayValue("Same as project (30 fps)");
      view.unmount();

      render(<AdvancedSettings {...props({ open: true, fps: 30 })} />);
      expect(optionTexts(rateBox())).toEqual([
        "Same as project (60 fps)",
        "50 fps",
        "30 fps",
        "25 fps",
        "24 fps",
      ]);
      expect(rateBox()).toHaveDisplayValue("30 fps");
    });

    // Every entry of the list, not the one that is easiest to check: the entry for the project's own rate is `null`, the others are numbers, and a number is a number and not its text.
    it.each(RATES_60.map((rate) => [rate.label, rate.value] as const))(
      "reports the pick of %s as %s",
      async (label, value) => {
        const onFps = vi.fn();
        const user = userEvent.setup();
        render(
          <AdvancedSettings {...props({ open: true, onFps, fps: value === null ? 24 : null })} />,
        );
        await user.selectOptions(rateBox(), label);
        expect(onFps).toHaveBeenCalledTimes(1);
        expect(onFps).toHaveBeenLastCalledWith(value);
      },
    );

    it("reports a rate that is not a whole number as that number", async () => {
      const onFps = vi.fn();
      const user = userEvent.setup();
      render(
        <AdvancedSettings
          {...props({
            open: true,
            onFps,
            rates: [
              { value: null, label: "Same as project (29.97 fps)" },
              { value: 23.976, label: "23.98 fps" },
            ],
          })}
        />,
      );
      await user.selectOptions(rateBox(), "23.98 fps");
      expect(onFps).toHaveBeenLastCalledWith(23.976);
    });
  });

  describe("Quality", () => {
    it("lists High, Medium and Low in that order, names only, with the shown quality selected", () => {
      render(<AdvancedSettings {...props({ open: true, quality: "low" })} />);
      expect(screen.getByText("Quality")).toBeVisible();
      expect(optionTexts(qualityBox())).toEqual(["High", "Medium", "Low"]);
      expect(qualityBox()).toHaveDisplayValue("Low");
    });

    it.each([
      ["High", "high", "medium"],
      ["Medium", "medium", "low"],
      ["Low", "low", "high"],
    ] as const)("reports the pick of %s as %s", async (label, value, shown) => {
      const onQuality = vi.fn();
      const user = userEvent.setup();
      render(<AdvancedSettings {...props({ open: true, onQuality, quality: shown })} />);
      await user.selectOptions(qualityBox(), label);
      expect(onQuality).toHaveBeenCalledTimes(1);
      expect(onQuality).toHaveBeenLastCalledWith(value);
    });

    it("is drawn whatever else is not: with one rate, no summary, no faster line and no chip", () => {
      render(
        <AdvancedSettings
          {...props({ open: true, rates: [{ value: null, label: "Same as project (24 fps)" }] })}
        />,
      );
      expect(qualityBox()).toBeVisible();
    });
  });

  describe("the summary and the faster-setting line", () => {
    it("are drawn when given, the summary first, and in the region", () => {
      render(<AdvancedSettings {...props({ open: true, summary: SUMMARY, fasterLine: FASTER })} />);
      expect(within(region()).getByText(SUMMARY)).toBeVisible();
      expect(within(region()).getByText(FASTER)).toBeVisible();
      expect(inOrder(screen.getByText(SUMMARY), screen.getByText(FASTER))).toBe(true);
    });

    it.each([
      ["absent", undefined],
      ["null", null],
      ["empty", ""],
    ] as const)("draw no summary when it is %s, not even an empty line", (_what, summary) => {
      render(<AdvancedSettings {...props({ open: true, summary, fasterLine: FASTER })} />);
      expect(screen.getByText(FASTER)).toBeVisible();
      expect(region().querySelectorAll("p")).toHaveLength(1); // the faster line alone
    });

    it("draw no faster-setting line when it is null, not even an empty line", () => {
      render(<AdvancedSettings {...props({ open: true, summary: SUMMARY, fasterLine: null })} />);
      expect(screen.getByText(SUMMARY)).toBeVisible();
      expect(region().querySelectorAll("p")).toHaveLength(1); // the summary alone
      expect(screen.queryByText(FASTER)).toBeNull();
    });

    it("leave nothing but the rows when neither is given", () => {
      render(<AdvancedSettings {...props({ open: true })} />);
      expect(region().querySelectorAll("p")).toHaveLength(0);
      expect(region().querySelectorAll("select")).toHaveLength(2);
    });
  });
});

describe("the Graphics chip row", () => {
  it("is not drawn and not tested when the view gives no chip (no project), though the PC has one", async () => {
    pc([amd]);
    render(<AdvancedSettings {...props({ open: true, chip: null })} />);
    await settled();
    expect(screen.queryByTestId("chip-row")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Graphics chip" })).toBeNull();
    expect(resolveExportResources).not.toHaveBeenCalled();
    expect(runCapabilityProbe).not.toHaveBeenCalled();
  });

  it("is mounted behind the closed door: its first look runs, the view is told, and none of it is visible", async () => {
    pc([amd]);
    const chip = chipProps();
    const view = render(<AdvancedSettings {...props({ open: false, chip })} />);
    await waitFor(() => expect(chip.onDrawn).toHaveBeenLastCalledWith(true));
    await waitFor(() => expect(note().textContent).toBe(NOTES.passed)); // the chip was tested with the door never opened
    expect(resolveExportResources).toHaveBeenCalled();
    expect(chipCalls().length).toBeGreaterThan(0);
    expect(screen.getByTestId("chip-row")).not.toBeVisible();
    expect(note()).not.toBeVisible();
    expect(screen.queryByRole("radiogroup", { name: "Graphics chip" })).toBeNull();
    expect(chip.onDrawn).not.toHaveBeenCalledWith(false);

    view.rerender(<AdvancedSettings {...props({ open: true, chip })} />);
    expect(screen.getByRole("radiogroup", { name: "Graphics chip" })).toBeVisible();
    expect(screen.getByText("Graphics chip")).toBeVisible();
    expect(screen.getByRole("radio", { name: "Auto" })).toBeChecked();
    expect(note()).toBeVisible();
    expect(note().textContent).toBe(NOTES.passed);
  });

  it("tells the view it is not there, behind the closed door, on a PC with no chip", async () => {
    pc([]);
    const chip = chipProps();
    render(<AdvancedSettings {...props({ open: false, chip })} />);
    await waitFor(() => expect(chip.onDrawn).toHaveBeenCalledWith(false));
    await settled();
    expect(chip.onDrawn).not.toHaveBeenCalledWith(true);
    expect(screen.queryByTestId("chip-row")).toBeNull();
  });

  it("stays the same row when the door is opened and closed: nothing is mounted again and nothing is asked again", async () => {
    pc([amd]);
    const chip = chipProps();
    const user = userEvent.setup();
    render(<Live chip={chip} />);
    await waitFor(() => expect(note().textContent).toBe(NOTES.passed));
    const row = screen.getByTestId("chip-row");
    const told = chip.onDrawn.mock.calls.length;
    const tested = chipCalls().length;
    for (let n = 0; n < 2; n++) {
      await user.click(door());
      await user.click(door());
    }
    await settled();
    expect(screen.getByTestId("chip-row")).toBe(row);
    expect(chip.onDrawn.mock.calls.length).toBe(told);
    expect(chipCalls().length).toBe(tested);
  });

  // The owner's sentence is for the state where the chip passed; the four others are the row's own, 0.28.0's, word for word.
  it.each([
    [
      "checking",
      async () => {
        pc([amd], {}, new Promise<void>((resolve) => (release = resolve)));
        render(<AdvancedSettings {...props({ open: true, chip: chipProps() })} />);
        await waitFor(() => expect(note().textContent).toBe(NOTES.checking));
      },
    ],
    [
      "not_passed",
      async () => {
        pc([amd], { chip: "fail" });
        render(<AdvancedSettings {...props({ open: true, chip: chipProps() })} />);
        await waitFor(() => expect(note().textContent).toBe(NOTES.not_passed));
      },
    ],
    [
      "set_aside",
      async () => {
        pc([amd]);
        const first = render(<AdvancedSettings {...props({ open: true, chip: chipProps() })} />);
        await waitFor(() => expect(note().textContent).toBe(NOTES.passed));
        first.unmount();
        markChipSuspect(amd);
        render(<AdvancedSettings {...props({ open: true, chip: chipProps() })} />);
        await waitFor(() => expect(note().textContent).toBe(NOTES.set_aside));
        expect(within(note()).getByRole("button", { name: "Try it again now" })).toBeVisible();
      },
    ],
    [
      "off",
      async () => {
        pc([amd]);
        localStorage.setItem(CHIP_PREF_KEY, "off");
        render(<AdvancedSettings {...props({ open: true, chip: chipProps() })} />);
        await waitFor(() => expect(note().textContent).toBe(NOTES.off));
        expect(screen.getByRole("radio", { name: "Off" })).toBeChecked();
      },
    ],
  ] as const)("says 0.28.0's words for the state %s", async (_state, arrange) => {
    await arrange();
  });

  it("tells the view when the person changes what the app does about the chip, and keeps the switch", async () => {
    pc([amd]);
    const chip = chipProps();
    const user = userEvent.setup();
    render(<AdvancedSettings {...props({ open: true, chip })} />);
    await waitFor(() => expect(note().textContent).toBe(NOTES.passed));
    expect(chip.onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: "Off" }));
    expect(chip.onChange).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CHIP_PREF_KEY)).toBe("off");
    await waitFor(() => expect(note().textContent).toBe(NOTES.off));
  });

  describe("is tested at the picture the export will deliver: the shown size and rate, not the project's", () => {
    const uhd = { width: 3840, height: 2160, fps: 30 };

    it("follows the shown size: 1080p on a 4K project is tested as 1080p, and the project's own size as 4K", async () => {
      pc([amd]);
      const shown = render(
        <AdvancedSettings
          {...props({ chip: chipProps({ workload: uhd, resolution: "1080p" }) })}
        />,
      );
      await waitFor(() => expect(note().textContent).toBe(NOTES.passed));
      expect(sizesTested().length).toBeGreaterThan(0);
      expect(sizesTested().every((size) => size.includes("1080x1920"))).toBe(true);
      shown.unmount();

      __resetChipTests();
      pc([amd]);
      render(
        <AdvancedSettings
          {...props({ chip: chipProps({ workload: uhd, resolution: "source" }) })}
        />,
      );
      await waitFor(() => expect(note().textContent).toBe(NOTES.passed));
      expect(sizesTested().length).toBeGreaterThan(0);
      expect(sizesTested().every((size) => size.includes("3840x2160"))).toBe(true);
    });

    it("follows the shown rate: 4K at 60 is a picture no chip serves, and shown at 30 it is one", async () => {
      pc([amd]);
      const uhd60 = { width: 3840, height: 2160, fps: 60 };
      const own = chipProps({ workload: uhd60, fps: null });
      const first = render(<AdvancedSettings {...props({ chip: own })} />);
      await waitFor(() => expect(own.onDrawn).toHaveBeenCalledWith(false));
      expect(own.onDrawn).not.toHaveBeenCalledWith(true);
      expect(runCapabilityProbe).not.toHaveBeenCalled();
      first.unmount();

      const slower = chipProps({ workload: uhd60, fps: 30 });
      render(<AdvancedSettings {...props({ chip: slower })} />);
      await waitFor(() => expect(slower.onDrawn).toHaveBeenCalledWith(true));
      expect(slower.onDrawn).not.toHaveBeenCalledWith(false);
      await waitFor(() => expect(sizesTested().length).toBeGreaterThan(0));
    });
  });
});
