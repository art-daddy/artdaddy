// The flat project consistency bridge: a point-in-time READ MODEL of a project's authoritative
// state, so Pack / Duplicate / reference-checks observe the OPEN document's in-memory timeline
// (which may be AHEAD of disk while autosave lags) — never a stale timeline.json — exactly like
// get_timeline / inspect / export / preview already do. Pure: NO disk mutation.
//
// The timeline comes from the SAME reconciler every reader funnels through (loadTimeline: the open
// ProjectDocument's TimelineSession when one is open + edited, else disk), so an aggregate consumer
// is never staler than the editor. The library catalog + project settings are read from disk, which
// is their authority — each is written atomically (temp + rename), so a single read is internally
// consistent (no torn read); only the timeline has an in-memory authority that lags disk.
//
// Future (IDEA-CLIENT-AGGREGATE-001): capture the whole aggregate UNDER the mutation gate for
// cross-field atomicity, carry styles + chat, and validate aggregate invariants (every timeline
// media_ref resolves in the library) — the arch-doc ProjectSnapshot. Alpha reconciles the TIMELINE
// (the only in-memory-authoritative field) and reads the atomic sidecars.
import { openDocumentByDir } from "../project/openDocuments";
import { INTERNAL_DIR, joinPath, type LibraryClip, type ProjectStoreAccess } from "../tools/store";
import { loadTimeline } from "./engine";
import { emptyTimeline, type Timeline } from "./model";

export interface AggregateCatalog {
  version?: number;
  clips?: LibraryClip[];
  folders?: unknown[];
}

export interface ProjectAggregate {
  projectDir: string;
  /** Point-in-time timeline: the open document's in-memory authority (CLONED) when a project is open
   *  and has been edited, else the on-disk timeline.json — both via {@link loadTimeline}. */
  timeline: Timeline;
  /** Which source won: `"memory"` iff an open document held an in-memory timeline (unsaved edits are
   *  captured), else `"disk"`. Lets Duplicate override the copied-from-disk file only when needed. */
  timelineSource: "memory" | "disk";
  /** On-disk library catalog (atomic single-file read; recovers to empty on a corrupt file). */
  library: AggregateCatalog;
  /** On-disk project settings, or null when absent/unreadable. */
  project: ({ name?: string } & Record<string, unknown>) | null;
}

/** Build the point-in-time read model the flat consistency bridge exposes. TOTAL (never throws): a
 *  corrupt/absent disk timeline with no open document degrades to a valid empty timeline, so every
 *  consumer (ref-check → 0 refs, Pack → empty bundle timeline, Duplicate → no override) behaves
 *  predictably instead of throwing. NO disk mutation. */
export async function projectAggregate(store: ProjectStoreAccess): Promise<ProjectAggregate> {
  // Provenance BEFORE the load: an open document holding an in-memory timeline is "memory" (edits
  // may be unsaved). loadTimeline itself makes the same choice; this only labels it for consumers.
  const timelineSource: "memory" | "disk" = openDocumentByDir(store.projectDir)?.timeline
    ? "memory"
    : "disk";
  let timeline: Timeline;
  try {
    timeline = await loadTimeline(store); // in-memory authority when open+edited, else disk
  } catch {
    timeline = emptyTimeline(); // corrupt/absent disk + no open document: degrade to a valid empty timeline
  }
  const library = await store.readJson<AggregateCatalog>(
    joinPath(store.projectDir, INTERNAL_DIR, "library.json"),
    { version: 1, clips: [], folders: [] },
  );
  let project: ({ name?: string } & Record<string, unknown>) | null = null;
  try {
    project = JSON.parse(
      await store.readText(joinPath(store.projectDir, INTERNAL_DIR, "project.json")),
    );
  } catch {
    project = null; // absent/unreadable settings: consumers fall back (dir name, no override)
  }
  return { projectDir: store.projectDir, timeline, timelineSource, library, project };
}
