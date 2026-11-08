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
  async rename(from: string, to: string): Promise<void> {
    const contents = await this.readTextFile(from);
    this.files.delete(this.k(from));
    this.files.set(this.k(to), contents);
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

// A ref to media the project is MAKING (or that failed, or whose linked file is gone) is a ref that
// is RIGHT and has no file to read. Every tool that took one said its own thing about the missing
// file ("media not found", "frame not found", "couldn't probe ... No such file or directory"), and
// the model believed it: 28 of one session's 51 tool errors, and 20 failed placements in a month
// (T-15, T-32). The tools were fixed one at a time and each fix missed another, so this walks EVERY
// library-ref parameter the served contract has, nested ones included (the list above is derived,
// so a parameter added later is held to it too), in every state and from both callers.
describe("a ref to media being made, failed or offline is never reported as unknown", () => {
  const WAIT = "media_gen_wait1";
  const BAD = "media_gen_bad1";
  const GONE = "media_gone1";
  const TYPO = "media_typo1";

  /** Parameters for which a state is a legitimate target, not a refusal. An entry is a decision. */
  const ALLOWED: Record<string, { states: string[]; why: string }> = {
    "set_clip_properties media_ref": {
      states: ["generating"],
      why: "a swap onto a generating ref is legitimate: the clip keeps its slot and the picture fills in when it lands (T-15); it is walked below with a probe that fails like the real one",
    },
    "add_captions subtitle_media_ref": {
      states: ["generating", "failed"],
      why: "a subtitle is imported, never generated, so no such ref can be in flight or fail",
    },
  };

  /** What kind of file the parameter takes, for the one state that needs a file of the right kind. */
  const OFFLINE_KIND: Record<string, { kind: string; file: string }> = {
    "add_captions subtitle_media_ref": { kind: "subtitle", file: "Interview.srt" },
  };

  /** A call that gives the entry no length, so a refusal has something to refuse (the template
   *  the attack tests use names one, and a length makes a generating ref placeable). */
  const STATE_CALL: Record<string, Call> = {
    "add_clips entries[].media_ref": (x) => [
      "add_clips",
      { entries: [{ media_ref: x, track_id: "v1", timeline_in: 60 }] },
    ],
  };

  /** What none of the four answers may say about a ref that is right (or, for a typo, about a state). */
  const SAYS_UNKNOWN =
    /not found|couldn't probe|no such file|could not sample|nothing in this project matches|unknown library id|not in the library/i;

  async function runAs(
    surface: "app" | "mcp",
    name: string,
    args: Record<string, unknown>,
    offline: { kind: string; file: string } = { kind: "video", file: "Interview.mp4" },
  ): Promise<Any> {
    const store = seed();
    const lib = joinPath(DIR, "internals/library.json");
    const cat = JSON.parse(await fs.readTextFile(lib));
    cat.clips.push(
      {
        id: WAIT,
        path: `library/${WAIT}.mp4`,
        filename: `${WAIT}.mp4`,
        kind: "video",
        status: "generating",
        added_at: Date.now() / 1000 - 30,
      },
      {
        id: BAD,
        path: `library/${BAD}.mp4`,
        filename: `${BAD}.mp4`,
        kind: "video",
        status: "failed",
        error: "content filter",
      },
      {
        id: GONE,
        path: `D:/Moved/${offline.file}`,
        filename: offline.file,
        kind: offline.kind,
        external: true,
      },
    );
    await fs.writeTextFile(lib, JSON.stringify(cat));
    registerTestDocument(DIR);
    const registry = createToolRegistry(() =>
      agentToolContext({ store, runner: probeLikeTheRealOne, surface }),
    );
    try {
      return await registry.run(name, args);
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  /** The harness runner answers every probe with a picture, which is why a tool that probes a file
   *  that is not there looks fine. The real ffprobe does not: it exits 1 with "No such file or
   *  directory", and that is the sentence the model was handed. This one does the same for the
   *  three state files, and still records every call so {@link probedStateFile} can see the attempt. */
  const probeLikeTheRealOne: CommandRunner = {
    run: async (program, args, ...rest) => {
      if (
        program === "ffprobe" &&
        args.some((a) => /media_gen_wait1|media_gen_bad1|Moved/.test(a))
      ) {
        calls.push([program, ...args]);
        return {
          code: 1,
          stdout: "",
          stderr: `${args[args.length - 1]}: No such file or directory`,
        };
      }
      return runner.run(program, args, ...rest);
    },
  };

  /** The files of the three state rows: none of them may ever be handed to ffprobe or ffmpeg. They
   *  are not there (or not there yet), so the probe's "No such file or directory" is all it could
   *  say, and that is the answer that sent a model after a path. */
  const probedStateFile = (): string[] =>
    calls.flat().filter((a) => /media_gen_wait1|media_gen_bad1|Moved/.test(a));

  /** What the tool said about the ref: its error, or (inspect_color's reference) the said refusal. */
  const said = (r: Any): string => String(r?.error ?? r?.reference_error ?? "");

  const walked = Object.entries(PARAMS).filter(
    (e): e is [string, (typeof PARAMS)[string] & { call: Call }] =>
      e[1].kind === "library-ref" && !!e[1].call,
  );

  it("walks every library-ref parameter the contract has", () => {
    expect(walked.length).toBeGreaterThanOrEqual(17);
    expect(walked.map(([p]) => p)).toEqual(
      expect.arrayContaining([
        "add_clips entries[].media_ref",
        "insert_clips entries[].media_ref",
        "generate_video start_frame",
        "generate_video end_frame",
        "generate_video reference_images[]",
        "generate_image reference_images[]",
        "export media_refs[]",
        "run_ffmpeg inputs[]",
        "inspect_color reference",
        "library_op id_or_path",
      ]),
    );
    for (const p of Object.keys(ALLOWED)) expect(PARAMS[p], p).toBeDefined();
  });

  for (const [param, spec] of walked) {
    const call = STATE_CALL[param] ?? spec.call;
    const row = OFFLINE_KIND[param];
    const allowed = (state: string): boolean => ALLOWED[param]?.states.includes(state) ?? false;

    // The id, and the path the library stores for it: both name the same asset, and a model that
    // is told "not found" about the first writes the second.
    for (const [form, ref] of [
      ["id", WAIT],
      ["path", `library/${WAIT}.mp4`],
    ] as const) {
      if (allowed("generating")) continue;
      it(`${param}: a generating ref (${form}) is said to be generating, to the app and over MCP`, async () => {
        const app = await runAs("app", ...call(ref));
        const mcp = await runAs("mcp", ...call(ref));
        for (const r of [app, mcp]) {
          expect(said(r), JSON.stringify(r).slice(0, 240)).toMatch(/still being generated/i);
          expect(said(r)).not.toMatch(SAYS_UNKNOWN);
        }
        // The in-app agent is told when it lands; an outside one never is, and is told so.
        expect(said(app)).toMatch(/you will be told when it lands/i);
        expect(said(mcp)).toMatch(/nothing will tell you/i);
        expect(said(mcp)).not.toMatch(/you will be told/i);
        expect(app).not.toHaveProperty("pending");
        // A refusal carries the typed status an outside caller can act on.
        if (mcp.ok === false) {
          expect(mcp).toMatchObject({ pending: true, status: "generating" });
          expect(mcp.retry_after_s).toBeGreaterThanOrEqual(10);
        }
        expect(probedStateFile()).toEqual([]);
      });
    }

    if (!allowed("failed"))
      it(`${param}: a FAILED generation says so, with its reason, and does not invite a retry`, async () => {
        for (const surface of ["app", "mcp"] as const) {
          const r = await runAs(surface, ...call(BAD));
          expect(said(r), `${surface} ${JSON.stringify(r).slice(0, 240)}`).toMatch(
            /failed to generate/i,
          );
          expect(said(r)).toContain("content filter");
          expect(said(r)).toMatch(/do not retry/i);
          expect(said(r)).not.toMatch(/still being generated/i);
        }
        expect(probedStateFile()).toEqual([]);
      });

    if (!allowed("offline"))
      it(`${param}: an OFFLINE linked file is offline, and the user is asked to relink it`, async () => {
        for (const surface of ["app", "mcp"] as const) {
          const r = await runAs(surface, ...call(GONE), row);
          expect(said(r), `${surface} ${JSON.stringify(r).slice(0, 240)}`).toMatch(/offline/i);
          expect(said(r)).toMatch(/relink/i);
          expect(said(r)).not.toMatch(SAYS_UNKNOWN);
          expect(said(r)).not.toContain("Moved"); // the library's name for it, never the user's folders
        }
        expect(probedStateFile()).toEqual([]);
      });

    // The direction that keeps the rule honest: a typo is not a generation, a failure or an
    // offline file, whatever the tool says about it.
    it(`${param}: a ref the library has never heard of is not reported as a state`, async () => {
      const r = await runAs("mcp", ...call(TYPO));
      expect(said(r)).not.toMatch(/still being generated|failed to generate|offline/i);
      expect(r).not.toHaveProperty("pending");
    });
  }

  // The one parameter for which a generating ref is a legitimate target, and the exemption above
  // only says so: it was never true. The swap fell through to ffprobe like every other door, so on a
  // real machine it answered "couldn't probe ... No such file or directory" (the harness probe that
  // says yes to everything hid it). With a probe that fails like the real one, it must succeed.
  it("set_clip_properties media_ref: a swap onto a generating ref keeps the slot and probes nothing", async () => {
    for (const surface of ["app", "mcp"] as const) {
      const r = await runAs(surface, "set_clip_properties", { clip_ids: ["c0"], media_ref: WAIT });
      expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
      const clip = (r.clips as Any[]).find((c) => c.id === "c0");
      expect(clip).toMatchObject({ media_ref: WAIT, kind: "video" });
      expect([clip.timeline_in, clip.timeline_out]).toEqual([0, 30]); // the slot is kept
    }
    expect(probedStateFile()).toEqual([]);
  });
});
