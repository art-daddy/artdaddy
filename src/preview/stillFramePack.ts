// The preview's frames of an animated still (GIF, APNG, animated WebP), made once per asset.
//
// The export decodes these with ffmpeg; the browser's own decoders would show the same file
// differently (and cannot jump to a frame on every platform). So ffmpeg decodes every frame once,
// into transparent PNGs written back to back, and an index records when each one shows. The preview
// then draws, at each project frame, the frame the export draws there (media/stillFrames.ts).
//
// Runs in the background proxy pass, so a still is drawn unmoving (as before) until its frames land.
// Desktop-only (ffmpeg), best-effort: any failure leaves the still unmoving, never broken.
import type { CommandRunner } from "../tools/command";
import type { ProjectStoreAccess } from "../tools/store";
import {
  PROBE_BYTES,
  STILL_HEAD_BYTES,
  stillFacts,
  stillLoop,
  stillReader,
} from "../media/stillReader";
import { packSize, serializePackIndex, timingFromProbe } from "../media/stillFrames";
import { transcode } from "../media/transcode";
import { animIndexName, animPackName } from "./proxyPaths";

/** Make the frames of `source` if it is an animated still that has none yet. True when made. */
export async function makeStillFramePack(
  store: ProjectStoreAccess,
  runner: CommandRunner,
  source: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const abs = await store.resolveRef(source);
  if (!abs) return false;
  const indexPath = store.artifactPath(`proxies/${animIndexName(abs)}`);
  if (await store.exists(indexPath)) return false;
  // By content, as ffmpeg opens it: a GIF saved as .png animates in the export, so it must here.
  // ffmpeg decides from 2 KB (an APNG's facts lie inside it); only a WebP may keep its count further,
  // and then it is read as far as the export reads it.
  let head = await store.readHead(abs, PROBE_BYTES);
  const reader = head ? stillReader(head) : null;
  if (reader !== "gif" && reader !== "apng" && reader !== "webp_anim") return false;
  if (reader === "webp_anim" && stillFacts(head!).plays === null)
    head = (await store.readHead(abs, STILL_HEAD_BYTES)) ?? head;
  // The passes the EXPORT plays (its own answer, which also picks how it loops). A WebP whose count
  // lies past even that is shown looping: the residual is a play-N WebP with a colour profile over
  // 64 KB, which the export plays N times.
  const passes = stillLoop(reader, 30, stillFacts(head!)).passes ?? Infinity;
  const probe = await runner
    .run(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=time_base,width,height:frame=pts,duration",
        "-of",
        "json",
        abs,
      ],
      signal,
    )
    .catch(() => null);
  if (!probe || probe.code !== 0) return false;
  let json: unknown;
  try {
    json = JSON.parse(probe.stdout);
  } catch {
    return false;
  }
  const found = timingFromProbe(json, passes);
  // One frame is a picture: nothing to animate, and the original already draws it.
  if (!found || found.timing.pts.length < 2) return false;
  const size = packSize(found.timing.pts.length, found.w, found.h);
  if (!size) return false;
  const pack = await store.prepareArtifact(`proxies/${animPackName(abs)}`);
  // One pass, every frame as decoded (passthrough: none dropped or repeated), with its alpha.
  const made = await transcode(
    store,
    runner,
    pack,
    [
      "-i",
      abs,
      "-map",
      "0:v:0",
      "-fps_mode",
      "passthrough",
      "-vf",
      `scale=${size.w}:${size.h}:flags=bicubic,format=rgba`,
      "-f",
      "image2pipe",
      "-c:v",
      "png",
    ],
    signal,
  );
  if (!made) return false;
  // The index goes LAST: its presence is what says the frames beside it are complete.
  return store.writeTextAtomic(indexPath, serializePackIndex({ timing: found.timing, ...size }));
}
