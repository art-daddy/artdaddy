// Loudness of an asset over the span the agent is looking at. EBU R128 integrated loudness and true
// peak from ffmpeg's `ebur128`, plain RMS from `volumedetect` (owner decision 2026-10-04: astats'
// figure to the 0.1 dB reported, 27% faster). One audio-only decode of the span; the picture is
// never read. A look waits for at most 10 minutes of audio (lookLoudness); a longer span is measured
// by the project's indexer, which also measures every file whole once it is imported.
import type { AppCache } from "./appCache";
import { stderrExcerpt } from "./command";
import type { ClientToolContext } from "./context";
import { backgroundLoudness } from "./transcriptQueue";

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
  return Number.isFinite(v) ? Math.round(v * 10) / 10 || 0 : null; // ffmpeg prints -0.0
}

/** volumedetect measures in 16 bits and prints its floor, -91.0 dB, for anything quieter. */
const VOLUMEDETECT_FLOOR_DB = -91;

/** Read the three figures out of ffmpeg's stderr. Only text after "Summary:" counts (ebur128's
 *  per-frame log, when on, prints a running `I:` before it). The RMS is the LAST `mean_volume`:
 *  ffmpeg builds and discards a first volumedetect before the run. At the floor it is silence. */
export function parseLoudness(stderr: string): Loudness {
  const summary = stderr.slice(Math.max(0, stderr.lastIndexOf("Summary:")));
  const volume = stderr.slice(Math.max(0, stderr.lastIndexOf("mean_volume:")));
  const rms = db(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(volume)?.[1]);
  return {
    integrated_lufs: db(/I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(summary)?.[1]),
    true_peak_dbtp: db(/True peak:\s*[\r\n]+\s*Peak:\s*(-?[\d.]+|-inf)/.exec(summary)?.[1]),
    rms_dbfs: rms !== null && rms > VOLUMEDETECT_FLOOR_DB ? rms : null,
  };
}

/** Bump when what is measured, or how, changes: entries under the old one are then never read.
 *  v2: RMS from volumedetect, not astats. */
const LOUDNESS_FORMAT = "v2";

/** The span as a key: from the start and to the end name themselves, whatever form they came in. */
function spanKey(start: number | null, end: number | null): string {
  const from = start !== null && start > 0 ? start.toFixed(3) : "0";
  return `${from}-${end !== null ? end.toFixed(3) : "end"}`;
}

const isLoudness = (v: unknown): v is Loudness =>
  !!v && typeof v === "object" && "integrated_lufs" in v && "rms_dbfs" in v;

/** Where `path`'s figures over the span are kept: in the app cache, under the file's identity and
 *  the span (4f). Null where nothing can be kept. */
async function slot(
  ctx: ClientToolContext,
  path: string,
  start: number | null,
  end: number | null,
): Promise<{ cache: AppCache; key: string } | null> {
  const identity = await ctx.store.fileIdentity(path).catch(() => null);
  if (!identity) return null;
  const cache = await ctx.store.appCache();
  return cache
    ? { cache, key: `loudness:${LOUDNESS_FORMAT}:${identity}:${spanKey(start, end)}` }
    : null;
}

async function kept(at: { cache: AppCache; key: string } | null): Promise<Loudness | null> {
  const v = at ? await at.cache.get<unknown>("loudness", at.key) : null;
  return isLoudness(v) ? v : null;
}

/** The figures kept for `path` over [start, end), or null. Never measures. */
export async function peekLoudness(
  ctx: ClientToolContext,
  path: string,
  start: number | null,
  end: number | null,
): Promise<Loudness | null> {
  return kept(await slot(ctx, path, start, end));
}

/** Measure `path`'s first audio stream over [start, end) seconds (the whole file when null). Kept
 *  in the app cache under the file's identity and the span (4f), so the same span of the same
 *  file is measured once, in any project. A failure is not kept. */
export async function measureLoudness(
  ctx: ClientToolContext,
  path: string,
  start: number | null,
  end: number | null,
): Promise<Loudness | { error: string }> {
  const at = await slot(ctx, path, start, end);
  const known = await kept(at);
  if (known) return known;

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
    "ebur128=peak=true:framelog=quiet,volumedetect",
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
  if (at) await at.cache.put("loudness", at.key, got);
  return got;
}

/** The longest span a look measures while the model waits (owner decision 2026-10-04): about
 *  0.3 s of decoding per minute of audio. A longer one is measured in the background. */
export const INLINE_LOUDNESS_MAX_S = 600;

/** How long a look waits for a background measurement an earlier look was told is coming. */
export const LOUDNESS_WAIT_MS = 60_000;

export type LookedLoudness =
  Loudness | { error: string } | { status: "in_progress" | "unavailable"; note: string };

/** `p`'s value, or null once `ms` pass or `signal` aborts, whichever is first. */
function settledWithin<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | null> {
  return new Promise((resolve) => {
    const finish = (v: T | null): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(v);
    };
    const stop = (): void => finish(null);
    const timer = setTimeout(stop, ms);
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    p.then(finish, stop);
  });
}

/** The loudness a look answers with, over [start, end) of a span `seconds` long (null: unknown).
 *  Kept figures come back at once, however long the span. Otherwise a span of up to
 *  {@link INLINE_LOUDNESS_MAX_S} is measured now; a longer one goes to the front of the project's
 *  background queue and answers "in progress" once: a later look waits up to
 *  {@link LOUDNESS_WAIT_MS} for that measurement. */
export async function lookLoudness(
  ctx: ClientToolContext,
  path: string,
  start: number | null,
  end: number | null,
  seconds: number | null,
): Promise<LookedLoudness> {
  const known = await peekLoudness(ctx, path, start, end);
  if (known) return known;
  if (seconds !== null && seconds <= INLINE_LOUDNESS_MAX_S)
    return measureLoudness(ctx, path, start, end);
  const long =
    seconds !== null
      ? `${Math.ceil(seconds / 60)} minutes of audio is`
      : "a span of unknown length is";
  const zoom = `Pass start_seconds/end_seconds covering up to ${INLINE_LOUDNESS_MAX_S / 60} minutes to measure that part now.`;
  const bg = backgroundLoudness(ctx.store.projectDir, path, start, end);
  if (!bg)
    return {
      status: "unavailable",
      note: `Not measured: ${long} too long to wait for, and nothing measures in the background for this project. ${zoom}`,
    };
  if (!bg.first) {
    const got = await settledWithin(bg.result, LOUDNESS_WAIT_MS, ctx.signal);
    if (got) return got;
  }
  return {
    status: "in_progress",
    note: `Not measured yet: ${long} too long to wait for, so it is being measured in the background, this span next. Call inspect_media again for it: that call waits for it. ${zoom}`,
  };
}
