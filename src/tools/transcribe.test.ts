import { readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What a finished run says about its backend and speed goes out as a usage sample (4i part 4).
const { reportTranscription } = vi.hoisted(() => ({ reportTranscription: vi.fn() }));
vi.mock("../api/appEvents", async (orig) => ({ ...(await orig<object>()), reportTranscription }));

import type { CommandRunner } from "./command";
import { _resetAppCaches } from "./appCache";
import type { ClientToolContext } from "./context";
import { __resetJobSupervisor, __setJobSupervisor } from "./jobSupervisor";
import { FakeJobs } from "../test/fakeJobs";
import { shortHash as shortHashOf } from "./media";
import {
  ProjectStoreAccess,
  joinPath,
  markProjectDirDead,
  reviveProjectDir,
  type FsLike,
} from "./store";
import { useModelDownload } from "../store/modelDownload";
import { isExpected } from "../lib/errors";
import {
  clipWordFrames,
  ensureTranscript,
  ensureWhisperModel,
  fmtTimestamp,
  fmtTimestampPrecise,
  getTranscriptTool,
  isSpeechEngineUnavailable,
  normLanguage,
  parseWhisperCppJson,
  peekTranscript,
  runWhisper,
  TRANSCRIPT_WAIT_MS,
  transcriptCacheSlot,
  WHISPER_MODELS,
  type WhisperModelSpec,
  whisperModelPath,
} from "./transcribe";
import { registerBackgroundTranscriber } from "./transcriptQueue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  modelMetadata = new Map<string, { size: number; sha256: string }>();
  appended: number[] = [];
  /** When each path was last written: a second apart, as a clock the file identity can read. */
  written = new Map<string, number>();
  private clock = 1_700_000_000_000;
  private stamp(n: string): void {
    this.clock += 1000;
    this.written.set(n, this.clock);
  }
  touch(p: string): void {
    this.files.set(joinPath(p), "");
    this.stamp(joinPath(p));
  }
  putBytes(p: string, b: Uint8Array): void {
    const n = joinPath(p);
    this.bytes.set(n, b.slice());
    this.modelMetadata.delete(n);
    this.stamp(n);
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
    this.stamp(joinPath(p));
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
  async stat(p: string): Promise<{ isDirectory: boolean; size: number; mtimeMs?: number }> {
    const n = joinPath(p);
    const mtimeMs = this.written.get(n) ?? 0;
    const model = this.modelMetadata.get(n);
    if (model) return { isDirectory: false, size: model.size, mtimeMs };
    const bytes = this.bytes.get(n);
    if (bytes) return { isDirectory: false, size: bytes.length, mtimeMs };
    if (this.files.has(n)) return { isDirectory: false, size: this.files.get(n)!.length, mtimeMs };
    throw new Error("ENOENT");
  }
  async cacheDir(): Promise<string> {
    return "C:/cache/app";
  }
  async workDir(): Promise<string> {
    return WORK;
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
    // A rename moves whatever is there, like the real one: the WAV extracts are written by a fake
    // ffmpeg as (empty) text entries, the model as bytes.
    const text = this.files.get(src);
    const written = this.written.get(src);
    if (written !== undefined) this.written.set(dst, written); // a move keeps the file's time
    this.written.delete(src);
    if (text !== undefined) {
      this.files.set(dst, text);
      this.files.delete(src);
      return;
    }
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
/** The app's work folder, outside every project: whisper's scratch goes there (4i). */
const WORK = "C:/work/app";

/** The part file is keyed by CONTENT, so a part left by a previous pinned revision can never
 *  be resumed into a different one. */
function partFor(spec: WhisperModelSpec): string {
  return `${MODEL}.${spec.sha256.slice(0, 12)}.part`;
}

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
  /** Simulate a process that never started (Windows resolves imports before any code runs). */
  whisperExit?: number;
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
        if (opts.whisperExit !== undefined)
          return { code: opts.whisperExit, stdout: "", stderr: "" };
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

// whisper writes sounds it hears as subtitle annotations. The forms below are real: 176 whisper
// outputs cached on the dev machine held "(eerie music)" x82, "(camera shutter clicks)" x72,
// "[Music]" x56, "[BLANK_AUDIO]", "[MUSIC PLAYING]"... and the Hindi clip of UJ-004 came back
// "[NON-ENGLISH SPEECH]" under the English default. As words they reach every caption.
describe("whisper's sound annotations are not words (UJ-004)", () => {
  type Tok = [text: string, fromMs: number, toMs: number];
  const seg = (text: string, toks: Tok[]) => ({
    offsets: { from: toks[0]?.[1] ?? 0, to: toks.at(-1)?.[2] ?? 0 },
    text,
    tokens: toks.map(([t, from, to]) => ({ text: t, offsets: { from, to }, p: 0.9 })),
  });
  const parse = (...segs: unknown[]) =>
    parseWhisperCppJson(JSON.stringify({ result: { language: "en" }, transcription: segs }));

  it("keeps the speech around an annotation, with its own timing, and the sentence whole", () => {
    // whisper's BPE splits an annotation over several tokens, spaces included.
    const t = parse(
      seg(" (eerie music) Hello there", [
        [" (", 0, 100],
        ["e", 100, 200],
        ["erie", 200, 500],
        [" music", 500, 900],
        [")", 900, 1000],
        [" Hello", 1000, 2000],
        [" there", 2000, 3000],
      ]),
    );
    expect(t.words.map((w) => w.word)).toEqual(["Hello", "there"]);
    expect([t.words[0].start_seconds, t.words[0].end_seconds]).toEqual([1, 2]);
    expect(t.words.map((w) => w.index_in_segment)).toEqual([0, 1]);
    // The sentence keeps it: a reader still sees where the music is.
    expect(t.segments[0].text).toBe("(eerie music) Hello there");
  });

  it("gives a segment that is only an annotation no words at all", () => {
    const t = parse(
      seg(" [Music]", [
        [" [", 0, 100],
        ["Music", 100, 1900],
        ["]", 1900, 2000],
      ]),
      seg(" [NON-ENGLISH SPEECH]", [
        [" [", 2000, 2100],
        ["NON", 2100, 2400],
        ["-", 2400, 2500],
        ["ENGLISH", 2500, 3000],
        [" SPEECH", 3000, 3800],
        ["]", 3800, 4000],
      ]),
    );
    expect(t.words).toEqual([]);
    expect(t.segments.map((s) => [s.text, s.words.length])).toEqual([
      ["[Music]", 0],
      ["[NON-ENGLISH SPEECH]", 0],
    ]);
  });

  it("drops what an annotation leaves behind, and keeps the word before it", () => {
    const t = parse(
      seg(" Bye [BLANK_AUDIO].", [
        [" Bye", 0, 500],
        [" [", 500, 600],
        ["BL", 600, 700],
        ["ANK", 700, 800],
        ["_", 800, 850],
        ["AUDIO", 850, 950],
        ["].", 950, 1000],
      ]),
      seg(" Ha(laughs)ha", [
        [" Ha", 1000, 1200],
        ["(", 1200, 1250],
        ["laugh", 1250, 1400],
        ["s", 1400, 1450],
        [")", 1450, 1500],
        ["ha", 1500, 1700],
      ]),
    );
    expect(t.words.map((w) => w.word)).toEqual(["Bye", "Ha", "ha"]);
  });

  it("keeps speech that merely contains a bracket that never closes", () => {
    const t = parse(
      seg(" well (and then", [
        [" well", 0, 300],
        [" (", 300, 350],
        ["and", 350, 600],
        [" then", 600, 900],
      ]),
    );
    expect(t.words.map((w) => w.word)).toEqual(["well", "(and", "then"]);
  });

  it("keeps ordinary punctuation words", () => {
    const t = parse(
      seg(" well -- right", [
        [" well", 0, 300],
        [" --", 300, 350],
        [" right", 350, 900],
      ]),
    );
    expect(t.words.map((w) => w.word)).toEqual(["well", "--", "right"]);
  });

  it("gives an untokenised annotation-only segment no word, and an untokenised one its speech", () => {
    const t = parseWhisperCppJson(
      JSON.stringify({
        transcription: [
          { offsets: { from: 0, to: 1000 }, text: " (upbeat music)" },
          { offsets: { from: 1000, to: 2000 }, text: " [Music] Danke (laughs)" },
        ],
      }),
    );
    expect(t.words.map((w) => w.word)).toEqual(["Danke"]);
    expect(t.segments).toHaveLength(2);
  });

  it("joins an untokenised segment's speech with single spaces where annotations were", () => {
    const t = parseWhisperCppJson(
      JSON.stringify({
        transcription: [
          { offsets: { from: 0, to: 1000 }, text: " Hallo[Music]Albi" },
          { offsets: { from: 1000, to: 2000 }, text: " [Music]  Danke (laughs)  schön" },
          // No offsets at all, and only special or blank tokens: the text is still the speech.
          { text: " Grüezi", tokens: [{ text: "[_BEG_]" }, { text: "  " }, { text: "[_TT_50]" }] },
        ],
      }),
    );
    expect(t.words.map((w) => [w.word, w.probability])).toEqual([
      ["Hallo Albi", 0],
      ["Danke schön", 0],
      ["Grüezi", 0],
    ]);
  });

  it("numbers the words it keeps without gaps, and times each from its own tokens", () => {
    const t = parseWhisperCppJson(
      JSON.stringify({
        transcription: [
          {
            offsets: { from: 0, to: 4000 },
            text: " Hello (sigh)World (x)ok",
            tokens: [
              { text: " Hel", offsets: { from: 0, to: 400 }, p: 0.8 },
              { text: "l", offsets: { from: 400, to: 600 } }, // no probability: not counted
              { text: "o", offsets: { from: 600, to: 900 }, p: 0.6 },
              { text: " (", offsets: { from: 900, to: 1000 }, p: 0.1 },
              { text: "sigh", offsets: { from: 1000, to: 2000 }, p: 0.1 },
              { text: ")", offsets: { from: 2000, to: 2500 }, p: 0.1 },
              // Glued to the annotation: the word starts at ITS time, not the annotation's.
              { text: "World", offsets: { from: 2500, to: 3000 }, p: 0.6 },
              { text: " (x)ok", offsets: { from: 3000, to: 4000 } },
            ],
          },
        ],
      }),
    );
    expect(t.words.map((w) => w.word)).toEqual(["Hello", "World", "ok"]);
    expect(t.words.map((w) => w.word_id)).toEqual([1, 2, 3]);
    expect(t.words.map((w) => [w.start_timestamp, w.end_timestamp])).toEqual([
      ["00:00:00.000", "00:00:00.900"],
      ["00:00:02.500", "00:00:03.000"],
      ["00:00:03.000", "00:00:04.000"],
    ]);
    const [hello, world, ok] = t.words.map((w) => w.probability);
    expect(hello).toBeCloseTo(0.7, 9); // the mean of its scored tokens
    expect([world, ok]).toEqual([0.6, 0]);
  });

  it("ends the word before an annotation that shares a token with the next one", () => {
    const t = parse(
      seg(" Ha(x)ha", [
        [" Ha", 0, 500],
        ["(x)ha", 500, 900],
      ]),
      // A whole annotation in one token, the next word glued on: that word starts at its own time.
      seg(" (x)World", [
        [" (x)", 1000, 1500],
        ["World", 1500, 1900],
      ]),
    );
    expect(t.words.map((w) => [w.word, w.start_seconds])).toEqual([
      ["Ha", 0],
      ["ha", 0.5],
      ["World", 1.5],
    ]);
  });

  it("property: the words are exactly what was said, around any annotations", () => {
    // Speech in Latin and Devanagari (the UJ-004 clip) and annotations of either bracket kind,
    // each word cut into BPE-like pieces with the space at the front, as whisper's tokens are.
    const spoken = fc
      .array(fc.constantFrom(..."abcxyzÄöüßéñएकआदमी"), { minLength: 1, maxLength: 6 })
      .map((cs) => cs.join(""));
    const item = fc.oneof(
      spoken.map((w) => ({ said: true, words: [w] })),
      fc
        .tuple(
          fc.constantFrom(["(", ")"], ["[", "]"]),
          fc.array(spoken, { minLength: 1, maxLength: 3 }),
        )
        .map(([[o, c], ws]) => ({ said: false, words: [`${o}${ws.join(" ")}${c}`] })),
    );
    fc.assert(
      fc.property(
        fc.array(item, { minLength: 1, maxLength: 8 }),
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 5 }),
        (items, cuts) => {
          const toks: Tok[] = [];
          let k = 0;
          for (const entry of items) {
            for (const w of entry.words.join(" ").split(" ")) {
              const piece = ` ${w}`;
              for (let i = 0; i < piece.length;) {
                const n = i === 0 ? 1 + cuts[k++ % cuts.length] : cuts[k++ % cuts.length];
                toks.push([piece.slice(i, i + n), toks.length * 10, toks.length * 10 + 10]);
                i += n;
              }
            }
          }
          const text = items.map((e) => ` ${e.words.join(" ")}`).join("");
          const got = parse(seg(text, toks)).words.map((w) => w.word);
          expect(got).toEqual(items.filter((e) => e.said).map((e) => e.words[0]));
        },
      ),
      { numRuns: 400 },
    );
  });
});

// Japanese, Chinese and Thai are written without spaces between words, and whisper's tokens carry
// none there either, so the space rule made each SENTENCE one word: a real 60 s Japanese clip came
// back as 5 "words" — a caption per sentence, and nothing a word edit could cut inside (UJ-004).
describe("speech written without spaces is cut into words (UJ-004)", () => {
  /** One token per piece, 100 ms each, the way whisper's tokens for these scripts look. */
  const parseTokens = (pieces: string[], start = 0) =>
    parseWhisperCppJson(
      JSON.stringify({
        result: { language: "ja" },
        transcription: [
          {
            offsets: { from: start, to: start + pieces.length * 100 },
            text: pieces.join(""),
            tokens: pieces.map((text, i) => ({
              text,
              offsets: { from: start + i * 100, to: start + (i + 1) * 100 },
              p: 0.5,
            })),
          },
        ],
      }),
    );

  it("cuts Japanese at its words, each timed from its own tokens, punctuation kept on the word", () => {
    // Real tokens from the clip: |ベ|ル|リ|ン|オ|リ|ンピ|ック|...
    const t = parseTokens([
      "ベ",
      "ル",
      "リ",
      "ン",
      "オ",
      "リ",
      "ンピ",
      "ック",
      "に",
      "出",
      "場",
      "した",
      "。",
    ]);
    expect(t.words.map((w) => [w.word, w.start_seconds, w.end_seconds])).toEqual([
      ["ベルリン", 0, 0.4],
      ["オリンピック", 0.4, 0.8],
      ["に", 0.8, 0.9],
      ["出場", 0.9, 1.1],
      ["した。", 1.1, 1.3],
    ]);
    expect(t.words.map((w) => w.word_id)).toEqual([1, 2, 3, 4, 5]);
    expect(t.segments[0].text).toBe("ベルリンオリンピックに出場した。"); // the sentence is unchanged
  });

  it("cuts Chinese too, and leaves languages that write spaces as whisper spaced them", () => {
    expect(parseTokens([..."我们今天去北京，好吗？"]).words.map((w) => w.word)).toEqual([
      "我们",
      "今天",
      "去",
      "北京，",
      "好",
      "吗？",
    ]);
    // Thai has no spaces between words, but whisper spaces its phrases, which is how it is written.
    expect(parseTokens([" สวัส", "ดี", "ครับ"]).words.map((w) => w.word)).toEqual(["สวัสดีครับ"]);
    // Hindi is written with spaces: its words stay exactly as before.
    expect(parseTokens([" एक", " आ", "द", "म", "ी", ","]).words.map((w) => w.word)).toEqual([
      "एक",
      "आदमी,",
    ]);
  });

  it("property: nothing said is dropped or invented, and the words run forward in time", () => {
    const pool = [..."日本語の文章を書きますオリンピック北京我们好吗。、！？ 1914年abc"];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...pool), { minLength: 1, maxLength: 40 }),
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 4 }),
        (chars, sizes) => {
          const text = chars.join("");
          const pieces: string[] = [];
          for (let i = 0, k = 0; i < text.length; k++) {
            const n = sizes[k % sizes.length];
            pieces.push(text.slice(i, i + n));
            i += n;
          }
          const t = parseTokens(pieces);
          const squash = (s: string) => s.replace(/\s+/g, "");
          expect(squash(t.words.map((w) => w.word).join(""))).toBe(squash(text));
          for (const [a, b] of t.words.slice(1).map((w, i) => [t.words[i], w]))
            expect(b.start_seconds).toBeGreaterThanOrEqual(a.start_seconds);
          for (const w of t.words) expect(w.end_seconds).toBeGreaterThanOrEqual(w.start_seconds);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("language: none means detect, never whisper's English default (UJ-004)", () => {
  const SRC = "C:/media/rede.mp4";
  const whisperArgs = (runner: CommandRunner): string[][] =>
    (runner.run as Any).mock.calls
      .filter((c: Any[]) => c[0] === "whisper-cli")
      .map((c: Any[]) => c[1]);
  const langOf = (args: string[]): string | undefined => {
    const i = args.indexOf("-l");
    return i >= 0 ? args[i + 1] : undefined;
  };
  // What the code BEFORE this fix wrote for a request with no language: keyed on src|size alone,
  // made with whisper's English default. Frozen here as history, not derived from the code.
  const LEGACY_DEFAULT_KEY = (src: string) => `transcribe/${shortHashOf(`${src}|small`)}.json`;

  it("keeps the queue's identity of 'no language' one value, however it is written", () => {
    // The background queue keys a job by this: two spellings of "detect" must not make two jobs.
    for (const none of [undefined, null, "", "  ", "auto", " AUTO "])
      expect(normLanguage(none)).toBe("");
    expect(normLanguage(" ES ")).toBe("es");
    expect(normLanguage("de-CH")).toBe("de");
    expect(normLanguage("zh_Hans")).toBe("zh");
  });

  it("keeps each distinct request's transcript apart, and one request however it is spelled", async () => {
    const fs = new MockFs();
    fs.putModel();
    const OTHER = "C:/media/other.mp4";
    fs.touch(SRC);
    fs.touch(OTHER);
    const runner = transcribeRunner(fs);
    const ctx = ctxWith(runner, fs);
    await runWhisper(ctx, SRC);
    await runWhisper(ctx, OTHER);
    await runWhisper(ctx, SRC, "small", "es");
    expect(whisperArgs(runner)).toHaveLength(3);
    // One request, however it is spelled: none and "auto", a region and its language, either slash.
    await runWhisper(ctx, SRC, "small", "auto");
    await runWhisper(ctx, SRC, "small", "es-MX");
    await runWhisper(ctx, SRC.replace(/\//g, "\\"));
    expect(whisperArgs(runner)).toHaveLength(3);
  });

  it("asks whisper to detect the language when none is given", async () => {
    const fs = new MockFs();
    fs.putModel();
    fs.touch(SRC);
    const runner = transcribeRunner(fs);
    await runWhisper(ctxWith(runner, fs), SRC);
    expect(whisperArgs(runner).map(langOf)).toEqual(["auto"]);
  });

  it("treats 'auto' and no language as one request", async () => {
    const fs = new MockFs();
    fs.putModel();
    fs.touch(SRC);
    const runner = transcribeRunner(fs);
    const ctx = ctxWith(runner, fs);
    await runWhisper(ctx, SRC);
    await runWhisper(ctx, SRC, "small", "AUTO");
    expect(whisperArgs(runner)).toHaveLength(1);
  });

  it("gives whisper the language of a regional code, and shares that language's transcript", async () => {
    const fs = new MockFs();
    fs.putModel();
    fs.touch(SRC);
    const runner = transcribeRunner(fs);
    const ctx = ctxWith(runner, fs);
    await runWhisper(ctx, SRC, "small", "de-CH");
    await runWhisper(ctx, SRC, "small", "de");
    await runWhisper(ctx, SRC, "small", "pt_BR");
    expect(whisperArgs(runner).map(langOf)).toEqual(["de", "pt"]);
  });

  it("never serves a transcript made under the English default as a detected one", async () => {
    const fs = new MockFs();
    fs.putModel();
    fs.touch(SRC);
    const english = JSON.stringify({
      result: { language: "en" },
      transcription: [
        { offsets: { from: 0, to: 900 }, text: " Hallo Albi", tokens: [{ text: " Hallo Albi" }] },
      ],
    });
    const detected = JSON.stringify({
      result: { language: "de" },
      transcription: [
        {
          offsets: { from: 0, to: 900 },
          text: " Hallo Albi",
          tokens: [{ text: " Hallo" }, { text: " Albi" }],
        },
      ],
    });
    const runner = transcribeRunner(fs, { json: detected });
    const ctx = ctxWith(runner, fs);
    const legacy = await ctx.store.prepareArtifact(LEGACY_DEFAULT_KEY(SRC));
    await fs.writeTextFile(legacy, english);
    const t = await runWhisper(ctx, SRC);
    expect(t.language).toBe("de");
    expect(whisperArgs(runner).map(langOf)).toEqual(["auto"]);
    // ...and peeking (inspect_media's cache check) agrees: it was not answered from the old file.
    expect((await peekTranscript(ctx, SRC))?.language).toBe("de");
  });

  it("serves a transcript made in a named language to the next ask in that language", async () => {
    const fs = new MockFs();
    fs.putModel();
    fs.touch(SRC);
    const runner = transcribeRunner(fs, {
      json: JSON.stringify({ result: { language: "es" }, transcription: [] }),
    });
    const ctx = ctxWith(runner, fs);
    await runWhisper(ctx, SRC, "small", "es");
    expect((await runWhisper(ctx, SRC, "small", "es")).language).toBe("es");
    expect(whisperArgs(runner)).toHaveLength(1);
  });

  // Transcripts used to live in the project (4f moved them to the app cache). What an older
  // version left there was made under whisper's English default for "no language", so it is never
  // read: the next ask makes the transcript again, as decided for UJ-004 and the cache move.
  it("never reads a transcript an older version left in the project", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "library/rede.mp4"));
    fs.putModel();
    const runner = transcribeRunner(fs);
    const ctx = ctxWith(runner, fs);
    // The old canonical file for "no language": hash(ref|size), English words in it.
    const old = await ctx.store.prepareArtifact(
      `transcripts/${shortHashOf("library/rede.mp4|small")}.json`,
    );
    await fs.writeTextFile(
      old,
      JSON.stringify({ transcription: { language: "en", words: [{ word: "stale" }] } }),
    );
    const r = await ensureTranscript(ctx, "library/rede.mp4");
    expect(r.existed).toBe(false);
    expect(r.parsed.words.map((w) => w.word)).not.toContain("stale");
    expect(whisperArgs(runner).map(langOf)).toEqual(["auto"]);
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

  it("keeps an incomplete download so the next attempt can resume it", async () => {
    const fs = new MockFs();
    const spec = await specFor(new Uint8Array([1, 2, 3]));
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array([1])]));
    await expect(
      ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "small", fetchImpl as Any, spec),
    ).rejects.toThrow("incomplete");
    expect(await fs.exists(MODEL)).toBe(false);
    // Discarding this prefix is what made every interrupted install restart from zero.
    expect(fs.bytes.get(partFor(spec))).toEqual(new Uint8Array([1]));
  });

  it("resumes from the bytes already on disk instead of downloading them again", async () => {
    const fs = new MockFs();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const spec = await specFor(bytes);
    fs.putBytes(partFor(spec), bytes.slice(0, 4)); // an earlier attempt got 4 of 6
    const ranges: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      ranges.push((init?.headers as Record<string, string> | undefined)?.Range);
      return streamedResponse([bytes.slice(4)], { status: 206, declaredBytes: 2 });
    });

    const r = await ensureWhisperModel(
      ctxWith(transcribeRunner(fs), fs),
      "small",
      fetchImpl as Any,
      spec,
    );

    expect(ranges).toEqual(["bytes=4-"]);
    expect(fs.appended, "only the missing tail may be fetched").toEqual([2]);
    expect(r).toEqual({ path: MODEL, downloaded: true });
    expect(fs.bytes.get(MODEL)).toEqual(bytes);
  });

  // A server free to ignore Range answers 200 with the WHOLE file. Appending that to the part
  // would concatenate two copies and leave the checksum as the only thing catching it.
  it("starts over when the server ignores the range instead of concatenating", async () => {
    const fs = new MockFs();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const spec = await specFor(bytes);
    fs.putBytes(partFor(spec), bytes.slice(0, 4));
    const fetchImpl = vi.fn(async () =>
      streamedResponse([bytes], { status: 200, declaredBytes: bytes.length }),
    );

    await ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "small", fetchImpl as Any, spec);

    expect(fs.bytes.get(MODEL)).toEqual(bytes);
  });

  it("discards the partial file when the server cannot satisfy the range", async () => {
    const fs = new MockFs();
    const bytes = new Uint8Array([1, 2, 3]);
    const spec = await specFor(bytes);
    fs.putBytes(partFor(spec), new Uint8Array([9, 9]));
    const fetchImpl = vi.fn(async () => streamedResponse([], { status: 416 }));

    await expect(
      ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "small", fetchImpl as Any, spec),
    ).rejects.toThrow("resume");
    expect(await fs.exists(partFor(spec))).toBe(false);
  });

  // The one failure a resume must NOT survive: these bytes are proven wrong, so keeping them
  // would make every future attempt download the tail and fail the same checksum forever.
  it("discards a complete download whose checksum is wrong", async () => {
    const fs = new MockFs();
    const spec = await specFor(new Uint8Array([4, 5, 6]));
    const fetchImpl = vi.fn(async () =>
      streamedResponse([new Uint8Array([9, 9, 9])], { declaredBytes: 3 }),
    );

    await expect(
      ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "small", fetchImpl as Any, spec),
    ).rejects.toThrow("checksum");
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

    // Named, sized and resumable. "transcription cancelled" described work that never started.
    await expect(ensureWhisperModel(ctx, "small", fetchImpl as Any, spec)).rejects.toThrow(
      /speech model download cancelled at \d+% of \d+ MB/,
    );
    expect(await fs.exists(MODEL)).toBe(false);
    expect(fs.bytes.get(partFor(spec))).toEqual(bytes);
  });

  // The background indexer and a caption request share ONE download. A project switch
  // cancelling the indexer used to reject the user's request too, and blame the user for it.
  it("lets one waiter cancel without cancelling the download the others need", async () => {
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
    const leaving = new AbortController();

    const abandoned = ensureWhisperModel(
      { ...ctx, signal: leaving.signal },
      "small",
      fetchImpl as Any,
      spec,
    );
    const waiting = ensureWhisperModel(ctx, "small", fetchImpl as Any, spec);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    leaving.abort();
    await expect(abandoned).rejects.toThrow(/speech model download cancelled/);
    release();

    await expect(waiting).resolves.toEqual({ path: MODEL, downloaded: true });
    expect(fs.bytes.get(MODEL)).toEqual(bytes);
  });

  it("publishes moving progress while downloading and clears it afterwards", async () => {
    const fs = new MockFs();
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const spec = await specFor(bytes);
    const seen: Array<[number, number]> = [];
    const stop = useModelDownload.subscribe((s) => seen.push([s.received, s.total]));
    try {
      const fetchImpl = vi.fn(async () => streamedResponse(chunks, { declaredBytes: 4 }));
      await ensureWhisperModel(ctxWith(transcribeRunner(fs), fs), "small", fetchImpl as Any, spec);
    } finally {
      stop();
    }

    // Two DIFFERENT points, or a frozen readout would pass just as well as a live one.
    expect(seen).toContainEqual([0, 4]);
    expect(seen).toContainEqual([4, 4]);
    expect(seen.at(-1), "the readout must not outlive the download").toEqual([0, 0]);
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

describe("runWhisper on a window (UJ-012)", () => {
  const SRC = "C:/media/talk.mp4";
  const calls = (runner: CommandRunner, program: string): string[][] =>
    (runner.run as Any).mock.calls.filter((c: Any[]) => c[0] === program).map((c: Any[]) => c[1]);

  // Extracting all of a 2-hour file to transcribe 30 seconds of it was most of that wait.
  it("reads only the window's audio when the whole file's extract is not on disk", async () => {
    const fs = new MockFs();
    fs.putModel();
    fs.touch(SRC);
    const runner = transcribeRunner(fs);
    const t = await runWhisper(ctxWith(runner, fs), SRC, "small", undefined, {
      start: 60,
      end: 90,
    });
    const [extract] = calls(runner, "ffmpeg");
    expect(extract.slice(0, extract.indexOf("-i"))).toEqual(
      expect.arrayContaining(["-ss", "60.000", "-to", "90.000"]),
    );
    const [whisper] = calls(runner, "whisper-cli");
    expect(whisper).not.toContain("-ot"); // the WAV IS the window
    expect(whisper).not.toContain("-d");
    // whisper counted from the window's start; the transcript is on the SOURCE timeline.
    expect(t.segments.map((s) => [s.start_seconds, s.end_seconds])).toEqual([
      [60, 61.2],
      [61.2, 62],
    ]);
    expect(t.words.map((w) => w.start_seconds)).toEqual([60, 60.6, 61.2]);
  });

  it("cuts the window from the whole file's extract while a run of the whole file holds it", async () => {
    const fs = new MockFs();
    fs.putModel();
    fs.touch(SRC);
    const runner = transcribeRunner(fs);
    const run = runner.run as ReturnType<typeof vi.fn>;
    const inner = run.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const wholeRunning = new Promise<void>((r) => (started = r));
    run.mockImplementation(async (program: string, args: string[]) => {
      // The French run of the whole file: whisper reads its extract until released.
      if (program === "whisper-cli" && args[args.indexOf("-l") + 1] === "fr") {
        started();
        await gate;
      }
      return inner(program, args);
    });
    const ctx = ctxWith(runner, fs);
    // The indexer's run of the whole file (a look's whisper would wait for another look's).
    const whole = runWhisper({ ...ctx, background: true }, SRC, "small", "fr");
    await wholeRunning;
    const t = await runWhisper(ctx, SRC, "small", undefined, { start: 60, end: 90 });
    const [wholeExtract, cut] = calls(runner, "ffmpeg");
    // The window is read from that extract, not decoded from the source again...
    expect(cut[cut.indexOf("-i") + 1]).not.toBe(SRC);
    expect(cut[cut.indexOf("-i") + 1]).toBe(
      `${wholeExtract.at(-1)!.replace(/\.[a-z0-9]+\.tmp\.wav$/, "")}.wav`,
    );
    // ...and whisper is handed only the window, never the whole extract with an offset.
    const second = calls(runner, "whisper-cli")[1];
    expect(second).not.toContain("-ot");
    expect(t.segments[0].start_seconds).toBe(60);
    release();
    await whole;
  });

  it("never hands a window's transcript out as the whole file's", async () => {
    const fs = new MockFs();
    fs.putModel();
    fs.touch(SRC);
    const ctx = ctxWith(transcribeRunner(fs), fs);
    expect(await peekTranscript(ctx, SRC)).toBeNull();
    await runWhisper(ctx, SRC, "small", undefined, { start: 60, end: 90 });
    expect(await peekTranscript(ctx, SRC)).toBeNull();
    expect(
      (await peekTranscript(ctx, SRC, "small", undefined, { start: 60, end: 90 }))?.segments,
    ).toHaveLength(2);
    // ...while the whole file's answers every window, without running anything.
    await runWhisper(ctx, SRC, "small");
    const runs = ((ctx.runner.run as Any).mock.calls as Any[]).length;
    expect(
      await peekTranscript(ctx, SRC, "small", undefined, { start: 300, end: 330 }),
    ).not.toBeNull();
    expect(((ctx.runner.run as Any).mock.calls as Any[]).length).toBe(runs);
  });
});

// 4i: whisper's 16 kHz audio and its raw output are scratch in the app's work folder, so a run that
// outlives its project's close never writes into the project; and none of it outlives the runs.
describe("whisper's scratch, outside every project (4i)", () => {
  const SRC = "C:/media/talk.mp4";
  const onDisk = (fs: MockFs): string[] => [...fs.files.keys(), ...fs.bytes.keys()];
  const under = (fs: MockFs, dir: string): string[] =>
    onDisk(fs).filter((p) => p.startsWith(`${dir}/`));
  const argsOf = (runner: CommandRunner, program: string): string[][] =>
    (runner.run as Any).mock.calls.filter((c: Any[]) => c[0] === program).map((c: Any[]) => c[1]);
  /** The published name of the extract the first ffmpeg run wrote. */
  const firstExtract = (runner: CommandRunner): string =>
    `${argsOf(runner, "ffmpeg")[0]
      .at(-1)!
      .replace(/\.[a-z0-9]+\.tmp\.wav$/, "")}.wav`;
  /** A runner whose whisper runs in `held` languages wait until released, one release each. */
  function gated(fs: MockFs, held: string[]) {
    const runner = transcribeRunner(fs);
    const run = runner.run as ReturnType<typeof vi.fn>;
    const inner = run.getMockImplementation()!;
    const waiting = new Map<string, () => void>();
    run.mockImplementation(async (program: string, args: string[]) => {
      const lang = args[args.indexOf("-l") + 1];
      if (program === "whisper-cli" && held.includes(lang))
        await new Promise<void>((r) => waiting.set(lang, r));
      return inner(program, args);
    });
    const until = async (lang: string): Promise<void> => {
      for (let i = 0; i < 200 && !waiting.has(lang); i++)
        await new Promise((r) => setTimeout(r, 1));
      expect(waiting.has(lang)).toBe(true);
    };
    const release = (lang: string): void => {
      waiting.get(lang)!();
      waiting.delete(lang);
    };
    return { runner, until, release };
  }

  it("reads and writes only in the work folder, never in the project, and leaves nothing there", async () => {
    for (const window of [null, { start: 60, end: 90 }]) {
      _resetAppCaches(); // each pass is its own install: nothing kept from the last
      const fs = new MockFs();
      fs.putModel();
      fs.touch(SRC);
      const runner = transcribeRunner(fs);
      const t = await runWhisper(ctxWith(runner, fs), SRC, "small", undefined, window);
      expect(t.words.map((w) => w.word)).toEqual(["Hello", "world", "Bye"]);
      const [extract] = argsOf(runner, "ffmpeg");
      const [whisper] = argsOf(runner, "whisper-cli");
      const touched = [
        extract.at(-1)!,
        whisper[whisper.indexOf("-f") + 1],
        whisper[whisper.indexOf("-of") + 1],
      ];
      for (const p of touched) expect(p.startsWith(`${WORK}/`), p).toBe(true);
      expect(under(fs, DIR)).toEqual([]);
      expect(under(fs, WORK)).toEqual([]);
      expect(under(fs, "C:/cache/app/transcripts")).toHaveLength(1);
    }
  });

  it("leaves nothing in the work folder when the extraction or whisper fails, or Stop ends it", async () => {
    const stopped = (fs: MockFs): { runner: CommandRunner; signal: AbortSignal } => {
      const ac = new AbortController();
      const inner = transcribeRunner(fs);
      return {
        signal: ac.signal,
        runner: {
          run: vi.fn(async (program: string, args: string[]) => {
            if (program !== "whisper-cli") return inner.run(program, args);
            await fs.writeTextFile(`${args[args.indexOf("-of") + 1]}.json`, "{");
            ac.abort();
            return { code: -1, stdout: "", stderr: "" };
          }),
        },
      };
    };
    const cases: Array<[string, (fs: MockFs) => { runner: CommandRunner; signal?: AbortSignal }]> =
      [
        ["extraction fails", (fs) => ({ runner: transcribeRunner(fs, { failConv: true }) })],
        ["whisper fails", (fs) => ({ runner: transcribeRunner(fs, { failWhisper: true }) })],
        ["whisper writes nonsense", (fs) => ({ runner: transcribeRunner(fs, { json: "{" }) })],
        ["Stop", stopped],
      ];
    for (const [name, make] of cases) {
      for (const window of [null, { start: 60, end: 90 }]) {
        _resetAppCaches();
        const fs = new MockFs();
        fs.putModel();
        fs.touch(SRC);
        const { runner, signal } = make(fs);
        const ctx = { ...ctxWith(runner, fs), signal };
        await expect(runWhisper(ctx, SRC, "small", undefined, window), name).rejects.toThrow();
        expect(under(fs, WORK), `${name}, window ${!!window}`).toEqual([]);
        expect(under(fs, DIR), name).toEqual([]);
      }
    }
  });

  it("never deletes an extract a run is reading, and deletes it when the last run holding it ends", async () => {
    // The indexer's whole-file run (French) holds its extract while whisper reads it; a look's
    // window cuts from it.
    for (const wholeEndsFirst of [false, true]) {
      _resetAppCaches();
      const fs = new MockFs();
      fs.putModel();
      fs.touch(SRC);
      const g = gated(fs, wholeEndsFirst ? ["fr", "auto"] : ["fr"]);
      const ctx = ctxWith(g.runner, fs);
      const whole = runWhisper({ ...ctx, background: true }, SRC, "small", "fr");
      await g.until("fr");
      const extract = firstExtract(g.runner);
      const window = runWhisper(ctx, SRC, "small", undefined, { start: 60, end: 90 });
      if (wholeEndsFirst) {
        await g.until("auto");
        g.release("fr");
        await whole;
        // The window's whisper is still running on audio cut from it: the extract stays...
        expect(await fs.exists(extract)).toBe(true);
        g.release("auto");
        await window;
      } else {
        await window;
        // The whole file's whisper is still reading it.
        expect(await fs.exists(extract)).toBe(true);
        g.release("fr");
        await whole;
      }
      // ...and goes with the last run that held it, with every other extract.
      expect(await fs.exists(extract)).toBe(false);
      expect(under(fs, WORK)).toEqual([]);
      const [, cut] = argsOf(g.runner, "ffmpeg");
      expect(cut[cut.indexOf("-i") + 1]).toBe(extract);
    }
  });

  it("extracts a file's audio once for two runs of it that need it at the same time", async () => {
    _resetAppCaches();
    const fs = new MockFs();
    fs.putModel();
    fs.touch(SRC);
    const g = gated(fs, ["fr"]);
    const ctx = ctxWith(g.runner, fs);
    const french = runWhisper({ ...ctx, background: true }, SRC, "small", "fr");
    await g.until("fr");
    // The German transcript of the same file reads the extract the French run holds.
    await runWhisper(ctx, SRC, "small", "de");
    expect(argsOf(g.runner, "ffmpeg")).toHaveLength(1);
    expect(argsOf(g.runner, "whisper-cli").map((a) => a[a.indexOf("-f") + 1])).toEqual([
      firstExtract(g.runner),
      firstExtract(g.runner),
    ]);
    g.release("fr");
    await french;
    expect(under(fs, WORK)).toEqual([]);
  });

  // 4i: a look's whisper runs at once, one look at a time; the indexer's took its turn already.
  it("runs looks' whispers one at a time, and the indexer's beside them", async () => {
    _resetAppCaches();
    const fs = new MockFs();
    fs.putModel();
    fs.touch(SRC);
    const g = gated(fs, ["fr", "de"]);
    const ctx = ctxWith(g.runner, fs);
    const whispers = () => argsOf(g.runner, "whisper-cli").map((a) => a[a.indexOf("-l") + 1]);
    const french = runWhisper(ctx, SRC, "small", "fr");
    await g.until("fr");
    const german = runWhisper(ctx, SRC, "small", "de");
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
    expect(whispers()).toEqual(["fr"]); // the second look waits for the first
    const indexer = await runWhisper({ ...ctx, background: true }, SRC, "small", "es");
    expect(indexer.words.map((w) => w.word)).toEqual(["Hello", "world", "Bye"]);
    expect(whispers()).toEqual(["fr", "es"]);
    g.release("fr");
    await french;
    await g.until("de");
    g.release("de");
    await german;
    expect(whispers()).toEqual(["fr", "es", "de"]);
    expect(under(fs, WORK)).toEqual([]);
  });

  it("answers a look stopped while it waits for its whisper at once, and runs nothing for it", async () => {
    _resetAppCaches();
    const fs = new MockFs();
    fs.putModel();
    fs.touch(SRC);
    const g = gated(fs, ["fr"]);
    const ctx = ctxWith(g.runner, fs);
    const french = runWhisper(ctx, SRC, "small", "fr");
    await g.until("fr");
    const stop = new AbortController();
    const german = runWhisper({ ...ctx, signal: stop.signal }, SRC, "small", "de");
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
    stop.abort();
    await expect(german).rejects.toThrow(/transcription cancelled/);
    expect(argsOf(g.runner, "whisper-cli")).toHaveLength(1);
    g.release("fr");
    await french;
    expect(argsOf(g.runner, "whisper-cli")).toHaveLength(1);
    expect(under(fs, WORK)).toEqual([]);
  });
});

// 4i part 3: in the app, whisper is a job of the app process, so a crash of the page neither stops
// it nor loses its words. The next page finishes it, and nothing asks for it twice.
describe("whisper as a job of the app process (4i)", () => {
  /** Each test's own file: a page that "dies" here leaves its run joinable in this module for good,
   *  so a file shared between tests would join it and never run. */
  let SRC = "";
  let files = 0;
  const under = (fs: MockFs, dir: string): string[] =>
    [...fs.files.keys(), ...fs.bytes.keys()].filter((p) => p.startsWith(`${dir}/`));
  const words = (t: { words: Array<{ word: string }> }): string[] => t.words.map((w) => w.word);
  async function until(pred: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !pred(); i++) await new Promise((r) => setTimeout(r, 1));
    expect(pred()).toBe(true);
  }
  /** The process writes its transcript and exits (or fails without one). */
  async function finish(fs: MockFs, jobs: FakeJobs, id: string, code = 0): Promise<void> {
    const spec = jobs.submitted.find((s) => s.id === id)!;
    if (code === 0)
      await fs.writeTextFile(`${spec.args[spec.args.indexOf("-of") + 1]}.json`, WHISPER_JSON);
    jobs.exit(id, code, code === 0 ? VULKAN_STDERR : "whisper boom");
  }
  function disk(): MockFs {
    _resetAppCaches();
    SRC = `C:/media/adopt-${++files}.mp4`;
    const fs = new MockFs();
    fs.putModel();
    fs.touch(SRC);
    return fs;
  }
  /** The page after a crash: every module fresh, the app process (and its jobs) the same. */
  async function nextPage(fs: MockFs, jobs: FakeJobs) {
    jobs.pageDied();
    vi.resetModules();
    const [transcribe, supervisor, gate, store, cache] = await Promise.all([
      import("./transcribe"),
      import("./jobSupervisor"),
      import("./workGate"),
      import("./store"),
      import("./appCache"),
    ]);
    supervisor.__setJobSupervisor(jobs);
    const ctx = { store: new store.ProjectStoreAccess(DIR, fs), runner: transcribeRunner(fs) };
    const io = {
      exists: (p: string) => fs.exists(p),
      readText: (p: string) => fs.readTextFile(p),
      remove: (p: string) => fs.remove(p),
      appCache: () => cache.appCacheFor(fs),
    };
    return { transcribe, gate, ctx, io };
  }

  afterEach(() => __resetJobSupervisor());

  /** What the shipped whisper printed on a Vulkan run (__fixtures__/whisper). */
  const VULKAN_STDERR = readFileSync(
    path.join(__dirname, "__fixtures__", "whisper", "vulkan.stderr.txt"),
    "utf8",
  );
  const VULKAN_RUN = { backend: "vulkan", audioSeconds: 171562 / 16000, wallSeconds: 2.72378 };
  beforeEach(() => reportTranscription.mockClear());

  it("runs whisper as a job of the app process, keeps its words, and lets the job go", async () => {
    const fs = disk();
    const jobs = new FakeJobs();
    jobs.onStart = (spec) => void finish(fs, jobs, spec.id);
    __setJobSupervisor(jobs);
    const runner = transcribeRunner(fs);
    const t = await runWhisper(ctxWith(runner, fs), SRC);
    expect(words(t)).toEqual(["Hello", "world", "Bye"]);
    const whisperInPage = (runner.run as Any).mock.calls.filter(
      (c: Any[]) => c[0] === "whisper-cli",
    );
    expect(whisperInPage).toHaveLength(0);
    expect(jobs.submitted.map((s) => s.program)).toEqual(["whisper-cli"]);
    expect(jobs.submitted[0].meta).toMatchObject({
      kind: "transcript",
      key: expect.stringMatching(/^whisper:v2:/),
    });
    expect(jobs.forgotten).toEqual([jobs.submitted[0].id]);
    expect(under(fs, WORK)).toEqual([]);
    expect(await peekTranscript(ctxWith(runner, fs), SRC)).not.toBeNull();
    // ...and what the run said about itself goes out once: which backend, and how fast.
    expect(reportTranscription.mock.calls).toEqual([[expect.objectContaining(VULKAN_RUN)]]);
  });

  it("kills the job on Stop and answers cancelled", async () => {
    const fs = disk();
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    const stop = new AbortController();
    const run = runWhisper({ ...ctxWith(transcribeRunner(fs), fs), signal: stop.signal }, SRC);
    await until(() => jobs.started.length === 1);
    stop.abort();
    await expect(run).rejects.toThrow(/transcription cancelled/);
    expect(jobs.killed).toEqual(jobs.started);
    expect(jobs.forgotten).toEqual(jobs.started);
    expect(under(fs, WORK)).toEqual([]);
  });

  it("keeps the words of a transcription the page crashed during, and asks for nothing twice", async () => {
    const fs = disk();
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    void runWhisper(ctxWith(transcribeRunner(fs), fs), SRC).catch(() => undefined);
    await until(() => jobs.started.length === 1);
    const [id] = jobs.started;
    const next = await nextPage(fs, jobs);
    expect(await next.transcribe.adoptTranscriptions(next.io)).toBe(1);
    // whisper is still at work: the indexer's next whisper waits for it...
    let turn: unknown = "waiting";
    void next.gate.backgroundTurn("whisper").then((r) => (turn = r));
    // ...and a request for the same transcript waits for it too, starting nothing.
    const joined = next.transcribe.runWhisper(next.ctx, SRC);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
    expect([turn, jobs.submitted.length]).toEqual(["waiting", 1]);
    await finish(fs, jobs, id);
    expect(words(await joined)).toEqual(["Hello", "world", "Bye"]);
    await until(() => jobs.forgotten.includes(id) && typeof turn === "function");
    expect(under(fs, WORK)).toEqual([]);
    expect(await next.transcribe.peekTranscript(next.ctx, SRC)).not.toBeNull();
    // The page that finished it reports it, once; the one that died never did.
    expect(reportTranscription.mock.calls).toEqual([[expect.objectContaining(VULKAN_RUN)]]);
  });

  it("keeps the words of one that ended while no page was there", async () => {
    const fs = disk();
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    void runWhisper(ctxWith(transcribeRunner(fs), fs), SRC).catch(() => undefined);
    await until(() => jobs.started.length === 1);
    const [id] = jobs.started;
    jobs.pageDied();
    await finish(fs, jobs, id);
    const next = await nextPage(fs, jobs);
    expect(await next.transcribe.adoptTranscriptions(next.io)).toBe(1);
    await until(() => jobs.forgotten.includes(id));
    expect(words((await next.transcribe.peekTranscript(next.ctx, SRC))!)).toEqual([
      "Hello",
      "world",
      "Bye",
    ]);
    expect(under(fs, WORK)).toEqual([]);
    // Asked again, it is answered from what was kept: whisper does not run again.
    await next.transcribe.runWhisper(next.ctx, SRC);
    expect(jobs.submitted).toHaveLength(1);
  });

  it("lets go of one that failed, keeps nothing of it, and a later request runs whisper again", async () => {
    const fs = disk();
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    void runWhisper(ctxWith(transcribeRunner(fs), fs), SRC).catch(() => undefined);
    await until(() => jobs.started.length === 1);
    const [id] = jobs.started;
    const next = await nextPage(fs, jobs);
    await next.transcribe.adoptTranscriptions(next.io);
    await finish(fs, jobs, id, 1);
    await until(() => jobs.forgotten.includes(id));
    expect(await next.transcribe.peekTranscript(next.ctx, SRC)).toBeNull();
    expect(reportTranscription).not.toHaveBeenCalled(); // a failed run is not a speed
    expect(under(fs, WORK)).toEqual([]);
    jobs.onStart = (spec) => void finish(fs, jobs, spec.id);
    expect(words(await next.transcribe.runWhisper(next.ctx, SRC))).toEqual([
      "Hello",
      "world",
      "Bye",
    ]);
    expect(jobs.submitted).toHaveLength(2);
  });

  it("takes over the transcriptions, and leaves every other job alone", async () => {
    const fs = disk();
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    await jobs.submit({
      id: "e1",
      lane: "export",
      program: "ffmpeg",
      args: [],
      meta: { kind: "export" },
    });
    void runWhisper(ctxWith(transcribeRunner(fs), fs), SRC).catch(() => undefined);
    await until(() => jobs.started.length === 2);
    const id = jobs.started[1];
    const next = await nextPage(fs, jobs);
    expect(await next.transcribe.adoptTranscriptions(next.io)).toBe(1);
    await finish(fs, jobs, id);
    await until(() => jobs.forgotten.includes(id));
    expect([jobs.forgotten, jobs.killed, jobs.view("e1")?.state]).toEqual([[id], [], "running"]);
    expect(await next.transcribe.peekTranscript(next.ctx, SRC)).not.toBeNull();
  });

  // A window is cut out and transcribed on its own, so its words come back on the window's clock and
  // are moved onto the file's before they are kept: by whichever page finishes it.
  it("keeps a window's words on the file's clock, and removes its audio", async () => {
    const fs = disk();
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    const window = { start: 60, end: 90 };
    void runWhisper(ctxWith(transcribeRunner(fs), fs), SRC, "small", undefined, window).catch(
      () => undefined,
    );
    await until(() => jobs.started.length === 1);
    const [id] = jobs.started;
    expect(under(fs, WORK).filter((p) => p.endsWith(".wav"))).toHaveLength(1);
    const next = await nextPage(fs, jobs);
    expect(await next.transcribe.adoptTranscriptions(next.io)).toBe(1);
    await finish(fs, jobs, id);
    await until(() => jobs.forgotten.includes(id));
    const t = await next.transcribe.peekTranscript(next.ctx, SRC, "small", undefined, window);
    expect(t?.words.map((w) => [w.word, w.start_seconds])).toEqual([
      ["Hello", 60],
      ["world", 60.6],
      ["Bye", 61.2],
    ]);
    expect(under(fs, WORK)).toEqual([]);
  });

  // The opposite ordering: the next page's first request comes before anything asked it to take
  // over (main.tsx's call is a dynamic import, still loading).
  it("joins the transcription still at work when asked before the page has taken over", async () => {
    const fs = disk();
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    void runWhisper(ctxWith(transcribeRunner(fs), fs), SRC).catch(() => undefined);
    await until(() => jobs.started.length === 1);
    const [id] = jobs.started;
    const next = await nextPage(fs, jobs);
    const joined = next.transcribe.runWhisper(next.ctx, SRC);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
    expect(jobs.submitted).toHaveLength(1);
    // The page's own call comes now, and takes over nothing a second time.
    await next.transcribe.adoptTranscriptions(next.io);
    await finish(fs, jobs, id);
    expect(words(await joined)).toEqual(["Hello", "world", "Bye"]);
    await until(() => jobs.forgotten.includes(id));
    expect([jobs.submitted.length, jobs.forgotten]).toEqual([1, [id]]);
    expect(under(fs, WORK)).toEqual([]);
  });

  it("still transcribes on a page that could not list the app's jobs", async () => {
    const fs = disk();
    const jobs = new FakeJobs();
    jobs.onStart = (spec) => void finish(fs, jobs, spec.id);
    const next = await nextPage(fs, jobs);
    const list = jobs.list.bind(jobs);
    let listed = 0;
    jobs.list = () => (++listed === 1 ? Promise.reject(new Error("ipc down")) : list());
    expect(await next.transcribe.adoptTranscriptions(next.io)).toBe(0);
    expect(words(await next.transcribe.runWhisper(next.ctx, SRC))).toEqual([
      "Hello",
      "world",
      "Bye",
    ]);
    expect(jobs.submitted).toHaveLength(1);
  });
});

describe("ensureTranscript", () => {
  it("transcribes once, then answers from what it made (no re-transcription)", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "audio.mp4"));
    fs.putModel();
    const ctx = ctxWith(transcribeRunner(fs), fs);
    const first = await ensureTranscript(ctx, "audio.mp4");
    expect(first.existed).toBe(false);
    expect(first.parsed.words.map((w) => w.word)).toEqual(["Hello", "world", "Bye"]);
    const again = await ensureTranscript(ctx, "audio.mp4");
    expect(again.existed).toBe(true);
    expect(again.parsed).toEqual(first.parsed);
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

  // Windows resolves a process's imports BEFORE any of its code runs, so a machine missing the
  // Visual C++ runtime whisper-cli needs produces this: no stderr, no whisper exit status, just
  // an NTSTATUS. One user's machine did it 56 times in a session, identical every time, and it
  // was indistinguishable from a broken media file.
  it.each([
    [-1073741515, "0xC0000135 STATUS_DLL_NOT_FOUND"],
    [-1073741511, "0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND"],
    [-1073741701, "0xC000007B STATUS_INVALID_IMAGE_FORMAT"],
  ])(
    "reports a process that never started (%i) as an unavailable engine, not a bad file",
    async (code) => {
      const fs = new MockFs();
      fs.touch(joinPath(DIR, "audio.mp4"));
      fs.putModel();
      const err = await ensureTranscript(
        ctxWith(transcribeRunner(fs, { whisperExit: code }), fs),
        "audio.mp4",
      ).catch((e: unknown) => e);

      expect(isSpeechEngineUnavailable(err)).toBe(true);
      // Expected, not a crash: the machine is misconfigured, which is not a Sentry event.
      expect(isExpected(err)).toBe(true);
      expect(String(err)).not.toMatch(/whisper-cli failed/);
    },
  );

  // The opposite direction: an ordinary non-zero exit is still just a failed transcription, and
  // must NOT disable transcription for the whole session.
  it("treats an ordinary whisper failure as a per-file failure", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "audio.mp4"));
    fs.putModel();
    const err = await ensureTranscript(
      ctxWith(transcribeRunner(fs, { failWhisper: true }), fs),
      "audio.mp4",
    ).catch((e: unknown) => e);
    expect(isSpeechEngineUnavailable(err)).toBe(false);
  });

  // Engine-down switches transcription off for the session, so the classification must be
  // exact: ANY other exit code — access violations, stack overflows, ordinary whisper errors,
  // the positive twins of the three load failures — stays a per-file failure. A code that
  // slipped into the set would let one unrelated crash disable transcription entirely.
  it("treats every exit code outside the three loader failures as per-file", async () => {
    const LOAD = new Set([-1073741515, -1073741511, -1073741701]);
    const code = fc.oneof(
      fc.integer({ min: -2147483648, max: 2147483647 }),
      fc.constantFrom(-1073741819, -1073741571, -1073741510, 3221225781, 1, 2, -1, 255),
    );
    await fc.assert(
      fc.asyncProperty(code, async (exit) => {
        fc.pre(exit !== 0 && !LOAD.has(exit));
        const fs = new MockFs();
        fs.touch(joinPath(DIR, "audio.mp4"));
        fs.putModel();
        const err = await ensureTranscript(
          ctxWith(transcribeRunner(fs, { whisperExit: exit }), fs),
          "audio.mp4",
        ).catch((e: unknown) => e);
        expect(err, `exit ${exit} should fail the file`).toBeInstanceOf(Error);
        expect(isSpeechEngineUnavailable(err), `exit ${exit}`).toBe(false);
      }),
      { numRuns: 150 },
    );
  });

  // Gaps mutation testing found (2026-09-27): each of these survived a mutant.
  it("a Stop says 'cancelled', not that the engine or the install is broken", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "audio.mp4"));
    fs.putModel();
    const ac = new AbortController();
    const runner = transcribeRunner(fs, { whisperExit: -1073741515 });
    const run = runner.run as ReturnType<typeof vi.fn>;
    const inner = run.getMockImplementation()!;
    run.mockImplementation(async (program: string, args: string[]) => {
      if (program === "whisper-cli") ac.abort(); // Stop kills the sidecar mid-run
      return inner(program, args);
    });
    const err = await ensureTranscript(
      { store: new ProjectStoreAccess(DIR, fs), runner, signal: ac.signal } as ClientToolContext,
      "audio.mp4",
    ).catch((e: unknown) => e);
    expect(String(err)).toMatch(/transcription cancelled/);
    // The kill's exit code must not be read as the machine's state.
    expect(isSpeechEngineUnavailable(err)).toBe(false);
  });

  it("fails on a non-zero exit even when a transcript file was left behind", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "audio.mp4"));
    fs.putModel();
    const runner = transcribeRunner(fs);
    const run = runner.run as ReturnType<typeof vi.fn>;
    const inner = run.getMockImplementation()!;
    run.mockImplementation(async (program: string, args: string[]) => {
      const r = await inner(program, args); // writes a complete-looking .json...
      return program === "whisper-cli" ? { ...r, code: 3, stderr: "crashed at the end" } : r;
    });
    await expect(ensureTranscript(ctxWith(runner, fs), "audio.mp4")).rejects.toThrow(
      /whisper-cli failed \(code=3\)/,
    );
  });

  it("an unavailable engine is an expected, named error the UI can recognise", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "audio.mp4"));
    fs.putModel();
    const err = (await ensureTranscript(
      ctxWith(transcribeRunner(fs, { whisperExit: -1073741515 }), fs),
      "audio.mp4",
    ).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.name).toBe("SpeechEngineUnavailableError");
    expect(err.code).toBe("speech_engine_unavailable");
    expect(err.message).toMatch(/could not start on this machine/);
  });
});

// 4f: a transcript is kept by FILE, outside every project. These assert the rule by what whisper
// is asked to do: once per file, whichever project asks, and again only for different bytes.
describe("one transcript per file, in the app-wide cache (4f)", () => {
  const A = "C:/data/projects/a";
  const B = "C:/data/projects/b";
  const catalog = (fs: MockFs, dir: string, clips: object[]): void =>
    void fs.files.set(joinPath(dir, "internals/library.json"), JSON.stringify({ clips }));
  const whisperRuns = (runner: CommandRunner): number =>
    (runner.run as Any).mock.calls.filter((c: Any[]) => c[0] === "whisper-cli").length;
  const ctxIn = (dir: string, runner: CommandRunner, fs: MockFs): ClientToolContext => ({
    store: new ProjectStoreAccess(dir, fs),
    runner,
  });
  /** The same media copied into two projects: other paths, other write times, the same bytes. */
  const copiedInto = (fs: MockFs, ...dirs: string[]): void => {
    for (const dir of dirs) {
      catalog(fs, dir, [{ id: "media_abc", path: "library/media_abc.mp4", filename: "talk.mp4" }]);
      fs.putBytes(joinPath(dir, "library/media_abc.mp4"), new Uint8Array([1, 2, 3]));
    }
  };

  it("transcribes a file two projects use once", async () => {
    const fs = new MockFs();
    fs.putModel();
    copiedInto(fs, A, B);
    const runner = transcribeRunner(fs);
    expect((await ensureTranscript(ctxIn(A, runner, fs), "media_abc")).existed).toBe(false);
    const inB = await ensureTranscript(ctxIn(B, runner, fs), "media_abc");
    expect(inB.existed).toBe(true);
    expect(inB.parsed.words.map((w) => w.word)).toEqual(["Hello", "world", "Bye"]);
    expect(whisperRuns(runner)).toBe(1);
  });

  // 4h2: whisper carried text across its 30 s windows and went blank after long silence. The
  // outcome is pinned against real whisper in inspectMedia.smoke.e2e.ts; here, the two things
  // that make it hold without the model: whisper is told to carry nothing, and a transcript made
  // the old way is never answered with.
  it("runs whisper carrying no text between windows, and never reads a transcript made otherwise", async () => {
    const fs = new MockFs();
    fs.putModel();
    copiedInto(fs, A);
    const runner = transcribeRunner(fs);
    const ctx = ctxIn(A, runner, fs);
    const src = joinPath(A, "library/media_abc.mp4");
    const blank = { result: { language: "en" }, transcription: [] };
    const v1 = `whisper:v1:${await ctx.store.fileIdentity(src)}:small:auto`;
    await (await ctx.store.appCache())!.put("transcripts", v1, blank);
    expect((await runWhisper(ctx, src)).words.map((w) => w.word)).toEqual([
      "Hello",
      "world",
      "Bye",
    ]);
    const call = (runner.run as Any).mock.calls.find((c: Any[]) => c[0] === "whisper-cli");
    const args = call[1] as string[];
    expect(args[args.indexOf("-mc") + 1]).toBe("0");
  });

  it("keeps a linked file's transcript when it is moved and relinked, not when it is edited", async () => {
    const fs = new MockFs();
    fs.putModel();
    const linkAt = (path: string): void =>
      catalog(fs, A, [{ id: "media_lnk", path, filename: "talk.mp4", external: true }]);
    fs.putBytes("D:/shoot/talk.mp4", new Uint8Array([1, 2, 3]));
    linkAt("D:/shoot/talk.mp4");
    const runner = transcribeRunner(fs);
    const ctx = ctxIn(A, runner, fs);
    await ensureTranscript(ctx, "media_lnk");

    await fs.rename("D:/shoot/talk.mp4", "E:/moved/talk.mp4");
    linkAt("E:/moved/talk.mp4");
    expect((await ensureTranscript(ctx, "media_lnk")).existed).toBe(true);

    // Edited where it lies: the same size, written later. Not the bytes it was transcribed from.
    fs.putBytes("E:/moved/talk.mp4", new Uint8Array([9, 9, 9]));
    expect((await ensureTranscript(ctx, "media_lnk")).existed).toBe(false);
    expect(whisperRuns(runner)).toBe(2);
  });

  // Moving the cache out of the project is what lets a transcription finish after its project
  // closed: nothing may be written into a closed project, and the next project still gets it.
  it("keeps a transcript whose project was closed and deleted while whisper ran", async () => {
    const fs = new MockFs();
    fs.putModel();
    copiedInto(fs, A, B);
    const runner = transcribeRunner(fs);
    const run = runner.run as ReturnType<typeof vi.fn>;
    const inner = run.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const whisperStarted = new Promise<void>((r) => (started = r));
    run.mockImplementation(async (program: string, args: string[]) => {
      if (program === "whisper-cli") {
        started();
        await gate;
      }
      return inner(program, args);
    });
    try {
      const inA = ensureTranscript(ctxIn(A, runner, fs), "media_abc");
      await whisperStarted;
      markProjectDirDead(A);
      release();
      await inA;
      expect((await ensureTranscript(ctxIn(B, runner, fs), "media_abc")).existed).toBe(true);
      expect(whisperRuns(runner)).toBe(1);
    } finally {
      reviveProjectDir(A);
    }
  });

  it("keeps the transcript outside the project", async () => {
    const fs = new MockFs();
    fs.putModel();
    copiedInto(fs, A);
    await ensureTranscript(ctxIn(A, transcribeRunner(fs), fs), "media_abc");
    const json = [...fs.files.keys()].filter((p) => p.endsWith(".json"));
    expect(json.filter((p) => p.startsWith("C:/cache/app/transcripts/"))).toHaveLength(1);
    expect(json.filter((p) => p.startsWith(`${A}/`))).toEqual([`${A}/internals/library.json`]);
  });

  // The background indexer and inspect_media can ask from different projects at once.
  it("runs one whisper for a file two projects ask for at the same moment", async () => {
    const fs = new MockFs();
    fs.putModel();
    copiedInto(fs, A, B);
    const runner = transcribeRunner(fs);
    const [inA, inB] = await Promise.all([
      ensureTranscript(ctxIn(A, runner, fs), "media_abc"),
      ensureTranscript(ctxIn(B, runner, fs), "media_abc"),
    ]);
    expect(inB.parsed).toEqual(inA.parsed);
    expect(whisperRuns(runner)).toBe(1);
  });

  it("makes a transcript again when what it finds kept is not whisper's output", async () => {
    const fs = new MockFs();
    fs.putModel();
    copiedInto(fs, A);
    const runner = transcribeRunner(fs);
    await ensureTranscript(ctxIn(A, runner, fs), "media_abc");
    const [entry] = [...fs.files.keys()].filter((p) => p.startsWith("C:/cache/app/transcripts/"));
    const { key } = JSON.parse(fs.files.get(entry)!) as { key: string };
    fs.files.set(entry, JSON.stringify({ key, value: "Hello world Bye" }));
    const again = await ensureTranscript(ctxIn(A, runner, fs), "media_abc");
    expect(again.existed).toBe(false);
    expect(again.parsed.words.map((w) => w.word)).toEqual(["Hello", "world", "Bye"]);
    expect(whisperRuns(runner)).toBe(2);
  });

  // Without an identity (a platform that does not say when a file was written) or without a cache
  // folder, nothing is kept: slower, never wrong. Above all, no file is answered with another's
  // transcript.
  it("keeps nothing it cannot key, and answers no file with another's transcript", async () => {
    const untimed = (fs: MockFs): MockFs => {
      const stat = fs.stat.bind(fs);
      fs.stat = async (p: string) => {
        const s = await stat(p);
        return p.startsWith("C:/media/") ? { isDirectory: s.isDirectory, size: s.size } : s;
      };
      return fs;
    };
    const disks = {
      "no identity": untimed(new MockFs()),
      "no cache folder": Object.assign(new MockFs(), { cacheDir: undefined }),
    };
    for (const [lacking, fs] of Object.entries(disks)) {
      fs.putModel();
      fs.touch("C:/media/one.mp4");
      fs.touch("C:/media/two.mp4");
      const runner = transcribeRunner(fs);
      const ctx = ctxWith(runner, fs);
      for (const src of ["C:/media/one.mp4", "C:/media/two.mp4", "C:/media/one.mp4"])
        expect((await runWhisper(ctx, src)).words.length, lacking).toBeGreaterThan(0);
      expect(whisperRuns(runner), lacking).toBe(3);
      // ...and the same for a window of each.
      const w = { start: 30, end: 40 };
      for (const src of ["C:/media/one.mp4", "C:/media/two.mp4"])
        await runWhisper(ctx, src, "small", undefined, w);
      expect(whisperRuns(runner), lacking).toBe(5);
    }
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

  // UJ-014: a linked source the user moved. "file not found: media_…" read as a wrong ref; the ref
  // is right, the file is offline, and the user can relink it.
  it("names an OFFLINE linked source as offline, with what to do, and still not as silence", async () => {
    const fs = new MockFs();
    fs.putModel();
    await fs.writeTextFile(
      joinPath(DIR, "internals", "library.json"),
      JSON.stringify({
        clips: [
          {
            id: "media_gone",
            path: "D:/Downloads/iCloud Fotos/New Jeans.mp3",
            filename: "New Jeans.mp3",
            external: true,
          },
        ],
      }),
    );
    const tl = JSON.parse(timelineWith(["c1"]));
    tl.tracks[0].clips[0].media_ref = "media_gone";
    await fs.writeTextFile(joinPath(DIR, "internals", "timeline.json"), JSON.stringify(tl));

    const r = (await getTranscriptTool({}, ctxWith(transcribeRunner(fs), fs))) as Any;

    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/NOT an absence of speech/i);
    expect(String(r.error)).toMatch(/'New Jeans\.mp3' is offline/);
    expect(String(r.error)).toMatch(/relink/i);
    expect(String(r.error)).not.toMatch(/file not found|iCloud Fotos/);
  });
});

// 4h (owner decision 2026-10-04): get_transcript transcribes only what the clips play, plus a second
// either side, and waits at most about a minute; what is not ready is listed and goes on in the
// background. The file here speaks a word "w<k>" every 5 s for 80 minutes, and the fake whisper
// hears only the stretch of the WAV it is handed, so what was transcribed shows in the words.
describe("get_transcript transcribes what the clips play (4h)", () => {
  const FPS = 30;
  const unregister: Array<() => void> = [];
  const releases: Array<() => void> = [];
  afterEach(async () => {
    for (const u of unregister.splice(0)) u();
    vi.useRealTimers();
    for (const release of releases.splice(0)) release();
    await new Promise((r) => setTimeout(r, 10)); // a released run finishes and leaves the join map
  });

  /** A runner whose ffmpeg records the stretch each WAV holds and whose whisper hears only that
   *  stretch. `hold(n)` makes the n-th whisper run (1-based) wait until it is released. */
  function spoken(fs: MockFs, hold: (n: number) => Promise<void> | void = () => undefined) {
    const held = (p: string): string => joinPath(p).replace(/\.[0-9a-z]+\.tmp\.wav$/, ".wav");
    const stretch = new Map<string, [number, number]>();
    const runs: Array<[number, number]> = [];
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        if (program === "ffmpeg") {
          const at = (flag: string, none: number): number =>
            args.includes(flag) ? Number(args[args.indexOf(flag) + 1]) : none;
          const from = stretch.get(held(args[args.indexOf("-i") + 1]))?.[0] ?? 0;
          stretch.set(held(args[args.length - 1]), [from + at("-ss", 0), from + at("-to", 4800)]);
          fs.touch(args[args.length - 1]);
        }
        if (program === "whisper-cli") {
          const [s, e] = stretch.get(held(args[args.indexOf("-f") + 1])) ?? [0, 4800];
          runs.push([s, e]);
          await hold(runs.length);
          const ms = (t: number): number => Math.round((t - s) * 1000);
          const said = Array.from({ length: 960 }, (_, k) => k * 5).filter(
            (t) => t >= s && t + 0.5 <= e,
          );
          const transcription = said.map((t) => ({
            offsets: { from: ms(t), to: ms(t + 0.5) },
            text: ` w${t / 5}`,
            tokens: [{ text: ` w${t / 5}`, offsets: { from: ms(t), to: ms(t + 0.5) }, p: 0.9 }],
          }));
          await fs.writeTextFile(
            `${args[args.indexOf("-of") + 1]}.json`,
            JSON.stringify({ result: { language: "en" }, transcription }),
          );
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
    };
    return { runner, runs };
  }

  /** A project whose timeline holds `clips` on one audio track, every clip of one file, its own:
   *  whisper runs are joined per file across the whole process, so tests must not share one.
   *  Each clip: the source seconds it plays and where it starts on the timeline, in seconds. */
  let files = 0;
  async function project(
    clips: Array<{ id: string; from: number; to: number; at: number; speed?: number }>,
  ) {
    const name = `talk${++files}.mp4`;
    const fs = new MockFs();
    fs.putModel();
    fs.touch(joinPath(DIR, name));
    await fs.writeTextFile(
      joinPath(DIR, "internals", "timeline.json"),
      JSON.stringify({
        canvas: { width: 1920, height: 1080, fps: FPS },
        tracks: [
          {
            id: "a1",
            kind: "audio",
            clips: clips.map((c) => ({
              id: c.id,
              media_ref: name,
              source_in: c.from * FPS,
              source_out: c.to * FPS,
              timeline_in: c.at * FPS,
              timeline_out: (c.at + (c.to - c.from) / (c.speed ?? 1)) * FPS,
              ...(c.speed ? { speed: c.speed } : {}),
            })),
          },
        ],
      }),
    );
    return { fs, src: joinPath(DIR, name) };
  }
  const words = (r: Any): string[] =>
    (r.clips as Array<{ words: Array<[number, string]> }>).flatMap((c) => c.words.map((w) => w[1]));

  it("transcribes only the stretch a clip plays, plus a second either side", async () => {
    const { fs } = await project([{ id: "c1", from: 60, to: 75, at: 0 }]);
    const { runner, runs } = spoken(fs);
    const r = (await getTranscriptTool({}, ctxWith(runner, fs))) as Any;
    expect(runs).toEqual([[59, 76]]);
    expect(r.clips[0].words).toEqual([
      [0, "w12", 0, 15],
      [1, "w13", 150, 165],
      [2, "w14", 300, 315],
    ]);
    expect(r.in_progress).toBeUndefined();
    expect(r.word_format).toEqual(["index", "text", "start_frame", "end_frame"]);
    expect([r.script_preview, r.word_count]).toEqual(["w12 w13 w14", 3]);
  });

  it("maps a sped-up clip to the stretch of the file it plays, from a start inside it", async () => {
    // At 2x, 15 s of timeline play 60-90 s of the file; from 5 s in, that is 70-90 s.
    const { fs } = await project([{ id: "c1", from: 60, to: 90, at: 0, speed: 2 }]);
    const { runner, runs } = spoken(fs);
    const r = (await getTranscriptTool({ start_frame: 5 * FPS }, ctxWith(runner, fs))) as Any;
    expect(runs).toEqual([[69, 91]]);
    expect(r.clips[0].words.map((w: Any) => [w[1], w[2]])).toEqual([
      ["w14", 150],
      ["w15", 225],
      ["w16", 300],
      ["w17", 375],
    ]);
  });

  it("returns no word before start_frame, even one the stretch's padding heard", async () => {
    const { fs } = await project([{ id: "c1", from: 60, to: 75, at: 0 }]);
    const { runner, runs } = spoken(fs);
    const r = (await getTranscriptTool({ start_frame: 6 * FPS }, ctxWith(runner, fs))) as Any;
    expect(runs).toEqual([[65, 76]]); // heard the word at 65 s, which plays at frame 150
    expect(words(r)).toEqual(["w14"]);
  });

  it("transcribes nothing of a clip that ends where the asked-for frames begin", async () => {
    const { fs } = await project([
      { id: "c1", from: 60, to: 75, at: 0 },
      { id: "c2", from: 600, to: 610, at: 15 },
    ]);
    const { runner, runs } = spoken(fs);
    await getTranscriptTool({ start_frame: 15 * FPS }, ctxWith(runner, fs));
    expect(runs).toEqual([[599, 611]]);
  });

  it("answers in timeline order whatever order the track lists its clips in", async () => {
    const { fs } = await project([
      { id: "late", from: 600, to: 610, at: 15 },
      { id: "early", from: 60, to: 75, at: 0 },
    ]);
    const { runner } = spoken(fs);
    const r = (await getTranscriptTool({}, ctxWith(runner, fs))) as Any;
    expect(r.clips.map((c: Any) => c.clip_id)).toEqual(["early", "late"]);
    expect(words(r)).toEqual(["w12", "w13", "w14", "w120", "w121"]);
  });

  it("lists no clip whose stretch holds no words", async () => {
    const { fs } = await project([{ id: "c1", from: 61, to: 64, at: 0 }]);
    const { runner, runs } = spoken(fs);
    const r = (await getTranscriptTool({}, ctxWith(runner, fs))) as Any;
    expect(runs).toEqual([[60, 65]]); // heard the word at 60 s, which the clip does not play
    expect([r.clips, r.word_count]).toEqual([[], 0]);
  });

  it("merges in the file's order, whatever order the timeline plays the stretches in", async () => {
    const { fs } = await project([
      { id: "c1", from: 600, to: 610, at: 0 },
      { id: "c2", from: 60, to: 75, at: 10 },
      { id: "c3", from: 77, to: 90, at: 25 }, // its padded stretch starts where c2's ends
    ]);
    const { runner, runs } = spoken(fs);
    const r = (await getTranscriptTool({}, ctxWith(runner, fs))) as Any;
    expect(runs).toEqual([
      [599, 611],
      [59, 91],
    ]);
    expect(words(r)).toEqual(["w120", "w121", "w12", "w13", "w14", "w16", "w17"]);
  });

  it("scopes to a clip by its own id or by the video clip its sound was split from", async () => {
    const { fs } = await project([
      { id: "a1c", from: 60, to: 75, at: 0 },
      { id: "a2c", from: 600, to: 610, at: 15 },
    ]);
    const at = joinPath(DIR, "internals", "timeline.json");
    const tl = JSON.parse(await fs.readTextFile(at));
    tl.tracks[0].clips[0].link_group = "L1";
    tl.tracks.unshift({
      id: "v1",
      kind: "video",
      clips: [{ ...tl.tracks[0].clips[0], id: "vc" }],
    });
    await fs.writeTextFile(at, JSON.stringify(tl));
    const { runner } = spoken(fs);
    const ctx = ctxWith(runner, fs);
    expect(words(await getTranscriptTool({ clip_id: "vc" }, ctx))).toEqual(["w12", "w13", "w14"]);
    expect(words(await getTranscriptTool({ clip_id: "a2c" }, ctx))).toEqual(["w120", "w121"]);
    // The video clip is never read itself: its sound is the audio clip's.
    expect(words(await getTranscriptTool({}, ctx))).toEqual(["w12", "w13", "w14", "w120", "w121"]);
    expect(await getTranscriptTool({ clip_id: "nope" }, ctx)).toEqual({
      ok: false,
      error: "clip not found on the timeline: nope",
    });
  });

  it("transcribes neighbouring stretches of one file once, and stretches far apart apart", async () => {
    const { fs } = await project([
      { id: "c1", from: 60, to: 75, at: 0 },
      { id: "c2", from: 75.5, to: 90, at: 15 },
      { id: "c3", from: 600, to: 610, at: 30 },
    ]);
    const { runner, runs } = spoken(fs);
    const r = (await getTranscriptTool({}, ctxWith(runner, fs))) as Any;
    expect(runs).toEqual([
      [59, 91],
      [599, 611],
    ]);
    expect(words(r)).toEqual(["w12", "w13", "w14", "w16", "w17", "w120", "w121"]);
    // Asked again: the merged stretch was kept as one, and answers as one.
    const again = (await getTranscriptTool({}, ctxWith(runner, fs))) as Any;
    expect(words(again)).toEqual(words(r));
    expect(runs).toHaveLength(2);
  });

  // 4h2: on the 12-minute QA file a clip's own stretch had words and times the whole file's lacked.
  it("answers a clip from its own kept stretch before the file's whole transcript", async () => {
    const { fs, src } = await project([{ id: "c1", from: 60, to: 75, at: 0 }]);
    const { runner, runs } = spoken(fs);
    const ctx = ctxWith(runner, fs);
    await getTranscriptTool({}, ctx); // keeps the stretch 59-76
    const whole = await transcriptCacheSlot(ctx, src);
    const at = { from: 60_000, to: 60_500 };
    await (await ctx.store.appCache())!.put(whole.namespace, whole.key!, {
      result: { language: "en" },
      transcription: [{ offsets: at, text: " WHOLE", tokens: [{ text: " WHOLE", offsets: at }] }],
    });
    expect(words(await getTranscriptTool({}, ctx))).toEqual(["w12", "w13", "w14"]);
    expect(runs).toHaveLength(1);
    // A clip with no stretch of its own kept is answered from the whole file, without running.
    const tl = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals", "timeline.json")));
    tl.tracks[0].clips[0].source_out = 72 * FPS; // a new stretch: 60-72 s
    tl.tracks[0].clips[0].timeline_out = 12 * FPS;
    await fs.writeTextFile(joinPath(DIR, "internals", "timeline.json"), JSON.stringify(tl));
    expect(words(await getTranscriptTool({}, ctx))).toEqual(["WHOLE"]);
    expect(runs).toHaveLength(1);
  });

  it("keeps a clip's words when a clip overlapping it joins, and transcribes only the newcomer", async () => {
    const { fs } = await project([{ id: "c1", from: 60, to: 75, at: 0 }]);
    const { runner, runs } = spoken(fs);
    const ctx = ctxWith(runner, fs);
    await getTranscriptTool({}, ctx);
    const at = joinPath(DIR, "internals", "timeline.json");
    const tl = JSON.parse(await fs.readTextFile(at));
    const [first] = tl.tracks[0].clips;
    tl.tracks[0].clips.push({
      ...first,
      id: "c2",
      source_in: 70 * FPS,
      source_out: 200 * FPS,
      timeline_in: 15 * FPS,
      timeline_out: 145 * FPS,
    });
    await fs.writeTextFile(at, JSON.stringify(tl));
    const r = (await getTranscriptTool({}, ctx)) as Any;
    expect(runs).toEqual([
      [59, 76],
      [69, 201],
    ]);
    expect(r.clips.map((c: Any) => c.clip_id)).toEqual(["c1", "c2"]);
  });

  it("answers from the file's whole transcript, when the indexer made one, without running", async () => {
    const { fs, src } = await project([{ id: "c1", from: 60, to: 75, at: 0 }]);
    const { runner, runs } = spoken(fs);
    const ctx = ctxWith(runner, fs);
    await runWhisper(ctx, src); // the indexer's whole-file run
    runs.length = 0;
    const r = (await getTranscriptTool({}, ctx)) as Any;
    expect(runs).toEqual([]);
    expect(words(r)).toEqual(["w12", "w13", "w14"]);
  });

  it("answers a stretch an earlier call transcribed without running again", async () => {
    const { fs } = await project([{ id: "c1", from: 60, to: 75, at: 0 }]);
    const { runner, runs } = spoken(fs);
    const ctx = ctxWith(runner, fs);
    await getTranscriptTool({}, ctx);
    expect(words((await getTranscriptTool({}, ctx)) as Any)).toEqual(["w12", "w13", "w14"]);
    expect(runs).toHaveLength(1);
  });

  // The whole file's 16 kHz audio is kept to cut windows from. Named by the file's PATH, a file
  // edited in place had its windows cut from the audio of what it was before (found in 4h).
  it("never cuts a window from the audio a file had before it changed", async () => {
    const { fs, src } = await project([{ id: "c1", from: 60, to: 75, at: 0 }]);
    const { runner } = spoken(fs);
    const ctx = ctxWith(runner, fs);
    await runWhisper(ctx, src); // extracts the whole file's audio, and keeps it
    const cutFrom = async (): Promise<string[]> => {
      vi.mocked(runner.run).mockClear();
      await getTranscriptTool({}, ctx);
      return vi
        .mocked(runner.run)
        .mock.calls.filter((c) => c[0] === "ffmpeg")
        .map((c) => joinPath(c[1][c[1].indexOf("-i") + 1]));
    };
    fs.touch(src); // edited in place: written again, a second later
    expect(await cutFrom()).toEqual([src]);
  });

  it("transcribes only the clips inside start_frame/end_frame, and only the part inside", async () => {
    const { fs } = await project([
      { id: "c1", from: 60, to: 75, at: 0 },
      { id: "c2", from: 600, to: 610, at: 15 },
    ]);
    const { runner, runs } = spoken(fs);
    const r = (await getTranscriptTool(
      { start_frame: 0, end_frame: 5 * FPS },
      ctxWith(runner, fs),
    )) as Any;
    expect(runs).toEqual([[59, 66]]);
    expect(words(r)).toEqual(["w12"]);
  });

  /** Let pending promises run until `done`, never forever (fake timers: no timer can help). */
  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 10_000 && !done(); i++) await Promise.resolve();
    expect(done()).toBe(true);
  }

  /** Three clips of three stretches; the second whisper run does not finish until the test ends. */
  async function slow(): Promise<{
    fs: MockFs;
    src: string;
    runner: CommandRunner;
    runs: Array<[number, number]>;
  }> {
    const { fs, src } = await project([
      { id: "c1", from: 60, to: 75, at: 0 },
      { id: "c2", from: 600, to: 610, at: 15 },
      { id: "c3", from: 1200, to: 1210, at: 25 },
    ]);
    const { runner, runs } = spoken(fs, (n) =>
      n === 2 ? new Promise<void>((r) => releases.push(r)) : undefined,
    );
    return { fs, src, runner, runs };
  }

  it("waits at most TRANSCRIPT_WAIT_MS, lists what is not ready, and hands the rest on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { fs, src, runner, runs } = await slow();
    const asked: Array<[string, string, unknown]> = [];
    unregister.push(
      registerBackgroundTranscriber(DIR, {
        prioritize: (source, language, window) => (asked.push([source, language, window]), true),
        loudness: () => null,
      }),
    );
    let got: Any;
    void getTranscriptTool({}, ctxWith(runner, fs)).then((r) => (got = r));
    await until(() => runs.length === 2);
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS - 1);
    expect(got).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await until(() => got !== undefined);
    expect(got.ok).toBe(true);
    expect(words(got)).toEqual(["w12", "w13", "w14"]);
    expect(got.in_progress).toEqual([
      { clip_id: "c2", track_id: "a1" },
      { clip_id: "c3", track_id: "a1" },
    ]);
    expect(got.note).toMatch(/background/);
    expect(got.note).toMatch(/not silence/);
    // The run still going keeps going; the one never started is the background's now.
    expect(runs).toHaveLength(2);
    expect(asked).toEqual([[src, "", { start: 1199, end: 1211 }]]);
  });

  it("says the rest takes longer than a call waits when nothing transcribes in the background", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { fs, runner, runs } = await slow();
    let got: Any;
    void getTranscriptTool({}, ctxWith(runner, fs)).then((r) => (got = r));
    await until(() => runs.length === 2);
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS);
    await until(() => got !== undefined);
    expect(got.in_progress).toHaveLength(2);
    expect(got.note).toMatch(/longer than one call waits/);
  });

  it("answers cancelled at once when the call is stopped while it waits", async () => {
    const { fs, runner, runs } = await slow();
    const stop = new AbortController();
    const call = getTranscriptTool({}, { ...ctxWith(runner, fs), signal: stop.signal });
    for (let i = 0; i < 2000 && runs.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
    stop.abort();
    expect(await call).toEqual({ ok: false, error: "cancelled" });
  });
});
