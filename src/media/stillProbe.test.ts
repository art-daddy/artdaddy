import { describe, expect, it } from "vitest";

import { probeStillFacts, probeStillTiming, type ReadRange } from "./stillProbe";
import { NO_FACTS } from "./stillReader";

const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** An animated WebP: VP8X, then the given chunks in order. */
const webp = (...chunks: [string, number[]][]) =>
  new Uint8Array([
    ...ascii("RIFF"),
    ...le32(0),
    ...ascii("WEBP"),
    ...ascii("VP8X"),
    ...le32(10),
    0x02,
    ...new Array(9).fill(0),
    ...chunks.flatMap(([cc, d]) => [
      ...ascii(cc),
      ...le32(d.length),
      ...d,
      ...(d.length & 1 ? [0] : []),
    ]),
  ]);
const ANIM = (n: number): [string, number[]] => ["ANIM", [0, 0, 0, 0, n & 255, n >> 8]];

/** A ranged reader over bytes that records every read. */
function reader(bytes: Uint8Array) {
  const reads: Array<[number, number]> = [];
  const read: ReadRange = async (o, n) => {
    reads.push([o, n]);
    return bytes.subarray(o, o + n);
  };
  return { read, reads };
}
const noRunner = null;

describe("probeStillFacts", () => {
  // The limitation this closes: a WebP's loop count behind a colour profile bigger than the bytes
  // first read was unknown, so the preview looped a still the export played N times.
  it("finds a WebP's loop count behind a 70 KB colour profile, a few bytes at a time", async () => {
    const file = webp(["ICCP", new Array(70_001).fill(7)], ANIM(2), [
      "ANMF",
      new Array(16).fill(0),
    ]);
    const { read, reads } = reader(file);
    const { reader: r, facts } = await probeStillFacts(read, noRunner, "x.webp");
    expect(r).toBe("webp_anim");
    expect(facts).toEqual({ ...NO_FACTS, known: true, plays: 2 });
    // The head, the profile's header, ANIM's header and its 6 bytes: nothing of the profile itself.
    expect(reads).toHaveLength(4);
    expect(reads.reduce((n, [, len]) => n + len, 0)).toBeLessThan(2048 + 64);
  });

  it("reads no further than the head when the count is in it", async () => {
    const { read, reads } = reader(webp(ANIM(3), ["ANMF", new Array(16).fill(0)]));
    expect((await probeStillFacts(read, noRunner, "x.webp")).facts).toEqual({
      ...NO_FACTS,
      known: true,
      plays: 3,
    });
    expect(reads).toHaveLength(1);
  });

  // The walk's cost is bounded: 16 chunks, then it stops knowing nothing.
  it("walks at most 16 chunks", async () => {
    const xmp = (n: number): [string, number[]][] =>
      Array.from({ length: n }, () => ["XMP ", new Array(3000).fill(0)]);
    const plays = async (before: number) =>
      (await probeStillFacts(reader(webp(...xmp(before), ANIM(2))).read, noRunner, "x.webp")).facts
        .plays;
    expect(await plays(15)).toBe(2);
    expect(await plays(16)).toBeNull();
  });

  // The failure direction: whatever the bytes, it knows nothing rather than throwing (a throw here
  // would fail the export it was only asked to advise).
  it("knows nothing, and never throws, when a read fails or a chunk is malformed mid-walk", async () => {
    const file = webp(["ICCP", new Array(3000).fill(7)], ANIM(2));
    let n = 0;
    const failsAfterHead: ReadRange = async (o, len) =>
      n++ === 0 ? file.subarray(o, o + len) : null;
    expect((await probeStillFacts(failsAfterHead, noRunner, "x.webp")).facts).toEqual(NO_FACTS);
    const badAnim = webp(["ICCP", new Array(3000).fill(7)], ["ANIM", [0, 0, 0, 0, 2, 0, 0, 0]]);
    expect((await probeStillFacts(reader(badAnim).read, noRunner, "x.webp")).facts).toEqual(
      NO_FACTS,
    );
  });

  // A plain picture costs its head read and nothing else. (Counted, not thrown: the prober swallows
  // a runner's failure, so a throwing runner could not tell "not run" from "run and failed".)
  it("runs nothing for a still that does not animate", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
    let runs = 0;
    const runner = { run: async () => (runs++, { code: 0, stdout: "", stderr: "" }) };
    expect(await probeStillFacts(reader(jpeg).read, runner, "x.gif")).toEqual({
      reader: "picture",
      facts: NO_FACTS,
    });
    expect(runs).toBe(0);
  });

  it("reads a WebP whose first frame comes before any ANIM as playing once", async () => {
    const big = webp(["ICCP", new Array(5000).fill(1)], ["ANMF", new Array(16).fill(0)], ANIM(0));
    expect((await probeStillFacts(reader(big).read, noRunner, "x.webp")).facts.plays).toBe(1);
  });

  it("gives up on a WebP whose chunks lead nowhere, without reading the whole file", async () => {
    const chunks: [string, number[]][] = Array.from({ length: 40 }, () => [
      "XMP ",
      new Array(200).fill(0),
    ]);
    const { read, reads } = reader(webp(...chunks));
    expect((await probeStillFacts(read, noRunner, "x.webp")).facts).toEqual(NO_FACTS);
    expect(reads.length).toBeLessThan(40);
  });

  it("asks ffprobe for a GIF's loop count, wherever in the file it is", async () => {
    const gif = new Uint8Array([...ascii("GIF89a"), 10, 0, 10, 0, 0, 0, 0]);
    const say = (stderr: string, code = 0) => ({
      run: async () => ({ code, stdout: "1\n", stderr }),
    });
    const facts = async (r: ReturnType<typeof say>) =>
      (await probeStillFacts(reader(gif).read, r, "x.gif")).facts;
    expect(await facts(say("[gif @ 0x1] Loop count is 2\n"))).toEqual({
      ...NO_FACTS,
      known: true,
      plays: 2,
    });
    expect(await facts(say("[gif @ 0x1] Loop count is 0\n"))).toEqual({
      ...NO_FACTS,
      known: true,
      plays: 0,
    });
    // Every digit of it: 10 plays eleven times in a browser, never once.
    expect(await facts(say("[gif @ 0x1] Loop count is 10\n"))).toEqual({
      ...NO_FACTS,
      known: true,
      plays: 10,
    });
    expect(await facts(say("[gif @ 0x1] Loop count is 65535\n"))).toEqual({
      ...NO_FACTS,
      known: true,
      plays: 65535,
    });
    expect(await facts(say("no loop extension here"))).toEqual({
      ...NO_FACTS,
      known: true,
      plays: null,
    });
    // A probe that failed knows nothing: the GIF keeps looping, as it always did. So does one that
    // could not run, and one that failed after printing a count.
    expect(await facts(say("", 1))).toEqual(NO_FACTS);
    expect(await facts(say("[gif @ 0x1] Loop count is 2\n", 1))).toEqual(NO_FACTS);
    expect(await facts({ run: async () => Promise.reject(new Error("spawn failed")) })).toEqual(
      NO_FACTS,
    );
    expect((await probeStillFacts(reader(gif).read, null, "x.gif")).facts).toEqual(NO_FACTS);
  });

  // An APNG's facts are in its first bytes; nothing else is read and nothing is run.
  it("reads an APNG's facts from its head alone", async () => {
    const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const chunk = (type: string, data: number[]) => [
      ...be(data.length),
      ...ascii(type),
      ...data,
      0,
      0,
      0,
      0,
    ];
    const apng = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...chunk("IHDR", [...be(40), ...be(30), 8, 6, 0, 0, 0]),
      ...chunk("acTL", [...be(6), ...be(3)]),
      ...chunk("IDAT", [0, 0, 0, 0]),
    ]);
    const { read, reads } = reader(apng);
    const runner = {
      run: async () => {
        throw new Error("nothing should run");
      },
    };
    const got = await probeStillFacts(read, runner, "x.png");
    expect(got).toMatchObject({
      reader: "apng",
      facts: { known: true, plays: 3, frames: 6, width: 40, height: 30 },
    });
    expect(reads).toHaveLength(1);
  });

  it("stops walking a WebP at a cut-off chunk header", async () => {
    const file = webp(["ICCP", new Array(3000).fill(7)], ANIM(2));
    // The file ends inside the header of the chunk after the profile.
    const cut = file.subarray(0, 12 + 18 + 8 + 3000 + 4);
    expect((await probeStillFacts(reader(cut).read, noRunner, "x.webp")).facts).toEqual(NO_FACTS);
  });

  it("knows nothing about bytes it cannot read", async () => {
    expect(await probeStillFacts(async () => null, noRunner, "x.gif")).toEqual({
      reader: null,
      facts: NO_FACTS,
    });
  });
});

describe("probeStillTiming", () => {
  // Packet timestamps equal decoded frame timestamps for all three readers (measured), so the
  // timing needs no decode: a 17 MB GIF probed in 87 ms.
  it("reads the timing from packets, with the passes a browser plays", async () => {
    const runner = {
      run: async (_p: string, args: string[]) => {
        expect(args.join(" ")).toContain("packet=pts,duration");
        return {
          code: 0,
          stdout: JSON.stringify({
            streams: [{ width: 64, height: 32, time_base: "1/100" }],
            packets: [
              { pts: 0, duration: 7 },
              { pts: 7, duration: 13 },
            ],
          }),
          stderr: "",
        };
      },
    };
    const t = await probeStillTiming(runner, "x.gif", "gif", {
      ...NO_FACTS,
      known: true,
      plays: 2,
    });
    expect(t).toEqual({ timing: { den: 100, pts: [0, 7], period: 20, passes: 3 }, w: 64, h: 32 });
  });

  it("is null when ffprobe fails", async () => {
    const runner = { run: async () => ({ code: 1, stdout: "", stderr: "boom" }) };
    expect(await probeStillTiming(runner, "x.gif", "gif", NO_FACTS)).toBeNull();
    // ffprobe can print what it read of a truncated file and THEN fail: never trusted.
    const partial = JSON.stringify({
      streams: [{ width: 8, height: 8, time_base: "1/100" }],
      packets: [
        { pts: 0, duration: 10 },
        { pts: 10, duration: 10 },
      ],
    });
    const failedLate = { run: async () => ({ code: 1, stdout: partial, stderr: "truncated" }) };
    expect(await probeStillTiming(failedLate, "x.gif", "gif", NO_FACTS)).toBeNull();
    const noSpawn = { run: async () => Promise.reject(new Error("spawn failed")) };
    expect(await probeStillTiming(noSpawn, "x.gif", "gif", NO_FACTS)).toBeNull();
    const garbage = { run: async () => ({ code: 0, stdout: "{not json", stderr: "" }) };
    expect(await probeStillTiming(garbage, "x.gif", "gif", NO_FACTS)).toBeNull();
  });

  // Measured: a GIF with anything after its last picture (a comment, a loop count kept at the end)
  // has one packet more than pictures. It decodes to nothing, and the export's `-stream_loop` waits
  // it out: pass 2 of a 10-frame, 10 cs GIF starts at 110 cs, not 100. The timing must say the same,
  // or the preview's frame indexes run past its pictures.
  it("counts a GIF's trailing packet into its pass, never as a picture", async () => {
    const packets = Array.from({ length: 11 }, (_, i) => ({ pts: i * 10, duration: 10 }));
    const runner = {
      run: async (_p: string, args: string[]) => {
        expect(args.join(" ")).toContain("nb_frames");
        return {
          code: 0,
          stdout: JSON.stringify({
            streams: [{ width: 8, height: 8, time_base: "1/100", nb_frames: "10" }],
            packets,
          }),
          stderr: "",
        };
      },
    };
    const t = await probeStillTiming(runner, "x.gif", "gif", {
      ...NO_FACTS,
      known: true,
      plays: 0,
    });
    expect(t?.timing.pts).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(t?.timing.period).toBe(110);
  });
});
