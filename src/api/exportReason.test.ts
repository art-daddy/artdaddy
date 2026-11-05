import { describe, expect, it } from "vitest";

import { EXPORT_REASON_CODES, reasonOfError } from "./exportReason";

// The words an export's failure arrives in (ffmpeg's own text, the app's own refusals) and the reason
// they are filed under. These pairs are what the report has classified since it existed; the module
// that holds the rule moved out of exportEvents.ts so the chat card and the assistant tool can use the
// SAME rule without importing the report (which tests replace wholesale).
const CASES: ReadonlyArray<[string, (typeof EXPORT_REASON_CODES)[number]]> = [
  ["write failed: No space left on device", "storage_full"],
  ["ENOSPC: no space left on device, write", "storage_full"],
  ["the disk is full", "storage_full"],
  ["No such file or directory: C:/media/a.mov", "source_unavailable"],
  ["source clip_3 missing", "source_unavailable"],
  ["media file is offline: beach.mov", "source_unavailable"],
  ["still generating: a voiceover", "source_unavailable"],
  ["failed to generate a_1", "source_unavailable"],
  ["x is not in the library", "source_unavailable"],
  ["Permission denied", "storage_unavailable"],
  ["Access is denied. (os error 5)", "storage_unavailable"],
  ["EACCES: permission denied, open", "storage_unavailable"],
  ["the destination is unavailable", "storage_unavailable"],
  ["render resident memory budget exceeded: sampled=3758313472, limit=3758096384", "memory_limit"],
  ["Error while filtering: Cannot allocate memory", "memory_limit"],
  ["out of memory", "memory_limit"],
  // ffmpeg and its encoders say a refused allocation in several ways; the field's own line (a real replay of an
  // 8K clip inside a memory wall) is the first of them.
  ["x264 [error]: malloc of size 12030144 failed", "memory_limit"],
  ["[libx264 @ 0000020a] Failed to allocate 12030144 bytes", "memory_limit"],
  ["Could not allocate memory for the frame buffer", "memory_limit"],
  ["There is not enough memory to continue", "memory_limit"],
  ["ENOMEM", "memory_limit"],
  ["the render deadline passed", "time_limit"],
  ["export execution expired", "time_limit"],
  ["timed out", "time_limit"],
  // What the app itself says when it stops an export: it stood still, or the PC ran short of memory.
  ["export stopped: it made no progress for 3 min (stalled)", "time_limit"],
  ["export stopped: it had not started making progress after 5 min (stalled)", "time_limit"],
  [
    "render memory floor crossed: the PC has 410 MiB left and keeps 768 MiB for itself",
    "memory_limit",
  ],
  ["artifact verification failed", "verification_failed"],
  ["frame count 598 of 600", "verification_failed"],
  ["duration mismatch", "verification_failed"],
  ["the app was restarted", "interrupted"],
  ["crash", "interrupted"],
  ["ffmpeg render failed (code=-22)", "render_failed"],
  ["the encoder exited", "render_failed"],
  ["something nobody has seen before", "unknown"],
  ["", "unknown"],
];

describe("reasonOfError", () => {
  it.each(CASES)("files %j under %s", (text, code) => {
    expect(reasonOfError(text)).toBe(code);
  });

  it("answers a reason the report knows, for any text at all", () => {
    for (const text of ["", " ", "\u0000", "x".repeat(100_000), "NO SPACE LEFT", "💥"])
      expect(EXPORT_REASON_CODES).toContain(reasonOfError(text));
  });

  it("is not fooled by upper case, and looks only at the start of a very long text", () => {
    expect(reasonOfError("CANNOT ALLOCATE MEMORY")).toBe("memory_limit");
    // Only the first 32 KiB is read: a failure that names its cause at the end of a wall of text is
    // filed by what came first (the cost of bounding the work).
    expect(reasonOfError(`${"a".repeat(40_000)} no space left`)).toBe("unknown");
  });

  it("does not take every mention of a word that sounds like memory for a refused allocation", () => {
    for (const text of [
      "memory leak detected in the test harness",
      "the encoder allocated 12 buffers",
      "Memory mapped file opened",
      "alloc: 3 frames",
    ])
      expect(reasonOfError(text)).not.toBe("memory_limit");
  });
});
