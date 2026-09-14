// Where a running export publishes itself.
//
// The render happens inside the tool host, several layers below React, and the export dialog is a
// component that can be dismissed and reopened while the job keeps going. Rather than thread a
// callback down through the tool context, a render announces itself here and the UI subscribes.
// One job at a time, matching the one ffmpeg process.
import { create } from "zustand";

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
  /** Set while a render is in flight, so the dialog can offer Cancel. */
  abort: (() => void) | null;
  begin: (abort: (() => void) | null) => void;
  update: (patch: Partial<ExportJob>) => void;
  finish: (patch: Partial<ExportJob>) => void;
  reset: () => void;
}

export const useExportJob = create<ExportState>((set) => ({
  ...IDLE,
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
