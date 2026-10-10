import { getIdentifier } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  exists,
  mkdir,
  readFile,
  readDir,
  rename,
  stat,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

import RecordDialog from "../../src/components/RecordDialog";
import SourceMonitor from "../../src/components/SourceMonitor";
import { highH264DecodesCorrectly } from "../../src/preview/h264Support";
import { clearSourceUrlCache, resolvePreviewUrl } from "../../src/preview/resolve";
import { VideoSource } from "../../src/preview/videoSource";
import { projectDocuments } from "../../src/project/documentRegistry";
import { asProjectId } from "../../src/project/types";
import { useEditor } from "../../src/store/editor";
import { IndexCoordinator } from "../../src/store/indexCoordinator";
import { useProjects } from "../../src/store/projects";
import { addClipsTool } from "../../src/timeline/placement";
import { setCanvasTool } from "../../src/timeline/ops";
import { exportTimelineTool } from "../../src/timeline/render";
import { whenExportEnds } from "../../src/timeline/exportQueue";
import { joinPath } from "../../src/tools/store";
import { makeTauriContext } from "../../src/tools/tauri";
import "../../src/index.css";

type Result = Record<string, unknown>;
const report: Result = { userAgent: navigator.userAgent, steps: [] as string[] };
const rootPath = new URLSearchParams(location.search).get("root") ?? "";
let step = "admission";

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function bounded<T>(work: Promise<T>, label: string, ms = 60_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function domReady<T>(find: () => T | null): Promise<T> {
  return bounded(
    new Promise<T>((resolve) => {
      const observer = new MutationObserver(() => inspect());
      const inspect = () => {
        const found = find();
        if (found) {
          observer.disconnect();
          resolve(found);
        }
      };
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      inspect();
    }),
    "native UI",
  );
}

function button(label: string): Promise<HTMLButtonElement> {
  return domReady(
    () =>
      [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === label && !entry.disabled,
      ) ?? null,
  );
}

async function pixels(url: string, seconds: number): Promise<number[]> {
  const source = new VideoSource(url);
  try {
    await bounded(source.whenReady(), "native recording index");
    const frame = await bounded(source.frameAt(seconds), "native recorded frame");
    check(frame, `No recorded frame at ${seconds}s`);
    const canvas = document.createElement("canvas");
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    check(context, "No canvas for native recording pixels");
    context.drawImage(frame, 0, 0);
    const color = [...context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data].slice(
      0,
      3,
    );
    await writeFile(
      joinPath(rootPath, `preview-${seconds}.png`),
      new Uint8Array(
        await (
          await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (blob) => (blob ? resolve(blob) : reject(new Error("No preview PNG"))),
              "image/png",
            );
          })
        ).arrayBuffer(),
      ),
    );
    return color;
  } finally {
    source.close();
  }
}

async function run(): Promise<void> {
  check(
    (await getIdentifier()) === "com.artdaddy.qa.mac-hotfix",
    "Refusing QA in the user's app instance",
  );
  check(rootPath.includes("artdaddy-mac-hotfix-"), "Refusing a non-QA output folder");
  await mkdir(rootPath, { recursive: true });
  const mark = (name: string) => {
    step = name;
    (report.steps as string[]).push(name);
  };

  mark("hidden-stage-exists");
  const stagePath = joinPath(rootPath, ".test_28764f.mp4.w9t626.partial");
  const committedPath = joinPath(rootPath, "scope-check.mp4");
  const stageRun = await makeTauriContext(rootPath).runner.run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=160x120:r=30:d=0.1",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "mp4",
    stagePath,
  ]);
  check(stageRun.code === 0, `Native staging encode failed: ${stageRun.stderr}`);
  check(await exists(stagePath), "The native fs plugin refused the hidden export staging file");
  const witness = await readFile(stagePath);
  check(witness.length > 1000, "Native staging encode produced no content");
  check((await stat(stagePath)).size === witness.length, "The stage has wrong bytes");
  await rename(stagePath, committedPath);
  check(!(await exists(stagePath)), "The hidden staging file survived commit");
  check(
    [...(await readFile(committedPath))].join() === [...witness].join(),
    "Native commit changed the bytes",
  );
  report.nativeFs = { stageExists: true, stageGoneAfterRename: true, bytes: witness.length };

  mark("open-disposable-project");
  const project = await useProjects
    .getState()
    .create("Mac Hotfix QA", "1:1", 30, joinPath(rootPath, "projects"));
  await useProjects.getState().open(project.id);
  const doc = await projectDocuments.open(asProjectId(project.id));
  check(doc.phase() === "open", "QA document did not open");
  const projectDir = useEditor.getState().store!.projectDir;
  const ctx = makeTauriContext(projectDir);
  useEditor.getState()._index?.dispose();
  check(
    ((await setCanvasTool({ width: 640, height: 480, fps: 30 }, ctx)) as Result).ok,
    "Canvas edit failed",
  );
  const nativeH264 = await highH264DecodesCorrectly();
  report.nativeH264 = nativeH264;

  mark("record-stop-and-save");
  const capture = document.createElement("canvas");
  capture.width = 640;
  capture.height = 480;
  const paint = capture.getContext("2d")!;
  let started = Infinity;
  let painting = true;
  const draw = () => {
    if (!painting) return;
    paint.fillStyle = performance.now() - started < 1000 ? "rgb(220,30,30)" : "rgb(25,205,50)";
    paint.fillRect(0, 0, capture.width, capture.height);
    requestAnimationFrame(draw);
  };
  draw();
  const audio = new AudioContext({ sampleRate: 48000 });
  const tone = audio.createOscillator();
  const gain = audio.createGain();
  gain.gain.value = 0.2;
  const sound = audio.createMediaStreamDestination();
  tone.connect(gain).connect(sound);
  tone.start();
  await bounded(audio.resume(), "native recording audio", 10_000);
  const originalDevices = navigator.mediaDevices;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () =>
        new MediaStream([
          ...capture.captureStream(30).getVideoTracks(),
          ...sound.stream.getAudioTracks(),
        ]),
      enumerateDevices: async () => [
        { deviceId: "qa-camera", label: "Synthetic QA camera", kind: "videoinput", groupId: "qa" },
        { deviceId: "qa-mic", label: "Synthetic QA microphone", kind: "audioinput", groupId: "qa" },
      ],
    },
  });
  const ui = createRoot(window.document.getElementById("root")!);
  let saved!: () => void;
  const stopped = new Promise<void>((resolve) => {
    saved = resolve;
  });
  ui.render(createElement(RecordDialog, { open: true, projectDir, onClose: () => saved() }));
  try {
    const recordButton = await button("Record");
    started = performance.now();
    recordButton.click();
    await domReady(() => (window.document.body.textContent?.includes("0:03") ? true : null));
    (await button("Stop & save")).click();
    await bounded(stopped, "Stop & save");
  } finally {
    painting = false;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalDevices,
    });
    tone.stop();
    await audio.close();
  }
  const recorded = (await ctx.store.listClips()).find((entry) => {
    const source = entry.source;
    return (
      source !== null &&
      typeof source === "object" &&
      "kind" in source &&
      source.kind === "recording"
    );
  });
  check(recorded, "RecordDialog reported success without a recording in the library");
  const original = (await ctx.store.resolveRef(recorded.id))!;
  const originalBytes = await readFile(original);
  check(originalBytes.length > 1000, "The captured recording is empty");
  const catalogBefore = await ctx.store.listClips();
  report.recording = {
    mediaRef: recorded.id,
    filename: recorded.filename,
    size: originalBytes.length,
    path: original,
  };

  mark("native-preview-arrival-race");
  clearSourceUrlCache();
  const originalExists = ctx.store.exists.bind(ctx.store);
  let releaseOld!: () => void;
  let entered!: () => void;
  let intercept = true;
  const enteredLookup = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const oldLookup = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  ctx.store.exists = async (path) => {
    const found = await originalExists(path);
    if (intercept && path.endsWith(".r4.mp4")) {
      intercept = false;
      check(!found, "The race fixture already had a proxy");
      entered();
      await oldLookup;
    }
    return found;
  };
  const pending = resolvePreviewUrl(ctx.store, recorded.id);
  await bounded(enteredLookup, "pre-arrival native filesystem lookup");
  ui.render(createElement(SourceMonitor, { mediaRef: recorded.id }));
  let derived!: () => void;
  const indexed = new Promise<void>((resolve) => {
    derived = resolve;
  });
  const index = new IndexCoordinator(
    ctx.store,
    () => ctx.runner,
    () => {
      const timeline = useEditor.getState().timeline;
      if (timeline) useEditor.setState({ timeline: { ...timeline } });
      derived();
    },
    () => {},
  );
  useEditor.setState({ _index: index });
  await index.sweep(useEditor.getState().timeline!);
  await bounded(indexed, "shared recording normalization");
  const readyUrl = await resolvePreviewUrl(ctx.store, recorded.id);
  check(readyUrl, "Recording preview was unresolved after derivation");
  releaseOld();
  check(
    (await bounded(pending, "superseded native lookup")) === readyUrl,
    "Old lookup returned an obsolete recording preview",
  );
  check(
    (await resolvePreviewUrl(ctx.store, recorded.id)) === readyUrl,
    "Old lookup poisoned the preview cache",
  );
  const player = await domReady(() => window.document.querySelector("video"));
  check(player.src === readyUrl, "Source Monitor did not pick up the ready recording");
  await bounded(
    new Promise<void>((resolve, reject) => {
      if (player.readyState >= HTMLMediaElement.HAVE_METADATA) resolve();
      else {
        player.addEventListener("loadedmetadata", () => resolve(), { once: true });
        player.addEventListener(
          "error",
          () => reject(new Error(`Source Monitor decode failed: ${player.error?.message}`)),
          { once: true },
        );
      }
    }),
    "Source Monitor metadata",
  );
  const monitorColors: number[][] = [];
  const presentedTimes: number[] = [];
  player.muted = true;
  for (const seconds of [0.4, 2]) {
    let frameCallback = 0;
    try {
      await bounded(
        new Promise<void>((resolve, reject) => {
          const presented = (_now: number, metadata: VideoFrameCallbackMetadata) => {
            if (Math.abs(metadata.mediaTime - seconds) <= 0.1) {
              presentedTimes.push(metadata.mediaTime);
              resolve();
            } else {
              frameCallback = player.requestVideoFrameCallback(presented);
            }
          };
          frameCallback = player.requestVideoFrameCallback(presented);
          player.currentTime = seconds;
          void player.play().catch(reject);
        }),
        "Source Monitor presented frame",
      );
    } finally {
      player.pause();
      player.cancelVideoFrameCallback(frameCallback);
    }
    const picture = window.document.createElement("canvas");
    picture.width = 16;
    picture.height = 16;
    const context = picture.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(player, 0, 0, 16, 16);
    monitorColors.push([...context.getImageData(8, 8, 1, 1).data].slice(0, 3));
  }
  report.previewAttempt = { sourceMonitorColors: monitorColors, presentedTimes, url: readyUrl };
  const early = await pixels(readyUrl, 0.4);
  const late = await pixels(readyUrl, 2.0);
  report.previewAttempt = {
    sourceMonitorColors: monitorColors,
    presentedTimes,
    early,
    late,
    url: readyUrl,
  };
  check(
    monitorColors[0][0] > monitorColors[0][1] + 80,
    "Source Monitor did not show the red recorded frame",
  );
  check(
    monitorColors[1][1] > monitorColors[1][0] + 80,
    "Source Monitor did not show the green recorded frame",
  );
  check(early[0] > early[1] + 80, `Early recording is not red: ${early}`);
  check(late[1] > late[0] + 80, `Late recording is not green: ${late}`);
  check(
    JSON.stringify(await ctx.store.listClips()) === JSON.stringify(catalogBefore),
    "Normalization changed the library document",
  );
  const after = await readFile(original);
  check(
    originalBytes.every((value, offset) => value === after[offset]) &&
      after.length === originalBytes.length,
    "Normalization changed the source recording",
  );
  report.preview = {
    early,
    late,
    sourceMonitorColors: monitorColors,
    sourceMonitorReady: true,
    oldLookupRecovered: true,
    url: readyUrl,
  };

  mark("real-export-with-hidden-staging");
  const added = (await addClipsTool(
    { entries: [{ media_ref: recorded.id, track_id: "v1", timeline_in: 0, timeline_out: 90 }] },
    ctx,
  )) as Result;
  check(added.ok, `Recording placement failed: ${JSON.stringify(added)}`);
  const output = joinPath(rootPath, "test_28764f.mp4");
  const submitted = (await exportTimelineTool({ output_path: output }, ctx)) as Result;
  check(submitted.ok, `Export submission failed: ${JSON.stringify(submitted)}`);
  const ended = await bounded(whenExportEnds(String(submitted.job_id)), "native recording export");
  check(ended?.state === "done", `Native export failed: ${JSON.stringify(ended)}`);
  check(await exists(output), "Export was done without a delivered file");
  const probe = await ctx.runner.run("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    output,
  ]);
  check(probe.code === 0, probe.stderr);
  const metadata = JSON.parse(probe.stdout) as {
    format: { duration: string; size: string };
    streams: Array<{ codec_type: string; sample_rate?: string }>;
  };
  check(Number(metadata.format.duration) >= 2.9, "Native export is truncated");
  check(
    metadata.streams.some((stream) => stream.codec_type === "video"),
    "Native export has no picture",
  );
  check(
    metadata.streams.some(
      (stream) => stream.codec_type === "audio" && stream.sample_rate === "48000",
    ),
    "Native export has no 48 kHz sound",
  );
  const exportedColors: number[][] = [];
  for (const seconds of [0.4, 2]) {
    const framePath = joinPath(rootPath, `export-${seconds}.rgb`);
    const decoded = await ctx.runner.run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-ss",
      String(seconds),
      "-i",
      output,
      "-vf",
      "scale=1:1:flags=area",
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      framePath,
    ]);
    check(decoded.code === 0, `Export pixel decode failed: ${decoded.stderr}`);
    const color = [...(await readFile(framePath))];
    check(color.length === 3, `Export has no frame at ${seconds}s`);
    exportedColors.push(color);
  }
  check(exportedColors[0][0] > exportedColors[0][1] + 80, "Delivered recording lost its red frame");
  check(
    exportedColors[1][1] > exportedColors[1][0] + 80,
    "Delivered recording lost its green frame",
  );
  const volume = await ctx.runner.run("ffmpeg", [
    "-i",
    output,
    "-vn",
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(volume.stderr);
  check(volume.code === 0 && mean && Number(mean[1]) > -50, "Delivered recording is silent");
  const leftover = (await readDir(rootPath)).filter((entry) => entry.name.endsWith(".partial"));
  check(leftover.length === 0, "Native export left a partial deliverable");
  report.export = {
    output,
    size: Number(metadata.format.size),
    duration: Number(metadata.format.duration),
    metadata,
    colors: exportedColors,
    meanVolumeDb: Number(mean[1]),
    partials: 0,
  };
  ui.unmount();
  check((await projectDocuments.close(asProjectId(project.id))).ok, "QA document failed to close");
  report.ok = true;
}

void run()
  .catch((error) => {
    report.ok = false;
    report.failedAt = step;
    report.error =
      error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  })
  .finally(async () => {
    await writeTextFile(joinPath(rootPath, "report.tmp"), JSON.stringify(report, null, 2));
    await rename(joinPath(rootPath, "report.tmp"), joinPath(rootPath, "report.json"));
    await getCurrentWindow().close();
  });
