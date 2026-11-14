// The speech jobs in the top bar (S2-04 = D): a small chip beside the Export badge and, on a click, a
// popover like the Account menu with what runs, how far, how fast, why it is slow and Cancel. Nothing is
// drawn over the timeline. It only READS the store of speech jobs (the engine writes it) and sends
// nothing anywhere. The classes and sentences are the ones of the owner's mockup pictures.
import { useEffect, useRef, useState } from "react";

import {
  cancelSpeechJob,
  chipJob,
  useSpeechJobs,
  waitingBesides,
  type SpeechJob,
} from "../store/speechJobs";
import { about, lengthText, runningOn, slowNote, speedLine } from "../tools/slowNote";
import { cn } from "./ui";

/** A run that is going shows in the chip once it has lasted this long, so a small file transcribed in
 *  8 s does not flicker a chip in and out, and Cancel can reach every run that matters (the owner's
 *  picture notes: "once it lasts more than 15 s so that Cancel can reach it"). `>=`, not `>`: the
 *  1-second tick reads exactly 15.0 s. */
export const CHIP_AFTER_MS = 15_000;
const TICK_MS = 1_000;

const STOPPED_NOTE =
  "It will be transcribed when needed: the assistant and captions read only the parts they use, at that moment.";
const QUIET = "rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800";

type Tone = "fast" | "slow" | "quiet";
const TONE: Record<Tone, { text: string; dot: string }> = {
  fast: { text: "text-accent", dot: "animate-pulse bg-accent" },
  slow: { text: "text-amber-400", dot: "bg-amber-400" },
  quiet: { text: "text-neutral-400", dot: "bg-neutral-500" },
};

/** What the chip shows now: a run once it has lasted long enough, a stopped one at once, a waiting one
 *  only when an export is why it waits. */
function isShown(job: SpeechJob, now: number): boolean {
  switch (job.phase) {
    case "starting":
    case "running":
      return now - (job.startedAt ?? job.enqueuedAt) >= CHIP_AFTER_MS;
    case "stopped":
      return true;
    case "waiting":
      return job.facts.exportsBusy;
  }
}

/** The clock of the chip: one tick a second while there is any job (a run is shown only once it has
 *  lasted 15 s, and a stopped one is cleared after a few seconds), and no timer at all otherwise. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => {
      const t = Date.now();
      useSpeechJobs.getState().prune(t);
      setNow(t);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const isSlow = (job: SpeechJob): boolean =>
  job.phase === "running" && job.rate !== null && Number.isFinite(job.rate) && job.rate > 1;

function percentOf(job: SpeechJob): number | null {
  const span = job.spanS;
  if (span === null || !(span > 0)) return null;
  // Multiply first: 29 * 100 / 100 is 29, where 29 / 100 * 100 is 28.999...
  return Math.min(100, Math.max(0, Math.floor((job.doneS * 100) / span + 1e-9)));
}

/** "Transcribing {label}", or by what asked for it and how much of the file it covers. */
function titleOf(job: SpeechJob): string {
  const span = job.spanS !== null && job.spanS > 0 ? job.spanS : null;
  const part = job.purpose !== "index" && span !== null ? `${lengthText(span)} of ` : "";
  return job.purpose === "captions"
    ? `Captions: ${part}${job.label}`
    : `Transcribing ${part}${job.label}`;
}

interface Words {
  chip: string;
  tone: Tone;
  /** The popover's name, for a screen reader. */
  dialog: string;
  /** Under the title; null when there is nothing to say yet. */
  sub: string | null;
}

/** No time is claimed before audio moves: `etaS` null says none, and a run that is only starting says so. */
function wordsOf(job: SpeechJob): Words {
  if (job.phase === "stopped")
    return {
      chip: "Transcription stopped",
      tone: "quiet",
      dialog: "transcription stopped",
      sub: null,
    };
  if (job.phase === "waiting")
    return {
      chip: "Transcription waiting for the export",
      tone: "quiet",
      dialog: "transcription waiting",
      sub: "waiting for the export",
    };
  if (job.phase === "starting")
    return {
      chip: "Transcribing · starting",
      tone: "fast",
      dialog: "transcription",
      sub: "starting…",
    };
  const pct = percentOf(job);
  const eta = job.etaS !== null && Number.isFinite(job.etaS) ? job.etaS : null;
  const left = eta === null ? null : `${about(eta)} left`;
  const slow = isSlow(job);
  const chip =
    pct === null
      ? "Transcribing…"
      : left === null
        ? `Transcribing ${pct}%`
        : `Transcribing ${pct}% · ${slow ? "slow: " : ""}${left}`;
  const sub = [pct === null ? null : `${pct}%`, left].filter(Boolean).join(" · ");
  return { chip, tone: slow ? "slow" : "fast", dialog: "transcription", sub: sub || null };
}

export default function SpeechChip(): JSX.Element | null {
  const jobs = useSpeechJobs((s) => s.jobs);
  const now = useNow(jobs.length > 0);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);

  const job = chipJob(jobs.filter((j) => isShown(j, now)));
  const shown = job !== null;

  // The popover goes with its job, and does not open by itself for the next one.
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      chipRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!job) return null;
  const words = wordsOf(job);
  const more = waitingBesides(jobs, job);

  return (
    <div className="relative">
      <button
        ref={chipRef}
        type="button"
        data-testid="speech-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={words.chip}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex min-w-0 max-w-[16rem] items-center gap-1 rounded px-2 py-0.5 text-[11px] hover:bg-neutral-800",
          TONE[words.tone].text,
          open && "bg-neutral-800",
        )}
      >
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE[words.tone].dot)}
          aria-hidden
        />
        <span className="truncate">{words.chip}</span>
      </button>

      {open && (
        <>
          <div
            data-testid="speech-popover-backdrop"
            className="fixed inset-0 z-[90]"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            data-testid="speech-popover"
            role="dialog"
            aria-label={words.dialog}
            className="absolute right-0 z-[91] mt-1 w-80 rounded-md border border-edge bg-panel py-1 shadow-2xl"
          >
            {job.phase === "stopped" ? (
              <StoppedBody job={job} more={more} />
            ) : (
              <LiveBody job={job} words={words} more={more} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MoreWaiting({ more }: { more: number }): JSX.Element | null {
  return more > 0 ? <div className="mt-2 text-neutral-500">{`${more} more waiting`}</div> : null;
}

function StoppedBody({ job, more }: { job: SpeechJob; more: number }): JSX.Element {
  const head =
    job.stop === "too_slow"
      ? `Stopped transcribing ${job.label}: it would have taken too long on this PC.`
      : `Stopped transcribing ${job.label}.`;
  return (
    <div className="px-3 pb-1 pt-1 text-[11px]">
      <div className="text-xs font-medium text-ink">{head}</div>
      <div className="mt-0.5 leading-snug text-ink-dim">{STOPPED_NOTE}</div>
      <MoreWaiting more={more} />
    </div>
  );
}

function LiveBody({
  job,
  words,
  more,
}: {
  job: SpeechJob;
  words: Words;
  more: number;
}): JSX.Element {
  const running = job.phase === "running";
  const going = running || job.phase === "starting";
  const title = titleOf(job);
  const pct = running ? percentOf(job) : null;
  const speed = running ? speedLine(job.rate) : null;
  const where = going ? runningOn(job.facts) : null;
  const note = isSlow(job) ? slowNote(job.facts) : null;
  const hasBody = pct !== null || speed !== null || where !== null || note !== null || more > 0;

  return (
    <>
      <div className={cn("px-3 pb-2 pt-1", hasBody && "border-b border-edge")}>
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs font-medium text-ink" title={title}>
            {title}
          </span>
          {going && (
            <button
              type="button"
              onClick={() => cancelSpeechJob(job.id)}
              className={`${QUIET} hover:text-red-400`}
            >
              Cancel
            </button>
          )}
        </div>
        {words.sub && <div className="truncate text-[11px] text-ink-dim">{words.sub}</div>}
      </div>
      {hasBody && (
        <div className="px-3 pb-2 pt-2 text-[11px]">
          {pct !== null && (
            <div
              role="progressbar"
              aria-label="transcription progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="mt-1.5 h-1 overflow-hidden rounded bg-neutral-800"
            >
              <div
                className="h-full rounded bg-accent transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          {(speed !== null || where !== null) && (
            <div className="mt-2 grid grid-cols-[72px_1fr] gap-y-0.5 text-neutral-300">
              {speed !== null && (
                <>
                  <span className="text-neutral-500">Speed</span>
                  <span>{speed}</span>
                </>
              )}
              {where !== null && (
                <>
                  <span className="text-neutral-500">Running on</span>
                  <span>{where}</span>
                </>
              )}
            </div>
          )}
          {note && (
            <>
              <div className="mt-2 leading-snug text-amber-300">{note.sentence}</div>
              <div className="mt-1.5 leading-snug text-neutral-400">{note.cancelNote}</div>
            </>
          )}
          <MoreWaiting more={more} />
        </div>
      )}
    </>
  );
}
