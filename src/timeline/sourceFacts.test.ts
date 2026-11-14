import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { CommandRunner } from "../tools/command";
import { probePath } from "../tools/media";
import { readOneSourceFacts, readSourceFacts, type SourceFacts } from "./sourceFacts";

vi.mock("../tools/media", () => ({ probePath: vi.fn() }));

const runner: CommandRunner = {
  async run() {
    return { code: 0, stdout: "", stderr: "" };
  },
};
const probe = vi.mocked(probePath);
const answer = (table: Record<string, unknown>): void => {
  probe.mockImplementation(async (_runner, path) => {
    const row = table[path];
    if (row === "throws") throw new Error("spawn failed");
    return row as never;
  });
};

afterEach(() => probe.mockReset());

/** The rule the report bands and the cost model rely on: a value that could not be read is null, never a stand-in. */
function isHonest(f: SourceFacts): boolean {
  const size = (v: number | null): boolean => v === null || (Number.isInteger(v) && v > 0);
  return (
    ["video", "image", "audio"].includes(f.kind) &&
    size(f.width) &&
    size(f.height) &&
    (f.codec === null ||
      (typeof f.codec === "string" && f.codec !== "" && !/^unknown/i.test(f.codec))) &&
    (f.hasAlpha === null || typeof f.hasAlpha === "boolean") &&
    (f.kind !== "audio" || (f.width === null && f.height === null && f.hasAlpha === null))
  );
}

describe("sourceFacts: the one reader of a source's size, codec and see-through-ness", () => {
  it("reads a video, a still picture and a sound-only file as what they are", async () => {
    answer({
      "/clip.mp4": {
        ok: true,
        format: "mov,mp4,m4a,3gp,3g2,mj2",
        video: { width: 1920, height: 1080, codec: "h264", pix_fmt: "yuv420p" },
        audio: { codec: "aac" },
      },
      "/shot.png": {
        ok: true,
        format: "png_pipe",
        video: { width: 800, height: 600, codec: "png", pix_fmt: "rgba" },
      },
      "/song.mp3": { ok: true, format: "mp3", audio: { codec: "mp3" } },
    });
    expect(await readOneSourceFacts(runner, "/clip.mp4")).toEqual({
      kind: "video",
      width: 1920,
      height: 1080,
      codec: "h264",
      hasAlpha: false,
    });
    expect(await readOneSourceFacts(runner, "/shot.png")).toEqual({
      kind: "image",
      width: 800,
      height: 600,
      codec: "png",
      hasAlpha: true,
    });
    expect(await readOneSourceFacts(runner, "/song.mp3")).toEqual({
      kind: "audio",
      width: null,
      height: null,
      codec: "mp3",
      hasAlpha: null,
    });
  });

  it("unknown is null, never a stand-in word or a zero", async () => {
    answer({
      "/odd.mkv": {
        ok: true,
        format: "matroska,webm",
        video: { width: 0, height: 1080.5, codec: 7, pix_fmt: "some_new_format" },
      },
    });
    expect(await readOneSourceFacts(runner, "/odd.mkv")).toEqual({
      kind: "video",
      width: null,
      height: null,
      codec: null,
      hasAlpha: null,
    });
    answer({
      "/x.bin": {
        ok: true,
        format: "bin",
        video: { width: 2, height: 2, codec: "unknown_codec", pix_fmt: "yuv420p" },
      },
      "/y.bin": {
        ok: true,
        format: "bin",
        video: { width: 2, height: 2, codec: "", pix_fmt: "yuv420p" },
      },
    });
    expect((await readOneSourceFacts(runner, "/x.bin"))?.codec).toBeNull();
    expect((await readOneSourceFacts(runner, "/y.bin"))?.codec).toBeNull();
  });

  it("a file that cannot be probed has no entry and does not stop the others; nothing throws", async () => {
    answer({
      "/a.mp4": {
        ok: true,
        format: "mp4",
        video: { width: 640, height: 360, codec: "h264", pix_fmt: "yuv420p" },
      },
      "/broken.mp4": "throws",
      "/refused.mp4": { ok: false },
      "/empty.bin": { ok: true, format: "bin" },
    });
    const facts = await readSourceFacts(runner, [
      "/a.mp4",
      "/broken.mp4",
      "/refused.mp4",
      "/empty.bin",
    ]);
    expect([...facts.keys()]).toEqual(["/a.mp4"]);
  });

  it("probes each distinct file once, never more than three at a time, and stops when the export is cancelled", async () => {
    let inFlight = 0;
    let most = 0;
    const seen: string[] = [];
    probe.mockImplementation(async (_runner, path) => {
      seen.push(path);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return {
        ok: true,
        format: "mp4",
        video: { width: 2, height: 2, codec: "h264", pix_fmt: "yuv420p" },
      } as never;
    });
    const paths = Array.from({ length: 12 }, (_, i) => `/f${i % 8}.mp4`);
    const facts = await readSourceFacts(runner, paths);
    expect(facts.size).toBe(8);
    expect(new Set(seen).size).toBe(seen.length);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(3);

    seen.length = 0;
    const controller = new AbortController();
    controller.abort();
    expect((await readSourceFacts(runner, paths, controller.signal)).size).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("whatever the probe says, the facts are honest (property), and the checker itself rejects a stand-in", async () => {
    const value = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.integer({ min: -5, max: 9000 }),
      fc.double({ min: -5, max: 9000, noNaN: true }),
      fc.string({ maxLength: 12 }),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          ok: fc.constantFrom(true, true, true, false),
          format: fc.oneof(fc.constantFrom("png_pipe", "mov,mp4", "image2", "mp3"), value),
          video: fc.oneof(
            fc.constant(undefined),
            fc.record({
              width: value,
              height: value,
              codec: value,
              pix_fmt: fc.oneof(
                fc.constantFrom("rgba", "yuv420p", "gray", "nv12", "yuva444p10le"),
                value,
              ),
            }),
          ),
          audio: fc.oneof(fc.constant(undefined), fc.record({ codec: value })),
        }),
        async (row) => {
          answer({ "/x": row });
          const facts = await readOneSourceFacts(runner, "/x");
          return facts === null || isHonest(facts);
        },
      ),
      { numRuns: 300 },
    );
    expect(isHonest({ kind: "video", width: 0, height: 10, codec: "h264", hasAlpha: false })).toBe(
      false,
    );
    expect(isHonest({ kind: "video", width: 10, height: 10, codec: "", hasAlpha: false })).toBe(
      false,
    );
    expect(
      isHonest({ kind: "video", width: 10, height: 10, codec: "unknown_codec", hasAlpha: false }),
    ).toBe(false);
    expect(isHonest({ kind: "audio", width: 10, height: null, codec: "mp3", hasAlpha: null })).toBe(
      false,
    );
  });
});
