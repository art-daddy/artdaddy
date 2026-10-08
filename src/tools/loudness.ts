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

/** Bump when what is measured, or how, changes: entries under the old one are then never read. */
const LOUDNESS_FORMAT = "v1";

/** The span as a key: from the start and to the end name themselves, whatever form they came in. */
function spanKey(start: number | null, end: number | null): string {
  const from = start !== null && start > 0 ? start.toFixed(3) : "0";
  return `${from}-${end !== null ? end.toFixed(3) : "end"}`;
}

const isLoudness = (v: unknown): v is Loudness =>
  !!v && typeof v === "object" && "integrated_lufs" in v && "rms_dbfs" in v;

/** Measure `path`'s first audio stream over [start, end) seconds (the whole file when null). Kept
 *  in the app cache under the file's identity and the span (4f), so the same span of the same
 *  file is measured once, in any project. A failure is not kept. */
export async function measureLoudness(
  ctx: ClientToolContext,
  path: string,
  start: number | null,
  end: number | null,
): Promise<Loudness | { error: string }> {
  const identity = await ctx.store.fileIdentity(path).catch(() => null);
  const key = identity ? `loudness:${LOUDNESS_FORMAT}:${identity}:${spanKey(start, end)}` : null;
  const cache = key ? await ctx.store.appCache() : null;
  const kept = cache && key ? await cache.get<unknown>("loudness", key) : null;
  if (isLoudness(kept)) return kept;

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
  if (cache && key) await cache.put("loudness", key, got);
  return got;
}
