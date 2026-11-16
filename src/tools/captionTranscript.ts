// The words add_captions needs, waited for within a limit shared by every clip of one call.
//
// add_captions waited for each clip's transcript with no limit at all, so a request for captions on
// footage that was not transcribed yet (a long file just imported, a machine without a GPU, the
// speech model still downloading) held the turn for as long as that took, the way inspect_media
// once did. It now waits as long as get_transcript does and, past that, says what is still pending
// and leaves the work running, so the next call finds the words in the cache.
import type { ClientToolContext } from "./context";
import { exportFlag, refreshExportFlags } from "../api/exportFlags";
import { noteWordsFetched, wakeTargetOf } from "../store/speechWakeHost";
import { ensureTranscript, transcribeSpan, type ParsedTranscript } from "./transcribe";
import type { TranscriptFailureReason } from "./speechFailure";
import { waitForRun, type InProgressTranscript } from "./transcriptWait";
import { formatDuration } from "./transcriptWords";

/** What a clip not yet transcribed still gets of the wait once the shared time is spent. A read of
 *  the cache takes milliseconds; with no wait at all a transcript that IS cached would be called
 *  pending. */
export const CACHE_READ_FLOOR_MS = 750;

export type CaptionWords =
  | { kind: "ready"; transcript: ParsedTranscript }
  | { kind: "pending"; status: InProgressTranscript }
  | { kind: "failed"; error: string; reason: TranscriptFailureReason }
  | { kind: "cancelled" };

/** The words of the stretch `window` of `ref` (source seconds: what a clip plays and a second either
 *  side, speechSpans.ts), waiting for new work at most until `deadline` (epoch ms). Only that stretch
 *  is transcribed, never the whole file, so the cap and Cancel bind captions too (S2-10); a whole-file
 *  transcript the indexer kept answers at once. The work is started or joined and is never stopped by
 *  the wait ending. With the switch `speech_cpu_cap` off it is 0.27.0: the whole file's words. */
export async function captionWords(
  ctx: ClientToolContext,
  ref: string,
  language: string | undefined,
  deadline: number,
  window: { start: number; end: number },
): Promise<CaptionWords> {
  // The server's switches are asked for beside the work, never waited for.
  void refreshExportFlags();
  const bySpan = exportFlag("speech_cpu_cap");
  const seconds = Math.max(0, window.end - window.start);
  // Where the file is, so that the card can find the speech job that transcribes it (it names files by path).
  const path = await Promise.resolve()
    .then(() => ctx.store.resolveRef(ref))
    .catch(() => null);
  const outcome = await waitForRun({
    key: `${ref}\u0000${language ?? ""}\u0000captions${bySpan ? `\u0000${window.start}-${window.end}` : ""}`,
    tool: "add_captions",
    audioSeconds: bySpan ? seconds : null,
    run: bySpan
      ? transcribeSpan({ ...ctx, speechPurpose: "captions" }, ref, window, language)
      : ensureTranscript(ctx, ref, undefined, language),
    boundMs: Math.max(CACHE_READ_FLOOR_MS, deadline - Date.now()),
    signal: ctx.signal,
    wake: wakeTargetOf(ctx, ref, ref, bySpan ? window : null, path),
  });
  switch (outcome.kind) {
    case "done":
      // add_captions is about to use these words: a wake that was going to say they are ready has nothing to say.
      noteWordsFetched(ctx, ref, bySpan ? window : null);
      return { kind: "ready", transcript: outcome.value.parsed };
    case "pending":
      return { kind: "pending", status: outcome.status };
    case "failed":
      return { kind: "failed", error: outcome.status.error, reason: outcome.status.reason };
    case "cancelled":
      return { kind: "cancelled" };
  }
}

/** The sentence about a pending model download, for the assistant. A second model file is not the one-time download
 *  of the first start, and is not said to be. */
function downloadSentence(status: InProgressTranscript): string {
  if (status.stage !== "downloading_speech_model") return "";
  const pct = status.progress_pct ?? 0;
  return status.again === true
    ? ` Another speech model is still downloading (${pct}%); this download happens only once.`
    : ` The speech model is still downloading (${pct}%); this one-time download happens the first time speech is transcribed on this computer.`;
}

/** What the model reads when captions could not be made yet because words are still being made. A
 *  failure for the tool (nothing was added), but not an error: the call can simply be repeated. */
export function pendingCaptionsResult(
  waiting: ReadonlyArray<{ clip_id: string; track_id: string }>,
  status: InProgressTranscript,
): Record<string, unknown> {
  const download = downloadSentence(status);
  // The time first (S2-13): a clip longer than this PC can do in ten minutes still runs, and the person
  // is told how long it is expected to take, so the assistant can say it before anything else.
  const left =
    status.eta_s === undefined
      ? ""
      : ` On this PC it should take about ${formatDuration(status.eta_s)} more: tell the user the time.`;
  return {
    ok: false,
    pending: true,
    status: "in_progress",
    stage: status.stage,
    ...(status.progress_pct === undefined ? {} : { progress_pct: status.progress_pct }),
    ...(status.eta_s === undefined ? {} : { eta_s: status.eta_s }),
    in_progress: waiting,
    error:
      `Captions were NOT added: the speech in ${waiting.length} audio clip(s) is still being ` +
      `transcribed.${download}${left} It goes on in the background, so the work is not lost. Tell the user ` +
      `it is still being transcribed. Then call add_captions again with the same arguments: it adds ` +
      `the captions at once when the words are ready. Do not describe or guess what is said, and if ` +
      `it is still not ready after two or three tries, stop and tell the user to ask again later.`,
  };
}
