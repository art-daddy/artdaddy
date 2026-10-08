// `project_id` on every row the app sends is the project's id, wherever the project's folder is.
// Seen live (2026-10-09): an import reported the project's whole folder path, the Windows user's
// name inside it, while every other event sent the id; and an export reported the name the user
// gave a folder Save As made. These drive the real import and the real export all the way to the
// request the app sends, for the three places a project can be.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readTextFile = vi.fn<(p: string) => Promise<string>>();
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: (p: string) => readTextFile(p) }));
vi.mock("@tauri-apps/api/path", () => ({
  dataDir: async () => "C:/Users/someone/AppData/Roaming",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("./config", () => ({ apiBase: () => "https://example.invalid" }));
vi.mock("./auth", () => ({
  hasSession: async () => true,
  authedFetch: (url: string, init: RequestInit = {}) => fetch(url, init),
}));
vi.mock("../platform/host", () => ({
  hostInfo: () => ({ os: "windows", arch: "x86_64" }),
  resolveHostInfo: async () => undefined,
}));

import { IDENTITY } from "../brand";
import { FakeJobs } from "../test/fakeJobs";
import { MemFs, registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { ensureTimeline } from "../timeline/engine";
import {
  __resetExportQueue,
  whenExportEnds,
  whenExportsSettle,
  whenExportTelemetrySettles,
} from "../timeline/exportQueue";
import { addClipsTool } from "../timeline/placement";
import { exportTimelineTool } from "../timeline/render";
import { agentToolContext } from "../tools/agentStore";
import type { CommandResult, CommandRunner } from "../tools/command";
import { projectDirFor } from "../tools/dataRoot";
import { __resetProjectJobs } from "../tools/genJobs";
import { registerLibraryClip } from "../tools/import";
import { __resetJobSupervisor, __setJobSupervisor } from "../tools/jobSupervisor";
import { joinPath, ProjectStoreAccess } from "../tools/store";
import { __resetAppEvents } from "./appEvents";

const ID = "hero_a1b2c3";
/** Where a new project goes: the app folder, under its id. */
const DEFAULT = `C:/Users/someone/AppData/Roaming/${IDENTITY.dataFolder}/projects/${ID}`;
/** Where Save As put the same project, under a name the user chose. */
const SAVED = "D:/Client Work/Hero Cut";
/** A folder no project was ever resolved to in this page. */
const UNBOUND = "E:/Someone Edits/Wedding Final";
/** Nothing of any of those folders may reach the server, in any field. */
const LEAK = /someone|client work|hero cut|edits|wedding/i;

/** {@link MemFs} that also keeps bytes (an import writes the file into the library) and moves files
 *  (an export lands by rename). */
class Fs extends MemFs {
  bytes = new Map<string, Uint8Array>();
  override async exists(p: string): Promise<boolean> {
    return this.bytes.has(joinPath(p)) || super.exists(p);
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const b = this.bytes.get(joinPath(p));
    if (b) return b;
    return new TextEncoder().encode(await this.readTextFile(p));
  }
  async rename(from: string, to: string): Promise<void> {
    const [f, t] = [joinPath(from), joinPath(to)];
    const b = this.bytes.get(f);
    if (b) {
      this.bytes.delete(f);
      this.bytes.set(t, b);
      return;
    }
    const v = this.files.get(f);
    if (v === undefined) throw new Error(`ENOENT ${from}`);
    this.files.delete(f);
    this.files.set(t, v);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(joinPath(p));
    this.bytes.delete(joinPath(p));
  }
}

const runner: CommandRunner = {
  run: async (): Promise<CommandResult> => ({ code: 0, stdout: "", stderr: "" }),
};

const posted: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  __resetAppEvents();
  posted.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      posted.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
      return { ok: true } as Response;
    }),
  );
});

afterEach(async () => {
  await whenExportsSettle();
  __resetExportQueue();
  __resetProjectJobs();
  __resetJobSupervisor();
  await resetTestDocuments();
  vi.unstubAllGlobals();
});

const sent = (path: string, event?: string) =>
  posted.find((p) => p.path === path && (!event || p.body.event === event))?.body;

/** Import a file into the project at `dir`: what the app told the server. */
async function importInto(dir: string) {
  await registerLibraryClip(
    new ProjectStoreAccess(dir, new Fs()),
    new Uint8Array([1, 2, 3]),
    "take.mp4",
    "video",
  );
  await vi.waitFor(() => expect(sent("/telemetry/app", "media_import")).toBeDefined());
  return sent("/telemetry/app", "media_import")!;
}

/** Export the project at `dir`, open as the document of project `id` (an edit needs one): what
 *  the app told the server. */
async function exportFrom(dir: string, id: string) {
  const fs = new Fs();
  const store = new ProjectStoreAccess(dir, fs);
  registerTestDocument(dir, id);
  await ensureTimeline(store);
  const added = await addClipsTool(
    { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
    { store, runner },
  );
  expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
  const jobs = new FakeJobs();
  jobs.onStart = (spec) => fs.writeTextFile(spec.args[spec.args.length - 1], "a whole video");
  __setJobSupervisor(jobs);
  const out = (await exportTimelineTool(
    {},
    agentToolContext({ store, runner }, new AbortController().signal),
  )) as { job_id: string };
  expect(out, JSON.stringify(out)).toHaveProperty("job_id");
  await vi.waitFor(() => expect(jobs.view(out.job_id)?.state).toBe("running"));
  jobs.exit(out.job_id, 0);
  expect((await whenExportEnds(out.job_id))?.state).toBe("done");
  await whenExportsSettle();
  await whenExportTelemetrySettles();
  return sent("/telemetry/export")!;
}

describe("the project_id the app sends", () => {
  it("is the id for a project in the app folder, never its folder's path", async () => {
    const imported = await importInto(DEFAULT);
    const exported = await exportFrom(DEFAULT, ID);
    expect(imported).toMatchObject({ event: "media_import", ok: true, project_id: ID });
    expect(exported).toMatchObject({ status: "done", project_id: ID });
    expect(JSON.stringify([imported, exported])).not.toMatch(LEAK);
  });

  it("is the id for a project Save As moved, never the name the user gave its folder", async () => {
    readTextFile.mockResolvedValue(
      JSON.stringify({ version: 1, projects: [{ id: ID, path: SAVED }] }),
    );
    expect(await projectDirFor(ID)).toBe(SAVED); // what opening it does first
    const imported = await importInto(SAVED);
    const exported = await exportFrom(SAVED, ID);
    expect(imported.project_id).toBe(ID);
    expect(exported.project_id).toBe(ID);
    expect(JSON.stringify([imported, exported])).not.toMatch(LEAK);
  });

  it("is nothing for a folder it cannot name, rather than the folder", async () => {
    // Only an import: no document can be found for a folder with no id, so nothing edits it.
    const imported = await importInto(UNBOUND);
    expect(imported.project_id).toBe("");
    expect(JSON.stringify(imported)).not.toMatch(LEAK);
  });

  it("is the id when an import is refused too", async () => {
    // A PNG header the dimension guard refuses (6864x41754, the screenshot that hung a render).
    const huge = new Uint8Array(33);
    huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    huge.set([0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
    new DataView(huge.buffer).setUint32(16, 6864);
    new DataView(huge.buffer).setUint32(20, 41754);
    const store = new ProjectStoreAccess(DEFAULT, new Fs());
    await expect(registerLibraryClip(store, huge, "shot.png", "image")).rejects.toThrow();
    await vi.waitFor(() => expect(sent("/telemetry/app", "media_import")).toBeDefined());
    expect(sent("/telemetry/app", "media_import")).toMatchObject({ ok: false, project_id: ID });
  });
});
