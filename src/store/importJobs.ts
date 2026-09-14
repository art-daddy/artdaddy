// Imports in flight, so a long one is visible instead of looking like a hang.
//
// Hashing a 1.75 GB file takes ~55s. Before this the app just sat there — the window stays
// responsive now that the probe is off the main thread, but nothing said why nothing happened.
//
// Non-modal on purpose: Premiere reports import progress in its status area, and other NLEs uses a
// media-panel toast (MediaPanelToast.progress). Neither blocks the editor while media ingests.
//
// Keyed by the FILE PATH: the byte progress comes from the Rust probe, which knows the path and
// nothing about whatever id the UI invented, so the path is the one thing both ends already share.
import { create } from "zustand";

export interface ImportJob {
  path: string;
  name: string;
  /** 0..1 once bytes are being read; null until the first report. */
  fraction: number | null;
  /** "reading" carries a percentage; "analysing" is the ffprobe + registration tail. */
  phase: "reading" | "analysing";
}

interface ImportJobsState {
  jobs: ImportJob[];
  begin: (path: string, name: string) => void;
  progress: (path: string, read: number, total: number) => void;
  finish: (path: string) => void;
}

const norm = (p: string): string => p.replace(/\\/g, "/");

export const useImportJobs = create<ImportJobsState>((set) => ({
  jobs: [],
  begin: (path, name) =>
    set((s) => {
      const key = norm(path);
      if (s.jobs.some((j) => j.path === key)) return s;
      return { jobs: [...s.jobs, { path: key, name, fraction: null, phase: "reading" }] };
    }),
  progress: (path, read, total) =>
    set((s) => {
      const key = norm(path);
      // Only report against a job the UI actually started: the probe also runs for imports
      // nobody is watching (the agent, a checkpoint restore) and those must not appear.
      if (!s.jobs.some((j) => j.path === key)) return s;
      const fraction = total > 0 ? Math.min(1, read / total) : null;
      return {
        jobs: s.jobs.map((j) =>
          j.path === key ? { ...j, fraction, phase: fraction === 1 ? "analysing" : "reading" } : j,
        ),
      };
    }),
  finish: (path) => set((s) => ({ jobs: s.jobs.filter((j) => j.path !== norm(path)) })),
}));

/** Show an import on screen for the life of `work`, clearing it however that ends. */
export async function withImportJob<T>(path: string, work: () => Promise<T>): Promise<T> {
  const name = path.split(/[\\/]/).pop() || path;
  useImportJobs.getState().begin(path, name);
  try {
    return await work();
  } finally {
    useImportJobs.getState().finish(path);
  }
}
