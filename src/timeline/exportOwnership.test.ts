// UJ-022: an export belongs to the export queue, not to the call that started it. The agent's tool
// context injects the turn's signal into every process a tool starts (so Stop kills them); the
// queued encode ran through that same runner, so cancelling from the queue reached nothing while
// the agent's next message killed the render. These run the export through `agentToolContext`,
// the wrapper the tool host builds for every agent call, with a runner that behaves like a
// process: it ends when released, or exits non-zero the moment its signal aborts.
import { afterEach, describe, expect, it } from "vitest";

import type { MutationOrigin } from "../project/MutationGate";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { ProjectDocument } from "../project/ProjectDocument";
import { asProjectId } from "../project/types";
import { MemFs, registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { agentToolContext } from "../tools/agentStore";
import type { CommandResult, CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { joinPath, ProjectStoreAccess } from "../tools/store";
import { ensureTimeline } from "./engine";
import {
  __resetExportQueue,
  cancelExport,
  listExportRecords,
  whenExportEnds,
  whenExportsSettle,
} from "./exportQueue";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

class RenamingFs extends MemFs {
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(joinPath(from));
    if (v === undefined) throw new Error(`ENOENT ${from}`);
    this.files.delete(joinPath(from));
    this.files.set(joinPath(to), v);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(joinPath(p));
  }
  // The delivered file is read back to catalogue it in the library.
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return new TextEncoder().encode(String(v));
  }
}

/** A runner whose ffmpeg writes its output, then waits: `release()` lets it exit 0; an abort of
 *  the signal it was GIVEN kills it (code 255), as the real runner kills the process tree. */
function processLikeRunner(fs: RenamingFs) {
  const seen: { args: string[]; signal?: AbortSignal }[] = [];
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const runner: CommandRunner = {
    run: async (program, args, signal): Promise<CommandResult> => {
      if (program !== "ffmpeg") return { code: 0, stdout: "", stderr: "" };
      seen.push({ args, signal });
      await fs.writeTextFile(args[args.length - 1], "partial video");
      const killed = new Promise<CommandResult>((resolve) => {
        if (signal?.aborted) resolve({ code: 255, stdout: "", stderr: "killed" });
        signal?.addEventListener("abort", () =>
          resolve({ code: 255, stdout: "", stderr: "killed" }),
        );
      });
      return Promise.race([released.then(() => ({ code: 0, stdout: "", stderr: "" })), killed]);
    },
  };
  return { runner, seen, release: () => release() };
}

async function agentExport(
  opts: { origin?: MutationOrigin; isOriginCurrent?: (o: MutationOrigin) => boolean } = {},
) {
  const fs = new RenamingFs();
  const store = new ProjectStoreAccess("C:/proj", fs);
  if (opts.isOriginCurrent) {
    // The chat's own fence: a commit carrying a retired turn's origin is refused.
    const doc = new ProjectDocument(
      asProjectId("proj"),
      { open: async () => "loaded", dispose: async () => {} },
      { isOriginCurrent: opts.isOriginCurrent },
    );
    setOpenDocumentResolver((id) => (String(id) === "proj" ? doc : undefined));
  } else registerTestDocument("C:/proj");
  await ensureTimeline(store);
  const proc = processLikeRunner(fs);
  const base: ClientToolContext = { store, runner: proc.runner };
  await addClipsTool(
    { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
    { store, runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) } },
  );
  const turn = new AbortController();
  const r = (await exportTimelineTool({}, agentToolContext(base, turn.signal, opts.origin))) as Any;
  expect(r.ok).toBe(true);
  // Let the queue hand the encode to ffmpeg.
  for (let i = 0; i < 20 && proc.seen.length === 0; i++) await new Promise((x) => setTimeout(x, 0));
  return { fs, proc, turn, jobId: String(r.job_id), dest: "C:/Users/test/Downloads/proj.mp4" };
}

afterEach(async () => {
  await resetTestDocuments();
  await whenExportsSettle();
  __resetExportQueue();
});

describe("an export belongs to the queue, not to the turn that started it", () => {
  it("survives the end of the agent's turn (Stop, a new message, a project switch)", async () => {
    const { fs, proc, turn, jobId, dest } = await agentExport();
    turn.abort(); // what Stop, the next message and a project switch all do to the turn
    await new Promise((x) => setTimeout(x, 0));
    expect(proc.seen[0].signal?.aborted ?? false).toBe(false); // ffmpeg is still running
    proc.release();
    expect((await whenExportEnds(jobId))?.state).toBe("done");
    expect(await fs.readTextFile(dest)).toBe("partial video"); // delivered where it belongs
  });

  it("is stopped by Cancel: ffmpeg is killed, the job reads cancelled, nothing is left behind", async () => {
    const { fs, proc, jobId, dest } = await agentExport();
    expect(cancelExport(jobId)).toBe(true);
    expect(proc.seen[0].signal?.aborted).toBe(true);
    expect((await whenExportEnds(jobId))?.state).toBe("cancelled");
    expect(await fs.exists(dest)).toBe(false);
    expect(await fs.exists(proc.seen[0].args[proc.seen[0].args.length - 1])).toBe(false);
  });

  it("writes its partial under a name that cannot pass for a video", async () => {
    const { proc, jobId } = await agentExport();
    const args = proc.seen[0].args;
    const partial = args[args.length - 1];
    const name = partial.split("/").pop()!;
    expect(name.startsWith(".")).toBe(true); // hidden on macOS and Linux
    expect(name).not.toMatch(/\.(mp4|mov|m4v|mkv|webm|avi)$/i);
    expect(args.slice(-3, -1)).toEqual(["-f", "mp4"]); // the container no longer rides the name
    cancelExport(jobId);
    await whenExportEnds(jobId);
  });

  // Live QA, 2026-10-05: the export survived the next message and was delivered, but never reached
  // the library: the catalog commit still carried the retired turn's origin, which the gate refuses.
  it("is catalogued in the library when it finishes after the turn that asked for it was retired", async () => {
    let current = 7;
    const { proc, turn, jobId } = await agentExport({
      origin: { chatSessionId: "chat", branchId: 0, executionId: 7 },
      isOriginCurrent: (o) => o.executionId === current,
    });
    current = 8; // the user's next message retires the turn...
    turn.abort(); // ...and aborts it
    proc.release();
    expect((await whenExportEnds(jobId))?.state).toBe("done");
    await whenExportsSettle();
    const rec = listExportRecords().find((r) => r.job_id === jobId);
    expect(rec?.mediaRef).toMatch(/^media_/);
  });
});
