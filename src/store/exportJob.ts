// Where a running export publishes itself.
//
// The render happens inside the tool host, several layers below React, and the export dialog is a
// component that can be dismissed and reopened while the job keeps going. Rather than thread a
// callback down through the tool context, a render announces itself here and the UI subscribes.
// One job at a time, matching the one ffmpeg process.
import { create } from "zustand";
import type { ExportCalibration, ExportEngine, ExportMode } from "../timeline/exportOptions";
import type { LiveFacts, LiveStageName } from "../timeline/exportWords";

const ENGINE_KEY = "artdaddy-export-routing-v2";
// Not per release: a measurement stays usable until EXPORT_SPEED_REVISION says the pipeline changed.
const CALIBRATION_KEY = "artdaddy-export-calibration-v4";

function calibration(value: unknown): ExportCalibration | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    !raw.workload ||
    typeof raw.workload !== "object" ||
    !raw.output ||
    typeof raw.output !== "object"
  )
    return null;
  const workload = raw.workload as Record<string, unknown>;
  const output = raw.output as Record<string, unknown>;
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const keys = [
    "width",
    "height",
    "fps",
    "durationSeconds",
    "visualClips",
    "captionClips",
    "audioClips",
    "peakVisualLayers",
    "peakMediaLayers",
  ] as const;
  if (
    keys.some((key) => number(workload[key]) === null) ||
    ["width", "height", "fps"].some((key) => !number(output[key]))
  )
    return null;
  if (
    !number(workload.width) ||
    !number(workload.height) ||
    !number(workload.fps) ||
    !number(workload.durationSeconds) ||
    !number(raw.elapsedSeconds) ||
    !number(raw.finalBytes) ||
    !["high", "medium", "low"].includes(String(raw.quality)) ||
    !["file-sequence-v1", "partition-pipes-v1"].includes(String(raw.engine)) ||
    (raw.encoder !== undefined &&
      !["x264-crf", "x264-crf-threads2", "amf-cqp18"].includes(String(raw.encoder)))
  )
    return null;
  const revision = number(raw.revision);
  // The setting the export ran at, when it was below the normal one (exportPlan.ts): what its peak means
  // depends on it, so a measurement that loses it is worse than none.
  const rung = raw.rung === 1 || raw.rung === 2 ? raw.rung : null;
  return {
    workload: Object.fromEntries(
      keys.map((key) => [key, workload[key]]),
    ) as unknown as ExportCalibration["workload"],
    output: { width: Number(output.width), height: Number(output.height), fps: Number(output.fps) },
    quality: String(raw.quality),
    engine: raw.engine as ExportEngine,
    encoder:
      raw.encoder === "amf-cqp18"
        ? "amf-cqp18"
        : raw.encoder === "x264-crf-threads2"
          ? "x264-crf-threads2"
          : "x264-crf",
    ...(revision === null ? {} : { revision }),
    ...(rung === null ? {} : { rung }),
    elapsedSeconds: Number(raw.elapsedSeconds),
    finalBytes: Number(raw.finalBytes),
    memoryBytes: number(raw.memoryBytes),
    temporaryBytes: number(raw.temporaryBytes),
  };
}

function savedCalibrations(): ExportCalibration[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CALIBRATION_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw
          .slice(-24)
          .map(calibration)
          .filter((sample): sample is ExportCalibration => sample !== null)
      : [];
  } catch {
    return [];
  }
}

function savedEngine(): ExportEngine {
  try {
    const saved = localStorage.getItem(ENGINE_KEY);
    return saved === "partition-pipes-v1" || saved === "file-sequence-v1" ? saved : "auto";
  } catch {
    return "auto";
  }
}

export type ExportPhase = "idle" | "preparing" | "rendering" | "done" | "failed" | "cancelled";

export interface ExportJob {
  phase: ExportPhase;
  /** 0..1, or null while ffmpeg has not reported a position yet. */
  fraction: number | null;
  /** Seconds remaining, or null when there is not enough information to say. */
  etaSec: number | null;
  /** Encoding rate as a multiple of realtime. */
  speed: number;
  frame: number;
  /** Where it landed, once it has. */
  savedTo: string | null;
  error: string | null;
  startedAt: number;
}

const IDLE: ExportJob = {
  phase: "idle",
  fraction: null,
  etaSec: null,
  speed: 0,
  frame: 0,
  savedTo: null,
  error: null,
  startedAt: 0,
};

/** The export that is running right now, whoever asked for it: what the chat card shows. Unlike the job
 *  above (begun by the Export menu only, so an export an assistant started never moved it) this is begun
 *  by the queue when an export's turn comes, and ended when it settles. */
export interface ExportLive extends LiveFacts {
  readonly jobId: string;
  readonly speed: number;
  readonly frame: number;
}

interface ExportState extends ExportJob {
  /** The export that is rendering right now: progress reports are about this one. */
  live: ExportLive | null;
  /** Exports whose render has ended but which have not settled (the file is being checked or saved) when
   *  the next export's turn begins: each keeps its own stage, so the card can still say where it is. */
  finishing: Readonly<Record<string, ExportLive>>;
  calibrations: readonly ExportCalibration[];
  rememberCalibration: (sample: ExportCalibration) => void;
  engine: ExportEngine;
  setEngine: (engine: ExportEngine) => void;
  mode: ExportMode;
  setMode: (mode: ExportMode) => void;
  /** Set while a render is in flight, so the dialog can offer Cancel. */
  abort: (() => void) | null;
  begin: (abort: (() => void) | null) => void;
  /** A progress report. Moves the dialog's job while that job is running, and the live feed whenever
   *  an export is live. `step` and `steps` say which part of a streamed render this is. */
  update: (patch: Partial<ExportJob> & { step?: number | null; steps?: number | null }) => void;
  finish: (patch: Partial<ExportJob>) => void;
  reset: () => void;
  beginLive: (jobId: string) => void;
  setLiveStage: (jobId: string, stage: LiveStageName) => void;
  endLive: (jobId: string) => void;
}

export const useExportJob = create<ExportState>((set, get) => ({
  ...IDLE,
  live: null,
  finishing: {},
  calibrations: savedCalibrations(),
  rememberCalibration: (value) => {
    const sample = calibration(value);
    if (!sample) return;
    const calibrations = [...get().calibrations, sample].slice(-24);
    try {
      localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibrations));
    } catch {}
    set({ calibrations });
  },
  engine: savedEngine(),
  mode: "quality",
  setMode: (mode) => set({ mode: mode === "fast" ? "fast" : "quality" }),
  setEngine: (engine) => {
    const selected =
      engine === "partition-pipes-v1" || engine === "auto" ? engine : "file-sequence-v1";
    try {
      localStorage.setItem(ENGINE_KEY, selected);
    } catch {}
    set({ engine: selected });
  },
  abort: null,
  begin: (abort) => set({ ...IDLE, phase: "preparing", startedAt: Date.now(), abort }),
  // Progress must never resurrect a job that already finished: ffmpeg's last blocks can arrive
  // after the process exits, and a bar that jumps back to 90% after saying "done" reads as a bug.
  update: (patch) =>
    set((s) => {
      const { step, steps, ...job } = patch;
      const moved = s.phase === "preparing" || s.phase === "rendering" ? { ...s, ...job } : s;
      return s.live ? { ...moved, live: advanced(s.live, patch, Date.now()) } : moved;
    }),
  finish: (patch) => set((s) => ({ ...s, ...patch, abort: null })),
  reset: () => set({ ...IDLE, abort: null }),
  beginLive: (jobId) => {
    const now = Date.now();
    set((s) => ({
      live: {
        jobId,
        stage: "preparing",
        startedAt: now,
        fraction: null,
        etaSec: null,
        speed: 0,
        frame: 0,
        step: null,
        steps: null,
        lastMoveAt: now,
      },
      // The one that was rendering is not any more, but it has not settled: it may still be checking the
      // file or saving it, and it keeps saying so. The next turn only comes once its render process is
      // over (even one that failed or was stopped, which never said "checking"), so it is never left
      // looking like a render that stands still.
      finishing:
        s.live && s.live.jobId !== jobId
          ? {
              ...s.finishing,
              [s.live.jobId]: {
                ...s.live,
                stage:
                  s.live.stage === "preparing" || s.live.stage === "rendering"
                    ? "checking"
                    : s.live.stage,
              },
            }
          : s.finishing,
    }));
  },
  // A word about an export is about that export, whether it is the one rendering or one finishing; a word
  // about one that already settled is about nothing.
  setLiveStage: (jobId, stage) =>
    set((s) => {
      const now = Date.now();
      if (s.live && s.live.jobId === jobId) return { live: { ...s.live, stage, lastMoveAt: now } };
      const other = s.finishing[jobId];
      return other
        ? { finishing: { ...s.finishing, [jobId]: { ...other, stage, lastMoveAt: now } } }
        : s;
    }),
  endLive: (jobId) =>
    set((s) => {
      const ending = s.live !== null && s.live.jobId === jobId;
      if (!ending && !(jobId in s.finishing)) return s;
      const rest = { ...s.finishing };
      delete rest[jobId];
      return { live: ending ? null : s.live, finishing: rest };
    }),
}));

/** What is known about an export's run: the feed of the one rendering, or of one that is finishing. */
export function liveFeedOf(
  state: Pick<ExportState, "live" | "finishing">,
  jobId: string,
): ExportLive | null {
  if (state.live && state.live.jobId === jobId) return state.live;
  return state.finishing[jobId] ?? null;
}

/** The live feed after a progress report. Movement is a change in the frame count, the output position
 *  or the part being made: ffmpeg prints a block every half second even when it is stuck, and a stuck
 *  one repeats the same numbers, so a block arriving is not a sign of life, a block that differs is. */
function advanced(
  live: ExportLive,
  patch: Partial<ExportJob> & { step?: number | null; steps?: number | null },
  now: number,
): ExportLive {
  const next: ExportLive = {
    ...live,
    fraction: patch.fraction !== undefined ? patch.fraction : live.fraction,
    etaSec: patch.etaSec !== undefined ? patch.etaSec : live.etaSec,
    speed: patch.speed !== undefined ? patch.speed : live.speed,
    frame: patch.frame !== undefined ? patch.frame : live.frame,
    step: patch.step !== undefined ? patch.step : live.step,
    steps: patch.steps !== undefined ? patch.steps : live.steps,
  };
  const moved =
    next.frame !== live.frame || next.fraction !== live.fraction || next.step !== live.step;
  return moved ? { ...next, lastMoveAt: now } : next;
}

/** True while a render is running — the menu uses this to refuse a second one. */
export function exportRunning(): boolean {
  const p = useExportJob.getState().phase;
  return p === "preparing" || p === "rendering";
}
