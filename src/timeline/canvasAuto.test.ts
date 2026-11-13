// The canvas follows the first video clip (T-31, D18). What is checked is what the PERSON or the AGENT ends up
// with: the canvas the timeline has, the project's saved default, how long the clip placed is in frames (which
// is only right when the canvas was settled BEFORE anything was counted), and what the agent is told. A test that
// read "setCanvasTool was called" would pass with the feature doing nothing to the video.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setCanvasChangeConfirmationForTests } from "../lib/confirm";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { useProjectNotice } from "../store/projectNotice";
import { makeEditorCommands } from "../store/editorCommands";
import {
  flushTestDocuments,
  makeRunner,
  registerTestDocument,
  resetTestDocuments,
} from "../test/timelineKit";
import type { CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { setProjectSettingsTool } from "../tools/project";
import { ProjectStoreAccess, type FsLike } from "../tools/store";
import {
  canvasDifference,
  canvasSizeFor,
  clearClipShapeCache,
  majorityShape,
  mismatchQuestion,
  PICTURE_SAMPLE,
  pictureShape,
  picturesQuestion,
  prepareCanvas,
  wholeFps,
  type PictureShape,
} from "./canvasAuto";
import { doUndo, loadTimeline } from "./engine";
import { getTimelineTool } from "./ops";
import {
  addClipsTool,
  clearDurationCache,
  clearHasAudioCache,
  clearHasVideoCache,
  insertClipsTool,
} from "./placement";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// A HEIF-family still (an iPhone photo) is measured as its DECODED picture: probed directly a tiled photo reports the size of one 512 px tile. `stillPicture` is the one owner of that
// decoded picture; a test registers where it is for a name, and every other name goes through the real function (a JPEG is its own picture).
const decoded = vi.hoisted(() => ({
  results: new Map<string, { path: string } | { error: string }>(),
  asked: [] as string[],
}));
vi.mock("../media/stillPicture", async (orig) => {
  const real = await orig<typeof import("../media/stillPicture")>();
  return {
    ...real,
    stillPicture: vi.fn(
      async (store: unknown, runner: unknown, abs: string, signal?: AbortSignal) => {
        const registered = decoded.results.get(abs);
        if (registered) {
          decoded.asked.push(abs);
          return registered;
        }
        return real.stillPicture(store as never, runner as never, abs, signal);
      },
    ),
  };
});

describe("the canvas a clip would give", () => {
  it("is the clip's own size when it is a usable one, with even edges", () => {
    expect(canvasSizeFor(1920, 1080)).toEqual([1920, 1080]);
    expect(canvasSizeFor(1080, 1920)).toEqual([1080, 1920]);
    expect(canvasSizeFor(3840, 2160)).toEqual([3840, 2160]); // exact, however big: no cap (D18)
    expect(canvasSizeFor(1921, 1081)).toEqual([1922, 1082]); // an odd edge breaks some encoders
  });

  it("keeps the shape of a clip past the canvas limit, and refuses one too small to be a canvas", () => {
    expect(canvasSizeFor(16384, 8192)).toEqual([8192, 4096]);
    expect(canvasSizeFor(48, 48)).toBeNull();
    expect(canvasSizeFor(1920, 40)).toBeNull();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(canvasSizeFor(bad, 1080)).toBeNull();
  });

  it("property: whatever the clip, the canvas is even, within the limits, and the clip's shape", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40_000 }),
        fc.integer({ min: 1, max: 40_000 }),
        (w, h) => {
          const size = canvasSizeFor(w, h);
          if (size === null) return;
          const [cw, ch] = size;
          expect(cw % 2 === 0 && ch % 2 === 0).toBe(true);
          expect(Math.min(cw, ch)).toBeGreaterThanOrEqual(64);
          expect(Math.max(cw, ch)).toBeLessThanOrEqual(8192);
          expect(Math.abs(cw / ch - w / h) / (w / h)).toBeLessThan(0.04);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("rounds a frame rate to the whole one it is", () => {
    expect(wholeFps(29.97)).toBe(30);
    expect(wholeFps(23.976)).toBe(24);
    expect(wholeFps(59.94)).toBe(60);
    expect(wholeFps(0.2)).toBe(1);
    expect(wholeFps(240)).toBe(120);
  });

  it("is a difference only when the canvas the clip would give is not the one there is", () => {
    const cur = { width: 1080, height: 1920, fps: 30 };
    expect(canvasDifference(cur, { width: 1080, height: 1920, fps: 30 })).toBeNull();
    expect(canvasDifference(cur, { width: 1080, height: 1920, fps: 29.97 })).toBeNull(); // 30 once rounded
    expect(canvasDifference(cur, { width: 1080, height: 1920, fps: null })).toBeNull(); // rate unknown: leave it
    expect(canvasDifference(cur, { width: 1920, height: 1080, fps: 30 })).toMatchObject({
      width: 1920,
      height: 1080,
      sizeDiffers: true,
      fpsDiffers: false,
    });
    expect(canvasDifference(cur, { width: 1080, height: 1920, fps: 24 })).toMatchObject({
      sizeDiffers: false,
      fpsDiffers: true,
      fps: 24,
    });
    expect(canvasDifference(cur, { width: 30, height: 30, fps: 24 })).toBeNull();
  });

  it("asks the person with both shapes in it", () => {
    const q = mismatchQuestion(
      { width: 1080, height: 1920, fps: 30 },
      { width: 1920, height: 1080, fps: 24, sizeDiffers: true, fpsDiffers: true },
    );
    expect(q).toContain("1920x1080 at 24 fps");
    expect(q).toContain("1080x1920 at 30 fps");
  });
});

// UJ-087, pictures first: the pure rules. A picture's shape is what the person SEES (the probe turns it upright), and a batch's shape is its strict majority.
describe("the shape of a picture, and of a batch of them (UJ-087)", () => {
  it.each([
    [1920, 1080, "16:9"],
    [1080, 1920, "9:16"],
    [1080, 1080, "1:1"],
    [4000, 3000, "16:9"], // 4:3 photos are landscape
    [3000, 2000, "16:9"], // 3:2
    [1080, 1350, "1:1"], // 4:5 portrait is nearer square than tall
    [2560, 1080, "16:9"], // ultrawide
    [1300, 1000, "1:1"], // 1.3 exactly is NOT above 1.3
    [1301, 1000, "16:9"],
    [770, 1000, "1:1"], // 0.77 exactly is NOT below 0.77
    [769, 1000, "9:16"],
  ])("%i x %i is %s", (w, h, shape) => {
    expect(pictureShape(w, h)).toBe(shape);
  });

  it("is no shape at all for a size that is no picture", () => {
    for (const [w, h] of [
      [0, 1080],
      [1920, 0],
      [-1, 5],
      [Number.NaN, 5],
      [5, Number.POSITIVE_INFINITY],
    ])
      expect(pictureShape(w, h)).toBeNull();
  });

  const shapes = fc.array(fc.constantFrom<PictureShape>("16:9", "9:16", "1:1"), { maxLength: 30 });
  it("property: the majority is a shape the sample has, strictly more common than every other, whatever the order", () => {
    fc.assert(
      fc.property(shapes, fc.nat(1000), (sample, seed) => {
        const win = majorityShape(sample);
        const count = (s: PictureShape) => sample.filter((x) => x === s).length;
        if (win) {
          expect(count(win.shape)).toBe(win.count);
          for (const other of ["16:9", "9:16", "1:1"] as const)
            if (other !== win.shape) expect(count(other)).toBeLessThan(win.count);
        } else {
          // no majority only when the sample is empty or two shapes share the top count
          const top = Math.max(0, ...(["16:9", "9:16", "1:1"] as const).map(count));
          expect(
            sample.length === 0 ||
              (["16:9", "9:16", "1:1"] as const).filter((s) => count(s) === top).length > 1,
          ).toBe(true);
        }
        // the order of the drop never changes the answer
        const k = sample.length ? seed % sample.length : 0;
        const reordered = [...sample.slice(k), ...sample.slice(0, k)].reverse();
        expect(majorityShape(reordered)).toEqual(win);
      }),
      { numRuns: 300 },
    );
  });

  it("a half-and-half batch has no majority, and a lone picture is its own", () => {
    expect(majorityShape(["16:9", "9:16"])).toBeNull();
    expect(majorityShape(["16:9", "9:16", "1:1"])).toBeNull();
    expect(majorityShape(["16:9", "16:9", "9:16", "9:16"])).toBeNull();
    expect(majorityShape(["1:1"])).toEqual({ shape: "1:1", count: 1 });
    expect(majorityShape(["16:9", "16:9", "9:16"])).toEqual({ shape: "16:9", count: 2 });
  });

  it("words the question for one picture, all of them and most of them, as the owner's sheet does", () => {
    const cur = { width: 1080, height: 1920, fps: 30 };
    expect(picturesQuestion(cur, "16:9", [1920, 1080], 41, 41)).toBe(
      "The pictures you are adding are landscape, and this project is 1080x1920 at 30 fps (the default).\n\nChange the project to 1920x1080 to match them?",
    );
    expect(picturesQuestion(cur, "16:9", [1920, 1080], 1, 1)).toBe(
      "The picture you are adding is landscape, and this project is 1080x1920 at 30 fps (the default).\n\nChange the project to 1920x1080 to match it?",
    );
    expect(picturesQuestion(cur, "1:1", [1080, 1080], 12, 7)).toMatch(
      /^Most of the pictures you are adding are square, and this project is 1080x1920/,
    );
    expect(PICTURE_SAMPLE).toBe(12);
  });
});

// --- the real path: a project on an in-memory disk, the real tools --------------------------------

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}
function parent(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i > 0 ? n.slice(0, i) : n;
}
function base(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

class MemFs implements FsLike {
  files = new Map<string, string>();
  dirs = new Set<string>();
  private regAncestors(p: string): void {
    let cur = parent(norm(p));
    while (cur && !this.dirs.has(cur)) {
      this.dirs.add(cur);
      const up = parent(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  async exists(p: string): Promise<boolean> {
    const n = norm(p);
    return this.files.has(n) || this.dirs.has(n);
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(norm(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    const n = norm(p);
    this.files.set(n, c);
    this.regAncestors(n);
  }
  async mkdir(p: string): Promise<void> {
    let cur = norm(p);
    while (cur && !this.dirs.has(cur)) {
      this.dirs.add(cur);
      const up = parent(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  async readDir(p: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
    const b = norm(p);
    const out = new Map<string, boolean>();
    for (const f of this.files.keys()) if (parent(f) === b) out.set(base(f), false);
    for (const d of this.dirs) if (parent(d) === b) out.set(base(d), true);
    return [...out.entries()].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async remove(p: string): Promise<void> {
    const b = norm(p);
    for (const f of [...this.files.keys()])
      if (f === b || f.startsWith(`${b}/`)) this.files.delete(f);
  }
  async copyFile(src: string, dst: string): Promise<void> {
    await this.writeTextFile(dst, await this.readTextFile(src));
  }
}

const DATA = "C:/appdata/ArtDaddy";
const ACTIVE = `${DATA}/projects/proj_auto`;

/** What a file is, as ffprobe says it. */
interface Probe {
  kind: "video" | "audio" | "image";
  w?: number;
  h?: number;
  /** r_frame_rate and avg_frame_rate, as ffprobe prints them. */
  rate?: string;
  /** A display turn on the stream: a portrait phone video is a landscape frame plus this. */
  rotation?: number;
  seconds?: number;
  /** ffprobe cannot read it. */
  unreadable?: boolean;
}

function probeRunner(files: Record<string, Probe>): CommandRunner {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  return makeRunner((program, args) => {
    if (program !== "ffprobe") return ok("");
    const path = args[args.length - 1];
    const key = Object.keys(files).find((k) => path.endsWith(k));
    const f = key ? files[key] : undefined;
    if (args.includes("-show_streams")) {
      if (!f || f.unreadable) return { code: 1, stdout: "", stderr: "moov atom not found" };
      const stream: Record<string, unknown> =
        f.kind === "audio"
          ? { codec_type: "audio" }
          : {
              codec_type: "video",
              width: f.w,
              height: f.h,
              r_frame_rate: f.rate ?? "30/1",
              avg_frame_rate: f.rate ?? "30/1",
            };
      if (f.rotation !== undefined) stream.side_data_list = [{ rotation: f.rotation }];
      return ok(
        JSON.stringify({
          format: {
            format_name: f.kind === "image" ? "png_pipe" : "mov,mp4,m4a,3gp,3g2,mj2",
            duration: String(f.seconds ?? 10),
          },
          streams: [stream],
        }),
      );
    }
    if (args.includes("-select_streams")) {
      const want = args[args.indexOf("-select_streams") + 1];
      return ok(f && (want === "v" ? f.kind !== "audio" : f.kind === "audio") ? "1" : "");
    }
    if (args.some((a) => a.includes("format=duration"))) return ok(String(f?.seconds ?? 10));
    return ok("");
  });
}

const CLIPS: Record<string, Probe> = {
  "wide.mp4": { kind: "video", w: 1920, h: 1080, rate: "24000/1001", seconds: 10 },
  "tall.mp4": { kind: "video", w: 1080, h: 1920, rate: "30/1", seconds: 10 },
  "phone.mov": { kind: "video", w: 1920, h: 1080, rate: "30/1", rotation: -90, seconds: 10 },
  "uhd.mp4": { kind: "video", w: 3840, h: 2160, rate: "60/1", seconds: 10 },
  "song.mp3": { kind: "audio", seconds: 10 },
  "photo.png": { kind: "image", w: 4000, h: 3000 },
  "broken.mp4": { kind: "video", unreadable: true },
  // pictures (UJ-087): as ffprobe reports them, a still having one frame and the size stored in the file
  "land1.jpg": { kind: "image", w: 1920, h: 1080 },
  "land2.jpg": { kind: "image", w: 1920, h: 1080 },
  "land3.jpg": { kind: "image", w: 1600, h: 900 },
  "port1.jpg": { kind: "image", w: 1080, h: 1920 },
  "port2.jpg": { kind: "image", w: 1080, h: 1920 },
  "sq1.jpg": { kind: "image", w: 1080, h: 1080 },
  "sq2.jpg": { kind: "image", w: 1200, h: 1200 },
  "photo43.jpg": { kind: "image", w: 4000, h: 3000 },
  // a portrait phone JPEG: a landscape frame plus a quarter turn, shown upright
  "turned1.jpg": { kind: "image", w: 1920, h: 1080, rotation: -90 },
  "turned2.jpg": { kind: "image", w: 1920, h: 1080, rotation: 90 },
  "broken.jpg": { kind: "image", unreadable: true },
  // an iPhone photo: the raw HEIC is ONE 512 px tile (square) to ffprobe; its decoded picture (registered per test with `decoded`) is the real one
  "IMG_0001.HEIC": { kind: "image", w: 512, h: 512 },
  "IMG_0002.HEIC": { kind: "image", w: 512, h: 512 },
  "decoded-landscape.png": { kind: "image", w: 4032, h: 3024 },
  "decoded-portrait.png": { kind: "image", w: 3024, h: 4032 },
};

interface Seed {
  /** Nobody has chosen the canvas yet. */
  auto?: boolean;
  canvas?: { width: number; height: number; fps: number };
  /** A clip already on the timeline. */
  withClip?: boolean;
}

async function project(seed: Seed = {}) {
  // A fresh open document for each project: one in-memory timeline session serves one project at a time, so
  // without this a second project built in the same test would still be holding the first one's clips.
  registerTestDocument(ACTIVE);
  const fs = new MemFs();
  const canvas = seed.canvas ?? { width: 1080, height: 1920, fps: 30 };
  await fs.writeTextFile(
    `${ACTIVE}/internals/project.json`,
    JSON.stringify({ id: "proj_auto", name: "Auto", settings: { canvas } }),
  );
  await fs.writeTextFile(
    `${ACTIVE}/internals/timeline.json`,
    JSON.stringify({
      units: "frames",
      canvas,
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 1,
          clips: seed.withClip
            ? [{ id: "had", media_ref: "tall.mp4", timeline_in: 0, timeline_out: 60 }]
            : [],
        },
      ],
      ...(seed.auto ? { canvas_auto: true } : {}),
    }),
  );
  await fs.writeTextFile(
    `${DATA}/projects.json`,
    JSON.stringify({
      version: 1,
      activeProjectId: "proj_auto",
      projects: [
        { id: "proj_auto", name: "Auto", path: ACTIVE, lastOpenedAt: "2026-01-01T00:00:00Z" },
      ],
    }),
  );
  const store = new ProjectStoreAccess(ACTIVE, fs);
  const ctx = (extra: Partial<ClientToolContext> = {}): ClientToolContext => ({
    store,
    runner: probeRunner(CLIPS),
    ...extra,
  });
  return { fs, store, ctx };
}

const canvasOf = async (store: ProjectStoreAccess) => (await loadTimeline(store)).canvas;
const savedCanvas = async (fs: MemFs) =>
  JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/project.json`)).settings.canvas;
const AGENT = { origin: { executionId: "turn-1" } } as unknown as Partial<ClientToolContext>;

beforeEach(async () => {
  registerTestDocument(ACTIVE);
  clearClipShapeCache();
  clearDurationCache();
  clearHasAudioCache();
  clearHasVideoCache();
});
afterEach(async () => resetTestDocuments());

describe("the first video clip sets the canvas of a project nobody has set", () => {
  it("for the person: its size and frame rate, silently, before anything is counted in frames", async () => {
    const { store, fs, ctx } = await project({ auto: true });
    const r = (await addClipsTool(
      { entries: [{ media_ref: "wide.mp4", timeline_in: 0 }] },
      ctx(),
    )) as Any;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await canvasOf(store)).toEqual({ width: 1920, height: 1080, fps: 24 });
    expect((await loadTimeline(store)).canvas_auto).toBeUndefined(); // chosen now
    // A 10 s clip at the NEW 24 fps. Counted at the old 30 it would be 300 frames: that is the proof the
    // canvas was settled first.
    const clip = (await loadTimeline(store)).tracks.flatMap((t) => t.clips ?? [])[0];
    expect(Number(clip.timeline_out) - Number(clip.timeline_in)).toBe(240);
    expect(r.canvas_note).toBeUndefined(); // the person is not told: for them it is silent
    await flushTestDocuments();
    expect(await savedCanvas(fs)).toEqual({ width: 1920, height: 1080, fps: 24 }); // the saved default agrees
  });

  it("is the size a viewer sees: a portrait phone video is portrait, not its stored landscape", async () => {
    const { store, ctx } = await project({
      auto: true,
      canvas: { width: 1920, height: 1080, fps: 30 },
    });
    await addClipsTool({ entries: [{ media_ref: "phone.mov", timeline_in: 0 }] }, ctx());
    const c = await canvasOf(store);
    expect([c.width, c.height]).toEqual([1080, 1920]);
  });

  it("is exact for a big clip: a 4K clip makes a 4K canvas (the owner's decision)", async () => {
    const { store, ctx } = await project({ auto: true });
    await addClipsTool({ entries: [{ media_ref: "uhd.mp4", timeline_in: 0 }] }, ctx());
    expect(await canvasOf(store)).toEqual({ width: 3840, height: 2160, fps: 60 });
  });

  it("for the agent: the size only, with a note that says what changed and what did not", async () => {
    const { store, ctx } = await project({ auto: true });
    const r = (await addClipsTool(
      { entries: [{ media_ref: "wide.mp4", timeline_in: 0 }] },
      ctx(AGENT),
    )) as Any;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // The frame rate stays: the agent counted its frames at the canvas it read, and it would be wrong under it.
    expect(await canvasOf(store)).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(r.canvas_note).toContain("1920x1080");
    expect(r.canvas_note).toContain("24 fps");
    expect(r.canvas_note).toContain("set_project_settings");
    const clip = (await loadTimeline(store)).tracks.flatMap((t) => t.clips ?? [])[0];
    expect(Number(clip.timeline_out) - Number(clip.timeline_in)).toBe(300); // 10 s at the canvas's 30 fps
  });

  it("an outside agent over MCP is an agent too", async () => {
    const { store, ctx } = await project({ auto: true });
    const r = (await addClipsTool(
      { entries: [{ media_ref: "wide.mp4", timeline_in: 0 }] },
      ctx({ surface: "mcp" }),
    )) as Any;
    expect(await canvasOf(store)).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(r.canvas_note).toBeDefined();
  });

  it("insert_clips settles it the same way", async () => {
    const { store, ctx } = await project({ auto: true });
    const r = (await insertClipsTool(
      { entries: [{ media_ref: "wide.mp4" }], at: 0 },
      ctx(),
    )) as Any;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await canvasOf(store)).toEqual({ width: 1920, height: 1080, fps: 24 });
  });

  it.each(["song.mp3", "photo.png", "broken.mp4"])(
    "%s alone is not a video the canvas follows: the project keeps waiting",
    async (ref) => {
      // A fresh project each, so every one is judged on an EMPTY timeline: after the first clip is placed
      // the rule would not apply anyway, which would hide a mistake in the second and third.
      const { store, ctx } = await project({ auto: true });
      await addClipsTool(
        { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 30 }] },
        ctx(),
      );
      expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
      expect((await loadTimeline(store)).canvas_auto).toBe(true);
    },
  );

  it("takes the first video of several, not the first thing", async () => {
    const { store, ctx } = await project({ auto: true });
    await addClipsTool(
      {
        entries: [
          { media_ref: "song.mp3", timeline_in: 0, timeline_out: 30 },
          { media_ref: "wide.mp4", timeline_in: 0, timeline_out: 30 },
        ],
      },
      ctx(),
    );
    expect(await canvasOf(store)).toMatchObject({ width: 1920, height: 1080 });
  });

  it("does nothing once the timeline has a clip, and keeps waiting", async () => {
    const { store, ctx } = await project({ auto: true, withClip: true });
    await addClipsTool(
      { entries: [{ media_ref: "wide.mp4", timeline_in: 100, timeline_out: 160 }] },
      ctx(),
    );
    expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect((await loadTimeline(store)).canvas_auto).toBe(true);
  });

  it("a clip that already fits settles it without changing anything", async () => {
    const { store, ctx } = await project({ auto: true });
    const r = (await addClipsTool(
      { entries: [{ media_ref: "tall.mp4", timeline_in: 0 }] },
      ctx(AGENT),
    )) as Any;
    expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect((await loadTimeline(store)).canvas_auto).toBeUndefined();
    expect(r.canvas_note).toBeUndefined(); // nothing to say
  });

  it("can be undone, and the project is waiting again", async () => {
    const { store, ctx } = await project({ auto: true });
    await addClipsTool({ entries: [{ media_ref: "wide.mp4", timeline_in: 0 }] }, ctx());
    // the clip first, then the canvas
    await doUndo(store);
    await doUndo(store);
    expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect((await loadTimeline(store)).canvas_auto).toBe(true);
  });
});

describe("a canvas somebody chose is kept", () => {
  it("an explicit canvas change settles an Auto project: the next video does not take it back", async () => {
    const { store, ctx } = await project({ auto: true });
    const set = (await setProjectSettingsTool({ width: 1080, height: 1080 }, ctx())) as Any;
    expect(set.ok, JSON.stringify(set)).toBe(true);
    expect((await loadTimeline(store)).canvas_auto).toBeUndefined();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "wide.mp4", timeline_in: 0 }] },
      ctx(),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(await canvasOf(store)).toEqual({ width: 1080, height: 1080, fps: 30 });
  });

  it("a refused canvas change does not settle it", async () => {
    const { store, ctx } = await project({ auto: true });
    const refused = (await setProjectSettingsTool({ width: 1, height: 1 }, ctx())) as Any;
    expect(refused.ok).toBe(false);
    expect((await loadTimeline(store)).canvas_auto).toBe(true);
  });

  it("a project that has no flag (every project before this) is never taken over", async () => {
    const { store, ctx } = await project({});
    await addClipsTool(
      { entries: [{ media_ref: "wide.mp4", timeline_in: 0, timeline_out: 30 }] },
      ctx(),
    );
    expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
  });

  it("the agent is told, and told to ask, when a clip does not match; the canvas stays", async () => {
    const { store, ctx } = await project({});
    const r = (await addClipsTool(
      { entries: [{ media_ref: "wide.mp4", timeline_in: 0, timeline_out: 30 }] },
      ctx(AGENT),
    )) as Any;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(r.canvas_note).toMatch(/NOT changed/);
    expect(r.canvas_note).toMatch(/ask them first/);
    expect(r.canvas_note).toContain("1920x1080 at 24 fps");
  });

  it("nobody is told or asked about a clip that matches, or when the timeline already has clips", async () => {
    const matching = await project({});
    const r = (await addClipsTool(
      { entries: [{ media_ref: "tall.mp4", timeline_in: 0, timeline_out: 30 }] },
      matching.ctx(AGENT),
    )) as Any;
    expect(r.canvas_note).toBeUndefined();
    const busy = await project({ withClip: true });
    const r2 = (await addClipsTool(
      { entries: [{ media_ref: "wide.mp4", timeline_in: 100, timeline_out: 130 }] },
      busy.ctx(AGENT),
    )) as Any;
    expect(r2.canvas_note).toBeUndefined();
  });
});

describe("asking the person", () => {
  const ask = (answer: boolean) => {
    const asked: string[] = [];
    return {
      asked,
      fn: async (message: string) => {
        asked.push(message);
        return answer;
      },
    };
  };

  it("'Change to Match' changes the project, size and frame rate, and the saved default", async () => {
    const { store, fs, ctx } = await project({});
    const q = ask(true);
    await prepareCanvas(ctx(), ["wide.mp4"], q.fn);
    expect(q.asked).toHaveLength(1);
    expect(q.asked[0]).toContain("1920x1080 at 24 fps");
    expect(await canvasOf(store)).toEqual({ width: 1920, height: 1080, fps: 24 });
    await flushTestDocuments();
    expect(await savedCanvas(fs)).toEqual({ width: 1920, height: 1080, fps: 24 });
  });

  it("'Keep Current' changes nothing", async () => {
    const { store, ctx } = await project({});
    const q = ask(false);
    await prepareCanvas(ctx(), ["wide.mp4"], q.fn);
    expect(q.asked).toHaveLength(1);
    expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
  });

  it("with nobody to ask, the canvas is left as it is", async () => {
    const { store, ctx } = await project({});
    await prepareCanvas(ctx(), ["wide.mp4"]);
    expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
  });

  it("is never asked about a clip that matches, an Auto project, a busy timeline, or the agent", async () => {
    const q = ask(true);
    await prepareCanvas((await project({})).ctx(), ["tall.mp4"], q.fn);
    await prepareCanvas((await project({ auto: true })).ctx(), ["wide.mp4"], q.fn);
    await prepareCanvas((await project({ withClip: true })).ctx(), ["wide.mp4"], q.fn);
    await prepareCanvas((await project({})).ctx(AGENT), ["wide.mp4"], q.fn);
    expect(q.asked).toEqual([]);
  });

  it("a question that throws changes nothing and costs the placement nothing", async () => {
    const { store, ctx } = await project({});
    const r = await prepareCanvas(ctx(), ["wide.mp4"], async () => {
      throw new Error("no dialog backend");
    });
    expect(r).toEqual({});
    expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
  });
});

describe("what the agent reads", () => {
  it("does not show the Auto marker in get_timeline", async () => {
    const { ctx } = await project({ auto: true });
    const r = (await getTimelineTool({}, ctx())) as Any;
    expect(JSON.stringify(r)).not.toContain("canvas_auto");
  });
});

// UJ-087: the agent cannot read `canvas_auto` (above), so the note with the placement result is the only way it can know that the canvas it is placing pictures on is a
// default nobody chose. The placement still goes ahead, as it does for a chosen canvas; the canvas is never changed by the agent's call.
describe("the agent is told when pictures land on a canvas nobody chose (UJ-087)", () => {
  const LAND = ["land1.jpg", "land2.jpg", "land3.jpg", "photo43.jpg"];
  const place = (refs: string[], at = 0) => ({
    entries: refs.map((media_ref, i) => ({
      media_ref,
      timeline_in: at + i * 30,
      timeline_out: at + i * 30 + 30,
    })),
  });
  afterEach(() => __resetExportFlags());

  it("add_clips: the note says what the pictures are, that the canvas is a default that was NOT changed, that they sit in bars, and what to do", async () => {
    const { store, ctx } = await project({ auto: true });
    const r = (await addClipsTool(place(LAND), ctx(AGENT))) as Any;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((r.clips as unknown[]).length).toBe(4); // the placement went ahead
    expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect((await loadTimeline(store)).canvas_auto).toBe(true); // nothing was settled either
    const note = String(r.canvas_note);
    expect(note).toMatch(
      /^The pictures are landscape, but the project canvas is still the default 1080x1920 at 30 fps that nobody chose/,
    );
    expect(note).toContain("NOT changed");
    expect(note).toContain("black bars");
    expect(note).toContain("(1920x1080)");
    expect(note).toMatch(
      /ask them first, then call set_project_settings with width and height and re-read get_timeline\.$/,
    );
    expect(note).not.toMatch(/crop/i); // they are fitted, not cropped: the export of the replay shows bars
  });

  it("insert_clips and an outside agent over MCP get the same note", async () => {
    const a = await project({ auto: true });
    const ins = (await insertClipsTool(
      { entries: [{ media_ref: "land1.jpg" }], at: 0 },
      a.ctx(AGENT),
    )) as Any;
    expect(ins.ok, JSON.stringify(ins)).toBe(true);
    expect(String(ins.canvas_note)).toMatch(
      /^The picture is landscape, but the project canvas is still the default/,
    );
    expect(String(ins.canvas_note)).toContain("it sits small inside it with black bars");
    const b = await project({ auto: true });
    const mcp = (await addClipsTool(
      place(LAND),
      b.ctx({ surface: "mcp" } as Partial<ClientToolContext>),
    )) as Any;
    expect(String(mcp.canvas_note)).toMatch(/^The pictures are landscape/);
    expect(await canvasOf(b.store)).toEqual({ width: 1080, height: 1920, fps: 30 });
  });

  it("says 'most of the pictures' for a majority and names the target of the majority's shape", async () => {
    const { ctx } = await project({ auto: true });
    const r = (await addClipsTool(place(["sq1.jpg", "sq2.jpg", "land1.jpg"]), ctx(AGENT))) as Any;
    expect(String(r.canvas_note)).toMatch(/^Most of the pictures are square,/);
    expect(String(r.canvas_note)).toContain("(1080x1080)");
  });

  it.each([
    ["pictures that already fit the canvas", ["port1.jpg", "port2.jpg"], { auto: true }, 0],
    ["a tie", ["land1.jpg", "port1.jpg"], { auto: true }, 0],
    ["a canvas somebody chose", LAND, {}, 0],
    ["a timeline that already has a clip", LAND, { auto: true, withClip: true }, 200],
  ])("no note for %s", async (_name, refs, seed, at) => {
    const { store, ctx } = await project(seed);
    const before = await canvasOf(store);
    const r = (await addClipsTool(place(refs, at), ctx(AGENT))) as Any;
    expect(r.canvas_note).toBeUndefined();
    expect(await canvasOf(store)).toEqual(before);
  });

  it("a video in the batch is D18, unchanged: the canvas follows it and the note is the adoption note, not the pictures'", async () => {
    const { store, ctx } = await project({ auto: true });
    const r = (await addClipsTool(place(["land1.jpg", "wide.mp4"]), ctx(AGENT))) as Any;
    expect(await canvasOf(store)).toMatchObject({ width: 1920, height: 1080 });
    expect(String(r.canvas_note)).toMatch(
      /^Set the canvas to 1920x1080 to match the first video clip\./,
    );
    expect(String(r.canvas_note)).not.toMatch(/pictures/);
  });

  it("is said once: after the pictures are placed the next call carries no note", async () => {
    const { ctx } = await project({ auto: true });
    const first = (await addClipsTool(place(LAND), ctx(AGENT))) as Any;
    const second = (await addClipsTool(
      { entries: [{ media_ref: "land1.jpg", timeline_in: 400, timeline_out: 430 }] },
      ctx(AGENT),
    )) as Any;
    expect(first.canvas_note).toBeDefined();
    expect(second.canvas_note).toBeUndefined();
  });

  it("the server's switch off (canvas_ask_stills) is 0.27.0: no note", async () => {
    __setExportFlag("canvas_ask_stills", false);
    const { ctx } = await project({ auto: true });
    const r = (await addClipsTool(place(LAND), ctx(AGENT))) as Any;
    expect(r.ok).toBe(true);
    expect(r.canvas_note).toBeUndefined();
  });

  it("a picture that cannot be read does not decide, and does not stop the placement", async () => {
    const { ctx } = await project({ auto: true });
    const r = (await addClipsTool(place(["broken.jpg", "land1.jpg"]), ctx(AGENT))) as Any;
    // the broken one is refused by the placement itself; the readable picture alone is what the note is about
    expect(typeof r.ok).toBe("boolean");
    expect(String(r.canvas_note)).toMatch(/^The picture is landscape/);
  });
});

// The person's own routes into the timeline (a drag from the library, a drop on a lane, an import) are the
// editor's commands, not the agent's tools. They must settle the canvas before they count a clip in frames, and
// they are the only place the person is asked.
describe("the person's editor commands", () => {
  const commands = async (seed: Seed = {}) => {
    const p = await project(seed);
    const timeline = await loadTimeline(p.store);
    const cmds = makeEditorCommands(
      () => ({ store: p.store, timeline }) as Any,
      vi.fn(),
      () => probeRunner(CLIPS),
    );
    return { ...p, cmds };
  };
  const placed = async (store: ProjectStoreAccess) =>
    (await loadTimeline(store)).tracks
      .flatMap((t) => t.clips ?? [])
      .map((c) => [Number(c.timeline_in), Number(c.timeline_out)]);
  const answering = (answer: boolean | "throws") => {
    const asked: string[] = [];
    __setCanvasChangeConfirmationForTests(async (message) => {
      asked.push(message);
      if (answer === "throws") throw new Error("no dialog backend");
      return answer;
    });
    return asked;
  };
  afterEach(() => __setCanvasChangeConfirmationForTests(null));

  // Both directions matter. Counting a 10 s clip at the OLD rate happens to come out right when the new rate is
  // lower (the tool bounds a clip by its source), and cuts it to half when the new rate is higher, so the
  // higher-rate clip is the witness that settles the canvas before it counts.
  it.each([
    ["wide.mp4", { width: 1920, height: 1080, fps: 24 }, 240],
    ["uhd.mp4", { width: 3840, height: 2160, fps: 60 }, 600],
  ])(
    "addClip into an Auto project adopts the canvas of %s first: the whole clip, at ITS frame rate",
    async (ref, canvas, frames) => {
      const asked = answering(true);
      const { store, fs, cmds } = await commands({ auto: true });
      await cmds.addClip(ref, "v1", 0);
      expect(await canvasOf(store)).toEqual(canvas);
      expect(await placed(store)).toEqual([[0, frames]]); // 10 s of footage, in frames of the new rate
      expect(asked).toEqual([]); // nothing was chosen yet, so nobody is asked
      await flushTestDocuments();
      expect(await savedCanvas(fs)).toEqual(canvas);
    },
  );

  it("addClips (a drop, a multi-import) follows the first video of the batch and lays every clip out at its rate", async () => {
    const { store, cmds } = await commands({ auto: true });
    await cmds.addClips(["uhd.mp4", "tall.mp4", "wide.mp4"], "v1", 0);
    expect(await canvasOf(store)).toEqual({ width: 3840, height: 2160, fps: 60 });
    expect(useProjectNotice.getState().message).toBeNull();
    // three 10 s sources, back to back, each 600 frames at the 60 fps of the first one (now the project's)
    expect(await placed(store)).toEqual([
      [0, 600],
      [600, 1200],
      [1200, 1800],
    ]);
  });

  it.each([
    ["wide.mp4", { width: 1920, height: 1080, fps: 24 }, 240],
    ["uhd.mp4", { width: 3840, height: 2160, fps: 60 }, 600],
  ])(
    "'Change to Match' to %s changes a canvas somebody chose, and the clip is counted at the new rate",
    async (ref, canvas, frames) => {
      const asked = answering(true);
      const { store, fs, cmds } = await commands({});
      await cmds.addClip(ref, "v1", 0);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain(`${canvas.width}x${canvas.height} at ${canvas.fps} fps`);
      expect(asked[0]).toContain("1080x1920 at 30 fps");
      expect(await canvasOf(store)).toEqual(canvas);
      expect(await placed(store)).toEqual([[0, frames]]);
      await flushTestDocuments();
      expect(await savedCanvas(fs)).toEqual(canvas);
    },
  );

  it("addClips asks too, once for the whole batch, about its first video", async () => {
    const asked = answering(true);
    const { store, cmds } = await commands({});
    await cmds.addClips(["wide.mp4", "tall.mp4"], "v1", 0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("1920x1080 at 24 fps");
    expect(await canvasOf(store)).toEqual({ width: 1920, height: 1080, fps: 24 });
    expect(await placed(store)).toEqual([
      [0, 240],
      [240, 480],
    ]);
  });

  // The position was counted by the caller in the frames of the canvas the person was looking at. If the first
  // clip changes the frame rate, the same moment in time is a different frame number: a clip dropped two seconds
  // in must still start two seconds in.
  it.each([
    ["wide.mp4", 24, 48],
    ["uhd.mp4", 60, 120],
  ])(
    "addClip: a clip dropped 2 s in still starts 2 s in once %s sets the rate (%i fps)",
    async (ref, fps, start) => {
      const { store, cmds } = await commands({ auto: true });
      await cmds.addClip(ref, "v1", 60); // 60 frames = 2 s at the 30 fps the person was looking at
      expect(await canvasOf(store)).toMatchObject({ fps });
      expect(await placed(store)).toEqual([[start, start + 10 * fps]]);
    },
  );

  it("addClips: the whole batch starts 2 s in once the first clip has set the rate", async () => {
    const { store, cmds } = await commands({ auto: true });
    await cmds.addClips(["uhd.mp4", "tall.mp4"], "v1", 60);
    expect(await placed(store)).toEqual([
      [120, 720],
      [720, 1320],
    ]);
  });

  it("a kept canvas moves nothing: 60 frames is still 2 s at the 30 fps it stays at", async () => {
    answering(false);
    const { store, cmds } = await commands({});
    await cmds.addClips(["wide.mp4"], "v1", 60);
    expect(await placed(store)).toEqual([[60, 360]]);
  });

  it.each([false, "throws" as const])(
    "%s: the canvas stays, and the clip is still placed, at the rate it stays",
    async (answer) => {
      const asked = answering(answer);
      const { store, cmds } = await commands({});
      await cmds.addClip("wide.mp4", "v1", 0);
      expect(asked).toHaveLength(1);
      expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
      expect(await placed(store)).toEqual([[0, 300]]); // 10 s at the canvas's own 30 fps
    },
  );

  it("never asks about a clip that matches, an Auto project, or a timeline that already has clips", async () => {
    const asked = answering(true);
    await (await commands({})).cmds.addClip("tall.mp4", "v1", 0);
    await (await commands({ auto: true })).cmds.addClip("wide.mp4", "v1", 0);
    const busy = await commands({ withClip: true });
    await busy.cmds.addClip("wide.mp4", "v1", 100);
    expect(asked).toEqual([]);
    expect(await canvasOf(busy.store)).toEqual({ width: 1080, height: 1920, fps: 30 });
  });

  // REPLACED on 13 Nov 2026 (owner's answer, Q2 = B, UJ-087; ALIGNMENT C1 to C5). It said a picture is never a reason to ask: "photo.png alone is not a video the canvas
  // follows" is still true (below: the canvas is never TAKEN), but a picture on the empty timeline of an Auto project is now a reason to ASK, because 41 landscape stills went
  // into a 1080x1920 canvas without a word and the person lost about 23 minutes. The question is the existing one, asked in the pictures' words.
  describe("pictures first (UJ-087): the person is asked, the canvas is never taken", () => {
    const LAND = ["land1.jpg", "land2.jpg", "land3.jpg", "photo43.jpg"];
    const answeringTitled = (answer: boolean | "throws") => {
      const asked: Array<{ message: string; title: string }> = [];
      __setCanvasChangeConfirmationForTests(async (message, title) => {
        asked.push({ message, title });
        if (answer === "throws") throw new Error("no dialog backend");
        return answer;
      });
      return asked;
    };
    afterEach(() => __resetExportFlags());

    it("asks once, in the pictures' words and under their own title; 'Change to Match' gives the project their shape, keeps its frame rate, settles it and the saved default", async () => {
      const asked = answeringTitled(true);
      const { store, fs, cmds } = await commands({ auto: true });
      await cmds.addClips(LAND, "v1", 0);
      expect(asked).toEqual([
        {
          title: "Pictures and project differ",
          message:
            "The pictures you are adding are landscape, and this project is 1080x1920 at 30 fps (the default).\n\nChange the project to 1920x1080 to match them?",
        },
      ]);
      expect(await canvasOf(store)).toEqual({ width: 1920, height: 1080, fps: 30 });
      expect((await loadTimeline(store)).canvas_auto).toBeUndefined(); // chosen now
      expect(await placed(store)).toHaveLength(4); // the pictures were placed on the new canvas
      await flushTestDocuments();
      expect(await savedCanvas(fs)).toEqual({ width: 1920, height: 1080, fps: 30 });
    });

    it("'Keep Current' changes nothing, places the pictures, leaves the project Auto, and the next empty-timeline drop asks again", async () => {
      const asked = answeringTitled(false);
      const { store, ctx } = await project({ auto: true });
      const refs = LAND;
      await prepareCanvas(ctx(), refs, async (m, d) => {
        asked.push({ message: m, title: d.subject ?? "clip" });
        return false;
      });
      await prepareCanvas(ctx(), refs, async (m, d) => {
        asked.push({ message: m, title: d.subject ?? "clip" });
        return false;
      });
      expect(asked).toHaveLength(2); // nothing was placed in between: the timeline is still empty
      expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
      expect((await loadTimeline(store)).canvas_auto).toBe(true);
    });

    it("an answer of Keep Current through the person's door still places every picture", async () => {
      answeringTitled(false);
      const { store, cmds } = await commands({ auto: true });
      await cmds.addClips(LAND, "v1", 0);
      expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
      expect((await loadTimeline(store)).canvas_auto).toBe(true);
      expect(await placed(store)).toHaveLength(4);
    });

    it("a library drag of ONE picture asks the same question once, for the picture, not twice", async () => {
      const asked = answeringTitled(false);
      const { cmds } = await commands({ auto: true });
      await cmds.addClip("photo43.jpg", "v1", 0); // addClip asks, then calls addClipsTool, which must neither ask nor say anything again
      expect(asked).toHaveLength(1);
      expect(asked[0].message).toMatch(
        /^The picture you are adding is landscape, and this project is 1080x1920/,
      );
      expect(asked[0].message).toMatch(/to match it\?$/);
    });

    it.each([
      [
        "portrait pictures into the portrait default (they already fit)",
        ["port1.jpg", "port2.jpg"],
        undefined,
      ],
      ["a tie between landscape and portrait", ["land1.jpg", "port1.jpg"], undefined],
      ["a three-way tie", ["land1.jpg", "port1.jpg", "sq1.jpg"], undefined],
      ["pictures only the broken kind (nothing could be measured)", ["broken.jpg"], undefined],
      ["landscape pictures into a landscape canvas", LAND, { width: 1920, height: 1080, fps: 30 }],
    ])("asks nothing for %s", async (_name, refs, canvas) => {
      const asked = answeringTitled(true);
      const { store, cmds } = await commands({ auto: true, ...(canvas ? { canvas } : {}) });
      const before = await canvasOf(store);
      await cmds.addClips(refs, "v1", 0);
      expect(asked).toEqual([]);
      expect(await canvasOf(store)).toEqual(before);
    });

    it("asks for the majority shape: most landscape, square, and the turned portrait phone JPEGs as they are SEEN", async () => {
      const asked = answeringTitled(false);
      const most = await commands({ auto: true });
      await most.cmds.addClips(["land1.jpg", "land2.jpg", "port1.jpg"], "v1", 0);
      expect(asked.at(-1)!.message).toMatch(/^Most of the pictures you are adding are landscape,/);
      expect(asked.at(-1)!.message).toContain("Change the project to 1920x1080 to match them?");

      const square = await commands({ auto: true });
      await square.cmds.addClips(["sq1.jpg", "sq2.jpg"], "v1", 0);
      expect(asked.at(-1)!.message).toMatch(/^The pictures you are adding are square,/);
      expect(asked.at(-1)!.message).toContain("Change the project to 1080x1080 to match them?");

      // stored landscape, turned a quarter: the person sees portrait. On a landscape default only the seen shape is a difference.
      const turned = await commands({ auto: true, canvas: { width: 1920, height: 1080, fps: 30 } });
      await turned.cmds.addClips(["turned1.jpg", "turned2.jpg"], "v1", 0);
      expect(asked.at(-1)!.message).toMatch(/^The pictures you are adding are portrait,/);
      expect(asked.at(-1)!.message).toContain("Change the project to 1080x1920 to match them?");
    });

    it("only the first 12 pictures decide a big drop: 12 landscape then 20 portrait is landscape", async () => {
      const asked = answeringTitled(false);
      const { cmds } = await commands({ auto: true });
      const refs = [...Array(12).fill("land1.jpg"), ...Array(20).fill("port1.jpg")];
      await cmds.addClips(refs, "v1", 0);
      expect(asked).toHaveLength(1);
      expect(asked[0].message).toMatch(/^The pictures you are adding are landscape,/); // counted over all 32 it would be portrait, the canvas shape: no question
    });

    it("audio in the batch is ignored, and an unreadable picture shrinks the sample without deciding it", async () => {
      const asked = answeringTitled(false);
      const { cmds } = await commands({ auto: true });
      await cmds.addClips(["song.mp3", "broken.jpg", "land1.jpg", "song.mp3"], "v1", 0);
      expect(asked).toHaveLength(1);
      expect(asked[0].message).toMatch(/^The picture you are adding is landscape,/);
    });

    it("a video in the batch is D18, as before: the canvas follows it silently and the pictures never decide or ask", async () => {
      const asked = answeringTitled(true);
      const a = await commands({ auto: true });
      await a.cmds.addClips(["port1.jpg", "wide.mp4"], "v1", 0);
      expect(await canvasOf(a.store)).toMatchObject({ width: 1920, height: 1080, fps: 24 });
      const b = await commands({ auto: true });
      await b.cmds.addClips(["land1.jpg", "land2.jpg", "tall.mp4"], "v1", 0);
      expect(await canvasOf(b.store)).toMatchObject({ width: 1080, height: 1920, fps: 30 });
      expect(asked).toEqual([]);
    });

    it("a canvas somebody chose is not asked about pictures, and a timeline that already has clips is never asked", async () => {
      const asked = answeringTitled(true);
      const chosen = await commands({});
      await chosen.cmds.addClips(LAND, "v1", 0);
      const busy = await commands({ auto: true, withClip: true });
      await busy.cmds.addClips(LAND, "v1", 100);
      expect(asked).toEqual([]);
      expect(await canvasOf(chosen.store)).toEqual({ width: 1080, height: 1920, fps: 30 });
      expect(await canvasOf(busy.store)).toEqual({ width: 1080, height: 1920, fps: 30 });
    });

    it.each([false, "throws" as const])(
      "%s: the canvas stays and the pictures are still placed",
      async (answer) => {
        const asked = answeringTitled(answer);
        const { store, cmds } = await commands({ auto: true });
        await cmds.addClips(LAND, "v1", 0);
        expect(asked).toHaveLength(1);
        expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
        expect(await placed(store)).toHaveLength(4);
      },
    );

    it("a HEIC iPhone photo is measured as its DECODED picture: the raw file is one square tile to ffprobe, and must not decide", async () => {
      decoded.results.clear();
      decoded.asked.length = 0;
      decoded.results.set("IMG_0001.HEIC", { path: "decoded-landscape.png" });
      decoded.results.set("IMG_0002.HEIC", { path: "decoded-landscape.png" });
      const asked = answeringTitled(false);
      const { cmds } = await commands({ auto: true });
      await cmds.addClips(["IMG_0001.HEIC", "IMG_0002.HEIC"], "v1", 0);
      expect(decoded.asked.sort()).toEqual(["IMG_0001.HEIC", "IMG_0002.HEIC"]);
      expect(asked).toHaveLength(1);
      // read as the tiles it is it would be "square" and ask for 1080x1080
      expect(asked[0].message).toMatch(/^The pictures you are adding are landscape,/);
      expect(asked[0].message).toContain("Change the project to 1920x1080");
    });

    it("a HEIC that cannot be decoded is passed over: it never decides, and alone it asks nothing", async () => {
      decoded.results.clear();
      decoded.results.set("IMG_0002.HEIC", { error: "'IMG_0002.HEIC' could not be decoded" });
      const asked = answeringTitled(true);
      const { store, cmds } = await commands({ auto: true });
      await cmds.addClips(["IMG_0002.HEIC"], "v1", 0);
      expect(asked).toEqual([]);
      expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
    });

    it("the server's switch off (canvas_ask_stills) is 0.27.0: nothing asked, nothing changed", async () => {
      __setExportFlag("canvas_ask_stills", false);
      const asked = answeringTitled(true);
      const { store, cmds } = await commands({ auto: true });
      await cmds.addClips(LAND, "v1", 0);
      expect(asked).toEqual([]);
      expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
      expect(await placed(store)).toHaveLength(4);
    });

    // The dialog is modal for the person, not for the agent: while it is open the agent can place clips or change the canvas itself. The answer is applied only to the
    // project as it was asked about. Same boundary for the new question and the old one (a video that does not fit a chosen canvas).
    it.each([
      ["pictures on an Auto project", { auto: true }, LAND, "land1.jpg"], // a PICTURE keeps the project Auto, so only the clips on the timeline stop the change
      ["a video on a chosen canvas", {}, ["wide.mp4"], "tall.mp4"],
    ])(
      "while the question about %s is open, a clip the agent places stops 'Change to Match' from reshaping the project",
      async (_name, seed, refs, agentRef) => {
        const { store, ctx, cmds } = await commands(seed);
        __setCanvasChangeConfirmationForTests(async () => {
          await addClipsTool(
            { entries: [{ media_ref: agentRef, timeline_in: 0, timeline_out: 30 }] },
            ctx(AGENT),
          );
          return true; // the person clicks Change to Match after that
        });
        await cmds.addClips(refs, "v1", 0);
        expect(await canvasOf(store)).toEqual({ width: 1080, height: 1920, fps: 30 });
      },
    );

    it("...and so does the agent changing the canvas itself while the question is open", async () => {
      const { store, ctx, cmds } = await commands({ auto: true });
      __setCanvasChangeConfirmationForTests(async () => {
        await setProjectSettingsTool({ width: 1080, height: 1080 }, ctx(AGENT));
        return true;
      });
      await cmds.addClips(LAND, "v1", 0);
      expect(await canvasOf(store)).toEqual({ width: 1080, height: 1080, fps: 30 }); // the agent's, not the person's answer to an older question
    });
  });
});
