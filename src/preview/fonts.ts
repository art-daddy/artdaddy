// Register the bundled caption families with the JS font system.
//
// The exporter hands libass `fontsdir=resources/fonts`, so a burned-in caption
// always gets the real face. The preview has no such directory: it draws through
// canvas 2D, which resolves families the way a web page does. None of these are
// system fonts, so an unregistered family silently falls back to Times New Roman
// — the preview stopped matching the export in both face AND line wrapping.
//
// Imported straight from the SAME .ttf files the exporter ships, so the two can't
// drift; Vite emits them into the web bundle, which also keeps this working in a
// packaged build (the resource dir sits outside the fs/asset scopes, and the
// preview worker must never touch Tauri IPC).
import anton from "../../src-tauri/resources/fonts/Anton-Regular.ttf?url";
import bebas from "../../src-tauri/resources/fonts/BebasNeue-Regular.ttf?url";
import oswald from "../../src-tauri/resources/fonts/Oswald-VF.ttf?url";
import playfair from "../../src-tauri/resources/fonts/PlayfairDisplay-VF.ttf?url";
import poppins from "../../src-tauri/resources/fonts/Poppins-Regular.ttf?url";

/** Family -> bundled face. Keys MUST match `FONT_FILES` (timeline/render.ts) and
 *  `BUNDLED_FONTS` (timeline/renderPlan.ts) — a name only in one place renders in
 *  the export and falls back in the preview, which is the bug this file fixes. */
export const BUNDLED_FONT_URLS: Readonly<Record<string, string>> = {
  Anton: anton,
  "Bebas Neue": bebas,
  Oswald: oswald,
  "Playfair Display": playfair,
  Poppins: poppins,
};

/** The slice of FontFaceSet we need, so this works on `document.fonts` (main
 *  thread) and `self.fonts` (preview worker) without pulling in the WebWorker lib. */
export interface FontFaceTarget {
  add(font: FontFace): unknown;
}

let pending: Promise<void> | null = null;

/** Load + register every bundled family. Idempotent per realm (the worker and the
 *  main thread each get their own module instance, and both need the faces). */
export function loadBundledFonts(target: FontFaceTarget): Promise<void> {
  if (pending) return pending;
  pending = Promise.all(
    Object.entries(BUNDLED_FONT_URLS).map(async ([family, url]) => {
      try {
        const face = new FontFace(family, `url("${url}")`);
        await face.load();
        target.add(face);
      } catch {
        /* one bad face must not block the other four (or the preview itself) */
      }
    }),
  ).then(() => undefined);
  return pending;
}
