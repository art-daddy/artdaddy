// The decoding setting, through the REAL transcription path (runWhisper, the model check, the one-
// run-per-file join, the app cache) with a fake engine whose answer I script. What is checked is
// what the engine is asked to do and what ends up kept, not how speechDecoding.ts decides: a
// language the accuracy gate cleared is decoded greedily, every other language with the arguments
// it always had, and a transcript made narrower than its detected language needs is never kept.
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import type { ClientToolContext } from "./context";
import {
  acceptableBeam,
  beamFor,
  DEFAULT_BEAM,
  GREEDY_BEAM,
  lastSpeechLanguage,
  rememberSpeechLanguage,
} from "./speechDecoding";
import { peekTranscript, runWhisper, WHISPER_MODELS, whisperModelPath } from "./transcribe";
import { WHISPER_LANGUAGES } from "./whisperLanguages";
import { __resetWorkGate } from "./workGate";

const DIR = "C:/data/projects/p1";
const WORK = "C:/Users/u/AppData/Local/com.artdaddy.app/work/launch-1-1";
const MODEL = whisperModelPath(DIR, "small");
const TINY = whisperModelPath(DIR, "tiny");
const CODES = Object.keys(WHISPER_LANGUAGES);

const spoken = (language: string, text: string): string =>
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

/** What one launch of the engine is told to say. */
type Say = { language: string; text: string };

/** The beam an engine launch was asked for: the default when its arguments name none. */
const beamOf = (args: string[]): number =>
  args.includes("-bs") ? Number(args[args.indexOf("-bs") + 1]) : DEFAULT_BEAM;

function rig(say: (launch: number, args: string[]) => Say, onLaunched?: (launch: number) => void) {
  const files = new Set<string>([MODEL, TINY]);
  const texts = new Map<string, string>();
  const kept = new Map<string, unknown>();
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
    rename: async (from: string, to: string) => (files.delete(from), void files.add(to)),
    remove: async (p: string) => void files.delete(p),
    byteSize: async (p: string) => (p === MODEL || p === TINY ? WHISPER_MODELS.small.bytes : 0),
    probeMedia: async () => ({
      id12: WHISPER_MODELS.small.sha256.slice(0, 12),
      sha256: WHISPER_MODELS.small.sha256,
      size: WHISPER_MODELS.small.bytes,
      head: new Uint8Array(),
    }),
    canStreamDownload: true,
    appendBytes: async () => true,
    resolveRef: async (r: string) => r,
  };
  const runner = {
    run: async (program: string, args: string[]) => {
      if (program === "ffmpeg") {
        files.add(args[args.length - 1]);
        return { code: 0, stdout: "", stderr: "" };
      }
      const launch = launches.length;
      launches.push(args);
      const said = say(launch, args);
      const out = `${args[args.indexOf("-of") + 1]}.json`;
      files.add(out);
      texts.set(out, spoken(said.language, said.text));
      onLaunched?.(launch);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const stop = new AbortController();
  const ctx = { store, runner, signal: stop.signal } as unknown as ClientToolContext;
  return { ctx, launches, stop, kept: () => [...kept.keys()] };
}

let seq = 0;
/** A file nobody has asked about: a run still joinable from another test is never joined. */
const freshSrc = (): string => `/media/decode-${++seq}.mp4`;
const words = (t: { words: Array<{ word: string }> }): string[] => t.words.map((w) => w.word);

beforeEach(() => {
  localStorage.clear();
  __resetWorkGate();
  reportAppError.mockClear();
  reportTranscription.mockClear();
});

describe("which arguments the engine is given", () => {
  it("decodes greedily for a language the gate cleared, and keeps the transcript", async () => {
    const r = rig(() => ({ language: "en", text: "hello" }));
    const src = freshSrc();
    const t = await runWhisper(r.ctx, src, "small", "en");
    expect(r.launches).toHaveLength(1);
    expect(r.launches[0].slice(-8)).toEqual(["-l", "en", "-mc", "0", "-bs", "1", "-bo", "1"]);
    expect(words(t)).toEqual(["hello"]);
    expect(words((await peekTranscript(r.ctx, src, "small", "en"))!)).toEqual(["hello"]);
  });

  it("gives every other language exactly the arguments it always had", async () => {
    // Korean is measured and NOT cleared on this model: nothing may be added after `-mc 0`.
    expect(beamFor("f16", "ko")).toBe(DEFAULT_BEAM);
    const r = rig(() => ({ language: "ko", text: "annyeong" }));
    await runWhisper(r.ctx, freshSrc(), "small", "ko");
    expect(r.launches[0][0]).toBe("-m");
    expect(r.launches[0][4]).toBe("-ojf");
    expect(r.launches[0].slice(-4)).toEqual(["-l", "ko", "-mc", "0"]);
    expect(r.launches[0]).not.toContain("-bs");
    expect(r.launches[0]).not.toContain("-bo");
  });

  it("never narrows a model size the gate did not measure, even for a cleared language", async () => {
    // Only `small` was measured. A size added later is handed to the engine as it always was until
    // someone measures it. The test gives `tiny` a spec of its own, as a later release might.
    const models = WHISPER_MODELS as Record<string, unknown>;
    models.tiny = WHISPER_MODELS.small;
    try {
      const r = rig(() => ({ language: "en", text: "x" }));
      await runWhisper(r.ctx, freshSrc(), "tiny", "en");
      expect(r.launches).toHaveLength(1);
      expect(r.launches[0]).toContain(TINY);
      expect(r.launches[0]).not.toContain("-bs");
      expect(r.launches[0].slice(-4)).toEqual(["-l", "en", "-mc", "0"]);
      // ...while the very same request on the measured model is greedy.
      const small = rig(() => ({ language: "en", text: "x" }));
      await runWhisper(small.ctx, freshSrc(), "small", "en");
      expect(small.launches[0]).toContain("-bs");
    } finally {
      delete models.tiny;
    }
  });
});

describe("a machine's first transcription, and the ones after it", () => {
  it("runs the first auto transcription at the engine's default and remembers what it heard", async () => {
    const r = rig(() => ({ language: "en", text: "first" }));
    await runWhisper(r.ctx, freshSrc());
    expect(r.launches).toHaveLength(1);
    expect(beamOf(r.launches[0])).toBe(DEFAULT_BEAM);
    expect(lastSpeechLanguage()).toBe("en");
    expect(reportTranscription.mock.calls[0][2]).toMatchObject({ beam: DEFAULT_BEAM });
  });

  it("decodes greedily from then on, for the language it last heard", async () => {
    const r = rig(() => ({ language: "en", text: "again" }));
    await runWhisper(r.ctx, freshSrc());
    await runWhisper(r.ctx, freshSrc());
    expect(r.launches.map(beamOf)).toEqual([DEFAULT_BEAM, GREEDY_BEAM]);
    expect(reportTranscription.mock.calls.at(-1)![2]).toMatchObject({ beam: GREEDY_BEAM });
  });

  it("does not remember a language that was only asked for by name", async () => {
    const r = rig(() => ({ language: "es", text: "hola" }));
    await runWhisper(r.ctx, freshSrc(), "small", "es");
    expect(lastSpeechLanguage()).toBeNull();
  });
});

describe("a prediction that was too narrow", () => {
  it("is refused and run again at the width the language needs; only the re-run is kept", async () => {
    rememberSpeechLanguage("en");
    const r = rig((launch) => ({ language: "ko", text: launch === 0 ? "first" : "second" }));
    const src = freshSrc();
    const t = await runWhisper(r.ctx, src);
    expect(r.launches.map(beamOf)).toEqual([GREEDY_BEAM, DEFAULT_BEAM]);
    expect(words(t)).toEqual(["second"]);
    expect(words((await peekTranscript(r.ctx, src))!)).toEqual(["second"]);
    expect(lastSpeechLanguage()).toBe("ko");
    // One transcript, reported as the re-run it was; the refused one reports nothing.
    expect(reportTranscription).toHaveBeenCalledTimes(1);
    expect(reportTranscription.mock.calls[0][2]).toMatchObject({ beam: DEFAULT_BEAM, rerun: true });
  });

  it("is kept as it is when the language turns out to be another one the gate cleared", async () => {
    rememberSpeechLanguage("en");
    const r = rig(() => ({ language: "es", text: "hola" }));
    await runWhisper(r.ctx, freshSrc());
    expect(r.launches).toHaveLength(1);
    expect(lastSpeechLanguage()).toBe("es");
  });

  it("is never re-run for a prediction that was WIDER than needed (the opposite ordering)", async () => {
    rememberSpeechLanguage("ko"); // predicted: needs the default beam
    const r = rig(() => ({ language: "en", text: "hello" })); // it was English after all
    const src = freshSrc();
    const t = await runWhisper(r.ctx, src);
    expect(r.launches.map(beamOf)).toEqual([DEFAULT_BEAM]);
    expect(words(t)).toEqual(["hello"]);
    expect(lastSpeechLanguage()).toBe("en");
  });

  it("keeps nothing when Stop comes between the refused run and its re-run", async () => {
    rememberSpeechLanguage("en");
    let r!: ReturnType<typeof rig>;
    r = rig(
      () => ({ language: "ko", text: "first" }),
      () => r.stop.abort(), // the first run ends, and the person presses Stop at that moment
    );
    const src = freshSrc();
    await expect(runWhisper(r.ctx, src)).rejects.toThrow(/cancelled/);
    expect(r.launches).toHaveLength(1);
    expect(r.kept()).toEqual([]);
    expect(await peekTranscript(r.ctx, src)).toBeNull();
    expect(reportTranscription).not.toHaveBeenCalled();
    // The engine did say Korean, so the machine predicts Korean next time, kept transcript or not.
    expect(lastSpeechLanguage()).toBe("ko");
  });

  it("lets two callers for the same file share ONE re-run", async () => {
    rememberSpeechLanguage("en");
    const r = rig((launch) => ({ language: "ko", text: launch === 0 ? "first" : "second" }));
    const src = freshSrc();
    const [a, b] = await Promise.all([runWhisper(r.ctx, src), runWhisper(r.ctx, src)]);
    expect(r.launches.map(beamOf)).toEqual([GREEDY_BEAM, DEFAULT_BEAM]);
    expect(words(a)).toEqual(["second"]);
    expect(words(b)).toEqual(["second"]);
  });
});

// The rule that survives any rewrite: whatever the engine reports, what is KEPT was not made
// narrower than that language needs, and getting there never takes more than two re-runs.
describe("the invariant, for ANY language the engine could report", () => {
  it("never keeps a transcript made narrower than its language needs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...CODES),
        fc.constantFrom(...CODES, "en", "en"),
        async (predicted, reported) => {
          localStorage.clear();
          __resetWorkGate();
          rememberSpeechLanguage(predicted);
          const r = rig(() => ({ language: reported, text: "x" }));
          const src = freshSrc();
          await runWhisper(r.ctx, src);
          const used = beamOf(r.launches.at(-1)!);
          expect(acceptableBeam(used, "f16", reported), `${predicted} -> ${reported}`).toBe(true);
          expect(r.launches.length).toBeLessThanOrEqual(2);
          expect(await peekTranscript(r.ctx, src)).not.toBeNull();
        },
      ),
      { numRuns: 60 },
    );
  });

  it("settles on the default when the language it re-runs for keeps changing", async () => {
    rememberSpeechLanguage("en");
    // Greedy hears Korean; the wider run then hears Hindi (also needing the default): never loops.
    const r = rig((launch) => ({ language: launch === 0 ? "ko" : "hi", text: String(launch) }));
    await runWhisper(r.ctx, freshSrc());
    expect(r.launches.map(beamOf)).toEqual([GREEDY_BEAM, DEFAULT_BEAM]);
  });
});
