// The preview copies being built right now, so a long one is visible instead of looking like a hang (UJ-091).
//
// A 4K or HEVC clip needs a smaller copy before the preview can play it, and building one takes seconds to many minutes (the field: a median of 6.8 s, a 90th
// percentile of 52 s, one of 49 minutes). Until now the app said "Processing imported media…" with no file, no number and nothing on the library tile.
//
// Keyed by the source's proxy key (preview/proxyPaths.ts), the one name the generator and every reader already share, so a library tile finds its row from its
// own path. Deliberately NOT part of store/importJobs.ts: that store is the person's imports (and the registry the agent is told from), and a preview copy of a
// file must never be reported as that file's import. Memory only. Written by the one place that builds a copy (IndexCoordinator.runProxy).
import { create } from "zustand";

import { proxyKey } from "../preview/proxyPaths";
import { etaSeconds, progressFraction } from "../timeline/ffmpegProgress";

export interface ProxyJob {
  /** proxyKey(source). */
  key: string;
  /** What the person calls the file. */
  name: string;
  /** The library ids that name this source, so the stage can tell which copy belongs to the clip under the playhead. */
  refs: string[];
  startedAt: number;
  /** 0..1 once ffmpeg has reported and the source's length is known; null before. */
  fraction: number | null;
  /** About how many seconds are left; null until there is enough to say. */
  etaSeconds: number | null;
}

/** An estimate that appears at once and is wrong is worse than one that appears a moment late: it is shown after this much of the copy, or this long with a reading. */
const ETA_AFTER_FRACTION = 0.05;
const ETA_AFTER_MS = 3_000;

interface ProxyJobsState {
  jobs: ProxyJob[];
  begin: (source: string, name: string, refs: readonly string[], now?: number) => void;
  progress: (
    source: string,
    p: { outMs: number; totalMs: number; speed: number },
    now?: number,
  ) => void;
  finish: (source: string) => void;
}

export const useProxyJobs = create<ProxyJobsState>((set) => ({
  jobs: [],
  begin: (source, name, refs, now = Date.now()) =>
    set((s) => {
      const key = proxyKey(source);
      if (s.jobs.some((j) => j.key === key)) return s;
      return {
        jobs: [
          ...s.jobs,
          { key, name, refs: [...refs], startedAt: now, fraction: null, etaSeconds: null },
        ],
      };
    }),
  progress: (source, p, now = Date.now()) =>
    set((s) => {
      const key = proxyKey(source);
      if (!s.jobs.some((j) => j.key === key)) return s;
      // Unknown length (no duration came back): no percent and no time left, and the row still says what is being made.
      const known = p.totalMs > 0 && p.outMs > 0;
      const fraction = known ? progressFraction(p.outMs, p.totalMs) : null;
      return {
        jobs: s.jobs.map((j) => {
          if (j.key !== key) return j;
          const ready =
            fraction !== null &&
            (fraction >= ETA_AFTER_FRACTION || now - j.startedAt >= ETA_AFTER_MS);
          return {
            ...j,
            // never backwards: ffmpeg's blocks can arrive out of step with a late `N/A` one
            fraction: fraction === null ? j.fraction : Math.max(j.fraction ?? 0, fraction),
            etaSeconds: ready ? etaSeconds(p.outMs, p.totalMs, p.speed) : j.etaSeconds,
          };
        }),
      };
    }),
  finish: (source) =>
    set((s) => {
      const key = proxyKey(source);
      return s.jobs.some((j) => j.key === key) ? { jobs: s.jobs.filter((j) => j.key !== key) } : s;
    }),
}));

/** The row for a library path (a tile knows its own path, never the key). */
export function jobFor(jobs: readonly ProxyJob[], source: string): ProxyJob | null {
  const key = proxyKey(source);
  return jobs.find((j) => j.key === key) ?? null;
}

/** The copy the stage's pill names, and how many are being made: the one that belongs to a clip under the playhead, else the one that began first. */
export function pillJob(
  jobs: readonly ProxyJob[],
  refsUnderPlayhead: readonly string[],
): { job: ProxyJob; count: number } | null {
  if (jobs.length === 0) return null;
  const mine = jobs.find((j) => j.refs.some((r) => refsUnderPlayhead.includes(r)));
  return { job: mine ?? jobs[0], count: jobs.length };
}

/** "42%", or "" before the first report. */
export const percentWords = (fraction: number | null): string =>
  fraction === null ? "" : `${Math.min(100, Math.round(fraction * 100))}%`;

/** "about 40 s left" under a minute and a half (to 5 s, never 0), then "about 2 min left"; "" while unknown. */
export function timeLeftWords(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 90) return `about ${Math.max(5, Math.ceil(seconds / 5) * 5)} s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}
