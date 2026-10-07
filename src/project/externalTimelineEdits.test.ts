// UJ-028: the document counts timeline changes the in-app agent did not make, so the chat can tell
// the model its picture is stale. Every case drives a REAL producer (engine, gesture, undo, restore,
// the agent's own tools) against an open document, the way the editor and the agent reach it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectDocument } from "./ProjectDocument";
import { setOpenDocumentResolver } from "./openDocuments";
import { asProjectId } from "./types";
import type { MutationOrigin } from "./MutationGate";
import { ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import { runProjectMutation } from "../tools/coordinator";
import type { ClientToolContext } from "../tools/context";
import {
  applyOp,
  ctxApplyOp,
  doRedo,
  doUndo,
  ensureTimeline,
  loadTimeline,
  replaceTimeline,
  runGesture,
} from "../timeline/engine";
import { redoTool, undoTool } from "../timeline/ops";
import { OpError } from "../timeline/errors";
import type { Track } from "../timeline/model";

class MemFs implements FsLike {
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
}

const DIR = "C:/proj";
const AGENT: MutationOrigin = { chatSessionId: "t1", branchId: 0, executionId: 1 };
const track = (id: string, z: number): Track => ({ id, kind: "video", z, clips: [] });
const pushTrack = (id: string, z: number) => (t: { tracks: Track[] }) =>
  void t.tracks.push(track(id, z));

let doc: ProjectDocument;
let store: ProjectStoreAccess;
const agentCtx = (): ClientToolContext =>
  ({ store, origin: AGENT, signal: new AbortController().signal }) as unknown as ClientToolContext;

function openDoc(saveTranscript?: () => Promise<boolean>): void {
  doc = new ProjectDocument(asProjectId("proj"), {
    open: async () => "loaded",
    dispose: async () => {},
    ...(saveTranscript ? { saveTranscript } : {}),
  });
  setOpenDocumentResolver((id) => (id === asProjectId("proj") ? doc : undefined));
}

beforeEach(async () => {
  openDoc();
  store = new ProjectStoreAccess(DIR, new MemFs());
  await ensureTimeline(store);
});
afterEach(async () => {
  await doc.autosave.flush();
  setOpenDocumentResolver(() => undefined);
});

describe("ProjectDocument.externalTimelineEdits", () => {
  it("counts an editor edit, and not an edit the in-app agent made", async () => {
    expect(doc.externalTimelineEdits()).toBe(0);
    await ctxApplyOp(agentCtx(), "agent_add", pushTrack("a", 0));
    expect(doc.externalTimelineEdits()).toBe(0);
    await applyOp(store, "editor_add", pushTrack("b", 1)); // the editor passes no origin
    expect(doc.externalTimelineEdits()).toBe(1);
    await ctxApplyOp(agentCtx(), "agent_add", pushTrack("c", 2));
    expect(doc.externalTimelineEdits()).toBe(1);
  });

  it("does not count a refused edit, or a commit that changed only the library", async () => {
    const refused = await applyOp(
      store,
      "dup",
      (t) => void t.tracks.push(track("v", 0), track("v", 1)),
    );
    expect(refused.ok).toBe(false);
    await runProjectMutation(DIR, "library.write", async (_doc, ctx) => {
      ctx?.markCommitted(); // a real catalog change: an export landing, an import
    });
    expect(doc.externalTimelineEdits()).toBe(0);
  });

  it("counts a whole editor gesture once, and a gesture that rolled back not at all", async () => {
    await runGesture(store, "drag", (apply) => {
      apply("a", pushTrack("a", 0));
      apply("b", pushTrack("b", 1));
    });
    expect(doc.externalTimelineEdits()).toBe(1);
    const r = await runGesture(store, "half", (apply) => {
      apply("c", pushTrack("c", 2));
      apply("d", () => {
        throw new OpError("refused");
      });
    });
    expect(r).toMatchObject({ ok: false });
    expect((await loadTimeline(store)).tracks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(doc.externalTimelineEdits()).toBe(1);
  });

  it("counts Ctrl+Z / Ctrl+Shift+Z in the editor, and not the agent's own undo and redo tools", async () => {
    await ctxApplyOp(agentCtx(), "agent_add", pushTrack("a", 0));
    await ctxApplyOp(agentCtx(), "agent_add", pushTrack("b", 1));
    expect((await undoTool({}, agentCtx())).ok).toBe(true);
    expect((await redoTool({}, agentCtx())).ok).toBe(true);
    expect(doc.externalTimelineEdits()).toBe(0);
    expect((await doUndo(store)).ok).toBe(true);
    expect(doc.externalTimelineEdits()).toBe(1);
    expect((await doRedo(store)).ok).toBe(true);
    expect(doc.externalTimelineEdits()).toBe(2);
  });

  it("does not count an undo with nothing to undo", async () => {
    expect((await doUndo(store)).ok).toBe(false);
    expect(doc.externalTimelineEdits()).toBe(0);
  });

  it("counts a checkpoint restore", async () => {
    const tl = await loadTimeline(store);
    tl.tracks.push(track("restored", 0));
    expect(await replaceTimeline(store, tl)).toBe(true);
    expect(doc.externalTimelineEdits()).toBe(1);
  });

  it("keeps counting after a failed close is cancelled (the gate is replaced, the count is not)", async () => {
    await doc.autosave.flush();
    openDoc(async () => false); // the transcript cannot be saved -> close-failed
    await applyOp(store, "editor_add", pushTrack("a", 0));
    expect(doc.externalTimelineEdits()).toBe(1);
    expect(await doc.close()).toEqual({ ok: false });
    doc.cancelClose();
    expect(doc.phase()).toBe("open");
    await applyOp(store, "editor_add", pushTrack("b", 1));
    await ctxApplyOp(agentCtx(), "agent_add", pushTrack("c", 2));
    expect(doc.externalTimelineEdits()).toBe(2);
  });

  it("refuses the agent's undo once its turn is stopped, like every other agent edit", async () => {
    await applyOp(store, "editor_add", pushTrack("a", 0));
    const stopped = new AbortController();
    stopped.abort();
    const ctx = { store, origin: AGENT, signal: stopped.signal } as unknown as ClientToolContext;
    expect((await undoTool({}, ctx)).ok).toBe(false);
    expect((await loadTimeline(store)).tracks.map((t) => t.id)).toEqual(["a"]);
  });
});
