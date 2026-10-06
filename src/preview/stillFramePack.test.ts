// The preview's frames of an animated still: made for animated content only (judged by its bytes,
// as ffmpeg judges it), with the index written last so it never describes frames that are not
// there. The frames themselves are proven against the export's pixels in
// stillFramePack.smoke.e2e.ts; this pins the decisions around them.
import { describe, expect, it } from "vitest";

import { parsePackIndex } from "../media/stillFrames";
import { MemFs } from "../test/timelineKit";
import { joinPath, ProjectStoreAccess } from "../tools/store";
import { animIndexName, animPackName } from "./proxyPaths";
import { makeStillFramePack } from "./stillFramePack";

class BytesFs extends MemFs {
  bin = new Map<string, Uint8Array>();
  async exists(p: string): Promise<boolean> {
    return this.bin.has(joinPath(p)) || super.exists(p);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.bin.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
}

const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]) => [...be(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = chunk("IHDR", [...be(40), ...be(40), 8, 6, 0, 0, 0]);
const APNG_ONCE = new Uint8Array([...SIG, ...IHDR, ...chunk("acTL", [...be(6), ...be(1)]), ...chunk("IDAT", [0])]);
const PLAIN_PNG = new Uint8Array([...SIG, ...IHDR, ...chunk("IDAT", [0])]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 40, 0, 40, 0, 0, 0, 0]);

const PROBE = {
  packets: [
    { pts: 0, duration: 7000 },
    { pts: 7000, duration: 13000 },
  ],
  streams: [{ width: 40, height: 40, time_base: "1/100000" }],
};

function setup(
  files: Record<string, Uint8Array>,
  o: { ffmpegFails?: boolean; probe?: unknown; gifLoopCount?: number | null } = {},
) {
  const fs = new BytesFs();
  for (const [p, b] of Object.entries(files)) fs.bin.set(joinPath(`C:/proj/${p}`), b);
  const store = new ProjectStoreAccess("C:/proj", fs);
  const calls: string[] = [];
  const loop = o.gifLoopCount === undefined ? 0 : o.gifLoopCount;
  const runner = {
    run: async (program: string, args: string[]) => {
      calls.push(program);
      // ffprobe as the shipped one answers: a GIF's loop count on stderr at debug level...
      if (program === "ffprobe" && args.includes("debug"))
        return { code: 0, stdout: "1\n", stderr: loop === null ? "" : `[gif @ 0x1] Loop count is ${loop}\n` };
      // ...and the packet timing as JSON.
      if (program === "ffprobe") return { code: 0, stdout: JSON.stringify(o.probe ?? PROBE), stderr: "" };
      if (o.ffmpegFails) return { code: 1, stdout: "", stderr: "boom" };
      await fs.writeTextFile(args[args.length - 1], "frames");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const index = (name: string) => joinPath(`C:/proj/internals/cache/proxies/${animIndexName(joinPath(`C:/proj/${name}`))}`);
  const pack = (name: string) => joinPath(`C:/proj/internals/cache/proxies/${animPackName(joinPath(`C:/proj/${name}`))}`);
  return { fs, store, runner, calls, index, pack };
}

describe("makeStillFramePack", () => {
  it("makes the frames and then the index for an animated still, judged by its bytes", async () => {
    const t = setup({ "library/meme.png": GIF });
    expect(await makeStillFramePack(t.store, t.runner, "library/meme.png")).toBe(true);
    expect(t.fs.files.has(t.pack("library/meme.png"))).toBe(true);
    const index = parsePackIndex(t.fs.files.get(t.index("library/meme.png"))!);
    expect(index?.timing).toEqual({ den: 100000, pts: [0, 7000], period: 20000, passes: Infinity });
    expect(index).toMatchObject({ w: 40, h: 40 });
  });

  // An APNG that plays once is read once by the export and held: the preview holds it too.
  it("records the passes the export plays", async () => {
    const t = setup({ "library/once.png": APNG_ONCE });
    expect(await makeStillFramePack(t.store, t.runner, "library/once.png")).toBe(true);
    expect(parsePackIndex(t.fs.files.get(t.index("library/once.png"))!)?.timing.passes).toBe(1);
  });

  // A GIF's own count, as the export plays it (a browser's rule): none once, N N+1 times.
  it("records a GIF's own count", async () => {
    const passes = async (gifLoopCount: number | null) => {
      const t = setup({ "library/a.gif": GIF }, { gifLoopCount });
      expect(await makeStillFramePack(t.store, t.runner, "library/a.gif")).toBe(true);
      return parsePackIndex(t.fs.files.get(t.index("library/a.gif"))!)?.timing.passes;
    };
    expect(await passes(null)).toBe(1);
    expect(await passes(2)).toBe(3);
    expect(await passes(0)).toBe(Infinity);
  });

  // The failure direction: an ordinary picture must cost nothing but a 2 KB read.
  it("runs nothing at all for a still that does not animate, whatever it is called", async () => {
    const t = setup({ "library/photo.gif": PLAIN_PNG });
    expect(await makeStillFramePack(t.store, t.runner, "library/photo.gif")).toBe(false);
    expect(t.calls).toEqual([]);
  });

  it("leaves no index when the frames could not be made, so nothing describes missing frames", async () => {
    const t = setup({ "library/a.gif": GIF }, { ffmpegFails: true });
    expect(await makeStillFramePack(t.store, t.runner, "library/a.gif")).toBe(false);
    expect(t.fs.files.has(t.index("library/a.gif"))).toBe(false);
  });

  it("makes nothing from a timing it cannot trust, or a single frame", async () => {
    const t = setup({ "library/a.gif": GIF }, { probe: { packets: [], streams: [] } });
    expect(await makeStillFramePack(t.store, t.runner, "library/a.gif")).toBe(false);
    const one = setup({ "library/b.gif": GIF }, { probe: { ...PROBE, packets: [PROBE.packets[0]] } });
    expect(await makeStillFramePack(one.store, one.runner, "library/b.gif")).toBe(false);
    expect(one.calls).not.toContain("ffmpeg"); // never decoded
  });

  it("does the work once", async () => {
    const t = setup({ "library/a.gif": GIF });
    await makeStillFramePack(t.store, t.runner, "library/a.gif");
    const before = t.calls.length;
    expect(await makeStillFramePack(t.store, t.runner, "library/a.gif")).toBe(false);
    expect(t.calls.length).toBe(before);
  });
});
