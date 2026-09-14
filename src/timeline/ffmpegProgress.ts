// Parsing ffmpeg's `-progress` stream.
//
// With `-progress pipe:1 -nostats` ffmpeg writes a block of `key=value` lines every ~0.5s,
// terminated by `progress=continue` (or `progress=end` on the last one). The stream arrives in
// arbitrary chunks, so a block can be split mid-line — the parser keeps a remainder rather than
// assuming chunk boundaries fall anywhere useful.
//
// One trap worth naming: ffmpeg's `out_time_ms` is MICROseconds, not milliseconds. It has been
// wrong for years and is kept for compatibility. `out_time_us` is the honest spelling of the same
// number, and `out_time` is the HH:MM:SS.ffffff form; we read the microsecond fields and convert.

export interface RenderProgress {
  /** Output frames written so far. */
  frame: number;
  /** Encoding rate in frames/sec (0 when ffmpeg has not reported one). */
  fps: number;
  /** Milliseconds of OUTPUT written so far. */
  outMs: number;
  /** Multiple of realtime, e.g. 1.5 means 1.5s of video per second (0 = unknown). */
  speed: number;
  /** True for the final block. */
  done: boolean;
}

const num = (v: string | undefined): number => {
  if (!v) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** Split accumulated text into whole progress blocks plus the unfinished remainder. */
export function parseProgressBlocks(text: string): { records: RenderProgress[]; rest: string } {
  const records: RenderProgress[] = [];
  let fields: Record<string, string> = {};
  let consumed = 0;
  let cursor = 0;

  for (;;) {
    const nl = text.indexOf("\n", cursor);
    if (nl === -1) break;
    const line = text.slice(cursor, nl).trim();
    cursor = nl + 1;
    const eq = line.indexOf("=");
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      fields[key] = value;
      // `progress` terminates a block. Everything before it belongs to this record.
      if (key === "progress") {
        // out_time_us and out_time_ms both carry MICROseconds; prefer whichever ffmpeg sent.
        const micros = fields.out_time_us ?? fields.out_time_ms;
        records.push({
          frame: Math.max(0, Math.round(num(fields.frame))),
          fps: Math.max(0, num(fields.fps)),
          outMs: Math.max(0, micros ? num(micros) / 1000 : hhmmssToMs(fields.out_time)),
          speed: Math.max(0, num((fields.speed ?? "").replace(/x$/, ""))),
          done: value === "end",
        });
        fields = {};
        consumed = cursor;
      }
    }
  }
  return { records, rest: text.slice(consumed) };
}

/** `HH:MM:SS.ffffff` to milliseconds. ffmpeg emits `N/A` before the first frame lands. */
export function hhmmssToMs(t: string | undefined): number {
  if (!t) return 0;
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(t.trim());
  if (!m) return 0;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

/** A stateful feeder over the pure parser, for a stream of chunks. */
export function createProgressReader(
  onRecord: (p: RenderProgress) => void,
): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    const { records, rest } = parseProgressBlocks(buffer);
    buffer = rest;
    // A pathological producer (no newlines at all) must not grow this without bound.
    if (buffer.length > 64_000) buffer = buffer.slice(-8_000);
    for (const r of records) onRecord(r);
  };
}

/** How far through, 0..1. Unknown total (a live/streamed input) reports 0 rather than guessing. */
export function progressFraction(outMs: number, totalMs: number): number {
  if (!(totalMs > 0) || !(outMs > 0)) return 0;
  // ffmpeg routinely overshoots the nominal duration by a frame or two.
  return Math.min(1, outMs / totalMs);
}

/** Seconds remaining, or null when there is not enough information to say.
 *
 *  Deliberately null rather than a guess: an ETA that appears instantly and is wrong is worse
 *  than one that appears a second late and is right. */
export function etaSeconds(outMs: number, totalMs: number, speed: number): number | null {
  if (!(totalMs > 0) || !(speed > 0)) return null;
  const remainingMs = totalMs - outMs;
  if (remainingMs <= 0) return 0;
  return remainingMs / 1000 / speed;
}

/** "2m 05s" / "45s" — short enough to sit next to a progress bar without reflowing it. */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}
