// The stories about which model file a run keeps that speechModelRun.test.ts leaves open, each found by a mutant of the
// app's own code that every other test let live (lane L12, helper D). Same rig: the REAL transcription path (runWhisper,
// ensureTranscripts, the model check, the launch boundary, the commit point, the app cache, the launch prefetch) with a
// fake engine whose answers I script. What is checked is what the engine is launched with and what ends up kept:
//
//   * a second refusal in one run, which only the smaller file can cause: its 5-beam re-run is refused too, and the
//     full-size file at the engine's own beam settles it;
//   * a transcript made with the smaller file is judged AS the smaller file at its own beam, on a lone run and on a run
//     over several files, including when it was planned at 5 beams (where the full-size file would have accepted it);
//   * the re-run after a refusal is planned from the language the engine heard, even when this PC cannot remember it;
//   * the last check before the engine starts stops the smaller file without `-ng` although the plan said otherwise;
//   * a short copy of the full-size file is not "installed", and the launch prefetch follows the plan.
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

// A plan that names the graphics chip for any file, to see what the last check does when the plan is wrong. The last
// check is also recorded as it passes: whatever the scenarios below start the engine with must be arguments it passed
// (a second way to start the engine is seen by what it does, not by what it is spelled like).
const wrongPlan = vi.hoisted(() => ({ on: false }));
const lastCheck = vi.hoisted(() => ({ passed: [] as string[][], unchecked: [] as string[][] }));
vi.mock("./speechModel", async (orig) => {
  const real = await orig<typeof import("./speechModel")>();
  return {
    ...real,
    launchPlan: (args: readonly string[], cpuOnly: boolean) =>
      wrongPlan.on
        ? { cpuOnly: false, key: real.modelKeyOfPath(args[args.indexOf("-m") + 1]) ?? "small" }
        : real.launchPlan(args, cpuOnly),
    assertLaunchArgv: (argv: readonly string[]) => {
      real.assertLaunchArgv(argv); // a launch the manifest does not allow throws: it is never recorded as passed
      lastCheck.passed.push([...argv]);
    },
  };
});
const wasChecked = (argv: readonly string[]): boolean =>
  lastCheck.passed.some((seen) => JSON.stringify(seen) === JSON.stringify(argv));

// The app's start-up code reads the data folder and the file system through the desktop shell: here, a folder in memory.
vi.mock("./tauri", async (orig) => ({
  ...(await orig<object>()),
  TauriFs: (await import("../test/loopbackModelServer")).MemoryModelFs,
}));
vi.mock("./dataRoot", async (orig) => ({
  ...(await orig<object>()),
  projectsRoot: async () => "C:/data/projects",
}));

import { platform } from "../platform";
import { __resetHostInfo } from "../platform/host";
import {
  clearModelDownload,
  modelDownloadMessage,
  setModelDownloadFailure,
  useModelDownload,
} from "../store/modelDownload";
import type { ClientToolContext } from "./context";
import { MODEL_MANIFEST, primaryUrl } from "./modelManifest";
import { __resetPrefetch, retrySpeechModelDownload } from "./modelPrefetch";
import { DEFAULT_BEAM, SPEECH_LANGUAGE_KEY } from "./speechDecoding";
import { TranscriptionFailure } from "./speechFailure";
import { recordSpeechRun } from "./speechPace";
import {
  __resetSmallerFileFailure,
  __setDownloadPolicy,
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
interface RigOptions {
  /** The manifest keys whose file is on disk, whole. Absent: both. */
  installed?: readonly string[];
  /** The manifest keys whose file is on disk but one byte short. */
  short?: readonly string[];
  /** What the engine says it heard, per launch and clip. Absent: English. */
  say?: (launch: number, args: string[], clip: string) => Say;
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
  const shortPaths = new Set((options.short ?? []).map(pathOf));
  for (const key of options.installed ?? [FULL, SMALL]) files.add(pathOf(key));
  for (const key of options.short ?? []) files.add(pathOf(key));
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
    byteSize: async (p: string) => (specs.get(p)?.bytes ?? 0) - (shortPaths.has(p) ? 1 : 0),
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
        return { code: 0, stdout: "", stderr: "" };
      }
      const launch = launches.length;
      launches.push(args);
      if (!wasChecked(args)) lastCheck.unchecked.push(args);
      const outs = flagValues(args, "-of");
      flagValues(args, "-f").forEach((wav, place) => {
        const source = wavSource.get(wav);
        if (!source) return;
        const said = options.say?.(launch, args, source) ?? { language: "en" };
        const out = `${outs[place]}.json`;
        files.add(out);
        texts.set(out, json(said.language, said.text ?? `launch ${launch}`));
      });
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const ctx = { store, runner, background: options.background } as unknown as ClientToolContext;
  return {
    ctx,
    launches,
    kept,
    words: async (src: string, language: string): Promise<string> =>
      ((await peekTranscript(ctx, src, "small", language)) ?? { words: [] }).words
        .map((w) => w.word)
        .join(" "),
  };
}

let seq = 0;
/** A clip nobody has asked about: a run still joinable from another test is never joined. */
const fresh = (): string => `/media/gap-${++seq}.mp4`;

/** A PC with no usable chip: the engine's own log said so on its latest run, and no hold is kept. */
const noChip = (): void => recordSpeechRun(60, 120, "cpu");
/** A PC whose latest run used its chip. */
const chipWorks = (): void => recordSpeechRun(60, 6, "gpu");
/** The last language this PC heard, as the app keeps it. */
const lastHeard = (code: string): void => localStorage.setItem(SPEECH_LANGUAGE_KEY, code);

const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

const fetchedUrls: string[] = [];
beforeEach(() => {
  localStorage.clear();
  lastCheck.passed.length = 0;
  lastCheck.unchecked.length = 0;
  __resetWorkGate();
  __resetSmallerFileFailure();
  __resetPrefetch();
  clearModelDownload();
  setModelDownloadFailure(null);
  __setDownloadPolicy(SINGLE_ATTEMPT);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WINDOWS_UA);
  __resetHostInfo();
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
  wrongPlan.on = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetHostInfo();
  __setDownloadPolicy(PATIENT_DOWNLOAD);
  // Whatever scenario ran, the engine was only ever started with arguments the last check had passed.
  expect(unchecked, "the engine was started with arguments the last check never saw").toEqual([]);
});

describe("a second refusal in one run", () => {
  it("is settled by the full-size file at the engine's own beam, whatever the smaller file was refused for", async () => {
    // English was predicted (greedy); the clip is Dutch (cleared at 5 beams only); the 5-beam re-run then hears Arabic,
    // which the smaller file was never cleared for. Only the full-size file at 5 beams is acceptable for every language.
    noChip();
    lastHeard("en");
    const heard = ["nl", "ar", "ar"];
    const r = rig({
      say: (launch) => ({ language: heard[launch] ?? "ar", text: `words of launch ${launch}` }),
    });
    const src = fresh();
    const kept = await runWhisper(r.ctx, src, "small", "auto");
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(SMALL), pathOf(FULL)]);
    expect(r.launches.map(beamOf)).toEqual([1, DEFAULT_BEAM, DEFAULT_BEAM]);
    // The smaller file is only ever launched with -ng; the full-size file's launch is as it always was.
    for (const args of r.launches)
      if (modelOf(args) === pathOf(SMALL)) expect(onProcessor(args)).toBe(true);
    expect(kept.words.map((w) => w.word).join(" ")).toBe("words of launch 2");
    expect(await r.words(src, "auto")).toBe("words of launch 2");
  });
});

describe("a transcript made with the smaller file at 5 beams", () => {
  it("is refused for a language the smaller file was not cleared for, though the full-size file at 5 beams would have kept it", async () => {
    // Dutch was predicted, so the smaller file runs at 5 beams; the clip is Arabic.
    noChip();
    lastHeard("nl");
    const r = rig({
      say: (launch) => ({ language: "ar", text: launch === 0 ? "smaller file" : "full-size file" }),
    });
    const src = fresh();
    const kept = await runWhisper(r.ctx, src, "small", "auto");
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(FULL)]);
    expect(r.launches.map(beamOf)).toEqual([DEFAULT_BEAM, DEFAULT_BEAM]);
    expect(kept.words.map((w) => w.word).join(" ")).toBe("full-size file");
    expect(await r.words(src, "auto")).toBe("full-size file");
  });

  it("is refused in a run over several files too, for the file whose language it was not cleared for", async () => {
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
          : { language: "nl", text: "first" },
    });
    const out = await ensureTranscripts(r.ctx, files, "small", "nl");
    expect(out.every((o) => o.ok)).toBe(true);
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(FULL)]);
    expect(r.launches.map((a) => flagValues(a, "-f").length)).toEqual([2, 1]);
    expect(await r.words(files[0], "nl")).toBe("first");
    expect(await r.words(files[1], "nl")).toBe("second, full-size file");
  });

  it("is refused in a run over several files when it was made at a narrower beam than its language was cleared at", async () => {
    // English was predicted, so the whole run is greedy; the second file is Dutch, which was cleared at 5 beams only.
    noChip();
    lastHeard("en");
    const files = [fresh(), fresh()];
    const r = rig({
      background: true,
      say: (launch, _args, clip) =>
        clip === files[1]
          ? { language: "nl", text: launch === 0 ? "second, greedy" : "second, 5 beams" }
          : { language: "en", text: "first" },
    });
    const out = await ensureTranscripts(r.ctx, files, "small", "auto");
    expect(out.every((o) => o.ok)).toBe(true);
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(SMALL)]);
    expect(r.launches.map(beamOf)).toEqual([1, DEFAULT_BEAM]);
    expect(r.launches.map((a) => flagValues(a, "-f").length)).toEqual([2, 1]);
    expect(await r.words(files[0], "auto")).toBe("first");
    expect(await r.words(files[1], "auto")).toBe("second, 5 beams");
  });
});

describe("the re-run after a refusal", () => {
  it("is planned from the language the engine heard, even when this PC cannot remember it", async () => {
    // The last language heard was English, so the smaller file at 1 beam is planned; the clip is Arabic, and the store
    // that would hold "ar" is full. The re-run must still be the full-size file, not another run of the smaller one.
    const memory = new Map<string, string>([[SPEECH_LANGUAGE_KEY, "en"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === SPEECH_LANGUAGE_KEY) throw new Error("the quota has been exceeded");
        memory.set(key, String(value));
      },
      removeItem: (key: string) => void memory.delete(key),
      clear: () => memory.clear(),
      key: (n: number) => [...memory.keys()][n] ?? null,
      get length() {
        return memory.size;
      },
    });
    noChip();
    const r = rig({
      say: (launch) => ({ language: "ar", text: launch === 0 ? "smaller file" : "full-size file" }),
    });
    const src = fresh();
    const kept = await runWhisper(r.ctx, src, "small", "auto");
    expect(memory.get(SPEECH_LANGUAGE_KEY)).toBe("en");
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(FULL)]);
    expect(kept.words.map((w) => w.word).join(" ")).toBe("full-size file");
  });
});

describe("the last check before the engine starts", () => {
  it("never lets the smaller file be spawned without -ng, even when the plan said the graphics chip", async () => {
    noChip();
    wrongPlan.on = true;
    const r = rig();
    const failure = await runWhisper(r.ctx, fresh(), "small", "en").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TranscriptionFailure);
    expect((failure as TranscriptionFailure).reason).toBe("engine_failed");
    // Nothing was spawned, and nothing was kept.
    expect(r.launches).toEqual([]);
    expect(r.kept.size).toBe(0);
  });
});

describe("which file counts as installed", () => {
  it("is a whole one: a short copy of the full-size file is not here, so the halved download is asked for", async () => {
    noChip();
    const r = rig({ installed: [], short: [FULL] });
    await runWhisper(r.ctx, fresh(), "small", "en").catch(() => undefined);
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[SMALL]));
  });
});

describe("a language that was only predicted, on a PC that holds only the smaller file", () => {
  it("does not fetch the full-size file for an `auto` request because the last clip was Arabic: the next clip is transcribed with the file that is here", async () => {
    noChip();
    lastHeard("en");
    const arabic = fresh();
    const english = fresh();
    const r = rig({
      installed: [SMALL],
      say: (_launch, _args, clip) =>
        clip === arabic
          ? { language: "ar", text: "arabic words" }
          : { language: "en", text: "english words" },
    });
    // The Arabic clip is refused at the commit point and the full-size file cannot be fetched (offline): the request
    // fails saying why, nothing wrong is kept, and the guess is Arabic from now on.
    const failure = await runWhisper(r.ctx, arabic, "small", "auto").catch((e: unknown) => e);
    expect((failure as TranscriptionFailure).reason).toBe("model_unavailable");
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[FULL]));
    expect(localStorage.getItem(SPEECH_LANGUAGE_KEY)).toBe("ar");
    expect(r.kept.size).toBe(0);

    // The next request is an English clip. It needs no download, though the guess is still Arabic.
    fetchedUrls.length = 0;
    const kept = await runWhisper(r.ctx, english, "small", "auto");
    expect(fetchedUrls).toEqual([]);
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL), pathOf(SMALL)]);
    expect(onProcessor(r.launches[1])).toBe(true);
    expect(kept.words.map((w) => w.word).join(" ")).toBe("english words");
    // The guess has corrected itself, because this run reached the engine.
    expect(localStorage.getItem(SPEECH_LANGUAGE_KEY)).toBe("en");
    expect(await r.words(english, "auto")).toBe("english words");
  });

  it("holds for every language the engine knows as the guess: the request starts on the file that is here and fetches nothing", async () => {
    noChip();
    for (const code of Object.keys(WHISPER_LANGUAGES)) {
      lastHeard(code);
      fetchedUrls.length = 0;
      const r = rig({ installed: [SMALL] });
      await runWhisper(r.ctx, fresh(), "small", "auto");
      expect(fetchedUrls, code).toEqual([]);
      expect(r.launches.map(modelOf), code).toEqual([pathOf(SMALL)]);
      expect(onProcessor(r.launches[0]), code).toBe(true);
    }
  });

  it("does the same in a run over several files", async () => {
    noChip();
    lastHeard("ar");
    const files = [fresh(), fresh()];
    const r = rig({ installed: [SMALL], background: true });
    const out = await ensureTranscripts(r.ctx, files, "small", "auto");
    expect(out.every((o) => o.ok)).toBe(true);
    expect(fetchedUrls).toEqual([]);
    expect(r.launches.map(modelOf)).toEqual([pathOf(SMALL)]);
    expect(r.launches.map((a) => flagValues(a, "-f").length)).toEqual([2]);
    expect(onProcessor(r.launches[0])).toBe(true);
  });

  it("still never keeps Arabic made with the smaller file when Arabic is both what was guessed and what is heard", async () => {
    noChip();
    lastHeard("ar");
    const r = rig({ installed: [SMALL], say: () => ({ language: "ar" }) });
    const src = fresh();
    const failure = await runWhisper(r.ctx, src, "small", "auto").catch((e: unknown) => e);
    expect((failure as TranscriptionFailure).reason).toBe("model_unavailable");
    // One run on the smaller file, refused at the commit point; then the full-size file was asked for and not there.
    expect(r.launches).toHaveLength(1);
    expect(onProcessor(r.launches[0])).toBe(true);
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[FULL]));
    expect(r.kept.size).toBe(0);
    expect(await r.words(src, "auto")).toBe("");
  });
});

describe("the download of a second model file, told to the screens", () => {
  /** A fetch that never gets an answer, so that the download stays under way while the store is read. */
  const silentNetwork = (): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
  };

  it("is flagged when another model file is already on the PC, through the app's own download", async () => {
    noChip();
    silentNetwork();
    // The smaller file is here and Arabic is named, so the full-size file is fetched: a second model file.
    const r = rig({ installed: [SMALL] });
    const asked = runWhisper(r.ctx, fresh(), "small", "ar").catch((e: unknown) => e);
    await vi.waitFor(() =>
      expect(useModelDownload.getState().total).toBe(WHISPER_MODELS[FULL].bytes),
    );
    await vi.waitFor(() => expect(useModelDownload.getState().again).toBe(true));
    const under = useModelDownload.getState();
    expect(modelDownloadMessage(under.received, under.total, null, under.again)).toBe(
      "Downloading another speech model (about 465 MB) - 0%",
    );
    // The person presses Cancel: the request ends saying so, and the flag goes with the download.
    under.cancel?.();
    expect(((await asked) as Error).message).toMatch(/speech model download cancelled/);
    expect(useModelDownload.getState()).toMatchObject({ total: 0, again: false });
  });

  it("is not flagged for the first download of a PC that holds no model file", async () => {
    noChip();
    silentNetwork();
    const r = rig({ installed: [] });
    const asked = runWhisper(r.ctx, fresh(), "small", "ar").catch((e: unknown) => e);
    await vi.waitFor(() =>
      expect(useModelDownload.getState().total).toBe(WHISPER_MODELS[FULL].bytes),
    );
    // The disk has been read by now: nothing else is here, so it is the first model, in the owner's words.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const under = useModelDownload.getState();
    expect(under.again).toBe(false);
    expect(modelDownloadMessage(under.received, under.total, null, under.again)).toBe(
      "Downloading the speech model (one time, about 465 MB) - 0%",
    );
    under.cancel?.();
    await asked;
  });
});

describe("Retry on the failure card, through the app's own start-up code", () => {
  /** The person presses Retry. The app's start-up code only runs in the desktop shell. */
  async function pressRetry(): Promise<void> {
    const shell = platform as { name: string };
    const was = shell.name;
    shell.name = "tauri";
    try {
      await retrySpeechModelDownload();
    } finally {
      shell.name = was;
    }
  }

  it("asks for the file the card is about, not for the file the last language this PC heard would need", async () => {
    // The smaller file is here and the last language was English, so the plan says the smaller file. A request names
    // Arabic while offline: the full-size file is asked for, cannot be fetched, and the card is about THAT file.
    noChip();
    lastHeard("en");
    const r = rig({ installed: [SMALL] });
    const failure = await runWhisper(r.ctx, fresh(), "small", "ar").catch((e: unknown) => e);
    expect((failure as TranscriptionFailure).reason).toBe("model_unavailable");
    expect(useModelDownload.getState()).toMatchObject({ failure: "network", failureKey: FULL });

    fetchedUrls.length = 0;
    await pressRetry();
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[FULL]));
    // It failed again, offline: the card is back, about the same file, with its Retry.
    expect(useModelDownload.getState()).toMatchObject({ failure: "network", failureKey: FULL });
  });

  it("asks for the file that failed even when the language this PC last heard has moved to one that needs the other", async () => {
    // Nothing is known and nothing is installed: the app's start fetches the smaller file, which fails offline.
    noChip();
    await pressRetry();
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[SMALL]));
    expect(useModelDownload.getState()).toMatchObject({ failure: "network", failureKey: SMALL });

    // Meanwhile the PC heard Arabic: the plan would now name the full-size file, but the card is about the smaller one.
    lastHeard("ar");
    fetchedUrls.length = 0;
    await pressRetry();
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[SMALL]));
  });
});

describe("the file the app fetches when it starts, through the app's own start-up code", () => {
  /** The start-up code only runs in the desktop shell. */
  async function startUp(): Promise<void> {
    const shell = platform as { name: string };
    const was = shell.name;
    shell.name = "tauri";
    try {
      await retrySpeechModelDownload();
    } finally {
      shell.name = was;
      setModelDownloadFailure(null);
    }
  }

  it("is the smaller one on a PC with no usable chip, and the full-size one on a PC with a chip", async () => {
    noChip();
    await startUp();
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[SMALL]));

    localStorage.clear();
    fetchedUrls.length = 0;
    chipWorks();
    await startUp();
    expect(fetchedUrls[0]).toBe(primaryUrl(MODEL_MANIFEST[FULL]));
  });
});
