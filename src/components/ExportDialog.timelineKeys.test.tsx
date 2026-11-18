// A key pressed in the Export dialog stays in the dialog. In the app the editor is mounted next to the dialog (which is not modal) and listens on the window for its shortcuts: an arrow key
// steps the playhead and is cancelled, Space plays, Delete removes the selected clip. Without the dialog keeping its keys, the arrow keys could never move the Quality | Fast radios (the browser's
// own move to the next radio is what the editor cancelled), and Delete on a focused control of the dialog, 0.28.0's included, removed the clip selected behind it. These tests mount the REAL
// timeline editor beside the REAL dialog; every "does nothing" case has a control in which the same key, pressed outside the dialog, does what the editor does.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = vi.hoisted(() => ({ state: {} as any }));
vi.mock("../store/editor", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useEditor: Object.assign((sel: any) => sel(h.state), { getState: () => h.state }),
  _zoomBounds: { MIN_ZOOM: 4, MAX_ZOOM: 400, DEFAULT_ZOOM: 40 },
}));
vi.mock("../lib/dragSource", () => ({ onDragPoint: () => () => undefined }));
vi.mock("../timeline/exportChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoice")>()),
  decideExportEncoder: vi.fn(),
}));
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

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { processorName, resolveExportResources, runCapabilityProbe } from "../platform/host";
import { useExportJob } from "../store/exportJob";
import { amd, harness } from "../test/chipHarness";
import { __resetChipTests } from "../timeline/chipTest";
import * as exportAsk from "../timeline/exportAsk";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import ExportDialog from "./ExportDialog";
import TimelineEditor from "./TimelineEditor";

const decision = (): ExportEncoderDecision => ({
  mode: "quality",
  reason: "none",
  showRow: false,
  defaultMode: "quality",
  fullSeconds: 40,
  fastSeconds: null,
  fullGuessed: true,
  tests: [],
  facts: { encoder: "x264", reason: "none", tests: [] },
});

function pcWith(adapters: (typeof amd)[]) {
  const scripted = harness(adapters);
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
    adapters,
  });
  vi.mocked(processorName).mockReset();
  vi.mocked(processorName).mockResolvedValue(null);
}

const timeline = {
  canvas: { width: 1920, height: 1080, fps: 30 },
  tracks: [
    {
      id: "v1",
      kind: "video",
      clips: [
        {
          id: "c1",
          media_ref: "clip.mp4",
          timeline_in: 0,
          timeline_out: 600,
          source_in: 0,
          source_out: 600,
        },
      ],
    },
  ],
};
const workload = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 20,
  visualClips: 1,
  captionClips: 0,
  audioClips: 0,
  peakVisualLayers: 1,
  peakMediaLayers: 1,
};

beforeEach(() => {
  localStorage.clear();
  __resetChipTests();
  __setExportFlag("quick_export", true);
  useExportJob.getState().reset();
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockImplementation(async () => decision());
  pcWith([amd]);
  h.state = {
    timeline,
    selection: null,
    get selectedIds(): string[] {
      return h.state.selection ? [h.state.selection] : [];
    },
    playhead: 0,
    zoom: 40,
    select: vi.fn(),
    selectAll: vi.fn(),
    setPlayhead: vi.fn(),
    setZoom: vi.fn(),
    beginGesture: vi.fn(),
    endGesture: vi.fn(),
    nudgeClips: vi.fn(() => Promise.resolve()),
    moveClip: vi.fn(() => Promise.resolve()),
    trimClip: vi.fn(() => Promise.resolve()),
    clipSourceFrames: vi.fn(() => Promise.resolve(null)),
    splitClip: vi.fn(() => Promise.resolve()),
    deleteClips: vi.fn(() => Promise.resolve()),
    rippleDeleteClip: vi.fn(() => Promise.resolve()),
    duplicateClip: vi.fn(() => Promise.resolve()),
    linkClips: vi.fn(() => Promise.resolve()),
    unlinkClips: vi.fn(() => Promise.resolve()),
    copyClip: vi.fn(),
    pasteClip: vi.fn(() => Promise.resolve()),
    clipboard: null,
    undo: vi.fn(() => Promise.resolve()),
    redo: vi.fn(() => Promise.resolve()),
    addClip: vi.fn(() => Promise.resolve()),
    addTrack: vi.fn(() => Promise.resolve()),
    removeTrack: vi.fn(() => Promise.resolve()),
    setTrack: vi.fn(() => Promise.resolve()),
    setTracks: vi.fn(() => Promise.resolve()),
    setTransition: vi.fn(() => Promise.resolve()),
    trackScale: { video: 1, audio: 1 },
    setTrackScale: vi.fn(),
    store: null,
    setSelectedRange: vi.fn(),
    selectedRange: null,
    selectMany: vi.fn(),
    selectGap: vi.fn(),
    selectedGap: null,
    rippleDeleteGap: vi.fn(),
  };
});
afterEach(() => {
  cleanup();
  exportAsk.__resetExportAsk();
  __resetExportFlags();
});

const settle = () =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));

/** The editor and the dialog side by side, as in the app. `togglePlay` counts the editor's play/pause event. */
async function mountBoth(quickRoute: boolean) {
  const togglePlay = vi.fn();
  window.addEventListener("artdaddy:toggle-play", togglePlay);
  const onCancel = vi.fn();
  const user = userEvent.setup();
  render(
    <>
      <TimelineEditor />
      <ExportDialog
        open
        onCancel={onCancel}
        onStart={() => undefined}
        workload={workload}
        quickRoute={quickRoute}
      />
    </>,
  );
  await settle();
  return {
    user,
    onCancel,
    togglePlay,
    done: () => window.removeEventListener("artdaddy:toggle-play", togglePlay),
  };
}
const radio = (name: "Quality" | "Fast") => screen.getByRole("radio", { name }) as HTMLInputElement;
const editor = () => h.state as Record<string, ReturnType<typeof vi.fn>>;

describe("the editor beside the dialog is live (the control of every case below)", () => {
  it("a key pressed outside the dialog does what the editor does with it: an arrow steps the playhead, Space plays, Delete removes the selected clip, and so do the chords", async () => {
    const { user, togglePlay, done } = await mountBoth(true);
    h.state.selection = "c1";
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("{ArrowRight}");
    expect(editor().setPlayhead).toHaveBeenCalledTimes(1);
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(editor().nudgeClips).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(togglePlay).toHaveBeenCalledTimes(1);
    await user.keyboard("{Control>}z{/Control}");
    expect(editor().undo).toHaveBeenCalledTimes(1);
    await user.keyboard("{Control>}c{/Control}");
    expect(editor().copyClip).toHaveBeenCalledTimes(1);
    await user.keyboard("{Control>}k{/Control}");
    expect(editor().splitClip).toHaveBeenCalledTimes(1);
    await user.keyboard("{Delete}");
    expect(editor().deleteClips).toHaveBeenCalledTimes(1);
    expect(editor().deleteClips.mock.calls[0][0]).toEqual(["c1"]);
    done();
  });
});

describe("a key pressed in the new dialog stays in it", () => {
  it("ArrowRight on the checked Quality radio checks Fast and ArrowLeft goes back, and neither steps the playhead", async () => {
    const { user, done } = await mountBoth(true);
    radio("Quality").focus();
    await user.keyboard("{ArrowRight}");
    expect(radio("Fast")).toBeChecked();
    expect(radio("Quality")).not.toBeChecked();
    expect(document.activeElement).toBe(radio("Fast"));
    await user.keyboard("{ArrowLeft}");
    expect(radio("Quality")).toBeChecked();
    expect(editor().setPlayhead).not.toHaveBeenCalled();
    done();
  });

  it("the arrow keys of every direction move between the two radios, and with Shift or Alt they still leave the editor alone", async () => {
    const { user, done } = await mountBoth(true);
    h.state.selection = "c1";
    radio("Quality").focus();
    await user.keyboard("{ArrowDown}");
    expect(radio("Fast")).toBeChecked();
    await user.keyboard("{ArrowUp}");
    expect(radio("Quality")).toBeChecked();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}{Alt>}{ArrowLeft}{/Alt}");
    expect(editor().setPlayhead).not.toHaveBeenCalled();
    expect(editor().nudgeClips).not.toHaveBeenCalled();
    done();
  });

  it("Space on a radio does not play or pause the editor", async () => {
    const { user, togglePlay, done } = await mountBoth(true);
    radio("Quality").focus();
    await user.keyboard(" ");
    act(() => radio("Fast").focus());
    await user.keyboard(" ");
    expect(radio("Fast")).toBeChecked();
    expect(togglePlay).not.toHaveBeenCalled();
    done();
  });

  it("Delete, Backspace and the editing chords do nothing to the clip selected behind the dialog", async () => {
    const { user, done } = await mountBoth(true);
    h.state.selection = "c1";
    radio("Quality").focus();
    await user.keyboard("{Delete}{Backspace}");
    await user.keyboard("{Shift>}{Delete}{/Shift}");
    await user.keyboard("{Control>}z{/Control}{Control>}c{/Control}{Control>}x{/Control}");
    await user.keyboard("{Control>}k{/Control}");
    const e = editor();
    expect(e.deleteClips).not.toHaveBeenCalled();
    expect(e.rippleDeleteClip).not.toHaveBeenCalled();
    expect(e.undo).not.toHaveBeenCalled();
    expect(e.copyClip).not.toHaveBeenCalled();
    expect(e.splitClip).not.toHaveBeenCalled();
    done();
  });

  it("the same keys on the other controls of the dialog (the door, the Export button) stay in it too", async () => {
    const { user, togglePlay, done } = await mountBoth(true);
    h.state.selection = "c1";
    const door = screen.getByRole("button", { name: "Advanced settings" });
    door.focus();
    await user.keyboard("{Delete}{ArrowRight}");
    expect(door).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Enter}");
    expect(door).toHaveAttribute("aria-expanded", "true");
    expect(editor().deleteClips).not.toHaveBeenCalled();
    expect(editor().setPlayhead).not.toHaveBeenCalled();
    expect(togglePlay).not.toHaveBeenCalled();
    done();
  });

  it("Escape still hides the dialog, once, from a focused radio, and the editor does not also act on it", async () => {
    const { user, onCancel, done } = await mountBoth(true);
    radio("Fast").focus();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(editor().select).not.toHaveBeenCalled();
    done();
  });
});

describe("a key pressed in the 0.28.0 dialog stays in it too (the same hazard, there for its selects)", () => {
  it("Delete on its Resolution select, and the arrows on its Quality select, leave the clip and the playhead alone", async () => {
    const { user, togglePlay, done } = await mountBoth(false);
    h.state.selection = "c1";
    (screen.getByLabelText("resolution") as HTMLSelectElement).focus();
    await user.keyboard("{Delete}{Backspace}");
    (screen.getByLabelText("quality") as HTMLSelectElement).focus();
    await user.keyboard("{ArrowRight}{ArrowLeft} ");
    expect(editor().deleteClips).not.toHaveBeenCalled();
    expect(editor().setPlayhead).not.toHaveBeenCalled();
    expect(togglePlay).not.toHaveBeenCalled();
    done();
  });

  it("Escape hides it, once", async () => {
    const { user, onCancel, done } = await mountBoth(false);
    (screen.getByLabelText("quality") as HTMLSelectElement).focus();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    done();
  });
});
