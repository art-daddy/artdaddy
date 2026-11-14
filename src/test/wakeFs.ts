// The machine under the app in the wake harness: an in-memory project disk, and the three programs the speech
// path runs (ffprobe, ffmpeg, whisper-cli) as fakes. Nothing here touches the real disk or starts a process.
// The engine takes virtual time (fake timers). That it does one file at a time is the app's own work gate;
// the fake only records when each run began and ended.
import type { CommandResult, CommandRunner } from "../tools/command";
import { joinPath, type DirEntry, type FsLike } from "../tools/store";
import { WHISPER_MODELS, whisperModelPath } from "../tools/transcribe";

const SAMPLE_RATE = 16_000;
const wavBytes = (seconds: number): number => 44 + SAMPLE_RATE * 2 * Math.round(seconds);
const enoent = (path: string): Error => new Error(`ENOENT: ${path}`);

interface Entry {
  text: string;
  size: number;
  mtimeMs: number;
}

/** A disk in memory, as far as the app's file code needs one: a folder exists because a file is under
 *  it, `readDir`, `remove` and `rename` on what is not there throw, and files carry a size and a time. */
export class WakeDisk implements FsLike {
  private readonly files = new Map<string, Entry>();
  private readonly folders = new Set<string>();

  private isFolder(key: string): boolean {
    if (this.folders.has(key)) return true;
    const prefix = `${key}/`;
    for (const file of this.files.keys()) if (file.startsWith(prefix)) return true;
    return false;
  }

  /** A file with a size of its own: a media file the app only ever probes, not reads. */
  put(path: string, entry: { text?: string; size?: number } = {}): void {
    const text = entry.text ?? "";
    this.files.set(joinPath(path), {
      text,
      size: entry.size ?? new TextEncoder().encode(text).length,
      mtimeMs: Date.now(),
    });
  }

  text(path: string): string | null {
    return this.files.get(joinPath(path))?.text ?? null;
  }

  async exists(path: string): Promise<boolean> {
    const key = joinPath(path);
    return this.files.has(key) || this.isFolder(key);
  }
  async readTextFile(path: string): Promise<string> {
    const entry = this.files.get(joinPath(path));
    if (!entry) throw enoent(path);
    return entry.text;
  }
  async writeTextFile(path: string, contents: string): Promise<void> {
    this.put(path, { text: contents });
  }
  async mkdir(path: string): Promise<void> {
    const parts = joinPath(path).split("/");
    for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
  }
  async rename(from: string, to: string): Promise<void> {
    const key = joinPath(from);
    const entry = this.files.get(key);
    if (!entry) throw enoent(from);
    this.files.delete(key);
    this.files.set(joinPath(to), { ...entry, mtimeMs: Date.now() });
  }
  async remove(path: string): Promise<void> {
    const key = joinPath(path);
    const under = [...this.files.keys()].filter((k) => k === key || k.startsWith(`${key}/`));
    if (!under.length && !this.folders.has(key)) throw enoent(path);
    for (const k of under) this.files.delete(k);
    this.folders.delete(key);
  }
  async readDir(path: string): Promise<DirEntry[]> {
    const key = joinPath(path);
    if (!this.isFolder(key)) throw enoent(path);
    const names = new Map<string, boolean>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(`${key}/`)) continue;
      const rest = file.slice(key.length + 1);
      const slash = rest.indexOf("/");
      names.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
    }
    for (const folder of this.folders) {
      if (!folder.startsWith(`${key}/`)) continue;
      names.set(folder.slice(key.length + 1).split("/")[0], true);
    }
    return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async stat(path: string): Promise<{ isDirectory: boolean; size: number; mtimeMs?: number }> {
    const key = joinPath(path);
    const entry = this.files.get(key);
    if (entry) return { isDirectory: false, size: entry.size, mtimeMs: entry.mtimeMs };
    if (this.isFolder(key)) return { isDirectory: true, size: 0, mtimeMs: Date.now() };
    throw enoent(path);
  }
  /** Where the app keeps what it can always redo (transcripts), and where a long job keeps its scratch. */
  async cacheDir(): Promise<string> {
    return "C:/app/cache";
  }
  async workDir(): Promise<string> {
    return "C:/app/work";
  }
}

/** One audio file the person imported. Everything in it is synthetic. */
export interface WakeFile {
  /** What the metrics call it. */
  label: string;
  /** The library id: what the assistant refers to the file by. */
  ref: string;
  filename: string;
  /** Seconds of speech, from the start of the file to its end. */
  seconds: number;
  /** What it says. Each sentence names the clip, which is how a test knows whose words reached the model. */
  says: string[];
}

const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];

/** `count` files of `seconds` each. `nonce` keeps the ids of one harness from being another's: a run the engine
 *  or the transcript cache still holds for a file is joined by anything that asks for the same id. */
export function wakeFiles(count: number, seconds: number, nonce: number): WakeFile[] {
  const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const word = NUMBER_WORDS[i] ?? String(n);
    const ref = `media_${hex(nonce, 4)}${hex(n, 8)}`;
    return {
      label: `clip-${String(n).padStart(2, "0")}`,
      ref,
      filename: `clip-${String(n).padStart(2, "0")}.wav`,
      seconds,
      says: [
        `Clip ${word} opens on the harbour at dawn.`,
        `The crew of clip ${word} ties the boat to the quay.`,
        `Clip ${word} ends with the lights going out.`,
      ],
    };
  });
}

interface Spoken {
  text: string;
  fromS: number;
  toS: number;
  words: Array<{ text: string; fromS: number; toS: number }>;
}

/** What the file says and when: its sentences spread over its length, their words evenly inside each. */
function speechOf(file: WakeFile): Spoken[] {
  const per = file.seconds / file.says.length;
  return file.says.map((text, i) => {
    const words = text.split(" ");
    const fromS = i * per + 0.5;
    const toS = (i + 1) * per - 0.5;
    const step = (toS - fromS) / words.length;
    return {
      text,
      fromS,
      toS,
      words: words.map((w, k) => ({
        text: w,
        fromS: fromS + k * step,
        toS: fromS + (k + 1) * step,
      })),
    };
  });
}

/** What whisper-cli's `-ojf` writes for the stretch [fromS, toS] of the file, on that stretch's own clock. */
function whisperJson(file: WakeFile, fromS: number, toS: number): string {
  const ms = (s: number): number => Math.round((s - fromS) * 1000);
  const inside = speechOf(file).filter((s) => s.fromS >= fromS && s.toS <= toS);
  return JSON.stringify({
    result: { language: "en" },
    transcription: inside.map((s) => ({
      offsets: { from: ms(s.fromS), to: ms(s.toS) },
      text: ` ${s.text}`,
      tokens: s.words.map((w) => ({
        text: ` ${w.text}`,
        offsets: { from: ms(w.fromS), to: ms(w.toS) },
        p: 0.95,
      })),
    })),
  });
}

const probeJson = (file: WakeFile): string =>
  JSON.stringify({
    streams: [
      {
        index: 0,
        codec_name: "pcm_s16le",
        codec_type: "audio",
        sample_rate: String(SAMPLE_RATE),
        channels: 1,
        channel_layout: "mono",
      },
    ],
    format: {
      format_name: "wav",
      duration: file.seconds.toFixed(6),
      size: String(wavBytes(file.seconds)),
    },
  });

/** What ffmpeg's loudness measure prints (ebur128 and volumedetect), the figures the app reads. */
const LOUDNESS_LOG = [
  "[Parsed_ebur128_0 @ 0000] Summary:",
  "",
  "  Integrated loudness:",
  "    I:         -18.2 LUFS",
  "    Threshold: -28.2 LUFS",
  "",
  "  True peak:",
  "    Peak:       -1.4 dBFS",
  "[Parsed_volumedetect_1 @ 0000] mean_volume: -21.3 dB",
].join("\n");

const valuesAfter = (args: readonly string[], flag: string): string[] =>
  args.flatMap((a, i) => (a === flag && i + 1 < args.length ? [args[i + 1]] : []));
const valueAfter = (args: readonly string[], flag: string): string | undefined =>
  valuesAfter(args, flag)[0];

/** A 16 kHz extract the fake ffmpeg wrote: which file it is of, and which stretch of it. */
const EXTRACT_MARK = "wake-audio:";

export interface EngineObserver {
  /** A run of the engine began on this file's audio. */
  started(file: WakeFile): void;
  /** It ended; `completed` is false when it was cut off. */
  ended(file: WakeFile, completed: boolean): void;
}

export interface Seeding {
  projectDir: string;
  files: readonly WakeFile[];
}

/** The project as the app finds it: the library catalog, the imported media (sizes only), and the speech
 *  model, installed, so no download is ever asked for. Returns where each file lives. */
export function seedProject(disk: WakeDisk, seeding: Seeding): Map<string, WakeFile> {
  const byPath = new Map<string, WakeFile>();
  const clips = seeding.files.map((file, i) => {
    const path = `library/${file.ref}.wav`;
    const absolute = joinPath(seeding.projectDir, path);
    disk.put(absolute, { size: wavBytes(file.seconds) });
    byPath.set(absolute, file);
    return {
      id: file.ref,
      filename: file.filename,
      path,
      kind: "audio",
      size_bytes: wavBytes(file.seconds),
      added_by: "import_media",
      added_at: 1_763_000_000 + i,
    };
  });
  disk.put(joinPath(seeding.projectDir, "internals/library.json"), {
    text: JSON.stringify({ clips }, null, 2),
  });
  const model = whisperModelPath(seeding.projectDir, "small");
  const spec = WHISPER_MODELS.small;
  disk.put(model, { size: spec.bytes });
  disk.put(`${model}.verified.json`, {
    text: JSON.stringify({ bytes: spec.bytes, sha256: spec.sha256 }),
  });
  return byPath;
}

export interface CommandsConfig {
  disk: WakeDisk;
  files: readonly WakeFile[];
  byPath: ReadonlyMap<string, WakeFile>;
  /** How long one run of the engine takes, in virtual seconds. */
  engineSeconds: (file: WakeFile) => number;
  observer: EngineObserver;
  /** Ends every run at once (the harness is being taken down). */
  lifetime: AbortSignal;
}

/** The programs the speech path runs. ffprobe and ffmpeg answer at once; whisper-cli takes the configured time
 *  per file and writes what whisper writes. A program that is not one of the three is refused and noted. */
export class WakeCommands implements CommandRunner {
  readonly refused: string[] = [];

  constructor(private readonly cfg: CommandsConfig) {}

  async run(program: string, args: string[], signal?: AbortSignal): Promise<CommandResult> {
    if (program === "ffprobe") return this.probe(args);
    if (program === "ffmpeg") return this.ffmpeg(args);
    if (program === "whisper-cli") return this.whisper(args, signal);
    this.refused.push(program);
    return { code: 127, stdout: "", stderr: `${program}: not available in the wake harness` };
  }

  private fail(stderr: string): CommandResult {
    return { code: 1, stdout: "", stderr };
  }

  /** The file a path names, and the stretch of it: a library file whole, or an extract the fake ffmpeg made. */
  private audioOf(path: string): { file: WakeFile; from: number; to: number } | null {
    const whole = this.cfg.byPath.get(joinPath(path));
    if (whole) return { file: whole, from: 0, to: whole.seconds };
    const made = this.cfg.disk.text(path);
    if (!made?.startsWith(EXTRACT_MARK)) return null;
    const note = JSON.parse(made.slice(EXTRACT_MARK.length)) as {
      ref: string;
      from: number;
      to: number;
    };
    const file = this.cfg.files.find((f) => f.ref === note.ref);
    return file ? { file, from: note.from, to: note.to } : null;
  }

  private probe(args: string[]): CommandResult {
    const file = this.cfg.byPath.get(joinPath(args[args.length - 1] ?? ""));
    if (!file) return this.fail("No such file or directory");
    return { code: 0, stdout: probeJson(file), stderr: "" };
  }

  private async ffmpeg(args: string[]): Promise<CommandResult> {
    if (valueAfter(args, "-af")?.includes("ebur128"))
      return { code: 0, stdout: "", stderr: LOUDNESS_LOG };
    if (!args.includes("-ar")) return { code: 0, stdout: "", stderr: "" };
    // A 16 kHz extract: ffmpeg reads from `-ss` to `-to` of its input and writes the last argument.
    const input = this.audioOf(valueAfter(args, "-i") ?? "");
    if (!input) return this.fail("Invalid data found when processing input");
    const from = input.from + Number(valueAfter(args, "-ss") ?? 0);
    const upTo = valueAfter(args, "-to");
    const to = upTo === undefined ? input.to : Math.min(input.to, input.from + Number(upTo));
    this.cfg.disk.put(args[args.length - 1], {
      text: `${EXTRACT_MARK}${JSON.stringify({ ref: input.file.ref, from, to })}`,
      size: wavBytes(to - from),
    });
    return { code: 0, stdout: "", stderr: "" };
  }

  private async whisper(args: string[], signal?: AbortSignal): Promise<CommandResult> {
    const inputs = valuesAfter(args, "-f");
    const outputs = valuesAfter(args, "-of");
    let stderr = "";
    for (const [i, wav] of inputs.entries()) {
      const audio = this.audioOf(wav);
      if (!audio) return this.fail(`error: failed to read audio data from '${wav}'`);
      const seconds = this.cfg.engineSeconds(audio.file);
      this.cfg.observer.started(audio.file);
      const stopped = await this.sleep(seconds * 1000, signal, this.cfg.lifetime);
      this.cfg.observer.ended(audio.file, !stopped);
      if (stopped) return this.fail("cancelled");
      await this.cfg.disk.writeTextFile(
        `${outputs[i]}.json`,
        whisperJson(audio.file, audio.from, audio.to),
      );
      const audioS = audio.to - audio.from;
      stderr +=
        `main: processing '${wav}' (${Math.round(audioS * SAMPLE_RATE)} samples, ${audioS.toFixed(1)} sec), 8 threads, 1 processors\n` +
        `whisper_print_timings:    total time = ${(seconds * 1000).toFixed(2)} ms\n`;
    }
    return { code: 0, stdout: "", stderr };
  }

  /** Waits `ms` of virtual time; true when a signal ended the wait first. */
  private sleep(ms: number, ...signals: Array<AbortSignal | undefined>): Promise<boolean> {
    const live = signals.filter((s): s is AbortSignal => s !== undefined);
    if (live.some((s) => s.aborted)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (stopped: boolean): void => {
        clearTimeout(timer);
        for (const s of live) s.removeEventListener("abort", onAbort);
        resolve(stopped);
      };
      const onAbort = (): void => finish(true);
      const timer = setTimeout(() => finish(false), ms);
      for (const s of live) s.addEventListener("abort", onAbort, { once: true });
    });
  }
}
