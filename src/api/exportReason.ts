// Why an export ended the way it did, as the report files it: a closed list of reasons, and the rule that
// reads one off the text a failure arrives in. No imports on purpose, for the same reason as
// exportVocabulary.ts: the report (exportEvents.ts) and the places that explain a failure to the person
// (the chat card, the assistant's export list) share ONE rule, and the report is replaced wholesale in
// tests that exercise the queue.
export const EXPORT_REASON_CODES = [
  "none",
  "source_unavailable",
  "storage_unavailable",
  "storage_full",
  "memory_limit",
  "time_limit",
  "verification_failed",
  "render_failed",
  "interrupted",
  "cancelled",
  "declined",
  "unknown",
] as const;
export type ExportReasonCode = (typeof EXPORT_REASON_CODES)[number];

/** The reason a failure's text points at. Only the first 32 KiB is read, so a runaway log cannot make
 *  the rule slow; the order is the order of confidence (a full disk is named before a render failed). */
export function reasonOfError(text: string): ExportReasonCode {
  const error = String(text ?? "")
    .slice(0, 32_768)
    .toLowerCase();
  if (/no space left|enospc|disk.*full/.test(error)) return "storage_full";
  if (
    /no such file|source.*(?:missing|unavailable)|enoent|\bis offline\b|\bmedia files? (?:are|is) offline\b|still (?:being )?generat(?:ing|ed)|failed to generate|is not in the library/.test(
      error,
    )
  )
    return "source_unavailable";
  if (/permission denied|access is denied|eacces|read.only|destination.*unavailable/.test(error))
    return "storage_unavailable";
  if (/memory.*(?:budget|limit|exceeded)|cannot allocate memory|out of memory/.test(error))
    return "memory_limit";
  if (/deadline|execution.*expired|timed out/.test(error)) return "time_limit";
  if (/artifact|verification|frame.*count|duration.*mismatch/.test(error))
    return "verification_failed";
  if (/interrupted|restart|crash/.test(error)) return "interrupted";
  if (/ffmpeg|encoder|render/.test(error)) return "render_failed";
  return "unknown";
}
