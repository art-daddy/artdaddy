// The platform's folder chooser, for the one place the app asks where a file should go (Save to). It never
// throws: a picker that cannot open is the same as a person who closed it, and the caller then changes nothing.
import { displayFolder } from "../timeline/exportQuestions";

/** Ask the person to choose a folder. Resolves with its path, or null when they chose none, when the picker
 *  could not open, or when this is not the desktop app (a browser has no folder chooser to ask). `from` is
 *  where the chooser starts, when it names an absolute folder. */
export async function pickFolder(title: string, from?: string): Promise<string | null> {
  const view = typeof window === "undefined" ? undefined : window;
  if (!view || !(view.__TAURI_INTERNALS__ ?? view.__TAURI__)) return null;
  const start = from?.trim() ?? "";
  const absolute = /^([A-Za-z]:|\/)/.test(start);
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen: unknown = await open({
      directory: true,
      multiple: false,
      title,
      ...(absolute ? { defaultPath: displayFolder(start) } : {}),
    });
    const first = Array.isArray(chosen) ? chosen[0] : chosen;
    const path = typeof first === "string" ? first.trim() : "";
    return path === "" ? null : path;
  } catch {
    return null;
  }
}
