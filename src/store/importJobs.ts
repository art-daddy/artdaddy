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

// --- The batch registry (UJ-088) -----------------------------------------------------------------------------------------------------------
//
// `withImportJob` shows ONE file at a time: a batch of three is known to the app one file at a time, as the loop reaches each. The AGENT needs the whole
// batch from the first instant: a message sent while files are still coming in used to be told the library was empty (witness 3LuwWwH6RRVj: three 3.2 GB
// files dropped, Enter 43 ms later, "library: []"). So every door that imports a batch registers ALL its paths here before its first await. A file's row
// leaves the moment ITS import settles (it is in the library then, or it failed), so the agent is never told a file that is already there is still coming;
// whatever the doors forgot to settle one by one leaves when the batch ends, however it ends. Who reads the rows, and the one place the `import_note` flag
// is checked: tools/importing.ts.
//
// Keyed by the project's DIRECTORY, the one identity the doors (which hold a project id and its store) and the readers (tools, which hold a store) both
// have. Memory only. A batch that has made no progress for IMPORT_ROW_MAX_MS (it started, or a file of it settled, that long ago) is no longer shown, so an
// import that hangs cannot leave a note up for good, while a long batch that keeps landing files is never cut off in the middle.

/** The longest a batch is shown without making progress. An import that has not moved by then is not reported to the agent any more (the import itself is untouched). */
export const IMPORT_ROW_MAX_MS = 30 * 60_000;

interface BatchRow {
  batch: number;
  projectDir: string;
  path: string;
  name: string;
}

export interface ImportingRow {
  path: string;
  name: string;
  /** 0..1 once bytes are being read; null before the first report. */
  fraction: number | null;
}

/** What a batch hands its door: run ONE file's import through it and that file's row leaves as soon as it settles (landed or failed). */
export type ImportFile = <T>(path: string, job: () => Promise<T>) => Promise<T>;

const passThrough: ImportFile = (_path, job) => job();

let rows: BatchRow[] = [];
let lastBatch = 0;
/** When each batch last made progress: it started, or one of its files settled. A batch is shown while it has made progress within IMPORT_ROW_MAX_MS, so a long
 *  batch that keeps landing files is never cut off in the middle, and one that has stopped moving is. */
const progressAt = new Map<number, number>();
const dirKey = (dir: string): string => norm(dir).replace(/\/+$/, "").toLowerCase();
const shown = (r: BatchRow, now: number): boolean =>
  now - (progressAt.get(r.batch) ?? Number.NEGATIVE_INFINITY) <= IMPORT_ROW_MAX_MS;

/** Register every path of a batch, run `work`, and take exactly those rows out again when it ends. The registration is SYNCHRONOUS: it has happened when this
 *  returns its promise, before the caller's first await. No project directory (the web build, a project that is not open) or no paths: nothing to register.
 *  `now` is the clock (a fixed time or a function; tests only). */
export async function withImportBatch<R>(
  projectDir: string | null | undefined,
  paths: readonly string[],
  work: (file: ImportFile) => Promise<R>,
  now: number | (() => number) = Date.now,
): Promise<R> {
  if (!projectDir || paths.length === 0) return work(passThrough);
  const clock = typeof now === "function" ? now : () => now;
  const batch = ++lastBatch;
  const key = dirKey(projectDir);
  const started = clock();
  rows = rows.filter((r) => shown(r, started)); // a row that long ago can only be a leak
  for (const id of [...progressAt.keys()])
    if (!rows.some((r) => r.batch === id)) progressAt.delete(id);
  progressAt.set(batch, started);
  for (const p of paths)
    rows.push({ batch, projectDir: key, path: norm(p), name: p.split(/[\\/]/).pop() || p });
  const file: ImportFile = async (path, job) => {
    try {
      return await job();
    } finally {
      const at = rows.findIndex((r) => r.batch === batch && r.path === norm(path));
      if (at >= 0) rows.splice(at, 1); // one row per call: a path given twice is settled twice
      if (progressAt.has(batch)) progressAt.set(batch, clock());
    }
  };
  try {
    return await work(file);
  } finally {
    rows = rows.filter((r) => r.batch !== batch);
    progressAt.delete(batch);
  }
}

/** What this project's person is importing right now: one entry per path, the percent when bytes are being read. */
export function importingRows(
  projectDir: string | null | undefined,
  now: number = Date.now(),
): ImportingRow[] {
  if (!projectDir) return [];
  const key = dirKey(projectDir);
  const seen = new Set<string>();
  const out: ImportingRow[] = [];
  for (const r of rows) {
    if (r.projectDir !== key || !shown(r, now) || seen.has(r.path)) continue;
    seen.add(r.path);
    const job = useImportJobs.getState().jobs.find((j) => j.path === r.path);
    out.push({ path: r.path, name: r.name, fraction: job?.fraction ?? null });
  }
  return out;
}

/** Tests only: forget every batch. */
export function resetImportBatches(): void {
  rows = [];
  progressAt.clear();
}
