// The Export dialog's Graphics chip row, drawn from the real chip lookup over a scripted PC and a scripted ffmpeg: its six states, the switch,
// Try it again now, and the two hints. Nothing here starts an export; the only thing that is run is the chip's own short test.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setExportFlag, type ExportFlagName } from "../api/exportFlags";
import { processorName, resolveExportResources, runCapabilityProbe } from "../platform/host";
import { amd, harness, intel, nvidia, type Behaviour } from "../test/chipHarness";
import { CHIP_PREF_KEY } from "../timeline/chipPref";
import { CHIP_ROW_NOTES } from "../timeline/chipRow";
import { __resetChipTests, markChipSuspect, takeChipTestEvents } from "../timeline/chipTest";
import { sizeClassOf } from "../timeline/exportEncoder";
import type { GraphicsAdapter } from "../platform/host";
import ChipRow from "./ChipRow";

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
const probe = vi.mocked(runCapabilityProbe);
const OLD_DRIVER = "32.0.15.6094"; // NVIDIA 560.94
const NEW_DRIVER = "32.0.16.1012"; // NVIDIA 610.12

type Resources = Awaited<ReturnType<typeof resolveExportResources>>;
const resourcesWith = (adapters: GraphicsAdapter[]): Resources => ({
  total_memory_bytes: null,
  available_memory_bytes: null,
  scratch_free_bytes: null,
  destination_free_bytes: null,
  budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
  adapters,
});

/** A PC with these chips, an ffmpeg that behaves as told, and (optionally) the processor's name. `gate` holds the chip's test until opened. */
function pc(
  adapters: GraphicsAdapter[],
  behaviour: Behaviour = {},
  processor: string | null = null,
  gate?: Promise<void>,
) {
  const scripted = harness(adapters, behaviour);
  probe.mockReset();
  probe.mockImplementation(async (args, options) => {
    if (gate) await gate;
    return scripted.deps.probe(args, options);
  });
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
  vi.mocked(processorName).mockResolvedValue(processor);
  return scripted;
}

beforeEach(() => {
  localStorage.clear();
  __resetChipTests();
  for (const flag of FLAGS) __setExportFlag(flag, true);
});
afterEach(() => {
  cleanup();
  for (const flag of FLAGS) __setExportFlag(flag, true);
});

const note = () => screen.getByTestId("chip-row-note");
const settled = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const chipCalls = () =>
  probe.mock.calls.filter(([, options]) => options.kind.startsWith("chip-test"));

describe("the chip row", () => {
  it("draws nothing on a PC with no chip of a known maker, and tests nothing", async () => {
    pc([]);
    const { container } = render(<ChipRow />);
    await settled();
    await settled();
    expect(container).toBeEmptyDOMElement();
    expect(probe).not.toHaveBeenCalled();
  });

  it("says it is checking while the chip is tested, and then that it passed", async () => {
    let open!: () => void;
    pc([amd], {}, null, new Promise<void>((resolve) => (open = resolve)));
    render(<ChipRow />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.checking));
    expect(screen.getByRole("radiogroup", { name: "Graphics chip" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Auto" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Off" })).not.toBeChecked();
    await act(async () => open());
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
  });

  it("says plainly that the chip did not pass, and the processor is used", async () => {
    pc([amd], { chip: "fail" });
    render(<ChipRow />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_not_passed));
    expect(screen.queryByTestId("chip-row-hint")).toBeNull();
  });

  it("is switched Off by the person: remembered, never tested again, and Auto brings the chip back from what it remembers", async () => {
    pc([amd]);
    const changed = vi.fn();
    render(<ChipRow onChange={changed} />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
    const tested = chipCalls().length;
    expect(tested).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.off));
    expect(localStorage.getItem(CHIP_PREF_KEY)).toBe("off");
    expect(screen.getByRole("radio", { name: "Off" })).toBeChecked();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(chipCalls().length).toBe(tested);

    fireEvent.click(screen.getByRole("radio", { name: "Auto" }));
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
    expect(localStorage.getItem(CHIP_PREF_KEY)).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(chipCalls().length).toBe(tested); // remembered: nothing was tested again
  });

  it("opens on Off when the person turned it off before: the row says so and not one command is run", async () => {
    pc([amd]);
    localStorage.setItem(CHIP_PREF_KEY, "off");
    render(<ChipRow />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.off));
    expect(screen.getByRole("radio", { name: "Off" })).toBeChecked();
    await settled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("says a chip that stopped an export is set aside for a day, and Try it again now lifts that without testing it again", async () => {
    pc([amd]);
    const changed = vi.fn();
    const { unmount } = render(<ChipRow onChange={changed} />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
    const tested = chipCalls().length;
    unmount();

    markChipSuspect(amd);
    render(<ChipRow onChange={changed} />);
    await waitFor(() =>
      expect(note().textContent).toContain(
        "stopped an export on this PC, so it is set aside for a day.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Try it again now" }));
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(chipCalls().length).toBe(tested);
  });

  it.each([
    ["with the server's switch for Quick export off (the old Mode row is back)", "quick_export"],
    ["with the server's switch for choosing the chip off", "chip_default"],
    ["with the server's switch for this maker off", "chip_amd"],
  ] as const)("is not drawn %s", async (_why, flag) => {
    pc([amd]);
    __setExportFlag(flag, false);
    const { container } = render(<ChipRow />);
    await settled();
    await settled();
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["with the server's switch for Quick export off", "quick_export"],
    ["with the server's switch for choosing the chip off", "chip_default"],
    ["with the server's switch for this maker off", "chip_amd"],
  ] as const)(
    "still draws the person's own Off %s, so it can be undone, and Auto takes the row away again",
    async (_why, flag) => {
      pc([amd]);
      localStorage.setItem(CHIP_PREF_KEY, "off");
      __setExportFlag(flag, false);
      const changed = vi.fn();
      render(<ChipRow onChange={changed} />);
      await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.off));
      expect(screen.getByRole("radio", { name: "Off" })).toBeChecked();
      await settled();
      expect(probe).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("radio", { name: "Auto" }));
      expect(localStorage.getItem(CHIP_PREF_KEY)).toBeNull();
      expect(changed).toHaveBeenCalledTimes(1);
      // with the server's switch off the row is not drawn for Auto: it was there only for the Off that could not otherwise be undone
      await waitFor(() => expect(screen.queryByTestId("chip-row")).toBeNull());
    },
  );

  it("drops a test that finishes after the person turned the chip off: nothing is remembered and nothing is reported for the next export", async () => {
    let open!: () => void;
    pc([amd], {}, null, new Promise<void>((resolve) => (open = resolve)));
    render(<ChipRow />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.checking));
    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.off));
    await act(async () => open());
    await waitFor(() => expect(chipCalls()).toHaveLength(4));
    await settled();
    await settled();
    expect(localStorage.getItem("artdaddy.chipTest.v1")).toBeNull();
    expect(takeChipTestEvents()).toEqual([]);
    expect(note()).toHaveTextContent(CHIP_ROW_NOTES.off);
  });

  it("never breaks the dialog: a PC that cannot be asked draws nothing, and a name that cannot be read only costs the hint", async () => {
    pc([amd]);
    vi.mocked(resolveExportResources).mockRejectedValue(new Error("no PC"));
    const { container, unmount } = render(<ChipRow />);
    await settled();
    await settled();
    expect(container).toBeEmptyDOMElement();
    unmount();

    pc([nvidia], {}, null);
    vi.mocked(processorName).mockRejectedValue(new Error("no name"));
    render(<ChipRow />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
    expect(screen.queryByTestId("chip-row-hint")).toBeNull();
  });

  it("tests the chip at the size the picture will be delivered in: 4K for a 4K project", async () => {
    pc([amd]);
    render(<ChipRow workload={{ width: 3840, height: 2160, fps: 30 }} />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
    expect(chipCalls().some(([args]) => args.join(" ").includes("size=3840x2160"))).toBe(true);
  });

  it.each([
    ["4K at 30 frames a second", { width: 3840, height: 2160, fps: 30 }, 30],
    ["4K at 60 frames a second", { width: 3840, height: 2160, fps: 60 }, 60],
    ["1440p at 60 frames a second", { width: 2560, height: 1440, fps: 60 }, 60],
  ])(
    "draws the row for %s and tests the chip at the 4K size, at the rate the picture is delivered in",
    async (_what, workload, rate) => {
      pc([amd]);
      render(<ChipRow workload={workload} />);
      await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
      const tested = chipCalls().map(([args]) => args.join(" "));
      expect(tested.some((line) => line.includes(`size=3840x2160:rate=${rate}`))).toBe(true);
      // The 1080p test came first, as for every larger class, and no test was made at a rate the picture does not have.
      expect(tested.some((line) => line.includes("size=1080x1920:rate=60"))).toBe(true);
      expect(
        tested.some((line) => line.includes(`size=3840x2160:rate=${rate === 30 ? 60 : 30}`)),
      ).toBe(false);
    },
  );

  it.each([
    ["8K", { width: 7680, height: 4320, fps: 30 }],
    ["8K at 60 frames a second", { width: 7680, height: 4320, fps: 60 }],
    ["a picture wider than 3840 pixels", { width: 4096, height: 2304, fps: 30 }],
    ["a picture with more than 3840 by 2160 pixels", { width: 3840, height: 2161, fps: 30 }],
    ["4K at 61 frames a second", { width: 3840, height: 2160, fps: 61 }],
    ["1080p at 120 frames a second", { width: 1920, height: 1080, fps: 120 }],
  ])(
    "draws no row for %s, a picture the chip never serves, and tests nothing; the person's own Off is still drawn",
    async (_what, workload) => {
      pc([amd]);
      const { container, unmount } = render(<ChipRow workload={workload} />);
      await settled();
      await settled();
      expect(container).toBeEmptyDOMElement();
      expect(probe).not.toHaveBeenCalled();
      unmount();
      localStorage.setItem(CHIP_PREF_KEY, "off");
      render(<ChipRow workload={workload} />);
      await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.off));
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it("is drawn for exactly the pictures that have a size class: a walk over sizes and rates, against sizeClassOf itself", async () => {
    pc([amd]);
    const sizes: Array<[number, number]> = [
      [1280, 720],
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
      [4096, 2304],
      [7680, 4320],
    ];
    for (const [width, height] of sizes)
      for (const fps of [30, 60, 61, 120]) {
        const { container, unmount } = render(<ChipRow workload={{ width, height, fps }} />);
        const label = `${width}x${height} at ${fps}`;
        if (sizeClassOf(width, height, fps) !== null) {
          await waitFor(() => expect(note(), label).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
        } else {
          await settled();
          await settled();
          expect(container, label).toBeEmptyDOMElement();
        }
        unmount();
      }
  });

  // The Export dialog draws the old Mode row only where this row is not drawn, so it has to be told, and told the truth: "not drawn" only once the first look has answered.
  it("tells the dialog it is drawn once its first look has found a chip, and not a moment before", async () => {
    pc([amd]);
    let answer!: (resources: Resources) => void;
    const gate = new Promise<Resources>((resolve) => (answer = resolve));
    vi.mocked(resolveExportResources).mockImplementation(() => gate);
    const drawn = vi.fn();
    render(<ChipRow onDrawn={drawn} />);
    await settled();
    await settled();
    expect(drawn).not.toHaveBeenCalled(); // the look is still out: nothing is known, so nothing is said
    await act(async () => answer(resourcesWith([amd])));
    await waitFor(() => expect(drawn).toHaveBeenLastCalledWith(true));
    expect(drawn).not.toHaveBeenCalledWith(false);
  });

  it.each([
    ["a PC with no chip of a known maker", () => pc([])],
    [
      "the server's switch for Quick export off",
      () => {
        pc([amd]);
        __setExportFlag("quick_export", false);
      },
    ],
    [
      "a PC that cannot be asked",
      () => {
        pc([amd]);
        vi.mocked(resolveExportResources).mockRejectedValue(new Error("no PC"));
      },
    ],
  ] as const)("tells the dialog it is not drawn, once it knows, with %s", async (_why, arrange) => {
    arrange();
    const drawn = vi.fn();
    const { container } = render(<ChipRow onDrawn={drawn} />);
    await waitFor(() => expect(drawn).toHaveBeenCalledWith(false));
    expect(drawn).not.toHaveBeenCalledWith(true);
    expect(container).toBeEmptyDOMElement();
  });

  it("tells the dialog when it goes and when it is back: the picture changes to a size the chip does not serve, and back", async () => {
    pc([amd]);
    const drawn = vi.fn();
    const uhd = { width: 3840, height: 2160, fps: 30 };
    const view = render(<ChipRow workload={uhd} onDrawn={drawn} />);
    await waitFor(() => expect(drawn).toHaveBeenLastCalledWith(true));
    view.rerender(<ChipRow workload={{ ...uhd, fps: 61 }} onDrawn={drawn} />);
    await waitFor(() => expect(drawn).toHaveBeenLastCalledWith(false));
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<ChipRow workload={uhd} onDrawn={drawn} />);
    await waitFor(() => expect(drawn).toHaveBeenLastCalledWith(true));
  });
});

describe("the hint about an old NVIDIA driver", () => {
  const nvidiaWith = (driver: string): GraphicsAdapter => ({ ...nvidia, driver });

  it("says what the person's own driver is and what the chip path needs, where the chip failed and the driver is below 610", async () => {
    pc([nvidiaWith(OLD_DRIVER)], { chip: "fail" });
    render(<ChipRow />);
    await waitFor(() => expect(screen.getByTestId("chip-row-hint")).toBeVisible());
    expect(screen.getByTestId("chip-row-hint")).toHaveTextContent(
      "Your NVIDIA graphics driver is 560.94. ArtDaddy's graphics-chip path needs 610 or newer. If a newer driver exists for your card, updating it can make exports faster. If not, ArtDaddy keeps using the processor.",
    );
    expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_not_passed);
  });

  it("says nothing of a driver of 610 or newer that fails (the cause is something else), or of one that passed", async () => {
    pc([nvidiaWith(NEW_DRIVER)], { chip: "fail" });
    const { unmount } = render(<ChipRow />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_not_passed));
    expect(screen.queryByTestId("chip-row-hint")).toBeNull();
    unmount();
    localStorage.clear();
    __resetChipTests();
    pc([nvidiaWith(OLD_DRIVER)]);
    render(<ChipRow />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
    expect(screen.queryByTestId("chip-row-hint")).toBeNull();
  });

  it("is not shown beside Off: a person who turned the chip off is not told how to get it working", async () => {
    pc([nvidiaWith(OLD_DRIVER)], { chip: "fail" });
    const { unmount } = render(<ChipRow />);
    await waitFor(() => expect(screen.getByTestId("chip-row-hint")).toBeVisible());
    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.off));
    expect(screen.queryByTestId("chip-row-hint")).toBeNull();
    unmount();
  });
});

describe("the hint about Intel graphics that may be switched off in the BIOS", () => {
  const intelHint =
    "Your processor has Intel graphics, but ArtDaddy can only see NVIDIA graphics. The Intel graphics may be switched off in your PC's BIOS. If it is switched on, ArtDaddy can test it and use it to make exports faster when it passes.";
  const withName = async (
    name: string | null,
    adapters: GraphicsAdapter[] = [{ ...nvidia, driver: NEW_DRIVER }],
  ) => {
    pc(adapters, {}, name);
    render(<ChipRow />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
    await settled();
  };

  it("is shown for an Intel processor with graphics when the only chip the app sees is another maker's", async () => {
    await withName("Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz");
    expect(screen.getByTestId("chip-row-hint")).toHaveTextContent(intelHint);
  });

  it.each([
    ["a model with no graphics (F)", "12th Gen Intel(R) Core(TM) i5-12400F"],
    ["a model with no graphics (KF)", "13th Gen Intel(R) Core(TM) i7-13700KF"],
    ["a Xeon", "Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz"],
    ["another maker's processor", "AMD Ryzen 7 5800X 8-Core Processor"],
    ["a name that could not be read", null],
  ])("is not shown for %s", async (_what, name) => {
    await withName(name);
    expect(screen.queryByTestId("chip-row-hint")).toBeNull();
  });

  it("is not shown, and the name is not even asked for, when an Intel chip is among the ones the app sees", async () => {
    await withName("Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz", [
      { ...nvidia, driver: NEW_DRIVER },
      intel,
    ]);
    expect(screen.queryByTestId("chip-row-hint")).toBeNull();
    expect(processorName).not.toHaveBeenCalled();
  });
});
