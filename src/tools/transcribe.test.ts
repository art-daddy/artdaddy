import { describe, expect, it, vi } from "vitest";

import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import {
  clipWordFrames,
  ensureTranscript,
  ensureWhisperModel,
  fmtTimestamp,
  fmtTimestampPrecise,
  getTranscriptTool,
  parseWhisperCppJson,
  warmWhisperModel,
  whisperModelPath,
} from "./transcribe";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  touch(p: string): void {
    this.files.set(joinPath(p), "");
  }
  putBytes(p: string, b: Uint8Array): void {
    this.bytes.set(joinPath(p), b);
  }
  async exists(p: string): Promise<boolean> {
    const n = joinPath(p);
    return this.files.has(n) || this.bytes.has(n);
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
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeBytes(p: string, data: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), data);
  }
  async mkdir(): Promise<void> {}
}

/** fs with no binary write, to exercise the warm no-op guard. */
class TextOnlyFs implements FsLike {
  async exists(): Promise<boolean> {
    return false;
  }
  async readTextFile(): Promise<string> {
    throw new Error("ENOENT");
  }
  async writeTextFile(): Promise<void> {}
  async mkdir(): Promise<void> {}
}

const DIR = "C:/data/projects/p1";
const MODEL = "C:/data/models/ggml-small.bin";

function ctxWith(runner: CommandRunner, fs: MockFs = new MockFs()): ClientToolContext {
  return { store: new ProjectStoreAccess(DIR, fs), runner };
}

const WHISPER_JSON = JSON.stringify({
  result: { language: "en" },
  transcription: [
    {
      offsets: { from: 0, to: 1200 },
      text: " Hello world",
      tokens: [
        { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 0 },
        { text: " Hello", offsets: { from: 0, to: 600 }, p: 0.9 },
        { text: " world", offsets: { from: 600, to: 1200 }, p: 0.8 },
      ],
    },
    {
      offsets: { from: 1200, to: 2000 },
      text: " Bye",
      tokens: [{ text: " Bye", offsets: { from: 1200, to: 2000 }, p: 0.95 }],
    },
  ],
});

interface RunnerOpts {
  failConv?: boolean;
  failWhisper?: boolean;
  json?: string;
}
function transcribeRunner(fs: MockFs, opts: RunnerOpts = {}): CommandRunner {
  return {
    run: vi.fn(async (program: string, args: string[]) => {
      if (program === "ffmpeg") {
        if (opts.failConv) return { code: 1, stdout: "", stderr: "conv boom" };
        fs.touch(args[args.length - 1]);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (program === "whisper-cli") {
        if (opts.failWhisper) return { code: 1, stdout: "", stderr: "whisper boom" };
        const outBase = args[args.indexOf("-of") + 1];
        await fs.writeTextFile(`${outBase}.json`, opts.json ?? WHISPER_JSON);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }),
  };
}

describe("timestamp formatting", () => {
  it("formats HH:MM:SS and HH:MM:SS.mmm", () => {
    expect(fmtTimestamp(0)).toBe("00:00:00");
    expect(fmtTimestamp(3661)).toBe("01:01:01");
    expect(fmtTimestampPrecise(1.234)).toBe("00:00:01.234");
    expect(fmtTimestampPrecise(-5)).toBe("00:00:00.000"); // clamped
    expect(fmtTimestampPrecise(0.9999)).toBe("00:00:01.000"); // ms carry
  });
});

describe("whisperModelPath", () => {
  it("resolves the model under <data_root>/models", () => {
    expect(whisperModelPath(DIR, "base")).toBe("C:/data/models/ggml-base.bin");
    expect(whisperModelPath(DIR, "small")).toBe(MODEL);
  });
});

describe("parseWhisperCppJson", () => {
  it("reconstructs words from BPE tokens and drops special tokens", () => {
    const t = parseWhisperCppJson(WHISPER_JSON);
    expect(t.language).toBe("en");
    expect(t.duration_seconds).toBe(2);
    expect(t.segments).toHaveLength(2);
    expect(t.words).toHaveLength(3);
    expect(t.words.map((w) => w.word)).toEqual(["Hello", "world", "Bye"]);
    expect(t.words[0]).toMatchObject({
      start_seconds: 0,
      end_seconds: 0.6,
      probability: 0.9,
      segment_id: 1,
    });
    expect(t.words[0].start_timestamp).toBe("00:00:00.000");
    expect(t.segments[0]).toMatchObject({
      text: "Hello world",
      start_timestamp: "00:00:00",
      end_timestamp: "00:00:01",
    });
    expect(t.segments[0].words).toHaveLength(2);
    expect(t.words[2]).toMatchObject({ word: "Bye", segment_id: 2, index_in_segment: 0 });
  });

  it("falls back to a single word when a segment has no tokens", () => {
    const t = parseWhisperCppJson(
      JSON.stringify({
        result: { language: "es" },
        transcription: [{ offsets: { from: 0, to: 1000 }, text: " Solo" }],
      }),
    );
    expect(t.words).toHaveLength(1);
    expect(t.words[0].word).toBe("Solo");
    expect(t.segments[0].text).toBe("Solo");
  });

  it("skips empty segments", () => {
    const t = parseWhisperCppJson(
      JSON.stringify({ transcription: [{ offsets: { from: 0, to: 5 }, text: "   " }] }),
    );
    expect(t.segments).toHaveLength(0);
    expect(t.language).toBeNull();
  });
});

describe("ensureWhisperModel", () => {
  it("returns the existing model without downloading", async () => {
    const fs = new MockFs();
    fs.putBytes(MODEL, new Uint8Array([1, 2, 3]));
    const fetchSpy = vi.fn();
    const r = await ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "small", fetchSpy as Any);
    expect(r).toEqual({ path: MODEL, downloaded: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("downloads + writes the model when absent", async () => {
    const fs = new MockFs();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([9, 9]).buffer,
    }));
    const r = await ensureWhisperModel(
      ctxWith(transcribeRunner(fs), fs),
      "small",
      fetchImpl as Any,
    );
    expect(r.downloaded).toBe(true);
    expect(await fs.exists(MODEL)).toBe(true);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("ggml-small.bin");
  });

  it("throws on an HTTP error", async () => {
    const fs = new MockFs();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await expect(
      ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "base", fetchImpl as Any),
    ).rejects.toThrow("404");
  });

  it("throws on an empty download", async () => {
    const fs = new MockFs();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await expect(
      ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "base", fetchImpl as Any),
    ).rejects.toThrow("empty");
  });
});

describe("warmWhisperModel", () => {
  it("is a no-op when the fs cannot write bytes", async () => {
    const ctx: ClientToolContext = {
      store: new ProjectStoreAccess(DIR, new TextOnlyFs()),
      runner: transcribeRunner(new MockFs()),
    };
    await expect(warmWhisperModel(ctx)).resolves.toBeUndefined();
  });

  it("does not throw when the model is already present", async () => {
    const fs = new MockFs();
    fs.putBytes(MODEL, new Uint8Array([1]));
    await expect(warmWhisperModel(ctxWith(transcribeRunner(fs), fs))).resolves.toBeUndefined();
  });
});

describe("clipWordFrames", () => {
  const words = [
    { word: "a", start_seconds: 0, end_seconds: 0.4 },
    { word: "b", start_seconds: 0.6, end_seconds: 0.9 },
    { word: "c", start_seconds: 1.2, end_seconds: 1.5 },
  ];
  it("maps source seconds -> project frames through timeline_in + trim (1x)", () => {
    // fps 30, source_in 0, timeline_in 100: a@0->100, b@0.6s(18f)->118, c@1.2s(36f)->136
    expect(
      clipWordFrames(words, { source_in: 0, source_out: 60, timeline_in: 100, speed: 1 }, 30),
    ).toEqual([
      ["a", 100, 112],
      ["b", 118, 127],
      ["c", 136, 145],
    ]);
  });
  it("drops words outside the clip's visible source span", () => {
    // source_in 20 (0.667s) .. source_out 40 (1.333s): only c (36f) is inside -> 100 + (36-20) = 116
    expect(
      clipWordFrames(words, { source_in: 20, source_out: 40, timeline_in: 100, speed: 1 }, 30),
    ).toEqual([["c", 116, 120]]);
  });
  it("compresses by speed (2x -> half the frames from the trim point)", () => {
    expect(
      clipWordFrames(words, { source_in: 0, source_out: 60, timeline_in: 0, speed: 2 }, 30),
    ).toEqual([
      ["a", 0, 6],
      ["b", 9, 14],
      ["c", 18, 23],
    ]);
  });

  // The reason end frames exist at all: "remove the silences" is unanswerable without them.
  it("makes the silence between words measurable, and it survives a speed change", () => {
    const gaps = (rows: Array<[string, number, number]>) =>
      rows.slice(1).map((r, i) => r[1] - rows[i][2]);

    const at1x = clipWordFrames(
      words,
      { source_in: 0, source_out: 60, timeline_in: 0, speed: 1 },
      30,
    );
    const at2x = clipWordFrames(
      words,
      { source_in: 0, source_out: 60, timeline_in: 0, speed: 2 },
      30,
    );

    // a ends 0.4s, b starts 0.6s -> 0.2s of silence = 6 frames; b->c is 0.3s = 9 frames.
    expect(gaps(at1x)).toEqual([6, 9]);
    // Played twice as fast the same silences are half as long, and still positive.
    expect(gaps(at2x)).toEqual([3, 4]);
    expect(gaps(at1x).every((g) => g > 0)).toBe(true);
  });

  it("clips a word's end to the cut, so a gap is never measured against inaudible audio", () => {
    // "c" runs 1.2s-1.5s (36f-45f) but the clip ends at source_out 40 — reporting 45 would
    // describe audio the viewer never hears, and any gap after it would be understated.
    const rows = clipWordFrames(
      words,
      { source_in: 0, source_out: 40, timeline_in: 0, speed: 1 },
      30,
    );
    expect(rows.at(-1)).toEqual(["c", 36, 40]);
  });

  it("never reports an end before its own start when the source has no end time", () => {
    const noEnds = [{ word: "a", start_seconds: 1 }];
    expect(
      clipWordFrames(noEnds, { source_in: 0, source_out: 60, timeline_in: 0, speed: 1 }, 30),
    ).toEqual([["a", 30, 30]]);
  });
});

describe("ensureTranscript", () => {
  it("transcribes to a canonical path, then reuses it (no re-transcription)", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "audio.mp4"));
    fs.putBytes(MODEL, new Uint8Array([1]));
    const ctx = ctxWith(transcribeRunner(fs), fs);
    const first = await ensureTranscript(ctx, "audio.mp4");
    expect(first.existed).toBe(false);
    expect(first.parsed.words.map((w) => w.word)).toEqual(["Hello", "world", "Bye"]);
    const again = await ensureTranscript(ctx, "audio.mp4");
    expect(again.existed).toBe(true);
    expect(again.path).toBe(first.path);
  });
  it("honors an explicit output path", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "audio.mp4"));
    fs.putBytes(MODEL, new Uint8Array([1]));
    const r = await ensureTranscript(
      ctxWith(transcribeRunner(fs), fs),
      "audio.mp4",
      "small",
      "custom/t.json",
    );
    expect(String(r.path)).toContain("custom/t.json");
  });
  it("throws on missing media", async () => {
    const fs = new MockFs();
    fs.putBytes(MODEL, new Uint8Array([1]));
    await expect(
      ensureTranscript(ctxWith(transcribeRunner(fs), fs), "missing.mp4"),
    ).rejects.toThrow(/not found/);
  });
  it("surfaces an audio-extraction failure", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "audio.mp4"));
    fs.putBytes(MODEL, new Uint8Array([1]));
    await expect(
      ensureTranscript(ctxWith(transcribeRunner(fs, { failConv: true }), fs), "audio.mp4"),
    ).rejects.toThrow(/audio extraction failed/);
  });
  it("surfaces a whisper-cli failure", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "audio.mp4"));
    fs.putBytes(MODEL, new Uint8Array([1]));
    await expect(
      ensureTranscript(ctxWith(transcribeRunner(fs, { failWhisper: true }), fs), "audio.mp4"),
    ).rejects.toThrow(/whisper-cli failed/);
  });
});

describe("getTranscriptTool (timeline transcript)", () => {
  it("errors without a context", async () => {
    expect(((await getTranscriptTool({}, null)) as Any).ok).toBe(false);
  });

  it("errors when there is no timeline", async () => {
    const fs = new MockFs();
    expect(((await getTranscriptTool({}, ctxWith(transcribeRunner(fs), fs))) as Any).ok).toBe(
      false,
    );
  });

  it("walks the audio clips and maps words to project frames", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "audio.mp4"));
    fs.putBytes(MODEL, new Uint8Array([1]));
    await fs.writeTextFile(
      joinPath(DIR, "internals", "timeline.json"),
      JSON.stringify({
        canvas: { width: 1080, height: 1920, fps: 30 },
        tracks: [
          {
            id: "a1",
            kind: "audio",
            clips: [
              {
                id: "c1",
                media_ref: "audio.mp4",
                source_in: 0,
                source_out: 60,
                timeline_in: 100,
                timeline_out: 160,
              },
            ],
          },
        ],
      }),
    );
    const r = (await getTranscriptTool({}, ctxWith(transcribeRunner(fs), fs))) as Any;
    expect(r.ok).toBe(true);
    expect(r.timing).toBe("project_frames");
    expect(r.word_count).toBe(3);
    expect(r.clips).toHaveLength(1);
    expect(r.clips[0]).toMatchObject({ clip_id: "c1", track_id: "a1" });
    expect(r.clips[0].words).toEqual([
      [0, "Hello", 100, 118],
      [1, "world", 118, 136],
      [2, "Bye", 136, 160], // 1.2s-2.0s, clamped to the clip's source_out of 60f
    ]);
  });

  // Regression: a broken transcriber used to be REPORTED AS SILENCE. get_transcript
  // caught every ensureTranscript error and `continue`d, so a whisper binary that
  // could not run returned ok:true with zero words — and the model told the user
  // their footage had no speech. Shipped exactly that way (a deprecation shim was
  // staged as whisper-cli), and nothing in the product said otherwise.
  const timelineWith = (ids: string[]) =>
    JSON.stringify({
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "a1",
          kind: "audio",
          clips: ids.map((id, i) => ({
            id,
            media_ref: `${id}.mp4`,
            source_in: 0,
            source_out: 60,
            timeline_in: 100 + i * 100,
            timeline_out: 160 + i * 100,
          })),
        },
      ],
    });

  it("FAILS instead of reporting silence when transcription is broken", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "c1.mp4"));
    fs.putBytes(MODEL, new Uint8Array([1]));
    await fs.writeTextFile(joinPath(DIR, "internals", "timeline.json"), timelineWith(["c1"]));

    const r = (await getTranscriptTool(
      {},
      ctxWith(transcribeRunner(fs, { failWhisper: true }), fs),
    )) as Any;

    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/NOT an absence of speech/i);
    expect(String(r.error)).toMatch(/whisper-cli failed/);
    expect(r.failed).toHaveLength(1);
    // The give-away of the old behaviour: a successful, empty transcript.
    expect(r.word_count).toBeUndefined();
  });

  it("still returns the clips it COULD transcribe, and names the ones it could not", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "c1.mp4")); // transcribes
    fs.putBytes(MODEL, new Uint8Array([1]));
    // c2.mp4 is absent -> ensureTranscript throws "not found" for that clip only.
    await fs.writeTextFile(joinPath(DIR, "internals", "timeline.json"), timelineWith(["c1", "c2"]));

    const r = (await getTranscriptTool({}, ctxWith(transcribeRunner(fs), fs))) as Any;

    expect(r.ok).toBe(true); // a partial result is still useful
    expect(r.clips).toHaveLength(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].clip_id).toBe("c2");
  });
});
