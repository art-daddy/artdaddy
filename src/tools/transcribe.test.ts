import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { shortHash as shortHashOf } from "./media";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import { useModelDownload } from "../store/modelDownload";
import { isExpected } from "../lib/errors";
import {
  canonicalTranscriptRel,
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
    // A rename moves whatever is there, like the real one: the WAV extracts are written by a fake
    // ffmpeg as (empty) text entries, the model as bytes.
    const text = this.files.get(src);
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

  it("files each distinct request's transcript separately, under transcripts/", () => {
    const rel = (ref: string, size = "small", lang?: string) =>
      canonicalTranscriptRel(ref, size, lang);
    // transcripts/ is the folder the media GC keeps whole; a transcript filed elsewhere is swept.
    expect(rel("library/a.mp4")).toMatch(/^transcripts\/[0-9a-f]{12}\.json$/);
    const distinct = [
      rel("library/a.mp4"),
      rel("library/b.mp4"),
      rel("library/a.mp4", "base"),
      rel("library/a.mp4", "small", "es"),
    ];
    expect(new Set(distinct).size).toBe(distinct.length);
    // One request, however it is spelled.
    expect(rel("library/a.mp4", "small", "auto")).toBe(rel("library/a.mp4"));
    expect(rel("library/a.mp4", "small", "en-US")).toBe(rel("library/a.mp4", "small", "en"));
    expect(rel("C:\\proj\\library\\a.mp4")).toBe(rel("library/a.mp4"));
  });

  it("asks whisper to detect the language when none is given", async () => {
    const fs = new MockFs();
    fs.putModel();
    const runner = transcribeRunner(fs);
    await runWhisper(ctxWith(runner, fs), SRC);
    expect(whisperArgs(runner).map(langOf)).toEqual(["auto"]);
  });

  it("treats 'auto' and no language as one request", async () => {
    const fs = new MockFs();
    fs.putModel();
    const runner = transcribeRunner(fs);
    const ctx = ctxWith(runner, fs);
    await runWhisper(ctx, SRC);
    await runWhisper(ctx, SRC, "small", "AUTO");
    expect(whisperArgs(runner)).toHaveLength(1);
  });

  it("gives whisper the language of a regional code, and shares that language's transcript", async () => {
    const fs = new MockFs();
    fs.putModel();
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

  it("still serves a transcript made in a language that was named", async () => {
    const fs = new MockFs();
    fs.putModel();
    const runner = transcribeRunner(fs);
    const ctx = ctxWith(runner, fs);
    const named = await ctx.store.prepareArtifact(
      `transcribe/${shortHashOf(`${SRC}|small|es`)}.json`,
    );
    await fs.writeTextFile(
      named,
      JSON.stringify({ result: { language: "es" }, transcription: [] }),
    );
    expect((await runWhisper(ctx, SRC, "small", "es")).language).toBe("es");
    expect(whisperArgs(runner)).toHaveLength(0);
  });

  it("does the same for the canonical transcript every tool shares", async () => {
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
    expect(r.path).toBe(
      await ctx.store.prepareArtifact(canonicalTranscriptRel("library/rede.mp4", "small")),
    );
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

  it("cuts the window from the whole file's extract when it is already on disk", async () => {
    const fs = new MockFs();
    fs.putModel();
    const runner = transcribeRunner(fs);
    const ctx = ctxWith(runner, fs);
    // A French transcript of the whole file leaves its 16 kHz extract behind (and no default one).
    await runWhisper(ctx, SRC, "small", "fr");
    const t = await runWhisper(ctx, SRC, "small", undefined, { start: 60, end: 90 });
    const [whole, cut] = calls(runner, "ffmpeg");
    // The window is read from that extract, not decoded from the source again...
    expect(cut[cut.indexOf("-i") + 1]).not.toBe(SRC);
    expect(cut[cut.indexOf("-i") + 1]).toBe(
      `${whole.at(-1)!.replace(/\.[a-z0-9]+\.tmp\.wav$/, "")}.wav`,
    );
    // ...and whisper is handed only the window, never the whole extract with an offset.
    const second = calls(runner, "whisper-cli")[1];
    expect(second).not.toContain("-ot");
    expect(t.segments[0].start_seconds).toBe(60);
  });

  it("never hands a window's transcript out as the whole file's", async () => {
    const fs = new MockFs();
    fs.putModel();
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
