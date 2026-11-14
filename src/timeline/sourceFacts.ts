// ONE reader of a source file's size, codec and see-through-ness (lane L3, Phase 3a; asked for by lane L2's report bands and lane L3c's cost model, and used by the
// lean render paths' eligibility). A thin, cached-per-call wrapper over the app's existing probe (`probePath`, tools/media.ts: display size with a
// quarter-turn applied, an EXIF orientation read from the first frame of a still): nothing here reads a file a second way.
//
// UNKNOWN IS NULL. A value that could not be read is null and a file that could not be probed has no entry; no stand-in word (`other`, `unknown`, 0) is
// ever written, so a consumer that bands a value leaves its field ABSENT when the value is null (lane L2's rule).
import { probePath } from "../tools/media";
import type { CommandRunner } from "../tools/command";
import { pixFmtHasAlpha } from "./pixelFormats";

export { pixFmtHasAlpha };

export interface SourceFacts {
  /** What the file is to ffmpeg: a video, a still picture, or sound only. */
  kind: "video" | "image" | "audio";
  /** Display size in pixels (a quarter-turn rotation already applied). Null: unknown. */
  width: number | null;
  height: number | null;
  /** ffprobe's codec name of the first video stream (a still picture's own codec for an image; the audio codec for sound only). Null: unknown. */
  codec: string | null;
  /** True or false when the pixel format says; null when it is not a format this table knows. */
  hasAlpha: boolean | null;
}

const SINGLE_PICTURE = /(^|,)(\w+_pipe|image2)(,|$)/;
const asDimension = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;

/** Read one file's facts, or null when the probe fails. */
export async function readOneSourceFacts(
  runner: CommandRunner,
  path: string,
): Promise<SourceFacts | null> {
  let probed: Record<string, unknown>;
  try {
    probed = await probePath(runner, path);
  } catch {
    return null;
  }
  if (probed.ok !== true) return null;
  const video = (probed.video ?? null) as Record<string, unknown> | null;
  const audio = (probed.audio ?? null) as Record<string, unknown> | null;
  if (!video) {
    if (!audio) return null;
    return {
      kind: "audio",
      width: null,
      height: null,
      codec: typeof audio.codec === "string" ? audio.codec : null,
      hasAlpha: null,
    };
  }
  return {
    kind: SINGLE_PICTURE.test(String(probed.format ?? "")) ? "image" : "video",
    width: asDimension(video.width),
    height: asDimension(video.height),
    codec: typeof video.codec === "string" ? video.codec : null,
    hasAlpha: pixFmtHasAlpha(video.pix_fmt),
  };
}

/** The facts of several files, a few probes at a time. A file that could not be read is left out of the map. Never throws. */
export async function readSourceFacts(
  runner: CommandRunner,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, SourceFacts>> {
  const distinct = [...new Set(paths)];
  const facts = new Map<string, SourceFacts>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const path = distinct[next++];
      if (path === undefined) return;
      const read = await readOneSourceFacts(runner, path);
      if (read) facts.set(path, read);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, distinct.length) }, worker));
  return facts;
}
