// Every contract parameter that can name something on disk or on the network, walked against the
// real tools, the way the agent reaches them: through agentToolContext (the context ToolHost builds
// for the in-app agent AND for MCP). A local path the project does not know, or a non-web URL, must
// never be read, probed, fetched or passed to a sidecar.
//
// The list of parameters is DERIVED from the served contract: a new parameter that can name a file
// or URL fails "classifies every..." until it is put in a class here. Each attack is paired with a
// control that must reach the same code with a library ref, so a template that fails validation
// early cannot pass by never getting to the resolver.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { allTools, paramSchema, type ParamSchema } from "../contract";
import { registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { createToolRegistry } from ".";
import { agentToolContext } from "./agentStore";
import type { CommandRunner } from "./command";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "./store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

vi.mock("../api/ai", () => ({
  callAiProxy: vi.fn(async () => ({ result: {}, media: [] })),
  toB64: () => "",
  fromB64: () => new Uint8Array(),
  RateLimitError: class extends Error {},
}));

const DIR = "C:/Users/u/projects/p1";
const SENT = "sentinel-7f3a";
const CTRL = "control-91c2";
const ATTACK = `C:/Users/u/Documents/${SENT}.mp4`;
const DOTDOT = `library/../../../../Documents/${SENT}.mp4`;
const FILE_URL = `file:///C:/Users/u/Documents/${SENT}.txt`;
const WEB_URL = `https://example.com/${CTRL}`;
/** A HEIF-family library still: every read of its pixels must go through media/stillPicture.ts. */
const HEIC_NAME = "IMG_0001.HEIC";
const HEIC = `D:/Footage/${HEIC_NAME}`;

class RecFs implements FsLike {
  files = new Map<string, string>();
  touched: string[] = [];
  private k(p: string): string {
    return joinPath(p).toLowerCase();
  }
  put(p: string, c = ""): void {
    this.files.set(this.k(p), c);
  }
  private see(p: string): void {
    this.touched.push(String(p));
  }
  async exists(p: string): Promise<boolean> {
    this.see(p);
    return this.files.has(this.k(p));
  }
  async readTextFile(p: string): Promise<string> {
    this.see(p);
    const v = this.files.get(this.k(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(this.k(p), c);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    this.see(p);
    if (!this.files.has(this.k(p))) throw new Error(`ENOENT ${p}`);
    return new Uint8Array([1, 2, 3]);
  }
  async writeBytes(p: string): Promise<void> {
    this.files.set(this.k(p), "");
  }
  async stat(p: string): Promise<{ isDirectory: boolean; size: number }> {
    this.see(p);
    if (!this.files.has(this.k(p))) throw new Error(`ENOENT ${p}`);
    return { isDirectory: false, size: 3 };
  }
  async readDir(): Promise<DirEntry[]> {
    return [];
  }
  async mkdir(): Promise<void> {}
}

let fs: RecFs;
let calls: string[][];
let fetched: string[];

function seed(): ProjectStoreAccess {
  fs = new RecFs();
  for (const p of [
    ATTACK,
    `D:/Footage/${CTRL}.mp4`,
    `D:/Footage/${CTRL}.png`,
    joinPath(DIR, "library/media_a.mp4"),
    joinPath(DIR, `notes-${CTRL}.md`),
    HEIC,
  ])
    fs.put(p);
  fs.put(`D:/Footage/${CTRL}.srt`, "1\n00:00:00,000 --> 00:00:01,000\nhello\n");
  fs.put(
    joinPath(DIR, "internals/library.json"),
    JSON.stringify({
      version: 1,
      folders: [],
      clips: [
        { id: "media_a", path: "library/media_a.mp4", filename: "a.mp4", kind: "video" },
        { id: "media_ctl", path: `D:/Footage/${CTRL}.mp4`, external: true, kind: "video" },
        { id: "media_img", path: `D:/Footage/${CTRL}.png`, external: true, kind: "image" },
        { id: "media_srt", path: `D:/Footage/${CTRL}.srt`, external: true, kind: "subtitle" },
        { id: "media_heic", path: HEIC, external: true, kind: "image" },
      ].map((c) => ({ filename: c.path.split("/").pop(), ...c })),
    }),
  );
  fs.put(
    joinPath(DIR, "internals/timeline.json"),
    JSON.stringify({
      version: 1,
      canvas: { width: 1920, height: 1080, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 0,
          clips: [
            {
              id: "c0",
              kind: "video",
              media_ref: "media_a",
              timeline_in: 0,
              timeline_out: 30,
              source_in: 0,
              source_out: 30,
            },
          ],
        },
      ],
    }),
  );
  return new ProjectStoreAccess(DIR, fs);
}

/** Enough of a probe for a tool to get past "is this media?" and reach its next read. */
const PROBE_JSON = JSON.stringify({
  format: { duration: "2" },
  streams: [{ codec_type: "video", width: 1, height: 1, codec_name: "h264" }],
});

const runner: CommandRunner = {
  run: async (program, args) => {
    calls.push([program, ...args]);
    if (program === "ffprobe" && args.includes("-print_format"))
      return { code: 0, stdout: PROBE_JSON, stderr: "" };
    // The still-picture owner's inventory: one primary item, as a plain HEIC has.
    if (program === "ffprobe" && args.some((a) => a.includes("stream_disposition")))
      return {
        code: 0,
        stdout: JSON.stringify({ streams: [{ index: 0, id: "0x1", disposition: { default: 1 } }] }),
        stderr: "",
      };
    // ffmpeg "writes" its output, so a tool that checks for it goes on to read it.
    if (program === "ffmpeg" && args.length) fs.put(String(args[args.length - 1]));
    return { code: 0, stdout: "", stderr: "" };
  },
};

async function run(name: string, args: Record<string, unknown>): Promise<Any> {
  const store = seed();
  registerTestDocument(DIR);
  const registry = createToolRegistry(() => agentToolContext({ store, runner }));
  try {
    return await registry.run(name, args);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Every place a run left a mark: paths the fs was asked about, sidecar argv, fetched URLs. */
function marks(): string {
  return [...fs.touched, ...calls.flat(), ...fetched].join("\n").toLowerCase();
}

type Kind =
  | "library-ref" // must name media the project knows
  | "web-url" // http(s) only
  | "import-door" // the ONE sanctioned way to bring a local path in (it catalogues it)
  | "destination" // where a deliverable is written; never read
  | "project-file" // contained inside the project folder
  | "library-folder" // a folder in the library panel's own tree, not on disk
  | "output-name"; // a bare filename the tool writes under its own cache dir

/** How to call a tool with `x` in the parameter under test. */
type Call = (x: string) => [string, Record<string, unknown>];

const PARAMS: Record<string, { kind: Kind; call?: Call; control?: string }> = {
  "add_captions subtitle_media_ref": {
    kind: "library-ref",
    call: (x) => ["add_captions", { subtitle_media_ref: x }],
    control: "media_srt",
  },
  "add_clips entries[].media_ref": {
    kind: "library-ref",
    call: (x) => [
      "add_clips",
      { entries: [{ media_ref: x, track_id: "v1", timeline_in: 60, timeline_out: 90 }] },
    ],
    control: "media_ctl",
  },
  "insert_clips entries[].media_ref": {
    kind: "library-ref",
    call: (x) => ["insert_clips", { at: 0, track_id: "v1", entries: [{ media_ref: x }] }],
    control: "media_ctl",
  },
  "clip_video media_ref": {
    kind: "library-ref",
    call: (x) => ["clip_video", { media_ref: x, start_s: 0, end_s: 1, output_name: "out.mp4" }],
    control: "media_ctl",
  },
  "crop_image media_ref": {
    kind: "library-ref",
    call: (x) => ["crop_image", { media_ref: x, bbox: { x: 0, y: 0, w: 10, h: 10 } }],
    control: "media_img",
  },
  "export media_refs[]": {
    kind: "library-ref",
    call: (x) => ["export", { media_refs: [x] }],
    control: "media_ctl",
  },
  "generate_image reference_images[]": {
    kind: "library-ref",
    call: (x) => ["generate_image", { prompt: "p", reference_images: [x] }],
    control: "media_img",
  },
  "generate_video start_frame": {
    kind: "library-ref",
    call: (x) => ["generate_video", { prompt: "p", start_frame: x }],
    control: "media_img",
  },
  "generate_video end_frame": {
    kind: "library-ref",
    call: (x) => ["generate_video", { prompt: "p", start_frame: "media_a", end_frame: x }],
    control: "media_img",
  },
  "generate_video reference_images[]": {
    kind: "library-ref",
    call: (x) => ["generate_video", { prompt: "p", reference_images: [x] }],
    control: "media_img",
  },
  "inspect_color media_ref": {
    kind: "library-ref",
    call: (x) => ["inspect_color", { media_ref: x }],
    control: "media_ctl",
  },
  "inspect_color reference": {
    kind: "library-ref",
    call: (x) => ["inspect_color", { media_ref: "media_a", reference: x }],
    control: "media_ctl",
  },
  "inspect_media media_ref": {
    kind: "library-ref",
    call: (x) => ["inspect_media", { media_ref: x }],
    control: "media_ctl",
  },
  "library_op id_or_path": {
    kind: "library-ref",
    call: (x) => ["library_op", { action: "resolve", id_or_path: x }],
    control: `${CTRL}.mp4`,
  },
  "run_ffmpeg inputs[]": {
    kind: "library-ref",
    call: (x) => [
      "run_ffmpeg",
      { inputs: [x], args: ["-i", "{in0}", "{out}"], output_name: "o.mp4" },
    ],
    control: "media_ctl",
  },
  "set_clip_properties media_ref": {
    kind: "library-ref",
    call: (x) => ["set_clip_properties", { clip_ids: ["c0"], media_ref: x }],
    control: "media_ctl",
  },
  "video_ask media_ref": {
    kind: "library-ref",
    call: (x) => ["video_ask", { media_ref: x, prompt: "what is this?" }],
    control: "media_ctl",
  },
  "video_find_moment media_ref": {
    kind: "library-ref",
    call: (x) => ["video_find_moment", { media_ref: x, query: "a dog" }],
    control: "media_ctl",
  },
  "read_file path_or_key": {
    kind: "project-file",
    call: (x) => ["read_file", { path_or_key: x }],
    control: `notes-${CTRL}.md`,
  },
  "download_video url": {
    kind: "web-url",
    call: (x) => ["download_video", { url: x, output_name: "d.mp4" }],
  },
  "get_page_image url": { kind: "web-url", call: (x) => ["get_page_image", { url: x }] },
  "video_get_metadata url": { kind: "web-url", call: (x) => ["video_get_metadata", { url: x }] },
  "import_media source.url": {
    kind: "web-url",
    call: (x) => ["import_media", { source: { url: x } }],
  },
  "import_media source.path": { kind: "import-door" },
  "export output_path": { kind: "destination" },
  "export output_dir": { kind: "destination" },
  "clip_video output_name": { kind: "output-name" },
  "download_video output_name": { kind: "output-name" },
  "run_ffmpeg output_name": { kind: "output-name" },
  "generate_image folder": { kind: "library-folder" },
  "generate_video folder": { kind: "library-folder" },
  "import_media folder": { kind: "library-folder" },
  "library_op folder": { kind: "library-folder" },
};

/** Every string parameter of every contract tool, as "tool path" (arrays as `[]`). */
function stringParams(): string[] {
  const out: string[] = [];
  const walk = (tool: string, s: ParamSchema | undefined, path: string): void => {
    if (!s) return;
    const t = s.type;
    if (t === "string" || (Array.isArray(t) && t.includes("string"))) out.push(`${tool} ${path}`);
    for (const [k, v] of Object.entries(s.properties ?? {}))
      walk(tool, v, path ? `${path}.${k}` : k);
    if (s.items) walk(tool, s.items, `${path}[]`);
  };
  for (const t of allTools()) walk(t.name, paramSchema(t.name), "");
  return out.sort();
}

/** A leaf name that could name a file, folder or URL. */
const RESOURCE_LEAF =
  /(^|_)(ref|refs|reference|references|path|paths|url|urls|uri|frame|image|images|input|inputs|file|files|dir|folder|source|output)(_|$)/i;

beforeEach(() => {
  calls = [];
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown) => {
      fetched.push(String(u));
      return new Response("", { status: 404 });
    }),
  );
});
afterEach(async () => {
  await resetTestDocuments();
});

describe("agent-typed paths and URLs reach only what the project knows", () => {
  it("classifies every contract parameter that can name a file or URL", () => {
    const resourceParams = stringParams().filter((p) => {
      const leaf = p.split(" ")[1].split(".").pop()!.replace(/\[\]$/, "");
      return RESOURCE_LEAF.test(leaf);
    });
    const unclassified = resourceParams.filter((p) => !PARAMS[p]);
    expect(unclassified, "classify these in PARAMS").toEqual([]);
    // A class with no tool behind it is a stale entry.
    const all = new Set(stringParams());
    expect(Object.keys(PARAMS).filter((p) => !all.has(p))).toEqual([]);
  });

  it("has exactly one door for a local path: import_media source.path", () => {
    expect(Object.keys(PARAMS).filter((p) => PARAMS[p].kind === "import-door")).toEqual([
      "import_media source.path",
    ]);
  });

  for (const [param, spec] of Object.entries(PARAMS)) {
    if (!spec.call) continue;
    const call = spec.call;

    if (spec.kind === "library-ref" || spec.kind === "project-file") {
      it(`${param}: an absolute path outside the project is never read`, async () => {
        const [name, args] = call(ATTACK);
        const r = await run(name, args);
        expect(marks()).not.toContain(SENT);
        // Refused, or (inspect_color's reference) the rest succeeded and the refusal is SAID.
        const said = r?.ok !== true || typeof r?.reference_error === "string";
        expect(said, JSON.stringify(r).slice(0, 300)).toBe(true);
      });

      it(`${param}: a '..' escape is never read`, async () => {
        const [name, args] = call(DOTDOT);
        await run(name, args);
        expect(marks()).not.toContain(SENT);
      });

      it(`${param}: control — a ref the project knows does reach the file`, async () => {
        const [name, args] = call(spec.control!);
        await run(name, args);
        expect(marks()).toContain(CTRL);
      });
    }

    if (spec.kind === "web-url") {
      it(`${param}: a file:// URL is refused before anything runs`, async () => {
        const [name, args] = call(FILE_URL);
        const r = await run(name, args);
        expect(r?.ok, JSON.stringify(r).slice(0, 300)).not.toBe(true);
        expect(marks()).not.toContain(SENT);
      });

      it(`${param}: control — a web URL is passed on`, async () => {
        const [name, args] = call(WEB_URL);
        await run(name, args);
        expect(marks()).toContain(CTRL);
      });
    }
  }
});

// A HEIF-family still (an iPhone photo) read directly is the wrong picture: its first tile or a
// thumbnail stored ahead of it, and every `-vf` on a tile grid fails. media/stillPicture.ts decodes it
// once; every other reader must read THAT. Walked over every library-ref parameter the served
// contract has, so a tool added later is held to it without anyone remembering to list it.
describe("a HEIF still's pixels are read only through its decoded picture", () => {
  /** The owner's own reads: its inventory probe and its decode (the only graph with `[still]`). */
  const ownerRead = (c: string[]): boolean =>
    (c[0] === "ffmpeg" && c.includes("[still]")) ||
    (c[0] === "ffprobe" && c.some((a) => a.includes("stream_disposition")));
  /** Reads that never look at the picture, and that a still answers correctly anyway. */
  const blindProbe = (c: string[]): boolean =>
    c[0] === "ffprobe" && c.some((a) => a === "format=duration" || a === "stream=index");
  const touchesHeic = (c: string[]): boolean => c.slice(1).some((a) => a.includes(HEIC_NAME));

  for (const [param, spec] of Object.entries(PARAMS)) {
    if (spec.kind !== "library-ref" || !spec.call) continue;
    const call = spec.call;
    it(`${param}: never decodes or measures the raw HEIC itself`, async () => {
      const [name, args] = call("media_heic");
      await run(name, args);
      const raw = calls.filter((c) => touchesHeic(c) && !ownerRead(c) && !blindProbe(c));
      expect(raw.map((c) => c.join(" ").slice(0, 200))).toEqual([]);
    });
  }

  // The floor that keeps the rule above from passing by never looking: these read the picture, so
  // each must have DECODED it through the owner. (Any parameter not listed is still held to the rule.)
  const PIXEL_READERS = [
    "clip_video media_ref",
    "crop_image media_ref",
    "generate_image reference_images[]",
    "generate_video end_frame",
    "generate_video reference_images[]",
    "generate_video start_frame",
    "inspect_color media_ref",
    "inspect_color reference",
    "inspect_media media_ref",
    "run_ffmpeg inputs[]",
    "video_ask media_ref",
    "video_find_moment media_ref",
  ];
  for (const param of PIXEL_READERS) {
    it(`${param}: reads the picture the owner decoded`, async () => {
      const [name, args] = PARAMS[param].call!("media_heic");
      await run(name, args);
      const decoded = calls.some(
        (c) => c[0] === "ffmpeg" && c.includes("[still]") && touchesHeic(c),
      );
      expect(decoded, calls.map((c) => c.join(" ").slice(0, 140)).join("\n")).toBe(true);
    });
  }
});
