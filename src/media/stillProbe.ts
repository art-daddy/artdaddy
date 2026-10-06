// What an animated still's file says about how it plays, read once for every consumer: the export
// and every inspect look (render.ts resolveClipSources) and the preview's frames (stillFramePack).
//   - facts: its reader, and its own play count wherever the file keeps it -- a WebP's ANIM chunk
//     behind any colour profile (walked chunk by chunk), a GIF's NETSCAPE extension anywhere in the
//     file (Chromium honours it even at the end; ffprobe finds it there too).
//   - timing: each frame's start and one pass, from packet headers (no decoding; packet and decoded
//     frame timestamps are identical for all three readers, measured).
import type { CommandRunner } from "../tools/command";
import { timingFromProbe, type StillTiming } from "./stillFrames";
import {
  browserPasses,
  NO_FACTS,
  PROBE_BYTES,
  stillFacts,
  stillReader,
  webpChunk,
  webpFacts,
  type StillFacts,
  type StillReader,
} from "./stillReader";

/** Reads `length` bytes from `offset` (short or empty past the end); null when unreadable. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array | null>;

/** Chunks walked before giving up on finding a WebP's loop count (VP8X, ICCP, EXIF, XMP, ...). */
const WEBP_CHUNKS = 16;

/** A still's reader and its facts, from its bytes (and ffprobe, for a GIF's loop count). */
export async function probeStillFacts(
  read: ReadRange,
  runner: CommandRunner | null,
  path: string,
  signal?: AbortSignal,
): Promise<{ reader: StillReader | null; facts: StillFacts }> {
  const head = await read(0, PROBE_BYTES);
  const reader = head ? stillReader(head) : null;
  if (!head || !reader) return { reader, facts: NO_FACTS };
  if (reader === "apng") return { reader, facts: stillFacts(head) };
  if (reader === "webp_anim") {
    const found = stillFacts(head);
    if (found.known) return { reader, facts: found };
    // The count lies past the head (behind a big colour profile): walk the chunk headers to it.
    let at = 12 + 8 + 10; // RIFF header, then VP8X (always 10 bytes of payload)
    for (let i = 0; i < WEBP_CHUNKS; i++) {
      const header = await read(at, 8);
      if (!header) break;
      const anim = header[0] === 0x41 /* A */ ? await read(at + 8, 6) : null;
      const step = webpChunk(header, at, anim ?? undefined);
      if (!step) break;
      if ("plays" in step) return { reader, facts: webpFacts(step.plays) };
      at = step.next;
    }
    return { reader, facts: NO_FACTS };
  }
  if (reader === "gif") {
    if (!runner) return { reader, facts: NO_FACTS };
    const plays = await gifLoopCount(runner, path, signal);
    return { reader, facts: plays === undefined ? NO_FACTS : { ...NO_FACTS, known: true, plays } };
  }
  return { reader, facts: NO_FACTS };
}

/** A GIF's NETSCAPE loop count as ffmpeg's GIF reader finds it (null: the file has none, so a browser
 *  plays it once), or undefined when ffprobe could not read the file. */
async function gifLoopCount(
  runner: CommandRunner,
  path: string,
  signal?: AbortSignal,
): Promise<number | null | undefined> {
  // The reader logs the count at debug level while it scans the file for its length; nothing is
  // decoded (`-show_entries format=` reads the header pass only).
  const r = await runner
    .run(
      "ffprobe",
      ["-v", "debug", "-show_entries", "format=nb_streams", "-of", "csv=p=0", path],
      signal,
    )
    .catch(() => null);
  if (!r || r.code !== 0) return undefined;
  const m = /Loop count is (\d+)/.exec(r.stderr);
  return m ? Number(m[1]) : null;
}

/** A still's timing (frame starts, one pass, the passes a browser plays) and picture size, from
 *  packet headers; null when ffprobe could not give a timing the rule can use. */
export async function probeStillTiming(
  runner: CommandRunner,
  path: string,
  reader: StillReader,
  facts: StillFacts,
  signal?: AbortSignal,
): Promise<{ timing: StillTiming; w: number; h: number } | null> {
  const r = await runner
    .run(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=time_base,width,height,nb_frames:packet=pts,duration",
        "-of",
        "json",
        path,
      ],
      signal,
    )
    .catch(() => null);
  if (!r || r.code !== 0) return null;
  let json: { packets?: unknown[]; streams?: unknown[] };
  try {
    json = JSON.parse(r.stdout) as typeof json;
  } catch {
    return null;
  }
  return timingFromProbe(
    { streams: json.streams, frames: json.packets },
    browserPasses(reader, facts),
  );
}
