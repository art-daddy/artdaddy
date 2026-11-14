// The Export dialog's Graphics chip row, drawn from the real chip lookup over a scripted PC and a scripted ffmpeg: its six states, the switch,
// Try it again now, and the two hints. Nothing here starts an export; the only thing that is run is the chip's own short test.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setExportFlag, type ExportFlagName } from "../api/exportFlags";
import { processorName, resolveExportResources, runCapabilityProbe } from "../platform/host";
import { amd, harness, intel, nvidia, type Behaviour } from "../test/chipHarness";
import { CHIP_PREF_KEY } from "../timeline/chipPref";
import { CHIP_ROW_NOTES } from "../timeline/chipRow";
import { __resetChipTests, markChipSuspect } from "../timeline/chipTest";
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

  it("tests the chip at the size the picture will be delivered in: 4K for a 4K project, and 1080p for one outside both classes", async () => {
    pc([amd]);
    render(<ChipRow workload={{ width: 3840, height: 2160, fps: 30 }} />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
    expect(chipCalls().some(([args]) => args.join(" ").includes("size=3840x2160"))).toBe(true);
    cleanup();
    localStorage.clear();
    __resetChipTests();
    pc([amd]);
    render(<ChipRow workload={{ width: 7680, height: 4320, fps: 30 }} />);
    await waitFor(() => expect(note()).toHaveTextContent(CHIP_ROW_NOTES.auto_passed));
    expect(chipCalls().some(([args]) => args.join(" ").includes("size=1080x1920"))).toBe(true);
    expect(chipCalls().some(([args]) => args.join(" ").includes("size=7680"))).toBe(false);
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
