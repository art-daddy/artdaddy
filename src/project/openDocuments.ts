// A leaf lookup from a project's package DIR to its open ProjectDocument, used by transitional
// call sites (the timeline engine) that only hold a `store.projectDir` — not the ProjectId the
// registry is keyed by. A DIRECT `engine -> documentRegistry` import would be a cycle
// (documentRegistry -> store/editor -> timeline/engine), so the composition root injects the
// resolver here instead (dependency inversion). This module imports ONLY project-layer types, so
// nothing it touches can close that cycle. Phase 5 removes it once the per-id owners hold their
// document reference directly and the engine folds into the document command layer.
import type { ProjectDocument } from "./ProjectDocument";
import { boundProjectId } from "../tools/dataRoot";
import { asProjectId } from "./types";

let resolver: (id: ReturnType<typeof asProjectId>) => ProjectDocument | undefined = () => undefined;

/** Wire the open-document lookup (called once at the composition root with the app registry). */
export function setOpenDocumentResolver(
  r: (id: ReturnType<typeof asProjectId>) => ProjectDocument | undefined,
): void {
  resolver = r;
}

/** The runtime-AUTHORITY document whose package dir is `projectDir` — open, close-failed, OR mid-close
 *  — or undefined when none owns it (a never-opened / being-created project, a bare test store, or the
 *  brief open window before the registry publishes the document). A CLOSING doc resolves here (unlike
 *  the UI `get()`) so the executor routes a late commit through its (closing) gate and is rejected,
 *  instead of finding "no document" and slipping past admission on a bare lock. The id is the final
 *  path segment: `safeProjectDir(id)` is `joinPath(projectsRoot, id)`, and the `isSafeProjectId`
 *  charset (`[a-z0-9_]`) guarantees the id occupies exactly one segment — so a non-project dir (a temp
 *  test path) simply resolves to no document and the caller uses its coordinator fallback. */
export function openDocumentByDir(projectDir: string): ProjectDocument | undefined {
  // The basename IS the id while a project sits in the app folder under its own id. Once
  // Save As lets the user name the folder that stops being true, and a wrong answer here is
  // not a missing lookup: the executor reads "no document" and falls back to a bare lock,
  // slipping every commit past the document's admission gate. `boundProjectId` is recorded
  // by the one hop that resolves an id to a directory, so it covers exactly those projects.
  const bound = boundProjectId(projectDir);
  if (bound) return resolver(asProjectId(bound));
  const segment = projectDir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";
  if (!segment) return undefined;
  return resolver(asProjectId(segment));
}

/** The runtime-AUTHORITY document for project `id` — open, close-failed, OR mid-close — or undefined
 *  when none owns it (never opened / being created, or a bare test store). The direct-by-id counterpart
 *  to {@link openDocumentByDir}, for a caller that already holds the ProjectId (the tool host) — routing
 *  through this leaf resolver instead of a `documentRegistry` import keeps the host out of that cycle
 *  (documentRegistry -> openToolHost). */
export function openDocumentById(id: string): ProjectDocument | undefined {
  return resolver(asProjectId(id));
}
