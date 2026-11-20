// The project's background index, as the tools see it. A long whole-file transcript is never
// waited on inside a look (owner decision 2026-10-02, UJ-012), nor more than 10 minutes of audio
// measured for loudness (2026-10-04, 4g): the look returns at once and the work goes to the FRONT
// of the project's background queue, which runs one whisper, and one loudness pass, at a time.
// That queue is owned by the project's IndexCoordinator; it registers itself here, keyed by the
// project's directory (the stable identity both the editor and the agent's tool host share), so a
// tool can reach it without holding the editor's store.
import type { Loudness } from "./loudness";
import type { TranscribeWindow } from "./transcribe";

/** A look's loudness measurement, handed to the background. */
export interface BackgroundLoudness {
  /** True when this ask queued it: the look says "in progress" and does not wait. False when an
   *  earlier ask did and it has not run yet: this look may wait for it. */
  first: boolean;
  /** The figures, or why there are none, once it has run. Never rejects. */
  result: Promise<Loudness | { error: string }>;
}

/** Where one transcription stands, as the assistant is told: it can tell a file that waits from one that is
 *  being transcribed (the owner's decision of 20 Nov 2026). */
export interface QueueStatus {
  /** `running`: the speech engine is working on it. `queued`: it has not started and waits its turn.
   *  `left_for_later`: this PC would need more than ten minutes for the whole file, so it is not started by
   *  itself; the parts a tool asks for are transcribed when asked. `unavailable`: nothing will transcribe it
   *  now (the speech engine cannot start on this PC, or the project is closing). */
  state: "running" | "queued" | "left_for_later" | "unavailable";
  /** Queued: the transcriptions that run before it. One that is running counts. */
  ahead?: number;
  /** Queued: something other than the work ahead holds the turn back: an export that is queued or running, or a
   *  transcription somebody asked for and is waiting on (those go first). */
  held_by?: "export" | "look";
}

export interface BackgroundTranscriber {
  /** Put `source` (an absolute path) in `language` ("" = the default) at the front of the queue,
   *  or report that it is already running: the whole file, or only `window` (source seconds).
   *  False when nothing will transcribe it: the project is closing, or this machine cannot run the
   *  speech engine at all. */
  prioritize(source: string, language: string, window?: TranscribeWindow | null): boolean;
  /** Measure `source` (an absolute path) over [start, end) seconds, the whole file when both are
   *  null, next. Null when nothing will: the project is closing. */
  loudness(source: string, start: number | null, end: number | null): BackgroundLoudness | null;
  /** Where the transcription of `source` (the whole file, or only `window`) stands in this queue. Null when it
   *  is not in it: it was not asked for, or it is done. */
  status?(source: string, language: string, window?: TranscribeWindow | null): QueueStatus | null;
  /** Index `source` now, as a file the person imports by hand is: its transcript, its loudness and, for a
   *  picture or video, its copy for the preview. A source indexed before is not queued again. */
  index?(source: string): void;
}

const byDir = new Map<string, BackgroundTranscriber>();
const keyOf = (dir: string): string => dir.replace(/\\/g, "/").replace(/\/+$/, "");

/** Register the transcriber for `projectDir`. The returned function unregisters it, and only it:
 *  a project reopened before the old session finished closing keeps the new registration. */
export function registerBackgroundTranscriber(
  projectDir: string,
  t: BackgroundTranscriber,
): () => void {
  const key = keyOf(projectDir);
  byDir.set(key, t);
  return () => {
    if (byDir.get(key) === t) byDir.delete(key);
  };
}

/** Ask `projectDir`'s background transcriber to do `source` (or only `window` of it) next. False
 *  when there is none. */
export function prioritizeTranscript(
  projectDir: string,
  source: string,
  language: string,
  window?: TranscribeWindow | null,
): boolean {
  return byDir.get(keyOf(projectDir))?.prioritize(source, language, window) ?? false;
}

/** Where `source`'s transcription stands in `projectDir`'s background queue. Null when it is not in it, and when
 *  there is no queue to ask. */
export function transcriptQueueStatus(
  projectDir: string,
  source: string,
  language: string,
  window?: TranscribeWindow | null,
): QueueStatus | null {
  return byDir.get(keyOf(projectDir))?.status?.(source, language, window) ?? null;
}

/** Hand `source` to `projectDir`'s background index now, as a file imported by hand is. False when there is no
 *  index to hand it to, which is also when nothing is known about it. */
export function indexImportedSource(projectDir: string, source: string): boolean {
  const index = byDir.get(keyOf(projectDir));
  if (!index?.index) return false;
  index.index(source);
  return true;
}

/** Ask `projectDir`'s background index to measure `source` over [start, end) next. Null when
 *  there is none. */
export function backgroundLoudness(
  projectDir: string,
  source: string,
  start: number | null,
  end: number | null,
): BackgroundLoudness | null {
  return byDir.get(keyOf(projectDir))?.loudness(source, start, end) ?? null;
}
