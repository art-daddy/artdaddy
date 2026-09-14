// Preview audio, bounded by the CLIP rather than the file.
//
// Web Audio can only schedule an AudioBuffer, and decodeAudioData needs a whole container —
// so decoding a source directly costs O(the file), which is how a 1.84 GB recording crashed
// the app. Instead ffmpeg (already bundled) extracts just the span the clip actually plays
// into a small cached WAV, and that is what gets decoded. This is Premiere's "conform", and
// it is why a 5-second clip taken from a multi-GB source costs ~1 MB instead of ~1.8 GB.
//
// It also decouples preview from the container: ffmpeg reads Matroska/Opus (which the file
// above turned out to be, despite its .mp4 name) and hands back plain PCM.
import type { CommandRunner } from "../tools/command";
import { shortHash } from "../tools/media";
import type { ProjectStoreAccess } from "../tools/store";

/** Bump when the extraction arguments change, so stale cached WAVs are not reused. */
const CONFORM_REV = 1;

/** How the preview gets an ffmpeg it can run. Overridable so tests (and the web build, which
 *  has no sidecar) can decline without reaching for Tauri. */
let runnerFor: () => Promise<CommandRunner | null> = async () => {
  const { platform } = await import("../platform");
  if (!platform.capabilities.localTools) return null;
  const { TauriCommandRunner } = await import("../tools/tauri");
  return new TauriCommandRunner();
};

/** DI hook: swap the ffmpeg used to conform preview audio (null = no conform available). */
export function setPreviewAudioRunner(fn: () => Promise<CommandRunner | null>): void {
  runnerFor = fn;
}

/** The ffmpeg every preview consumer conforms with, or null where there is none. */
export function previewRunner(): Promise<CommandRunner | null> {
  return runnerFor().catch(() => null);
}

export interface ConformDeps {
  store: ProjectStoreAccess;
  runner: CommandRunner;
}

/** Absolute path of the WAV holding `[inSec, outSec)` of `src`'s audio, extracting it once
 *  and reusing it after. Null when the span has no audio (a silent video), which the caller
 *  must treat as "nothing to play" rather than "not ready yet". */
export async function conformWindow(
  deps: ConformDeps,
  src: string,
  inSec: number,
  outSec: number,
): Promise<string | null> {
  const abs = await deps.store.resolveRef(src);
  if (!abs) return null;
  const from = Math.max(0, inSec);
  const dur = Math.max(0, outSec - from);
  if (dur <= 0) return null;
  const key = shortHash(`${abs}|${from.toFixed(3)}|${dur.toFixed(3)}|r${CONFORM_REV}`);
  const wav = await deps.store.prepareArtifact(`preview/audio_${key}.wav`);
  if (await deps.store.exists(wav)) return wav;
  const r = await deps.runner.run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    // -ss BEFORE -i seeks by index instead of decoding up to the point, so the cost is the
    // window, not the offset into a long recording.
    "-ss",
    from.toFixed(3),
    "-t",
    dur.toFixed(3),
    "-i",
    abs,
    "-vn",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s16le",
    wav,
  ]);
  // A source with no audio track exits non-zero and writes nothing; that is a legitimate
  // answer ("silent"), not a failure to retry forever.
  if (r.code !== 0 || !(await deps.store.exists(wav))) return null;
  return wav;
}
