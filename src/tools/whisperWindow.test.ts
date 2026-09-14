// Whisper is the most expensive thing the app runs, so what it is ASKED to do matters more
// than what we do with the answer. These drive runWhisper's real argument/caching logic.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runWhisper, whisperModelPath } from "./transcribe";
import type { ClientToolContext } from "./context";

const DIR = "C:/data/projects/p1";

const WHISPER_JSON = JSON.stringify({
  transcription: [{ offsets: { from: 60000, to: 62000 }, text: "hello", tokens: [] }],
});

function harness() {
  // The model is already downloaded; this exercises the RUN, not the fetch.
  const files = new Set<string>([whisperModelPath(DIR, "small"), whisperModelPath(DIR, "base")]);
  const calls: { program: string; args: string[] }[] = [];
  const ctx = {
    store: {
      projectDir: DIR,
      prepareArtifact: async (rel: string) => `${DIR}/internals/cache/${rel}`,
      exists: async (p: string) => files.has(p),
      readText: async () => WHISPER_JSON,
      resolveRef: async (r: string) => r,
    },
    runner: {
      run: async (program: string, args: string[]) => {
        calls.push({ program, args });
        // whisper writes `<-of>.json`; ffmpeg writes its last argument.
        if (program === "whisper-cli") files.add(`${args[args.indexOf("-of") + 1]}.json`);
        else files.add(args[args.length - 1]);
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
  it("bounds the WORK to the window, in milliseconds", async () => {
    const { ctx, calls } = harness();
    await runWhisper(ctx, "/m/a.mp4", "small", undefined, { start: 12.5, end: 42 });
    const w = whisperCall(calls);
    expect(argVal(w!.args, "-ot"), "offset must be ms from the source start").toBe("12500");
    expect(argVal(w!.args, "-d"), "duration must be the window LENGTH, not its end").toBe("29500");
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

  it("extracts the wav ONCE when two different windows race", async () => {
    const { ctx, calls } = harness();
    await Promise.all([
      runWhisper(ctx, "/m/a.mp4", "small", undefined, { start: 0, end: 5 }),
      runWhisper(ctx, "/m/a.mp4", "small", undefined, { start: 90, end: 95 }),
    ]);
    // Two whisper runs (different windows) but a single shared 16 kHz extract — two ffmpegs
    // writing the same path concurrently is a corrupt wav.
    expect(calls.filter((c) => c.program === "ffmpeg")).toHaveLength(1);
    expect(calls.filter((c) => c.program === "whisper-cli")).toHaveLength(2);
  });

  it("keeps the source timeline: a windowed run's times are NOT shifted", async () => {
    // Verified against the real binary: `-ot 60000` makes whisper report offsets that already
    // start at 60000. Re-basing them here would move every caption.
    const { ctx } = harness();
    const t = await runWhisper(ctx, "/m/a.mp4", "small", undefined, { start: 60, end: 62 });
    expect(t.segments[0]?.start_seconds).toBeCloseTo(60, 3);
  });
});
