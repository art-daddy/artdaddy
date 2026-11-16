// Which model file a run is made with, through the REAL transcription path (runWhisper, ensureTranscripts, the
// model check, the launch boundary, the commit point, the app cache) with a fake engine whose answers I script.
// What is checked is what the engine is launched with and what ends up kept, never how speechModel.ts decides:
//
//   * the smaller file (q8_0) is only ever launched on the processor, the launch with `-ng`, whatever the PC's
//     chip did before the plan or between the plan and the launch;
//   * a language the gate did not clear on the processor (Arabic, and every language it has no row for) is never
//     transcribed with the smaller file, and a transcript made with a file its language does not allow is never kept;
//   * a PC that transcribes on a chip, and every PC that already holds the full-size file, is run as it always was.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportAppError, reportTranscription } = vi.hoisted(() => ({
  reportAppError: vi.fn(),
  reportTranscription: vi.fn(),
}));
vi.mock("../api/appEvents", async (orig) => ({
  ...(await orig<object>()),
  reportAppError,
  reportTranscription,
}));
vi.mock("@tauri-apps/api/path", () => ({ resolveResource: async () => "C:/res/fonts" }));

// The last check on the arguments about to be spawned, recorded as it passes. Whatever the engine is started with in
// the scenarios below must be arguments that check passed: a process started any other way (a second spawner that
// names the program through a constant, say, which no search of the source for the program's name would find) is
// seen here by what it did, not by what it is spelled like.
const lastCheck = vi.hoisted(() => ({ passed: [] as string[][], unchecked: [] as string[][] }));
vi.mock("./speechModel", async (orig) => {
  const real = await orig<typeof import("./speechModel")>();
  return {
    ...real,
    assertLaunchArgv: (argv: readonly string[]) => {
      real.assertLaunchArgv(argv); // a launch the manifest does not allow throws: it is never recorded as passed
      lastCheck.passed.push([...argv]);
    },
  };
});
const wasChecked = (argv: readonly string[]): boolean =>
  lastCheck.passed.some((seen) => JSON.stringify(seen) === JSON.stringify(argv));

import type { ClientToolContext } from "./context";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { __resetHostInfo } from "../platform/host";
import { MODEL_MANIFEST, primaryUrl } from "./modelManifest";
import { cpuOnlyNow, holdCpuOnly, releaseCpuOnly, SPEECH_CPU_ONLY_KEY } from "./speechBackend";
import { beamFor, DEFAULT_BEAM } from "./speechDecoding";
import { TranscriptionFailure } from "./speechFailure";
import { assertLaunchArgv, processorBeam } from "./speechModel";
import { recordSpeechRun } from "./speechPace";
import { __resetWordTimesShipped, __setWordTimesShipped, DTW_ARGS } from "./speechWordTimes";
import {
  __resetModelDownloads,
  __resetSmallerFileFailure,
  __setDownloadPolicy,
  ensureLaunchModel,
  ensureTranscripts,
  PATIENT_DOWNLOAD,
  peekTranscript,
  runWhisper,
  SINGLE_ATTEMPT,
  WHISPER_MODELS,
  whisperModelPath,
} from "./transcribe";
import { WHISPER_LANGUAGES } from "./whisperLanguages";
import { __resetWorkGate } from "./workGate";

const DIR = "C:/data/projects/p1";
const WORK = "C:/Users/u/AppData/Local/com.artdaddy.app/work/launch-1-1";
/** The manifest keys of the two files. */
const FULL = "small";
const SMALL = "small_q8_0";
const pathOf = (key: string): string => whisperModelPath(DIR, key);
const CODES = Object.keys(WHISPER_LANGUAGES);
const ENGINE_CRASH = -1073740791; // 0xC0000409, the crash the graphics chip is known for
const VULKAN_LOG =
  "ggml_vulkan: Found 1 Vulkan devices:\nggml_vulkan: 0 = Radeon (AMD proprietary driver)";

const json = (language: string, text: string): string =>
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

interface Say {
  language: string;
  text?: string;
}
/** What a launch of the stand-in engine ends with. */
interface EngineAnswer {
  code: number;
  stderr?: string;
  /** Leaves no output file, whatever the exit code says: with code 0, a clean exit with no transcript. */
  noOutput?: boolean;
  /** With code 0, leaves an output that stops in the middle: a run that died while writing it. */
  cutShort?: boolean;
}
interface RigOptions {
  /** The manifest keys whose file is on disk. Absent: both. */
  installed?: readonly string[];
  /** What the engine says it heard, per launch and clip. Absent: English. */
  say?: (launch: number, args: string[], clip: string) => Say;
  engine?: (launch: number, args: string[]) => EngineAnswer;
  /** Every launch waits for this before it answers: a run that is still going. */
  gate?: Promise<void>;
  /** Runs when the audio is extracted: after the plan, before the launch. */
  onExtract?: () => void;
  background?: boolean;
}

const flagValues = (args: readonly string[], flag: string): string[] =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const modelOf = (args: readonly string[]): string => flagValues(args, "-m")[0];
const beamOf = (args: readonly string[]): number =>
  args.includes("-bs") ? Number(flagValues(args, "-bs")[0]) : DEFAULT_BEAM;
const onProcessor = (args: readonly string[]): boolean => args.includes("-ng");

function rig(options: RigOptions = {}) {
  const files = new Set<string>();
  const texts = new Map<string, string>();
  const kept = new Map<string, unknown>();
  const wavSource = new Map<string, string>();
  const launches: string[][] = [];
  const specs = new Map(Object.entries(WHISPER_MODELS).map(([key, spec]) => [pathOf(key), spec]));
  for (const key of options.installed ?? [FULL, SMALL]) files.add(pathOf(key));
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
    byteSize: async (p: string) => specs.get(p)?.bytes ?? 0,
    probeMedia: async (p: string) => {
      const spec = specs.get(p);
      return {
        id12: (spec?.sha256 ?? "").slice(0, 12),
        sha256: spec?.sha256 ?? "",
        size: spec?.bytes ?? 0,
        head: new Uint8Array(),
      };
    },
    canStreamDownload: true,
    appendBytes: async () => true,
    resolveRef: async (r: string) => r,
    offlineMedia: async () => null,
  };
  const runner = {
    run: async (program: string, args: string[]) => {
      if (program === "ffmpeg") {
        const out = args[args.length - 1];
        files.add(out);
        wavSource.set(out, args[args.indexOf("-i") + 1]);
        options.onExtract?.();
        return { code: 0, stdout: "", stderr: "" };
      }
      const launch = launches.length;
      launches.push(args);
      if (!wasChecked(args)) lastCheck.unchecked.push(args);
      await options.gate;
      const answer = options.engine?.(launch, args) ?? { code: 0 };
      if (answer.code === 0 && answer.noOutput !== true) {
        const outs = flagValues(args, "-of");
        flagValues(args, "-f").forEach((wav, place) => {
          const source = wavSource.get(wav);
          if (!source) return;
          const said = options.say?.(launch, args, source) ?? { language: "en" };
          const out = `${outs[place]}.json`;
          files.add(out);
          const whole = json(said.language, said.text ?? `launch ${launch}`);
          texts.set(out, answer.cutShort === true ? whole.slice(0, 12) : whole);
        });
      }
      return { code: answer.code, stdout: "", stderr: answer.stderr ?? "" };
    },
  };
  const ctx = { store, runner, background: options.background } as unknown as ClientToolContext;
  return {
    ctx,
    launches,
    files,
    kept,
    words: async (src: string, language: string): Promise<string> =>
      ((await peekTranscript(ctx, src, "small", language)) ?? { words: [] }).words
        .map((w) => w.word)
        .join(" "),
  };
}

let seq = 0;
/** A clip nobody has asked about: a run still joinable from another test is never joined. */
const fresh = (): string => `/media/model-${++seq}.mp4`;

/** A PC with no usable chip: the engine's own log said so on its latest run, and no hold is kept. */
const noChip = (): void => recordSpeechRun(60, 120, "cpu");
/** A PC whose chip crashed: the app keeps it off for a while. */
const chipHeldOff = (): void => holdCpuOnly(ENGINE_CRASH);
/** A PC whose latest run used its chip. */
const chipWorks = (): void => recordSpeechRun(60, 6, "gpu");

const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
/** The app's idea of the PC's operating system, which is what a PC with no history is assumed to be. */
const hostIs = (userAgent: string): void => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  __resetHostInfo();
};

const fetchedUrls: string[] = [];
beforeEach(() => {
  localStorage.clear();
  lastCheck.passed.length = 0;
  lastCheck.unchecked.length = 0;
  __resetWorkGate();
  // An install a test left running (a failed assertion before its Cancel) must not make the next one wait for it.
  __resetModelDownloads();
  __resetSmallerFileFailure();
  __setDownloadPolicy(SINGLE_ATTEMPT);
  hostIs(WINDOWS_UA);
  fetchedUrls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      fetchedUrls.push(String(url));
      throw new Error("offline");
    }),
  );
  reportAppError.mockClear();
  reportTranscription.mockClear();
});
afterEach(() => {
  const unchecked = lastCheck.unchecked.slice();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetHostInfo();
  __resetWordTimesShipped();
  __resetExportFlags();
  __setDownloadPolicy(PATIENT_DOWNLOAD);
  // Whatever scenario ran, the engine was only ever started with arguments the last check had passed.
  expect(unchecked, "the engine was started with arguments the last check never saw").toEqual([]);
});

describe("a PC that transcribes on its processor, with both files on disk", () => {
  for (const [how, setUp] of [
    ["has no usable chip", noChip],
    ["has its chip held off after a crash", chipHeldOff],
  ] as const) {
    it(`runs the smaller file for a language the gate cleared, at the beam it cleared, on the processor (${how})`, async () => {
      setUp();
      const english = rig();
      await runWhisper(english.ctx, fresh(), "small", "en");
      expect(english.launches).toHaveLength(1);
      expect(modelOf(english.launches[0])).toBe(pathOf(SMALL));
      expect(onProcessor(english.launches[0])).toBe(true);
      expect(beamOf(english.launches[0])).toBe(1);

      const dutch = rig();
      await runWhisper(dutch.ctx, fresh(), "small", "nl");
      expect(modelOf(dutch.launches[0])).toBe(pathOf(SMALL));
      expect(onProcessor(dutch.launches[0])).toBe(true);
      expect(beamOf(dutch.launches[0])).toBe(DEFAULT_BEAM);
    });

    it(`runs the full-size file for Arabic and for a language the gate has no row for (${how})`, async () => {
      setUp();
      for (const language of ["ar", "th", "he"]) {
        const r = rig();
        await runWhisper(r.ctx, fresh(), "small", language);
        expect(r.launches).toHaveLength(1);
        expect(modelOf(r.launches[0])).toBe(pathOf(FULL));
        expect(beamOf(r.launches[0])).toBe(beamFor("f16", language));
      }
    });
  }

  it("never launches the smaller file for a language the gate did not clear, and never without -ng, for ANY language the engine knows", async () => {
    noChip();
    for (const code of CODES) {
      const r = rig();
      await runWhisper(r.ctx, fresh(), "small", code);
      expect(r.launches, code).toHaveLength(1);
      const [launch] = r.launches;
      const needed = processorBeam(code);
      if (modelOf(launch) === pathOf(SMALL)) {
        expect(onProcessor(launch), `${code} on the smaller file`).toBe(true);
        expect(needed, `${code} was not cleared for the smaller file`).not.toBeNull();
        expect(beamOf(launch), `${code} narrower than it was cleared at`).toBeGreaterThanOrEqual(
          needed ?? DEFAULT_BEAM,
        );
      } else {
        expect(modelOf(launch)).toBe(pathOf(FULL));
        // The file's own decoding is what it always was.
        expect(beamOf(launch), code).toBe(beamFor("f16", code));
      }
      // And the other way: a cleared language does get the smaller file when both are here.
      expect(modelOf(launch) === pathOf(SMALL), `${code} cleared: ${needed}`).toBe(needed !== null);
    }
  });

  it("keeps the file even when the chip comes back between the plan and the launch", async () => {
    // The plan is made while the chip is held off; the hold ends while the audio is being extracted.
    chipHeldOff();
    const r = rig({ onExtract: () => releaseCpuOnly() });
    await runWhisper(r.ctx, fresh(), "small", "en");
    expect(cpuOnlyNow()).toBe(false);
    expect(r.launches).toHaveLength(1);
    expect(modelOf(r.launches[0])).toBe(pathOf(SMALL));
    expect(onProcessor(r.launches[0])).toBe(true);
  });

  it("does not take a crash of the smaller file's launch for the chip's, and keeps no hold for it", async () => {
    noChip();
    // Only the smaller file's launch crashes (with the chip's own signature in its log): it never had the chip on.
    const r = rig({
      engine: (_launch, args) =>
        modelOf(args) === pathOf(SMALL) ? { code: ENGINE_CRASH, stderr: VULKAN_LOG } : { code: 0 },
    });
    const kept = await runWhisper(r.ctx, fresh(), "small", "en");
    // The smaller file's launch is not retried "with the chip off" (it was a processor launch from the start); the
    // request goes on with the full-size file, once (see the next describe).
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(FULL)]);
    expect(onProcessor(r.launches[0])).toBe(true);
    expect(cpuOnlyNow()).toBe(false);
    expect(localStorage.getItem(SPEECH_CPU_ONLY_KEY)).toBeNull();
    expect(kept.words.map((w) => w.word).join(" ")).toBe("launch 1");
  });
});

// The net under the smaller file (RM-006): it was never run on a Linux PC, and on Linux it is the default. When the
// engine itself fails on it (it cannot load it, it crashes, it leaves nothing), the request is run once more with the
// full-size file, which every language accepts; nothing else changes: the smaller file is still only ever started with
// -ng, nothing wrong is kept, and the runs never loop.
describe("when the engine fails on the smaller file", () => {
  const FAILURES: Array<[how: string, answer: EngineAnswer]> = [
    ["it cannot load the file", { code: 1, stderr: "failed to load model" }],
    ["it crashes", { code: ENGINE_CRASH, stderr: VULKAN_LOG }],
    ["it exits cleanly and leaves no transcript", { code: 0, noOutput: true }],
    ["it exits cleanly and leaves a transcript cut short", { code: 0, cutShort: true }],
  ];

  it.each(FAILURES)(
    "the request goes on with the full-size file, once, when %s",
    async (_how, failure) => {
      noChip();
      const r = rig({
        engine: (_launch, args) => (modelOf(args) === pathOf(SMALL) ? failure : { code: 0 }),
      });
      const src = fresh();
      const kept = await runWhisper(r.ctx, src, "small", "en");
      expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(FULL)]);
      expect(onProcessor(r.launches[0])).toBe(true);
      expect(kept.words.map((w) => w.word).join(" ")).toBe("launch 1");
      // The words kept are the full-size file's, under the key that answers the request later.
      expect(await r.words(src, "en")).toBe("launch 1");
    },
  );

  it("is one more run at most: when the full-size file fails too, the failure is the engine's own and nothing is kept", async () => {
    noChip();
    const r = rig({ engine: () => ({ code: 1, stderr: "failed to load model" }) });
    const failure = await runWhisper(r.ctx, fresh(), "small", "en").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TranscriptionFailure);
    expect((failure as TranscriptionFailure).reason).toBe("engine_failed");
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(FULL)]);
    expect(r.kept.size).toBe(0);
  });

  it("asks for the full-size file when only the smaller one is here, and says why plainly when it cannot be fetched", async () => {
    noChip();
    const r = rig({
      installed: [SMALL],
      engine: () => ({ code: 1, stderr: "failed to load model" }),
    });
    const failure = await runWhisper(r.ctx, fresh(), "small", "en").catch((e: unknown) => e);
    expect((failure as TranscriptionFailure).reason).toBe("model_unavailable");
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL)]);
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[FULL]));
    expect(r.kept.size).toBe(0);
  });

  it("remembers it for the rest of the session: the next request goes straight to the full-size file", async () => {
    noChip();
    const r = rig({
      engine: (_launch, args) =>
        modelOf(args) === pathOf(SMALL) ? { code: 1, stderr: "failed to load model" } : { code: 0 },
    });
    await runWhisper(r.ctx, fresh(), "small", "en");
    await runWhisper(r.ctx, fresh(), "small", "en");
    // The smaller file was tried once, and not again.
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(FULL), pathOf(FULL)]);
    // The graphics chip is not involved: the full-size file on this PC is launched as it always was.
    expect(onProcessor(r.launches[2])).toBe(false);
  });

  it("remembers nothing when the full-size file fails too: the file is not to blame, and the next request tries the smaller one first", async () => {
    noChip();
    const r = rig({ engine: () => ({ code: 1, stderr: "failed to load model" }) });
    await runWhisper(r.ctx, fresh(), "small", "en").catch(() => undefined);
    await runWhisper(r.ctx, fresh(), "small", "en").catch(() => undefined);
    expect(r.launches.map(modelOf)).toEqual([SMALL, FULL, SMALL, FULL].map((key) => pathOf(key)));
  });

  it("does not go on when the engine cannot start at all: a missing library is not the model's fault", async () => {
    noChip();
    const STATUS_DLL_NOT_FOUND = -1073741515;
    const r = rig({ engine: () => ({ code: STATUS_DLL_NOT_FOUND, stderr: "" }) });
    const failure = await runWhisper(r.ctx, fresh(), "small", "en").catch((e: unknown) => e);
    expect((failure as TranscriptionFailure).reason).toBe("engine_unavailable");
    expect(r.launches).toHaveLength(1);
  });

  // On Linux, where the net matters most, the loader and the shell say it with exit 126 or 127 and with their own
  // words, not with a Windows status. No model file can cause that, so nothing is fetched for it.
  const COULD_NOT_START: Array<[how: string, answer: EngineAnswer]> = [
    [
      "the loader cannot find a library",
      {
        code: 127,
        stderr:
          "whisper-cli: error while loading shared libraries: libgomp.so.1: cannot open shared object file",
      },
    ],
    ["the shell cannot run the program", { code: 126, stderr: "" }],
    ["the loader says so under another exit code", { code: 1, stderr: "cannot open shared object file" }],
  ];

  it.each(COULD_NOT_START)(
    "does not go on with the full-size file, and fetches nothing, when %s",
    async (_how, failure) => {
      noChip();
      const r = rig({ installed: [SMALL], engine: () => failure });
      const failed = await runWhisper(r.ctx, fresh(), "small", "en").catch((e: unknown) => e);
      expect((failed as TranscriptionFailure).reason).toBe("engine_failed");
      expect(r.launches).toHaveLength(1);
      expect(fetchedUrls).toEqual([]);
    },
  );

  it("is still three runs at most: a refusal, an engine failure on the re-run, then the full-size file", async () => {
    noChip();
    // Guessed English (greedy), heard Dutch (cleared at 5 beams only): refused, run again at 5 beams, and that fails.
    localStorage.setItem("artdaddy.speech_language", "en");
    const r = rig({
      say: () => ({ language: "nl" }),
      engine: (launch) => (launch === 1 ? { code: 1, stderr: "failed to load model" } : { code: 0 }),
    });
    const kept = await runWhisper(r.ctx, fresh(), "small", "auto");
    expect(r.launches.map((a) => [modelOf(a), beamOf(a)])).toEqual([
      [pathOf(SMALL), 1],
      [pathOf(SMALL), 5],
      [pathOf(FULL), DEFAULT_BEAM],
    ]);
    expect(kept.words.map((w) => w.word).join(" ")).toBe("launch 2");
  });

  it("reports a re-run after a refusal as a re-run, and one after an engine failure as an ordinary run", async () => {
    noChip();
    // Guessed English, heard Dutch: refused, then run again at 5 beams: that is what the telemetry's re-run means.
    localStorage.setItem("artdaddy.speech_language", "en");
    const refused = rig({ say: () => ({ language: "nl" }) });
    await runWhisper(refused.ctx, fresh(), "small", "auto");
    expect(reportTranscription).toHaveBeenCalledTimes(1);
    expect(reportTranscription.mock.calls[0][2]).toMatchObject({ beam: 5, rerun: true });

    // The engine failed on the smaller file and the full-size file ran the request: no transcript was refused.
    reportTranscription.mockClear();
    const failed = rig({
      engine: (_launch, args) =>
        modelOf(args) === pathOf(SMALL) ? { code: 1, stderr: "failed to load model" } : { code: 0 },
    });
    await runWhisper(failed.ctx, fresh(), "small", "en");
    expect(reportTranscription).toHaveBeenCalledTimes(1);
    expect(reportTranscription.mock.calls[0][2]).toMatchObject({ beam: DEFAULT_BEAM });
    expect(reportTranscription.mock.calls[0][2].rerun).not.toBe(true);
  });

  // A batch that finds the file already being transcribed joins that run. The run's own caller goes on after an engine
  // failure on the smaller file (or a refusal) by itself; the batch must not be handed that as the file's outcome.
  describe("a batch that joined the run", () => {
    it("is not told the engine failed on the smaller file: it gets the words the run goes on to make", async () => {
      noChip();
      let open!: () => void;
      const r = rig({
        gate: new Promise<void>((resolve) => (open = resolve)),
        engine: (_launch, args) =>
          modelOf(args) === pathOf(SMALL)
            ? { code: 1, stderr: "failed to load model" }
            : { code: 0 },
      });
      const clip = fresh();
      const single = runWhisper(r.ctx, clip, "small", "en");
      await vi.waitFor(() => expect(r.launches).toHaveLength(1));
      const batch = ensureTranscripts(r.ctx, [clip], "small", "en");
      // The batch finds the run and joins it before the engine answers.
      await new Promise((resolve) => setTimeout(resolve, 20));
      open();
      const [kept, out] = await Promise.all([single, batch]);
      expect(out).toEqual([{ ok: true, existed: false }]);
      expect(kept.words.map((w) => w.word).join(" ")).toBe("launch 1");
      // One run with each file: the batch started none of its own.
      expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(FULL)]);
    });

    it("is not told the transcript was refused either: it gets the words of the run that replaces it", async () => {
      noChip();
      localStorage.setItem("artdaddy.speech_language", "en");
      let open!: () => void;
      const r = rig({
        gate: new Promise<void>((resolve) => (open = resolve)),
        say: () => ({ language: "nl" }),
      });
      const clip = fresh();
      const single = runWhisper(r.ctx, clip, "small", "auto");
      await vi.waitFor(() => expect(r.launches).toHaveLength(1));
      const batch = ensureTranscripts(r.ctx, [clip], "small", "auto");
      await new Promise((resolve) => setTimeout(resolve, 20));
      open();
      const [, out] = await Promise.all([single, batch]);
      expect(out).toEqual([{ ok: true, existed: false }]);
      // The refused run and the one run that replaces it, at 5 beams: the batch started none of its own.
      expect(r.launches.map((a) => [modelOf(a), beamOf(a)])).toEqual([
        [pathOf(SMALL), 1],
        [pathOf(SMALL), 5],
      ]);
    });
  });

  it("does not touch a PC that runs the full-size file: its failure is its own, with one launch", async () => {
    // A chip PC, and a processor PC that already holds the full-size file with the owner's switch off, plan it.
    noChip();
    const held = rig({
      installed: [FULL],
      engine: () => ({ code: 1, stderr: "failed to load model" }),
    });
    const failure = await runWhisper(held.ctx, fresh(), "small", "en").catch((e: unknown) => e);
    expect((failure as TranscriptionFailure).reason).toBe("engine_failed");
    expect(held.launches.map(modelOf)).toEqual([pathOf(FULL)]);
  });

  it("goes on for every file of a run over several files, each with the full-size file", async () => {
    noChip();
    const files = [fresh(), fresh()];
    const r = rig({
      background: true,
      engine: (_launch, args) =>
        modelOf(args) === pathOf(SMALL) ? { code: 1, stderr: "failed to load model" } : { code: 0 },
    });
    const out = await ensureTranscripts(r.ctx, files, "small", "en");
    expect(out.every((o) => o.ok)).toBe(true);
    // Every launch of the smaller file is a processor launch, and every file ended with the full-size file's words.
    for (const args of r.launches)
      if (modelOf(args) === pathOf(SMALL)) expect(onProcessor(args)).toBe(true);
    expect(r.launches.filter((a) => modelOf(a) === pathOf(FULL)).length).toBe(2);
    for (const file of files) expect(await r.words(file, "en")).not.toBe("");
  });
});

describe("a PC that transcribes on its graphics chip", () => {
  for (const [how, setUp] of [
    ["has never run anything (Windows)", () => undefined],
    ["ran on its chip last time", chipWorks],
  ] as const) {
    it(`runs the full-size file with today's decoding for every language, even with the smaller file on disk (${how})`, async () => {
      setUp();
      for (const code of CODES) {
        const r = rig();
        await runWhisper(r.ctx, fresh(), "small", code);
        expect(r.launches, code).toHaveLength(1);
        const [launch] = r.launches;
        expect(modelOf(launch), code).toBe(pathOf(FULL));
        expect(onProcessor(launch), code).toBe(false);
        expect(beamOf(launch), code).toBe(beamFor("f16", code));
      }
    });
  }

  it("still goes to the processor, with the same file, when the chip is held off between the plan and the launch", async () => {
    const r = rig({ onExtract: () => chipHeldOff() });
    await runWhisper(r.ctx, fresh(), "small", "en");
    expect(modelOf(r.launches[0])).toBe(pathOf(FULL));
    expect(onProcessor(r.launches[0])).toBe(true);
  });

  it("falls back to the processor after a chip crash with the full-size file, as it always did", async () => {
    const r = rig({
      engine: (launch) => (launch === 0 ? { code: ENGINE_CRASH, stderr: VULKAN_LOG } : { code: 0 }),
    });
    await runWhisper(r.ctx, fresh(), "small", "en");
    expect(r.launches).toHaveLength(2);
    expect(r.launches.map(modelOf)).toEqual([pathOf(FULL), pathOf(FULL)]);
    expect(r.launches.map(onProcessor)).toEqual([false, true]);
    expect(cpuOnlyNow()).toBe(true);
  });
});

describe("a PC that already holds the full-size file", () => {
  it("keeps it, downloads nothing, and decodes as it always did, on the processor too", async () => {
    // Today's launch: the chip is off only where a crash held it off; a PC with no chip is not given `-ng`.
    noChip();
    const r = rig({ installed: [FULL] });
    await runWhisper(r.ctx, fresh(), "small", "en");
    expect(modelOf(r.launches[0])).toBe(pathOf(FULL));
    expect(onProcessor(r.launches[0])).toBe(false);
    expect(beamOf(r.launches[0])).toBe(beamFor("f16", "en"));
    expect(fetchedUrls).toEqual([]);

    chipHeldOff();
    const held = rig({ installed: [FULL] });
    await runWhisper(held.ctx, fresh(), "small", "en");
    expect(modelOf(held.launches[0])).toBe(pathOf(FULL));
    expect(onProcessor(held.launches[0])).toBe(true);
    expect(beamOf(held.launches[0])).toBe(beamFor("f16", "en"));
    expect(fetchedUrls).toEqual([]);
  });
});

describe("a language that is not what the plan predicted", () => {
  it("refuses a transcript the smaller file made of a language it was not cleared for, and keeps the full-size file's", async () => {
    // The last language this PC heard was English, so the plan is the smaller file; the clip turns out to be Arabic.
    noChip();
    localStorage.setItem("artdaddy.speech_language", "en");
    const r = rig({
      say: (launch) =>
        launch === 0
          ? { language: "ar", text: "words of the smaller file" }
          : { language: "ar", text: "words of the full-size file" },
    });
    const src = fresh();
    const kept = await runWhisper(r.ctx, src, "small", "auto");
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(FULL)]);
    // The smaller file's launch is a processor launch whatever the PC's history; the full-size file's is as it always was.
    expect(onProcessor(r.launches[0])).toBe(true);
    expect(kept.words.map((w) => w.word).join(" ")).toBe("words of the full-size file");
    expect(await r.words(src, "auto")).toBe("words of the full-size file");
  });

  it("re-runs a language cleared only at 5 beams with the smaller file at 5 beams", async () => {
    noChip();
    localStorage.setItem("artdaddy.speech_language", "en");
    const r = rig({ say: () => ({ language: "nl" }) });
    await runWhisper(r.ctx, fresh(), "small", "auto");
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(SMALL)]);
    expect(r.launches.map(beamOf)).toEqual([1, DEFAULT_BEAM]);
  });

  it("never keeps a transcript of Arabic made with the smaller file when the full-size file cannot be fetched", async () => {
    noChip();
    localStorage.setItem("artdaddy.speech_language", "en");
    const r = rig({ installed: [SMALL], say: () => ({ language: "ar" }) });
    const src = fresh();
    const failure = await runWhisper(r.ctx, src, "small", "auto").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TranscriptionFailure);
    expect((failure as TranscriptionFailure).reason).toBe("model_unavailable");
    // One launch (the smaller file), refused at the commit point; the full-size file was asked for and was not there.
    expect(r.launches).toHaveLength(1);
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[FULL]));
    expect(r.kept.size).toBe(0);
    expect(await r.words(src, "auto")).toBe("");
  });

  it("asks for the full-size file when Arabic is named and only the smaller one is here, and launches nothing without it", async () => {
    noChip();
    const r = rig({ installed: [SMALL] });
    const failure = await runWhisper(r.ctx, fresh(), "small", "ar").catch((e: unknown) => e);
    expect((failure as TranscriptionFailure).reason).toBe("model_unavailable");
    expect(r.launches).toEqual([]);
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[FULL]));
  });
});

describe("a run over several files", () => {
  it("is one launch of the smaller file on the processor, and a file the language of which it was not cleared for is run alone with the full-size file", async () => {
    noChip();
    const files = [fresh(), fresh()];
    const r = rig({
      background: true,
      say: (launch, _args, clip) =>
        clip === files[1]
          ? {
              language: "ar",
              text: launch === 0 ? "second, smaller file" : "second, full-size file",
            }
          : { language: "en", text: "first" },
    });
    const out = await ensureTranscripts(r.ctx, files, "small", "en");
    expect(out.every((o) => o.ok)).toBe(true);
    expect(r.launches).toHaveLength(2);
    expect(modelOf(r.launches[0])).toBe(pathOf(SMALL));
    expect(onProcessor(r.launches[0])).toBe(true);
    expect(flagValues(r.launches[0], "-f")).toHaveLength(2);
    expect(modelOf(r.launches[1])).toBe(pathOf(FULL));
    expect(flagValues(r.launches[1], "-f")).toHaveLength(1);
    expect(await r.words(files[0], "en")).toBe("first");
    expect(await r.words(files[1], "en")).toBe("second, full-size file");
  });
});

describe("the file the app fetches when it starts", () => {
  it("is the smaller one on a PC known to have no usable chip and holding neither file, from the first place", async () => {
    noChip();
    const r = rig({ installed: [] });
    await ensureLaunchModel(r.ctx).catch(() => undefined);
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[SMALL]));
  });

  it("is the full-size one on a PC that has a chip, and on a Windows PC that has never run anything", async () => {
    chipWorks();
    const chip = rig({ installed: [] });
    await ensureLaunchModel(chip.ctx).catch(() => undefined);
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[FULL]));

    localStorage.clear();
    fetchedUrls.length = 0;
    const fresh = rig({ installed: [] });
    await ensureLaunchModel(fresh.ctx).catch(() => undefined);
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[FULL]));
  });

  it("is the smaller one on a Linux PC that has never run anything, whose engine has no chip", async () => {
    hostIs(LINUX_UA);
    const r = rig({ installed: [] });
    await ensureLaunchModel(r.ctx).catch(() => undefined);
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[SMALL]));
  });

  it("is nothing at all where the full-size file is already here, even on the processor", async () => {
    noChip();
    const r = rig({ installed: [FULL] });
    expect(await ensureLaunchModel(r.ctx)).toEqual({ path: pathOf(FULL), downloaded: false });
    expect(fetchedUrls).toEqual([]);
  });

  it("is the full-size one for a PC whose last language was Arabic, even on the processor, when it holds no file", async () => {
    noChip();
    localStorage.setItem("artdaddy.speech_language", "ar");
    const r = rig({ installed: [] });
    await ensureLaunchModel(r.ctx).catch(() => undefined);
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[FULL]));
  });

  it("is nothing at all on a PC that holds only the smaller file, even when the last language it heard was Arabic: a guess fetches nothing while a file is here", async () => {
    noChip();
    localStorage.setItem("artdaddy.speech_language", "ar");
    const r = rig({ installed: [SMALL] });
    expect(await ensureLaunchModel(r.ctx)).toEqual({ path: pathOf(SMALL), downloaded: false });
    expect(fetchedUrls).toEqual([]);
  });
});

describe("the first-word fix's arguments, with it switched on", () => {
  it("are carried by the full-size file's processor launch and never by the smaller file's", async () => {
    __setWordTimesShipped(true);
    __setExportFlag("speech_word_times", true);
    chipHeldOff();
    // English on a processor PC with both files: the smaller file, on the processor, WITHOUT the arguments.
    const english = rig();
    await runWhisper(english.ctx, fresh(), "small", "en");
    expect(modelOf(english.launches[0])).toBe(pathOf(SMALL));
    expect(onProcessor(english.launches[0])).toBe(true);
    expect(english.launches[0]).not.toContain("-dtw");
    expect(english.launches[0]).not.toContain("-nfa");
    // Arabic: the full-size file, on the processor, with them (the file whose alignment was measured).
    const arabic = rig();
    await runWhisper(arabic.ctx, fresh(), "small", "ar");
    expect(modelOf(arabic.launches[0])).toBe(pathOf(FULL));
    expect(arabic.launches[0].join(" ")).toContain(DTW_ARGS.join(" "));
  });
});

describe("where the engine is started", () => {
  /** Every non-test source file of the app. */
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory())
        return name === "__fixtures__" || name === "node_modules" ? [] : sources(full);
      return /\.(ts|tsx)$/.test(name) && !/\.(test|e2e|smoke\.e2e)\.tsx?$/.test(name) ? [full] : [];
    });

  it("is one place, and that place checks the model file's path before it spawns anything", () => {
    const root = path.join(__dirname, "..");
    const spawners = sources(root).filter((file) => {
      const text = readFileSync(file, "utf8");
      return /program:\s*"whisper-cli"|\.run\(\s*"whisper-cli"/.test(text);
    });
    expect(spawners.map((f) => path.relative(root, f).replace(/\\/g, "/"))).toEqual([
      "tools/transcribe.ts",
    ]);
    const text = readFileSync(spawners[0], "utf8");
    const start = text.indexOf("const launch = async (cpuOnly: boolean");
    expect(start).toBeGreaterThan(0);
    const body = text.slice(start, text.indexOf("const engine = async", start));
    const spawn = body.indexOf("runAsJob(");
    // The plan, the added `-ng` and the last check all come before the process is started.
    expect(body.indexOf("enginePath(args, cpuOnly)")).toBeGreaterThan(-1);
    expect(body.indexOf("enginePath(args, cpuOnly)")).toBeLessThan(spawn);
    expect(body.indexOf("checkLaunch(run)")).toBeGreaterThan(-1);
    expect(body.indexOf("checkLaunch(run)")).toBeLessThan(spawn);
    expect(body.match(/"whisper-cli"/g)).toHaveLength(2);
  });

  it("is also watched by what it does: every scenario above fails if the engine is started with arguments the last check never saw", () => {
    const stray = ["-m", pathOf(SMALL), "-f", "x.wav"];
    expect(wasChecked(stray)).toBe(false);
    // The same arguments through the last check, as the app's single start passes them, are seen; the stray ones are not.
    assertLaunchArgv([...stray, "-ng"]);
    expect(wasChecked([...stray, "-ng"])).toBe(true);
    expect(wasChecked(stray)).toBe(false);
    // A launch the manifest does not allow is refused and is never recorded as passed.
    expect(() => assertLaunchArgv(stray)).toThrow();
    expect(wasChecked(stray)).toBe(false);
  });
});
