// Every ffmpeg run that draws text through libass (caption bands in an export, the coordinate grid
// and labels on an inspect frame) references its .ass files by BARE name and its fonts through a
// `fonts/` dir, so the run needs a scratch working dir holding both. This is the one place that
// stages it and always removes it, whatever the run does.
import type { ClientToolContext } from "./context";
import { joinPath } from "./store";

// The bundled font directory (resources/fonts), resolved lazily via the Tauri path API and
// cached. null outside a Tauri context (tests / browser bundle); then nothing is copied and
// libass falls back to its built-in default. The PROMISE is cached, so the frames of one look,
// which stage their runs at the same moment, share one resolution instead of racing to make it.
let fontDir: Promise<string | null> | undefined;
export function bundledFontDir(): Promise<string | null> {
  fontDir ??= (async () => {
    try {
      const { resolveResource } = await import("@tauri-apps/api/path");
      return await resolveResource("resources/fonts");
    } catch {
      return null;
    }
  })();
  return fontDir;
}

export interface AssFile {
  name: string;
  content: string;
}

/** Run `fn` with a scratch dir holding `assFiles` and the bundled `fonts` they name, then delete
 *  it, on success, failure or throw. With no .ass files there is no scratch dir and `fn` gets
 *  `undefined`: the common, caption-less render is untouched. Two files with one name must be the
 *  same file; a clash means two callers disagree about what a name draws, which is a bug. */
export async function withAssScratch<T>(
  ctx: ClientToolContext,
  assFiles: readonly AssFile[],
  fonts: readonly string[],
  fn: (cwd: string | undefined) => Promise<T>,
): Promise<T> {
  if (!assFiles.length) return fn(undefined);
  const byName = new Map<string, string>();
  for (const f of assFiles) {
    const prev = byName.get(f.name);
    if (prev !== undefined && prev !== f.content)
      throw new Error(`two different .ass files are both named ${f.name}`);
    byName.set(f.name, f.content);
  }
  const relBase = `renderer/caps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const scratch = ctx.store.artifactPath(relBase);
  try {
    for (const [name, content] of byName)
      await ctx.store.writeText(await ctx.store.prepareArtifact(`${relBase}/${name}`), content);
    const fontDir = fonts.length ? await bundledFontDir() : null;
    if (fontDir) {
      for (const file of new Set(fonts)) {
        try {
          await ctx.store.writeBytes(
            joinPath(scratch, "fonts", file),
            await ctx.store.readBytes(joinPath(fontDir, file)),
          );
        } catch {
          /* a missing/unreadable bundled font: libass just falls back for that family */
        }
      }
    }
    return await fn(scratch);
  } finally {
    await ctx.store.remove(scratch).catch(() => undefined);
  }
}
