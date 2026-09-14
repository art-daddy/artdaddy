// Does async generation actually PRODUCE anything?
//
// Every other test for this feature runs on an in-memory fs with a mocked submit, so all of them
// would still pass if a placeholder never became a file. This one runs the REAL generate_image
// tool, against a REAL project directory on disk, through the REAL job ledger and library, and
// reads the artifacts: the catalog rows, the bytes, jobs.json.
//
// Only the network is stubbed -- the paid call is the one thing that must not happen in a test.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../api/ai", async () => {
  const actual = await vi.importActual<typeof import("../api/ai")>("../api/ai");
  return { ...actual, callAiProxy: vi.fn() };
});

import { callAiProxy } from "../api/ai";
import { ClientToolRegistry } from "./registry";
import { registerGenerationTools } from "./generation";
import { __resetProjectJobs, whenGenerationsSettle } from "./genJobs";
import { __resetJobNotes, pendingJobNotes } from "../store/jobNotes";
import { installE2EDocuments, mkCtx, openE2EDoc, resetE2EDocuments } from "./__e2e";

/** A chat execution identity: these runs stand in for the AGENT calling the tool, which is what
 *  entitles the completion to resume the conversation. */
const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };
import { joinPath } from "./store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// A real, decodable 1x1 PNG — the renderability guard at the library door must accept it.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let dir = "";

async function readJson(rel: string): Promise<Any> {
  return JSON.parse(await fs.readFile(path.join(dir, rel), "utf8"));
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "artdaddy-genjob-"));
  await fs.mkdir(path.join(dir, "internals"), { recursive: true });
  await fs.mkdir(path.join(dir, "library"), { recursive: true });
  installE2EDocuments();
  await openE2EDoc(dir);
});

afterAll(async () => {
  await resetE2EDocuments();
  __resetProjectJobs();
  __resetJobNotes();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("async generation produces real media", () => {
  it("turns a placeholder into bytes on disk, and records the job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(callAiProxy).mockImplementation(async () => {
      await gate;
      return { result: { ok: true }, media: [{ b64: PNG_B64, ext: ".png" }] } as Any;
    });

    const reg = new ClientToolRegistry();
    const ctx = { ...mkCtx(dir), origin: AGENT };
    registerGenerationTools(reg, () => ctx);

    const out = (await reg.run("generate_image", {
      prompt: "a hero still",
      model: "nano-banana",
    })) as Any;

    // 1. The tool came back BEFORE the paid call resolved, with a usable id.
    expect(out.ok).toBe(true);
    expect(out.status).toBe("generating");
    const ref = out.assets[0].media_ref as string;
    expect(ref).toMatch(/^media_gen_/);

    // 2. The library says so, on disk.
    const pending = (await readJson("internals/library.json")).clips.find((c: Any) => c.id === ref);
    expect(pending).toMatchObject({ status: "generating", path: `library/${ref}.png` });

    // 3. The job was recorded BEFORE the call, so a crash here would leave a trace.
    const running = (await readJson("internals/jobs.json")).jobs;
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ status: "running", tool: "generate_image" });

    // 4. Nothing exists yet — this is what makes the export refusal necessary.
    await expect(fs.access(path.join(dir, "library", `${ref}.png`))).rejects.toThrow();

    release();
    await whenGenerationsSettle();

    // 5. The bytes are REAL and on disk, under the id handed out in step 1.
    const bytes = await fs.readFile(path.join(dir, "library", `${ref}.png`));
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(bytes.length).toBe(Buffer.from(PNG_B64, "base64").length);

    // 6. The catalog row is ready, same id, and resolves to that file.
    const done = (await readJson("internals/library.json")).clips.find((c: Any) => c.id === ref);
    expect(done.status).toBeUndefined();
    expect(done.size_bytes).toBe(bytes.length);
    expect(await ctx.store.resolveRef(ref)).toBe(joinPath(dir, `library/${ref}.png`));

    // 7. The ledger settled, and the chat has something to wake for.
    expect((await readJson("internals/jobs.json")).jobs[0]).toMatchObject({ status: "done" });
    expect(pendingJobNotes(dir).map((n) => n.status)).toEqual(["done"]);
  });

  it("leaves a failed generation visible instead of silently dropping it", async () => {
    __resetJobNotes();
    vi.mocked(callAiProxy).mockRejectedValue(new Error("content filter"));

    const reg = new ClientToolRegistry();
    const ctx = { ...mkCtx(dir), origin: AGENT };
    registerGenerationTools(reg, () => ctx);

    const out = (await reg.run("generate_image", { prompt: "x", model: "nano-banana" })) as Any;
    const ref = out.assets[0].media_ref as string;
    await whenGenerationsSettle();

    // The row SURVIVES: a clip the agent already placed must not vanish from the timeline.
    const row = (await readJson("internals/library.json")).clips.find((c: Any) => c.id === ref);
    expect(row).toMatchObject({ status: "failed", error: "content filter" });
    await expect(fs.access(path.join(dir, "library", `${ref}.png`))).rejects.toThrow();
    expect(pendingJobNotes(dir).map((n) => n.status)).toContain("failed");
  });
});
