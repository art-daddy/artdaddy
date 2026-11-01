// The words add_captions needs, waited for within a limit shared by every clip of one call.
//
// add_captions waited for each clip's transcript with no limit at all, so a request for captions on
// footage that was not transcribed yet (a long file just imported, a machine without a GPU, the
// speech model still downloading) held the turn for as long as that took, the way inspect_media
// once did. It now waits as long as get_transcript does and, past that, says what is still pending
// and leaves the work running, so the next call finds the words in the cache.
import type { ClientToolContext } from "./context";
import { ensureTranscript, type ParsedTranscript } from "./transcribe";
import { waitForRun, type InProgressTranscript } from "./transcriptWait";

/** What a clip not yet transcribed still gets of the wait once the shared time is spent. A read of
 *  the cache takes milliseconds; with no wait at all a transcript that IS cached would be called
 *  pending. */
export const CACHE_READ_FLOOR_MS = 750;

export type CaptionWords =
  | { kind: "ready"; transcript: ParsedTranscript }
  | { kind: "pending"; status: InProgressTranscript }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" };

/** The whole-file transcript of `ref`, waiting for new work at most until `deadline` (epoch ms).
 *  The work is started or joined and is never stopped by the wait ending. */
export async function captionWords(
  ctx: ClientToolContext,
  ref: string,
  language: string | undefined,
  deadline: number,
): Promise<CaptionWords> {
  const outcome = await waitForRun({
    key: `${ref}\u0000${language ?? ""}\u0000captions`,
    audioSeconds: null,
    audioLabel: "",
    run: ensureTranscript(ctx, ref, undefined, language),
    boundMs: Math.max(CACHE_READ_FLOOR_MS, deadline - Date.now()),
    signal: ctx.signal,
  });
  switch (outcome.kind) {
    case "done":
      return { kind: "ready", transcript: outcome.value.parsed };
    case "pending":
      return { kind: "pending", status: outcome.status };
    case "failed":
      return { kind: "failed", error: outcome.status.error };
    case "cancelled":
      return { kind: "cancelled" };
  }
}

/** What the model reads when captions could not be made yet because words are still being made. A
 *  failure for the tool (nothing was added), but not an error: the call can simply be repeated. */
export function pendingCaptionsResult(
  waiting: ReadonlyArray<{ clip_id: string; track_id: string }>,
  status: InProgressTranscript,
): Record<string, unknown> {
  const download =
    status.stage === "downloading_speech_model"
      ? ` The speech model is still downloading (${status.progress_pct ?? 0}%); this one-time download happens the first time speech is transcribed on this computer.`
      : "";
  return {
    ok: false,
    pending: true,
    status: "in_progress",
    stage: status.stage,
    ...(status.progress_pct === undefined ? {} : { progress_pct: status.progress_pct }),
    in_progress: waiting,
    error:
      `Captions were NOT added: the speech in ${waiting.length} audio clip(s) is still being ` +
      `transcribed.${download} It goes on in the background, so the work is not lost. Tell the user ` +
      `it is still being transcribed. Then call add_captions again with the same arguments: it adds ` +
      `the captions at once when the words are ready. Do not describe or guess what is said, and if ` +
      `it is still not ready after two or three tries, stop and tell the user to ask again later.`,
  };
}
