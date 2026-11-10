// Where a project keeps the chats that are put away, and what a file there is called. Kept apart from
// transcriptFile.ts so the media cleanup (tools/mediaGc.ts), which must see every chat file, reads the
// same names without pulling in the persistence queue.
//
// The open chat stays where it always was, `internals/transcript.json`, in the format an older app
// reads. A put-away chat is one file here, `<id>.json`, in that same format plus a title and a time.
// Beside it sits `<id>.meta.json`, a few hundred bytes the list reads instead of every chat, which
// can run to megabytes. The summary is a cache: the chat file is the record, and a missing or
// stale summary is rebuilt from it.
import { INTERNAL_DIR, joinPath, type DirEntry, type ProjectStoreAccess } from "../tools/store";

/** Put-away chats, relative to the project folder. */
export const CHAT_SESSIONS_REL = `${INTERNAL_DIR}/chat/sessions`;

/** An id fit to be a file name: what this app mints (a UUID), never a path or a dotted name. */
const CHAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isChatId(id: unknown): id is string {
  return typeof id === "string" && CHAT_ID_RE.test(id);
}

/** The chat a directory entry holds, or null when it is anything else. `<id>.meta.json` never
 *  matches (an id has no dot), nor does a temp or a `.corrupt-` copy kept aside. */
export function chatFileId(name: string): string | null {
  if (!name.endsWith(".json")) return null;
  const id = name.slice(0, -".json".length);
  return isChatId(id) ? id : null;
}

export const chatSessionsDir = (projectDir: string): string =>
  joinPath(projectDir, CHAT_SESSIONS_REL);
export const chatFilePath = (projectDir: string, id: string): string =>
  joinPath(projectDir, CHAT_SESSIONS_REL, `${id}.json`);
export const chatMetaPath = (projectDir: string, id: string): string =>
  joinPath(projectDir, CHAT_SESSIONS_REL, `${id}.meta.json`);

/** The folder's entries, or null when there is no folder yet. Absent is not unreadable: a folder that
 *  exists and cannot be listed THROWS, so a caller that must see every chat file (the media cleanup)
 *  fails closed instead of treating it as empty. */
export async function readChatDir(store: ProjectStoreAccess): Promise<DirEntry[] | null> {
  const dir = chatSessionsDir(store.projectDir);
  try {
    return await store.readDir(dir);
  } catch (e) {
    if (await store.exists(dir)) throw e;
    return null;
  }
}
