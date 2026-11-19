// The Export dialog's words as drawn, against the names the owner chose: "Quality" and "Fast" for the two choices and "light compression" for the processor's lighter setting. The 0.28.0 dialog (no quickRoute) is the
// contrast: it still draws the older names, so a check that finds none in the new view could have found them. The new view is looked at in every state it has: Quality and Fast, the door closed and open, whatever the
// app says about the encoder, and while an export runs. The words guard of the sources is timeline/exportNames.guard.test.ts.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests are about the Quality | Fast row, so they hold the choice offered whatever the constant says (the real dialog without it is held by ExportDialog.noChoiceConstant.test.tsx).
vi.mock("../timeline/exportChoiceView", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoiceView")>()),
  FAST_CHOICE_OFFERED: true,
}));

import { __resetExportFlags } from "../api/exportFlags";
import { useExportJob } from "../store/exportJob";
import { retiredIn } from "../test/retiredNames";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { FASTER_SETTING_LINE } from "../timeline/exportWords";
import type { RenderWorkload } from "../timeline/renderPlan";
import ExportDialog from "./ExportDialog";

vi.mock("../timeline/exportChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoice")>()),
  decideExportEncoder: vi.fn(),
}));

const PROJECT: RenderWorkload = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 120,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
};

/** What the app decided about the encoder, as the dialog is told: no chip, so no Mode row, unless a case says otherwise. */
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
/** A chip that has proven itself and an export long enough to select it: the 0.28.0 dialog draws its Mode row, the hint and the amber note. */
const withRow = (): ExportEncoderDecision =>
  decision({
    showRow: true,
    defaultMode: "fast",
    reason: "over_minute",
    fullSeconds: 720,
    fastSeconds: 240,
    facts: { encoder: "x264", chip: "amd", reason: "none", tests: [] },
  });
/** No chip, an export far over the promise: the app will use the processor's lighter setting and says so. */
const lighter = (): ExportEncoderDecision =>
  decision({ faster: true, reason: "promise_line", fullSeconds: 900 });

beforeEach(() => {
  __resetExportFlags();
  useExportJob.getState().reset();
  useExportJob.getState().setEngine("auto");
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockResolvedValue(decision());
});
afterEach(() => {
  cleanup();
  useExportJob.getState().reset();
});

type Props = Partial<ComponentProps<typeof ExportDialog>>;
const dialog = (props: Props = {}) => (
  <ExportDialog
    open
    onCancel={() => undefined}
    onStart={() => undefined}
    workload={PROJECT}
    quickRoute
    {...props}
  />
);
const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

/** Everything on the screen as a person reads it, the closed door's region included (so a name behind the door is found too): the page's text as one string, then the text of every element on a line of its
 *  own, because a name that opens an element ("Export video" then "Quick export") has no word boundary in front of it once the page's text is run together. */
const drawn = (): string =>
  [
    document.body.textContent ?? "",
    ...Array.from(document.body.querySelectorAll("*"), (element) => element.textContent ?? ""),
  ].join("\n");
/** The owner's sentence for the processor's lighter setting, written out here. */
const LIGHT_COMPRESSION = "To save time, ArtDaddy will use light compression.";
const door = () => screen.getByRole("button", { name: "Advanced settings" });
const fastRadio = () => screen.getByRole("radio", { name: "Fast" });
const qualityRadio = () => screen.getByRole("radio", { name: "Quality" });

describe("the 0.28.0 dialog draws the older names, so the checks below can tell", () => {
  it("names Full quality and Fast in its Mode row, with the hint that says quicker, where a chip has passed", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(withRow());
    render(dialog({ quickRoute: false }));
    await screen.findByRole("radio", { name: "Full quality" });
    expect(retiredIn(drawn())).toEqual(expect.arrayContaining(["Full quality", "quicker"]));
  });

  it("names a faster setting where the app will use the processor's lighter one", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(lighter());
    render(dialog({ quickRoute: false }));
    expect(await screen.findByText(FASTER_SETTING_LINE)).toBeVisible();
    expect(retiredIn(drawn())).toContain("faster setting");
  });
});

describe("the new view reads none of the older names", () => {
  it("draws none of the Mode row's words for the decision that makes the 0.28.0 dialog draw them", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(withRow());
    const user = userEvent.setup();
    render(dialog());
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await settle();
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect(screen.queryByRole("radio", { name: "Full quality" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "export mode" })).toBeNull();
    expect(screen.queryByText(/is selected because/)).toBeNull();
    // The door is open and the dialog has answered: what is on screen has been looked at, and carries no older name at all.
    expect(screen.getByLabelText("quality")).toBeInTheDocument();
    expect(retiredIn(drawn())).toEqual([]);
  });

  it("says light compression, in the owner's words, and not a faster setting, where the app will use the processor's lighter setting", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(lighter());
    const user = userEvent.setup();
    render(dialog());
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await settle();
    await user.click(door());
    expect(screen.getByText(LIGHT_COMPRESSION)).toBeVisible();
    expect(drawn()).not.toContain(FASTER_SETTING_LINE);
    expect(retiredIn(drawn())).toEqual([]);
  });

  it("says nothing of light compression with Fast picked, and says it again when Quality is picked back: the sentence is Quality's alone", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(lighter());
    const user = userEvent.setup();
    render(dialog());
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await settle();
    await user.click(door());
    expect(screen.getByText(LIGHT_COMPRESSION)).toBeInTheDocument();

    await user.click(fastRadio());
    await settle();
    expect(fastRadio()).toBeChecked(); // else this case says nothing about Fast
    expect(screen.queryByText(LIGHT_COMPRESSION)).toBeNull();
    expect(drawn()).not.toMatch(/light compression|softer/i);
    expect(retiredIn(drawn())).toEqual([]);

    await user.click(qualityRadio());
    await settle();
    expect(qualityRadio()).toBeChecked();
    expect(screen.getByText(LIGHT_COMPRESSION)).toBeInTheDocument();
  });

  it.each([
    { name: "the app's answer wants the Mode row", decide: withRow },
    { name: "the app will use the lighter setting", decide: lighter },
    { name: "the app has nothing to say", decide: decision },
  ])(
    "draws no older name in any state of the view, Fast picked and the door open included: $name",
    async ({ decide }) => {
      vi.mocked(decideExportEncoder).mockResolvedValue(decide());
      const user = userEvent.setup();
      render(dialog());
      await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
      await settle();
      const states: { name: string; enter: () => Promise<void>; holds: () => void }[] = [
        {
          name: "Quality, the door closed",
          enter: async () => undefined,
          holds: () => {
            expect(qualityRadio()).toBeChecked();
            expect(door()).toHaveAttribute("aria-expanded", "false");
          },
        },
        {
          name: "Quality, the door open",
          enter: () => user.click(door()),
          holds: () => expect(door()).toHaveAttribute("aria-expanded", "true"),
        },
        {
          name: "Fast, the door open",
          enter: () => user.click(fastRadio()),
          holds: () => {
            expect(fastRadio()).toBeChecked();
            expect(door()).toHaveAttribute("aria-expanded", "true");
            expect(drawn()).toContain("One size smaller, Medium quality."); // Fast's own line is on the page
          },
        },
        {
          name: "Fast, the door closed",
          enter: () => user.click(door()),
          holds: () => {
            expect(fastRadio()).toBeChecked();
            expect(door()).toHaveAttribute("aria-expanded", "false");
          },
        },
        {
          name: "Quality picked back, the door closed",
          enter: () => user.click(qualityRadio()),
          holds: () => expect(qualityRadio()).toBeChecked(),
        },
      ];
      for (const { name, enter, holds } of states) {
        await enter();
        await settle();
        holds();
        expect(retiredIn(drawn()), name).toEqual([]);
        expect(screen.queryByRole("radiogroup", { name: "export mode" }), name).toBeNull();
        expect(screen.queryByRole("radio", { name: "Full quality" }), name).toBeNull();
      }
    },
  );

  it.each([
    { name: "Quality", fast: false },
    { name: "Fast", fast: true },
  ])(
    "draws no older name while an export runs, after it, or after it failed, with $name picked",
    async ({ fast }) => {
      const user = userEvent.setup();
      render(dialog());
      await settle();
      if (fast) await user.click(fastRadio());
      act(() => useExportJob.getState().begin(null));
      act(() => useExportJob.getState().update({ phase: "rendering", fraction: 0.4 }));
      expect(screen.getByTestId("export-status")).toBeInTheDocument();
      expect(retiredIn(drawn())).toEqual([]);
      act(() =>
        useExportJob.getState().finish({ phase: "done", fraction: 1, savedTo: "film.mp4" }),
      );
      expect(screen.getByText(/film\.mp4/)).toBeInTheDocument();
      expect(retiredIn(drawn())).toEqual([]);
      cleanup();
      useExportJob.getState().reset();

      render(dialog());
      await settle();
      if (fast) await user.click(fastRadio());
      act(() => useExportJob.getState().begin(null));
      act(() =>
        useExportJob
          .getState()
          .finish({ phase: "failed", error: "the encoder said no clips to render" }),
      );
      expect(screen.getByTestId("export-error")).toBeInTheDocument();
      expect(retiredIn(drawn())).toEqual([]);
    },
  );
});
