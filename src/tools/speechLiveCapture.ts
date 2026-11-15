// The capture of ONE run of the speech engine, and what is done with it (the real-sidecar proof, P1).
//
// What is unproven about the engine is what the app ASSUMES of it: that its stdout is flushed one burst per
// decoded window, that the segment lines read with the monitor's pattern, that the monitor's speed matches the
// engine's own timings, that the live check acts at the right moments on the real cadence, that a kill ends
// the process. A capture is what the real engine did (every stdout chunk with the time it arrived, the head of
// its log, its own timing lines, how it ended), kept in one small JSON file. `replayMonitor` then feeds it to
// the app's monitor and live check exactly as the app does, with no engine at all.
//
// The file holds NO speech and NO path of the PC it was made on, and the schema check enforces that (the writer
// is not trusted with it): every segment line keeps its two timestamps and carries a placeholder as its text,
// the log has its paths taken out, the flags name the model by its file and the audio by a placeholder.
//
// The fake engine (`fakeRun`) makes what the real engine prints, from the facts the code already knows, so the
// replay and the smoke test are proven before the real engine is run once.
import {
  createLiveCheck,
  createSpeechMonitor,
  type LiveReading,
  type MonitorSnapshot,
} from "./speechMonitor";
import { CAP_S } from "./speechPlan";
import { whisperRunFacts } from "./whisperFacts";

export const CAPTURE_SCHEMA = "speech-live-capture-v1";
/** What the app's job supervisor keeps of the head of an engine's log (jobs.rs HEAD_BYTES). */
export const STDERR_HEAD_BYTES = 16 * 1024;
/** What a segment's text is replaced by. */
export const BLANKED = "[text blanked]";
export const TEXT_POLICY =
  "Segment text is blanked: every segment line keeps its two timestamps and the placeholder replaces the " +
  "words, so the file holds no speech; the log has its paths removed.";

export interface StdoutChunk {
  /** Milliseconds from the launch of the engine to the arrival of this output. */
  tMs: number;
  text: string;
}

export interface RunExit {
  /** The process's exit status; null when it reported none. */
  code: number | null;
  /** Milliseconds from launch to the process being gone. */
  wallMs: number;
  /** Milliseconds from launch to the moment Cancel was pressed (a run that was killed). */
  killedAtMs?: number;
  /** What the app's result for the run said stopped it. Absent for a run nobody stopped. */
  stoppedBy?: "person" | "too_slow";
  /** Milliseconds from Cancel to the process being gone. */
  deathMs?: number;
  /** The engine's output file was still on disk after the run was stopped. */
  outputFileLeft?: boolean;
  /** How many times the engine was launched for this one run (a chip crash makes a second). */
  launches?: number;
}

export interface RunCapture {
  engine: {
    /** What the engine's own log says it ran on: "cpu", "vulkan", ... */
    backend: string;
    threads: number | null;
    model: string | null;
    /** The flags the app gave it, with the model named by its file and the audio and scratch by placeholder. */
    args: string[];
  };
  /** Seconds of audio the engine was handed. */
  audioS: number;
  chunks: StdoutChunk[];
  /** The first {@link STDERR_HEAD_BYTES} of the engine's log, paths removed. */
  stderrHead: string;
  /** The engine's own timing lines, as `whisperRunFacts` reads them. */
  stderrFacts: { totalMs?: number; loadMs?: number; audioS?: number };
  /** What the engine's own final output file held: how many segments, and where the last one ended. */
  finalJson?: { segments: number; lastEndS: number };
  exit: RunExit;
}

/** What the chip's store said after one output, with the times since the launch. */
export interface ChipSample {
  tMs: number;
  phase: string;
  firstWordsMs: number | null;
  doneS: number;
  rate: number | null;
  etaS: number | null;
}

export interface AppRunCapture extends RunCapture {
  /** The chip's store sampled after every output of a run through the app's own path. */
  chip: ChipSample[];
}

export interface SpeechLiveCapture extends RunCapture {
  schema: typeof CAPTURE_SCHEMA;
  textPolicy: string;
  /** The same recording, killed at a known time (Cancel). */
  killed?: RunCapture;
  /** The same recording through the app's own path, with the chip's store sampled. */
  app?: AppRunCapture;
}

/** What a file may leave out, as paths in the capture; the ones of a run apply to the run of every section.
 *  The schema check's conformance test walks a complete capture and deletes each field in turn: a field that is
 *  neither here nor required by the check fails it. */
export const OPTIONAL_FIELDS: readonly string[] = [
  "killed",
  "app",
  "finalJson",
  "stderrFacts.totalMs",
  "stderrFacts.loadMs",
  "stderrFacts.audioS",
  "exit.killedAtMs",
  "exit.stoppedBy",
  "exit.deathMs",
  "exit.outputFileLeft",
  "exit.launches",
];

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// The segment pattern, written again here and not imported: it is the oracle the monitor's own is checked against.
const SEGMENT =
  /\[(\d{1,4}):([0-5]\d):([0-5]\d)[.,](\d{3}) --> (\d{1,4}):([0-5]\d):([0-5]\d)[.,](\d{3})\]/g;
const SEGMENT_LINE =
  /^\[\d{1,4}:[0-5]\d:[0-5]\d[.,]\d{3} --> \d{1,4}:[0-5]\d:[0-5]\d[.,]\d{3}\](.*)$/;
const SEGMENT_HEAD = /^\[\d{1,4}:[0-5]\d:[0-5]\d[.,]\d{3} --> \d{1,4}:[0-5]\d:[0-5]\d[.,]\d{3}\]$/;

const clock = (h: string, m: string, s: string, ms: string): number =>
  Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;

/** `seconds` as whisper-cli prints a time: hh:mm:ss.mmm (or with a comma). */
export function stamp(seconds: number, comma = false): string {
  const total = Math.round(Math.max(0, seconds) * 1000);
  const ms = total % 1000;
  const whole = Math.floor(total / 1000);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}${comma ? "," : "."}${pad(ms, 3)}`;
}

// ---------------------------------------------------------------------------------------------------------
// What the engine printed: the segments in a capture, counted without the monitor.

export interface SegmentBurst {
  /** The arrival time of the output that completed a segment line. */
  tMs: number;
  /** Seconds of audio read so far: the end of the latest segment up to and including this output. */
  endS: number;
}

function scan(chunks: readonly StdoutChunk[]): { segments: number; bursts: SegmentBurst[] } {
  const text = chunks.map((c) => c.text).join("");
  const ends: number[] = [];
  let at = 0;
  for (const c of chunks) {
    at += c.text.length;
    ends.push(at);
  }
  const bursts: SegmentBurst[] = [];
  let segments = 0;
  let chunk = 0;
  let position = 0;
  let lastChunk = -1;
  for (const m of text.matchAll(SEGMENT)) {
    const start = clock(m[1], m[2], m[3], m[4]);
    const end = clock(m[5], m[6], m[7], m[8]);
    // a segment that ends before it starts is not one: the monitor skips it too
    if (!(end >= start)) continue;
    segments++;
    const last = (m.index ?? 0) + m[0].length - 1;
    while (chunk < ends.length - 1 && ends[chunk] <= last) chunk++;
    position = Math.max(position, end);
    if (chunk !== lastChunk) {
      bursts.push({ tMs: chunks[chunk].tMs, endS: position });
      lastChunk = chunk;
    } else bursts[bursts.length - 1].endS = position;
  }
  return { segments, bursts };
}

/** The outputs that completed at least one segment line, in order, with how far the audio had got. */
export function segmentBursts(chunks: readonly StdoutChunk[]): SegmentBurst[] {
  return scan(chunks).bursts;
}

export interface SegmentStats {
  segments: number;
  lastEndS: number;
  bursts: number;
  burstTimesMs: number[];
}

/** What a capture's stdout holds, from its text alone. */
export function segmentStats(chunks: readonly StdoutChunk[]): SegmentStats {
  const { segments, bursts } = scan(chunks);
  return {
    segments,
    lastEndS: bursts.length ? bursts[bursts.length - 1].endS : 0,
    bursts: bursts.length,
    burstTimesMs: bursts.map((b) => b.tMs),
  };
}

// ---------------------------------------------------------------------------------------------------------
// What may be kept of a real run, and the check that it was.

/** Keeps every timestamp of a segment line and replaces its words by {@link BLANKED}, reading the stream chunk
 *  by chunk (a line is cut wherever the pipe cut it, and the result is the same however it is cut). Lines that
 *  are not segment lines pass unchanged; the schema check refuses a file that holds one. */
export function createTextBlanker(): (chunk: string) => string {
  let line = "";
  let inText = false;
  return (chunk) => {
    let out = "";
    for (const ch of chunk) {
      if (inText) {
        if (ch === "\n") {
          inText = false;
          line = "";
          out += "\n";
        }
        continue;
      }
      out += ch;
      if (ch === "\n") {
        line = "";
        continue;
      }
      line += ch;
      if (ch === "]" && SEGMENT_HEAD.test(line)) {
        out += `  ${BLANKED}`;
        inText = true;
      }
    }
    return out;
  };
}

/** The engine's log without the paths of the PC it ran on: a quoted path (the model, the audio, the output), the
 *  path a backend library was loaded from, and any other drive path; then each of `needles` (the home folder, the
 *  user's name, the PC's name), wherever they are left. No line is added or lost. */
export function redactPaths(text: string, needles: readonly string[] = []): string {
  let out = text
    .replace(/'[^'\n]*[\\/][^'\n]*'/g, "'<path>'")
    .replace(/(\bfrom )(?:[A-Za-z]:)?[\\/][^\n]*/g, "$1<path>")
    .replace(/\b[A-Za-z]:[\\/][^\s'"]*/g, "<path>");
  for (const needle of needles) {
    if (!needle) continue;
    out = out.replace(
      new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      "<redacted>",
    );
  }
  return out;
}

/** The flags as the app gave them, minus what names the PC: the model by its file, the audio and the scratch
 *  output by placeholder. */
export function sanitizeArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    out.push(flag);
    const value = args[i + 1];
    if (value === undefined) continue;
    if (flag === "-m") {
      out.push(value.split(/[\\/]/).pop() ?? "<model>");
      i++;
    } else if (flag === "-f") {
      out.push("<audio>");
      i++;
    } else if (flag === "-of") {
      out.push("<scratch>");
      i++;
    }
  }
  return out;
}

/** The engine's own timing lines, as `whisperRunFacts` reads them (and its `load time`). */
export function readStderrFacts(stderr: string): {
  totalMs?: number;
  loadMs?: number;
  audioS?: number;
} {
  const facts = whisperRunFacts(stderr);
  const load = /whisper_print_timings:\s+load time =\s+(\d+(?:\.\d+)?) ms/.exec(stderr);
  return {
    ...(facts.wallSeconds === null ? {} : { totalMs: Math.round(facts.wallSeconds * 1e5) / 100 }),
    ...(load ? { loadMs: Number(load[1]) } : {}),
    ...(facts.audioSeconds === null ? {} : { audioS: facts.audioSeconds }),
  };
}

const PRIVATE: ReadonlyArray<readonly [string, RegExp]> = [
  ["a drive path", /(^|[^A-Za-z])[A-Za-z]:[\\/]/],
  ["a network path", /\\\\[^\\\s]+\\/],
  ["a home folder", /(^|[\s'"])\/(Users|home)\//],
  ["an e-mail address", /[\w.+-]+@[\w-]+\.[\w.-]+/],
];

function* stringsIn(v: unknown, at = ""): Generator<[string, string]> {
  if (typeof v === "string") yield [at, v];
  else if (Array.isArray(v))
    for (let i = 0; i < v.length; i++) yield* stringsIn(v[i], `${at}[${i}]`);
  else if (isObj(v))
    for (const [k, child] of Object.entries(v)) yield* stringsIn(child, at ? `${at}.${k}` : k);
}

function checkRun(run: unknown, prefix: string, problems: string[]): void {
  const bad = (field: string, why: string): void => {
    problems.push(`${prefix}${field}: ${why}`);
  };
  if (!isObj(run)) {
    problems.push(`${prefix || "capture"}: must be an object`);
    return;
  }
  const e = run.engine;
  if (!isObj(e)) bad("engine", "must be an object");
  else {
    if (typeof e.backend !== "string" || !e.backend) bad("engine.backend", "must be a name");
    if (e.threads !== null && !finite(e.threads)) bad("engine.threads", "must be a number or null");
    if (e.model !== null && typeof e.model !== "string")
      bad("engine.model", "must be a name or null");
    if (!Array.isArray(e.args) || !e.args.every((a) => typeof a === "string"))
      bad("engine.args", "must be a list of strings");
  }
  if (!finite(run.audioS) || run.audioS <= 0) bad("audioS", "must be a positive number of seconds");

  let lastT = 0;
  const chunks = run.chunks;
  if (!Array.isArray(chunks)) bad("chunks", "must be an array");
  else {
    chunks.forEach((c: unknown, i) => {
      if (!isObj(c)) return bad(`chunks[${i}]`, "must be an object");
      if (!finite(c.tMs) || c.tMs < 0) bad(`chunks[${i}].tMs`, "must be a time in ms, 0 or more");
      else {
        if (c.tMs < lastT) bad(`chunks[${i}].tMs`, "goes back in time");
        lastT = Math.max(lastT, c.tMs);
      }
      if (typeof c.text !== "string") bad(`chunks[${i}].text`, "must be a string");
    });
    if (chunks.every((c: unknown) => isObj(c) && typeof c.text === "string")) {
      const joined = chunks.map((c: { text: string }) => c.text).join("");
      let n = 0;
      for (const raw of joined.split("\n")) {
        n++;
        const line = raw.replace(/\r$/, "");
        if (line.trim() === "") continue;
        const m = SEGMENT_LINE.exec(line);
        if (!m)
          bad(
            "chunks",
            `line ${n} of the output is not a segment line (${line.length} characters)`,
          );
        else if (m[1] !== `  ${BLANKED}`)
          bad("chunks", `line ${n} carries speech (text other than the placeholder)`);
      }
    }
  }
  if (typeof run.stderrHead !== "string") bad("stderrHead", "must be a string");
  else if (run.stderrHead.length > STDERR_HEAD_BYTES)
    bad("stderrHead", `is longer than the ${STDERR_HEAD_BYTES} bytes the supervisor keeps`);

  const facts = run.stderrFacts;
  if (!isObj(facts)) bad("stderrFacts", "must be an object");
  else
    for (const key of ["totalMs", "loadMs", "audioS"])
      if (facts[key] !== undefined && (!finite(facts[key]) || (facts[key] as number) < 0))
        bad(`stderrFacts.${key}`, "must be a number, 0 or more");

  if (run.finalJson !== undefined) {
    const f = run.finalJson;
    if (!isObj(f)) bad("finalJson", "must be an object");
    else {
      if (!Number.isInteger(f.segments) || (f.segments as number) < 0)
        bad("finalJson.segments", "must be a count");
      if (!finite(f.lastEndS) || f.lastEndS < 0)
        bad("finalJson.lastEndS", "must be a time in seconds");
    }
  }

  const x = run.exit;
  if (!isObj(x)) bad("exit", "must be an object");
  else {
    if (x.code !== null && !finite(x.code)) bad("exit.code", "must be a number or null");
    if (!finite(x.wallMs) || x.wallMs < 0) bad("exit.wallMs", "must be a time in ms, 0 or more");
    else if (lastT > x.wallMs) bad("exit.wallMs", "is before the last output arrived");
    if (x.killedAtMs !== undefined) {
      if (!finite(x.killedAtMs) || x.killedAtMs < 0) bad("exit.killedAtMs", "must be a time in ms");
      else if (finite(x.wallMs) && x.killedAtMs > x.wallMs)
        bad("exit.killedAtMs", "is after the run ended");
    }
    if (x.stoppedBy !== undefined && x.stoppedBy !== "person" && x.stoppedBy !== "too_slow")
      bad("exit.stoppedBy", 'must be "person" or "too_slow"');
    if (x.deathMs !== undefined && (!finite(x.deathMs) || x.deathMs < 0))
      bad("exit.deathMs", "must be a time in ms");
    if (x.outputFileLeft !== undefined && typeof x.outputFileLeft !== "boolean")
      bad("exit.outputFileLeft", "must be true or false");
    if (x.launches !== undefined && (!Number.isInteger(x.launches) || (x.launches as number) < 1))
      bad("exit.launches", "must be a count");
  }
}

/** What is wrong with `value` as a capture file; nothing when it is one. Checks the shape, the order of the
 *  times, that no segment line carries speech, and that nothing in the file names a path or a person. */
export function validateCapture(value: unknown): string[] {
  const problems: string[] = [];
  if (!isObj(value)) return ["capture: must be an object"];
  if (value.schema !== CAPTURE_SCHEMA) problems.push(`schema: must be "${CAPTURE_SCHEMA}"`);
  if (typeof value.textPolicy !== "string" || !value.textPolicy)
    problems.push("textPolicy: must say which text policy the file was made under");
  checkRun(value, "", problems);
  if (value.killed !== undefined) checkRun(value.killed, "killed.", problems);
  if (value.app !== undefined) {
    checkRun(value.app, "app.", problems);
    const chip = isObj(value.app) ? value.app.chip : undefined;
    if (!Array.isArray(chip)) problems.push("app.chip: must be an array");
    else
      chip.forEach((s: unknown, i) => {
        const bad = (field: string, why: string): void => {
          problems.push(`app.chip[${i}].${field}: ${why}`);
        };
        if (!isObj(s)) return problems.push(`app.chip[${i}]: must be an object`);
        if (!finite(s.tMs)) bad("tMs", "must be a time in ms");
        if (typeof s.phase !== "string") bad("phase", "must be a string");
        if (s.firstWordsMs !== null && !finite(s.firstWordsMs))
          bad("firstWordsMs", "must be a number or null");
        if (!finite(s.doneS)) bad("doneS", "must be a number");
        if (s.rate !== null && !finite(s.rate)) bad("rate", "must be a number or null");
        if (s.etaS !== null && !finite(s.etaS)) bad("etaS", "must be a number or null");
      });
  }
  for (const [at, text] of stringsIn(value))
    for (const [what, pattern] of PRIVATE)
      if (pattern.test(text)) problems.push(`privacy: ${what} at ${at}`);
  return problems;
}

export function parseCapture(json: string): SpeechLiveCapture {
  const value: unknown = JSON.parse(json);
  const problems = validateCapture(value);
  if (problems.length > 0) throw new Error(`not a speech capture: ${problems.join("; ")}`);
  return value as SpeechLiveCapture;
}

/** The file form: one output to a line, so the file reads as a log and a change to it is a change to a line. */
export function serializeCapture(c: SpeechLiveCapture): string {
  return (
    JSON.stringify(c, null, 1).replace(
      /\{\n\s*"tMs": ([-\d.e+]+),\n\s*"text": ("(?:[^"\\]|\\.)*")\n\s*\}/g,
      '{ "tMs": $1, "text": $2 }',
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------------------------------------
// The fake engine.

export interface FakeRunOptions {
  /** Seconds of audio. */
  audioS: number;
  /** Seconds of work for each second of audio, steady. */
  rate: number;
  /** Seconds from launch to the engine being ready to decode (default 3). */
  startupS?: number;
  /** Seconds of audio the engine decodes before it prints (default 30). */
  windowS?: number;
  /** Write the times with a comma, as some builds of the engine do. */
  comma?: boolean;
  backend?: "cpu" | "gpu";
  threads?: number;
  /** Segment lines in each burst (default 2). */
  segmentsPerWindow?: number;
  /** Cancel pressed at this time: the run ends there, as a killed one does. */
  killAtMs?: number;
  /** Milliseconds from Cancel to the process being gone (default 40). */
  deathMs?: number;
}

/** What the engine does before its own clock starts: the process, its libraries, the audio read. */
const ENGINE_START_S = 0.8;
const LOAD_MS = 480;
/** From the last output to the process being gone: the output file written, the timings printed. */
const FINISH_MS = 250;

function fakeStderr(o: {
  audioS: number;
  backend: "cpu" | "gpu";
  threads: number;
  timings: { totalMs: number; loadMs: number } | null;
}): string {
  const gpu = o.backend === "gpu";
  const samples = Math.round(o.audioS * 16000);
  const lines = [
    "ggml_vulkan: Found 1 Vulkan devices:",
    "load_backend: loaded Vulkan backend from <path>",
    "load_backend: loaded CPU backend from <path>",
    "whisper_init_from_file_with_params_no_state: loading model from '<path>'",
    `whisper_init_with_params_no_state: use gpu    = ${gpu ? 1 : 0}`,
    "whisper_init_with_params_no_state: flash attn = 1",
    "whisper_model_load: loading model",
    "whisper_model_load: type          = 3 (small)",
    "whisper_model_load: model size    =  487.01 MB",
    gpu
      ? "whisper_backend_init_gpu: using Vulkan0 backend"
      : "whisper_backend_init_gpu: no GPU found",
    "whisper_init_state: kv self size  =   18.87 MB",
    "read_audio_data: reading audio data from '<path>' ...",
    `system_info: n_threads = ${o.threads} / 16 | WHISPER : COREML = 0 | OPENVINO = 0 | CPU : AVX = 1 | AVX2 = 1 |`,
    `main: processing '<path>' (${samples} samples, ${(samples / 16000).toFixed(1)} sec), ${o.threads} threads, 1 processors, 5 beams + best of 5, lang = en, task = transcribe, timestamps = 1 ...`,
  ];
  if (o.timings) {
    lines.push(
      "",
      "output_json: saving output to '<path>'",
      "",
      `whisper_print_timings:     load time = ${o.timings.loadMs.toFixed(2).padStart(9)} ms`,
      "whisper_print_timings:     fallbacks =   0 p /   0 h",
      `whisper_print_timings:    total time = ${o.timings.totalMs.toFixed(2).padStart(9)} ms`,
    );
  }
  return lines.join("\n") + "\n";
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** One run of an engine that works at a steady rate, as the real one prints it: nothing on stdout until the
 *  first window is decoded, then one burst of segment lines per window, each at the start-up plus the audio so
 *  far at the rate; the log with its backend line near the top and, for a run that finished, its timings at the
 *  end. With `killAtMs` the run is cut there and has no timings and no output file. */
export function fakeRun(o: FakeRunOptions): RunCapture {
  const startupS = o.startupS ?? 3;
  const windowS = o.windowS ?? 30;
  const per = o.segmentsPerWindow ?? 2;
  const backend = o.backend ?? "cpu";
  const threads = o.threads ?? 8;
  const killed = o.killAtMs !== undefined;
  const windows = Math.ceil(o.audioS / windowS);
  let chunks: StdoutChunk[] = [];
  for (let w = 0; w < windows; w++) {
    const from = w * windowS;
    const to = Math.min(o.audioS, from + windowS);
    let text = w === 0 ? "\n" : "";
    for (let i = 0; i < per; i++) {
      const a = from + ((to - from) * i) / per;
      const b = from + ((to - from) * (i + 1)) / per;
      text += `[${stamp(a, o.comma)} --> ${stamp(b, o.comma)}]  ${BLANKED}\n`;
    }
    chunks.push({ tMs: Math.round((startupS + to * o.rate) * 1000), text });
  }
  if (killed) chunks = chunks.filter((c) => c.tMs <= o.killAtMs!);
  const totalMs = Math.round(
    Math.max(0, startupS - ENGINE_START_S) * 1000 + o.audioS * o.rate * 1000,
  );
  const head = fakeStderr({
    audioS: o.audioS,
    backend,
    threads,
    timings: killed ? null : { totalMs, loadMs: LOAD_MS },
  });
  const parsed = whisperRunFacts(head);
  const deathMs = o.deathMs ?? 40;
  const args = [
    "-m",
    "ggml-small.bin",
    "-f",
    "<audio>",
    "-ojf",
    "-of",
    "<scratch>",
    "-t",
    String(threads),
    "-l",
    "en",
    "-mc",
    "0",
    ...(backend === "cpu" ? ["-ng"] : []),
  ];
  return {
    engine: {
      backend: parsed.backend ?? backend,
      threads: parsed.threads,
      model: parsed.model,
      args,
    },
    audioS: o.audioS,
    chunks,
    stderrHead: head,
    stderrFacts: readStderrFacts(head),
    ...(killed ? {} : { finalJson: { segments: windows * per, lastEndS: round3(o.audioS) } }),
    exit: killed
      ? {
          code: -1,
          wallMs: o.killAtMs! + deathMs,
          killedAtMs: o.killAtMs!,
          stoppedBy: "person",
          deathMs,
          outputFileLeft: false,
          launches: 1,
        }
      : { code: 0, wallMs: (chunks[chunks.length - 1]?.tMs ?? 0) + FINISH_MS, launches: 1 },
  };
}

/** A full capture file from the fake engine: a run to its end, and the same recording killed at `killAtMs`
 *  (90 s when not said). It has no chip samples: those come only from a live run through the app's own path. */
export function fakeCapture(o: FakeRunOptions): SpeechLiveCapture {
  return {
    schema: CAPTURE_SCHEMA,
    textPolicy: TEXT_POLICY,
    ...fakeRun({ ...o, killAtMs: undefined }),
    killed: fakeRun({ ...o, killAtMs: o.killAtMs ?? 90_000 }),
  };
}

/** What the committed fake capture (`speechLive.capture.fake.json`) was made with. */
export const FAKE_FIXTURE_OPTIONS: FakeRunOptions = {
  audioS: 1500,
  rate: 0.3,
  startupS: 3.2,
  killAtMs: 90_000,
};

// ---------------------------------------------------------------------------------------------------------
// Making one capture into another: a PC k times slower, a PC that slept.

const copyRun = (c: RunCapture): RunCapture => ({
  engine: { ...c.engine, args: [...c.engine.args] },
  audioS: c.audioS,
  chunks: c.chunks.map((x) => ({ ...x })),
  stderrHead: c.stderrHead,
  stderrFacts: { ...c.stderrFacts },
  ...(c.finalJson ? { finalJson: { ...c.finalJson } } : {}),
  exit: { ...c.exit },
});

/** The run as a PC k times slower would have made it: every time k times, the engine's own timings too. */
export function scaleCapture(c: RunCapture, k: number): RunCapture {
  const out = copyRun(c);
  for (const x of out.chunks) x.tMs *= k;
  const f = out.stderrFacts;
  if (f.totalMs !== undefined) f.totalMs *= k;
  if (f.loadMs !== undefined) f.loadMs *= k;
  out.exit.wallMs *= k;
  if (out.exit.killedAtMs !== undefined) out.exit.killedAtMs *= k;
  if (out.exit.deathMs !== undefined) out.exit.deathMs *= k;
  return out;
}

/** The run as it would have been had the PC slept for `gapMs` just after `atMs`: everything after that time
 *  arrives later by the gap. The engine's own timings are the work it did, so they stay. */
export function withGap(c: RunCapture, atMs: number, gapMs: number): RunCapture {
  const out = copyRun(c);
  for (const x of out.chunks) if (x.tMs > atMs) x.tMs += gapMs;
  if (out.exit.wallMs > atMs) out.exit.wallMs += gapMs;
  if (out.exit.killedAtMs !== undefined && out.exit.killedAtMs > atMs) out.exit.killedAtMs += gapMs;
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The replay.

export interface ReplayStep {
  /** Which output of the capture this is. */
  index: number;
  tMs: number;
  snapshot: MonitorSnapshot;
  live: LiveReading;
  /** The live check said to stop the run after this output. */
  stopped: boolean;
}

export interface MonitorReplay {
  steps: ReplayStep[];
  /** The step the run was stopped at; null when the check let it finish. */
  stoppedAt: ReplayStep | null;
  /** The last step replayed: the stop, or the end of the capture. */
  final: ReplayStep;
}

/** The capture fed to the app's monitor and live check as the app feeds them (speechRun.ts `watchRun`): each
 *  output at its arrival time, the head of the engine's log handed over once audio has moved (as the job
 *  supervisor holds it), the live check taking a reading after each output, only on the processor and only
 *  when `liveStop` is on, and the replay ending at the stop, as the run does. */
export function replayMonitor(
  run: RunCapture,
  opts: { liveStop?: boolean; capS?: number } = {},
): MonitorReplay {
  const monitor = createSpeechMonitor({ launchedAt: 0, spanS: run.audioS });
  const check = createLiveCheck(opts.capS ?? CAP_S);
  const liveStop = opts.liveStop !== false;
  const cpuOnly = run.engine.args.includes("-ng");
  const steps: ReplayStep[] = [];
  let stoppedAt: ReplayStep | null = null;
  let headFed = false;
  for (let i = 0; i < run.chunks.length; i++) {
    const { tMs, text } = run.chunks[i];
    monitor.feed(text, tMs);
    if (!headFed && monitor.snapshot().firstWordsAt !== null) {
      monitor.feed(run.stderrHead, tMs);
      headFed = true;
    }
    const snapshot = monitor.snapshot();
    const live = monitor.live();
    const onProcessor = snapshot.backend === null ? cpuOnly : snapshot.backend === "cpu";
    const stopped = liveStop && onProcessor && check.observe(live);
    const step: ReplayStep = { index: i, tMs, snapshot, live, stopped };
    steps.push(step);
    if (stopped) {
      stoppedAt = step;
      break;
    }
  }
  const final: ReplayStep = steps[steps.length - 1] ?? {
    index: -1,
    tMs: 0,
    snapshot: monitor.snapshot(),
    live: monitor.live(),
    stopped: false,
  };
  return { steps, stoppedAt, final };
}
