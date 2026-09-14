// Shared helpers for the timeline op test suites. Lives under src/test/ so it is
// excluded from coverage.
import type { CommandResult, CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { ensureTimeline } from "../timeline/engine";
import { ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import { ProjectDocument } from "../project/ProjectDocument";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { asProjectId } from "../project/types";

export class MemFs implements FsLike {
  files = new Map<string, string>();
  async exists(p: string): Promise<boolean> {
    return this.files.has(joinPath(p));
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async mkdir(): Promise<void> {}
  async downloadDir(): Promise<string> {
    return "C:/Users/test/Downloads";
  }
}

export const DIR = "C:/proj";

export function makeRunner(
  impl?: (program: string, args: string[]) => CommandResult,
): CommandRunner {
  return {
    run: async (program, args) =>
      impl ? impl(program, args) : { code: 0, stdout: "", stderr: "" },
  };
}

/** A runner whose ffprobe reports the source HAS an audio stream. */
export const audioRunner = makeRunner((p, a) =>
  p === "ffprobe" && a.includes("-select_streams")
    ? { code: 0, stdout: "1", stderr: "" }
    : { code: 0, stdout: "", stderr: "" },
);

/** A runner whose ffprobe reports a VIDEO stream only (no audio), so an add_clips
 *  of an .mp4 stays a single video clip — no audio-only downgrade (sourceHasVideo),
 *  no linked-audio split (sourceHasAudio). */
export const videoRunner = makeRunner((p, a) => {
  if (p !== "ffprobe" || !a.includes("-select_streams")) return { code: 0, stdout: "", stderr: "" };
  return { code: 0, stdout: a[a.indexOf("-select_streams") + 1] === "v" ? "1" : "", stderr: "" };
});

// --- Ephemeral open-document backing for the timeline op suites (Phase 5.5) --------------
// A project's timeline edits commit through its OPEN ProjectDocument's in-memory
// TimelineSession + gate (engine.runTimelineCommit resolves the document by the store's dir).
// To exercise that real path, seededCtx registers a fresh ProjectDocument for the store's dir
// and points the leaf resolver at it. A FRESH doc per call keeps each test's in-memory timeline
// isolated; the resolver is keyed by the dir's LAST path segment, which is exactly how
// openDocumentByDir maps a store.projectDir back to its document.
function dirSegment(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";
}

let activeTestDoc: { seg: string; doc: ProjectDocument } | null = null;

/** Register a fresh OPEN ProjectDocument for `dir` and install the leaf resolver, returning the
 *  doc so a test can flush/inspect it. Each call supersedes the previous active doc (one project
 *  under test at a time), so per-test setup needs no explicit teardown for correctness. */
export function registerTestDocument(dir: string): ProjectDocument {
  const seg = dirSegment(dir);
  const doc = new ProjectDocument(asProjectId(seg), {
    open: async () => "loaded",
    dispose: async () => {},
  });
  activeTestDoc = { seg, doc };
  setOpenDocumentResolver((id) =>
    activeTestDoc && String(id) === activeTestDoc.seg ? activeTestDoc.doc : undefined,
  );
  return doc;
}

/** Flush the active document's pending autosave and clear the injected resolver. Use in afterEach
 *  when a suite asserts on-disk state or must not leak the resolver into a non-document test. */
export async function resetTestDocuments(): Promise<void> {
  const prev = activeTestDoc;
  activeTestDoc = null;
  setOpenDocumentResolver(() => undefined);
  if (prev) await prev.doc.autosave.flush();
}

/** Flush the pending autosave WITHOUT tearing the document down, for a test that asserts on disk
 *  MID-test. An edit commits into the document's in-memory session and reaches timeline.json on
 *  the autosave, so reading the file straight after a tool call is a race: it happened to pass in
 *  file order and failed under `--sequence.shuffle`. afterEach is too late to help. */
export async function flushTestDocuments(): Promise<void> {
  await activeTestDoc?.doc.autosave.flush();
}

export async function seededCtx(
  runner?: CommandRunner,
  dir: string = DIR,
): Promise<{ ctx: ClientToolContext; store: ProjectStoreAccess; doc: ProjectDocument }> {
  const store = new ProjectStoreAccess(dir, new MemFs());
  const doc = registerTestDocument(dir);
  await ensureTimeline(store);
  // Default to a runner that reports a real video stream, so a bare ".mp4" is a
  // VIDEO clip (not audio-downgraded) deterministically — no dependence on probe-
  // cache state leaking across tests. Tests wanting linked audio pass audioRunner.
  return { ctx: { store, runner: runner ?? videoRunner }, store, doc };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findClipById(tl: any, id: string): any {
  for (const t of tl.tracks ?? []) for (const c of t.clips ?? []) if (c.id === id) return c;
  throw new Error(`clip ${id} not found`);
}
