// Desktop fast-path helper. On the Tauri desktop build the client and the local
// server share the SAME co-located project dir, so file reads/writes can skip the
// HTTP round-trip and touch the filesystem directly. On web there's no local fs,
// so this returns null and callers fall back to the server endpoints.
import { platform } from "../platform";
import { createProjectStore, useEditor } from "../store/editor";
import { projectDirFor } from "../tools/dataRoot";
import { type ProjectStoreAccess } from "../tools/store";

/** The fs-backed store for `projectId` when we can bypass the server (desktop +
 *  it's the active project), else null (→ HTTP fallback). */
export function desktopStore(projectId: string): ProjectStoreAccess | null {
  if (!platform.capabilities.fileSystem) return null;
  const s = useEditor.getState();
  return s.projectId === projectId && s.store ? s.store : null;
}

/** Like {@link desktopStore} but never races the editor: returns the editor's
 *  store when it's already loaded for `projectId`, otherwise builds a fresh
 *  fs-backed store from the project dir. So session/transcript reads on desktop
 *  ALWAYS hit the co-located `internals/` file instead of falling back to the
 *  stateless server (which no longer persists the transcript). null on web. */
export async function storeForProject(projectId: string): Promise<ProjectStoreAccess | null> {
  if (!platform.capabilities.fileSystem) return null;
  const s = useEditor.getState();
  if (s.projectId === projectId && s.store) return s.store;
  try {
    const dir = await projectDirFor(projectId);
    return await createProjectStore(dir);
  } catch {
    return null;
  }
}
