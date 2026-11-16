// The launches and transcripts of the base this lane builds on, FROZEN before the first-word rule was built (lane L13,
// I-10). While the shipped constants are off (WORD_TIMES_SHIPPED, WORD_TIMES_CHIP_SHIPPED) nothing of the rule may show:
// every launch of the engine carries the arguments the base carried, every job records the meta it recorded, and every
// transcript is read as it was, whatever the server's switch says and whatever the audio holds.
//
// `__fixtures__/firstWord/frozen-l12.json` was recorded ONCE, by the code of client branch `l12/speech-q8-host` at commit
// e96ebdf4 (product code of 91428bb1, the smaller speech model's integration, on the 0.28.0 candidate 1b2be1b6), with
// `L13_RECORD=1`, before any change of this lane. It is never regenerated to make this test pass: if it moves, something
// changed what a user's launch or transcript is, and the cause is the finding. (The same scenarios recorded from the
// candidate itself differ from it only where the smaller model file's plan and the launch boundary say so: the lane's
// closure lists every difference.)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { FakeJobs } from "../test/fakeJobs";
import { DIR, flagValues, freshSource, speechRig } from "../test/speechRig";
import { __resetJobSupervisor, __setJobSupervisor, type JobSpec } from "./jobSupervisor";
import { MODEL_MANIFEST } from "./modelManifest";
import { __resetSpeechSession } from "./speechAdmission";
import { holdCpuOnly } from "./speechBackend";
import { recordSpeechRun } from "./speechPace";
import { __resetWordTimesShipped, __setWordTimesShipped } from "./speechWordTimes";
import {
  ensureTranscripts,
  peekTranscript,
  runWhisper,
  WHISPER_MODELS,
  whisperModelPath,
} from "./transcribe";
import { __resetWorkGate } from "./workGate";

const FIXTURES = path.join(__dirname, "__fixtures__", "wordTimes");
const FROZEN = path.join(__dirname, "__fixtures__", "firstWord", "frozen-l12.json");
const CRASH = -1073740791; // 0xC0000409, the exit the chip's crash is known for
const GPU_LOG =
  "ggml_vulkan: Found 1 Vulkan devices:\nwhisper_init_from_file_with_params_no_state: loading model\n";
const CLIP_DTW = readFileSync(path.join(FIXTURES, "en-leading-silence.json"), "utf8");
const CLIP_STORED = CLIP_DTW.replace(/"t_dtw": \d+/g, '"t_dtw": -1');
/** The manifest key of the smaller model file (the processor-only one). */
const SMALLER = "small_q8_0";

/** Strings that differ from one run of the test to the next, or from one PC to the next (a counter, a hash, a clock,
 *  how many threads the engine is given), made equal. */
const normalize = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value)
      .replace(/"-t","\d+"/g, '"-t","<n>"')
      .replace(/rig-\d+/g, "rig-N")
      .replace(/\/transcribe\/[0-9a-z]+/g, "/transcribe/<h>")
      .replace(/\.[0-9a-z]{4,12}\.tmp/g, ".<t>.tmp"),
  );

interface Scenario {
  name: string;
  processor: boolean;
  size?: string;
  window?: { start: number; end: number };
  /** How many files one call asks for: more than one is a run over several files. */
  files?: number;
  /** The first launch crashes as the graphics chip's does. */
  chipCrash?: boolean;
  /** The smaller model file is on the PC too; with `noChip` the PC's latest run was on its processor (no hold is kept),
   *  so the plan names the smaller file while the caller asks for the chip and the launch is converted. */
  smaller?: "held" | "noChip";
}

const SCENARIOS: Scenario[] = [
  { name: "one file on the processor", processor: true },
  { name: "one file on the graphics chip", processor: false },
  { name: "a window on the processor", processor: true, window: { start: 100, end: 110 } },
  { name: "a window on the graphics chip", processor: false, window: { start: 12.345, end: 22 } },
  {
    name: "the chip crashes and the retry runs on the processor",
    processor: false,
    chipCrash: true,
  },
  { name: "two files on the processor", processor: true, files: 2 },
  { name: "two files on the graphics chip", processor: false, files: 2 },
  { name: "a model that was not measured, on the processor", processor: true, size: "tiny" },
  // What the smaller file adds (it is planned only for a PC that transcribes on its processor).
  {
    name: "the smaller model file on a PC whose chip is held off",
    processor: true,
    smaller: "held",
  },
  {
    name: "the smaller model file on a PC with no usable chip (the launch is converted to the processor's)",
    processor: false,
    smaller: "noChip",
  },
  {
    name: "a window with the smaller model file on a PC with no usable chip",
    processor: false,
    smaller: "noChip",
    window: { start: 100, end: 110 },
  },
  {
    name: "two files with the smaller model file on a PC with no usable chip",
    processor: false,
    smaller: "noChip",
    files: 2,
  },
];

/** What the base does for one scenario: every job it submitted (arguments and meta), the words it kept, and the
 *  transcripts it answered. The engine is a stand-in that writes what a run WITHOUT the alignment writes. */
async function record(s: Scenario): Promise<unknown> {
  localStorage.clear();
  if (s.processor) holdCpuOnly(CRASH);
  if (s.smaller === "noChip") recordSpeechRun(60, 120, "cpu");
  const size = s.size ?? "small";
  const models = WHISPER_MODELS as Record<string, unknown>;
  const manifest = MODEL_MANIFEST as Record<string, unknown>;
  if (size === "tiny") {
    // The manifest says which files may be launched at all, so a `tiny` that borrows `small`'s entry must be one.
    models.tiny = { ...WHISPER_MODELS.small, file: "ggml-tiny.bin" };
    manifest.tiny = { ...MODEL_MANIFEST.small, file: "ggml-tiny.bin" };
  }
  try {
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    const rig = speechRig();
    rig.store.byteSize = async (p: string) =>
      p === whisperModelPath(DIR, size) ? WHISPER_MODELS.small.bytes : 0;
    rig.files.add(whisperModelPath(DIR, size));
    if (s.smaller) {
      // The smaller file is whole on disk: its size and checksum are what the manifest says.
      const specs = new Map(
        Object.entries(WHISPER_MODELS).map(([key, spec]) => [whisperModelPath(DIR, key), spec]),
      );
      Object.assign(rig.store, {
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
      });
      rig.files.add(whisperModelPath(DIR, SMALLER));
    }
    let launch = 0;
    jobs.onStart = (spec: JobSpec) =>
      void setTimeout(() => {
        const n = launch++;
        if (s.chipCrash && n === 0) return jobs.exit(spec.id, CRASH, GPU_LOG);
        for (const base of flagValues(spec.args, "-of")) {
          rig.files.add(`${base}.json`);
          rig.texts.set(`${base}.json`, CLIP_STORED);
        }
        jobs.exit(spec.id, 0, "");
      }, 0);
    const sources = Array.from({ length: s.files ?? 1 }, () => freshSource());
    const answered: unknown[] = [];
    if ((s.files ?? 1) > 1) {
      const outcomes = await ensureTranscripts(rig.ctx(), sources, size, "en");
      for (const src of sources) answered.push(await peekTranscript(rig.ctx(), src, size, "en"));
      answered.push(outcomes);
    } else {
      answered.push(await runWhisper(rig.ctx(), sources[0], size, "en", s.window));
      answered.push(await peekTranscript(rig.ctx(), sources[0], size, "en", s.window));
    }
    return normalize({
      jobs: jobs.submitted.map((spec) => ({
        program: spec.program,
        args: spec.args,
        meta: spec.meta,
      })),
      kept: [...rig.kept.entries()],
      answered,
    });
  } finally {
    delete models.tiny;
    delete manifest.tiny;
    __resetJobSupervisor();
  }
}

/** A JSON with an alignment in it, read from the cache the way 0.27.0 read every JSON. */
async function readStray(): Promise<unknown> {
  localStorage.clear();
  const rig = speechRig();
  const src = freshSource();
  const key = `whisper:v2:file:${src}:small:en`;
  rig.kept.set(`transcripts|${key}`, JSON.parse(CLIP_DTW));
  return normalize(await peekTranscript(rig.ctx(), src, "small", "en"));
}

const ALL = async (): Promise<Record<string, unknown>> => {
  const out: Record<string, unknown> = {};
  for (const s of SCENARIOS) out[s.name] = await record(s);
  out["a kept JSON that holds an alignment"] = await readStray();
  return out;
};

beforeEach(() => {
  localStorage.clear();
  __resetExportFlags();
  __resetWordTimesShipped();
  __resetSpeechSession();
  __resetWorkGate();
  reportAppError.mockClear();
  reportTranscription.mockClear();
});
afterEach(() => {
  __resetJobSupervisor();
  __resetExportFlags();
  __resetWordTimesShipped();
});

describe("with the shipped constants off, every launch and every transcript is the base's", () => {
  if (process.env.L13_RECORD === "1") {
    it("RECORDS the base's outputs (run once, on the base's code, before any change of this lane)", async () => {
      __setWordTimesShipped(false);
      mkdirSync(path.dirname(FROZEN), { recursive: true });
      writeFileSync(FROZEN, `${JSON.stringify(await ALL(), null, 1)}\n`);
    });
    return;
  }

  const frozen = JSON.parse(readFileSync(FROZEN, "utf8")) as Record<string, unknown>;

  it.each([
    ["the server's switch on", true],
    ["the server's switch off", false],
  ])("is byte for byte the frozen outputs, with %s", async (_label, flag) => {
    __setWordTimesShipped(false);
    __setExportFlag("speech_word_times", flag);
    const now = await ALL();
    expect(Object.keys(now)).toEqual(Object.keys(frozen));
    for (const name of Object.keys(frozen)) expect(now[name], name).toStrictEqual(frozen[name]);
  });

  it("freezes launches that carry none of the alignment's arguments, so the comparison above has teeth", () => {
    const text = JSON.stringify(frozen);
    expect(text).not.toContain('"-dtw"');
    expect(text).not.toContain('"-nfa"');
    expect(text).toContain('"-ng"');
    // The smaller model file is in the frozen launches too, and only ever with the processor's `-ng`.
    expect(text).toContain("ggml-small-q8_0.bin");
    expect(Object.keys(frozen)).toHaveLength(SCENARIOS.length + 1);
  });
});
