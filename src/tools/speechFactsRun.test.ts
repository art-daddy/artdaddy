// What the speech sample tells about how a run was made, through the REAL transcription path (runWhisper, ensureTranscripts,
// the launch boundary, the commit point) with a fake engine, and the REAL sample (reportTranscription) whose request is caught
// where it leaves the app. What is checked is what leaves the PC, and that every fact it states is true of the arguments the
// engine was really launched with: never how speechFacts.ts or transcribe.ts are arranged.
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportAppError } = vi.hoisted(() => ({ reportAppError: vi.fn() }));
// Only the app-error beacon is stood in for: the sample itself is the real one.
vi.mock("../api/appEvents", async (orig) => ({ ...(await orig<object>()), reportAppError }));
vi.mock("../api/auth", async (io) => ({
  ...(await io<typeof import("../api/auth")>()),
  hasSession: vi.fn(async () => true),
}));
vi.mock("@tauri-apps/api/path", () => ({ resolveResource: async () => "C:/res/fonts" }));

import { __resetAppEvents } from "../api/appEvents";
import { setClerkTokenProvider } from "../api/auth";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { __resetHostInfo } from "../platform/host";
import { useAuth } from "../store/auth";
import { FakeJobs } from "../test/fakeJobs";
import {
  flagValues,
  freshSource,
  installModels,
  speechRig,
  wavWithVoiceAt,
  type SpeechRigOptions,
} from "../test/speechRig";
import { __resetJobSupervisor, __setJobSupervisor } from "./jobSupervisor";
import { __resetSpeechSession } from "./speechAdmission";
import { holdCpuOnly } from "./speechBackend";
import { DEFAULT_BEAM } from "./speechDecoding";
import { __resetSpeechFactsShipped, __setSpeechFactsShipped } from "./speechFacts";
import { modelKeyOfPath } from "./speechModel";
import { recordSpeechRun } from "./speechPace";
import { __resetWordTimesShipped, __setWordTimesShipped } from "./speechWordTimes";
import { __resetSmallerFileFailure, ensureTranscripts, runWhisper } from "./transcribe";
import { __resetWorkGate } from "./workGate";

const CRASH = -1073740791; // 0xC0000409, the exit the chip's crash is known for
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

const fixture = (name: string): string =>
  readFileSync(
    path.join(__dirname, "__fixtures__", "whisper", `${name}.stderr.txt`),
    "utf8",
  ).replace(/\r\n/g, "\n");
/** A capture of the shipped engine, made to say that it read ten minutes of audio in 66.1 seconds (a single run under the
 *  sample's floor of 30 seconds of audio is not reported at all). */
const longRun = (log: string): string => {
  const said = log
    .replace("(171562 samples, 10.7 sec)", "(9600000 samples, 600.0 sec)")
    .replace(/total time =\s+[\d.]+ ms/, "total time =  66100.00 ms");
  expect(said).toContain("600.0 sec");
  return said;
};
/** What the engine printed when it ran on the graphics chip (an AMD one, through Vulkan) and on the processor. */
const ON_CHIP = longRun(fixture("vulkan"));
const ON_PROCESSOR = longRun(fixture("cpu"));
/** A run over several files, on the same chip. */
const BATCH_ON_CHIP = fixture("batch3");

/** The words of the sample's `reason` that this change added, in the order they were written. */
const NEW_KEYS = new Set(["ng", "held", "mf", "net", "dtw", "lead", "gpu", "lang"]);
const factsOf = (reason: string): string[] =>
  reason.split(" ").filter((token) => NEW_KEYS.has(token.split("=")[0]));

/** The beam a launch was given: the engine's own default when its arguments do not name one. */
const beamOf = (args: readonly string[]): number =>
  args.includes("-bs") ? Number(flagValues(args, "-bs")[0]) : DEFAULT_BEAM;
/** What 0.28.0 sends for the run the logs above describe (ten minutes of audio in 66.1 seconds, eight threads): the older
 *  figures and nothing more. The beam is the one the launch was given. */
const OLD_SAMPLE = (beam: number): string =>
  `audio_s=600.0 wall_s=66.1 x=9.08 model=small threads=8 beam=${beam}`;
/** whisper's output for one clip that says one word. */
const A_WORD =
  '{"result":{"language":"en"},"transcription":[{"offsets":{"from":0,"to":1000},"text":" a","tokens":[{"text":" a","offsets":{"from":0,"to":1000},"p":0.9}]}]}';

let sent: Record<string, unknown>[] = [];

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WINDOWS_UA);
  __resetHostInfo();
  __resetExportFlags();
  __resetSpeechSession();
  __resetWorkGate();
  __resetSmallerFileFailure();
  __resetAppEvents();
  reportAppError.mockClear();
  __setWordTimesShipped(true);
  __setExportFlag("speech_word_times", true);
  __setSpeechFactsShipped(true);
  useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
  setClerkTokenProvider(async () => "isolated-speech-facts-session");
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      // Everything the sample sends is caught; any other request (a model download, the switches) finds the network down.
      if (!String(url).endsWith("/telemetry/app")) throw new Error("offline");
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, status: "ok" }), { status: 200 });
    }),
  );
});
afterEach(() => {
  __resetJobSupervisor();
  __resetSpeechFactsShipped();
  __resetWordTimesShipped();
  __resetExportFlags();
  __resetAppEvents();
  setClerkTokenProvider(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetHostInfo();
});

interface Scenario {
  /** The graphics chip is being kept off (the hold the app keeps after a crash). */
  hold?: boolean;
  /** The PC's own history says it has no usable chip, so the smaller model file is planned when it is on disk. */
  noChip?: boolean;
  /** The smaller model file is on disk as well as the full-size one. */
  smaller?: boolean;
  /** Where the voice starts in the audio, in milliseconds. Absent: the store cannot read the audio at all. */
  voiceAtMs?: number;
  /** What the engine prints, and how each launch ends. */
  log?: string;
  engine?: SpeechRigOptions["engine"];
  language?: string;
}

/** One transcription of one clip under `s`, and the one sample it leaves, as the service would receive it. */
async function transcribed(s: Scenario) {
  localStorage.clear();
  __resetAppEvents();
  sent = [];
  if (s.hold) holdCpuOnly(CRASH);
  if (s.noChip) recordSpeechRun(60, 120, "cpu");
  const rig = speechRig({
    ...(s.voiceAtMs === undefined ? {} : { audio: () => wavWithVoiceAt(s.voiceAtMs!) }),
    engine: s.engine ?? (async () => ({ code: 0, stderr: s.log ?? ON_CHIP })),
  });
  if (s.smaller) installModels(rig, ["small", "small_q8_0"]);
  await runWhisper(rig.ctx(), freshSource(), "small", s.language ?? "en");
  return { ...(await theSample()), launches: rig.launches };
}

async function theSample() {
  await vi.waitFor(() => expect(sent.filter((e) => e.event === "transcription")).toHaveLength(1));
  const body = sent.find((e) => e.event === "transcription")!;
  return { reason: String(body.reason), via: String(body.via), body };
}

/** What the arguments of a launch say of the four facts they can: the rule that every sample must agree with. */
function saidByTheLaunch(args: readonly string[]): string[] {
  const key = modelKeyOfPath(flagValues(args, "-m")[0]);
  return [
    ...(args.includes("-ng") ? ["ng=1"] : []),
    `mf=${key}`,
    ...(args.includes("-dtw") ? ["dtw=1"] : []),
    `lang=${flagValues(args, "-l")[0]}`,
  ];
}
/** The facts a sample states that the arguments of the launch can confirm or deny. */
const confirmable = (tokens: string[]): string[] =>
  tokens.filter((t) => /^(ng|mf|lang)=/.test(t) || t === "dtw=1");

describe("what the sample says about how a run was made", () => {
  it("a run on the graphics chip of a Windows PC whose voice starts late: the first-word arguments, where the voice started, the chip's maker", async () => {
    const got = await transcribed({ voiceAtMs: 1360 });
    expect(got.via).toBe("vulkan");
    expect(factsOf(got.reason)).toEqual(["mf=small", "dtw=1", "lead=gt1", "gpu=amd", "lang=en"]);
  });

  it("a voice that starts within a second: the rule looked, found nothing to align, and the sample says so", async () => {
    const got = await transcribed({ voiceAtMs: 400 });
    expect(factsOf(got.reason)).toEqual(["mf=small", "lead=le1", "gpu=amd", "lang=en"]);
  });

  it("a PC that cannot read the audio's start says it is not known, and still says everything else", async () => {
    const got = await transcribed({});
    expect(factsOf(got.reason)).toEqual(["mf=small", "lead=unk", "gpu=amd", "lang=en"]);
  });

  it("a chip that is being kept off after a crash: the processor, held, and no maker (the run did not use the chip)", async () => {
    const got = await transcribed({ hold: true, voiceAtMs: 1360, log: ON_PROCESSOR });
    expect(got.via).toBe("cpu");
    // the engine listed the chip in its own log even then: only a run that used it has a maker
    expect(ON_PROCESSOR).toMatch(/^ggml_vulkan: 0 = AMD Radeon/m);
    expect(factsOf(got.reason)).toEqual([
      "ng=1",
      "held=1",
      "mf=small",
      "dtw=1",
      "lead=gt1",
      "lang=en",
    ]);
  });

  it("the smaller model file, which only the processor may run: the file, the processor, and nothing measured for it", async () => {
    const got = await transcribed({
      noChip: true,
      smaller: true,
      voiceAtMs: 1360,
      log: ON_PROCESSOR,
    });
    // its alignment was never measured, so the rule never looked at the voice and the sample has no word for it
    expect(factsOf(got.reason)).toEqual(["ng=1", "mf=small_q8_0", "lang=en"]);
  });

  it("the net: the full-size file that ran after the engine failed on the smaller one says so", async () => {
    const got = await transcribed({
      noChip: true,
      smaller: true,
      engine: async (launch) =>
        launch === 0
          ? { code: 1, stderr: "whisper-cli: the model could not be used" }
          : { code: 0, stderr: ON_PROCESSOR },
    });
    expect(got.launches).toHaveLength(2);
    expect(modelKeyOfPath(flagValues(got.launches[0], "-m")[0])).toBe("small_q8_0");
    expect(modelKeyOfPath(flagValues(got.launches[1], "-m")[0])).toBe("small");
    expect(factsOf(got.reason)).toEqual(["mf=small", "net=1", "lead=unk", "lang=en"]);
  });

  it("a launch with the first-word arguments that failed and was redone without them: redone, and where the voice started is still said", async () => {
    const got = await transcribed({
      voiceAtMs: 1360,
      engine: async (_launch, args) =>
        args.includes("-dtw") ? { code: 1, stderr: "" } : { code: 0, stderr: ON_CHIP },
    });
    expect(got.launches).toHaveLength(2);
    expect(got.launches[0]).toContain("-dtw");
    expect(got.launches[1]).not.toContain("-dtw");
    expect(factsOf(got.reason)).toEqual(["mf=small", "dtw=r", "lead=gt1", "gpu=amd", "lang=en"]);
  });

  it("a chip that crashed, retried on the processor: the retry says it carried -ng, and it is not a held chip (the hold is for the next run)", async () => {
    const got = await transcribed({
      voiceAtMs: 400,
      engine: async (launch) =>
        launch === 0 ? { code: CRASH, stderr: ON_CHIP } : { code: 0, stderr: ON_PROCESSOR },
    });
    expect(got.launches).toHaveLength(2);
    expect(got.launches[0]).not.toContain("-ng");
    expect(got.launches[1]).toContain("-ng");
    expect(factsOf(got.reason)).toEqual(["ng=1", "mf=small", "lead=le1", "lang=en"]);
  });

  it("an aligned launch that crashed on the chip, the plain retry that crashed too, then the processor: redone, with where the voice started kept from the first", async () => {
    const got = await transcribed({
      voiceAtMs: 1360,
      engine: async (launch) =>
        launch < 2 ? { code: CRASH, stderr: ON_CHIP } : { code: 0, stderr: ON_PROCESSOR },
    });
    expect(got.launches).toHaveLength(3);
    expect(got.launches[0]).toContain("-dtw");
    expect(got.launches[1]).not.toContain("-dtw");
    expect(got.launches[2]).toContain("-ng");
    expect(got.launches[2]).not.toContain("-dtw");
    expect(factsOf(got.reason)).toEqual(["ng=1", "mf=small", "dtw=r", "lead=gt1", "lang=en"]);
  });

  it("the language it was asked for, as the engine takes it: a code, or auto", async () => {
    expect(factsOf((await transcribed({ language: "hi" })).reason)).toContain("lang=hi");
    expect(factsOf((await transcribed({ language: "auto" })).reason)).toContain("lang=auto");
    // a name the engine does not know is detected, so it is said as auto and never as what was typed
    expect(factsOf((await transcribed({ language: "Klingon" })).reason)).toContain("lang=auto");
  });

  it("a run over several files: one launch for them all, so the facts of a launch and none about where one voice started", async () => {
    const rig = speechRig({ engine: async () => ({ code: 0, stderr: BATCH_ON_CHIP }) });
    const [a, b] = [freshSource(), freshSource()];
    const outcomes = await ensureTranscripts(rig.ctx(), [a, b], "small", "en");
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
    expect(rig.launches).toHaveLength(1);
    const got = await theSample();
    expect(got.reason).toContain("files=2");
    expect(factsOf(got.reason)).toEqual(["mf=small", "gpu=amd", "lang=en"]);
  });

  it("never states a fact the launch does not bear out, whichever way the run was made", async () => {
    const scenarios: Scenario[] = [
      { voiceAtMs: 1360 },
      { voiceAtMs: 400 },
      {},
      { hold: true, voiceAtMs: 1360, log: ON_PROCESSOR },
      { noChip: true, smaller: true, log: ON_PROCESSOR },
      { noChip: true, voiceAtMs: 1360, log: ON_PROCESSOR },
      {
        voiceAtMs: 1360,
        engine: async (_launch, args) =>
          args.includes("-dtw") ? { code: 1, stderr: "" } : { code: 0, stderr: ON_CHIP },
      },
      { language: "pt" },
    ];
    for (const s of scenarios) {
      const got = await transcribed(s);
      // the launch whose words were kept is the last one; a launch redone without the first-word arguments carries none,
      // and the sample says `dtw=r` of it, which is not among the facts a launch can confirm
      expect(confirmable(factsOf(got.reason)), JSON.stringify(s)).toEqual(
        confirmable(saidByTheLaunch(got.launches.at(-1)!)),
      );
      // and it never says more than the lists allow
      for (const token of factsOf(got.reason)) expect(token).toMatch(/^[a-z]+=[A-Za-z0-9_]+$/);
    }
  });
});

describe("a build that keeps the facts dark", () => {
  /** The arguments of a launch with the names that are unique to every run (the audio's and the output's) left out. */
  const argv = (args: string[]): string[] =>
    args.map((a, i) => (["-f", "-of"].includes(args[i - 1]) ? "<unique>" : a));

  it("sends the sample it always sent: turning the facts on only adds to it, after the older figures", async () => {
    const on = await transcribed({ voiceAtMs: 1360, hold: true, log: ON_PROCESSOR });
    __setSpeechFactsShipped(false);
    const off = await transcribed({ voiceAtMs: 1360, hold: true, log: ON_PROCESSOR });
    expect(factsOf(off.reason)).toEqual([]);
    // exactly what 0.28.0 sends for this run, not only free of the new words: a word under any other name would show here
    expect(off.reason).toBe(OLD_SAMPLE(beamOf(off.launches.at(-1)!)));
    expect(factsOf(on.reason).length).toBeGreaterThan(0);
    expect(on.reason.startsWith(off.reason)).toBe(true);
    expect(on.reason.slice(off.reason.length).trim().split(" ")).toEqual(factsOf(on.reason));
    // the engine was launched the same way either way
    expect(argv(off.launches.at(-1)!)).toEqual(argv(on.launches.at(-1)!));
  });

  it("writes nothing on the run's own record, and on a build that tells them writes exactly what the sample says", async () => {
    const recorded = async (gate: boolean, hold: boolean) => {
      localStorage.clear();
      __setSpeechFactsShipped(gate);
      const jobs = new FakeJobs();
      __setJobSupervisor(jobs);
      if (hold) holdCpuOnly(CRASH);
      const rig = speechRig({ audio: () => wavWithVoiceAt(1360) });
      jobs.onStart = (spec) =>
        void setTimeout(() => {
          const out = `${spec.args[spec.args.indexOf("-of") + 1]}.json`;
          rig.files.add(out);
          rig.texts.set(out, A_WORD);
          jobs.exit(spec.id, 0, ON_PROCESSOR);
        }, 0);
      await runWhisper(rig.ctx(), freshSource(), "small", "en");
      return jobs.submitted.filter((s) => s.program === "whisper-cli");
    };
    const dark = await recorded(false, true);
    expect(dark).toHaveLength(1);
    expect(dark[0].meta).not.toHaveProperty("notes");
    const lit = await recorded(true, true);
    expect(lit).toHaveLength(1);
    // a page that takes the run over after a crash reads this: the launch's own facts, as the sample will say them
    expect(lit[0].meta).toMatchObject({
      kind: "transcript",
      notes: { ng: true, held: true, mf: "small", dtw: "1", lead: "gt1" },
    });
    expect(lit[0].meta.notes).not.toHaveProperty("lang");
    expect(lit[0].meta.notes).not.toHaveProperty("net");
  });

  it("writes no mark of the net run on its record when dark, and the mark on the run that went on when lit", async () => {
    const netRun = async (gate: boolean) => {
      localStorage.clear();
      // a run that went on with the full-size file keeps the smaller one out of the plan for the rest of the session
      __resetSmallerFileFailure();
      __setSpeechFactsShipped(gate);
      recordSpeechRun(60, 120, "cpu");
      const jobs = new FakeJobs();
      __setJobSupervisor(jobs);
      const rig = speechRig({});
      installModels(rig, ["small", "small_q8_0"]);
      jobs.onStart = (spec) =>
        void setTimeout(() => {
          const smaller = modelKeyOfPath(flagValues(spec.args, "-m")[0]) === "small_q8_0";
          if (!smaller) {
            const out = `${spec.args[spec.args.indexOf("-of") + 1]}.json`;
            rig.files.add(out);
            rig.texts.set(out, A_WORD);
          }
          jobs.exit(
            spec.id,
            smaller ? 1 : 0,
            smaller ? "whisper-cli: the model could not be used" : ON_PROCESSOR,
          );
        }, 0);
      await runWhisper(rig.ctx(), freshSource(), "small", "en");
      return jobs.submitted.filter((s) => s.program === "whisper-cli");
    };
    const dark = await netRun(false);
    expect(dark).toHaveLength(2);
    for (const spec of dark) expect(spec.meta).not.toHaveProperty("notes");
    const lit = await netRun(true);
    expect(lit).toHaveLength(2);
    expect(modelKeyOfPath(flagValues(lit[0].args, "-m")[0])).toBe("small_q8_0");
    expect(modelKeyOfPath(flagValues(lit[1].args, "-m")[0])).toBe("small");
    expect(lit[0].meta.notes).toMatchObject({ ng: true, mf: "small_q8_0" });
    expect(lit[0].meta.notes).not.toHaveProperty("net");
    expect(lit[1].meta.notes).toMatchObject({ net: true, mf: "small" });
  });
});

describe("a run a crashed page left in the app process", () => {
  /** The first page launches a run (alone on the processor with the chip held off, or two files in one launch on the chip) and
   *  dies; the next page, a module graph of its own that knows nothing but what the job's record says, takes the run over and
   *  reports it. The record the next page reads is the one that was serialised when the job was submitted, as the app
   *  process's own supervisor keeps it (the stand-in keeps the live object, which a launch could still be writing to), and
   *  what the first page left in the browser's own storage (the hold on the chip) is gone. */
  async function reportedByTheNextPage(gate: boolean, several = false) {
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    const serialised = new Map<string, Record<string, unknown>>();
    const submit = jobs.submit.bind(jobs);
    jobs.submit = async (spec) => {
      serialised.set(spec.id, JSON.parse(JSON.stringify(spec.meta)) as Record<string, unknown>);
      return submit(spec);
    };
    if (!several) holdCpuOnly(CRASH);
    __setSpeechFactsShipped(gate);
    const rig = speechRig({ ...(several ? {} : { audio: () => wavWithVoiceAt(1360) }) });
    if (several) void ensureTranscripts(rig.ctx(), [freshSource(), freshSource()], "small", "en");
    else void runWhisper(rig.ctx(), freshSource(), "small", "en").catch(() => undefined);
    for (let i = 0; i < 500 && jobs.started.length === 0; i++)
      await new Promise((r) => setTimeout(r, 2));
    expect(jobs.started).toHaveLength(1);
    const [spec] = jobs.submitted.filter((s) => s.program === "whisper-cli");
    const record = serialised.get(spec.id)!;
    jobs.pageDied();
    localStorage.clear();
    const [view] = (await jobs.list()).filter((v) => v.id === spec.id);
    jobs.restoreJob({
      ...view,
      meta: JSON.parse(JSON.stringify(record)) as Record<string, unknown>,
    });
    vi.resetModules();
    const [transcribe, supervisor, wordTimes, flags, facts, auth, session] = await Promise.all([
      import("./transcribe"),
      import("./jobSupervisor"),
      import("./speechWordTimes"),
      import("../api/exportFlags"),
      import("./speechFacts"),
      import("../store/auth"),
      import("../api/auth"),
    ]);
    supervisor.__setJobSupervisor(jobs);
    wordTimes.__setWordTimesShipped(true);
    flags.__setExportFlag("speech_word_times", true);
    facts.__setSpeechFactsShipped(gate);
    auth.useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
    session.setClerkTokenProvider(async () => "isolated-speech-facts-next-page");
    sent = [];
    const io = {
      exists: (p: string) => rig.store.exists(p),
      readText: (p: string) => rig.store.readText(p),
      remove: (p: string) => rig.store.remove(p),
      appCache: () => rig.store.appCache(),
    };
    expect(await transcribe.adoptTranscriptions(io as never)).toBe(1);
    for (const base of flagValues(spec.args, "-of")) {
      rig.files.add(`${base}.json`);
      rig.texts.set(`${base}.json`, A_WORD);
    }
    jobs.exit(spec.id, 0, several ? BATCH_ON_CHIP : ON_PROCESSOR);
    return { spec, record, sample: await theSample() };
  }

  it("is reported by the next page with the facts of the launch that made it, read from the job's own record", async () => {
    const { spec, record, sample } = await reportedByTheNextPage(true);
    expect(spec.args).toContain("-ng");
    expect(spec.args).toContain("-dtw");
    // what the app process was handed when the job was made: the launch's facts were already on it
    expect(record).toMatchObject({
      kind: "transcript",
      notes: { ng: true, held: true, mf: "small", dtw: "1", lead: "gt1" },
    });
    expect(factsOf(sample.reason)).toEqual([
      "ng=1",
      "held=1",
      "mf=small",
      "dtw=1",
      "lead=gt1",
      "lang=en",
    ]);
  });

  it("is reported by the next page as it would have been by the first, for one launch over several files too", async () => {
    const { spec, record, sample } = await reportedByTheNextPage(true, true);
    expect(flagValues(spec.args, "-f")).toHaveLength(2);
    const items = (record as { items: Array<{ notes?: unknown }> }).items;
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.notes).toMatchObject({ mf: "small" });
    expect(sample.reason).toContain("files=2");
    expect(factsOf(sample.reason)).toEqual(["mf=small", "gpu=amd", "lang=en"]);
  });

  it("is reported as the sample always was when the build keeps the facts dark", async () => {
    const { spec, record, sample } = await reportedByTheNextPage(false);
    expect(record).not.toHaveProperty("notes");
    expect(factsOf(sample.reason)).toEqual([]);
    expect(sample.reason).toBe(OLD_SAMPLE(beamOf(spec.args)));
  });
});
