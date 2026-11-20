// Which speech job is transcribing a file the assistant is waiting for. The wake registry knows a file by the name
// the assistant used and, where the tool had it, by its path and the stretch it asked for; the job store (L2's
// `useSpeechJobs`) knows what each run reads, by path. This is the one place the two are matched, so the card's
// time comes from a job that is really doing the work and from nothing else.
import type { SpeechJob, SpeechWorkItem } from "../store/speechJobs";
import { spanCovers, type Entry, type SpanWindow } from "../store/speechWake";

const samePath = (a: string, b: string): boolean =>
  a.replace(/\\/g, "/").replace(/\/+$/, "") === b.replace(/\\/g, "/").replace(/\/+$/, "");

const spanOfWork = (w: SpeechWorkItem): SpanWindow | null =>
  w.window ? { start: w.window.start, end: w.window.end ?? Infinity } : null;

/** Does this run read what the file's words are waited for: its file, and a stretch that holds the one asked? A run
 *  over the whole file holds any stretch. */
export function runReads(job: SpeechJob, path: string, wanted: SpanWindow | null): boolean {
  return job.work.some((w) => samePath(w.source, path) && spanCovers(spanOfWork(w), wanted));
}

/** The jobs that stand for what is awaited, in the order of the entries. A file with no path (the tool did not
 *  know it), or one no job reads, has no job: its time is not told. When several jobs read it, the one that has
 *  got furthest is the one that will produce it; of several running, the one with a measured time, then the
 *  soonest. */
export function jobsFor(
  entries: readonly Pick<Entry, "key" | "path" | "window">[],
  jobs: readonly SpeechJob[],
): Map<string, SpeechJob> {
  const rank = { running: 3, starting: 2, waiting: 1, stopped: 0 } as const;
  const sooner = (a: SpeechJob, b: SpeechJob): boolean =>
    a.etaS !== null && (b.etaS === null || a.etaS < b.etaS);
  const found = new Map<string, SpeechJob>();
  for (const e of entries) {
    if (e.path === null) continue;
    let best: SpeechJob | undefined;
    for (const job of jobs) {
      if (job.phase === "stopped" || !runReads(job, e.path, e.window)) continue;
      if (
        !best ||
        rank[job.phase] > rank[best.phase] ||
        (job.phase === "running" && best.phase === "running" && sooner(job, best))
      )
        best = job;
    }
    if (best) found.set(e.key, best);
  }
  return found;
}

/** Has audio of the run behind this file moved? True once words have come; false while the engine has started
 *  and said none; null when nothing is known (no job reads the file, or it has not started). The not-ready answer
 *  claims no time while this is false. */
export function audioMovedFor(
  jobs: readonly SpeechJob[],
  path: string | null,
  wanted: SpanWindow | null,
): boolean | null {
  if (path === null) return null;
  const found = jobsFor([{ key: "k", path, window: wanted }], jobs).get("k");
  if (!found) return null;
  if (found.phase === "waiting") return null;
  return found.phase === "running";
}

/** Is a run going that reads this stretch of the file (source seconds; null is the whole file)? Whoever started it:
 *  the indexer, a look, a request for captions. A job that only waits for an export is not going. */
export function runIsGoing(
  jobs: readonly SpeechJob[],
  path: string,
  window: { start?: number | null; end?: number | null } | null,
): boolean {
  const wanted: SpanWindow | null = window
    ? { start: window.start ?? 0, end: window.end ?? Infinity }
    : null;
  return jobs.some(
    (j) => (j.phase === "running" || j.phase === "starting") && runReads(j, path, wanted),
  );
}
