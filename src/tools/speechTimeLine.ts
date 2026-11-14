// What the speech card says: how the transcription of the files the assistant is waiting for is going.
//
// The card is a view of the speech work, not a message, so what it may say is decided here, pure, where
// each rule is a property that can be tested:
//   - the count is exact, in whole files, and never has more done than there are;
//   - a time is never shown before audio has moved: "starting…" until the first words come, and nothing
//     but the count while the work waits or its state is not known;
//   - a time is rounded the way the assistant is told it (`approxTime`), and a PC that is slower than real
//     time says that it can take much longer.
// The hook that fills a `CardInput` from the stores and the component that shows a `CardView` are elsewhere.
import { formatEta } from "../store/modelDownload";
import type { TranscriptFailureReason } from "./speechFailure";
import { approxTime } from "./transcriptWords";

/** Why some files will not be transcribed. A model that could not be downloaded is the download line's
 *  business, so it has no note. */
export type CardNoteKind = Exclude<TranscriptFailureReason, "model_unavailable"> | "expired";
export interface CardNote {
  id: string;
  kind: CardNoteKind;
  count: number;
}
export type HeldBy = "typing" | "capped" | "credits" | null;

export interface CardInput {
  /** Files of the chat's open batches that still count: done = words landed or already read; total
   *  excludes files that failed, were cancelled or expired. */
  done: number;
  total: number;
  /** The phase of the speech work for these files: null = not known (no job store data yet: show the
   *  count only). */
  phase: "waiting" | "starting" | "running" | null;
  /** True when the phase is "waiting" because an export is running. */
  waitingForExport: boolean;
  /** Seconds left for the running job, null until audio has moved; plus the seconds the other files not
   *  yet started are projected to take. */
  runningEtaS: number | null;
  queuedS: number;
  /** Measured under real time since the first words. */
  slow: boolean;
  /** The speech model is downloading right now (percent 0 to 100, seconds left or null). */
  download: { pct: number; etaS: number | null } | null;
  /** Words landed and not yet read: how many files, and why the assistant is not carrying on by itself
   *  (null = it is about to). */
  ready: { files: number; held: HeldBy } | null;
  notes: readonly CardNote[];
}

export interface CardView {
  lines: readonly string[];
  /** Each can be dismissed, by its id. */
  notes: ReadonlyArray<{ id: string; text: string }>;
}

const SLOW_WORDS = "this PC is slow at this, it can take much longer";

const HELD_WORDS: Readonly<Record<NonNullable<HeldBy>, string>> = {
  typing: "The assistant carries on when you send or clear your message.",
  capped: "Ask the assistant to carry on.",
  credits: "You are out of credits, so the assistant cannot carry on yet.",
};

const NOTE_WORDS: Readonly<Record<CardNoteKind, (count: number) => string>> = {
  engine_failed: (n) => `The speech engine failed on ${plural(n, "file", "files")}.`,
  audio_extraction_failed: (n) => `The sound of ${plural(n, "file", "files")} could not be read.`,
  engine_unavailable: () => "Speech cannot run on this computer.",
  language_rejected: (n) => `The language was not accepted for ${plural(n, "file", "files")}.`,
  expired: (n) =>
    `The words for ${plural(n, "file", "files")} are still not ready after 30 minutes. ` +
    "Ask the assistant to try again later.",
};

/** A count as the card says it: whole, never below zero, and zero for anything that is not a finite number. */
function whole(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** Seconds as given, zero for anything that is not a finite number and for a negative one. */
function secondsOrZero(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The entry a key names, never one the table only inherits. */
function lookup<K extends string, V>(table: Readonly<Record<K, V>>, key: unknown): V | undefined {
  return typeof key === "string" && Object.hasOwn(table, key) ? table[key as K] : undefined;
}

/** "1 file", "3 files", "0 files". */
export function plural(n: number, one: string, many: string): string {
  const count = whole(n);
  return `${count} ${count === 1 ? one : many}`;
}

function progressLine(input: CardInput, done: number, total: number): string {
  const files = plural(total, "file", "files");
  const { phase, runningEtaS: eta } = input;
  if (phase === "waiting" && input.waitingForExport === true)
    return `Transcription is waiting for the export to finish · ${done} of ${files}`;
  const count = `Transcribing ${done} of ${files}`;
  if (phase === "starting" || (phase === "running" && eta === null)) return `${count} · starting…`;
  if (phase === "running" && typeof eta === "number" && Number.isFinite(eta) && eta >= 0) {
    // Two huge finite times can add up to Infinity, which would read as no time left at all.
    const leftS = Math.min(Number.MAX_VALUE, eta + secondsOrZero(input.queuedS));
    return `${count} · ${approxTime(leftS)}${input.slow === true ? ` · ${SLOW_WORDS}` : ""}`;
  }
  return count;
}

/** The card for the speech work as it stands, or null when there is nothing to say. */
export function cardView(input: CardInput): CardView | null {
  const total = whole(input.total);
  const done = Math.min(whole(input.done), total);
  const left = total - done;
  const lines: string[] = [];

  if (isRecord(input.download)) {
    const { pct, etaS } = input.download;
    const timeLeft =
      typeof etaS === "number" && Number.isFinite(etaS) ? `, ${formatEta(etaS)} left` : "";
    lines.push(`Downloading the speech model (one time): ${Math.min(100, whole(pct))}%${timeLeft}`);
    if (left > 0) lines.push(`Then ${plural(left, "file", "files")} to transcribe.`);
  } else if (left > 0) {
    lines.push(progressLine(input, done, total));
  }

  if (isRecord(input.ready)) {
    const files = whole(input.ready.files);
    if (files > 0) {
      const why = lookup(HELD_WORDS, input.ready.held);
      lines.push(`Words are ready for ${plural(files, "file", "files")}.${why ? ` ${why}` : ""}`);
    }
  }

  const notes: Array<{ id: string; text: string }> = [];
  for (const note of Array.isArray(input.notes) ? input.notes : []) {
    if (!isRecord(note)) continue;
    const words = lookup(NOTE_WORDS, note.kind);
    const count = whole(note.count);
    if (words && count > 0) notes.push({ id: note.id as string, text: words(count) });
  }

  return lines.length === 0 && notes.length === 0 ? null : { lines, notes };
}
