// What the Export dialog says about time before the click, with the honest estimate and the PC's speed check behind it: the words of every basis, the line while the check runs, the quiet line after it and
// the action to run it again, and what the dialog does when the estimate or the check misbehaves. The dialog is rendered as the person sees it; the PC check is the real service with a probe the test answers by hand.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { createPcCheckService, type PcCheckService } from "../platform/pcCheck";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import * as estimator from "../timeline/estimator";
import { __resetExportAsk, exportAskedNow } from "../timeline/exportAsk";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import {
  EXPORT_SPEED_REVISION,
  estimateForDialog,
  type ExportCalibration,
} from "../timeline/exportOptions";
import { describeExpected } from "../timeline/exportWords";
import { emptyTimeline, type Clip, type Timeline } from "../timeline/model";
import { setPcCheckService } from "../timeline/pcCheckHandle";
import type { PcCheckRecord, StorageLike } from "../timeline/pcClass";
import { summarizeRenderWorkload } from "../timeline/renderPlan";
import { __resetRouteEstimatesMemo } from "../timeline/routeEstimates";
import ExportDialog from "./ExportDialog";

vi.mock("../timeline/exportChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoice")>()),
  decideExportEncoder: vi.fn(),
}));

const DAY = 86_400_000;
const NOW = Date.now();
const SPEED = "export-speed";

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

const clip = (id: string, from: number, to: number): Clip => ({
  id,
  kind: "video",
  media_ref: `${id}.mp4`,
  source_in: 0,
  source_out: to - from,
  timeline_in: from,
  timeline_out: to,
});
/** A two-minute talk at 1080p30: the project the dialog is opened on. */
const talk: Timeline = (() => {
  const raw = emptyTimeline(1920, 1080, 30);
  raw.tracks = [{ id: "v1", kind: "video", z: 0, clips: [clip("a", 0, 3600)] }];
  return raw;
})();
const PROJECT = summarizeRenderWorkload(talk);

const done = (over: Partial<PcCheckRecord> = {}): PcCheckRecord => ({
  revision: 1,
  build: "artdaddy@test",
  atMs: NOW,
  cores: 8,
  outcome: "done",
  aFps: 90,
  bFps: 12,
  cFps: 40,
  rHat: 2.5,
  cls: "ok",
  ...over,
});

/** The real PC check service, quiet and ready, whose speed test the test answers by hand. */
function checkWorld() {
  const map = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
  const runs: {
    signal: AbortSignal;
    resolve: (answer: { record: PcCheckRecord | null; stored: boolean }) => void;
  }[] = [];
  const service: PcCheckService = createPcCheckService({
    now: () => NOW,
    storage,
    build: "artdaddy@test",
    cores: 8,
    setTimer: () => 0,
    clearTimer: () => undefined,
    probe: async () => ({ kind: "busy" }),
    files: {
      dir: async () => "C:/cache/pc-check",
      mkdir: async () => undefined,
      remove: async () => undefined,
      rename: async () => undefined,
      size: async () => null,
    },
  });
  service.registerProbe({
    id: SPEED,
    revision: 1,
    ttlMs: 30 * DAY,
    budgetMs: 20_000,
    definesClass: true,
    run: ({ signal }) => new Promise((resolve) => void runs.push({ signal, resolve })),
  });
  service.setSignals({
    exportBusy: false,
    exportAsked: false,
    playing: false,
    lookOrSpeechJob: false,
    projectOpen: true,
    lastInputAtMs: NOW - 60_000,
  });
  return { service, storage, runs };
}

const earlier = (over: Partial<ExportCalibration> = {}): ExportCalibration => ({
  workload: PROJECT,
  output: { width: 1920, height: 1080, fps: 30 },
  quality: "medium",
  engine: "file-sequence-v1",
  encoder: "x264-crf",
  revision: EXPORT_SPEED_REVISION,
  elapsedSeconds: 150,
  finalBytes: 48_000_000,
  memoryBytes: null,
  temporaryBytes: null,
  ...over,
});

const show = (workload = PROJECT, onStart = vi.fn()) =>
  render(<ExportDialog open onCancel={() => {}} onStart={onStart} workload={workload} />);
const line = () => screen.getByLabelText("export estimate");

beforeEach(() => {
  useExportJob.getState().reset();
  useExportJob.setState({ calibrations: [] });
  useEditor.setState({ timeline: talk });
  __resetRouteEstimatesMemo();
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockResolvedValue(decision());
});
afterEach(() => {
  vi.restoreAllMocks();
  setPcCheckService(null);
  __resetExportFlags();
  __resetExportAsk();
  useEditor.setState({ timeline: null });
  __resetRouteEstimatesMemo();
});

describe("the estimate line says where its number comes from", () => {
  it("a PC that has been checked: from a quick check of this PC's speed, and never the old 'nothing like this has been exported' guess", async () => {
    const world = checkWorld();
    setPcCheckService(world.service);
    world.runs.length = 0;
    world.service.requestRun({ reason: "dialog", force: true });
    await act(async () => undefined);
    world.runs[0].resolve({ record: done(), stored: false });
    await act(async () => undefined);
    show();
    expect(line()).toHaveTextContent(/^Expected: .+, from a quick check of this PC's speed\.$/);
    expect(line()).not.toHaveTextContent("nothing like this");
  });

  it("a PC nobody has checked: a rough guess that says the speed has not been checked yet", () => {
    show();
    expect(line()).toHaveTextContent(
      /^Expected: .+\. A rough guess: this PC's speed has not been checked yet\.$/,
    );
  });

  it("a check that could not finish: a rough guess that says so, and that this PC is treated as slower than most", async () => {
    const world = checkWorld();
    setPcCheckService(world.service);
    world.service.requestRun({ reason: "dialog", force: true });
    await act(async () => undefined);
    world.runs[0].resolve({ record: null, stored: false });
    await act(async () => undefined);
    show();
    expect(line()).toHaveTextContent(
      /^Expected: .+\. A rough guess: the speed check could not finish, so this PC is treated as slower than most\.$/,
    );
  });

  it("earlier exports on this PC speak first, in the words 0.27.0 used for them", () => {
    useExportJob.setState({ calibrations: [earlier()] });
    const view = show();
    expect(line()).toHaveTextContent(
      "Expected: about 3 min, a file of about 48 MB, from earlier exports on this PC.",
    );
    view.unmount();
    // a project of another shape does not borrow that time
    useExportJob.setState({
      calibrations: [
        earlier({ workload: { ...PROJECT, peakMediaLayers: 3, peakVisualLayers: 3 } }),
      ],
    });
    show();
    expect(line()).not.toHaveTextContent("from earlier exports");
  });

  it("follows the settings the person changes", () => {
    const world = checkWorld();
    setPcCheckService(world.service);
    useExportJob.setState({
      calibrations: [
        earlier({
          output: { width: 1280, height: 720, fps: 30 },
          elapsedSeconds: 70,
          finalBytes: 20_000_000,
        }),
      ],
    });
    show();
    expect(line()).not.toHaveTextContent("a file of about 20 MB");
    fireEvent.change(screen.getByLabelText("resolution"), { target: { value: "720p" } });
    expect(line()).toHaveTextContent("Expected: about 1 min, a file of about 20 MB");
  });

  it("says a range, not one number, where the estimate is unsure, and says it could take much longer for a project it could not read", () => {
    useEditor.setState({ timeline: null });
    __resetRouteEstimatesMemo();
    show();
    expect(line().textContent).toMatch(/ to /);
    expect(screen.getByTestId("estimate-much-longer")).toHaveTextContent(
      "This project is heavier than what the check measured, so it could take much longer.",
    );
  });

  it("says nothing where the project has none to go on", () => {
    show({ ...PROJECT, durationSeconds: 0 });
    expect(screen.queryByLabelText("export estimate")).not.toBeInTheDocument();
  });
});

describe("the speed check, in the dialog", () => {
  it("says the check is running, keeps Export enabled, and shows the estimate it leads to when it ends", async () => {
    const world = checkWorld();
    setPcCheckService(world.service);
    const start = vi.fn();
    show(PROJECT, start);
    expect(screen.queryByTestId("speed-check")).not.toBeInTheDocument();
    act(() => world.service.requestRun({ reason: "dialog", force: true }));
    await act(async () => undefined);
    expect(line()).toHaveTextContent("Checking this PC's speed… (about 10 seconds)");
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
    world.runs[0].resolve({ record: done({ rHat: 6, cls: "weak" }), stored: false });
    await act(async () => undefined);
    expect(line()).toHaveTextContent("from a quick check of this PC's speed.");
    expect(screen.getByTestId("speed-check")).toHaveTextContent(
      "Speed check: slow · today · Check again",
    );
  });

  it("clicking Export while it runs starts the export at once, on a labelled rough guess, and tells the check an export is being asked", async () => {
    const world = checkWorld();
    setPcCheckService(world.service);
    const start = vi.fn();
    show(PROJECT, start);
    act(() => world.service.requestRun({ reason: "dialog", force: true }));
    await act(async () => undefined);
    expect(world.service.status().running).toBe(SPEED);
    expect(exportAskedNow()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledTimes(1);
    // the request is on its way before the queue has it: from the click, the check's world says an export is being asked
    expect(exportAskedNow()).toBe(true);
  });

  it("a finished check is said quietly under the estimate, in the person's words", async () => {
    for (const [record, words] of [
      [done({ rHat: 0.5, cls: "fast" }), "Speed check: fast · today · Check again"],
      [done({ rHat: 2.5, cls: "ok" }), "Speed check: OK · today · Check again"],
      [done({ rHat: 6, cls: "weak" }), "Speed check: slow · today · Check again"],
    ] as const) {
      const world = checkWorld();
      setPcCheckService(world.service);
      world.service.requestRun({ reason: "dialog", force: true });
      await act(async () => undefined);
      world.runs[0].resolve({ record, stored: false });
      await act(async () => undefined);
      const view = show();
      expect(screen.getByTestId("speed-check")).toHaveTextContent(words);
      view.unmount();
    }
  });

  it("a check that could not finish is said as that, treated as slower than most", async () => {
    const world = checkWorld();
    setPcCheckService(world.service);
    world.service.requestRun({ reason: "dialog", force: true });
    await act(async () => undefined);
    world.runs[0].resolve({ record: null, stored: false });
    await act(async () => undefined);
    show();
    expect(screen.getByTestId("speed-check")).toHaveTextContent(
      "Speed check: not finished (this PC was busy) · treated as slower than most · Check again",
    );
  });

  it("Check again runs it again, now, and the line says so", async () => {
    const world = checkWorld();
    setPcCheckService(world.service);
    world.service.requestRun({ reason: "dialog", force: true });
    await act(async () => undefined);
    world.runs[0].resolve({ record: done(), stored: false });
    await act(async () => undefined);
    show();
    expect(world.runs).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await act(async () => undefined);
    expect(world.runs).toHaveLength(2);
    expect(line()).toHaveTextContent("Checking this PC's speed… (about 10 seconds)");
    world.runs[1].resolve({ record: done({ rHat: 0.5, cls: "fast" }), stored: false });
    await act(async () => undefined);
    expect(screen.getByTestId("speed-check")).toHaveTextContent("Speed check: fast");
  });

  it("is not started by opening the dialog, and says nothing where there is no check service (a page without the app) or the switch is off", async () => {
    const world = checkWorld();
    setPcCheckService(world.service);
    const first = show();
    await act(async () => undefined);
    expect(world.runs).toHaveLength(0);
    expect(screen.queryByTestId("speed-check")).not.toBeInTheDocument();
    first.unmount();
    setPcCheckService(null);
    const alone = show();
    expect(screen.queryAllByTestId("speed-check")).toHaveLength(0);
    alone.unmount();
    const checked = checkWorld();
    setPcCheckService(checked.service);
    checked.service.requestRun({ reason: "dialog", force: true });
    await act(async () => undefined);
    checked.runs[0].resolve({ record: done(), stored: false });
    await act(async () => undefined);
    __setExportFlag("pc_check", false);
    show();
    expect(screen.queryByTestId("speed-check")).not.toBeInTheDocument();
    expect(line()).toHaveTextContent("A rough guess: this PC's speed has not been checked yet.");
  });
});

describe("with the new estimate off the dialog says what 0.27.0 said", () => {
  const legacyLine = (history: ExportCalibration[]) =>
    describeExpected(
      estimateForDialog(
        PROJECT,
        { resolution: "source", quality: "medium", fps: null, mode: "quality" },
        history,
        { faster: false },
      ),
    );

  it("is 0.27.0's own line, word for word, for a guess and for a measurement, whatever the check says", async () => {
    __setExportFlag("estimate_v2", false);
    const world = checkWorld();
    setPcCheckService(world.service);
    world.service.requestRun({ reason: "dialog", force: true });
    await act(async () => undefined);
    world.runs[0].resolve({ record: done({ rHat: 9, cls: "weak" }), stored: false });
    await act(async () => undefined);
    const guess = show();
    expect(line().textContent).toBe(legacyLine([]));
    expect(screen.queryByTestId("estimate-much-longer")).not.toBeInTheDocument();
    guess.unmount();
    useExportJob.setState({ calibrations: [earlier()] });
    show();
    expect(line().textContent).toBe(legacyLine([earlier()]));
  });

  it("with the check switched off there is no speed-check line and no class, and the estimate is the guess", async () => {
    __setExportFlag("pc_check", false);
    const world = checkWorld();
    setPcCheckService(world.service);
    show();
    expect(screen.queryByTestId("speed-check")).not.toBeInTheDocument();
    expect(line()).toHaveTextContent("A rough guess: this PC's speed has not been checked yet.");
  });
});

describe("it fails soft: the dialog opens and the export starts whatever the estimate or the check does", () => {
  it("a project that cannot be read has no line, and Export still starts", () => {
    const start = vi.fn();
    show(
      { ...PROJECT, width: Number.NaN, height: 0, fps: Number.NaN, durationSeconds: Number.NaN },
      start,
    );
    expect(screen.queryByLabelText("export estimate")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("an estimator that throws leaves the dialog open and the export startable, with no estimate line", () => {
    vi.spyOn(estimator, "estimate").mockImplementation(() => {
      throw new Error("the model broke");
    });
    const start = vi.fn();
    show(PROJECT, start);
    expect(screen.getByRole("dialog", { name: "export video" })).toBeInTheDocument();
    expect(screen.queryByLabelText("export estimate")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("a speed check that never ends does not delay the dialog: it opens at once and Export works", async () => {
    const world = checkWorld();
    setPcCheckService(world.service);
    world.service.requestRun({ reason: "dialog", force: true });
    await act(async () => undefined);
    const start = vi.fn();
    const began = Date.now();
    show(PROJECT, start);
    expect(Date.now() - began).toBeLessThan(1000);
    expect(line()).toHaveTextContent("Checking this PC's speed…");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("a damaged store of the check is no check", () => {
    const world = checkWorld();
    world.storage.setItem("artdaddy.pcCheck.v1", "{not json");
    setPcCheckService(world.service);
    show();
    expect(line()).toHaveTextContent("A rough guess: this PC's speed has not been checked yet.");
    expect(screen.queryByTestId("speed-check")).not.toBeInTheDocument();
  });

  it("a check service that throws is no check service", () => {
    setPcCheckService({
      result: () => {
        throw new Error("the service broke");
      },
      status: () => {
        throw new Error("the service broke");
      },
      subscribe: () => {
        throw new Error("the service broke");
      },
      pcClass: () => {
        throw new Error("the service broke");
      },
    } as unknown as PcCheckService);
    const start = vi.fn();
    show(PROJECT, start);
    expect(line()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(start).toHaveBeenCalledTimes(1);
  });
});
