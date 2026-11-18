// What the NEW Export dialog hands over for a Fast pick, pushed through the real `export` tool, against the same settings typed by hand. Two layers, each comparing two artifacts:
//  (A) the real ExportSettingsView driven with userEvent (pick Fast, pick a Resolution, a Frame rate, a Quality, press Export): the object it hands to onStart is turned into the tool call the
//      menu bar makes (callOf) and the real tool runs it on a fresh project of that canvas, with the dialog's route slot;
//  (B) the twin of each case, typed by hand from the owner's table: the same tool, the settings as a person types them, no slot, and the encoder asked for the way a typed export asks for it.
// The two artifacts are what the app process was handed for each (`submitted[i].args` and `steps`, and the plan's output) and the export's record. Every expected picture, rate and crf is written
// out from the owner's table below (never computed with the code under test). Nothing runs ffmpeg, reaches a vendor or uses the network.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests are about the Quality | Fast row, so they hold the choice offered whatever the constant says (the real dialog without it is held by ExportDialog.noChoiceConstant.test.tsx).
vi.mock("./exportChoiceView", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exportChoiceView")>()),
  FAST_CHOICE_OFFERED: true,
}));

import ExportSettingsView from "../components/ExportSettingsView";
import type { ExportSettings } from "../components/ExportDialog";
import { processorName, resolveExportResources, runCapabilityProbe } from "../platform/host";
import { useEditor } from "../store/editor";
import { amd, harness } from "../test/chipHarness";
import {
  after,
  callOf,
  CRF,
  commandOf,
  keysOf,
  observe,
  outputOf,
  pic,
  recordOf,
  resetAfter,
  resetBefore,
  scrub,
  textOf,
  withoutPreset,
  world,
  type Any,
  type Canvas,
  type Picture,
} from "../test/fastDialogKit";
import { registerLibraryClip } from "../tools/import";
import { __resetChipTests } from "./chipTest";
import * as exportAsk from "./exportAsk";
import type { ExportEngine } from "./exportOptions";
import { emptyTimeline } from "./model";
import { addClipsTool } from "./placement";
import type { RenderWorkload } from "./renderPlan";

// What the queue sends the server for each settled export is dropped here; it is never sent.
vi.mock("../api/exportEvents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/exportEvents")>()),
  reportExport: async () => undefined,
}));
// The graphics chip's lookup is the test's to answer: no chip unless a test says so.
vi.mock("./chipTest", async (importOriginal) => {
  const real = await importOriginal<typeof import("./chipTest")>();
  return {
    ...real,
    findChip: vi.fn(async () => ({ chip: null, events: [] })),
    markChipSuspect: vi.fn(),
  };
});
// No brand asset is fetched: the exports here are the unbranded ones.
vi.mock("./brandRecovery", () => ({ recoverBrandAsset: async () => null }));
// The PC the Graphics chip row of the dialog asks (the tool does not read it): nothing to say.
vi.mock("../platform/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/host")>()),
  runCapabilityProbe: vi.fn(),
  resolveExportResources: vi.fn(),
  processorName: vi.fn(),
}));

function pcWithNoChip() {
  const scripted = harness([] as (typeof amd)[]);
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
    adapters: [],
  });
  vi.mocked(processorName).mockReset();
  vi.mocked(processorName).mockResolvedValue(null);
}

beforeEach(() => {
  resetBefore();
  localStorage.clear();
  __resetChipTests();
  useEditor.setState({ timeline: null });
  pcWithNoChip();
});
afterEach(async () => {
  cleanup();
  exportAsk.__resetExportAsk();
  useEditor.setState({ timeline: null });
  await resetAfter();
});

const UHD60: Canvas = { w: 3840, h: 2160, fps: 60 };
const HD30: Canvas = { w: 1920, h: 1080, fps: 30 };
const HD24: Canvas = { w: 1920, h: 1080, fps: 24 };
const VERTICAL30: Canvas = { w: 1080, h: 1920, fps: 30 };
const SD24: Canvas = { w: 854, h: 480, fps: 24 };
const WXGA30: Canvas = { w: 1366, h: 768, fps: 30 };
const QHD50: Canvas = { w: 2560, h: 1440, fps: 50 };
const ENGINES: readonly ExportEngine[] = ["file-sequence-v1", "partition-pipes-v1"];
/** Both engines on two canvases, the first engine on the others. */
const enginesFor = (canvas: Canvas): readonly ExportEngine[] =>
  canvas === UHD60 || canvas === VERTICAL30 ? ENGINES : ENGINES.slice(0, 1);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The dialog, driven the way a person drives it.

const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
const setCanvas = (canvas: Canvas) =>
  useEditor.setState({
    timeline: {
      ...emptyTimeline(),
      canvas: { width: canvas.w, height: canvas.h, fps: canvas.fps },
    },
  });
/** What the dialog snapshotted when it opened. */
const workloadOf = (canvas: Canvas): RenderWorkload => ({
  width: canvas.w,
  height: canvas.h,
  fps: canvas.fps,
  durationSeconds: 120,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
});

type User = ReturnType<typeof userEvent.setup>;
/** One pick, by the words of the entry the person sees: `fast` / `quality` (the choice row), `size:<entry>`, `rate:<entry>` and `q:<entry>` (the last two are behind the door). */
async function pick(user: User, what: string): Promise<void> {
  const [kind, ...rest] = what.split(":");
  const entry = rest.join(":");
  if (kind === "fast" || kind === "quality") {
    await user.click(screen.getByRole("radio", { name: kind === "fast" ? "Fast" : "Quality" }));
    return;
  }
  if (kind === "size") {
    await user.selectOptions(screen.getByRole("combobox", { name: "resolution" }), entry);
    return;
  }
  const door = screen.getByRole("button", { name: "Advanced settings" });
  if (door.getAttribute("aria-expanded") !== "true") await user.click(door);
  const box = screen.getByRole("combobox", { name: kind === "rate" ? "frame rate" : "quality" });
  await user.selectOptions(box, entry);
}

/** Open the real settings view on a project of this canvas (with the dialog's workload, or without it: the dialog has no project figures to hand over), make the picks, press Export, and return the
 *  object handed to onStart. `between` runs after the picks and right before the click, in the same turn (the project changing under the open dialog: the view has not drawn again yet, and the click
 *  works the project out as it is at that moment). */
async function dialogGives(
  canvas: Canvas,
  picks: readonly string[],
  options: { between?: () => void; workload?: boolean } = {},
): Promise<ExportSettings> {
  setCanvas(canvas);
  const onStart = vi.fn<(settings: ExportSettings) => void>();
  const user = userEvent.setup();
  const view = render(
    <ExportSettingsView
      workload={options.workload === false ? null : workloadOf(canvas)}
      onCancel={() => undefined}
      onStart={onStart}
    />,
  );
  await settle();
  for (const what of picks) await pick(user, what);
  await settle();
  const button = screen.getByRole("button", { name: "Export" });
  if (options.between) {
    options.between();
    fireEvent.click(button);
  } else await user.click(button);
  expect(onStart).toHaveBeenCalledTimes(1);
  const sent = onStart.mock.calls[0][0];
  view.unmount();
  useEditor.setState({ timeline: null });
  // The slots are frozen: a tool that wrote into the dialog's slot would throw.
  if (sent.route) {
    Object.freeze(sent.route.explicit);
    Object.freeze(sent.route);
  }
  return sent;
}

type Flags = { size: boolean; fps: boolean; quality: boolean };
/** Which of the size (s), the rate (f) and the quality (q) the person set. */
const flagsOf = (set: string): Flags => ({
  size: set.includes("s"),
  fps: set.includes("f"),
  quality: set.includes("q"),
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The owner's table, one row per pick: what the person does, which of the three they set, the settings typed by hand for the picture it makes (size, rate, quality) and the picture
// it makes (width, height, rate). A row whose `set` is null is Quality: the project's own picture and no route.
type Row = {
  name: string;
  canvas: Canvas;
  picks: string[];
  set: string | null;
  typed: [string, number, string];
  want: Picture;
};
const row = (
  name: string,
  canvas: Canvas,
  picks: string[],
  set: string,
  typed: [string, number, string],
  want: Picture,
): Row => ({ name: `${canvasName(canvas)}: ${name}`, canvas, picks, set, typed, want });
const canvasName = (c: Canvas) => `${c.w}x${c.h}@${c.fps}`;
const SAME = (c: Canvas) => `size:Same as project (${c.w} x ${c.h})`;
const SAME_RATE = (c: Canvas) => `rate:Same as project (${c.fps} fps)`;
/** Fast then Quality again: no route, the project's own picture at Medium. */
const backToQuality = (canvas: Canvas, picks: string[] = []): Row => ({
  name: `${canvasName(canvas)}: ${picks.length ? "picks, then" : "Fast, then"} Quality again`,
  canvas,
  picks: ["fast", ...picks, "quality"],
  set: null,
  typed: ["source", canvas.fps, "medium"],
  want: pic(canvas.w, canvas.h, canvas.fps),
});

const ROWS: Row[] = [
  // 3840x2160 at 60: Fast is 1080p at 30. Rates listed below 60: 50, 30, 25, 24. Sizes: 1440p, 1080p, 720p, 480p.
  row("nothing set", UHD60, ["fast"], "", ["1080p", 30, "medium"], pic(1920, 1080, 30)),
  row(
    "size Same",
    UHD60,
    ["fast", SAME(UHD60)],
    "s",
    ["source", 30, "medium"],
    pic(3840, 2160, 30),
  ),
  row("size 720p", UHD60, ["fast", "size:720p"], "s", ["720p", 30, "medium"], pic(1280, 720, 30)),
  row(
    "rate Same",
    UHD60,
    ["fast", SAME_RATE(UHD60)],
    "f",
    ["1080p", 60, "medium"],
    pic(1920, 1080, 60),
  ),
  row("rate 24", UHD60, ["fast", "rate:24 fps"], "f", ["1080p", 24, "medium"], pic(1920, 1080, 24)),
  row("quality High", UHD60, ["fast", "q:High"], "q", ["1080p", 30, "high"], pic(1920, 1080, 30)),
  row("quality Low", UHD60, ["fast", "q:Low"], "q", ["1080p", 30, "low"], pic(1920, 1080, 30)),
  row(
    "all three: 1440p, 24, High",
    UHD60,
    ["fast", "size:1440p", "rate:24 fps", "q:High"],
    "sfq",
    ["1440p", 24, "high"],
    pic(2560, 1440, 24),
  ),
  backToQuality(UHD60),
  backToQuality(UHD60, ["size:720p", "rate:24 fps", "q:Low"]),
  // 1920x1080 at 30: Fast is 720p at 30. Rates listed below 30: 25, 24. Sizes: 720p, 480p.
  row("nothing set", HD30, ["fast"], "", ["720p", 30, "medium"], pic(1280, 720, 30)),
  row("size Same", HD30, ["fast", SAME(HD30)], "s", ["source", 30, "medium"], pic(1920, 1080, 30)),
  row("size 480p", HD30, ["fast", "size:480p"], "s", ["480p", 30, "medium"], pic(854, 480, 30)),
  row(
    "rate Same",
    HD30,
    ["fast", SAME_RATE(HD30)],
    "f",
    ["720p", 30, "medium"],
    pic(1280, 720, 30),
  ),
  row("rate 24", HD30, ["fast", "rate:24 fps"], "f", ["720p", 24, "medium"], pic(1280, 720, 24)),
  row("quality High", HD30, ["fast", "q:High"], "q", ["720p", 30, "high"], pic(1280, 720, 30)),
  row("quality Low", HD30, ["fast", "q:Low"], "q", ["720p", 30, "low"], pic(1280, 720, 30)),
  row(
    "all three: 480p, 24, Low",
    HD30,
    ["fast", "size:480p", "rate:24 fps", "q:Low"],
    "sfq",
    ["480p", 24, "low"],
    pic(854, 480, 24),
  ),
  backToQuality(HD30),
  // 1920x1080 at 24: Fast is 720p at 24. No lower rate is listed, so there is no Frame rate to pick.
  row("nothing set", HD24, ["fast"], "", ["720p", 24, "medium"], pic(1280, 720, 24)),
  row("size Same", HD24, ["fast", SAME(HD24)], "s", ["source", 24, "medium"], pic(1920, 1080, 24)),
  row("size 480p", HD24, ["fast", "size:480p"], "s", ["480p", 24, "medium"], pic(854, 480, 24)),
  row("quality High", HD24, ["fast", "q:High"], "q", ["720p", 24, "high"], pic(1280, 720, 24)),
  row("quality Low", HD24, ["fast", "q:Low"], "q", ["720p", 24, "low"], pic(1280, 720, 24)),
  row(
    "size 480p and quality Low",
    HD24,
    ["fast", "size:480p", "q:Low"],
    "sq",
    ["480p", 24, "low"],
    pic(854, 480, 24),
  ),
  backToQuality(HD24),
  // 1080x1920 at 30, vertical: Fast is 720p at 30. Sizes: 720p, 480p. Rates: 25, 24.
  row("nothing set", VERTICAL30, ["fast"], "", ["720p", 30, "medium"], pic(720, 1280, 30)),
  row(
    "size Same",
    VERTICAL30,
    ["fast", SAME(VERTICAL30)],
    "s",
    ["source", 30, "medium"],
    pic(1080, 1920, 30),
  ),
  row(
    "size 480p",
    VERTICAL30,
    ["fast", "size:480p"],
    "s",
    ["480p", 30, "medium"],
    pic(480, 854, 30),
  ),
  row(
    "rate Same",
    VERTICAL30,
    ["fast", SAME_RATE(VERTICAL30)],
    "f",
    ["720p", 30, "medium"],
    pic(720, 1280, 30),
  ),
  row(
    "rate 24",
    VERTICAL30,
    ["fast", "rate:24 fps"],
    "f",
    ["720p", 24, "medium"],
    pic(720, 1280, 24),
  ),
  row(
    "quality High",
    VERTICAL30,
    ["fast", "q:High"],
    "q",
    ["720p", 30, "high"],
    pic(720, 1280, 30),
  ),
  row("quality Low", VERTICAL30, ["fast", "q:Low"], "q", ["720p", 30, "low"], pic(720, 1280, 30)),
  row(
    "all three: 480p, 24, High",
    VERTICAL30,
    ["fast", "size:480p", "rate:24 fps", "q:High"],
    "sfq",
    ["480p", 24, "high"],
    pic(480, 854, 24),
  ),
  backToQuality(VERTICAL30),
  // 854x480 at 24: there is no smaller size and no lower rate, so Fast changes only the encoder; the dialog has no Resolution or Frame rate to pick.
  row("nothing set", SD24, ["fast"], "", ["source", 24, "medium"], pic(854, 480, 24)),
  row("quality High", SD24, ["fast", "q:High"], "q", ["source", 24, "high"], pic(854, 480, 24)),
  row("quality Low", SD24, ["fast", "q:Low"], "q", ["source", 24, "low"], pic(854, 480, 24)),
  backToQuality(SD24),
  // 1366x768 at 30, an odd size: Fast is 720p at 30 (1280x720). Sizes: 720p, 480p. Rates: 25, 24.
  row("nothing set", WXGA30, ["fast"], "", ["720p", 30, "medium"], pic(1280, 720, 30)),
  row(
    "size Same",
    WXGA30,
    ["fast", SAME(WXGA30)],
    "s",
    ["source", 30, "medium"],
    pic(1366, 768, 30),
  ),
  row("size 480p", WXGA30, ["fast", "size:480p"], "s", ["480p", 30, "medium"], pic(854, 480, 30)),
  row(
    "rate Same",
    WXGA30,
    ["fast", SAME_RATE(WXGA30)],
    "f",
    ["720p", 30, "medium"],
    pic(1280, 720, 30),
  ),
  row("rate 24", WXGA30, ["fast", "rate:24 fps"], "f", ["720p", 24, "medium"], pic(1280, 720, 24)),
  row("quality High", WXGA30, ["fast", "q:High"], "q", ["720p", 30, "high"], pic(1280, 720, 30)),
  row("quality Low", WXGA30, ["fast", "q:Low"], "q", ["720p", 30, "low"], pic(1280, 720, 30)),
  row(
    "all three: 480p, 24, Low",
    WXGA30,
    ["fast", "size:480p", "rate:24 fps", "q:Low"],
    "sfq",
    ["480p", 24, "low"],
    pic(854, 480, 24),
  ),
  backToQuality(WXGA30),
  // 2560x1440 at 50: Fast is 1080p at 25. Sizes: 1080p, 720p, 480p. Rates: 30, 25, 24.
  row("nothing set", QHD50, ["fast"], "", ["1080p", 25, "medium"], pic(1920, 1080, 25)),
  row(
    "size Same",
    QHD50,
    ["fast", SAME(QHD50)],
    "s",
    ["source", 25, "medium"],
    pic(2560, 1440, 25),
  ),
  row("size 720p", QHD50, ["fast", "size:720p"], "s", ["720p", 25, "medium"], pic(1280, 720, 25)),
  row(
    "rate Same",
    QHD50,
    ["fast", SAME_RATE(QHD50)],
    "f",
    ["1080p", 50, "medium"],
    pic(1920, 1080, 50),
  ),
  row("rate 24", QHD50, ["fast", "rate:24 fps"], "f", ["1080p", 24, "medium"], pic(1920, 1080, 24)),
  row("quality High", QHD50, ["fast", "q:High"], "q", ["1080p", 25, "high"], pic(1920, 1080, 25)),
  row("quality Low", QHD50, ["fast", "q:Low"], "q", ["1080p", 25, "low"], pic(1920, 1080, 25)),
  row(
    "all three: 720p, 24, High",
    QHD50,
    ["fast", "size:720p", "rate:24 fps", "q:High"],
    "sfq",
    ["720p", 24, "high"],
    pic(1280, 720, 24),
  ),
  backToQuality(QHD50),
];

/** What the tool call of the dialog's object gives, and what the same settings typed by hand give, for one chip and one engine. */
async function bothWays(settings: ExportSettings, row: Row, chip: boolean, engine: ExportEngine) {
  const call = callOf(settings);
  const viaDialog = await observe({
    canvas: row.canvas,
    args: call.args,
    slot: call.slot,
    mode: call.mode,
    chip,
    engine,
  });
  // The twin: the settings typed (the size's preset, the rate, the quality), no slot, and the encoder asked for the way a typed export asks: the chip is the dialog's Fast mode, no chip is
  // Quality's plain libx264 (Fast adds the faster setting to it). A Quality export is typed as the 0.28.0 dialog sends it, and asks what the dialog asked.
  const [size, rate, quality] = row.typed;
  const typedArgs =
    row.set === null
      ? { resolution: "source", quality: "medium" }
      : { resolution: size, fps: rate, quality };
  const byHand = await observe({
    canvas: row.canvas,
    args: typedArgs,
    mode: row.set === null ? call.mode : chip ? "fast" : "quality",
    chip,
    engine,
  });
  return { viaDialog, byHand };
}

describe("A and B. the dialog's pick, through the real export tool, is the export typed by hand", () => {
  it.each(ROWS)(
    "$name",
    async (row) => {
      const settings = await dialogGives(row.canvas, row.picks);
      const fast = row.set !== null;

      // The object the dialog handed over: Quality hands the 0.28.0 four keys and no route; Fast hands the route with the flags of what the person set, and leaves the encoder to the app.
      if (fast) {
        expect(keysOf(settings)).toEqual(["fps", "mode", "quality", "resolution", "route"]);
        expect(settings.mode).toBeNull();
        expect(settings.route).toEqual({ route: "quick", explicit: flagsOf(row.set!) });
      } else {
        expect(keysOf(settings)).toEqual(["fps", "mode", "quality", "resolution"]);
        expect(settings).not.toHaveProperty("route");
        expect(settings).toMatchObject({ resolution: "source", quality: "medium", fps: null });
        expect([null, "quality"]).toContain(settings.mode);
      }

      const [, , quality] = row.typed;
      for (const chip of [true, false])
        for (const engine of enginesFor(row.canvas)) {
          const where = `${chip ? "chip" : "processor"}, ${engine}`;
          const { viaDialog, byHand } = await bothWays(settings, row, chip, engine);

          // (1) the picture the plan reports is the one written out by hand, for the dialog's export and for the twin.
          expect(viaDialog.output, where).toEqual(row.want);
          expect(byHand.output, where).toEqual(row.want);

          // (2) the command the app process was handed.
          if (!fast) {
            expect(viaDialog.command, where).toEqual(byHand.command);
            expect(textOf(viaDialog.command), where).not.toContain("veryfast");
          } else if (chip) {
            expect(viaDialog.command, where).toEqual(byHand.command);
            expect([viaDialog.codec, byHand.codec], where).toEqual(["h264_amf", "h264_amf"]);
          } else {
            expect(withoutPreset(viaDialog.command), where).toEqual(byHand.command);
            expect(after(viaDialog.command, "-preset"), where).toBe("veryfast");
            expect(after(byHand.command, "-preset"), where).toBeUndefined();
            expect([viaDialog.codec, byHand.codec], where).toEqual(["libx264", "libx264"]);
          }

          // (3) the command is not empty or trivially equal: it names the picture, the rate and (on the processor) the quality.
          expect(viaDialog.command.args.length, where).toBeGreaterThan(10);
          expect(after(viaDialog.command, "-r"), where).toBe(String(row.want.fps));
          const own = row.want.width === row.canvas.w && row.want.height === row.canvas.h;
          if (!own)
            expect(textOf(viaDialog.command), where).toContain(
              `scale=${row.want.width}:${row.want.height}`,
            );
          if (!chip) expect(after(viaDialog.command, "-crf"), where).toBe(CRF[quality]);

          // (4) the record says route quick for Fast and has no route key otherwise.
          if (fast) {
            expect([viaDialog.running.route, viaDialog.done.route], where).toEqual([
              "quick",
              "quick",
            ]);
          } else {
            expect(viaDialog.running, where).not.toHaveProperty("route");
            expect(viaDialog.done, where).not.toHaveProperty("route");
          }
          expect(byHand.running, where).not.toHaveProperty("route");
          expect(byHand.done, where).not.toHaveProperty("route");
        }
    },
    300_000,
  );

  it("a Quality pick hands the tool no slot at all, and the command of the 0.28.0 dialog", async () => {
    const settings = await dialogGives(UHD60, ["quality"]);
    expect(settings).toMatchObject({ resolution: "source", quality: "medium", fps: null });
    expect(settings).not.toHaveProperty("route");
    expect(callOf(settings).slot).toBeUndefined();
    const call = callOf(settings);
    const seen = await observe({
      canvas: UHD60,
      args: call.args,
      slot: call.slot,
      mode: call.mode,
    });
    const old = await observe({
      canvas: UHD60,
      args: { resolution: "source", quality: "medium" },
      mode: call.mode,
    });
    expect(seen.command).toEqual(old.command);
    expect(seen.output).toEqual(pic(3840, 2160, 60));
    expect(after(seen.command, "-crf")).toBe("23");
    expect(after(seen.command, "-preset")).toBeUndefined();
    expect(seen.running).not.toHaveProperty("route");
  });
});

describe("C. the flags of the slot are the dialog's word on what the person set, and the tool reads them", () => {
  const OWN = pic(3840, 2160, 60);
  const COMPOSED = pic(1920, 1080, 30);
  const flags = (size: boolean, fps: boolean, quality: boolean) =>
    Object.freeze({ route: "quick", explicit: Object.freeze({ size, fps, quality }) });

  it("a Same picked on purpose stays with the dialog's flags; flags that are missing or all false lose it; all true composes nothing", async () => {
    const settings = await dialogGives(UHD60, ["fast", SAME(UHD60), SAME_RATE(UHD60)]);
    expect(settings).toMatchObject({ resolution: "source", fps: null, quality: "medium" });
    expect(settings.route).toEqual({
      route: "quick",
      explicit: { size: true, fps: true, quality: false },
    });
    const args = callOf(settings).args;
    const slots: [string, unknown, Picture][] = [
      ["the dialog's own flags", settings.route, OWN],
      ["the flags missing", Object.freeze({ route: "quick" }), COMPOSED],
      ["every flag false", flags(false, false, false), COMPOSED],
      ["every flag true", flags(true, true, true), OWN],
    ];
    const commands = [];
    for (const [name, slot, want] of slots) {
      const seen = await observe({ canvas: UHD60, args, slot });
      expect(seen.output, name).toEqual(want);
      expect(seen.running.route, name).toBe("quick");
      commands.push(seen.command);
    }
    // The flags decide the command, not only the plan: what was lost is a different picture and rate in what the app process was handed.
    expect(commands[1]).not.toEqual(commands[0]);
    expect(commands[2]).not.toEqual(commands[0]);
    expect(commands[3]).toEqual(commands[0]);
  });

  it("a call that sets nothing is composed by Fast when no flag is set, and left alone when every flag is", async () => {
    const args = { resolution: "source", quality: "medium" };
    const open = await observe({ canvas: UHD60, args, slot: flags(false, false, false) });
    const set = await observe({ canvas: UHD60, args, slot: flags(true, true, true) });
    const none = await observe({ canvas: UHD60, args });
    expect(open.output).toEqual(COMPOSED);
    expect(set.output).toEqual(OWN);
    // Every flag set: Fast changes only the encoder, so what is left is the command of the call without a slot, plus the faster setting.
    expect(withoutPreset(set.command)).toEqual(none.command);
    expect(after(set.command, "-preset")).toBe("veryfast");
    expect(after(none.command, "-preset")).toBeUndefined();
    expect(open.command).not.toEqual(none.command);
  });

  it("a project that changed between the click and the tool is exported as Fast for the project it is then: what the person set stays, the rest is Fast's", async () => {
    // The dialog was open on 4K at 60; by the time the tool runs the project is 1920x1080 at 30 (Fast: 720p at 30).
    const nothing = callOf(await dialogGives(UHD60, ["fast"]));
    expect((await observe({ canvas: HD30, ...nothing })).output).toEqual(pic(1280, 720, 30));
    const rate = callOf(await dialogGives(UHD60, ["fast", "rate:24 fps"]));
    const ran = await observe({ canvas: HD30, ...rate });
    expect(ran.output).toEqual(pic(1280, 720, 24));
    const typed = { resolution: "720p", fps: 24, quality: "medium" };
    const byHand = await observe({ canvas: HD30, args: typed, mode: "quality" });
    expect(withoutPreset(ran.command)).toEqual(byHand.command);
    const size = callOf(await dialogGives(UHD60, ["fast", "size:480p"]));
    expect((await observe({ canvas: HD30, ...size })).output).toEqual(pic(854, 480, 30));
  });

  it("a pick the project no longer holds at the click is dropped from what is sent and from the flags", async () => {
    // The project shrinks to 1920x1080 at 30 in the turn of the click, before the view has drawn again: the 1440p and the 50 fps are not on offer any more.
    const settings = await dialogGives(UHD60, ["fast", "size:1440p", "rate:50 fps"], {
      between: () => setCanvas(HD30),
    });
    expect(settings).toMatchObject({ resolution: "720p", fps: null, quality: "medium" });
    expect(settings.route).toEqual({
      route: "quick",
      explicit: { size: false, fps: false, quality: false },
    });
    const call = callOf(settings);
    const ran = await observe({ canvas: HD30, ...call });
    expect(ran.output).toEqual(pic(1280, 720, 30));
    const byHand = await observe({
      canvas: HD30,
      args: { resolution: "720p", fps: 30, quality: "medium" },
      mode: "quality",
    });
    expect(withoutPreset(ran.command)).toEqual(byHand.command);
  });
});

describe("D. the switch is read by the tool when it runs, not by the dialog at the click", () => {
  const OFF = [{ name: "switched off on the server", off: "off" as const }];
  it.each(OFF)(
    "$name: the tool runs what the dialog showed, on the plain encoder, with no route",
    async ({ off }) => {
      // What the dialog showed for each project (the click happened with the switch on): 1080p at 30 for 4K at 60, 720p at 30 for 1080p at 30, both at Medium.
      const cases: [Canvas, Picture][] = [
        [UHD60, pic(1920, 1080, 30)],
        [HD30, pic(1280, 720, 30)],
      ];
      for (const [canvas, shown] of cases)
        for (const chip of [false, true]) {
          const where = `${canvasName(canvas)}, ${chip ? "chip" : "processor"}`;
          const call = callOf(await dialogGives(canvas, ["fast"]));
          expect(call.slot, where).toMatchObject({ route: "quick" });
          const ran = await observe({ canvas, ...call, chip, switch: off });
          const typed = {
            resolution: shown.height === 1080 ? "1080p" : "720p",
            fps: 30,
            quality: "medium",
          };
          const byHand = await observe({ canvas, args: typed, chip, switch: off });
          expect(ran.output, where).toEqual(shown);
          expect(ran.command, where).toEqual(byHand.command);
          expect(ran.codec, where).toBe("libx264");
          expect(after(ran.command, "-preset"), where).toBeUndefined();
          expect(after(ran.command, "-crf"), where).toBe("23");
          expect(ran.running, where).not.toHaveProperty("route");
          expect(ran.done, where).not.toHaveProperty("route");
          // The same object with the switch on is Fast: not the same command.
          const on = await observe({ canvas, ...call, chip });
          expect(on.command, where).not.toEqual(ran.command);
          expect(on.running.route, where).toBe("quick");
        }
    },
    300_000,
  );

  // The build's hold on the other switches (the estimate and the speed check) does not reach the Fast choice: the dialog's pick runs as Fast in a shipped build, in the bytes it has with the hold lifted.
  it("as shipped (the hold on for the other names): the dialog's Fast pick runs as Fast, in the bytes it has with the hold lifted", async () => {
    for (const canvas of [UHD60, HD30])
      for (const chip of [false, true]) {
        const where = `${canvasName(canvas)}, ${chip ? "chip" : "processor"}`;
        const call = callOf(await dialogGives(canvas, ["fast"]));
        const lifted = await observe({ canvas, ...call, chip, switch: "on" });
        const shipped = await observe({ canvas, ...call, chip, switch: "shipped" });
        expect(shipped.command, where).toEqual(lifted.command);
        expect(shipped.output, where).toEqual(lifted.output);
        expect([shipped.running.route, shipped.done.route], where).toEqual(["quick", "quick"]);
      }
  }, 300_000);
});

describe("E. the chat and MCP doors never take Fast", () => {
  const DOORS = [
    { name: "the assistant in the app", surface: "app" as const },
    { name: "an outside program over MCP", surface: "mcp" as const },
  ];
  it.each(DOORS)(
    "$name: no slot, so the project's own picture, or exactly what the arguments say, on Quality's encoder",
    async ({ surface }) => {
      const shown = callOf(await dialogGives(UHD60, ["fast"])).args;
      for (const chip of [false, true]) {
        const where = chip ? "chip" : "processor";
        // A call that sets nothing is the project's own picture (Fast would have made 1080p at 30 of it).
        const open = await observe({ canvas: UHD60, args: {}, chip, surface });
        expect(open.output, where).toEqual(pic(3840, 2160, 60));
        expect(open.running, where).not.toHaveProperty("route");
        expect(textOf(open.command), where).not.toContain("veryfast");
        // The values Fast's dialog showed, sent without the slot: those values and nothing more, never the chip, never the faster setting.
        const asked = await observe({ canvas: UHD60, args: shown, chip, surface });
        expect(asked.output, where).toEqual(pic(1920, 1080, 30));
        expect(asked.codec, where).toBe("libx264");
        expect(textOf(asked.command), where).not.toContain("veryfast");
        expect(after(asked.command, "-crf"), where).toBe("23");
        expect(asked.running, where).not.toHaveProperty("route");
        expect(asked.done, where).not.toHaveProperty("route");
        // What the slot adds is the encoder alone: on the processor the same call with Fast's slot is this command plus the faster setting.
        if (!chip) {
          const slot = callOf(await dialogGives(UHD60, ["fast"])).slot;
          const fast = await observe({ canvas: UHD60, args: shown, slot, surface });
          expect(withoutPreset(fast.command)).toEqual(asked.command);
          expect(after(fast.command, "-preset")).toBe("veryfast");
        }
      }
    },
    300_000,
  );
});

describe("G. before the app has answered about the encoder (no project figures for the dialog)", () => {
  it("Quality asks for Full quality as the 0.28.0 dialog does, Fast leaves the encoder to the app and still takes the chip", async () => {
    const quality = await dialogGives(UHD60, ["quality"], { workload: false });
    expect(quality).toStrictEqual({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: "quality",
    });
    const fast = await dialogGives(UHD60, ["fast"], { workload: false });
    expect(fast.mode).toBeNull();
    expect(fast.route).toEqual({
      route: "quick",
      explicit: { size: false, fps: false, quality: false },
    });
    const chosen = callOf(quality);
    const plain = await observe({ canvas: UHD60, ...chosen, chip: true });
    expect([plain.codec, plain.output]).toEqual(["libx264", pic(3840, 2160, 60)]);
    expect(plain.running).not.toHaveProperty("route");
    const taken = callOf(fast);
    const viaChip = await observe({ canvas: UHD60, ...taken, chip: true });
    expect([viaChip.codec, viaChip.output]).toEqual(["h264_amf", pic(1920, 1080, 30)]);
    expect(viaChip.running.route).toBe("quick");
  });
});

describe("F. a clip export and a library copy ignore the dialog's Fast slot (clip_ids and media_refs)", () => {
  async function clipExport(slot: unknown) {
    const t = await world(UHD60);
    const entries = [{ media_ref: "b.mp4", timeline_in: 60, timeline_out: 120 }];
    const placed = (await addClipsTool({ entries }, t.base)) as Any;
    const clipId = String(placed.created[0].clip_id);
    const reply = await t.call({ clip_ids: [clipId], output_dir: "clips" }, slot);
    const id = String(reply.exports[0].job_id);
    const spec = await t.handedOver(id);
    return {
      reply: scrub(reply, [id, clipId]),
      command: commandOf(spec),
      output: outputOf(spec),
      record: { ...recordOf(id) },
    };
  }

  it("a clip made with the slot of a Fast pick is the clip of Quality: the clip's own picture, the same command, no route", async () => {
    const slot = callOf(await dialogGives(UHD60, ["fast"])).slot;
    expect(slot).toMatchObject({ route: "quick" });
    const fast = await clipExport(slot);
    const none = await clipExport(undefined);
    expect(fast.command).toEqual(none.command);
    expect(fast.reply).toEqual(none.reply);
    expect(fast.output).toEqual(pic(3840, 2160, 60));
    expect(fast.record).not.toHaveProperty("route");
    expect(keysOf(fast.record)).toEqual(keysOf(none.record));
  });

  it("a library file copied with the slot of a Fast pick is the copy of Quality, with no route and no render", async () => {
    const slot = callOf(await dialogGives(UHD60, ["fast"])).slot;
    const copy = async (given: unknown) => {
      const t = await world(UHD60);
      // The app process plays the copy as well: the delivery's copy runs as one of its jobs.
      const delivery = t.jobs.delivery!;
      const prepare = delivery.prepare.bind(delivery);
      delivery.prepare = async (...args) => {
        const prepared = await prepare(...args);
        if (prepared.source?.kind === "copy") t.jobs.queueCopy(prepared);
        return prepared;
      };
      const run = delivery.copy.bind(delivery);
      delivery.copy = (id) => t.jobs.runCopy(id, () => run(id));
      const source = "C:/source/copied.mp4";
      await t.fs.writeTextFile(source, "complete copied video");
      const bytes = await t.store.readBytes(source);
      const from = { kind: "import" };
      const entry = await registerLibraryClip(t.store, bytes, "copied.mp4", "video", from, source);
      const reply = await t.call({ media_refs: [entry.id], output_dir: "copies" }, given);
      const id = String(reply.exports[0].job_id);
      return {
        reply: scrub(reply, [id, entry.id]),
        record: { ...recordOf(id) },
        rendered: t.jobs.submitted.length,
      };
    };
    const fast = await copy(slot);
    const none = await copy(undefined);
    expect(fast.reply).toEqual(none.reply);
    expect(fast.record).not.toHaveProperty("route");
    expect(keysOf(fast.record)).toEqual(keysOf(none.record));
    expect([fast.rendered, none.rendered]).toEqual([0, 0]);
  });
});
