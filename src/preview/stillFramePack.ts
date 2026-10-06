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
import { probeStillFacts, probeStillTiming } from "../media/stillProbe";
import { packSize, serializePackIndex } from "../media/stillFrames";
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
  // By content, as ffmpeg opens it: a GIF saved as .png animates in the export, so it must here. The
  // facts and timing are the ones the export reads (media/stillProbe.ts), so the preview plays the
  // passes the export plays.
  const read = (offset: number, length: number) => store.readRange(abs, offset, length);
  const { reader, facts } = await probeStillFacts(read, runner, abs, signal);
  if (reader !== "gif" && reader !== "apng" && reader !== "webp_anim") return false;
  const found = await probeStillTiming(runner, abs, reader, facts, signal);
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
