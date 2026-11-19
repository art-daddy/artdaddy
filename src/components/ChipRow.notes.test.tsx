// The `notes` prop of the Graphics chip row: the Export dialog's Quality / Fast view draws its own sentence for the state where the chip passed its test, while the 0.28.0-style dialog (which passes no
// `notes`) draws the row's own words. Drawn from the real chip lookup over a scripted PC and a scripted ffmpeg, with the same boundary mocked as ChipRow.test.tsx. The words are written out here, never read
// from the row's own table, so a change to them is a change this file sees. Four of the five notes are 0.28.0's; the note for a chip that passed changed on purpose (the chip is used whenever it passed), and
// the last block holds it against the sentence 0.28.0 drew.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setExportFlag, type ExportFlagName } from "../api/exportFlags";
import {
  processorName,
  resolveExportResources,
  runCapabilityProbe,
  type GraphicsAdapter,
} from "../platform/host";
import { amd, harness, nvidia, type Behaviour } from "../test/chipHarness";
import { CHIP_PREF_KEY } from "../timeline/chipPref";
import { __resetChipTests, markChipSuspect } from "../timeline/chipTest";
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

/** The four notes of 0.28.0 that the row still draws, word for word ("\u2026" is the ellipsis of the first one). */
const NOTES_0280 = {
  checking: "Checking this PC's graphics chip\u2026",
  auto_not_passed:
    "Auto: not used. The graphics chip did not pass ArtDaddy's test on this PC, so exports use the processor.",
  set_aside:
    "The graphics chip stopped an export on this PC, so it is set aside for a day. Try it again now",
  off: "Off: the graphics chip is not tested, offered or used on this PC. Everything runs on the processor.",
} as const;
const LINK = "Try it again now";
/** The note for a chip that passed, as the row draws it now: the chip is used whenever it passed. */
const PASSED_NOTE =
  "Auto: used on this PC. The file is usually larger and the picture can differ slightly. It passed ArtDaddy's test on this PC.";
/** The note for a chip that passed in 0.28.0, the previous release, word for word. Written out so that the row is held against what it used to say, never against its own table. */
const PASSED_NOTE_0280 =
  "Auto: used for long exports where it saves time. When it is used, the file is usually larger and the picture can differ slightly. It passed ArtDaddy's test on this PC.";

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
});
afterEach(() => {
  cleanup();
  for (const flag of FLAGS) __setExportFlag(flag, true);
});

const note = () => screen.getByTestId("chip-row-note");
const settled = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
/** The note once the row has left "checking": the first look is over and the row says what it found. */
const answered = async () => {
  await waitFor(() => expect(note().textContent).not.toBe(NOTES_0280.checking));
  return note();
};
/** Opens the chip test that a case holds back; run after every case so none is left waiting. */
let release: (() => void) | null = null;
afterEach(() => {
  release?.();
  release = null;
});

describe("the chip row's notes prop", () => {
  it("shows exactly the given words for a chip that passed its test", async () => {
    pc([amd]);
    render(<ChipRow notes={{ auto_passed: "X" }} />);
    expect((await answered()).textContent).toBe("X");
    expect(screen.getByRole("radio", { name: "Auto" })).toBeChecked();
  });

  // Only the passed state is named, so the other four are the row's own: a rule over every state, not over the one the owner's sentence is for.
  it.each([
    [
      "checking",
      async () => {
        pc([amd], {}, new Promise<void>((resolve) => (release = resolve)));
        render(<ChipRow notes={{ auto_passed: "X" }} />);
        await waitFor(() => expect(note().textContent).toBe(NOTES_0280.checking));
      },
    ],
    [
      "auto_not_passed",
      async () => {
        pc([amd], { chip: "fail" });
        render(<ChipRow notes={{ auto_passed: "X" }} />);
        await answered();
      },
    ],
    [
      "set_aside",
      async () => {
        pc([amd]);
        const first = render(<ChipRow notes={{ auto_passed: "X" }} />);
        await answered();
        first.unmount();
        markChipSuspect(amd);
        render(<ChipRow notes={{ auto_passed: "X" }} />);
        await waitFor(() => expect(note().textContent).toBe(NOTES_0280.set_aside));
      },
    ],
    [
      "off",
      async () => {
        pc([amd]);
        localStorage.setItem(CHIP_PREF_KEY, "off");
        render(<ChipRow notes={{ auto_passed: "X" }} />);
        await answered();
      },
    ],
  ] as const)(
    "keeps 0.28.0's words for the state %s when only the passed state is given",
    async (state, arrange) => {
      await arrange();
      expect(note().textContent).toBe(NOTES_0280[state]);
    },
  );

  it("does not carry the words of one state over to another: Off is named, and Auto then passes with the row's own words", async () => {
    pc([amd]);
    localStorage.setItem(CHIP_PREF_KEY, "off");
    render(<ChipRow notes={{ off: "Own off words" }} />);
    await waitFor(() => expect(note().textContent).toBe("Own off words"));
    fireEvent.click(screen.getByRole("radio", { name: "Auto" }));
    await waitFor(() => expect(note().textContent).toBe(PASSED_NOTE));
    expect(localStorage.getItem(CHIP_PREF_KEY)).toBeNull();
  });

  it.each([
    ["no prop", undefined],
    ["an empty prop", {}],
  ] as const)("is the row's own, word for word, with %s", async (_what, notes) => {
    pc([amd]);
    render(<ChipRow notes={notes} />);
    expect((await answered()).textContent).toBe(PASSED_NOTE);
    expect(screen.getByRole("radio", { name: "Auto" })).toBeChecked();
  });

  describe("the link that lifts a chip that was set aside", () => {
    const setAside = async (notes: Parameters<typeof ChipRow>[0]["notes"], onChange = vi.fn()) => {
      pc([amd]);
      const first = render(<ChipRow notes={notes} />);
      await answered();
      first.unmount();
      markChipSuspect(amd);
      render(<ChipRow notes={notes} onChange={onChange} />);
      await waitFor(() => expect(screen.queryByTestId("chip-row")).not.toBeNull());
      await waitFor(() => expect(note().textContent).not.toBe(NOTES_0280.checking));
      return onChange;
    };

    it("is still drawn for words of its own that end with it, and works", async () => {
      const own = `Own words for a chip that was set aside. ${LINK}`;
      const changed = await setAside({ auto_passed: "Passed words", set_aside: own });
      expect(note().textContent).toBe(own);
      const link = within(note()).getByRole("button", { name: LINK });
      expect(link).toHaveTextContent(LINK);
      fireEvent.click(link);
      await waitFor(() => expect(note().textContent).toBe("Passed words"));
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it("is not drawn for words of its own that do not end with it, even when they hold it", async () => {
      const own = `${LINK} will not help for a day.`;
      await setAside({ set_aside: own });
      expect(note().textContent).toBe(own);
      expect(within(note()).queryByRole("button")).toBeNull();
    });

    it("is not drawn beside words of another state that end with it: it is the set-aside state's alone", async () => {
      pc([amd]);
      render(<ChipRow notes={{ auto_passed: `Passed. ${LINK}` }} />);
      expect((await answered()).textContent).toBe(`Passed. ${LINK}`);
      expect(within(note()).queryByRole("button")).toBeNull();
    });

    it("is drawn for 0.28.0's own words when none are given, as before", async () => {
      await setAside(undefined);
      expect(note().textContent).toBe(NOTES_0280.set_aside);
      expect(within(note()).getByRole("button", { name: LINK })).toBeVisible();
    });
  });

  it("changes nothing but the words: the hint under the note, and the row itself, stay as they are", async () => {
    pc([{ ...nvidia, driver: "32.0.15.6094" }], { chip: "fail" });
    render(<ChipRow notes={{ auto_not_passed: "Y" }} />);
    await waitFor(() => expect(note().textContent).toBe("Y"));
    expect(screen.getByTestId("chip-row-hint")).toHaveTextContent(
      "Your NVIDIA graphics driver is 560.94. ArtDaddy's graphics-chip path needs 610 or newer. If a newer driver exists for your card, updating it can make exports faster. If not, ArtDaddy keeps using the processor.",
    );
    expect(screen.getByRole("radiogroup", { name: "Graphics chip" })).toBeVisible();
  });

  it("draws no row where the row is not drawn, and says so, whatever the words given", async () => {
    pc([]);
    const drawn = vi.fn();
    const { container } = render(
      <ChipRow
        onDrawn={drawn}
        notes={{
          checking: "A",
          auto_passed: "B",
          auto_not_passed: "C",
          set_aside: "D",
          off: "E",
        }}
      />,
    );
    await waitFor(() => expect(drawn).toHaveBeenCalledWith(false));
    await settled();
    expect(drawn).not.toHaveBeenCalledWith(true);
    expect(container).toBeEmptyDOMElement();
  });
});

// The chip is used whenever it passed its test for the picture's size. The row's note for that state said, in 0.28.0, that the chip is used for long exports where it saves time, which the export no longer does,
// and a person reads it before the start. The two artifacts compared: the note the real row draws now, and the sentence 0.28.0 drew (written out above, not read from the row's table).
describe("the chip row's note for a chip that passed, now and in 0.28.0", () => {
  const drawn = async (notes?: Parameters<typeof ChipRow>[0]["notes"]): Promise<string> => {
    pc([amd]);
    render(<ChipRow notes={notes} />);
    return (await answered()).textContent ?? "";
  };
  const THIRD = " It passed ArtDaddy's test on this PC.";

  it("is not the sentence 0.28.0 drew, and no word of that sentence's claim is left", async () => {
    const after = await drawn();
    expect(after).not.toBe(PASSED_NOTE_0280);
    // What the old sentence claimed: the chip is used for a kind of export (long ones), where it saves time. The new one names no kind of export, no saving and no condition.
    expect(PASSED_NOTE_0280).toMatch(/long exports where it saves time/);
    expect(after).not.toMatch(/long|exports|saves?|saving|time|minute|when|where/i);
  });

  it("says the chip is used on this PC, keeps what it costs, and keeps the sentence about the test", async () => {
    const after = await drawn();
    expect(after).toMatch(/^Auto: used on this PC\./);
    expect(after).toContain("The file is usually larger and the picture can differ slightly.");
    expect(after.endsWith(THIRD)).toBe(true);
    // the third sentence is the one 0.28.0 already had: kept, not rewritten
    expect(PASSED_NOTE_0280.endsWith(THIRD)).toBe(true);
    // one note, three sentences, nothing else
    expect(after.split(/(?<=\.) /)).toHaveLength(3);
  });
});
