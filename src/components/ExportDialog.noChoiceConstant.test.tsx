// The one constant that offers the choice, `FAST_CHOICE_OFFERED`, is what the real dialog reads: with it false the dialog the menu bar hands `quickRoute` to is the Quality-only dialog. No test of the
// real dialog read the constant before this one (the view's tests pass `fastChoice` as a prop), so a view that stopped reading it, or a dialog that drew the row whatever it says, was green. This file
// pins the constant to false for the whole file and holds what a person sees and what Export hands over. The other files of the dialog pin it to true, so flipping it needs no test edit but this
// file's expectations. What differs from the dialog before Fast is one sentence (decision D8): the line behind the door for the lighter setting says "light compression".
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags } from "../api/exportFlags";
import { useExportJob } from "../store/exportJob";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import type { RenderWorkload } from "../timeline/renderPlan";
import type { ExportSettings } from "./ExportDialog";
import ExportDialog from "./ExportDialog";

vi.mock("../timeline/exportChoiceView", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoiceView")>()),
  FAST_CHOICE_OFFERED: false,
}));
vi.mock("../timeline/exportChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoice")>()),
  decideExportEncoder: vi.fn(),
}));

/** A project at 72 fps: Fast's own rate would be 18, which a dialog without Fast must not list. */
const PROJECT: RenderWorkload = {
  width: 1920,
  height: 1080,
  fps: 72,
  durationSeconds: 120,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
};

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

const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
const door = () => screen.getByRole("button", { name: "Advanced settings" });
const rateBox = () => screen.getByLabelText("frame rate");
const noop = () => undefined;
const mount = (onStart: (settings: ExportSettings) => void = noop) =>
  render(<ExportDialog open onCancel={noop} onStart={onStart} workload={PROJECT} quickRoute />);

describe("the real dialog with FAST_CHOICE_OFFERED false", () => {
  it("draws no choice row and no line under the door, though the dialog was handed quickRoute; the rest of the dialog is there once", async () => {
    mount();
    await settle();
    expect(screen.queryByRole("radiogroup", { name: "export choice" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Fast" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Quality" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "export video" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "resolution" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Export" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    fireEvent.click(door());
    expect(screen.queryByText(/Project size and frame rate/)).toBeNull();
    expect(screen.queryByText(/One size smaller/)).toBeNull();
    expect(screen.queryByText(/Medium quality\./)).toBeNull();
    expect(screen.getByLabelText("quality")).toHaveDisplayValue("Medium");
  });

  it("lists the ladder rates alone: 72 fps has no 18 fps, which only a dialog that offers Fast adds", async () => {
    mount();
    await settle();
    const rates = within(rateBox())
      .getAllByRole("option", { hidden: true })
      .map((option) => option.textContent);
    expect(rates).toEqual([
      "Same as project (72 fps)",
      "60 fps",
      "50 fps",
      "30 fps",
      "25 fps",
      "24 fps",
    ]);
  });

  it("hands over Quality's object, key for key, whatever is picked, and no route", async () => {
    const onStart = vi.fn<(settings: ExportSettings) => void>();
    mount(onStart);
    await settle();
    fireEvent.change(screen.getByRole("combobox", { name: "resolution" }), {
      target: { value: "720p" },
    });
    fireEvent.click(door());
    fireEvent.change(screen.getByLabelText("quality"), { target: { value: "high" } });
    fireEvent.change(rateBox(), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    const sent = onStart.mock.calls[0][0];
    expect(sent).toMatchObject({ resolution: "720p", quality: "high", fps: 24 });
    expect(Object.keys(sent).sort()).toEqual(["fps", "mode", "quality", "resolution"]);
  });

  it("keeps the one sentence that differs from the dialog before Fast: the lighter setting is called light compression (decision D8)", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(decision({ faster: true }));
    mount();
    await settle();
    fireEvent.click(door());
    expect(
      screen.getByText(
        "To save time, ArtDaddy will use light compression; the picture may be slightly softer.",
      ),
    ).toBeVisible();
  });
});
