// Getting a finished recording into the library.
//
// Everything media enters by is `registerLibraryClip`, so this does not write a catalog row of
// its own — it stages a file and hands it over, exactly like import and drag-drop. The only extra
// step is the container: MediaRecorder may have produced WebM, which mp4box cannot demux, so the
// preview would show nothing for a clip that plays fine everywhere else. Transcode before it
// enters rather than leaving an asset the editor cannot draw.
import type { CommandRunner } from "../tools/command";
import { registerLibraryClip, stageByPath } from "../tools/import";
import type { ProjectStoreAccess } from "../tools/store";
import { extensionForMime, isPlayableContainer, recordingName } from "./recorder";

export interface SavedRecording {
  media_ref: string;
  filename: string;
  /** Whether the bytes had to be re-encoded on the way in. */
  transcoded: boolean;
}

export async function saveRecording(
  ctx: { store: ProjectStoreAccess; runner: CommandRunner },
  bytes: Uint8Array,
  mime: string,
  at: Date = new Date(),
): Promise<SavedRecording> {
  if (!bytes.length) throw new Error("the recording is empty — nothing was captured");
  const { store, runner } = ctx;
  const stamp = `${Date.now().toString(36)}`;
  const ext = extensionForMime(mime);
  const raw = await store.prepareArtifact(`rec/${stamp}.${ext}`);
  await store.writeBytesAtomic(raw, bytes);

  let final = raw;
  const transcoded = !isPlayableContainer(mime);
  if (transcoded) {
    const mp4 = await store.prepareArtifact(`rec/${stamp}.mp4`);
    const r = await runner.run("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      raw,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      mp4,
    ]);
    // Leave nothing behind on failure: a half-written mp4 beside an orphan webm in the cache is
    // worse than the error, because neither is reachable from the library.
    if (r.code !== 0 || !(await store.exists(mp4))) {
      await store.remove(raw).catch(() => undefined);
      await store.remove(mp4).catch(() => undefined);
      throw new Error(`could not convert the recording for the editor: ${tail(r.stderr)}`);
    }
    await store.remove(raw).catch(() => undefined);
    final = mp4;
  }

  const filename = recordingName(at);
  // Same choice the import path makes: stream it when the platform can hash without reading the
  // whole file, otherwise hand over the bytes and clean up the copy we staged.
  const streamed = store.canStreamImport;
  const src = streamed ? await stageByPath(store, final, true) : await store.readBytes(final);
  const entry = await registerLibraryClip(store, src, filename, "video", {
    kind: "recording",
    recorded_at: at.toISOString(),
  });
  if (!streamed) await store.remove(final).catch(() => undefined);
  return { media_ref: entry.id, filename: entry.filename, transcoded };
}

function tail(stderr: string): string {
  const lines = (stderr ?? "").trim().split(/\r?\n/).filter(Boolean);
  return lines[lines.length - 1] ?? "ffmpeg gave no reason";
}
