// What the text of a failed export looks like when it reaches a screen: one real-looking text for each reason the rule
// (api/exportReason.ts) can read off a text, and the long log an encoder leaves behind. Shared by the tests that say what a
// failure looks like to the person, so none of them invents its own reading of a failure.
import type { ExportReasonCode } from "../api/exportReason";

/** One text for each reason `reasonOfError` can say. It never says none, cancelled or declined: those are states an export is in,
 *  and they carry no text to read. A test that uses the table asserts first that the rule reads each text as its key, so a text
 *  cannot drift from the rule unseen. */
export const FAILURE_TEXTS: Readonly<Partial<Record<ExportReasonCode, string>>> = {
  storage_full:
    "ffmpeg render failed (code=-28): av_interleaved_write_frame(): No space left on device",
  source_unavailable: "ENOENT: no such file or directory, open 'C:\\Users\\mia\\Videos\\beach.mp4'",
  storage_unavailable: "EACCES: permission denied, open 'D:\\Exports\\film.mp4.partial'",
  memory_limit: "ffmpeg render failed (code=1): Error while filtering: Cannot allocate memory",
  time_limit: "export deadline exceeded after 28800 s",
  verification_failed:
    "the finished file did not pass its check: duration mismatch (expected 120.04 s, found 87.3 s)",
  interrupted: "the export was interrupted: the app restarted",
  render_failed:
    "native render failed: [h264_amf @ 0000028f] Error submitting video frame to the encoder",
  unknown: "something odd",
};

/** The table as rows: the reason, and a text that means it. */
export const FAILURE_TEXT_ROWS = Object.entries(FAILURE_TEXTS) as [ExportReasonCode, string][];

/** The reasons with no text in the table, which are the states an export is in rather than ways it stopped. */
export const REASONS_WITHOUT_TEXT: readonly ExportReasonCode[] = ["none", "cancelled", "declined"];

/** A failure as it arrives from the app process: the encoder's own log, then the app's diagnostics, byte counts and an operating
 *  system error number (about 1,100 characters, in lines). The rule reads it as `render_failed`. */
export const ENCODER_FAILURE_LOG = [
  "native render failed: ffmpeg render failed (code=-22)",
  "Input #0, rawvideo, from 'pipe:': Duration: N/A, start: 0.000000, bitrate: 1990656 kb/s",
  "  Stream #0:0: Video: rawvideo (BGRA / 0x41524742), bgra, 1920x1080, 1990656 kb/s, 30 tbr, 30 tbn",
  "Stream mapping: Stream #0:0 -> #0:0 (rawvideo (native) -> h264 (h264_amf))",
  "[h264_amf @ 0000028f3c1d5a40] SubmitInput() failed with error 6",
  "[h264_amf @ 0000028f3c1d5a40] Error submitting video frame to the encoder",
  "[vost#0:0/h264_amf @ 0000028f3a8e1c00] Error while encoding stream 0:0: Generic error in an external library",
  "[vf#0:0 @ 0000028f3a8e2d40] Error sending frames to consumers: Generic error in an external library",
  "[out#0/mp4 @ 0000028f3a8d9e80] Nothing was written into output file, because at least one of its streams received no packets.",
  "frame=    0 fps=0.0 q=0.0 Lsize=       0KiB time=N/A bitrate=N/A speed=N/A",
  "Conversion failed!",
  'native render resident: {"limit":8589934592,"sampled_peak":2147483648,"workers_at_peak":[1,2,3,4]}',
  "wrote 41943040 of 1887436800 bytes to D:\\Exports\\film.mp4.partial",
  "The process cannot access the file because it is being used by another process. (os error 32)",
].join("\n");

/** Pieces of that log that no screen of the app says to the person: the encoder's name and error, the app's own diagnostics, a byte
 *  count and the operating system's error number. Each is a single line's worth, so a match is a match of one piece. */
export const ENCODER_FAILURE_PIECES: readonly string[] = [
  "[h264_amf @ 0000028f3c1d5a40] SubmitInput() failed with error 6",
  'native render resident: {"limit":8589934592',
  "Conversion failed!",
  "wrote 41943040 of 1887436800 bytes",
  "(os error 32)",
];
