// A small stand-in for the project store and the command runner, for tests that drive the REAL transcription
// path (`runWhisper`, `ensureTranscripts`, the work folder, the one-run-per-file join, the app cache) with a
// fake engine whose answers the test scripts. Modelled on the rig of transcribeBatchRun.test.ts, kept apart
// so several test files can share it.
import { vi } from "vitest";

import type { ClientToolContext } from "../tools/context";
import { WHISPER_MODELS, whisperModelPath } from "../tools/transcribe";

export const DIR = "C:/data/projects/p1";
export const WORK = "C:/Users/u/AppData/Local/com.artdaddy.app/work/launch-1-1";
export const MODEL = whisperModelPath(DIR, "small");

/** whisper's `-ojf` output for one clip that says `text`. */
export const transcriptJson = (text: string, language = "en"): string =>
  JSON.stringify({
    result: { language },
    transcription: [
      {
        offsets: { from: 0, to: 1000 },
        text: ` ${text}`,
        tokens: [{ text: ` ${text}`, offsets: { from: 0, to: 1000 }, p: 0.9 }],
      },
    ],
  });

export const flagValues = (args: readonly string[], flag: string): string[] =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

/** The bytes of a 16 kHz mono 16-bit WAV file that holds `quietMs` of faint noise and then `voiceMs` of a loud voice-like
 *  signal (bursts of 180 ms, a pause of 60 ms between them), so the speech detector finds the voice at `quietMs`
 *  (exactly, when it is a multiple of 20). Whole-number arithmetic only: what a test expects never depends on a
 *  platform's floating point. */
export function wavWithVoiceAt(quietMs: number, voiceMs = 3000): Uint8Array {
  const rate = 16_000;
  const quiet = Math.round((quietMs * rate) / 1000);
  const total = quiet + Math.round((voiceMs * rate) / 1000);
  const bytes = new Uint8Array(44 + 2 * total);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string): void =>
    [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + 2 * total, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 2 * total, true);
  let state = 12345;
  for (let i = 0; i < total; i++) {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    const noise = (state >> 15) - 32768; // -32768 .. 32767
    const inVoice = i >= quiet && (i - quiet) % 3840 < 2880; // 240 ms periods: 180 ms of voice, 60 ms of pause
    const sample = inVoice
      ? (Math.floor(i / 40) % 2 === 0 ? 9000 : -9000) + (noise >> 4)
      : (noise * 12 + 16384) >> 15;
    view.setInt16(44 + 2 * i, sample, true);
  }
  return bytes;
}

export interface EngineAnswer {
  code: number;
  stdout?: string;
  stderr?: string;
}

export interface SpeechRigOptions {
  /** What the engine does for a launch that the runner path starts (no job supervisor): by default it
   *  writes the output of every file it is given and exits 0. */
  engine?: (launch: number, args: string[], signal?: AbortSignal) => Promise<EngineAnswer>;
  /** How many seconds of audio each extract holds (its size is 44 bytes of header and 32,000 a second).
   *  Absent: the extracts are empty files, whose length cannot be told. */
  audioSeconds?: number;
  /** The audio each extract holds, as its WAV bytes, for tests of what a launch does with the audio it hears: `null` is a
   *  file that cannot be read. Absent: the store has no ranged read at all, as a build without one. */
  audio?: (source: string, wav: string) => Uint8Array | null;
}

let seq = 0;
/** A clip nobody has asked about: a run still joinable from another test is never joined. */
export const freshSource = (): string => `/media/rig-${++seq}.mp4`;

export function speechRig(options: SpeechRigOptions = {}) {
  const files = new Set<string>([MODEL]);
  const texts = new Map<string, string>();
  const kept = new Map<string, unknown>();
  const wavSource = new Map<string, string>();
  const sizes = new Map<string, number>();
  /** Every program the page's own runner was asked to run, in order. */
  const programs: string[] = [];
  /** The arguments of every whisper-cli launch the runner path made. */
  const launches: string[][] = [];
  const store = {
    projectDir: DIR,
    fileIdentity: async (src: string) => `file:${src}`,
    appCache: async () => ({
      get: async (ns: string, key: string) => kept.get(`${ns}|${key}`) ?? null,
      put: async (ns: string, key: string, value: unknown) => (
        kept.set(`${ns}|${key}`, value),
        true
      ),
    }),
    prepareWork: async (rel: string) => `${WORK}/${rel}`,
    exists: async (p: string) => files.has(p),
    readText: async (p: string) => texts.get(p) ?? "",
    writeText: async (p: string, s: string) => (files.add(p), void texts.set(p, s)),
    canRename: true,
    rename: async (from: string, to: string) => {
      files.delete(from);
      files.add(to);
      const src = wavSource.get(from);
      if (src) wavSource.set(to, src);
      const size = sizes.get(from);
      if (size !== undefined) sizes.set(to, size);
    },
    remove: async (p: string) => void files.delete(p),
    byteSize: async (p: string) => sizes.get(p) ?? (p === MODEL ? WHISPER_MODELS.small.bytes : 0),
    ...(options.audio
      ? {
          readHead: async (p: string, maxBytes: number): Promise<Uint8Array | null> => {
            const source = wavSource.get(p);
            const bytes = source === undefined ? null : options.audio!(source, p);
            return bytes === null ? null : bytes.subarray(0, maxBytes);
          },
        }
      : {}),
    probeMedia: async () => ({
      id12: WHISPER_MODELS.small.sha256.slice(0, 12),
      sha256: WHISPER_MODELS.small.sha256,
      size: WHISPER_MODELS.small.bytes,
      head: new Uint8Array(),
    }),
    canStreamDownload: true,
    appendBytes: async () => true,
    resolveRef: async (r: string) => r,
    offlineMedia: async () => null,
  };
  /** The clip an audio file was extracted from. */
  const sourceOf = (wav: string): string | undefined => wavSource.get(wav);
  /** What an engine process does with its files: writes the output of each. */
  const writeOutputs = (args: readonly string[]): void => {
    const ins = flagValues(args, "-f");
    const outs = flagValues(args, "-of");
    ins.forEach((wav, place) => {
      const source = wavSource.get(wav);
      if (!files.has(wav) || !source) return;
      const out = `${outs[place]}.json`;
      files.add(out);
      texts.set(out, transcriptJson(`clip of ${source.split("/").pop()}`));
    });
  };
  const runner = {
    run: vi.fn(async (program: string, args: string[], signal?: AbortSignal) => {
      programs.push(program);
      if (program === "ffmpeg") {
        const out = args[args.length - 1];
        files.add(out);
        wavSource.set(out, args[args.indexOf("-i") + 1]);
        if (options.audioSeconds !== undefined) sizes.set(out, 44 + 32_000 * options.audioSeconds);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (program === "whisper-cli") {
        const launch = launches.length;
        launches.push(args);
        const answer = options.engine
          ? await options.engine(launch, args, signal)
          : { code: 0, stdout: "", stderr: "" };
        if (answer.code === 0) writeOutputs(args);
        return { code: answer.code, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }),
  };
  const ctx = (over: Partial<ClientToolContext> = {}): ClientToolContext =>
    ({ store, runner, ...over }) as unknown as ClientToolContext;
  return {
    store,
    runner,
    ctx,
    files,
    texts,
    kept,
    programs,
    launches,
    sourceOf,
    writeOutputs,
    /** What is left in the app's work folder: audio and scratch output nobody cleaned up. */
    leftovers: (): string[] => [...files].filter((p) => p.startsWith(`${WORK}/`)),
  };
}
