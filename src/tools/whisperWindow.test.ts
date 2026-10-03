// Whisper is the most expensive thing the app runs, so what it is ASKED to do matters more
// than what we do with the answer. These drive runWhisper's real argument/caching logic.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runWhisper, WHISPER_MODELS, whisperModelPath } from "./transcribe";
import type { ClientToolContext } from "./context";

const DIR = "C:/data/projects/p1";

const WHISPER_JSON = JSON.stringify({
  transcription: [{ offsets: { from: 60000, to: 62000 }, text: "hello", tokens: [] }],
});

function harness(opts: { failWhisper?: number } = {}) {
  // The model is already downloaded; this exercises the RUN, not the fetch.
  const files = new Set<string>([whisperModelPath(DIR, "small"), whisperModelPath(DIR, "base")]);
  const texts = new Map<string, string>();
  const calls: { program: string; args: string[] }[] = [];
  let whisperFailures = opts.failWhisper ?? 0;
  const ctx = {
    store: {
      projectDir: DIR,
      prepareArtifact: async (rel: string) => `${DIR}/internals/cache/${rel}`,
      exists: async (p: string) => files.has(p),
      readText: async (p: string) => texts.get(p) ?? WHISPER_JSON,
      writeText: async (p: string, s: string) => {
        files.add(p);
        texts.set(p, s);
      },
      byteSize: async () => WHISPER_MODELS.small.bytes,
      probeMedia: async () => ({
        id12: WHISPER_MODELS.small.sha256.slice(0, 12),
        sha256: WHISPER_MODELS.small.sha256,
        size: WHISPER_MODELS.small.bytes,
        head: new Uint8Array(),
      }),
      resolveRef: async (r: string) => r,
    },
    runner: {
      run: async (program: string, args: string[]) => {
        calls.push({ program, args });
        if (program === "whisper-cli") {
          if (whisperFailures > 0) {
            whisperFailures--;
            return { code: 1, stdout: "", stderr: "interrupted" };
          }
          // Like the real binary: offsets count from the start of the file it READ, moved by
          // `-ot` when given. "hello" is spoken 0 s into whatever it was handed (plus -ot).
          const from = Number(argVal(args, "-ot") ?? 0);
          const json = JSON.stringify({
            transcription: [{ offsets: { from, to: from + 2000 }, text: "hello", tokens: [] }],
          });
          const out = `${args[args.indexOf("-of") + 1]}.json`;
          files.add(out);
          texts.set(out, json);
        } else files.add(args[args.length - 1]); // ffmpeg writes its last argument
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as ClientToolContext;
  return { ctx, calls, files };
}

/** The whisper invocation (not the wav extraction). */
const whisperCall = (calls: { program: string; args: string[] }[]) =>
  calls.find((c) => c.program === "whisper-cli");

const argVal = (args: string[], flag: string): string | undefined =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

beforeEach(() => {
  vi.unstubAllGlobals();
});
describe("runWhisper", () => {
  // UJ-012: a window used to extract the WHOLE file's audio first, so 30 s of a 2-hour file
  // waited on 2 hours of decoding. The work is bounded by what whisper is handed.
  it("bounds the WORK to the window: only the window's audio is extracted, and whisper reads that", async () => {
    const { ctx, calls } = harness();
    await runWhisper(ctx, "/m/a.mp4", "small", undefined, { start: 12.5, end: 42 });
    const ff = calls.filter((c) => c.program === "ffmpeg");
    expect(ff).toHaveLength(1);
    expect(argVal(ff[0].args, "-ss")).toBe("12.500");
    expect(argVal(ff[0].args, "-to")).toBe("42.000");
    const w = whisperCall(calls)!;
    expect(argVal(w.args, "-f"), "whisper reads the window's own extract").toBe(ff[0].args.at(-1));
    expect(w.args).not.toContain("-ot"); // the file IS the window
  });

  it("bounds the WORK to the window on the whole file's extract when one is already on disk, in milliseconds", async () => {
    // A whole-file run that extracted the audio and then failed leaves the extract behind.
    const { ctx, calls } = harness({ failWhisper: 1 });
    await expect(runWhisper(ctx, "/m/a.mp4")).rejects.toThrow(/whisper-cli failed/);
    const fullWav = calls.find((c) => c.program === "ffmpeg")!.args.at(-1);
    calls.length = 0;
    await runWhisper(ctx, "/m/a.mp4", "small", undefined, { start: 12.5, end: 42 });
    expect(calls.filter((c) => c.program === "ffmpeg"), "nothing is extracted twice").toHaveLength(0);
    const w = whisperCall(calls)!;
    expect(argVal(w.args, "-f")).toBe(fullWav);
    expect(argVal(w.args, "-ot"), "offset must be ms from the source start").toBe("12500");
    expect(argVal(w.args, "-d"), "duration must be the window LENGTH, not its end").toBe("29500");
  });

  it("asks for the whole file when no window is given", async () => {
    const { ctx, calls } = harness();
    await runWhisper(ctx, "/m/a.mp4");
    const w = whisperCall(calls);
    expect(w!.args).not.toContain("-ot");
    expect(w!.args).not.toContain("-d");
  });

  it("never serves a WINDOWED transcript to a full-file request", async () => {
    const { ctx, calls } = harness();
    await runWhisper(ctx, "/m/a.mp4", "small", undefined, { start: 10, end: 20 });
    await runWhisper(ctx, "/m/a.mp4", "small");
    const outs = calls.filter((c) => c.program === "whisper-cli").map((c) => argVal(c.args, "-of"));
    expect(new Set(outs).size, "the window has to be part of the cache key").toBe(2);
  });

  it("reuses a FULL transcript for a windowed ask instead of re-running", async () => {
    const { ctx, calls } = harness();
    await runWhisper(ctx, "/m/a.mp4", "small"); // full run, now cached
    const before = calls.length;
    await runWhisper(ctx, "/m/a.mp4", "small", undefined, { start: 5, end: 9 });
    expect(calls.length, "a full transcript already answers every window").toBe(before);
  });

  it("uses the machine's cores rather than whisper's default of 4", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 16 });
    const { ctx, calls } = harness();
    await runWhisper(ctx, "/m/a.mp4");
    expect(argVal(whisperCall(calls)!.args, "-t")).toBe("8");
  });

  it("does not oversubscribe a small machine", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 2 });
    const { ctx, calls } = harness();
    await runWhisper(ctx, "/m/a.mp4");
    expect(Number(argVal(whisperCall(calls)!.args, "-t"))).toBeGreaterThanOrEqual(1);
    expect(Number(argVal(whisperCall(calls)!.args, "-t"))).toBeLessThanOrEqual(2);
  });

  // The failure this guards is the expensive one: the background indexer and inspect_media
  // both wanting the same file, neither seeing a transcript yet, and the machine running two
  // identical 20-minute jobs.
  it("runs ONE whisper when two callers race for the same file", async () => {
    const { ctx, calls } = harness();
    const [a, b] = await Promise.all([runWhisper(ctx, "/m/a.mp4"), runWhisper(ctx, "/m/a.mp4")]);
    expect(calls.filter((c) => c.program === "whisper-cli")).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("never lets two extractions write one file when two different windows race", async () => {
    const { ctx, calls } = harness();
    await Promise.all([
      runWhisper(ctx, "/m/a.mp4", "small", undefined, { start: 0, end: 5 }),
      runWhisper(ctx, "/m/a.mp4", "small", undefined, { start: 90, end: 95 }),
    ]);
    // Two ffmpegs writing the same path concurrently is a corrupt wav. Each window reads its own.
    const outs = calls.filter((c) => c.program === "ffmpeg").map((c) => c.args.at(-1));
    expect(outs).toHaveLength(2);
    expect(new Set(outs).size).toBe(2);
    expect(calls.filter((c) => c.program === "whisper-cli")).toHaveLength(2);
  });

  it("runs ONE extraction and ONE whisper when the same window is asked for twice at once", async () => {
    const { ctx, calls } = harness();
    const [a, b] = await Promise.all([
      runWhisper(ctx, "/m/a.mp4", "small", undefined, { start: 30, end: 40 }),
      runWhisper(ctx, "/m/a.mp4", "small", undefined, { start: 30, end: 40 }),
    ]);
    expect(calls.filter((c) => c.program === "ffmpeg")).toHaveLength(1);
    expect(calls.filter((c) => c.program === "whisper-cli")).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("keeps the source timeline: a window's words land where they are in the FILE", async () => {
    // Own extract: whisper counts from the window's start, so the times are moved by it.
    const own = harness();
    const t1 = await runWhisper(own.ctx, "/m/a.mp4", "small", undefined, { start: 60, end: 62 });
    expect(t1.segments[0]?.start_seconds).toBeCloseTo(60, 3);
    // On the whole file's extract, `-ot 60000` already reports from 60000 (verified against the
    // real binary): moving them again would put every caption a minute late.
    const shared = harness({ failWhisper: 1 });
    await expect(runWhisper(shared.ctx, "/m/a.mp4")).rejects.toThrow();
    const t2 = await runWhisper(shared.ctx, "/m/a.mp4", "small", undefined, { start: 60, end: 62 });
    expect(t2.segments[0]?.start_seconds).toBeCloseTo(60, 3);
  });
});
