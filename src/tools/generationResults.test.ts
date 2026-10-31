import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { toB64 } from "../api/ai";
import {
  decodeGenerated,
  decodeImages,
  decodeMusic,
  decodeVideo,
  decodeVoiceover,
  isResultTool,
  musicScratchKeys,
  parsePcmMime,
  pcmToWav,
  RESULT_TOOLS,
} from "./generationResults";
import { joinPath, ProjectStoreAccess, type FsLike } from "./store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

class Fs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  async exists(p: string): Promise<boolean> {
    return this.files.has(joinPath(p)) || this.bytes.has(joinPath(p));
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.bytes.get(joinPath(p));
    if (!v) throw new Error("ENOENT");
    return v;
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async mkdir(): Promise<void> {}
}

const store = () => new ProjectStoreAccess("C:/proj", new Fs());
const b64 = (bytes: number[]) => toB64(new Uint8Array(bytes));

describe("which results can be brought back", () => {
  it("are exactly the four generation tools", () => {
    expect([...RESULT_TOOLS].sort()).toEqual([
      "generate_image",
      "generate_music",
      "generate_video",
      "generate_voiceover",
    ]);
    for (const tool of RESULT_TOOLS) expect(isResultTool(tool)).toBe(true);
    for (const other of ["export", "style_analyze", "voiceover", "generate", ""])
      expect(isResultTool(other)).toBe(false);
  });
});

describe("images and video", () => {
  it("keep every image in the order the provider sent them, with its extension", () => {
    const out = decodeImages({
      result: {},
      media: [
        { b64: b64([1, 2]), ext: ".png" },
        { b64: b64([3]), ext: ".jpg" },
      ],
    } as Any);
    expect(out).toEqual([
      { bytes: new Uint8Array([1, 2]), ext: ".png" },
      { bytes: new Uint8Array([3]), ext: ".jpg" },
    ]);
  });

  it("say which model returned nothing, when there are no images", () => {
    expect(() => decodeImages({ result: {} } as Any, "m1")).toThrow(
      "image generation returned no images (model=m1)",
    );
    expect(() => decodeImages({ result: {}, media: [] } as Any)).toThrow(
      "image generation returned no images",
    );
  });

  it("keep only the first video, and say when there is none", () => {
    expect(
      decodeVideo({
        result: {},
        media: [
          { b64: b64([9]), ext: ".mp4" },
          { b64: b64([8]), ext: ".mp4" },
        ],
      } as Any),
    ).toEqual([{ bytes: new Uint8Array([9]), ext: ".mp4" }]);
    expect(() => decodeVideo({ result: {} } as Any, "veo")).toThrow(
      "video generation returned no downloadable file (model=veo)",
    );
  });
});

describe("a voiceover", () => {
  it("becomes a WAV file whose header says what the audio really is", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8000, max: 96_000 }),
        fc.integer({ min: 1, max: 2 }),
        fc.uint8Array({ minLength: 0, maxLength: 64 }),
        (rate, channels, pcm) => {
          const wav = pcmToWav(pcm, rate, channels);
          const dv = new DataView(wav.buffer);
          expect(wav.length).toBe(44 + pcm.length);
          expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
          expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
          expect(dv.getUint32(4, true)).toBe(36 + pcm.length);
          expect(dv.getUint16(22, true)).toBe(channels);
          expect(dv.getUint32(24, true)).toBe(rate);
          expect(dv.getUint32(28, true)).toBe(rate * channels * 2);
          expect(dv.getUint16(32, true)).toBe(channels * 2);
          expect(dv.getUint32(40, true)).toBe(pcm.length);
          expect([...wav.slice(44)]).toEqual([...pcm]);
        },
      ),
    );
  });

  it("reads the real sample rate and channel count from the mime, and falls back to mono 24 kHz", () => {
    expect(parsePcmMime("audio/l16; rate=48000; channels=2")).toEqual([48000, 2]);
    expect(parsePcmMime("audio/l16;rate=16000")).toEqual([16000, 1]);
    expect(parsePcmMime("")).toEqual([24000, 1]);
    expect(parsePcmMime("audio/l16; rate=fast; channels=many")).toEqual([24000, 1]);
  });

  it("measures its own length from the audio, and refuses an answer with none", () => {
    const [out] = decodeVoiceover({
      result: { ok: true, pcm_b64: toB64(new Uint8Array(96_000)), mime: "audio/l16; rate=24000" },
    } as Any);
    expect(out.meta).toEqual({ duration_s: 2, sample_rate: 24000, channels: 1 });
    expect(out.ext).toBe(".wav");
    expect(() => decodeVoiceover({ result: { ok: true } } as Any)).toThrow(
      "voiceover synthesis failed",
    );
    expect(() => decodeVoiceover({ result: { ok: false, error: "tts boom" } } as Any)).toThrow(
      "tts boom",
    );
    expect(() => decodeVoiceover({} as Any)).toThrow("voiceover synthesis failed");
  });
});

describe("a music bed", () => {
  const SRC = new Uint8Array([1, 2, 3, 4]);
  const answer = {
    result: { ok: true, audio_b64: toB64(SRC), format: "wav", lyrics: "la la" },
  } as Any;

  it("is kept as it came, with the lyrics and sensible defaults, where there is no ffmpeg", async () => {
    const [out] = await decodeMusic(answer, {
      store: store(),
      runner: null,
      sourceKey: "s",
      outputKey: "o",
    });
    expect(out.bytes).toEqual(SRC);
    expect(out.meta).toEqual({ lyrics: "la la", duration_s: 0, sample_rate: 48000, channels: 2 });
  });

  it("is re-muxed and measured when there is an ffmpeg, and the source is kept if the re-mux fails", async () => {
    const fs = new Fs();
    const s = new ProjectStoreAccess("C:/proj", fs);
    const ran: string[][] = [];
    const runner = {
      run: vi.fn(async (program: string, args: string[]) => {
        ran.push([program, ...args]);
        if (program === "ffmpeg") {
          await fs.writeBytes(args[args.length - 1], new Uint8Array([7, 7, 7]));
          return { code: 0, stdout: "", stderr: "" };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            format: { duration: "2.5" },
            streams: [{ codec_type: "audio", sample_rate: "44100", channels: 1 }],
          }),
          stderr: "",
        };
      }),
    };
    const [out] = await decodeMusic(answer, {
      store: s,
      runner: runner as Any,
      sourceKey: "s",
      outputKey: "o",
    });
    expect(out.bytes).toEqual(new Uint8Array([7, 7, 7]));
    expect(ran[0].slice(0, 2)).toEqual(["ffmpeg", "-nostdin"]);

    const failing = {
      run: vi.fn(async (program: string) =>
        program === "ffmpeg"
          ? { code: 1, stdout: "", stderr: "boom" }
          : { code: 1, stdout: "", stderr: "" },
      ),
    };
    const [kept] = await decodeMusic(answer, {
      store: new ProjectStoreAccess("C:/proj", new Fs()),
      runner: failing as Any,
      sourceKey: "s",
      outputKey: "o",
    });
    expect(kept.bytes).toEqual(SRC);
  });

  it("names its scratch files from the prompt and model, so the same request reuses them", () => {
    expect(musicScratchKeys("lofi", "m")).toEqual(musicScratchKeys("lofi", "m"));
    expect(musicScratchKeys("lofi", "m").outputKey).not.toBe(
      musicScratchKeys("lofi", "other").outputKey,
    );
    expect(musicScratchKeys("lofi", "m").sourceKey).not.toBe(
      musicScratchKeys("jazz", "m").sourceKey,
    );
  });

  it("is refused when the answer has no audio", async () => {
    const env = { store: store(), runner: null, sourceKey: "s", outputKey: "o" };
    await expect(decodeMusic({ result: { ok: true } } as Any, env)).rejects.toThrow(
      "music generation failed",
    );
    await expect(
      decodeMusic({ result: { ok: false, error: "no quota" } } as Any, env),
    ).rejects.toThrow("no quota");
  });
});

describe("bringing a result back by its order", () => {
  const dto = {
    generate_image: { result: { ok: true }, media: [{ b64: b64([1]), ext: ".png" }] },
    generate_video: { result: { ok: true }, media: [{ b64: b64([2]), ext: ".mp4" }] },
    generate_voiceover: { result: { ok: true, pcm_b64: toB64(new Uint8Array(4)) } },
    generate_music: { result: { ok: true, audio_b64: b64([4]), format: "wav" } },
  } as const;

  it.each(RESULT_TOOLS)(
    "turns the answer of %s into media with the same decoder the tool uses",
    async (tool) => {
      const [out] = await decodeGenerated(tool, dto[tool] as Any, {
        store: store(),
        runner: null,
        orderId: "0123456789abcdef",
      });
      expect(out.bytes.length).toBeGreaterThan(0);
      expect(out.ext).toBe(
        tool === "generate_image" ? ".png" : tool === "generate_video" ? ".mp4" : ".wav",
      );
    },
  );

  // What separates the image decoder from the video one is how many outputs they keep: a batch of images must not lose all but the
  // first because the answer was brought back after a restart.
  it("keeps every image of a batch, and only the first video", async () => {
    const env = { store: store(), runner: null, orderId: "0123456789abcdef" };
    const two = {
      result: { ok: true },
      media: [
        { b64: b64([1]), ext: ".png" },
        { b64: b64([2]), ext: ".png" },
      ],
    } as Any;
    expect((await decodeGenerated("generate_image", two, env)).map((o) => [...o.bytes])).toEqual([
      [1],
      [2],
    ]);
    expect((await decodeGenerated("generate_video", two, env)).map((o) => [...o.bytes])).toEqual([
      [1],
    ]);
  });

  it("fails the way the tool does for an answer with nothing in it, whichever tool asked", async () => {
    const env = { store: store(), runner: null, orderId: "0123456789abcdef" };
    const empty = { result: { ok: true } } as Any;
    await expect(decodeGenerated("generate_image", empty, env)).rejects.toThrow(
      "image generation returned no images",
    );
    await expect(decodeGenerated("generate_video", empty, env)).rejects.toThrow(
      "video generation returned no downloadable file",
    );
    await expect(decodeGenerated("generate_voiceover", empty, env)).rejects.toThrow(
      "voiceover synthesis failed",
    );
    await expect(decodeGenerated("generate_music", empty, env)).rejects.toThrow(
      "music generation failed",
    );
  });

  it("keeps the scratch files of two orders apart, and of one order the same", async () => {
    const fs = new Fs();
    const s = new ProjectStoreAccess("C:/proj", fs);
    const A = "aaaaaaaaaaaaaaaa";
    const B = "bbbbbbbbbbbbbbbb";
    const written = () => [...fs.bytes.keys()].filter((p) => p.includes("music_")).sort();
    await decodeGenerated("generate_music", dto.generate_music as Any, {
      store: s,
      runner: null,
      orderId: A,
    });
    const afterA = written();
    await decodeGenerated("generate_music", dto.generate_music as Any, {
      store: s,
      runner: null,
      orderId: A,
    });
    expect(written()).toEqual(afterA);
    await decodeGenerated("generate_music", dto.generate_music as Any, {
      store: s,
      runner: null,
      orderId: B,
    });
    expect(written().length).toBe(afterA.length * 2);
  });
});
