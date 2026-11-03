// Why a transcription failed, as a code a program can act on.
//
// A message is for a person; the reason is for the model, the telemetry and the tests. Every place
// the transcription path can fail names its reason where it throws, so nothing downstream has to
// guess from the text of an error (the old answer to a failed look was a sentence inside a result
// that said ok: 107 such calls from 10 users).
import { ArtDaddyError } from "../lib/errors";

export const TRANSCRIPT_FAILURE_REASONS = [
  /** The speech model could not be downloaded or installed. */
  "model_unavailable",
  /** The speech engine cannot start on this machine at all. */
  "engine_unavailable",
  /** The engine does not know the language that was asked for. */
  "language_rejected",
  /** The file's sound could not be read. */
  "audio_extraction_failed",
  /** The engine ran and did not produce a transcript. */
  "engine_failed",
] as const;

export type TranscriptFailureReason = (typeof TRANSCRIPT_FAILURE_REASONS)[number];

export class TranscriptionFailure extends ArtDaddyError {
  readonly code: string;
  readonly expected: boolean;
  constructor(
    readonly reason: TranscriptFailureReason,
    message: string,
    options: { expected?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TranscriptionFailure";
    this.code = `speech_${reason}`;
    this.expected = options.expected ?? false;
  }
}

/** A failed transcription as the model reads it: our own errors whole, since they lead with what
 *  happened, and the TAIL of anything else, where a subprocess puts its reason. */
export function failureText(e: unknown): string {
  if (e instanceof ArtDaddyError) return e.message;
  try {
    return String(e).slice(-200);
  } catch {
    // An object with no usable toString (a null-prototype object, `{ toString: {} }`) cannot be made into text.
    return "the error could not be read";
  }
}

export interface ClassifiedFailure {
  reason: TranscriptFailureReason;
  message: string;
}

/** The reason and sentence for any error thrown on the way to a transcript. An error that did not
 *  name a reason is the engine's: whatever else can fail is named where it is thrown. */
export function classifyTranscriptFailure(e: unknown): ClassifiedFailure {
  return {
    reason: e instanceof TranscriptionFailure ? e.reason : "engine_failed",
    message: failureText(e),
  };
}

/** What to tell the person and what to do next, for the model reading a failed transcript. Each
 *  says whether trying again can help, because the first reading of a failure is to retry it. */
export const FAILURE_ADVICE: Readonly<Record<TranscriptFailureReason, string>> = {
  model_unavailable:
    "The speech model could not be downloaded, so nothing was transcribed. Tell the user that transcribing needs a one-time download of the speech model and an internet connection. Calling again retries the download from where it stopped.",
  engine_unavailable:
    "The speech engine cannot start on this computer, so audio cannot be transcribed here. Do not retry; tell the user.",
  language_rejected:
    "The speech engine does not accept that language. Call again without `language` (it is detected from the audio) or with another code.",
  audio_extraction_failed:
    "The sound of this file could not be read: it may be damaged or have no usable audio. Do not retry the same file; tell the user.",
  engine_failed:
    "The speech engine failed on this file. Calling again once may work; if it fails again, say that transcription is unavailable for it.",
};
