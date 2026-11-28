// The storyboard inspect_media makes for the agent (its `overview`): which frames become tiles, and the time written on
// each one. The agent edits by those times, so a tile labelled with the time a seek ASKED for, rather than the time the
// frame really sits at, sends its cut to the wrong place. storyboard.test.ts holds the pure selection rules; this drives
// makeStoryboard itself over a fake ffmpeg that answers the way the real one does (each seek lands on the keyframe
// before it, reported by showinfo as a negative pts_time), and reads what it writes: the tile times, the label sheet, the
// tile list, the cache, and what is left behind when a step fails.
import { describe, expect, it } from "vitest";

import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { makeStoryboard, OVERVIEW, showinfoIndex, timeLabel } from "./storyboard";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";

class MemFs implements FsLike {
  text = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  async exists(p: string): Promise<boolean> {
    const n = joinPath(p);
    return this.text.has(n) || this.bytes.has(n);
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.text.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.text.set(joinPath(p), c);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.bytes.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async mkdir(): Promise<void> {}
  async remove(p: string): Promise<void> {
    const prefix = joinPath(p);
    for (const m of [this.text, this.bytes])
      for (const k of [...m.keys()]) if (k === prefix || k.startsWith(`${prefix}/`)) m.delete(k);
  }
  /** Every path that still holds something. */
  paths(): string[] {
    return [...this.text.keys(), ...this.bytes.keys()];
  }
}

const DIR = "C:/proj";
const SOURCE = "C:/media/talk.mp4";
const KEYFRAME_EVERY = 10; // seconds: a seek lands on the keyframe at or before it

/** The picture at a keyframe: scenes alternate dark and bright, so every keyframe is a new tile. */
const gridAt = (keyframe: number): Uint8Array =>
  new Uint8Array(64).fill((keyframe / KEYFRAME_EVERY) % 2 ? 200 : 20);

interface Run {
  args: string[];
  /** The label sheet the compose step burned in, read from its scratch folder while it ran. */
  labels?: string;
  tiles?: string;
}

function rig(opts: { failBatch?: boolean; failCompose?: boolean } = {}) {
  const fs = new MemFs();
  const store = new ProjectStoreAccess(DIR, fs);
  const runs: Run[] = [];
  const runner: CommandRunner = {
    run: async (_cmd, args, _signal, cwd) => {
      const run: Run = { args: [...args] };
      runs.push(run);
      if (args.includes("-filter_complex")) {
        if (opts.failBatch) return { code: 1, stdout: "", stderr: "talk.mp4: Invalid data found" };
        const seeks = args.flatMap((a, i) => (a === "-ss" ? [Number(args[i + 1])] : []));
        const gridFile = args[args.length - 1];
        const grids = new Uint8Array(seeks.length * 64);
        const lines = seeks.map((t, i) => {
          const keyframe = Math.floor(t / KEYFRAME_EVERY) * KEYFRAME_EVERY;
          grids.set(gridAt(keyframe), i * 64);
          return `[Parsed_showinfo_${showinfoIndex(i)} @ 000001] n:   0 pts:      0 pts_time:${(keyframe - t).toFixed(3)} duration: 1`;
        });
        await fs.writeBytes(gridFile, grids);
        return { code: 0, stdout: "", stderr: lines.join("\n") };
      }
      // The compose step: one sheet out of the listed tiles, with the label sheet burned in.
      const listFile = args[args.indexOf("-i") + 1];
      run.tiles = await fs.readTextFile(listFile);
      if (cwd) run.labels = await fs.readTextFile(joinPath(cwd, "storyboard_labels.ass"));
      if (opts.failCompose) return { code: 1, stdout: "", stderr: "Error opening output" };
      await fs.writeBytes(args[args.length - 1], new Uint8Array([0xff, 0xd8]));
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const ctx = { store, runner } as unknown as ClientToolContext;
  return { fs, ctx, runs };
}

const LANDSCAPE = { w: 1920, h: 1080 };
const SPAN: [number, number] = [0, 240]; // 120 candidates, in four batches of 30, run side by side

describe("makeStoryboard", () => {
  it("labels each tile with the time its frame really sits at, one tile per keyframe that looks new", async () => {
    const { ctx, runs } = rig();
    const board = await makeStoryboard(ctx, SOURCE, ...SPAN, LANDSCAPE);
    const keyframes = Array.from({ length: 24 }, (_, i) => i * KEYFRAME_EVERY);
    expect(board.tile_times).toEqual(keyframes);
    expect(runs.filter((r) => r.args.includes("-filter_complex"))).toHaveLength(
      Math.ceil(120 / OVERVIEW.batch),
    );

    const compose = runs[runs.length - 1];
    // Row by row, six to a row: each tile's chip at its own top-left corner says its own time.
    const tile = { w: 160, h: 90 };
    const chips = [...compose.labels!.matchAll(/\\pos\((\d+),(\d+)\)\}([\d:]+)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
      m[3],
    ]);
    expect(chips).toEqual(
      keyframes.map((t, i) => [(i % 6) * tile.w + 4, Math.floor(i / 6) * tile.h + 2, timeLabel(t)]),
    );
    expect(compose.labels).toContain(`PlayResX: ${6 * tile.w}`);
    expect(compose.labels).toContain(`PlayResY: ${4 * tile.h}`);
    // The sheet is laid out from the tiles in the same order as the times handed back.
    expect(compose.tiles!.split("\n")).toHaveLength(keyframes.length);
    expect(compose.args).toContain(
      `tile=6x4:color=black,ass=f=storyboard_labels.ass:fontsdir=fonts`,
    );
  });

  it("keeps a portrait source portrait, and a short clip to the tiles it has", async () => {
    const { ctx, runs } = rig();
    const board = await makeStoryboard(ctx, SOURCE, 0, 25, { w: 1080, h: 1920 });
    expect(board.tile_times).toEqual([0, 10, 20]);
    const compose = runs[runs.length - 1];
    expect(compose.args).toContain(
      `tile=3x1:color=black,ass=f=storyboard_labels.ass:fontsdir=fonts`,
    );
    expect(compose.labels).toContain(`PlayResX: ${3 * 90}`);
    expect(compose.labels).toContain("PlayResY: 160");
  });

  it("answers the same span of the same file from its cache, without running ffmpeg again", async () => {
    const { ctx, runs } = rig();
    const first = await makeStoryboard(ctx, SOURCE, ...SPAN, LANDSCAPE);
    const ran = runs.length;
    const again = await makeStoryboard(ctx, SOURCE, ...SPAN, LANDSCAPE);
    expect(again).toEqual(first);
    expect(runs).toHaveLength(ran);
    // Another span is another storyboard.
    await makeStoryboard(ctx, SOURCE, 0, 60, LANDSCAPE);
    expect(runs.length).toBeGreaterThan(ran);
  });

  it("says why when ffmpeg cannot read the file, leaves no scratch behind and caches nothing", async () => {
    const broken = rig({ failBatch: true });
    await expect(makeStoryboard(broken.ctx, SOURCE, ...SPAN, LANDSCAPE)).rejects.toThrow(
      /Invalid data found/,
    );
    expect(broken.fs.paths().filter((p) => p.includes("_work/"))).toEqual([]);
    expect(broken.fs.paths().filter((p) => p.includes("/inspect/ov_"))).toEqual([]);
  });

  it("fails, and caches nothing, when the sheet cannot be composed", async () => {
    const broken = rig({ failCompose: true });
    await expect(makeStoryboard(broken.ctx, SOURCE, ...SPAN, LANDSCAPE)).rejects.toThrow(
      /composing the overview failed: Error opening output/,
    );
    expect(broken.fs.paths().filter((p) => p.includes("/inspect/ov_"))).toEqual([]);
  });
});
