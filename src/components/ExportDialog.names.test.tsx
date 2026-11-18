// The Export dialog's words as drawn, against the names the owner chose: "Quality" and "Fast" for the two choices and "light compression" for the processor's lighter setting. The 0.28.0 dialog (no quickRoute) is the
// contrast: it still draws the older names, so a check that finds none in the new view could have found them. The words guard of the sources is timeline/exportNames.guard.test.ts.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags } from "../api/exportFlags";
import { useExportJob } from "../store/exportJob";
import { retiredIn } from "../test/retiredNames";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { D2_WORDS } from "../timeline/exportChoiceWords";
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

/** Until the new view has a sentence of its own for the lighter setting (the Quality / Fast lane gives it one) it draws the 0.28.0 sentence, which names "a faster setting": the one old name the new view may
 *  draw, and only while its words file still holds that sentence. Once the words file does not, this is null and the screen is held to every name. */
const PENDING_SENTENCE: string | null = (Object.values(D2_WORDS) as readonly string[]).includes(
  FASTER_SETTING_LINE,
)
  ? FASTER_SETTING_LINE
  : null;

/** Everything on the screen as a person reads it, without the one sentence that may still carry an old name. */
const drawn = (): string => {
  const text = document.body.textContent ?? "";
  return PENDING_SENTENCE ? text.split(PENDING_SENTENCE).join("") : text;
};

describe("the 0.28.0 dialog draws the older names, so the checks below can tell", () => {
  it("names Full quality and Fast in its Mode row, with the hint that says quicker, where a chip has passed", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(withRow());
    render(dialog({ quickRoute: false }));
    await screen.findByRole("radio", { name: "Full quality" });
    expect(retiredIn(document.body.textContent ?? "")).toEqual(
      expect.arrayContaining(["Full quality", "quicker"]),
    );
  });

  it("names a faster setting where the app will use the processor's lighter one", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(lighter());
    render(dialog({ quickRoute: false }));
    expect(await screen.findByText(FASTER_SETTING_LINE)).toBeVisible();
    expect(retiredIn(document.body.textContent ?? "")).toContain("faster setting");
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

  it("says light compression, not a faster setting, where the app will use the processor's lighter setting", async () => {
    vi.mocked(decideExportEncoder).mockResolvedValue(lighter());
    const user = userEvent.setup();
    render(dialog());
    await waitFor(() => expect(decideExportEncoder).toHaveBeenCalled());
    await settle();
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect(retiredIn(drawn())).toEqual([]);
    // Said as the owner names it as soon as the view has its own sentence; until then it is the 0.28.0 one, which is exempt above and named here so the hand-over is not forgotten.
    expect(PENDING_SENTENCE !== null || /light compression/.test(drawn())).toBe(true);
  });

  it("draws no older name while an export runs, after it, or after it failed", async () => {
    render(dialog());
    await settle();
    act(() => useExportJob.getState().begin(null));
    act(() => useExportJob.getState().update({ phase: "rendering", fraction: 0.4 }));
    expect(screen.getByTestId("export-status")).toBeInTheDocument();
    expect(retiredIn(drawn())).toEqual([]);
    act(() => useExportJob.getState().finish({ phase: "done", fraction: 1, savedTo: "film.mp4" }));
    expect(screen.getByText(/film\.mp4/)).toBeInTheDocument();
    expect(retiredIn(drawn())).toEqual([]);
    cleanup();
    useExportJob.getState().reset();

    render(dialog());
    await settle();
    act(() => useExportJob.getState().begin(null));
    act(() =>
      useExportJob
        .getState()
        .finish({ phase: "failed", error: "the encoder said no clips to render" }),
    );
    expect(screen.getByTestId("export-error")).toBeInTheDocument();
    expect(retiredIn(drawn())).toEqual([]);
  });
});
