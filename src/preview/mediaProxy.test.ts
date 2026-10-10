// A preview proxy is needed when the WebView cannot decode the source — and that is a
// question about the CONTAINER as much as the codec. mp4box parses ISOBMFF only, so
// h264-in-Matroska is undecodable here even though h264 alone is fine. The file that
// exposed this was a screen recording named ".mp4" that ffprobe reported as
// matroska,webm: a codec-only check cleared it, no proxy was built, and the preview
// silently showed nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { processImportedMedia } from "./mediaProxy";
import { highH264DecodesCorrectly } from "./h264Support";
import { onMediaDerived } from "./mediaDerived";
import { posterName, proxyKey, proxyRel, webOkName } from "./proxyPaths";
import { MemFs } from "../test/timelineKit";
import { ProjectStoreAccess } from "../tools/store";

vi.mock("./h264Support", () => ({ highH264DecodesCorrectly: vi.fn() }));
beforeEach(() => vi.mocked(highH264DecodesCorrectly).mockResolvedValue(true));

type Probe = { codec: string; format: string; audioOnly?: boolean };

/** Records the ffmpeg invocations a probe of `p` provokes. */
async function run(p: Probe, source = "library/a.mp4", legacyWebOk = false) {
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
            format: { format_name: p.format, duration: "5" },
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

// Posters are produced in the background, after the clip or library tile is already drawn.
// Without an announcement the thumbnail resolves once, finds nothing, and keeps its
// placeholder for the whole session — observed on a real project with the poster sitting on
// disk beside it, 2m32s after the asset appeared.
describe("telling the UI that derived media arrived", () => {
  it("announces when it actually produced something", async () => {
    let fired = 0;
    const off = onMediaDerived(() => (fired += 1));
    try {
      await run({ codec: "h264", format: "matroska,webm" });
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
