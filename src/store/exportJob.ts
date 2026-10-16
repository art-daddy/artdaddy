// Where a running export publishes itself.
//
// The render happens inside the tool host, several layers below React, and the export dialog is a
// component that can be dismissed and reopened while the job keeps going. Rather than thread a
// callback down through the tool context, a render announces itself here and the UI subscribes.
// One job at a time, matching the one ffmpeg process.
import { create } from "zustand";
import type { ExportCalibration, ExportEngine } from "../timeline/exportOptions";

const ENGINE_KEY = "artdaddy-export-routing-v2";
const CALIBRATION_KEY = `artdaddy-export-calibration-v2:${__ARTDADDY_RELEASE__}`;

function calibration(value: unknown): ExportCalibration | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!raw.workload || typeof raw.workload !== "object" || !raw.output || typeof raw.output !== "object") return null;
  const workload = raw.workload as Record<string, unknown>;
  const output = raw.output as Record<string, unknown>;
  const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const keys = ["width", "height", "fps", "durationSeconds", "visualClips", "captionClips", "audioClips", "peakVisualLayers", "peakMediaLayers"] as const;
  if (keys.some((key) => number(workload[key]) === null) || ["width", "height", "fps"].some((key) => !number(output[key]))) return null;
  if (!number(workload.width) || !number(workload.height) || !number(workload.fps) || !number(workload.durationSeconds) ||
    !number(raw.elapsedSeconds) || !number(raw.finalBytes) || !["high", "medium", "low"].includes(String(raw.quality)) ||
    !["file-sequence-v1", "partition-pipes-v1"].includes(String(raw.engine))) return null;
  return { workload: Object.fromEntries(keys.map((key) => [key, workload[key]])) as unknown as ExportCalibration["workload"],
    output: { width: Number(output.width), height: Number(output.height), fps: Number(output.fps) },
    quality: String(raw.quality), engine: raw.engine as ExportEngine, elapsedSeconds: Number(raw.elapsedSeconds), finalBytes: Number(raw.finalBytes),
    memoryBytes: number(raw.memoryBytes), temporaryBytes: number(raw.temporaryBytes) };
}

function savedCalibrations(): ExportCalibration[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CALIBRATION_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.slice(-24).map(calibration).filter((sample): sample is ExportCalibration => sample !== null) : [];
  } catch { return []; }
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

interface ExportState extends ExportJob {
  calibrations: readonly ExportCalibration[];
  rememberCalibration: (sample: ExportCalibration) => void;
  engine: ExportEngine;
  setEngine: (engine: ExportEngine) => void;
  /** Set while a render is in flight, so the dialog can offer Cancel. */
  abort: (() => void) | null;
  begin: (abort: (() => void) | null) => void;
  update: (patch: Partial<ExportJob>) => void;
  finish: (patch: Partial<ExportJob>) => void;
  reset: () => void;
}

export const useExportJob = create<ExportState>((set, get) => ({
  ...IDLE,
  calibrations: savedCalibrations(),
  rememberCalibration: (value) => {
    const sample = calibration(value);
    if (!sample) return;
    const calibrations = [...get().calibrations, sample].slice(-24);
    try { localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibrations)); } catch {}
    set({ calibrations });
  },
  engine: savedEngine(),
  setEngine: (engine) => {
    const selected = engine === "partition-pipes-v1" || engine === "auto" ? engine : "file-sequence-v1";
    try { localStorage.setItem(ENGINE_KEY, selected); } catch {}
    set({ engine: selected });
  },
  abort: null,
  begin: (abort) => set({ ...IDLE, phase: "preparing", startedAt: Date.now(), abort }),
  // Progress must never resurrect a job that already finished: ffmpeg's last blocks can arrive
  // after the process exits, and a bar that jumps back to 90% after saying "done" reads as a bug.
  update: (patch) =>
    set((s) => (s.phase === "preparing" || s.phase === "rendering" ? { ...s, ...patch } : s)),
  finish: (patch) => set((s) => ({ ...s, ...patch, abort: null })),
  reset: () => set({ ...IDLE, abort: null }),
}));

/** True while a render is running — the menu uses this to refuse a second one. */
export function exportRunning(): boolean {
  const p = useExportJob.getState().phase;
  return p === "preparing" || p === "rendering";
}
