// The speech stand-in for the browser lane: the desktop app's job supervisor (src-tauri/src/jobs.rs)
// and the speech engine behind it, answered from the test process so captions and transcripts can
// be tested in a browser, in CI, with no speech model on the machine.
//
// What is real: everything the page does. It plans the run, extracts the clip's sound with the
// shipped ffmpeg (the QA shell's `sidecar_run`), launches whisper-cli as a job, follows the job's
// events, reads the JSON the engine wrote, keeps the words, cuts the captions and places them.
// What is a stand-in: the engine's answer. A whisper-cli job writes, at the path its `-of` names,
// what the REAL engine wrote for this clip's sound (fixtures/speech/spoken.whisper.json, made by
// fixtures/make-fixtures.mjs with the shipped whisper-cli and the speech model), cut to the stretch
// of the sound the app handed it, with times from that stretch's start as the engine writes them.
// The speech model is "on disk" as the app checks it: the file exists, its size is the manifest's
// (the QA shell's stat answers it) and its checksum marker matches.
//
//   const speech = SpeechStandIn.install(qa);       // before qa.openProject()
//   speech.answer({ kind: "fail", stderr: "..." });  // the next launch fails; then words again
//
// Each launch is recorded (`launches`): its arguments (the language, the model file), the stretch
// it was handed and how it ended, so a test can check what the app ASKED the engine.
import { existsSync, promises as fsp, readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Page } from "@playwright/test";

import { MODEL_MANIFEST } from "../../../../src/tools/modelManifest";
import type { QaShell } from "../../agent-and-models/lib/qaShell";

const HERE = path.resolve("e2e/ui/captions-and-transcription");
/** 12 s: red 0-4 s, green 4-8 s, blue 8-12 s; three spoken sentences, starting near 0.6, 4.6 and 8.0 s. */
export const SPOKEN_CLIP = path.join(HERE, "fixtures/media/spoken_scenes.mp4");
export const SUBTITLES = path.join(HERE, "fixtures/media/subtitles.srt");

interface Token {
  text: string;
  offsets: { from: number; to: number };
  timestamps?: unknown;
  id?: number;
  p?: number;
  t_dtw?: number;
}
interface Segment {
  text: string;
  offsets: { from: number; to: number };
  timestamps?: unknown;
  tokens: Token[];
}
export interface WhisperJson {
  result: { language: string };
  transcription: Segment[];
  [k: string]: unknown;
}

/** What the real engine wrote for the whole clip's sound. */
export const RECORDED: WhisperJson = JSON.parse(
  readFileSync(path.join(HERE, "fixtures/speech/spoken.whisper.json"), "utf8"),
) as WhisperJson;

/** The words of the recording, in order, as the engine heard them (no punctuation, lower case). */
export const RECORDED_WORDS: string[] = RECORDED.transcription
  .map((s) => s.text)
  .join(" ")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s']/gu, " ")
  .split(/\s+/)
  .filter(Boolean);

/** Each word of the recording with the time the engine gave it (seconds of the clip's sound): a
 *  token with a leading space starts a word, as the app joins them. */
export function recordedWordTimes(): Array<{ word: string; start: number; end: number }> {
  const out: Array<{ word: string; start: number; end: number }> = [];
  for (const seg of RECORDED.transcription)
    for (const t of seg.tokens) {
      if (/^\s*\[_/.test(t.text) || !t.text.trim()) continue;
      const letters = t.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
      if (t.text.startsWith(" ") || !out.length) {
        if (!letters) continue;
        out.push({ word: letters, start: t.offsets.from / 1000, end: t.offsets.to / 1000 });
      } else {
        const last = out[out.length - 1];
        last.word += letters;
        last.end = t.offsets.to / 1000;
      }
    }
  return out;
}

const special = (t: Token): boolean => /^\s*\[_/.test(t.text);

/** The recorded answer for the stretch [startS, endS) of the clip's sound, as the engine writes it
 *  for that stretch's own audio: only tokens heard inside it, times from its start. */
export function heardIn(startS: number, endS: number, language = "en"): WhisperJson {
  const from = Math.round(startS * 1000);
  const to = Math.round(endS * 1000);
  const shift = (o: { from: number; to: number }) => ({
    from: Math.max(0, o.from - from),
    to: Math.max(0, o.to - from),
  });
  const transcription: Segment[] = [];
  for (const seg of RECORDED.transcription) {
    const tokens = seg.tokens.filter(
      (t) => special(t) || (t.offsets.from >= from && t.offsets.to <= to),
    );
    const said = tokens.filter((t) => !special(t));
    if (!said.length) continue;
    transcription.push({
      ...seg,
      text: said.map((t) => t.text).join(""),
      offsets: shift({ from: said[0].offsets.from, to: said[said.length - 1].offsets.to }),
      tokens: tokens.map((t) => ({ ...t, offsets: shift(t.offsets) })),
    });
  }
  return { ...RECORDED, result: { language }, transcription };
}

/** How the next engine launch ends. With nothing queued, a launch answers `words`. */
export type EngineAnswer =
  /** The recorded words for the stretch it was handed (heard as `language`, "en" by default). */
  | { kind: "words"; language?: string }
  /** It ran and wrote a transcript with nothing in it. */
  | { kind: "silence" }
  /** It exits with this code and this on stderr, and writes nothing. */
  | { kind: "fail"; code?: number; stderr?: string }
  /** It keeps running, its first segment printed, until `release()` (then words) or a Cancel. */
  | { kind: "hold" };

export interface Launch {
  id: string;
  args: string[];
  meta: Record<string, unknown>;
  answer: EngineAnswer;
  /** The stretch of the clip's sound it was handed (seconds), from the job's own record. */
  window: { start: number; end: number };
  state: "running" | "exited";
  code: number | null;
  killed: boolean;
  at: number;
  endedAt?: number;
}

interface JobView {
  id: string;
  lane: string;
  state: "queued" | "running" | "exited";
  step?: number;
  code: number | null;
  killed: boolean;
  committed: boolean;
  meta: Record<string, unknown>;
  stdout_tail: string;
  stderr_head: string;
  stderr_elided: number;
  stderr_tail: string;
  queued_at: number;
  started_at: number | null;
  ended_at: number | null;
}

/** The job protocol the page asks for (src/tools/jobSupervisor.ts, EXPORT_PROTOCOL_VERSION). */
const PROTOCOL = 20;

const hms = (ms: number): string => {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const r = t % 1000;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(h)}:${two(m)}:${two(s)}.${String(r).padStart(3, "0")}`;
};

const argAfter = (args: string[], flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

export class SpeechStandIn {
  /** Every whisper-cli launch the app made, in order. */
  readonly launches: Launch[] = [];
  /** Every job the app submitted (any program), by id. */
  private readonly views = new Map<string, JobView>();
  private readonly queued: EngineAnswer[] = [];
  private readonly byPurpose = new Map<string, EngineAnswer>();
  private readonly holds = new Map<string, () => void>();
  private readonly modelFiles = new Map<string, number>();

  private constructor(
    private readonly shell: QaShell,
    private readonly page: Page,
  ) {}

  /** Answer the job supervisor and the speech engine for this rig's shell, and put the speech model
   *  "on disk". Call it before the app is opened. `model: false` leaves the model off the disk. */
  static async install(
    rig: { shell: QaShell; page: Page },
    options: { model?: boolean } = {},
  ): Promise<SpeechStandIn> {
    const speech = new SpeechStandIn(rig.shell, rig.page);
    if (options.model !== false) await speech.placeModel();
    const base = rig.shell.handle.bind(rig.shell);
    speech.base = base;
    rig.shell.handle = async (cmd: string, json: string): Promise<string> => {
      const own = await speech.own(cmd, json);
      return own ?? base(cmd, json);
    };
    return speech;
  }

  /** Queue how the next launches end, in order. */
  answer(...answers: EngineAnswer[]): void {
    this.queued.push(...answers);
  }

  /** How every launch for this purpose ends ("index": the background transcription of imported media;
   *  "captions", "look", "transcript": a request's own run), ahead of the queue. */
  answerFor(purpose: string, answer: EngineAnswer): void {
    this.byPurpose.set(purpose, answer);
  }

  /** Let every held launch finish, with the recorded words. */
  release(): void {
    for (const [id, go] of [...this.holds]) {
      if (id.endsWith(":kill")) continue;
      this.holds.delete(id);
      this.holds.delete(`${id}:kill`);
      go();
    }
  }

  /** The launches still running. */
  running(): Launch[] {
    return this.launches.filter((l) => l.state === "running");
  }

  private async placeModel(): Promise<void> {
    const dir = path.join(this.shell.root, "data", "ArtDaddy", "models");
    await fsp.mkdir(dir, { recursive: true });
    for (const entry of Object.values(MODEL_MANIFEST)) {
      const file = path.join(dir, entry.file);
      await fsp.writeFile(file, "");
      await fsp.writeFile(
        `${file}.verified.json`,
        JSON.stringify({ bytes: entry.bytes, sha256: entry.sha256 }),
      );
      this.modelFiles.set(this.shell.virtual(`data/ArtDaddy/models/${entry.file}`), entry.bytes);
    }
  }

  /** This stand-in's answer to a command, or null for the QA shell's own. */
  private async own(cmd: string, json: string): Promise<string | null> {
    const ok = (value: unknown) => JSON.stringify({ ok: true, value: value ?? null });
    const a = (JSON.parse(json) ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "jobs_export_protocol":
        return ok(PROTOCOL);
      case "jobs_submit":
        return ok(await this.submit((a.spec ?? {}) as Record<string, unknown>));
      case "jobs_list":
        return ok([...this.views.values()]);
      case "jobs_kill":
        return ok(await this.kill(String(a.id)));
      case "jobs_commit": {
        const v = this.views.get(String(a.id));
        if (v) v.committed = true;
        return ok(Boolean(v));
      }
      case "jobs_forget":
        return ok(this.views.delete(String(a.id)));
      case "plugin:fs|stat":
      case "plugin:fs|lstat": {
        const size = this.modelFiles.get(String(a.path));
        if (size === undefined || !existsSync(this.shell.real(String(a.path)))) return null;
        // The model file is empty on this disk; the app sees the manifest's size, as for the real one.
        const real = JSON.parse(await this.shellCall(cmd, json)) as {
          ok: boolean;
          value?: Record<string, unknown>;
        };
        if (!real.ok || !real.value) return null;
        return ok({ ...real.value, size });
      }
    }
    return null;
  }

  /** The QA shell's own answer, as it was before this stand-in was installed. */
  private base: (cmd: string, json: string) => Promise<string> = () =>
    Promise.resolve(JSON.stringify({ ok: false, error: "not installed" }));

  private shellCall(cmd: string, json: string): Promise<string> {
    return this.base(cmd, json);
  }

  private async emit(event: string, payload: unknown): Promise<void> {
    await this.page
      .evaluate(
        ({ e, p }) =>
          (
            window as unknown as { __qaShell?: { emit(e: string, p: unknown): void } }
          ).__qaShell?.emit(e, p),
        { e: event, p: payload },
      )
      .catch(() => undefined); // the page went away (a reload): the next page lists the jobs
  }

  private async submit(spec: Record<string, unknown>): Promise<number> {
    const id = String(spec.id ?? "");
    const now = Date.now();
    const view: JobView = {
      id,
      lane: String(spec.lane ?? ""),
      state: "running",
      code: null,
      killed: false,
      committed: false,
      meta: (spec.meta ?? {}) as Record<string, unknown>,
      stdout_tail: "",
      stderr_head: "",
      stderr_elided: 0,
      stderr_tail: "",
      queued_at: now,
      started_at: now,
      ended_at: null,
    };
    this.views.set(id, view);
    const args = (Array.isArray(spec.args) ? spec.args : []).map(String);
    if (spec.program !== "whisper-cli") {
      // Exports run as jobs too; this lane does not export. Say so instead of pretending.
      void this.end(
        view,
        1,
        `the QA speech stand-in runs whisper-cli only, not ${String(spec.program)}`,
      );
      return 0;
    }
    const start = Number(view.meta.shiftMs ?? 0) / 1000;
    const spanS = Number(view.meta.spanS);
    const launch: Launch = {
      id,
      args,
      meta: view.meta,
      answer: this.byPurpose.get(String(view.meta.purpose)) ??
        this.queued.shift() ?? { kind: "words" },
      window: { start, end: Number.isFinite(spanS) ? start + spanS : Infinity },
      state: "running",
      code: null,
      killed: false,
      at: performance.now(),
    };
    this.launches.push(launch);
    void this.run(launch, view);
    return 0;
  }

  private async run(launch: Launch, view: JobView): Promise<void> {
    await this.emit("jobs:changed", view);
    const { answer } = launch;
    if (answer.kind === "fail") {
      await this.end(
        view,
        answer.code ?? 1,
        answer.stderr ?? "whisper-cli: failed to process audio",
      );
      return;
    }
    const heard =
      answer.kind === "silence"
        ? { ...RECORDED, result: { language: "en" }, transcription: [] }
        : heardIn(
            launch.window.start,
            launch.window.end,
            answer.kind === "words" ? answer.language : "en",
          );
    // What the engine prints as it decodes: a line per segment, which is how the chip tells progress.
    const lines = heard.transcription.map(
      (s) => `[${hms(s.offsets.from)} --> ${hms(s.offsets.to)}]  ${s.text}\n`,
    );
    if (answer.kind === "hold") {
      if (lines[0]) await this.emit("jobs:stdout", { id: view.id, chunk: lines[0] });
      const released = await new Promise<boolean>((resolve) => {
        this.holds.set(view.id, () => resolve(true));
        this.holds.set(`${view.id}:kill`, () => resolve(false));
      });
      if (!released) return; // killed: kill() has ended it
    }
    for (const chunk of lines) await this.emit("jobs:stdout", { id: view.id, chunk });
    const out = argAfter(launch.args, "-of");
    if (!out) {
      await this.end(view, 1, "whisper-cli: no -of given");
      return;
    }
    const file = this.shell.real(`${out}.json`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(heard));
    await this.end(view, 0, "whisper_print_timings:    total time =  1000.00 ms\n");
  }

  private async end(
    view: JobView,
    code: number | null,
    stderr: string,
    killed = false,
  ): Promise<void> {
    if (view.state === "exited") return;
    view.state = "exited";
    view.code = code;
    view.killed = killed;
    view.ended_at = Date.now();
    view.stderr_head = stderr;
    const launch = this.launches.find((l) => l.id === view.id);
    if (launch) {
      launch.state = "exited";
      launch.code = code;
      launch.killed = killed;
      launch.endedAt = performance.now();
    }
    await this.emit("jobs:changed", view);
  }

  private async kill(id: string): Promise<boolean> {
    const view = this.views.get(id);
    if (!view || view.state === "exited") return false;
    this.holds.delete(id);
    const stop = this.holds.get(`${id}:kill`);
    this.holds.delete(`${id}:kill`);
    stop?.();
    await this.end(view, null, "", true);
    return true;
  }
}
