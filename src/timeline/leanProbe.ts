// Asks ffmpeg itself what a picture looks like where the lean paths need to know (Phase 3a, fix 1): the pixel format it arrives in and its size after the
// graph's own pre-scale. ffmpeg reports them through `showinfo`; nothing about ffmpeg's rounding (force_divisible_by, aspect-preserving scale, an
// automatic rotation from the file's orientation) is re-implemented here, because the mask must be EXACTLY the size of the picture it is merged into.
// A probe that fails, times out or says something unexpected simply has no answer: the caller keeps 0.27.0's recipe for that clip.
import type { CommandRunner } from "../tools/command";
import type { LeanProbed, LeanProbeRequest } from "./leanOptions";

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 3;

interface ShowInfo {
  fmt: string;
  width: number;
  height: number;
}

/** Every `showinfo` line of ffmpeg's log, in graph order. */
export function parseShowinfo(log: string): ShowInfo[] {
  const out: ShowInfo[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (!/Parsed_showinfo_\d+/.test(line)) continue;
    const fmt = /\bfmt:(\S+)/.exec(line)?.[1];
    const size = /\bs:(\d+)x(\d+)\b/.exec(line);
    if (fmt && size) out.push({ fmt, width: Number(size[1]), height: Number(size[2]) });
  }
  return out;
}

/** What the probe's two `showinfo` lines say, or null when the answer is not the two sizes of one frame. */
export function probedFromLog(log: string): LeanProbed | null {
  const lines = parseShowinfo(log);
  if (lines.length !== 2) return null;
  const [before, after] = lines;
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

/** Answer the builder's requests (distinct by key), a few at a time. A request with no answer is left out of the map. Never throws. */
export async function probeLean(
  runner: CommandRunner,
  requests: readonly LeanProbeRequest[],
  signal?: AbortSignal,
): Promise<Map<string, LeanProbed>> {
  const distinct = [...new Map(requests.map((r) => [r.key, r])).values()];
  const answers = new Map<string, LeanProbed>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const request = distinct[next++];
      if (!request) return;
      const probed = await probeOne(runner, request, signal);
      if (probed) answers.set(request.key, probed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, distinct.length) }, worker));
  return answers;
}
