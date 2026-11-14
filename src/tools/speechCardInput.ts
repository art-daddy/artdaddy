// What the speech card is given: the wake registry's view of the files the assistant waits for, the speech jobs
// that are doing the work, and the model's download, made into the `CardInput` that `cardView` words. Pure: the hook
// that reads the stores hands them in.
import type { SpeechJob } from "../store/speechJobs";
import type { WakeChatView } from "../store/speechWakeHost";
import { jobsFor } from "./speechJobMatch";
import type { CardInput } from "./speechTimeLine";

export interface CardSources {
  readonly wake: WakeChatView;
  readonly jobs: readonly SpeechJob[];
  /** The speech model's download, when one is under way. */
  readonly download: { pct: number; etaS: number | null } | null;
  /** Seconds this PC is projected to need for `audioS` seconds of audio not yet started. */
  readonly projectedS: (audioS: number) => number;
}

const isTime = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

export function cardInputOf(src: CardSources): CardInput {
  const { wake } = src;
  const found = jobsFor(wake.pending, src.jobs);
  const mine = [...new Set(found.values())];
  const running = mine.filter((j) => j.phase === "running");
  const starting = mine.filter((j) => j.phase === "starting");
  const waiting = mine.filter((j) => j.phase === "waiting");
  const phase: CardInput["phase"] = running.length
    ? "running"
    : starting.length
      ? "starting"
      : waiting.length
        ? "waiting"
        : null;
  // The time left is the work of the runs going now (they all have to end) plus what the files not yet started
  // are projected to take. A run that has said no word yet gives no time: the card says it is starting.
  const runningEtaS =
    running.length && running.every((j) => isTime(j.etaS))
      ? Math.max(...running.map((j) => j.etaS as number))
      : null;
  const started = new Set([...running, ...starting]);
  let queuedS = 0;
  for (const e of wake.pending) {
    const job = found.get(e.key);
    if (job && started.has(job)) continue;
    if (isTime(e.audioS)) queuedS += src.projectedS(e.audioS);
  }
  return {
    done: wake.done,
    total: wake.total,
    phase,
    waitingForExport: phase === "waiting" && waiting.some((j) => j.facts.exportsBusy),
    runningEtaS,
    queuedS,
    slow: running.some((j) => j.rate !== null && j.rate > 1),
    download: src.download,
    ready: wake.ready,
    notes: wake.notes,
  };
}
