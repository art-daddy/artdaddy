// 3j (UJ-023): `export` delivers separate files into a folder: library files copied as they are
// (`media_refs`), timeline clips rendered over their own spans (`clip_ids`), into `output_dir`.
// A user asked for "the 19 separate clips in a dedicated folder" and the agent could only offer a
// zip of the project. These drive the real tool door (the registry's `export`) on an in-memory
// disk and judge what lands there, what the queue reports and what wakes the agent.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("@tauri-apps/api/path", () => ({ resolveResource: async (r: string) => `C:/res/${r}` }));
const exportBeacon = vi.hoisted(() => vi.fn(async (_event: Record<string, unknown>) => undefined));
vi.mock("../api/exportEvents", () => ({ reportExport: exportBeacon }));

import { MemFs, registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { ensureTimeline } from "./engine";
import {
  cancelExport,
  listExportOutcomes,
  __resetExportQueue,
  whenExportsSettle,
  whenExportTelemetrySettles,
  localDeliveryPort,
} from "./exportQueue";
import { exportTool } from "./exportItems";
import { addClipsTool, addTextClipsTool } from "./placement";
import { ProjectStoreAccess, joinPath } from "../tools/store";
import { __resetJobNotes, pendingJobNotes } from "../store/jobNotes";
import { setClerkTokenProvider } from "../api/auth";
import { useAuth } from "../store/auth";
import { __setExportConfirmationForTests } from "../lib/confirm";
import { ClientToolRegistry } from "../tools/registry";
import { FakeJobs } from "../test/fakeJobs";
import { __resetJobSupervisor, __setJobSupervisor } from "../tools/jobSupervisor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const DIR = "C:/proj";
const DL = "C:/Users/test/Downloads";
const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };

function requestedExport(args: Record<string, unknown>, ctx: Parameters<typeof exportTool>[1]) {
  const registry = new ClientToolRegistry();
  registry.register("export", (input) => exportTool(input, ctx));
  return registry.run("export", args);
}

afterEach(async () => {
  await whenExportsSettle();
  await whenExportTelemetrySettles();
  exportBeacon.mockClear();
  __resetExportQueue();
  __resetJobNotes();
  await resetTestDocuments();
  setClerkTokenProvider(null);
  useAuth.setState({ status: "checking", profile: null });
  vi.unstubAllGlobals();
});

/** An in-memory disk with the operations an export uses, and a gate to hold a copy mid-way. */
class Disk extends MemFs {
  dirs = new Set<string>();
  gates = new Map<string, Promise<void>>();
  failCopy = new Set<string>();
  async readBytes(p: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readTextFile(p));
  }
  async probeMedia(p: string, headBytes: number) {
    const bytes = await this.readBytes(p);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      id12: sha256.slice(0, 12),
      sha256,
      size: bytes.length,
      head: bytes.slice(0, headBytes),
    };
  }
  async mkdir(p?: string): Promise<void> {
    if (p) this.dirs.add(joinPath(p));
  }
  async copyFile(src: string, dst: string): Promise<void> {
    const body = await this.readTextFile(src);
    await this.gates.get(joinPath(src));
    if (this.failCopy.has(joinPath(src))) {
      await this.writeTextFile(dst, body.slice(0, 1)); // a partial, as a full disk leaves
      throw new Error("No space left on device");
    }
    await this.writeTextFile(dst, body);
  }
  async rename(from: string, to: string): Promise<void> {
    const body = await this.readTextFile(from);
    this.files.delete(joinPath(from));
    this.files.set(joinPath(to), body);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(joinPath(p));
  }
  async stat(p: string): Promise<{ isDirectory: boolean; size: number }> {
    if (this.dirs.has(joinPath(p))) return { isDirectory: true, size: 0 };
    const f = this.files.get(joinPath(p));
    if (f === undefined) throw new Error(`ENOENT ${p}`);
    return { isDirectory: false, size: f.length };
  }
  /** Files under a folder, by name. */
  under(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.files)
      if (k.startsWith(joinPath(dir) + "/") && !k.slice(joinPath(dir).length + 1).includes("/"))
        out[k.slice(joinPath(dir).length + 1)] = v;
    return out;
  }
}

interface Setup {
  disk: Disk;
  store: ProjectStoreAccess;
  ctx: Any;
  ffmpeg: string[][];
  clips: Record<string, string>;
  /** Holds every ffmpeg run until it resolves. */
  hold: { gate: Promise<void> | null };
}

/** A project with library files, two timeline clips and (unless told) the brand assets. */
async function project(
  o: { origin?: boolean; brand?: boolean; place?: boolean; extra?: Any[] } = {},
): Promise<Setup> {
  const disk = new Disk();
  if (o.brand !== false)
    for (const r of ["16x9", "1x1", "9x16"])
      for (const f of [`watermark-${r}.png`, `endcard-${r}.mp4`])
        await disk.writeTextFile(`C:/res/resources/brand/${f}`, "asset");
  const library = [
    { id: "media_aaa", path: "library/media_aaa.mp4", filename: "Tape 14.mp4", kind: "video" },
    { id: "media_bbb", path: "library/media_bbb.mov", filename: "Tape 16.MOV", kind: "video" },
    { id: "media_ccc", path: "library/media_ccc.wav", filename: "narration.wav", kind: "audio" },
    {
      id: "media_gen",
      path: "library/media_gen.mp4",
      filename: "dragon.mp4",
      kind: "video",
      status: "generating",
    },
    {
      id: "media_bad",
      path: "library/media_bad.mp4",
      filename: "bad.mp4",
      kind: "video",
      status: "failed",
    },
    ...(o.extra ?? []),
  ];
  await disk.writeTextFile(`${DIR}/internals/library.json`, JSON.stringify({ clips: library }));
  for (const c of library.filter((c) => !c.status && !c.external))
    await disk.writeTextFile(`${DIR}/${c.path}`, `bytes of ${c.filename}`);
  const store = new ProjectStoreAccess(DIR, disk);
  registerTestDocument(DIR);
  await ensureTimeline(store);
  const ffmpeg: string[][] = [];
  const hold: Setup["hold"] = { gate: null };
  const runner = {
    run: async (program: string, args: string[]) => {
      if (program === "ffprobe" && args.includes("stream=codec_type,duration:format=duration")) {
        const command = ffmpeg.find((command) => command.at(-1) === args.at(-1));
        const graph = command?.[command.indexOf("-filter_complex") + 1] ?? "";
        const main = Number(
          /color=(?:c=)?[^:;]+:s=\d+x\d+:r=[\d.]+:d=([\d.]+)/.exec(graph)?.[1] ?? 8,
        );
        const duration = main + 2.033;
        return {
          code: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", duration: String(duration) },
              ...(command?.includes("-an")
                ? []
                : [{ codec_type: "audio", duration: String(duration) }]),
            ],
            format: { duration: String(duration) },
          }),
          stderr: "",
        };
      }
      if (program === "ffprobe" && args.includes("-count_frames")) {
        const command = ffmpeg.find((command) => command.at(-1) === args.at(-1));
        const graph = command?.[command.indexOf("-filter_complex") + 1] ?? "";
        const canvas = /color=(?:c=)?[^:;]+:s=(\d+)x(\d+):r=([\d.]+):d=([\d.]+)/.exec(graph);
        const fps = Number(command?.[command.indexOf("-r") + 1] ?? canvas?.[3] ?? 30);
        const duration = command?.includes("-shortest")
          ? Number(canvas?.[4] ?? 0) + 2.033
          : command?.includes("-t")
            ? Number(command[command.lastIndexOf("-t") + 1])
            : Number(canvas?.[4] ?? 0);
        const frames = Math.ceil(duration * fps - 1e-6);
        return {
          code: 0,
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: "video",
                width: Number(canvas?.[1] ?? 1920),
                height: Number(canvas?.[2] ?? 1080),
                avg_frame_rate: `${fps}/1`,
                nb_read_frames: String(frames),
                duration: String(frames / fps),
              },
            ],
          }),
          stderr: "",
        };
      }
      if (program === "ffprobe" && args.includes("format=duration"))
        // The brand end card measures 2.033 s; library media is long enough for the clips placed
        // on it (a clip is never placed longer than its media).
        return {
          code: 0,
          stdout: /endcard-/.test(args[args.length - 1]) ? "2.033\n" : "60\n",
          stderr: "",
        };
      if (program === "ffmpeg") {
        ffmpeg.push(args);
        await hold.gate;
        await disk.writeTextFile(args[args.length - 1], "rendered");
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const base = { store, runner };
  const ids: string[] = [];
  if (o.place !== false) {
    const placed = await addClipsTool(
      {
        entries: [
          { media_ref: "a.mp4", timeline_in: 0, timeline_out: 90 },
          { media_ref: "b.mp4", timeline_in: 90, timeline_out: 240 },
        ],
      },
      base,
    );
    ids.push(...(placed as Any).created.map((c: Any) => c.clip_id));
  }
  return {
    disk,
    store,
    ffmpeg,
    hold,
    clips: { a: ids[0], b: ids[1] },
    ctx: { ...base, ...(o.origin ? { origin: AGENT } : {}) },
  };
}

describe("export delivers separate files into a folder", () => {
  it.each([false, true])(
    "uses the account policy for timeline clips, including agent exports: %s",
    async (origin) => {
      setClerkTokenProvider(async () => "account-token");
      useAuth.setState({
        status: "unlocked",
        profile: {
          user_id: "user_exempt",
          email: "",
          display_name: "",
          image_url: "",
          metered: true,
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                user_id: "user_exempt",
                watermark: false,
                end_card: true,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
        ),
      );
      const setup = await project({ origin });
      const reply = (await exportTool(
        { clip_ids: [setup.clips.a, setup.clips.b], output_dir: "clean clips" },
        setup.ctx,
      )) as Any;
      expect(reply.ok).toBe(true);
      await whenExportsSettle();
      expect(Object.keys(setup.disk.under(`${DL}/clean clips`))).toHaveLength(2);
      expect(setup.ffmpeg).toHaveLength(2);
      for (const args of setup.ffmpeg)
        expect(args.some((arg) => /watermark-|endcard-/.test(arg))).toBe(false);
      expect(String(reply.note)).not.toMatch(/carries the ArtDaddy watermark/i);
    },
  );

  it("copies library files byte for byte into a folder made in Downloads, numbered as asked", async () => {
    const p = await project();
    const r = (await exportTool(
      { media_refs: ["media_bbb", "media_aaa"], output_dir: "VHS clips" },
      p.ctx,
    )) as Any;
    expect(r.ok, r.error).toBe(true);
    await whenExportsSettle();

    expect(p.disk.dirs.has(`${DL}/VHS clips`)).toBe(true);
    expect(p.disk.under(`${DL}/VHS clips`)).toEqual({
      "01 Tape 16.mov": "bytes of Tape 16.MOV",
      "02 Tape 14.mp4": "bytes of Tape 14.mp4",
    });
    expect(p.ffmpeg, "a copy is never re-encoded").toEqual([]);
    expect(r.exports.map((e: Any) => [e.media_ref, e.saved_to])).toEqual([
      ["media_bbb", "01 Tape 16.mov"],
      ["media_aaa", "02 Tape 14.mp4"],
    ]);
    expect(String(r.note)).toMatch(/VHS clips/);
    expect(String(r.note)).not.toMatch(/end card/i);
    expect(r.note).toBe(
      "Saving 2 files to 'VHS clips' in your Downloads folder. Library files are copied as they are.",
    );
    expect(r.status).toBe("exporting");
    // Each delivered file is listed done, with the library ref it came from.
    const rows = listExportOutcomes();
    expect(rows.map((x) => [x.filename, x.state, x.media_ref])).toEqual([
      ["01 Tape 16.mov", "done", "media_bbb"],
      ["02 Tape 14.mp4", "done", "media_aaa"],
    ]);
  });

  it("keeps a single file's own name", async () => {
    const p = await project();
    const r = (await exportTool({ media_refs: ["media_ccc"] }, p.ctx)) as Any;
    expect(r.ok, r.error).toBe(true);
    expect(r.note).toBe(
      "Saving 1 file to your Downloads folder. Library files are copied as they are.",
    );
    await whenExportsSettle();
    expect(p.disk.under(DL)).toEqual({ "narration.wav": "bytes of narration.wav" });
  });

  it("needs no renderable timeline to deliver library files", async () => {
    const p = await project({ place: false });
    const r = (await exportTool({ media_refs: ["media_aaa"] }, p.ctx)) as Any;
    expect(r.ok, r.error).toBe(true);
    await whenExportsSettle();
    expect(p.disk.under(DL)).toEqual({ "Tape 14.mp4": "bytes of Tape 14.mp4" });
  });

  it("names a caption by its words and a library clip by its library name", async () => {
    const p = await project();
    const lib = (await addClipsTool(
      { entries: [{ media_ref: "media_aaa", timeline_in: 240, timeline_out: 300 }] },
      p.ctx,
    )) as Any;
    const cap = (await addTextClipsTool(
      {
        entries: [
          { content: "Grandma at the lake in nineteen eighty", timeline_in: 0, timeline_out: 60 },
        ],
      },
      p.ctx,
    )) as Any;
    expect(lib.ok && cap.ok, JSON.stringify([lib.error, cap.error])).toBe(true);
    const r = (await exportTool(
      { clip_ids: [cap.created[0].clip_id, lib.created[0].clip_id] },
      p.ctx,
    )) as Any;
    expect(r.ok, r.error).toBe(true);
    expect(r.exports.map((e: Any) => e.saved_to)).toEqual([
      "01 Grandma at the lake in nineteen.mp4",
      "02 Tape 14.mp4",
    ]);
  });

  it("renders each clip at the frame rate asked for", async () => {
    const p = await project();
    const r = (await exportTool({ clip_ids: [p.clips.a, p.clips.b], fps: 24 }, p.ctx)) as Any;
    expect(r.ok, r.error).toBe(true);
    await whenExportsSettle();
    expect(p.ffmpeg.map((a) => a[a.indexOf("-r") + 1])).toEqual(["24", "24"]);
  });

  it("claims no watermark when the brand assets are missing, and warns once", async () => {
    const p = await project({ brand: false });
    const r = (await exportTool({ clip_ids: [p.clips.a, p.clips.b] }, p.ctx)) as Any;
    expect(r.ok, r.error).toBe(true);
    expect(String(r.note)).not.toMatch(/watermark/i);
    expect((r.warnings as string[]).filter((w) => /unbranded/.test(w))).toHaveLength(1);
    await whenExportsSettle();
    for (const args of p.ffmpeg) expect(args.some((a) => /watermark-/.test(a))).toBe(false);
  });

  it("says queued when an encode is already running", async () => {
    const p = await project();
    let release!: () => void;
    p.hold.gate = new Promise<void>((r) => (release = r));
    const first = (await exportTool({}, p.ctx)) as Any;
    expect(first.ok, first.error).toBe(true);
    const r = (await exportTool({ clip_ids: [p.clips.a] }, p.ctx)) as Any;
    expect(r.ok, r.error).toBe(true);
    expect(r.status).toBe("queued");
    expect(r.exports[0].queue_position).toBe(1);
    release();
  });

  it("refuses a second render of the same clip into the same folder while the first runs", async () => {
    const p = await project();
    let release!: () => void;
    p.hold.gate = new Promise<void>((r) => (release = r));
    const first = (await exportTool({ clip_ids: [p.clips.a], output_dir: "scenes" }, p.ctx)) as Any;
    expect(first.ok, first.error).toBe(true);
    const again = (await exportTool({ clip_ids: [p.clips.a], output_dir: "scenes" }, p.ctx)) as Any;
    expect(again.ok).toBe(false);
    expect(String(again.error)).toMatch(/a\.mp4 is already queued or running/);
    release();
  });

  it("allows 50 files in one call and no more", async () => {
    const extra = Array.from({ length: 50 }, (_, i) => ({
      id: `media_n${i}`,
      path: `library/media_n${i}.mp4`,
      filename: `n${i}.mp4`,
      kind: "video",
    }));
    const p = await project({ extra });
    const fifty = (await exportTool({ media_refs: extra.map((e) => e.id) }, p.ctx)) as Any;
    expect(fifty.ok, fifty.error).toBe(true);
    expect(fifty.exports).toHaveLength(50);
    await whenExportsSettle();
    const over = (await exportTool(
      { media_refs: extra.map((e) => e.id).slice(0, 49), clip_ids: [p.clips.a, p.clips.b] },
      p.ctx,
    )) as Any;
    expect(over.ok).toBe(false);
    expect(String(over.error)).toMatch(/at most 50 files \(asked for 51\)/);
  });

  it("refuses a folder it cannot make, and queues nothing", async () => {
    const p = await project();
    p.disk.mkdir = async () => {
      throw new Error("Access is denied");
    };
    const r = (await exportTool(
      { media_refs: ["media_aaa"], output_dir: "Z:/locked" },
      p.ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/could not make the folder Z:\/locked: .*Access is denied/);
    expect(listExportOutcomes()).toEqual([]);
  });

  it("refuses timeline clips while media on the timeline is offline or still generating", async () => {
    const p = await project({
      extra: [
        {
          id: "media_ext",
          path: "D:/footage/ext.mp4",
          filename: "ext.mp4",
          kind: "video",
          external: true,
        },
      ],
    });
    await p.disk.writeTextFile("D:/footage/ext.mp4", "linked footage");
    const placed = (await addClipsTool(
      { entries: [{ media_ref: "media_ext", timeline_in: 240, timeline_out: 270 }] },
      p.ctx,
    )) as Any;
    expect(placed.ok, placed.error).toBe(true);
    await p.disk.remove("D:/footage/ext.mp4"); // the user moved it
    const offline = (await exportTool({ clip_ids: [p.clips.a] }, p.ctx)) as Any;
    expect(offline.ok).toBe(false);
    expect(String(offline.error)).toMatch(/ext\.mp4.*offline|offline.*ext\.mp4/);

    const q = await project();
    const gen = (await addClipsTool(
      { entries: [{ media_ref: "media_gen", timeline_in: 240, timeline_out: 270 }] },
      q.ctx,
    )) as Any;
    expect(gen.ok, gen.error).toBe(true);
    const generating = (await exportTool({ clip_ids: [q.clips.a] }, q.ctx)) as Any;
    expect(generating.ok).toBe(false);
    expect(String(generating.error)).toMatch(/still generating/);
    expect(listExportOutcomes()).toEqual([]);
  });

  it("refuses with no tool runtime", async () => {
    const r = (await exportTool({ media_refs: ["media_aaa"] }, null)) as Any;
    expect(r.ok).toBe(false);
  });

  it("renders each timeline clip over its own span, with the watermark and no end card", async () => {
    const p = await project();
    const r = (await exportTool(
      { clip_ids: [p.clips.b, p.clips.a], output_dir: "scenes" },
      p.ctx,
    )) as Any;
    expect(r.ok, r.error).toBe(true);
    await whenExportsSettle();

    expect(Object.keys(p.disk.under(`${DL}/scenes`)).sort()).toEqual(["01 b.mp4", "02 a.mp4"]);
    expect(r.exports.map((e: Any) => [e.clip_id, e.saved_to, e.duration_s])).toEqual([
      [p.clips.b, "01 b.mp4", 5],
      [p.clips.a, "02 a.mp4", 3],
    ]);
    expect(p.ffmpeg).toHaveLength(2);
    // The end card is never an input of a clip's render; the watermark always is.
    for (const args of p.ffmpeg) {
      expect(args.some((a) => /endcard-/.test(a))).toBe(false);
      expect(args.some((a) => /watermark-/.test(a))).toBe(true);
    }
    expect(String(r.note)).toMatch(/watermark/i);
    expect(String(r.note)).toMatch(/no end card/i);
    expect(r.note).toBe(
      "Saving 2 files to 'scenes' in your Downloads folder. Each clip from the timeline carries the ArtDaddy watermark (no end card).",
    );
    expect(listExportOutcomes().every((x) => x.state === "done")).toBe(true);
  });

  it("never overwrites a file already in the folder", async () => {
    const p = await project();
    await p.disk.writeTextFile(`${DL}/VHS clips/01 Tape 16.mov`, "the user's own file");
    const r = (await exportTool(
      { media_refs: ["media_bbb", "media_aaa"], output_dir: "VHS clips" },
      p.ctx,
    )) as Any;
    expect(r.ok, r.error).toBe(true);
    await whenExportsSettle();
    expect(p.disk.under(`${DL}/VHS clips`)).toEqual({
      "01 Tape 16.mov": "the user's own file",
      "01 Tape 16 2.mov": "bytes of Tape 16.MOV",
      "02 Tape 14.mp4": "bytes of Tape 14.mp4",
    });
  });

  it("uses a full path as given, and makes it when missing", async () => {
    const p = await project();
    const r = (await exportTool(
      { media_refs: ["media_aaa"], output_dir: "D:/Deliveries/Client A" },
      p.ctx,
    )) as Any;
    expect(r.ok, r.error).toBe(true);
    await whenExportsSettle();
    expect(p.disk.dirs.has("D:/Deliveries/Client A")).toBe(true);
    expect(p.disk.under("D:/Deliveries/Client A")).toEqual({
      "Tape 14.mp4": "bytes of Tape 14.mp4",
    });
  });

  it("puts the whole timeline into a named folder too", async () => {
    const p = await project();
    const r = (await exportTool({ output_dir: "renders" }, p.ctx)) as Any;
    expect(r.ok, r.error).toBe(true);
    expect(r.saved_to).toBe("proj.mp4");
    await whenExportsSettle();
    const outcome = listExportOutcomes().find((outcome) => outcome.job_id === r.job_id);
    expect(outcome?.state, String(outcome?.error ?? "whole timeline delivery outcome")).toBe(
      "done",
    );
    expect(Object.keys(p.disk.under(`${DL}/renders`))).toEqual(["proj.mp4"]);
  });

  it.each(["whole", "clip", "copy"] as const)(
    "does not create a destination folder after Cancel for %s export",
    async (kind) => {
      const p = await project();
      __setExportConfirmationForTests(async () => "cancel");
      const args = {
        output_dir: "not-created-without-consent",
        ...(kind === "clip"
          ? { clip_ids: [p.clips.a] }
          : kind === "copy"
            ? { media_refs: ["media_aaa"] }
            : {}),
      };
      const result = (await requestedExport(args, p.ctx)) as Any;
      expect(result.ok).toBe(false);
      expect(result.error).toContain("cancelled before submission");
      expect(p.disk.dirs.has(`${DL}/not-created-without-consent`)).toBe(false);
      expect(p.disk.under(`${DL}/not-created-without-consent`)).toEqual({});
      expect(p.ffmpeg).toHaveLength(0);
      expect(listExportOutcomes()).toHaveLength(0);
      await whenExportTelemetrySettles();
      expect(exportBeacon).toHaveBeenCalledTimes(1);
      expect(exportBeacon.mock.calls[0][0]).toMatchObject({
        status: "declined",
        readiness: "unknown",
      });
    },
  );

  it.each(["whole", "clip", "copy", "no-context"] as const)(
    "counts an early %s refusal once without admitting a job",
    async (kind) => {
      const p = await project({
        extra: [
          {
            id: "media_ext",
            path: "D:/footage/ext.mp4",
            filename: "ext.mp4",
            kind: "video",
            external: true,
          },
        ],
      });
      let args: Record<string, unknown> = {};
      if (kind === "whole" || kind === "clip") {
        await p.disk.writeTextFile("D:/footage/ext.mp4", "linked footage");
        const placed = (await addClipsTool(
          { entries: [{ media_ref: "media_ext", timeline_in: 240, timeline_out: 270 }] },
          p.ctx,
        )) as Any;
        expect(placed.ok).toBe(true);
        const source = await p.store.resolveMediaRef("media_ext");
        expect(source).not.toBeNull();
        await p.disk.remove(source!);
        if (kind === "clip") args = { clip_ids: [p.clips.a] };
      } else if (kind === "copy") args = { media_refs: ["not-in-the-library"] };
      const result = (await requestedExport(args, kind === "no-context" ? null : p.ctx)) as Any;
      expect(result.ok).toBe(false);
      expect(listExportOutcomes()).toHaveLength(0);
      await whenExportTelemetrySettles();
      expect(exportBeacon).toHaveBeenCalledTimes(1);
      expect(exportBeacon.mock.calls[0][0]).toMatchObject({
        status: "blocked",
        readiness: "unknown",
      });
    },
  );

  it.each([null, { unexpected_export_param: true }])(
    "counts protocol-refused export arguments before any handler runs: %s",
    async (args) => {
      const p = await project();
      const handler = vi.fn((input: Record<string, unknown>) => exportTool(input, p.ctx));
      const registry = new ClientToolRegistry();
      registry.register("export", handler);
      const result = (await registry.run("export", args as Any)) as Any;
      expect(result.ok).toBe(false);
      expect(handler).not.toHaveBeenCalled();
      expect(exportBeacon).toHaveBeenCalledTimes(1);
      expect(exportBeacon.mock.calls[0][0]).toMatchObject({
        status: "blocked",
        readiness: "unknown",
      });
      expect(listExportOutcomes()).toHaveLength(0);
    },
  );

  it.each(["render", "copy"] as const)(
    "counts an accepted %s once through the real dispatch and file outcome",
    async (operation) => {
      const p = await project();
      const result = (await requestedExport(
        operation === "copy" ? { media_refs: ["media_aaa"] } : { clip_ids: [p.clips.a] },
        p.ctx,
      )) as Any;
      expect(result.ok, result.error).toBe(true);
      await whenExportsSettle();
      await whenExportTelemetrySettles();
      expect(Object.keys(p.disk.under(DL))).toHaveLength(1);
      expect(exportBeacon).toHaveBeenCalledTimes(1);
      expect(exportBeacon.mock.calls[0][0]).toMatchObject({ status: "done", operation });
    },
  );

  it.each([1, 2])(
    "counts every output once when native batch admission fails at position %s",
    async (failureAt) => {
      const p = await project();
      const jobs = new FakeJobs();
      jobs.delivery = localDeliveryPort(p.store);
      const prepare = jobs.delivery.prepare.bind(jobs.delivery);
      const copy = jobs.delivery.copy.bind(jobs.delivery);
      let calls = 0;
      jobs.delivery.prepare = async (...args) => {
        if (++calls === failureAt) throw new Error("native intent write failed");
        const delivery = await prepare(...args);
        jobs.queueCopy(delivery);
        return delivery;
      };
      jobs.delivery.copy = (id) => jobs.runCopy(id, () => copy(id));
      __setJobSupervisor(jobs);
      try {
        const result = (await requestedExport(
          { media_refs: ["media_aaa", "media_bbb"] },
          p.ctx,
        )) as Any;
        expect(result.ok).toBe(false);
        expect(result.exports?.length ?? 0).toBe(failureAt - 1);
        expect(JSON.stringify(result)).not.toContain("export_refusal");
        await whenExportsSettle();
        await whenExportTelemetrySettles();
        expect(exportBeacon).toHaveBeenCalledTimes(2);
        const events = exportBeacon.mock.calls.map(([event]) => event);
        expect(events.every((event) => event.operation === "copy")).toBe(true);
        expect(events.filter((event) => event.status === "done")).toHaveLength(failureAt - 1);
        expect(events.filter((event) => event.status === "blocked")).toHaveLength(3 - failureAt);
        expect(Object.values(p.disk.under(DL))).toEqual(
          failureAt === 2 ? ["bytes of Tape 14.mp4"] : [],
        );
      } finally {
        await whenExportsSettle();
        __resetJobSupervisor();
      }
    },
  );

  // The failure direction: one bad item must leave NOTHING behind, not a half-delivered folder.
  it.each([
    [{ media_refs: ["media_aaa", "media_zzz"] }, /media_zzz.*not in the library/],
    [{ media_refs: ["C:/Windows/win.ini"] }, /library/],
    [{ media_refs: ["../secret.mp4"] }, /library/],
    [{ media_refs: ["media_gen"] }, /still being generated/],
    [{ clip_ids: ["clip_nope"] }, /clip_nope/],
    [{ media_refs: [] }, /empty/],
    [
      { media_refs: Array.from({ length: 51 }, () => "media_aaa"), clip_ids: [] },
      /empty|at most 50/,
    ],
    [{ media_refs: ["media_aaa"], output_path: "D:/x.mp4" }, /output_dir/],
    [{ output_dir: "renders", output_path: "D:/x.mp4" }, /output_dir/],
    [{ media_refs: ["media_aaa"], output_dir: "Downloads/VHS" }, /folder name/],
    [{ media_refs: ["media_aaa"], output_dir: "C:/proj/library/media_aaa.mp4" }, /is a file/],
    [{ media_refs: "media_aaa" }, /list of ids/],
    [{ media_refs: ["media_aaa", 5] }, /list of ids/],
    [{ clip_ids: ["  "] }, /list of ids/],
    [{ media_refs: ["media_bad"] }, /failed to generate/],
  ])("refuses %j and queues nothing", async (args, why) => {
    const p = await project();
    const before = new Set(p.disk.files.keys());
    const r = (await exportTool(args as Any, p.ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(why);
    await whenExportsSettle();
    expect(listExportOutcomes()).toEqual([]);
    expect([...p.disk.files.keys()].filter((k) => !before.has(k))).toEqual([]);
    expect([...p.disk.dirs].filter((d) => d.startsWith(DL) || d.startsWith("D:"))).toEqual([]);
  });

  it("caps one call at 50 files", async () => {
    const p = await project();
    const refs = Array.from({ length: 51 }, (_, i) => `media_${i}`);
    const r = (await exportTool({ media_refs: refs }, p.ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/at most 50/);
  });

  it("delivers a repeated item once", async () => {
    const p = await project();
    const r = (await exportTool({ media_refs: ["media_aaa", " media_aaa "] }, p.ctx)) as Any;
    expect(r.ok, r.error).toBe(true);
    await whenExportsSettle();
    expect(p.disk.under(DL)).toEqual({ "Tape 14.mp4": "bytes of Tape 14.mp4" });
  });

  it("reads a blank output_path as no output_path", async () => {
    const p = await project();
    const r = (await exportTool({ media_refs: ["media_aaa"], output_path: "  " }, p.ctx)) as Any;
    expect(r.ok, r.error).toBe(true);
  });

  it("says a library file is offline rather than unknown when its file is gone", async () => {
    const p = await project();
    await p.disk.remove(`${DIR}/library/media_ccc.wav`);
    const r = (await exportTool({ media_refs: ["media_ccc"] }, p.ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/media_ccc is offline/);
  });

  it("delivers a project file the library never catalogued, under its own name", async () => {
    const p = await project();
    await p.disk.writeTextFile(`${DIR}/library/loose.mp4`, "loose bytes");
    const r = (await exportTool({ media_refs: ["library/loose.mp4"] }, p.ctx)) as Any;
    expect(r.ok, r.error).toBe(true);
    await whenExportsSettle();
    expect(p.disk.under(DL)).toEqual({ "loose.mp4": "loose bytes" });
  });

  it("refuses a second call writing the same files while the first is still going", async () => {
    const p = await project();
    let release!: () => void;
    p.disk.gates.set(`${DIR}/library/media_aaa.mp4`, new Promise<void>((r) => (release = r)));
    const first = (await exportTool(
      { media_refs: ["media_aaa"], output_dir: "VHS clips" },
      p.ctx,
    )) as Any;
    expect(first.ok).toBe(true);
    const again = (await exportTool(
      { media_refs: ["media_aaa"], output_dir: "VHS clips" },
      p.ctx,
    )) as Any;
    expect(again.ok).toBe(false);
    expect(String(again.error)).toMatch(/already queued or running/);
    release();
    await whenExportsSettle();
    expect(p.disk.under(`${DL}/VHS clips`)).toEqual({ "Tape 14.mp4": "bytes of Tape 14.mp4" });
  });
});

describe("one export call wakes the agent once", () => {
  it("after its LAST file lands, even when that is the first one asked for", async () => {
    const p = await project({ origin: true });
    let release!: () => void;
    p.disk.gates.set(`${DIR}/library/media_bbb.mov`, new Promise<void>((r) => (release = r)));
    const r = (await exportTool(
      { media_refs: ["media_bbb"], clip_ids: [p.clips.a] },
      p.ctx,
    )) as Any;
    expect(r.ok, r.error).toBe(true);
    // A copy never waits behind a render: the clip renders while the first file is still copying.
    await vi.waitFor(() =>
      expect(listExportOutcomes().filter((x) => x.state === "done")).toHaveLength(1),
    );
    expect(pendingJobNotes(DIR), "no wake while a file is still on its way").toEqual([]);
    release();
    await whenExportsSettle();
    expect(pendingJobNotes(DIR).map((n) => [n.label, n.status])).toEqual([
      ["the export 02 a.mp4", "done"],
      ["the export 01 Tape 16.mov", "done"],
    ]);
  });

  it("reports a failed copy in that one wake and leaves no partial file", async () => {
    const p = await project({ origin: true });
    p.disk.failCopy.add(`${DIR}/library/media_aaa.mp4`);
    const r = (await exportTool(
      { media_refs: ["media_bbb", "media_aaa"], output_dir: "out" },
      p.ctx,
    )) as Any;
    expect(r.ok, r.error).toBe(true);
    await whenExportsSettle();
    expect(p.disk.under(`${DL}/out`)).toEqual({ "01 Tape 16.mov": "bytes of Tape 16.MOV" });
    const notes = pendingJobNotes(DIR);
    expect(notes.map((n) => n.status).sort()).toEqual(["done", "failed"]);
    expect(String(notes.find((n) => n.status === "failed")?.error)).toMatch(/No space left/);
  });

  it("a cancelled file neither holds the others' wake nor appears in it", async () => {
    const p = await project({ origin: true });
    let release!: () => void;
    p.disk.gates.set(`${DIR}/library/media_aaa.mp4`, new Promise<void>((r) => (release = r)));
    const r = (await exportTool(
      { media_refs: ["media_bbb", "media_aaa", "media_ccc"], output_dir: "out" },
      p.ctx,
    )) as Any;
    expect(r.ok, r.error).toBe(true);
    expect(cancelExport(r.exports[1].job_id)).toBe(true);
    release();
    await whenExportsSettle();
    expect(Object.keys(p.disk.under(`${DL}/out`)).sort()).toEqual([
      "01 Tape 16.mov",
      "03 narration.wav",
    ]);
    expect(pendingJobNotes(DIR).map((n) => n.status)).toEqual(["done", "done"]);
  });
});
