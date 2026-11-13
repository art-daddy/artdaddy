// A preview proxy is needed when the WebView cannot decode the source — and that is a
// question about the CONTAINER as much as the codec. mp4box parses ISOBMFF only, so
// h264-in-Matroska is undecodable here even though h264 alone is fine. The file that
// exposed this was a screen recording named ".mp4" that ffprobe reported as
// matroska,webm: a codec-only check cleared it, no proxy was built, and the preview
// silently showed nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { processImportedMedia } from "./mediaProxy";
import { recordMedia } from "../api/editorEvents";
import { highH264DecodesCorrectly } from "./h264Support";
import { onMediaDerived } from "./mediaDerived";
import { posterName, proxyKey, proxyRel, webOkName } from "./proxyPaths";
import { ExportMemFs, MemFs } from "../test/timelineKit";
import { ProjectStoreAccess } from "../tools/store";

vi.mock("./h264Support", () => ({ highH264DecodesCorrectly: vi.fn() }));
vi.mock("../api/editorEvents", async (orig) => ({
  ...(await orig<typeof import("../api/editorEvents")>()),
  recordMedia: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(highH264DecodesCorrectly).mockResolvedValue(true);
  vi.mocked(recordMedia).mockClear();
});

type Probe = { codec: string; format: string; audioOnly?: boolean };

/** Records the ffmpeg invocations a probe of `p` provokes. */
async function run(p: Probe, source = "library/a.mp4", legacyWebOk = false, failProxy = false) {
  const fs = new MemFs();
  await fs.writeTextFile(`C:/proj/${source}`, "media");
  const store = new ProjectStoreAccess("C:/proj", fs);
  if (legacyWebOk) {
    await fs.writeTextFile(store.artifactPath(`proxies/${proxyKey(source)}.webok`), "");
  }
  const ffmpeg: string[][] = [];
  const runner = {
    run: async (program: string, args: string[]) => {
      if (program === "ffprobe") {
        return {
          code: 0,
          stdout: JSON.stringify({
            format: { format_name: p.format, duration: "5", size: "52428800" },
            streams: [
              p.audioOnly
                ? { codec_type: "audio", codec_name: p.codec, sample_rate: "48000", channels: 1 }
                : { codec_type: "video", codec_name: p.codec, width: 1920, height: 1080 },
            ],
          }),
          stderr: "",
        };
      }
      ffmpeg.push(args);
      if (failProxy && args.includes("libx264")) return { code: 1, stdout: "", stderr: "boom" };
      // Whatever ffmpeg was told to write, pretend it wrote it.
      await fs.writeTextFile(args[args.length - 1], "out");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  await processImportedMedia(store, runner, source);
  return { ffmpeg, store, fs };
}

/** ffmpeg calls that build the H.264 proxy (the poster pass also runs, and is not one). */
const proxyRuns = (calls: string[][]) => calls.filter((a) => a.includes("libx264"));

describe("what a first look at a video says about it (the editor stream)", () => {
  it("a file that needed a preview copy says what it is, that one was made, and how long it took", async () => {
    await run({ codec: "h264", format: "matroska,webm" });
    expect(recordMedia).toHaveBeenCalledTimes(1);
    const [facts, project] = vi.mocked(recordMedia).mock.calls[0];
    expect(project).toBe("proj");
    expect(facts).toMatchObject({
      media: "video",
      codec: "h264",
      width: 1920,
      height: 1080,
      seconds: 5,
      bytes: 52_428_800,
      proxy: "built",
    });
    expect(facts.ms).toBeGreaterThanOrEqual(0);
  });

  it("a file the preview plays as it is says that no copy was needed", async () => {
    await run({ codec: "h264", format: "mov,mp4,m4a,3gp,3g2,mj2" });
    expect(vi.mocked(recordMedia).mock.calls[0][0]).toMatchObject({
      codec: "h264",
      proxy: "none",
      ms: 0,
    });
  });

  it("a copy that could not be made says so, and still says what the file is", async () => {
    await run({ codec: "hevc", format: "matroska,webm" }, "library/a.mp4", false, true);
    expect(vi.mocked(recordMedia).mock.calls[0][0]).toMatchObject({
      codec: "hevc",
      proxy: "failed",
      width: 1920,
    });
  });

  it("is said once for a file: looking at it again finds the copy and says nothing", async () => {
    const fs = new MemFs();
    await fs.writeTextFile("C:/proj/library/a.mp4", "media");
    const store = new ProjectStoreAccess("C:/proj", fs);
    const runner = {
      run: async (program: string, args: string[]) => {
        if (program === "ffprobe")
          return {
            code: 0,
            stdout: JSON.stringify({
              format: { format_name: "matroska,webm", duration: "5" },
              streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 360 }],
            }),
            stderr: "",
          };
        await fs.writeTextFile(args[args.length - 1], "out");
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await processImportedMedia(store, runner, "library/a.mp4");
    await processImportedMedia(store, runner, "library/a.mp4");
    expect(recordMedia).toHaveBeenCalledTimes(1);
  });

  it("carries no file name and no folder", async () => {
    await run({ codec: "h264", format: "matroska,webm" }, "library/My Private Holiday.mp4");
    expect(JSON.stringify(vi.mocked(recordMedia).mock.calls)).not.toMatch(
      /Private|Holiday|library|\.mp4/,
    );
  });

  it("an audio-only file named like a video says nothing about a preview copy", async () => {
    await run({ codec: "aac", format: "mov,mp4,m4a,3gp,3g2,mj2", audioOnly: true });
    expect(recordMedia).not.toHaveBeenCalled();
  });

  it("a recorder that throws costs the preview copy nothing", async () => {
    vi.mocked(recordMedia).mockImplementation(() => {
      throw new Error("the recorder is broken");
    });
    const { store } = await run({ codec: "h264", format: "matroska,webm" });
    expect(await store.exists(`C:/proj/${proxyRel("library/a.mp4")}`)).toBe(true);
    vi.mocked(recordMedia).mockReset();
  });
});

describe("preview proxy — what the WebView can actually decode", () => {
  it("builds a proxy for h264 in a NON-ISOBMFF container, whatever the file is named", async () => {
    const { ffmpeg } = await run({ codec: "h264", format: "matroska,webm" });
    expect(proxyRuns(ffmpeg)).toHaveLength(1);
  });

  it("...and does NOT for h264 in mp4 — the rule is not just transcoding everything", async () => {
    const { ffmpeg } = await run({ codec: "h264", format: "mov,mp4,m4a,3gp,3g2,mj2" });
    expect(proxyRuns(ffmpeg)).toHaveLength(0);
  });

  it("normalizes H.264 on a failing runtime even when an old marker approved it", async () => {
    vi.mocked(highH264DecodesCorrectly).mockResolvedValue(false);
    const source = "library/a.mp4";
    const { store, fs } = await run({ codec: "h264", format: "mov,mp4" }, source, true);
    expect(await store.exists(`C:/proj/${proxyRel(source)}`)).toBe(true);
    expect(await store.exists(store.artifactPath(`proxies/${webOkName(source, false)}`))).toBe(
      false,
    );
    expect(await fs.readTextFile(`C:/proj/${source}`)).toBe("media");
  });

  it("still permits another supported codec on the same runtime", async () => {
    vi.mocked(highH264DecodesCorrectly).mockResolvedValue(false);
    const source = "library/a.mp4";
    const { store } = await run({ codec: "vp9", format: "mov,mp4" }, source);
    expect(await store.exists(`C:/proj/${proxyRel(source)}`)).toBe(false);
    expect(await store.exists(store.artifactPath(`proxies/${webOkName(source, false)}`))).toBe(
      true,
    );
  });

  it("does not disable an audio-only MP4 when High-profile video is unavailable", async () => {
    vi.mocked(highH264DecodesCorrectly).mockResolvedValue(false);
    const source = "library/audio.mp4";
    const { store, fs } = await run({ codec: "aac", format: "mov,mp4", audioOnly: true }, source);
    expect(await store.exists(`C:/proj/${proxyRel(source)}`)).toBe(false);
    expect(await store.exists(store.artifactPath(`proxies/${webOkName(source, false)}`))).toBe(
      true,
    );
    expect(await fs.readTextFile(`C:/proj/${source}`)).toBe("media");
  });

  for (const failure of ["rename", "ignored-abort"] as const) {
    it(`does not publish a proxy or approval after ${failure}`, async () => {
      vi.mocked(highH264DecodesCorrectly).mockResolvedValue(false);
      const fs = Object.assign(new MemFs(), {
        rename: async (from: string, to: string) => {
          if (failure === "rename") throw new Error("promotion refused");
          await fs.writeTextFile(to, await fs.readTextFile(from));
          fs.files.delete(from);
        },
        remove: async (file: string) => {
          fs.files.delete(file);
        },
      });
      const store = new ProjectStoreAccess("C:/proj", fs);
      const source = "library/refused.mp4";
      const abs = `C:/proj/${source}`;
      await fs.writeTextFile(abs, "original media");
      await fs.writeTextFile(store.artifactPath(`posters/${posterName(source)}`), "poster");
      const abort = new AbortController();
      const runner = {
        run: async (program: string, args: string[]) => {
          if (program === "ffprobe") {
            return {
              code: 0,
              stdout: JSON.stringify({
                format: { format_name: "mov,mp4", duration: "5" },
                streams: [{ codec_type: "video", codec_name: "h264", width: 160, height: 96 }],
              }),
              stderr: "",
            };
          }
          await fs.writeTextFile(args[args.length - 1], "rendered proxy");
          if (failure === "ignored-abort") abort.abort();
          return { code: 0, stdout: "", stderr: "" };
        },
      };
      expect(await processImportedMedia(store, runner, source, undefined, abort.signal)).toBe(
        false,
      );
      expect(await store.exists(`C:/proj/${proxyRel(source)}`)).toBe(false);
      expect(await store.exists(store.artifactPath(`proxies/${webOkName(source, false)}`))).toBe(
        false,
      );
      expect([...fs.files.keys()].filter((file) => file.includes(".tmp-"))).toEqual([]);
      expect(await fs.readTextFile(abs)).toBe("original media");
    });
  }

  it("still builds one for an undecodable CODEC in a fine container", async () => {
    const { ffmpeg } = await run({ codec: "hevc", format: "mov,mp4,m4a,3gp,3g2,mj2" });
    expect(proxyRuns(ffmpeg)).toHaveLength(1);
  });

  // Media imported by reference lives outside the project; it needs a proxy just the same.
  it("proxies media referenced from OUTSIDE the project", async () => {
    const fs = new MemFs();
    await fs.writeTextFile("D:/Recordings/screen.mp4", "media");
    const store = new ProjectStoreAccess("C:/proj", fs);
    const ffmpeg: string[][] = [];
    const runner = {
      run: async (program: string, args: string[]) => {
        if (program === "ffprobe")
          return {
            code: 0,
            stdout: JSON.stringify({
              format: { format_name: "matroska,webm" },
              streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }],
            }),
            stderr: "",
          };
        ffmpeg.push(args);
        await fs.writeTextFile(args[args.length - 1], "out");
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await processImportedMedia(store, runner, "D:/Recordings/screen.mp4");
    expect(proxyRuns(ffmpeg)).toHaveLength(1);
  });

  it("leaves non-video alone", async () => {
    const { ffmpeg } = await run({ codec: "h264", format: "wav" }, "library/a.wav");
    expect(ffmpeg).toHaveLength(0);
  });
});

// A still the WebView has no decoder for is invisible everywhere — preview, source monitor,
// timeline thumbnail — while exporting perfectly well, because ffmpeg reads it and
// createImageBitmap does not.
describe("preview proxy — stills the browser cannot decode", () => {
  /** Runs the generator over an image and reports what ffmpeg was asked to write. */
  async function image(name: string) {
    const fs = new MemFs();
    await fs.writeTextFile(`C:/proj/${name}`, "media");
    const store = new ProjectStoreAccess("C:/proj", fs);
    const written: string[] = [];
    const runner = {
      run: async (program: string, args: string[]) => {
        // A HEIF still is decoded by its owner (media/stillPicture.ts), which first asks ffprobe
        // which item is the picture. Answer as ffprobe does for a plain one: a single default stream.
        if (program === "ffprobe")
          return {
            code: 0,
            stdout: JSON.stringify({
              streams: [{ index: 0, id: "0x1", disposition: { default: 1 } }],
            }),
            stderr: "",
          };
        const out = args[args.length - 1];
        written.push(out);
        await fs.writeTextFile(out, "out");
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await processImportedMedia(store, runner, name);
    return written;
  }

  it("writes a PNG stand-in and a poster for a TIFF", async () => {
    const written = await image("library/scan.tiff");
    expect(written.some((p) => /proxies\/.*\.png$/.test(p))).toBe(true);
    expect(written.some((p) => /posters\/.*\.jpg$/.test(p))).toBe(true);
  });

  // A still's stand-in takes a moment: it raises the overlay flag (`onTranscode`) but it is not a copy of a video, so it must not ask for a "Preparing preview" row
  // (`onCopy`): a batch of 40 HEICs would flash 40 cards (found in review of UJ-091).
  it("a still's stand-in raises the overlay but is not a video copy", async () => {
    const calls: string[] = [];
    const fs = new MemFs();
    await fs.writeTextFile("C:/proj/library/scan.tiff", "media");
    const store = new ProjectStoreAccess("C:/proj", fs);
    const runner = {
      run: async (_program: string, args: string[]) => {
        await fs.writeTextFile(args[args.length - 1], "out");
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await processImportedMedia(
      store,
      runner,
      "library/scan.tiff",
      () => calls.push("overlay"),
      undefined,
      { onCopy: () => calls.push("row") },
    );
    expect(calls).toEqual(["overlay"]);
  });

  it("...and for a HEIC", async () => {
    const written = await image("library/photo.heic");
    expect(written.some((p) => /proxies\/.*\.png$/.test(p))).toBe(true);
    expect(written.some((p) => /posters\/.*\.jpg$/.test(p))).toBe(true);
  });

  // The failure direction: a PNG already draws, so generating a PNG OF a PNG is pure waste.
  it("does nothing for an image the browser already decodes", async () => {
    expect(await image("library/shot.png")).toEqual([]);
    expect(await image("library/shot.jpg")).toEqual([]);
    expect(await image("library/shot.webp")).toEqual([]);
  });
});

// Keep the fake honest: if probePath's shape changes, these tests must not keep passing.
it("the probe fixture matches what probePath actually returns", async () => {
  const { probePath } = await import("../tools/media");
  const runner = {
    run: vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        format: { format_name: "matroska,webm", duration: "5" },
        streams: [{ codec_type: "video", codec_name: "h264", width: 16, height: 9 }],
      }),
      stderr: "",
    })),
  };
  const probe = await probePath(runner, "x.mp4");
  expect(probe.format).toBe("matroska,webm");
  expect((probe.video as { codec: string }).codec).toBe("h264");
});

/** One source that needs a preview copy; ffmpeg's `-progress` blocks are fed to whoever listens. */
async function copyRun(hooks?: Parameters<typeof processImportedMedia>[5]) {
  const fs = new MemFs();
  await fs.writeTextFile("C:/proj/library/a.mp4", "media");
  const store = new ProjectStoreAccess("C:/proj", fs);
  const calls: { args: string[]; streamed: boolean }[] = [];
  const runner = {
    run: async (
      program: string,
      args: string[],
      _signal?: AbortSignal,
      _cwd?: string,
      onStdout?: (chunk: string) => void,
    ) => {
      if (program === "ffprobe")
        return {
          code: 0,
          stdout: JSON.stringify({
            format: { format_name: "matroska,webm", duration: "5" },
            streams: [{ codec_type: "video", codec_name: "hevc", width: 3840, height: 2160 }],
          }),
          stderr: "",
        };
      calls.push({ args, streamed: onStdout !== undefined });
      if (args.includes("libx264")) {
        // A block split in the middle of a line, as the app's stream delivers them.
        onStdout?.("frame=60\nfps=30\nout_time_us=250");
        onStdout?.("0000\nspeed=2.5x\nprogress=continue\n");
        onStdout?.("frame=120\nfps=30\nout_time_us=5000000\nspeed=2.4x\nprogress=end\n");
      }
      await fs.writeTextFile(args[args.length - 1], "out");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  await processImportedMedia(store, runner, "library/a.mp4", undefined, undefined, hooks);
  return calls;
}

describe("the preview copy says how far it is", () => {
  it("hands over each block ffmpeg reports, with the source's own length, even split mid-line", async () => {
    const seen: unknown[] = [];
    await copyRun({ onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([
      { outMs: 2500, totalMs: 5000, speed: 2.5, done: false },
      { outMs: 5000, totalMs: 5000, speed: 2.4, done: true },
    ]);
  });

  it("asks ffmpeg for its progress report on the copy only, never on the poster", async () => {
    const calls = await copyRun({ onProgress: () => undefined });
    const copy = calls.find((c) => c.args.includes("libx264"))!;
    const poster = calls.find((c) => !c.args.includes("libx264"))!;
    expect(copy.args.join(" ")).toContain("-nostats -progress pipe:1");
    expect(copy.streamed).toBe(true);
    expect(poster.args).not.toContain("-progress");
    expect(poster.streamed).toBe(false);
  });

  it("without a listener the command is exactly what it always was, and with one it only gains the three words, right after -loglevel error", async () => {
    const watched = (await copyRun({ onProgress: () => undefined })).find((c) =>
      c.args.includes("libx264"),
    )!;
    const plain = (await copyRun()).find((c) => c.args.includes("libx264"))!;
    expect(plain.streamed).toBe(false);
    // The literal command (the last word is the temp file, whose name differs by run).
    const COPY = [
      "-i",
      "C:/proj/library/a.mp4",
      "-vf",
      "scale=-2:'max(2,trunc(min(720,ih)/2)*2)'",
      "-c:v",
      "libx264",
      "-profile:v",
      "baseline",
      "-preset",
      "veryfast",
      "-crf",
      "24",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "15",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
    ];
    expect(plain.args.slice(0, -1)).toEqual(["-y", "-hide_banner", "-loglevel", "error", ...COPY]);
    expect(watched.args.slice(0, -1)).toEqual([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      "-progress",
      "pipe:1",
      ...COPY,
    ]);
  });

  // Attaching a listener must not change how a build ends: a copy that fails still fails (and says so), leaves no partial file, and never throws.
  it("a copy that fails with a listener attached fails exactly as without one", async () => {
    for (const listener of [true, false]) {
      const fs = new ExportMemFs(); // can rename and remove, so the copy is written to a temp file first, as on disk
      await fs.writeTextFile("C:/proj/library/a.mp4", "media");
      const store = new ProjectStoreAccess("C:/proj", fs);
      const seen: unknown[] = [];
      const runner = {
        run: async (
          program: string,
          args: string[],
          _signal?: AbortSignal,
          _cwd?: string,
          onStdout?: (chunk: string) => void,
        ) => {
          if (program === "ffprobe")
            return {
              code: 0,
              stdout: JSON.stringify({
                format: { format_name: "matroska,webm", duration: "5" },
                streams: [{ codec_type: "video", codec_name: "hevc", width: 3840, height: 2160 }],
              }),
              stderr: "",
            };
          if (args.includes("libx264")) {
            await fs.writeTextFile(args[args.length - 1], "half a file"); // the temp output ffmpeg had started
            onStdout?.("frame=60\nfps=30\nout_time_us=2000000\nspeed=2x\nprogress=continue\n");
            return { code: 1, stdout: "", stderr: "boom" };
          }
          await fs.writeTextFile(args[args.length - 1], "out");
          return { code: 0, stdout: "", stderr: "" };
        },
      };
      vi.mocked(recordMedia).mockClear();
      const changed = await processImportedMedia(
        store,
        runner,
        "library/a.mp4",
        undefined,
        undefined,
        listener ? { onProgress: (p) => seen.push(p) } : undefined,
      );
      expect(changed, "the poster was still made").toBe(true);
      expect(
        [...fs.files.keys()].filter((p) => /\/proxies\//.test(p)),
        "no copy, and no half-written one, is left behind",
      ).toEqual([]);
      expect(vi.mocked(recordMedia).mock.calls.at(-1)![0]).toMatchObject({ proxy: "failed" });
      expect(seen).toHaveLength(listener ? 1 : 0);
    }
  });
});

// Posters are produced in the background, after the clip or library tile is already drawn.
// Without an announcement the thumbnail resolves once, finds nothing, and keeps its
// placeholder for the whole session — observed on a real project with the poster sitting on
// disk beside it, 2m32s after the asset appeared.
describe("telling the UI that derived media arrived", () => {
  it("announces the poster BEFORE a long preview copy starts, and the copy when it lands", async () => {
    // Once, at the end of the job, kept a finished picture off the screen for as long as the copy took
    // (the poster was on disk 6 s after the drop and was shown 162 s later). Two announcements, in this order.
    const log: string[] = [];
    const off = onMediaDerived(() => log.push("announce"));
    try {
      const fs = new MemFs();
      await fs.writeTextFile("C:/proj/library/a.mp4", "media");
      const store = new ProjectStoreAccess("C:/proj", fs);
      const runner = {
        run: async (program: string, args: string[]) => {
          if (program === "ffprobe")
            return {
              code: 0,
              stdout: JSON.stringify({
                format: { format_name: "matroska,webm", duration: "5" },
                streams: [{ codec_type: "video", codec_name: "hevc", width: 3840, height: 2160 }],
              }),
              stderr: "",
            };
          log.push(args.includes("libx264") ? "copy" : "poster");
          await fs.writeTextFile(args[args.length - 1], "out");
          return { code: 0, stdout: "", stderr: "" };
        },
      };
      await processImportedMedia(store, runner, "library/a.mp4");
    } finally {
      off();
    }
    expect(log).toEqual(["poster", "announce", "copy", "announce"]);
  });

  it("calls the caller's hook at the same moment, so what is on screen refreshes before the copy", async () => {
    const log: string[] = [];
    const fs = new MemFs();
    await fs.writeTextFile("C:/proj/library/a.mp4", "media");
    const store = new ProjectStoreAccess("C:/proj", fs);
    const runner = {
      run: async (program: string, args: string[]) => {
        if (program === "ffprobe")
          return {
            code: 0,
            stdout: JSON.stringify({
              format: { format_name: "matroska,webm", duration: "5" },
              streams: [{ codec_type: "video", codec_name: "hevc", width: 3840, height: 2160 }],
            }),
            stderr: "",
          };
        log.push(args.includes("libx264") ? "copy" : "poster");
        await fs.writeTextFile(args[args.length - 1], "out");
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await processImportedMedia(
      store,
      runner,
      "library/a.mp4",
      () => log.push("overlay"),
      undefined,
      {
        onArtifacts: () => log.push("artifacts"),
        onCopy: () => log.push("row"),
      },
    );
    expect(log).toEqual(["poster", "artifacts", "overlay", "row", "copy"]);
  });

  it("a video that needs no copy keeps its single announcement at the end", async () => {
    let fired = 0;
    const off = onMediaDerived(() => (fired += 1));
    try {
      await run({ codec: "h264", format: "mov,mp4,m4a,3gp,3g2,mj2" });
    } finally {
      off();
    }
    expect(fired).toBe(1);
  });

  it("announces when eligibility arrives without a video proxy", async () => {
    vi.mocked(highH264DecodesCorrectly).mockResolvedValue(false);
    let fired = 0;
    const off = onMediaDerived(() => (fired += 1));
    try {
      const source = "library/audio.mp4";
      const fs = new MemFs();
      await fs.writeTextFile(`C:/proj/${source}`, "audio");
      const store = new ProjectStoreAccess("C:/proj", fs);
      await fs.writeTextFile(store.artifactPath(`posters/${posterName(source)}`), "poster");
      const runner = {
        run: async () => ({
          code: 0,
          stdout: JSON.stringify({
            format: { format_name: "mov,mp4" },
            streams: [
              { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 1 },
            ],
          }),
          stderr: "",
        }),
      };
      await processImportedMedia(store, runner, source);
      expect(await store.exists(store.artifactPath(`proxies/${webOkName(source, false)}`))).toBe(
        true,
      );
    } finally {
      off();
    }
    expect(fired).toBe(1);
  });

  // The other direction, and the one that keeps this honest: announcing unconditionally would
  // make every already-resolved thumbnail re-look on every pass over an untouched library.
  it("stays quiet when everything was already derived", async () => {
    const fs = new MemFs();
    const source = "library/a.mp4";
    await fs.writeTextFile(`C:/proj/${source}`, "media");
    const store = new ProjectStoreAccess("C:/proj", fs);
    await fs.writeTextFile(await store.prepareArtifact(`posters/${posterName(source)}`), "p");
    await fs.writeTextFile(await store.prepareArtifact(`proxies/${webOkName(source, true)}`), "");

    let fired = 0;
    const off = onMediaDerived(() => (fired += 1));
    try {
      const changed = await processImportedMedia(
        store,
        { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
        source,
      );
      expect(changed).toBe(false);
    } finally {
      off();
    }
    expect(fired).toBe(0);
  });
});
