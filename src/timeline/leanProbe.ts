// Asks ffmpeg itself what a picture looks like where the lean paths need to know (Phase 3a, fix 1): the pixel format it arrives in and its size after the
// graph's own pre-scale. ffmpeg reports them through `showinfo`; nothing about ffmpeg's rounding (force_divisible_by, aspect-preserving scale, an
// automatic rotation from the file's orientation) is re-implemented here, because the mask must be EXACTLY the size of the picture it is merged into.
// A probe that fails, times out or says something unexpected simply has no answer: the caller keeps 0.27.0's recipe for that clip.
import type { CommandRunner } from "../tools/command";
import type { LeanProbed, LeanProbeRequest } from "./leanOptions";

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 3;

interface ShowInfo {
  /** The filter instance (`Parsed_showinfo_<n>`) and the frame's own number in that instance. */
  instance: number;
  frame: number;
  fmt: string;
  width: number;
  height: number;
}

/** Every `showinfo` frame line of ffmpeg's log, in log order. */
export function parseShowinfo(log: string): ShowInfo[] {
  const out: ShowInfo[] = [];
  for (const line of log.split(/\r?\n/)) {
    const instance = /^\s*\[Parsed_showinfo_(\d+)\b/.exec(line)?.[1]; // a line that begins with the filter's own tag: ffmpeg also echoes the input's PATH in its log, and a path may hold a newline
    if (instance === undefined) continue;
    const frame = /\bn:\s*(\d+)\b/.exec(line)?.[1];
    const fmt = /\bfmt:(\S+)/.exec(line)?.[1];
    const size = /\bs:(\d+)x(\d+)\b/.exec(line);
    if (frame !== undefined && fmt && size)
      out.push({
        instance: Number(instance),
        frame: Number(frame),
        fmt,
        width: Number(size[1]),
        height: Number(size[2]),
      });
  }
  return out;
}

/**
 * What the probe's two `showinfo` filters say about the FIRST frame, or null when the answer is not the two sizes of one frame. A video input lets a second
 * frame through both filters before ffmpeg stops at `-frames:v 1` (seen on a screen recording), so each filter's frame number 0 is the one that counts.
 */
export function probedFromLog(log: string): LeanProbed | null {
  const first = new Map<number, ShowInfo>();
  for (const line of parseShowinfo(log)) {
    const seen = first.get(line.instance);
    if (!seen || line.frame < seen.frame) first.set(line.instance, line);
  }
  if (first.size !== 2) return null;
  const [before, after] = [...first.values()].sort((a, b) => a.instance - b.instance);
  if (before.frame !== 0 || after.frame !== 0) return null;
  const ok = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 32768;
  if (![before.width, before.height, after.width, after.height].every(ok)) return null;
  return {
    fmt: before.fmt,
    source: [before.width, before.height],
    scaled: [after.width, after.height],
  };
}

async function probeOne(
  runner: CommandRunner,
  request: LeanProbeRequest,
  signal: AbortSignal | undefined,
): Promise<LeanProbed | null> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), PROBE_TIMEOUT_MS);
  const onAbort = (): void => timeout.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await runner.run(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "info",
        "-an",
        "-i",
        request.path,
        // the graph's own `[N:v]` is the FIRST video stream; without this ffmpeg takes the best one, which for a file with two video streams can be another
        "-map",
        "0:v:0",
        "-vf",
        request.filters,
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      ],
      timeout.signal,
    );
    if (result.code !== 0) return null;
    return probedFromLog(result.stderr);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** The whole probing phase gets this long (a probe that hangs or a slow disk must not hold an export back: every clip left without an answer keeps today's recipe). */
export const PROBE_DEADLINE_MS = 10_000;

/** Answer the builder's requests (distinct by key), a few at a time, within one overall deadline. A request with no answer is left out of the map. Never throws. */
export async function probeLean(
  runner: CommandRunner,
  requests: readonly LeanProbeRequest[],
  signal?: AbortSignal,
  deadlineMs: number = PROBE_DEADLINE_MS,
): Promise<Map<string, LeanProbed>> {
  const distinct = [...new Map(requests.map((r) => [r.key, r])).values()];
  const answers = new Map<string, LeanProbed>();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  const onAbort = (): void => deadline.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) deadline.abort();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (deadline.signal.aborted) return;
      const request = distinct[next++];
      if (!request) return;
      const probed = await probeOne(runner, request, deadline.signal);
      if (probed && !deadline.signal.aborted) answers.set(request.key, probed);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, distinct.length) }, worker));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  return answers;
}
