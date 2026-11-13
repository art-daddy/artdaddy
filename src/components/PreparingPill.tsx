// What the person reads while a preview copy is being built (UJ-091): which file, how far, how long is left, and that editing can go on.
//
// A 4K or HEVC clip needs a smaller copy before the preview can play it, and the stage used to say only "Processing imported media…" for the minutes that took. The
// wording is the owner's sheet (option A): "Preparing preview of drone_0412.mov", "42% · about 1 min left", "You can keep editing." Where no copy has reported (a still's
// stand-in, the moment between two files) the old line stays, so the pill never flickers off between files of one batch.
import { useProxyJobs, percentWords, pillJob, timeLeftWords } from "../store/proxyJobs";

/** The library refs of the clips that cover `frame`: the copy of one of them is the one the person is looking at. */
function refsAt(
  timeline: {
    tracks?: { clips?: { media_ref?: string; timeline_in: number; timeline_out: number }[] }[];
  } | null,
  frame: number,
): string[] {
  const refs: string[] = [];
  for (const track of timeline?.tracks ?? [])
    for (const clip of track.clips ?? [])
      if (clip.media_ref && frame >= clip.timeline_in && frame < clip.timeline_out)
        refs.push(clip.media_ref);
  return refs;
}

export default function PreparingPill({
  importing,
  timeline,
  frame,
}: {
  /** The drain's overlay flag: true from the first copy of a batch to the end of it. */
  importing: boolean;
  timeline: Parameters<typeof refsAt>[0];
  frame: number;
}): JSX.Element | null {
  const jobs = useProxyJobs((s) => s.jobs);
  const shown = jobs.length > 0 ? pillJob(jobs, refsAt(timeline, frame)) : null;
  if (!shown) {
    if (!importing) return null;
    return (
      <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-md bg-black/70 px-3 py-1.5 text-xs text-neutral-200 ring-1 ring-white/10">
        Processing imported media…
      </div>
    );
  }
  const { job, count, index } = shown;
  const detail = [percentWords(job.fraction), timeLeftWords(job.etaSeconds)]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      role="group"
      aria-label="preparing preview"
      className="pointer-events-none absolute right-3 top-3 z-10 w-72 rounded-md bg-black/70 px-3 py-2 text-xs text-neutral-200 ring-1 ring-white/10"
    >
      <div className="truncate font-medium" title={job.name}>
        Preparing preview of {job.name}
        {count > 1 ? (
          <span className="font-normal text-neutral-400">
            {" "}
            ({index} of {count})
          </span>
        ) : null}
      </div>
      {detail && (
        <div className="mt-0.5 tabular-nums" data-testid="preparing-detail">
          {detail}
        </div>
      )}
      {/* a progress bar, not a live region: the text changes twice a second and a screen reader should not read each change out */}
      <div
        role="progressbar"
        aria-label={`Preparing preview of ${job.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={
          job.fraction === null ? undefined : Math.min(100, Math.round(job.fraction * 100))
        }
        className="mt-1.5 h-1 overflow-hidden rounded bg-neutral-800"
      >
        <div
          data-testid="preparing-bar"
          className={
            job.fraction === null
              ? "h-full w-1/3 animate-pulse rounded bg-accent"
              : "h-full rounded bg-accent transition-[width] duration-200"
          }
          style={job.fraction === null ? undefined : { width: percentWords(job.fraction) }}
        />
      </div>
      <div className="mt-1 text-neutral-400">You can keep editing.</div>
    </div>
  );
}
