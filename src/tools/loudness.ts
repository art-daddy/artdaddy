// Loudness of an asset over the span the agent is looking at (owner decision 2026-10-03: always
// measured, however long the span). EBU R128 integrated loudness and true peak from ffmpeg's
// `ebur128`, plain RMS from `astats`. One audio-only decode of the span; the picture is never read.
import { stderrExcerpt } from "./command";
import type { ClientToolContext } from "./context";

export interface Loudness {
  /** EBU R128 integrated loudness, LUFS. -70 is ffmpeg's floor for silence. */
  integrated_lufs: number | null;
  /** True peak, dBTP (dB relative to full scale, inter-sample peaks included). */
  true_peak_dbtp: number | null;
  /** RMS level over the span, dBFS. */
  rms_dbfs: number | null;
}

/** A dB figure from ffmpeg's text, where silence prints as "-inf". */
function db(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

/** Read the three figures out of ffmpeg's stderr. Only text after "Summary:" counts (ebur128's
 *  per-frame log, when on, prints a running `I:` before it); astats' figures come from its Overall
 *  block. */
export function parseLoudness(stderr: string): Loudness {
  const summary = stderr.slice(Math.max(0, stderr.lastIndexOf("Summary:")));
  const overall = stderr.slice(Math.max(0, stderr.lastIndexOf("Overall")));
  return {
    integrated_lufs: db(/I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(summary)?.[1]),
    true_peak_dbtp: db(/True peak:\s*[\r\n]+\s*Peak:\s*(-?[\d.]+|-inf)/.exec(summary)?.[1]),
    rms_dbfs: db(/RMS level dB:\s*(-?[\d.]+|-inf)/.exec(overall)?.[1]),
  };
}

/** Measure `path`'s first audio stream over [start, end) seconds (the whole file when null). */
export async function measureLoudness(
  ctx: ClientToolContext,
  path: string,
  start: number | null,
  end: number | null,
): Promise<Loudness | { error: string }> {
  const args = ["-hide_banner", "-nostats"];
  if (start !== null && start > 0) args.push("-ss", start.toFixed(3));
  if (end !== null) args.push("-to", end.toFixed(3));
  args.push(
    "-i",
    path,
    "-map",
    "0:a:0",
    "-vn",
    "-af",
    // framelog=quiet: by default ebur128 logs a line per 100 ms of audio, ~1 MB for a 10-minute
    // span. Every line reached the page as its own message, and a few long looks at once
    // overflowed the page's queue and stopped the app's IPC (2026-10-07). The Summary is the same.
    "ebur128=peak=true:framelog=quiet,astats=measure_perchannel=none",
    "-f",
    "null",
    "-",
  );
  const r = await ctx.runner.run("ffmpeg", args, ctx.signal);
  if (r.code !== 0) {
    if (ctx.signal?.aborted) return { error: "cancelled" };
    return { error: `loudness could not be measured: ${stderrExcerpt(r.stderr, 300)}` };
  }
  const got = parseLoudness(r.stderr);
  if (got.integrated_lufs === null && got.rms_dbfs === null)
    return { error: "loudness could not be read from ffmpeg's output" };
  return got;
}
