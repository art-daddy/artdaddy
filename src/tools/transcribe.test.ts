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
  WHISPER_MODELS,
  type WhisperModelSpec,
  whisperModelPath,
} from "./transcribe";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  modelMetadata = new Map<string, { size: number; sha256: string }>();
  appended: number[] = [];
  touch(p: string): void {
    this.files.set(joinPath(p), "");
  }
  putBytes(p: string, b: Uint8Array): void {
    const n = joinPath(p);
    this.bytes.set(n, b.slice());
    this.modelMetadata.delete(n);
  }
  putModel(p = MODEL): void {
    const spec = WHISPER_MODELS.small;
    this.bytes.set(joinPath(p), new Uint8Array([1]));
    this.modelMetadata.set(joinPath(p), { size: spec.bytes, sha256: spec.sha256 });
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
    this.putBytes(p, data);
  }
  async appendBytes(p: string, data: Uint8Array): Promise<void> {
    const n = joinPath(p);
    const previous = this.bytes.get(n) ?? new Uint8Array();
    const next = new Uint8Array(previous.length + data.length);
    next.set(previous);
    next.set(data, previous.length);
    this.bytes.set(n, next);
    this.appended.push(data.length);
  }
  async stat(p: string): Promise<{ isDirectory: boolean; size: number }> {
    const n = joinPath(p);
    const model = this.modelMetadata.get(n);
    if (model) return { isDirectory: false, size: model.size };
    const bytes = this.bytes.get(n);
    if (bytes) return { isDirectory: false, size: bytes.length };
    if (this.files.has(n)) return { isDirectory: false, size: this.files.get(n)!.length };
    throw new Error("ENOENT");
  }
  async probeMedia(p: string, headBytes: number) {
    const n = joinPath(p);
    const bytes = this.bytes.get(n);
    if (!bytes) throw new Error("ENOENT");
    const model = this.modelMetadata.get(n);
    const sha256 = model?.sha256 ?? (await sha256Of(bytes));
    return {
      id12: sha256.slice(0, 12),
      sha256,
      size: model?.size ?? bytes.length,
      head: bytes.slice(0, headBytes),
    };
  }
  async remove(p: string): Promise<void> {
    const n = joinPath(p);
    this.files.delete(n);
    this.bytes.delete(n);
    this.modelMetadata.delete(n);
  }
  async rename(from: string, to: string): Promise<void> {
    const src = joinPath(from);
    const dst = joinPath(to);
    const bytes = this.bytes.get(src);
    if (!bytes) throw new Error("ENOENT");
    this.bytes.set(dst, bytes);
    this.bytes.delete(src);
    const metadata = this.modelMetadata.get(src);
    if (metadata) this.modelMetadata.set(dst, metadata);
    this.modelMetadata.delete(src);
  }
  async mkdir(): Promise<void> {}
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function specFor(bytes: Uint8Array): Promise<WhisperModelSpec> {
  return { revision: "test-revision", bytes: bytes.length, sha256: await sha256Of(bytes) };
}

function streamedResponse(
  chunks: Uint8Array[],
  opts: {
    status?: number;
    declaredBytes?: number;
    onDone?: () => void;
    onCancel?: () => void;
  } = {},
): Response {
  let at = 0;
  return {
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    headers: new Headers(
      opts.declaredBytes === undefined
        ? undefined
        : { "content-length": String(opts.declaredBytes) },
    ),
    body: {
      getReader: () => ({
        read: async () => {
          if (at < chunks.length) return { done: false, value: chunks[at++] };
          opts.onDone?.();
          return { done: true, value: undefined };
        },
        cancel: async () => opts.onCancel?.(),
        releaseLock: () => undefined,
      }),
    },
    arrayBuffer: async () => {
      throw new Error("whole-buffer model read");
    },
  } as unknown as Response;
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
    const bytes = new Uint8Array([1, 2, 3]);
    fs.putBytes(MODEL, bytes);
    const spec = await specFor(bytes);
    const fetchSpy = vi.fn();
    const r = await ensureWhisperModel(
      ctxWith(transcribeRunner(fs), fs),
      "small",
      fetchSpy as Any,
      spec,
    );
    expect(r).toEqual({ path: MODEL, downloaded: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("streams the model to a temp file, validates it, and atomically promotes it", async () => {
    const fs = new MockFs();
    const chunks = [new Uint8Array([9, 9]), new Uint8Array([8, 7, 6])];
    const bytes = new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
    const spec = await specFor(bytes);
    const fetchImpl = vi.fn(async () => streamedResponse(chunks, { declaredBytes: bytes.length }));
    const r = await ensureWhisperModel(
      ctxWith(transcribeRunner(fs), fs),
      "small",
      fetchImpl as Any,
      spec,
    );
    expect(r).toEqual({ path: MODEL, downloaded: true });
    expect(fs.bytes.get(MODEL)).toEqual(bytes);
    expect(fs.appended).toEqual([2, 3]);
    expect([...fs.bytes.keys()].filter((path) => path.endsWith(".part"))).toEqual([]);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/test-revision/ggml-small.bin",
    );
  });

  it("throws on an HTTP error", async () => {
    const fs = new MockFs();
    const spec = await specFor(new Uint8Array([1]));
    const fetchImpl = vi.fn(async () => streamedResponse([], { status: 404 }));
    await expect(
      ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "small", fetchImpl as Any, spec),
    ).rejects.toThrow("404");
  });

  it("removes an incomplete download without exposing a final model", async () => {
    const fs = new MockFs();
    const spec = await specFor(new Uint8Array([1, 2, 3]));
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array([1])]));
    await expect(
      ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "small", fetchImpl as Any, spec),
    ).rejects.toThrow("incomplete");
    expect(await fs.exists(MODEL)).toBe(false);
    expect([...fs.bytes.keys()].filter((path) => path.endsWith(".part"))).toEqual([]);
  });

  it("replaces a same-size cached model whose checksum is wrong", async () => {
    const fs = new MockFs();
    const wanted = new Uint8Array([4, 5, 6]);
    const spec = await specFor(wanted);
    fs.putBytes(MODEL, new Uint8Array([6, 5, 4]));
    const fetchImpl = vi.fn(async () => streamedResponse([wanted]));

    await ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "small", fetchImpl as Any, spec);

    expect(fs.bytes.get(MODEL)).toEqual(wanted);
  });

  it("keeps the previous cached model when its replacement cannot be downloaded", async () => {
    const fs = new MockFs();
    const previous = new Uint8Array([6, 5, 4]);
    const wanted = new Uint8Array([4, 5, 6]);
    const spec = await specFor(wanted);
    fs.putBytes(MODEL, previous);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("offline");
    });

    await expect(
      ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "small", fetchImpl as Any, spec),
    ).rejects.toThrow("offline");
    expect(fs.bytes.get(MODEL)).toEqual(previous);
  });

  it("cancels an oversized response body and removes its temp file", async () => {
    const fs = new MockFs();
    const spec = await specFor(new Uint8Array([1]));
    let cancelled = false;
    const fetchImpl = vi.fn(async () =>
      streamedResponse([new Uint8Array([1, 2])], {
        onCancel: () => {
          cancelled = true;
        },
      }),
    );

    await expect(
      ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "small", fetchImpl as Any, spec),
    ).rejects.toThrow("exceeded");
    expect(cancelled).toBe(true);
    expect(await fs.exists(MODEL)).toBe(false);
    expect([...fs.bytes.keys()].filter((path) => path.endsWith(".part"))).toEqual([]);
  });

  it("joins concurrent callers into one download and one final model", async () => {
    const fs = new MockFs();
    const bytes = new Uint8Array([2, 4, 6, 8]);
    const spec = await specFor(bytes);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return streamedResponse([bytes]);
    });
    const ctx = ctxWith(transcribeRunner(fs), fs);

    const first = ensureWhisperModel(ctx, "small", fetchImpl as Any, spec);
    const second = ensureWhisperModel(ctx, "small", fetchImpl as Any, spec);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { path: MODEL, downloaded: true },
      { path: MODEL, downloaded: true },
    ]);
    expect(fs.bytes.get(MODEL)).toEqual(bytes);
  });

  it("does not promote when cancellation arrives after the final chunk", async () => {
    const fs = new MockFs();
    const bytes = new Uint8Array([3, 1, 4]);
    const spec = await specFor(bytes);
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () =>
      streamedResponse([bytes], { onDone: () => controller.abort() }),
    );
    const ctx = { ...ctxWith(transcribeRunner(fs), fs), signal: controller.signal };

    await expect(ensureWhisperModel(ctx, "small", fetchImpl as Any, spec)).rejects.toThrow(
      "cancelled",
    );
    expect(await fs.exists(MODEL)).toBe(false);
    expect([...fs.bytes.keys()].filter((path) => path.endsWith(".part"))).toEqual([]);
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
    fs.putModel();
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
    fs.putModel();
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
    fs.putModel();
    await expect(
      ensureTranscript(ctxWith(transcribeRunner(fs), fs), "missing.mp4"),
    ).rejects.toThrow(/not found/);
  });
  it("surfaces an audio-extraction failure", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "audio.mp4"));
    fs.putModel();
    await expect(
      ensureTranscript(ctxWith(transcribeRunner(fs, { failConv: true }), fs), "audio.mp4"),
    ).rejects.toThrow(/audio extraction failed/);
  });
  it("surfaces a whisper-cli failure", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "audio.mp4"));
    fs.putModel();
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
    fs.putModel();
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
    fs.putModel();
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
    fs.putModel();
    // c2.mp4 is absent -> ensureTranscript throws "not found" for that clip only.
    await fs.writeTextFile(joinPath(DIR, "internals", "timeline.json"), timelineWith(["c1", "c2"]));

    const r = (await getTranscriptTool({}, ctxWith(transcribeRunner(fs), fs))) as Any;

    expect(r.ok).toBe(true); // a partial result is still useful
    expect(r.clips).toHaveLength(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].clip_id).toBe("c2");
  });
});
