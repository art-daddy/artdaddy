// The Resolution list of the Export dialog: Same as project, and then only the presets smaller than the project, never one as large as it or larger. The project's size is read from
// two places: the `workload` the dialog is opened with (a snapshot) and the open project's canvas as it is now, which wins where it can be read (the assistant or an MCP client can change
// the size while the dialog is open). A pick the list no longer holds is shown, asked about, estimated and sent as Same as project. The dialog is rendered as the person sees it.
//
// The expected lists come from an oracle written out in this file, never from the code under test: a preset is named by its short side, so it is smaller than the project exactly when
// the number in its name is below the project's short side. The five numbers are the five presets.
import { Profiler } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExportDialog, { type ExportSettings } from "./ExportDialog";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { __resetExportAsk } from "../timeline/exportAsk";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import { EXPORT_SPEED_REVISION, type ExportCalibration } from "../timeline/exportOptions";
import { emptyTimeline, type Timeline } from "../timeline/model";
import type { RenderWorkload } from "../timeline/renderPlan";

vi.mock("../timeline/exportChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/exportChoice")>()),
  decideExportEncoder: vi.fn(),
}));

/** What the app decided about the encoder, as the dialog is told: no chip, so no Mode row. */
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

/** The snapshot the dialog is opened with: a project of this picture size, with the layers of a two-minute edit. */
const project = (width: number, height: number): RenderWorkload => ({
  width,
  height,
  fps: 30,
  durationSeconds: 120,
  visualClips: 6,
  captionClips: 1,
  audioClips: 1,
  peakVisualLayers: 2,
  peakMediaLayers: 2,
});
/** The open project as the editor holds it, with this canvas (a size that cannot be read, NaN, is kept as it is). */
const timelineOf = (width: number, height: number): Timeline => emptyTimeline(width, height, 30);

const dialog = (
  workload: RenderWorkload | null,
  {
    open = true,
    onStart = () => {},
  }: { open?: boolean; onStart?: (s: ExportSettings) => void } = {},
) => <ExportDialog open={open} onCancel={() => {}} onStart={onStart} workload={workload} />;

const select = () => screen.getByLabelText("resolution") as HTMLSelectElement;
/** The Resolution list as the person sees it, top to bottom: each option's value and its words. */
const listed = () =>
  Array.from(select().options).map((option) => ({
    value: option.value,
    words: option.textContent ?? "",
  }));
const values = () => listed().map((option) => option.value);
/** What the list shows as chosen. */
const chosen = () => select().value;
const pick = (value: string) => fireEvent.change(select(), { target: { value } });
const exportNow = () => fireEvent.click(screen.getByRole("button", { name: "Export" }));
/** The app's answers have come in. */
const settle = () => act(async () => undefined);
const estimate = () => screen.getByLabelText("export estimate").textContent;

// ---- the oracle: written out, never asked of the code under test ----
/** All five presets, by the number in their names. */
const PRESETS = [2160, 1440, 1080, 720, 480];
/** What each value of the list is called on screen. */
const WORDS: Record<string, string> = {
  source: "Same as project",
  "2160p": "2160p (4K)",
  "1440p": "1440p",
  "1080p": "1080p",
  "720p": "720p",
  "480p": "480p",
};
/** The number in a preset's own name, which is what it promises: "720p" is 720 and "2160p (4K)" is 2160. */
const numberIn = (name: string): number => Number(/^(\d+)p/.exec(name)?.[1]);
const readable = (width: number, height: number) =>
  Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
/** The values the list must hold for a project: Same as project, then each preset below the short side, largest first. A size that cannot be read has no smaller size. */
const expectedFor = (width: number, height: number): string[] => [
  "source",
  ...(readable(width, height)
    ? PRESETS.filter((side) => side < Math.min(width, height)).map((side) => `${side}p`)
    : []),
];

const CANVASES: [string, number, number][] = [
  ["landscape 1920x1080", 1920, 1080],
  ["vertical 1080x1920", 1080, 1920],
  ["ultrawide 2560x1080", 2560, 1080],
  ["4K 3840x2160", 3840, 2160],
  ["4K cinema 4096x2160", 4096, 2160],
  ["8K 7680x4320", 7680, 4320],
  ["2560x1440", 2560, 1440],
  ["square 1080x1080", 1080, 1080],
  ["1920x1088", 1920, 1088],
  ["1366x768", 1366, 768],
  ["1280x720", 1280, 720],
  ["1281x721", 1281, 721],
  ["854x480", 854, 480],
  ["640x360", 640, 360],
  ["odd 1081x1921", 1081, 1921],
  ["odd 1079x1919", 1079, 1919],
  ["1x1", 1, 1],
  ["unreadable 0x0", 0, 0],
  ["unreadable 1920x0", 1920, 0],
  ["unreadable -1920x-1080", -1920, -1080],
  ["unreadable NaN x NaN", Number.NaN, Number.NaN],
  ["unreadable NaN x 1080", Number.NaN, 1080],
  ["unreadable Infinity x Infinity", Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
];

/** The examples the owner's rule was given in, with the lists they must give. */
const EXAMPLES: [string, number, number, string[]][] = [
  ["a vertical 1080x1920 project", 1080, 1920, ["source", "720p", "480p"]],
  ["a 4K project", 3840, 2160, ["source", "1440p", "1080p", "720p", "480p"]],
  ["an 8K project", 7680, 4320, ["source", "2160p", "1440p", "1080p", "720p", "480p"]],
  ["a 1280x720 project", 1280, 720, ["source", "480p"]],
  ["an 854x480 project", 854, 480, ["source"]],
  ["a 640x360 project, smaller than every preset", 640, 360, ["source"]],
  ["a 1366x768 project", 1366, 768, ["source", "720p", "480p"]],
  [
    "a canvas equal to a preset (1920x1080) does not offer it",
    1920,
    1080,
    ["source", "720p", "480p"],
  ],
  [
    "an odd 1081x1921 canvas, whose short side is 1081",
    1081,
    1921,
    ["source", "1080p", "720p", "480p"],
  ],
];

beforeEach(() => {
  useExportJob.getState().reset();
  useExportJob.getState().setEngine("auto");
  useExportJob.setState({ calibrations: [] });
  useEditor.setState({ timeline: null });
  vi.mocked(decideExportEncoder).mockReset();
  vi.mocked(decideExportEncoder).mockResolvedValue(decision());
});
afterEach(() => {
  useEditor.setState({ timeline: null });
  __resetExportFlags();
  __resetExportAsk();
});

describe("the Resolution list, for the project the dialog is opened on", () => {
  it.each(CANVASES)(
    "%s: Same as project first, then only sizes smaller than the project, the set exact and largest first",
    async (_name, width, height) => {
      render(dialog(project(width, height)));
      await settle();
      const options = listed();
      expect(options[0]).toEqual({ value: "source", words: "Same as project" });
      for (const { value, words } of options.slice(1)) {
        expect(numberIn(words), `${words} is called by the number of ${value}`).toBe(
          numberIn(value),
        );
        expect(numberIn(words), `${words} is not smaller than ${width}x${height}`).toBeLessThan(
          Math.min(width, height),
        );
      }
      // none missing, none extra, none out of order
      expect(options.map((option) => option.value)).toEqual(expectedFor(width, height));
      // nothing larger than the project is listed, so there is nothing for a note about upscaling to say
      expect(screen.queryByText(/never upscales/i)).toBeNull();
      expect(document.body.textContent).not.toMatch(/upscal/i);
    },
  );

  it.each(EXAMPLES)("%s", async (_name, width, height, expected) => {
    render(dialog(project(width, height)));
    await settle();
    expect(values()).toEqual(expected);
    expect(listed().map((option) => option.words)).toEqual(expected.map((value) => WORDS[value]));
  });

  it("offers Same as project alone, and Export sends it, with no project and no timeline", () => {
    const onStart = vi.fn();
    render(dialog(null, { onStart }));
    expect(listed()).toEqual([{ value: "source", words: "Same as project" }]);
    expect(document.body.textContent).not.toMatch(/upscal/i);
    exportNow();
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ resolution: "source" }));
  });
});

describe("the list follows the project's size while the dialog is open", () => {
  it("follows a new workload given to the dialog", async () => {
    const view = render(dialog(project(1920, 1080)));
    await settle();
    expect(values()).toEqual(["source", "720p", "480p"]);
    view.rerender(dialog(project(3840, 2160)));
    await settle();
    expect(values()).toEqual(["source", "1440p", "1080p", "720p", "480p"]);
    view.rerender(dialog(project(1280, 720)));
    await settle();
    expect(values()).toEqual(["source", "480p"]);
    view.rerender(dialog(null));
    expect(values()).toEqual(["source"]);
  });

  it("follows the open project's canvas as it is now, which wins over the workload the dialog was opened with", async () => {
    render(dialog(project(1920, 1080)));
    await settle();
    expect(values()).toEqual(["source", "720p", "480p"]);
    // the assistant makes the project 4K, and then 720p
    act(() => {
      useEditor.setState({ timeline: timelineOf(3840, 2160) });
    });
    expect(values()).toEqual(["source", "1440p", "1080p", "720p", "480p"]);
    act(() => {
      useEditor.setState({ timeline: timelineOf(1280, 720) });
    });
    expect(values()).toEqual(["source", "480p"]);
    // no project open any more: the snapshot is what there is
    act(() => {
      useEditor.setState({ timeline: null });
    });
    expect(values()).toEqual(["source", "720p", "480p"]);
    await settle();
  });

  it.each([
    ["NaN x NaN", Number.NaN, Number.NaN],
    ["0x0", 0, 0],
    ["1920x0", 1920, 0],
    ["-1920x-1080", -1920, -1080],
    ["Infinity x Infinity", Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  ])(
    "goes by the snapshot where the open project's canvas cannot be read (%s)",
    async (_name, width, height) => {
      useEditor.setState({ timeline: timelineOf(width, height) });
      render(dialog(project(1920, 1080)));
      await settle();
      expect(values()).toEqual(["source", "720p", "480p"]);
    },
  );

  it("goes by the open project's canvas where there is no snapshot, and offers Same as project alone where neither can be read", async () => {
    const view = render(dialog(null));
    expect(values()).toEqual(["source"]);
    act(() => {
      useEditor.setState({ timeline: timelineOf(1280, 720) });
    });
    expect(values()).toEqual(["source", "480p"]);
    act(() => {
      useEditor.setState({ timeline: timelineOf(Number.NaN, Number.NaN) });
    });
    expect(values()).toEqual(["source"]);
    view.rerender(dialog(project(Number.NaN, 1080)));
    await settle();
    expect(values()).toEqual(["source"]);
  });

  it("draws again when the project's width or height changes, and not for any other change to the project", () => {
    let draws = 0;
    render(
      <Profiler id="export-dialog" onRender={() => void (draws += 1)}>
        {dialog(null)}
      </Profiler>,
    );
    act(() => {
      useEditor.setState({ timeline: timelineOf(1920, 1080) });
    });
    expect(values()).toEqual(["source", "720p", "480p"]);
    const settled = draws;
    // an edit: a new timeline object, with a track on it, at the same size
    act(() => {
      useEditor.setState({
        timeline: {
          ...timelineOf(1920, 1080),
          tracks: [{ id: "v1", kind: "video", z: 0, clips: [] }],
        },
      });
    });
    expect(draws).toBe(settled);
    act(() => {
      useEditor.setState({ timeline: timelineOf(1280, 720) });
    });
    expect(draws).toBeGreaterThan(settled);
    expect(values()).toEqual(["source", "480p"]);
  });
});

type Channel = "workload" | "store";
/** The two ways the project's size changes while the dialog is open: a new workload (the dialog is opened again on the project) and the editor's own canvas (the assistant or an MCP client
 *  resizes the project, and the workload stays the snapshot taken when the dialog opened). */
const CHANNELS: [string, Channel][] = [
  ["a new workload", "workload"],
  ["the editor's own canvas", "store"],
];

/** A dialog opened on a project of this size, and the way its size changes while it is open. */
async function openOn(channel: Channel, width: number, height: number) {
  const onStart = vi.fn();
  if (channel === "store") useEditor.setState({ timeline: timelineOf(width, height) });
  const view = render(dialog(project(width, height), { onStart }));
  await settle();
  const resize = async (to: { width: number; height: number }) => {
    if (channel === "store") {
      act(() => {
        useEditor.setState({ timeline: timelineOf(to.width, to.height) });
      });
    } else {
      view.rerender(dialog(project(to.width, to.height), { onStart }));
    }
    await settle();
  };
  return { onStart, resize };
}

describe.each(CHANNELS)(
  "the person's pick, when the project's size changes by %s",
  (_name, channel) => {
    it("is kept while it is still on offer", async () => {
      const { onStart, resize } = await openOn(channel, 1920, 1080);
      pick("720p");
      expect(chosen()).toBe("720p");
      await resize({ width: 1366, height: 768 });
      expect(values()).toEqual(["source", "720p", "480p"]);
      expect(chosen()).toBe("720p");
      exportNow();
      expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: "720p" }));
    });

    it("is kept where the list shrinks around it, and falls back to Same as project once the list has no place for it", async () => {
      const { onStart, resize } = await openOn(channel, 3840, 2160);
      pick("720p");
      await resize({ width: 1920, height: 1080 });
      expect(values()).toEqual(["source", "720p", "480p"]);
      expect(chosen()).toBe("720p");
      exportNow();
      expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: "720p" }));
      await resize({ width: 1280, height: 720 });
      expect(values()).toEqual(["source", "480p"]);
      expect(chosen()).toBe("source");
      exportNow();
      expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: "source" }));
    });

    it("falls back to Same as project when it is no longer on offer, is sent as that, and does not come back when the project grows again", async () => {
      const { onStart, resize } = await openOn(channel, 1920, 1080);
      pick("720p");
      await resize({ width: 1280, height: 720 });
      expect(values()).toEqual(["source", "480p"]);
      expect(chosen()).toBe("source");
      exportNow();
      expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: "source" }));
      await resize({ width: 1920, height: 1080 });
      expect(values()).toEqual(["source", "720p", "480p"]);
      expect(chosen()).toBe("source");
      exportNow();
      expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: "source" }));
    });

    it("falls back when the project becomes exactly as large as the size picked: nothing is offered at the project's own size", async () => {
      const { onStart, resize } = await openOn(channel, 3840, 2160);
      pick("1080p");
      expect(chosen()).toBe("1080p");
      await resize({ width: 1920, height: 1080 });
      expect(values()).toEqual(["source", "720p", "480p"]);
      expect(chosen()).toBe("source");
      exportNow();
      expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: "source" }));
    });

    // The app is asked in the effects of the draw the new size came with, so a draw that still held the old pick would put it to the app: no question is ever about a size the project cannot give.
    it("never asks the app about a size the project cannot give, through a shrink and a growth", async () => {
      // The project's size at the moment of each question, read here and not by the dialog: the open project's canvas where it can be read, else the workload that is asked about.
      const asked: { size: string; width: number; height: number }[] = [];
      vi.mocked(decideExportEncoder).mockImplementation(async (question) => {
        const live = useEditor.getState().timeline?.canvas;
        const there = live && readable(live.width, live.height) ? live : question.workload;
        asked.push({
          size: question.settings.resolution ?? "source",
          width: there.width,
          height: there.height,
        });
        return decision();
      });
      const { resize } = await openOn(channel, 3840, 2160);
      pick("720p");
      await resize({ width: 1280, height: 720 });
      await resize({ width: 3840, height: 2160 });
      pick("1080p");
      await resize({ width: 1920, height: 1080 });
      expect(asked.length).toBeGreaterThanOrEqual(3); // as it opened, as 720p was picked, and once the pick fell back
      for (const { size, width, height } of asked)
        expect(
          expectedFor(width, height),
          `${size} was asked about for a ${width}x${height} project`,
        ).toContain(size);
      // and the latest question stands for the project as it is now (1920x1080), not for the size picked before it shrank
      expect(expectedFor(1920, 1080)).toContain(asked.at(-1)?.size);
    });
  },
);

describe("the pick, across openings of the dialog", () => {
  it("is kept across a close and an opening on the same project", async () => {
    const onStart = vi.fn();
    const view = render(dialog(project(1920, 1080), { onStart }));
    await settle();
    pick("720p");
    view.rerender(dialog(project(1920, 1080), { open: false, onStart }));
    view.rerender(dialog(project(1920, 1080), { onStart }));
    await settle();
    expect(values()).toEqual(["source", "720p", "480p"]);
    expect(chosen()).toBe("720p");
    exportNow();
    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: "720p" }));
  });

  it("falls back by the same rule when it is opened again on a smaller project, and a bigger one later does not bring it back", async () => {
    const onStart = vi.fn();
    const view = render(dialog(project(1920, 1080), { onStart }));
    await settle();
    pick("720p");
    view.rerender(dialog(project(1920, 1080), { open: false, onStart }));
    view.rerender(dialog(project(1280, 720), { onStart }));
    await settle();
    expect(values()).toEqual(["source", "480p"]);
    expect(chosen()).toBe("source");
    exportNow();
    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: "source" }));
    view.rerender(dialog(project(1920, 1080), { onStart }));
    await settle();
    expect(chosen()).toBe("source");
  });

  it("falls back when the project's canvas changed while the dialog was closed", async () => {
    useEditor.setState({ timeline: timelineOf(1920, 1080) });
    const onStart = vi.fn();
    const view = render(dialog(project(1920, 1080), { onStart }));
    await settle();
    pick("720p");
    view.rerender(dialog(project(1920, 1080), { open: false, onStart }));
    act(() => {
      useEditor.setState({ timeline: timelineOf(1280, 720) });
    });
    view.rerender(dialog(project(1280, 720), { onStart }));
    await settle();
    expect(values()).toEqual(["source", "480p"]);
    expect(chosen()).toBe("source");
    exportNow();
    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: "source" }));
  });

  it("falls back to Same as project, the one size left, when it is opened again with no project", async () => {
    useEditor.setState({ timeline: timelineOf(1920, 1080) });
    const onStart = vi.fn();
    const view = render(dialog(project(1920, 1080), { onStart }));
    await settle();
    pick("720p");
    view.rerender(dialog(project(1920, 1080), { open: false, onStart }));
    act(() => {
      useEditor.setState({ timeline: null });
    });
    view.rerender(dialog(null, { onStart }));
    await settle();
    expect(values()).toEqual(["source"]);
    expect(chosen()).toBe("source");
    exportNow();
    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: "source" }));
  });
});

// What is estimated and what the app is asked about follow what is on screen: after a fallback, Same as project, never the size the list no longer holds.
describe("the estimate and the app's question, after a pick has fallen back", () => {
  beforeEach(() => __setExportFlag("estimate_v2", false));

  const measured = (
    output: { width: number; height: number },
    elapsedSeconds: number,
    finalBytes: number,
  ): ExportCalibration => ({
    workload: project(1920, 1080),
    output: { ...output, fps: 30 },
    quality: "medium",
    engine: "file-sequence-v1",
    encoder: "x264-crf",
    revision: EXPORT_SPEED_REVISION,
    elapsedSeconds,
    finalBytes,
    memoryBytes: null,
    temporaryBytes: null,
  });
  const askedAbout = () =>
    vi.mocked(decideExportEncoder).mock.calls.map(([question]) => question.settings.resolution);

  it("are for Same as project, and the app is never asked about a size that is not on offer", async () => {
    useExportJob.setState({
      calibrations: [
        measured({ width: 1920, height: 1080 }, 150, 48_000_000),
        measured({ width: 1280, height: 720 }, 70, 20_000_000),
      ],
    });
    const view = render(dialog(project(1920, 1080)));
    pick("720p");
    await settle();
    expect(estimate()).toContain("about 1 min, a file of about 20 MB");
    expect(askedAbout().at(-1)).toBe("720p");
    const before = askedAbout().length;

    // the project is made 1280x720 meanwhile: no 720p is on offer any more
    act(() => {
      useEditor.setState({ timeline: timelineOf(1280, 720) });
    });
    await settle();
    expect(values()).toEqual(["source", "480p"]);
    expect(chosen()).toBe("source");
    expect(askedAbout().length).toBeGreaterThan(before);
    expect(askedAbout().slice(before)).not.toContain("720p");
    expect(askedAbout().at(-1)).toBe("source");
    const afterFallback = estimate();
    expect(afterFallback).not.toContain("a file of about 20 MB");

    // the line says what a dialog opened on the same project, with nothing picked, says
    view.unmount();
    render(dialog(project(1920, 1080)));
    expect(estimate()).toBe(afterFallback);
  });

  it("are asked and sent for the size picked while it is on offer", async () => {
    const onStart = vi.fn();
    render(dialog(project(3840, 2160), { onStart }));
    pick("1080p");
    await settle();
    expect(askedAbout().at(-1)).toBe("1080p");
    exportNow();
    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: "1080p" }));
    expect(values()).toEqual(["source", "1440p", "1080p", "720p", "480p"]);
  });
});
