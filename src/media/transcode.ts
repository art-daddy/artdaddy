// Run ffmpeg to produce ONE derived file atomically: written to a temp sibling and renamed onto its
// destination only on a clean exit, so a killed or interrupted run never leaves a partial file that a
// later "already made?" check would accept. Shared by the preview's proxies and posters and by the
// still-picture owner; a leaf module so the latter never reaches the tool modules.
import { stderrExcerpt, type CommandRunner } from "../tools/command";
import type { ProjectStoreAccess } from "../tools/store";

/** Run `ffmpeg -y -hide_banner -loglevel error <midArgs> <tmp>`, then move tmp onto `dest`. Falls
 *  back to a direct write when the fs has no rename. Returns success. */
export async function transcode(
  store: ProjectStoreAccess,
  runner: CommandRunner,
  dest: string,
  midArgs: string[],
  signal?: AbortSignal,
): Promise<boolean> {
  const canRename = store.canRename;
  const dot = dest.lastIndexOf(".");
  const rand = Math.random().toString(36).slice(2, 8);
  const out = !canRename
    ? dest
    : dot < 0
      ? `${dest}.tmp-${rand}`
      : `${dest.slice(0, dot)}.tmp-${rand}${dest.slice(dot)}`;
  const r = await runner
    .run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...midArgs, out], signal)
    .catch(() => ({ code: -1, stdout: "", stderr: "" }));
  if (r.code !== 0 || !(await store.exists(out))) {
    console.warn(
      `[transcode] ffmpeg failed dest=${dest} code=${r.code} stderr=${stderrExcerpt(r.stderr, 300)}`,
    );
    if (canRename) await store.remove(out).catch(() => undefined);
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
