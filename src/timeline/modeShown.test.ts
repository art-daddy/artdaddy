// What an export started from the Export menu says about the Mode row ("mode_shown"): that it was shown only if the dialog had the row on screen when Export was pressed. The dialog leaves the row out where the
// Graphics chip row is drawn (ExportDialog.tsx), and a row nobody saw must not be reported as shown; an export that did not start in the dialog says what it always did.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useExportJob } from "../store/exportJob";
import type { ClientToolContext } from "../tools/context";
import { decideExportEncoder, type ExportEncoderDecision } from "./exportChoice";
import type { ExportOptions } from "./exportOptions";
import { emptyTimeline, type Clip, type Timeline } from "./model";
import { encoderOptions } from "./render";

vi.mock("./exportChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exportChoice")>()),
  decideExportEncoder: vi.fn(),
}));

const clip = (id: string, from: number, to: number): Clip => ({
  id,
  kind: "video",
  media_ref: `${id}.mp4`,
  source_in: 0,
  source_out: to - from,
  timeline_in: from,
  timeline_out: to,
});
/** A two-minute talk at 1080p30. */
const talk: Timeline = (() => {
  const raw = emptyTimeline(1920, 1080, 30);
  raw.tracks = [{ id: "v1", kind: "video", z: 0, clips: [clip("a", 0, 3600)] }];
  return raw;
})();

/** The app's answer when a chip has proven itself and the export is long: it wants the Mode row, started on Fast. */
const wantsRow: ExportEncoderDecision = {
  mode: "fast",
  chip: "amd",
  reason: "over_minute",
  showRow: true,
  defaultMode: "fast",
  fullSeconds: 720,
  fastSeconds: 240,
  fullGuessed: false,
  tests: [],
  facts: { encoder: "amd", chip: "amd", reason: "over_minute", tests: [] },
};

const options: ExportOptions = { resolution: "source", quality: "medium" };
const menu = { surface: "app" } as unknown as ClientToolContext;
const chat = {
  surface: "app",
  origin: { chatSessionId: "chat-1" },
} as unknown as ClientToolContext;
const mcp = { surface: "mcp" } as unknown as ClientToolContext;

const optionsFor = async (ctx: ClientToolContext, decision: ExportEncoderDecision = wantsRow) => {
  vi.mocked(decideExportEncoder).mockResolvedValue(decision);
  return encoderOptions(ctx, { seconds: talk, request: "auto" }, options);
};

beforeEach(() => {
  vi.mocked(decideExportEncoder).mockReset();
  useExportJob.setState({ modeRowOnScreen: null });
});

describe("what an export from the menu says of the Mode row", () => {
  it("says the row was shown, and what it started on, when the dialog had it on screen", async () => {
    useExportJob.getState().setModeRowOnScreen(true);
    expect((await optionsFor(menu)).choice?.shown).toBe("fast");
    expect((await optionsFor(menu, { ...wantsRow, defaultMode: "quality" })).choice?.shown).toBe(
      "full",
    );
  });

  it("says nothing of a row the dialog did not draw (the Graphics chip row was drawn in its place), and still runs the export as the app decided", async () => {
    useExportJob.getState().setModeRowOnScreen(false);
    const out = await optionsFor(menu);
    expect(out.choice?.shown).toBeUndefined();
    // only the claim is withdrawn: what was chosen, and why, is recorded as it was
    expect(out).toMatchObject({
      mode: "fast",
      chip: "amd",
      choice: { encoder: "amd", chip: "amd", reason: "over_minute" },
    });
  });

  it("claims as it always did when the dialog has not said (an export that did not start there)", async () => {
    expect(useExportJob.getState().modeRowOnScreen).toBeNull();
    expect((await optionsFor(menu)).choice?.shown).toBe("fast");
  });

  it.each([
    ["the app's chat", chat],
    ["an outside assistant over MCP", mcp],
  ] as const)("never claims a row for %s, whatever the dialog last showed", async (_who, ctx) => {
    useExportJob.getState().setModeRowOnScreen(true);
    expect((await optionsFor(ctx)).choice?.shown).toBeUndefined();
  });
});
