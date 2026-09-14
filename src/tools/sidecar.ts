// Sidecar routing: which external tools ship as BUNDLED Tauri sidecars (vs a
// PATH program). The desktop app bundles every helper binary so a user needs
// nothing pre-installed. Kept dependency-free (no Tauri imports) so it is
// unit-testable; TauriCommandRunner consumes it.
import { IDENTITY } from "../brand";

/** The one browser sidecar. Its name is build identity: this string, the file staged
 *  in src-tauri/binaries, and the externalBin entry must all agree or the tool fails
 *  at runtime rather than at build. */
export const BROWSER_BIN = `${IDENTITY.sidecarPrefix}-browser`;

/** Tool names that are bundled as Tauri sidecars (src-tauri/binaries/<name>). */
export const SIDECAR_BINS: ReadonlySet<string> = new Set([
  "ffmpeg",
  "ffprobe",
  "yt-dlp",
  "whisper-cli",
  BROWSER_BIN,
]);

export interface SidecarResolution {
  /** True when the tool is launched as a bundled sidecar, false for PATH. */
  sidecar: boolean;
  /** For a sidecar: the externalBin id ("binaries/<name>", triple resolved by
   *  Tauri). Otherwise the program name unchanged. */
  path: string;
}

/** Decide how the Tauri shell should launch a tool. */
export function resolveSidecar(program: string): SidecarResolution {
  return SIDECAR_BINS.has(program)
    ? { sidecar: true, path: `binaries/${program}` }
    : { sidecar: false, path: program };
}
