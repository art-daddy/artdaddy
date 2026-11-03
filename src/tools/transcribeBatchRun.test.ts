// One run of the engine over several files (T-34 step 3), through the REAL transcription path
// (ensureTranscripts, the model check, the one-run-per-file join, the app cache, the job supervisor) with
// a fake engine whose answers I script. What is checked is what the engine is asked to do and what ends up
// kept: that a batch is ONE process, that every file keeps its own words, and that a file the batch could
// not make is run alone without costing its neighbours anything.
import { readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
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

import { FakeJobs } from "../test/fakeJobs";
import type { ClientToolContext } from "./context";
import { __resetJobSupervisor, __setJobSupervisor } from "./jobSupervisor";
import { beamFor, DEFAULT_BEAM, GREEDY_BEAM, rememberSpeechLanguage } from "./speechDecoding";
import { TranscriptionFailure } from "./speechFailure";
import { readPace } from "./speechPace";
import {
  ensureTranscripts,
  isSpeechEngineUnavailable,
  peekTranscript,
  runWhisper,
  WHISPER_MODELS,
  whisperModelPath,
} from "./transcribe";
import { __resetWorkGate } from "./workGate";

const DIR = "C:/data/projects/p1";
const WORK = "C:/Users/u/AppData/Local/com.artdaddy.app/work/launch-1-1";
const MODEL = whisperModelPath(DIR, "small");
/** What the shipped engine printed reading three files in one process (__fixtures__/whisper). */
const BATCH3 = readFileSync(
  path.join(__dirname, "__fixtures__", "whisper", "batch3.stderr.txt"),
  "utf8",
);
const BATCH3_AUDIO_S = (70061 + 76779 + 68541) / 16000;
const ENGINE_NEVER_STARTS = -1073741515; // 0xC0000135, a DLL the engine needs is missing
const ENGINE_CRASH = -1073740791; // 0xC0000409, the crash the GPU path is known for

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

/** What an engine process does with the nth file it is given. */
interface Behaviour {
  /** "ok": writes its transcript. "missing": writes nothing (a file it could not read). "cut": dies while
   *  writing it. */
  output?: "ok" | "missing" | "cut";
  language?: string;
}

interface RigOptions {
  /** What launch `launch` does with the file at `place` in it (`source` is the clip it was made from). */
  file?: (launch: number, place: number, source: string) => Behaviour;
  code?: (launch: number, args: string[]) => number;
  stderr?: (launch: number, args: string[]) => string;
  /** Every launch waits for this before it answers. */
  gate?: Promise<void>;
}

const flagValues = (args: string[], flag: string): string[] =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
/** The beam an engine launch was asked for: the engine's own default when none is named. */
const beamOf = (args: string[]): number => Number(flagValues(args, "-bs")[0] ?? DEFAULT_BEAM);

let seq = 0;
/** Clips nobody has asked about: a run still joinable from another test is never joined. */
const fresh = (n: number): string[] => Array.from({ length: n }, () => `/media/batch-${++seq}.mp4`);
const clipNo = (src: string): string => /(\d+)\.mp4$/.exec(src)![1];

function rig(options: RigOptions = {}) {
  const files = new Set<string>([MODEL]);
  const texts = new Map<string, string>();
  const kept = new Map<string, unknown>();
  const wavSource = new Map<string, string>();
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
  /** What an engine process does: writes the output of each file it is given, as scripted. A file it is
   *  handed that is not on disk is one it cannot read: no output. */
  const engineRuns = async (args: string[]) => {
    const launch = launches.length;
    launches.push(args);
    await options.gate;
    const ins = flagValues(args, "-f");
    const outs = flagValues(args, "-of");
    ins.forEach((wav, place) => {
      const source = wavSource.get(wav);
      if (!files.has(wav) || !source) return;
      const how = options.file?.(launch, place, source) ?? {};
      const out = `${outs[place]}.json`;
      const full = json(how.language ?? "en", `clip${clipNo(source)}`);
      if ((how.output ?? "ok") === "ok") {
        files.add(out);
        texts.set(out, full);
      } else if (how.output === "cut") {
        files.add(out);
        texts.set(out, full.slice(0, 40));
      }
    });
    return {
      code: options.code?.(launch, args) ?? 0,
      stdout: "",
      stderr: options.stderr?.(launch, args) ?? "",
    };
  };
  const runner = {
    run: async (program: string, args: string[]) => {
      if (program === "ffmpeg") {
        const out = args[args.length - 1];
        files.add(out);
        wavSource.set(out, args[args.indexOf("-i") + 1]);
        return { code: 0, stdout: "", stderr: "" };
      }
      return engineRuns(args);
    },
  };
  const ctx = { store, runner, background: true } as unknown as ClientToolContext;
  return {
    ctx,
    launches,
    files,
    kept: () => [...kept.keys()],
    /** The clip the audio file `wav` was made from. */
    sourceOf: (wav: string): string | undefined => wavSource.get(wav),
    /** What is left in the app's work folder: audio and scratch output nobody cleaned up. */
    leftovers: (): string[] => [...files].filter((p) => p.startsWith(`${WORK}/`)),
    /** The words kept for `src`, as asked for in `language` (English unless the options name none). */
    wordsOf: async (
      src: string,
      options: { language?: string } = { language: "en" },
    ): Promise<string> =>
      ((await peekTranscript(ctx, src, "small", options.language)) ?? { words: [] }).words
        .map((w) => w.word)
        .join(" "),
  };
}

beforeEach(() => {
  localStorage.clear();
  __resetWorkGate();
  reportAppError.mockClear();
  reportTranscription.mockClear();
});
afterEach(() => __resetJobSupervisor());

describe("one engine process for the files that need one", () => {
  it("runs six clips in a single process, and every clip keeps its own words", async () => {
    const r = rig();
    const clips = fresh(6);
    const out = await ensureTranscripts(r.ctx, clips, "small", "en");
    expect(out).toEqual(clips.map(() => ({ ok: true, existed: false })));
    expect(r.launches).toHaveLength(1);
    expect(flagValues(r.launches[0], "-f")).toHaveLength(6);
    expect(new Set(flagValues(r.launches[0], "-of")).size).toBe(6);
    for (const c of clips) expect(await r.wordsOf(c)).toBe(`clip${clipNo(c)}`);
  });

  it("gives the engine the settings a run alone gets, once for them all", async () => {
    const r = rig();
    await ensureTranscripts(r.ctx, fresh(3), "small", "en");
    const args = r.launches[0];
    // greedy for English, as a run alone is, and no per-file settings: one -l, one -t
    expect(args.slice(-8)).toEqual(["-l", "en", "-mc", "0", "-bs", "1", "-bo", "1"]);
    expect(flagValues(args, "-l")).toEqual(["en"]);
    expect(flagValues(args, "-t")).toHaveLength(1);
    expect(flagValues(args, "-m")).toHaveLength(1);
  });

  it("a batch of one is the run it always was", async () => {
    const batch = rig();
    const alone = rig();
    const [a] = fresh(1);
    const [b] = fresh(1);
    await ensureTranscripts(batch.ctx, [a], "small", "en");
    await runWhisper(alone.ctx, b, "small", "en");
    const shape = (args: string[]) => args.map((x) => x.replace(/[^/]*$/, "*"));
    expect(shape(batch.launches[0])).toEqual(shape(alone.launches[0]));
  });

  it("leaves nothing behind: no scratch output, no audio", async () => {
    const r = rig();
    const clips = fresh(4);
    const out = await ensureTranscripts(r.ctx, clips, "small", "en");
    // the engine found every audio file where it was told (a file it cannot read makes no output)
    expect(out.every((o) => o.ok)).toBe(true);
    expect(r.leftovers()).toEqual([]);
  });

  it("reports the run once, for every file it read, and keeps it out of the machine's pace", async () => {
    const r = rig({ stderr: () => BATCH3 });
    await ensureTranscripts(r.ctx, fresh(3), "small", "en");
    expect(reportTranscription.mock.calls).toEqual([
      [
        expect.objectContaining({ audioSeconds: BATCH3_AUDIO_S, backend: "vulkan" }),
        undefined,
        expect.objectContaining({ beam: 1, files: 3 }),
      ],
    ]);
    // one start-up shared by several clips says nothing about how fast this machine transcribes
    expect(readPace()).toEqual([]);
  });
});

describe("what is not run again", () => {
  it("a clip that already has its words costs nothing, and the rest still run together", async () => {
    const r = rig();
    const [done, ...rest] = fresh(4);
    await runWhisper(r.ctx, done, "small", "en");
    r.launches.length = 0;
    const out = await ensureTranscripts(r.ctx, [done, ...rest], "small", "en");
    expect(out[0]).toEqual({ ok: true, existed: true });
    expect(out.slice(1).every((o) => o.ok)).toBe(true);
    expect(r.launches).toHaveLength(1);
    expect(flagValues(r.launches[0], "-f")).toHaveLength(3);
  });

  it("one clip that needs the engine is an ordinary run", async () => {
    const r = rig();
    const [done, one] = fresh(2);
    await runWhisper(r.ctx, done, "small", "en");
    r.launches.length = 0;
    await ensureTranscripts(r.ctx, [done, one], "small", "en");
    expect(r.launches).toHaveLength(1);
    expect(flagValues(r.launches[0], "-f")).toHaveLength(1);
  });

  it("a clip someone else is already transcribing is joined, not started again", async () => {
    let open!: () => void;
    const r = rig({ gate: new Promise<void>((res) => (open = res)) });
    const [mine, b, c] = fresh(3);
    const first = runWhisper(r.ctx, mine, "small", "en");
    while (r.launches.length < 1) await new Promise((res) => setTimeout(res, 1));
    const batch = ensureTranscripts(r.ctx, [mine, b, c], "small", "en");
    while (r.launches.length < 2) await new Promise((res) => setTimeout(res, 1));
    open();
    const out = await batch;
    await first;
    expect(out.map((o) => o.ok)).toEqual([true, true, true]);
    // the clip in progress ran once; the other two ran together
    expect(r.launches.map((args) => flagValues(args, "-f").length).sort()).toEqual([1, 2]);
  });

  it("someone who asks for a clip while the batch has it waits for the batch", async () => {
    let open!: () => void;
    const r = rig({ gate: new Promise<void>((res) => (open = res)) });
    const clips = fresh(3);
    const batch = ensureTranscripts(r.ctx, clips, "small", "en");
    while (r.launches.length < 1) await new Promise((res) => setTimeout(res, 1));
    const asked = runWhisper(r.ctx, clips[1], "small", "en");
    open();
    const [out, words] = await Promise.all([batch, asked]);
    expect(out.every((o) => o.ok)).toBe(true);
    expect(words.words.map((w) => w.word)).toEqual([`clip${clipNo(clips[1])}`]);
    expect(r.launches).toHaveLength(1); // nobody started a second process
  });
});

describe("a clip the run made nothing of", () => {
  it("is run alone, and its neighbours keep what the batch made of them", async () => {
    const r = rig({
      file: (launch, place) => (launch === 0 && place === 1 ? { output: "missing" } : {}),
    });
    const clips = fresh(3);
    const out = await ensureTranscripts(r.ctx, clips, "small", "en");
    expect(out.every((o) => o.ok)).toBe(true);
    expect(r.launches.map((a) => flagValues(a, "-f").length)).toEqual([3, 1]);
    // it is the clip the batch made nothing of that ran again, not another one
    expect(r.sourceOf(flagValues(r.launches[1], "-f")[0])).toBe(clips[1]);
    for (const c of clips) expect(await r.wordsOf(c)).toBe(`clip${clipNo(c)}`);
    expect(r.leftovers()).toEqual([]);
  });

  it("fails alone, with its own error, when running it alone does not work either", async () => {
    const clips = fresh(4);
    const r = rig({
      file: (_launch, _place, source) => (source === clips[2] ? { output: "missing" } : {}),
    });
    const out = await ensureTranscripts(r.ctx, clips, "small", "en");
    expect(out.map((o) => o.ok)).toEqual([true, true, false, true]);
    const failure = (out[2] as { error: unknown }).error;
    expect(failure).toBeInstanceOf(TranscriptionFailure);
    expect((failure as TranscriptionFailure).reason).toBe("engine_failed");
    expect(await r.wordsOf(clips[2])).toBe(""); // nothing was kept for it
    for (const c of [clips[0], clips[1], clips[3]])
      expect(await r.wordsOf(c)).toBe(`clip${clipNo(c)}`);
    expect(r.leftovers()).toEqual([]);
  });

  it("is run alone when the engine died while writing its output, and an output cut short is never kept", async () => {
    const r = rig({
      file: (launch, place) => (launch === 0 && place === 1 ? { output: "cut" } : {}),
      code: (launch) => (launch === 0 ? 1 : 0),
    });
    const clips = fresh(3);
    const out = await ensureTranscripts(r.ctx, clips, "small", "en");
    expect(out.every((o) => o.ok)).toBe(true);
    expect(r.launches.map((a) => flagValues(a, "-f").length)).toEqual([3, 1]);
    expect(r.sourceOf(flagValues(r.launches[1], "-f")[0])).toBe(clips[1]);
    for (const c of clips) expect(await r.wordsOf(c)).toBe(`clip${clipNo(c)}`);
  });

  it("an engine that died half way loses only the files it had not reached", async () => {
    const r = rig({
      file: (launch, place) => (launch === 0 && place >= 2 ? { output: "missing" } : {}),
      code: (launch) => (launch === 0 ? 1 : 0),
    });
    const clips = fresh(5);
    const out = await ensureTranscripts(r.ctx, clips, "small", "en");
    expect(out.every((o) => o.ok)).toBe(true);
    // the batch kept two; the other three were each run alone
    expect(r.launches.map((a) => flagValues(a, "-f").length)).toEqual([5, 1, 1, 1]);
    const again = r.launches.slice(1).map((a) => r.sourceOf(flagValues(a, "-f")[0]));
    expect(again).toEqual(clips.slice(2));
  });

  it("a clip in a language that needs the wider setting is run alone at that width; the others keep the batch's", async () => {
    // the gate did not clear Korean for the faster setting, and did clear English
    expect(beamFor("f16", "ko")).toBe(DEFAULT_BEAM);
    expect(beamFor("f16", "en")).toBe(GREEDY_BEAM);
    rememberSpeechLanguage("en"); // so the batch, asked for no language, decodes greedily
    const clips = fresh(3);
    const korean = clips[1];
    const r = rig({
      file: (_launch, _place, source) => ({ language: source === korean ? "ko" : "en" }),
    });
    const out = await ensureTranscripts(r.ctx, clips, undefined, undefined);
    expect(out.every((o) => o.ok)).toBe(true);
    expect(r.launches.map(beamOf)).toEqual([GREEDY_BEAM, DEFAULT_BEAM]);
    expect(r.launches.map((a) => flagValues(a, "-f").length)).toEqual([3, 1]);
    expect(r.sourceOf(flagValues(r.launches[1], "-f")[0])).toBe(korean);
    for (const c of clips) expect(await r.wordsOf(c, {})).toBe(`clip${clipNo(c)}`);
    // each run is reported once: the batch for the two it kept, then the Korean re-run as a re-run
    expect(reportTranscription.mock.calls.map((c) => c[2])).toEqual([
      expect.objectContaining({ beam: GREEDY_BEAM, files: 2 }),
      expect.objectContaining({ beam: DEFAULT_BEAM, rerun: true }),
    ]);
  });
});

describe("a run that cannot happen", () => {
  it("an engine that cannot start fails every file at once, and is run once", async () => {
    const r = rig({
      file: () => ({ output: "missing" }),
      code: () => ENGINE_NEVER_STARTS,
    });
    const out = await ensureTranscripts(r.ctx, fresh(4), "small", "en");
    expect(out.every((o) => !o.ok)).toBe(true);
    for (const o of out)
      expect(isSpeechEngineUnavailable((o as { error: unknown }).error)).toBe(true);
    expect(r.launches).toHaveLength(1); // not once more for each file
  });

  it("a crash of the GPU path is retried once with the GPU off, for the whole batch", async () => {
    const r = rig({
      file: (launch) => (launch === 0 ? { output: "missing" } : {}),
      code: (launch) => (launch === 0 ? ENGINE_CRASH : 0),
      stderr: (launch) => (launch === 0 ? "ggml_vulkan: Found 1 Vulkan devices:\n" : ""),
    });
    const out = await ensureTranscripts(r.ctx, fresh(3), "small", "en");
    expect(out.every((o) => o.ok)).toBe(true);
    expect(r.launches).toHaveLength(2);
    expect(r.launches[0]).not.toContain("-ng");
    expect(r.launches[1]).toContain("-ng");
    expect(flagValues(r.launches[1], "-f")).toHaveLength(3);
  });

  it("a file that cannot be read for audio fails alone and the rest still run together", async () => {
    const r = rig();
    const clips = fresh(4);
    const bad = clips[1];
    const run = r.ctx.runner.run.bind(r.ctx.runner);
    (r.ctx.runner as { run: unknown }).run = async (
      program: string,
      args: string[],
      ...rest: unknown[]
    ) =>
      program === "ffmpeg" && args.includes(bad)
        ? { code: 1, stdout: "", stderr: "Invalid data found when processing input" }
        : (run as (...a: unknown[]) => unknown)(program, args, ...rest);
    const out = await ensureTranscripts(r.ctx, clips, "small", "en");
    expect(out.map((o) => o.ok)).toEqual([true, false, true, true]);
    // it fails with the reason the audio could not be read, not a generic "did not finish"
    expect(String((out[1] as { error: unknown }).error)).toMatch(/Invalid data found/);
    expect(r.launches).toHaveLength(1);
    expect(flagValues(r.launches[0], "-f")).toHaveLength(3);
    expect(r.leftovers()).toEqual([]);
  });
});

describe("property: whatever the engine does with each file", () => {
  it("every file ends with its own words, or its own failure, and a bad file costs only itself", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("ok", "missing", "cut"), { minLength: 2, maxLength: 8 }),
        // whether running a file alone works for the ones the batch could not make
        fc.boolean(),
        async (statuses, aloneWorks) => {
          const clips = fresh(statuses.length);
          const r = rig({
            file: (launch, _place, source) => {
              const status = statuses[clips.indexOf(source)] as "ok" | "missing" | "cut";
              if (launch === 0) return { output: status };
              return { output: aloneWorks ? "ok" : "missing" }; // a file run alone
            },
            code: (launch) => (launch === 0 && statuses.includes("cut") ? 1 : 0),
          });
          const out = await ensureTranscripts(r.ctx, clips, "small", "en");
          const failed = clips.filter((_, i) => statuses[i] !== "ok");
          // one process for the batch, then one for each file it could not make, and no other
          expect(r.launches).toHaveLength(1 + failed.length);
          expect(flagValues(r.launches[0], "-f")).toHaveLength(clips.length);
          const again = r.launches.slice(1).map((a) => r.sourceOf(flagValues(a, "-f")[0]));
          expect([...again].sort()).toEqual([...failed].sort());
          for (const [i, c] of clips.entries()) {
            if (statuses[i] === "ok" || aloneWorks) {
              expect(out[i]).toEqual({ ok: true, existed: false });
              expect(await r.wordsOf(c)).toBe(`clip${clipNo(c)}`);
            } else {
              expect(out[i].ok).toBe(false);
              expect(await r.wordsOf(c)).toBe(""); // nothing wrong was kept
            }
          }
          expect(r.leftovers()).toEqual([]);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("a batch the page crashed during", () => {
  it("is finished file by file by the next page, from the output each file was given", async () => {
    const r = rig({ stderr: () => BATCH3 });
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    const clips = fresh(3);
    // the page that starts it dies while the engine is at work
    void ensureTranscripts(r.ctx, clips, "small", "en").catch(() => undefined);
    for (let i = 0; i < 500 && jobs.started.length < 1; i++)
      await new Promise((res) => setTimeout(res, 1));
    expect(jobs.submitted).toHaveLength(1);
    jobs.pageDied();
    const spec = jobs.submitted[0];
    expect(spec.meta).toMatchObject({ kind: "transcripts" });
    const items = (spec.meta as { items: Array<{ scratch: string; once: string }> }).items;
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.scratch)).size).toBe(3);

    // the next page: every module fresh, the app process (and its job) the same
    vi.resetModules();
    const [transcribe, supervisor, gate] = await Promise.all([
      import("./transcribe"),
      import("./jobSupervisor"),
      import("./workGate"),
    ]);
    supervisor.__setJobSupervisor(jobs);
    const io = {
      exists: (p: string) => r.ctx.store.exists(p),
      readText: (p: string) => r.ctx.store.readText(p),
      remove: (p: string) => r.ctx.store.remove(p),
      appCache: () => r.ctx.store.appCache(),
    };
    expect(await transcribe.adoptTranscriptions(io)).toBe(1);
    // the engine is still at work: the indexer's next whisper waits for it, and a request for one of
    // its files waits for it too, starting nothing
    let turn: unknown = "waiting";
    void gate.backgroundTurn("whisper").then((t) => (turn = t));
    const asked = transcribe.runWhisper(r.ctx, clips[0], "small", "en");
    for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 1));
    expect([turn, jobs.submitted.length]).toEqual(["waiting", 1]);

    // the engine finishes: two of the three files have their output, the middle one does not
    for (const [i, text] of [
      [0, "first"],
      [2, "third"],
    ] as const)
      await r.ctx.store.writeText(`${items[i].scratch}.json`, json("en", text));
    jobs.exit(spec.id, 0, BATCH3);
    expect((await asked).words.map((w) => w.word)).toEqual(["first"]);
    for (
      let i = 0;
      i < 500 && !(jobs.forgotten.includes(spec.id) && typeof turn === "function");
      i++
    )
      await new Promise((res) => setTimeout(res, 1));
    expect(jobs.forgotten).toEqual([spec.id]); // the job is let go of, for all the files
    expect(typeof turn).toBe("function"); // and the indexer's whisper turn is free again
    const words = async (src: string) =>
      ((await transcribe.peekTranscript(r.ctx, src, "small", "en"))?.words ?? []).map(
        (w) => w.word,
      );
    expect(await words(clips[0])).toEqual(["first"]);
    expect(await words(clips[1])).toEqual([]); // no output: nothing was kept for it
    expect(await words(clips[2])).toEqual(["third"]);
    expect(jobs.submitted).toHaveLength(1); // nothing was started again for any of them
    expect(r.leftovers()).toEqual([]);
    // the page that finished it reports the run, once, for the two files it kept; the one that died never did
    expect(reportTranscription.mock.calls).toEqual([
      [
        expect.objectContaining({ backend: "vulkan" }),
        undefined,
        expect.objectContaining({ files: 2 }),
      ],
    ]);
  });
});
