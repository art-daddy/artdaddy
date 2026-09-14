// Abstraction over spawning a bundled/PATH binary. The Tauri shell plugin
// implements this in production (src/tools/tauri.ts); tests inject a mock.
export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  /** Run a binary. When `signal` is provided and it aborts, a running process is
   *  killed and the result comes back with a "cancelled" stderr. `cwd` sets the process working
   *  directory (the renderer runs ffmpeg in a scratch dir so libass .ass files resolve by bare name;
   *  input + output paths are absolute, so cwd never affects them).
   *
   *  `onStdout` receives decoded output AS IT ARRIVES. Without it a caller only ever sees the
   *  whole buffer at exit, which is why a render could report nothing until it finished. */
  run(
    program: string,
    args: string[],
    signal?: AbortSignal,
    cwd?: string,
    onStdout?: (chunk: string) => void,
  ): Promise<CommandResult>;
}

/** Trim a failed process's stderr to `max` chars, keeping BOTH ends.
 *
 *  ffmpeg names the cause on one of its FIRST lines ("Padded dimensions cannot be
 *  smaller than input dimensions") and then floods with per-stream noise, so a
 *  tail-only excerpt drops the only line worth reading — that is why a `-22` abort
 *  once needed a track-by-track bisect. The tail still matters (whisper/yt-dlp put
 *  their summary last), so keep a head-heavy split of both. */
export function stderrExcerpt(stderr: string | null | undefined, max = 1500): string {
  const s = (stderr ?? "").trim();
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  const cut = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${cut} chars elided]…\n${s.slice(-tail)}`;
}
