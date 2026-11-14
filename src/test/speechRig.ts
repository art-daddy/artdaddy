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

export interface EngineAnswer {
  code: number;
  stdout?: string;
  stderr?: string;
}

export interface SpeechRigOptions {
  /** What the engine does for a launch that the runner path starts (no job supervisor): by default it
   *  writes the output of every file it is given and exits 0. */
  engine?: (launch: number, args: string[], signal?: AbortSignal) => Promise<EngineAnswer>;
}

let seq = 0;
/** A clip nobody has asked about: a run still joinable from another test is never joined. */
export const freshSource = (): string => `/media/rig-${++seq}.mp4`;

export function speechRig(options: SpeechRigOptions = {}) {
  const files = new Set<string>([MODEL]);
  const texts = new Map<string, string>();
  const kept = new Map<string, unknown>();
  const wavSource = new Map<string, string>();
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
    },
    remove: async (p: string) => void files.delete(p),
    byteSize: async (p: string) => (p === MODEL ? WHISPER_MODELS.small.bytes : 0),
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
