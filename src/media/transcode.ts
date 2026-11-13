// Run ffmpeg to produce ONE derived file atomically: written to a temp sibling and renamed onto its
// destination only on a clean exit, so a killed or interrupted run never leaves a partial file that a
// later "already made?" check would accept. Shared by the preview's proxies and posters and by the
// still-picture owner; a leaf module so the latter never reaches the tool modules.
import { stderrExcerpt, type CommandRunner } from "../tools/command";
import type { ProjectStoreAccess } from "../tools/store";
import { createProgressReader, type RenderProgress } from "../timeline/ffmpegProgress";

/** Run `ffmpeg -y -hide_banner -loglevel error <midArgs> <tmp>`, then move tmp onto `dest`. Falls
 *  back to a direct write when the fs has no rename. Returns success.
 *
 *  With `onProgress`, ffmpeg also writes its `-progress` report to the runner's output as it goes
 *  and every block is handed over (timeline/ffmpegProgress.ts); without it the command is exactly
 *  what it always was, so a poster or a still's stand-in, which take seconds, are unchanged. */
export async function transcode(
  store: ProjectStoreAccess,
  runner: CommandRunner,
  dest: string,
  midArgs: string[],
  signal?: AbortSignal,
  onProgress?: (p: RenderProgress) => void,
): Promise<boolean> {
  const canRename = store.canRename;
  const dot = dest.lastIndexOf(".");
  const rand = Math.random().toString(36).slice(2, 8);
  const out = !canRename
    ? dest
    : dot < 0
      ? `${dest}.tmp-${rand}`
      : `${dest.slice(0, dot)}.tmp-${rand}${dest.slice(dot)}`;
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...(onProgress ? ["-nostats", "-progress", "pipe:1"] : []),
    ...midArgs,
    out,
  ];
  const r = await (
    onProgress
      ? runner.run("ffmpeg", args, signal, undefined, createProgressReader(onProgress))
      : runner.run("ffmpeg", args, signal)
  ).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  if (r.code !== 0 || !(await store.exists(out)) || signal?.aborted) {
    console.warn(
      `[transcode] ffmpeg failed dest=${dest} code=${r.code} stderr=${stderrExcerpt(r.stderr, 300)}`,
    );
    await store.remove(out).catch(() => undefined);
    return false;
  }
  if (canRename) {
    try {
      await store.rename(out, dest);
    } catch (e) {
      console.warn(`[transcode] rename failed ${out} -> ${dest}: ${String(e)}`);
      await store.remove(out).catch(() => undefined);
      return false;
    }
  }
  return true;
}
