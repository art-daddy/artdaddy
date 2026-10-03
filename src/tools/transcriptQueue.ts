// The project's background transcriber, as the tools see it. A long whole-file transcript is never
// waited on inside a look (owner decision 2026-10-02, UJ-012): the look returns at once and the file
// goes to the FRONT of the background queue, which runs one whisper at a time. That queue is owned
// by the project's IndexCoordinator; it registers itself here, keyed by the project's directory
// (the stable identity both the editor and the agent's tool host share), so a tool can reach it
// without holding the editor's store.

export interface BackgroundTranscriber {
  /** Put `source` (an absolute path) in `language` ("" = the default) at the front of the queue,
   *  or report that it is already running. False when nothing will transcribe it: the project is
   *  closing, or this machine cannot run the speech engine at all. */
  prioritize(source: string, language: string): boolean;
}

const byDir = new Map<string, BackgroundTranscriber>();
const keyOf = (dir: string): string => dir.replace(/\\/g, "/").replace(/\/+$/, "");

/** Register the transcriber for `projectDir`. The returned function unregisters it, and only it:
 *  a project reopened before the old session finished closing keeps the new registration. */
export function registerBackgroundTranscriber(
  projectDir: string,
  t: BackgroundTranscriber,
): () => void {
  const key = keyOf(projectDir);
  byDir.set(key, t);
  return () => {
    if (byDir.get(key) === t) byDir.delete(key);
  };
}

/** Ask `projectDir`'s background transcriber to do `source` next. False when there is none. */
export function prioritizeTranscript(projectDir: string, source: string, language: string): boolean {
  return byDir.get(keyOf(projectDir))?.prioritize(source, language) ?? false;
}
