// An in-process replay of "the assistant asks for the words of audio files that are not ready yet". It builds the
// REAL chat store, tool host and tool registry, job queue and transcript wait, and the real speech path under
// them (peek, run, one at a time, app cache). Fake, below the app: the project disk, the programs (ffprobe, ffmpeg,
// whisper-cli, which takes virtual time), and the model, which is a script. Time is virtual (fake timers; Date.now()
// follows them), so a scenario of minutes runs at once and the same way every time.
//
// A test file that uses this needs these mocks, which only a test file can hoist:
//   vi.mock("../agent/api", async () => (await import("../test/wakeModel")).modelModule());
//   vi.mock("../tools/tauri", async () => (await import("../test/wakeWiring")).tauriModule());
//   vi.mock("../tools/dataRoot", ...projectDirFor: wiring.projectDir)
//   vi.mock("../api/appEvents", ...reportAppError and reportTranscription do nothing)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

import { __resetExportFlags } from "../api/exportFlags";
import {
  activateChatProject,
  deactivateChatProject,
  getChatStore,
  resetHistoryModeSupport,
  useChat,
} from "../store/chat";
import { useEditor } from "../store/editor";
import { __resetJobNotes, JOB_WAKE_LEAD, notifyJobSettled } from "../store/jobNotes";
import { resetLiveWait } from "../store/liveWait";
import { clearModelDownload } from "../store/modelDownload";
import { applyOp, ensureTimeline, loadTimeline } from "../timeline/engine";
import type { Clip } from "../timeline/model";
import { closeToolHost } from "../tools/host";
import { ProjectStoreAccess } from "../tools/store";
import { __resetWaiting } from "../tools/transcriptWait";
import { registerTestDocument, resetTestDocuments } from "./timelineKit";
import { seedProject, WakeCommands, WakeDisk, wakeFiles, type WakeFile } from "./wakeFs";
import {
  ScriptedModel,
  type CaptionsAnswer,
  type LookAnswer,
  type ModelRecorder,
  type WakeTask,
} from "./wakeModel";
import { wiring } from "./wakeWiring";

export type { CaptionsAnswer, LookAnswer, WakeFile, WakeTask };

export const PROJECT_ID = "wake_p1";
export const PROJECT_DIR = "C:/data/projects/wake_p1";
/** The clock every scenario starts on. */
const START = Date.UTC(2026, 10, 15, 9, 0, 0);
const TIMELINE_FPS = 30;
/** A turn that has not ended after this much virtual time, or this many steps, never will. */
const MAX_TURN_VIRTUAL_S = 3600;
const MAX_STEPS = 20_000;

let harnesses = 0;

export interface WakeOptions {
  /** How many audio files the person imported. */
  files: number;
  /** Seconds of speech in each. */
  fileSeconds: number;
  /** How long the speech engine takes for one file (or one clip's stretch of it), in virtual seconds. */
  engineSecondsPerFile: number;
  /** What the person's request makes the assistant do. */
  task: WakeTask;
  /** One audio clip per file on the timeline, back to back on one audio track (for captions). */
  placeOnTimeline?: boolean;
  /** How long the model takes per round, in virtual seconds. Default 0. */
  modelSecondsPerRound?: number;
}

export interface TurnMetric {
  kind: "user" | "system";
  /** The first characters of the message the turn started with (all of it is synthetic). */
  textStart: string;
  rounds: number;
  startedAtS: number;
  endedAtS: number | null;
}

export interface EngineRunMetric {
  file: string;
  startS: number;
  endS: number | null;
}

export interface TimelineEvent {
  atS: number;
  event: string;
  [detail: string]: unknown;
}

export interface WakeMetrics {
  turns: TurnMetric[];
  /** The turns the app started by itself with the words of a wake (a system turn that starts with JOB_WAKE_LEAD). */
  wakeTurns: TurnMetric[];
  /** Every system turn, whatever it says: tells a wake with other words from none. */
  systemTurns: number;
  modelRounds: number;
  engineRuns: EngineRunMetric[];
  /** Per file, what each look told the model about its words, in order. */
  looks: Record<string, LookAnswer[]>;
  /** How many distinct files had their words reach the model, of `filesTotal`. */
  wordsFetched: number;
  wordsFetchedFiles: string[];
  filesTotal: number;
  /** What `add_captions` answered the model, in order. */
  captionsAnswers: CaptionsAnswer[];
  /** The last thing each turn said to the person. */
  finalAssistantTexts: string[];
  /** When the last word landed, in virtual seconds; null before any did. */
  lastLandingS: number | null;
  nowS: number;
  /** Attempts to reach the network. The harness refuses all of them. */
  networkCalls: number;
  /** Programs the app ran that the fakes do not know. */
  refusedPrograms: string[];
  timeline: TimelineEvent[];
}

export interface WakeHarness {
  readonly files: readonly WakeFile[];
  /** The person sends a message, and the harness runs (in virtual time) until the chat is idle. */
  say(text: string): Promise<void>;
  /** Lets virtual time pass; a turn still running at the end of it is run to its end. */
  advance(ms: number): Promise<void>;
  advanceTo(seconds: number): Promise<void>;
  /** An export the chat started has finished: the app's own queue, as the export queue reports it. */
  settleExport(opts?: { label?: string }): void;
  /** Work the chat started has finished, as the job queue gets it (a stand-in for a wake the app does not have). */
  settleJob(job: { tool: string; label: string; media_refs?: string[]; detail?: string }): void;
  nowS(): number;
  /** When the engine ends its last file, given when it began its first. */
  lastLandingS(): number;
  metrics(): WakeMetrics;
  /** The caption clips on the project's timeline now. */
  captionClips(): Promise<number>;
  /** With L6_EVIDENCE_DIR set, writes <dir>/<name>.json with the metrics. */
  writeEvidence(name: string): Promise<void>;
  dispose(): Promise<void>;
}

type ChatSnapshot = ReturnType<typeof useChat.getState>;
type ChatStoreApi = ReturnType<typeof getChatStore>;

interface TurnRecord {
  kind: "user" | "system";
  text: string;
  rounds: number;
  startedAtS: number;
  endedAtS: number | null;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

class Harness implements WakeHarness, ModelRecorder {
  readonly files: readonly WakeFile[];
  private readonly lifetime = new AbortController();
  private readonly disk = new WakeDisk();
  private readonly events: TimelineEvent[] = [];
  private readonly turnRecords: TurnRecord[] = [];
  private readonly turnById = new Map<string, TurnRecord>();
  private readonly runs: EngineRunMetric[] = [];
  private readonly looks = new Map<string, LookAnswer[]>();
  private readonly wordsOf = new Set<string>();
  private readonly captionAnswers: CaptionsAnswer[] = [];
  private readonly blocked: string[] = [];
  private commands: WakeCommands | null = null;
  private store: ProjectStoreAccess | null = null;
  private chatStore: ChatStoreApi | null = null;
  private unsubscribe: (() => void) | null = null;
  private timersFaked = false;
  private disposed = false;
  private t0 = START;
  private rounds = 0;
  private jobs = 0;

  constructor(private readonly opts: WakeOptions) {
    this.files = wakeFiles(opts.files, opts.fileSeconds, ++harnesses);
  }

  // ---- setup and teardown -------------------------------------------------------------------------------

  async setup(): Promise<void> {
    // The app imports these lazily, the first time it needs them. Loaded now, so that no import waits on the
    // faked clock (captionsWait.test.ts found that loading a module needs the clock running).
    await Promise.all([
      import("../tools/dataRoot"),
      import("../tools/tauri"),
      import("../tools/jobSupervisor"),
      import("../project/jobLedger"),
    ]);
    // The state of one run must not be the next one's: the app keeps these for the life of the page.
    localStorage.clear();
    __resetWaiting();
    resetLiveWait();
    clearModelDownload();
    __resetExportFlags();
    __resetJobNotes();
    resetHistoryModeSupport();
    closeToolHost();
    vi.useFakeTimers();
    this.timersFaked = true;
    vi.setSystemTime(START);
    this.refuseNetwork();

    const byPath = seedProject(this.disk, { projectDir: PROJECT_DIR, files: this.files });
    this.commands = new WakeCommands({
      disk: this.disk,
      files: this.files,
      byPath,
      engineSeconds: () => this.opts.engineSecondsPerFile,
      lifetime: this.lifetime.signal,
      observer: {
        started: (file) => {
          this.runs.push({ file: file.label, startS: this.nowS(), endS: null });
          this.event("engine_started", { file: file.label });
        },
        ended: (file, completed) => {
          const run = this.runs.find((r) => r.file === file.label && r.endS === null);
          if (run) run.endS = this.nowS();
          this.event(completed ? "words_landed" : "engine_cut_off", { file: file.label });
        },
      },
    });
    const store = new ProjectStoreAccess(PROJECT_DIR, this.disk);
    this.store = store;
    registerTestDocument(PROJECT_DIR, PROJECT_ID);
    await ensureTimeline(store);
    if (this.opts.placeOnTimeline) await this.placeOnTimeline(store);

    wiring.context = { store, runner: this.commands };
    wiring.projectDir = PROJECT_DIR;
    wiring.model = new ScriptedModel(
      this.opts.task,
      this.files,
      this,
      (this.opts.modelSecondsPerRound ?? 0) * 1000,
    );

    useEditor.setState({ projectId: PROJECT_ID, store, timeline: await loadTimeline(store) });
    await activateChatProject(PROJECT_ID);
    this.chatStore = getChatStore(PROJECT_ID);
    this.unsubscribe = this.chatStore.subscribe((state) => this.onChat(state));
    await this.settle();
    this.t0 = Date.now();
  }

  /** Every attempt to reach the network is refused and counted (host and path only: nothing of a query or a body). */
  private refuseNetwork(): void {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      let where = "unknown";
      try {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        where = `${url.hostname}${url.pathname}`;
      } catch {
        /* a relative address names no host */
      }
      this.blocked.push(`${method} ${where}`);
      throw new TypeError("fetch failed: the wake harness allows no network");
    });
  }

  /** One audio clip per file, back to back on one audio track, each playing its whole file. */
  private async placeOnTimeline(store: ProjectStoreAccess): Promise<void> {
    let at = 0;
    const clips = this.files.map((file, i): Clip => {
      const frames = Math.round(file.seconds * TIMELINE_FPS);
      const clip: Clip = {
        id: `au_${i + 1}`,
        kind: "audio",
        media_ref: file.ref,
        timeline_in: at,
        timeline_out: at + frames,
        source_in: 0,
        source_out: frames,
      };
      at += frames;
      return clip;
    });
    const placed = await applyOp(store, "seed", (timeline) => {
      timeline.tracks.push({ id: "a1", kind: "audio", z: timeline.tracks.length, clips });
    });
    if (placed.ok === false)
      throw new Error(`the harness could not seed the timeline: ${String(placed.error)}`);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    deactivateChatProject(PROJECT_ID);
    this.lifetime.abort();
    closeToolHost(PROJECT_ID);
    __resetJobNotes();
    useEditor.setState({ projectId: null, store: null, timeline: null });
    wiring.context = null;
    wiring.model = null;
    wiring.projectDir = "";
    if (this.timersFaked) await vi.advanceTimersByTimeAsync(0);
    await resetTestDocuments();
    if (this.timersFaked) {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    vi.unstubAllGlobals();
  }

  // ---- recording -------------------------------------------------------------------------------------------

  nowS(): number {
    return round3((Date.now() - this.t0) / 1000);
  }

  private event(event: string, detail: Record<string, unknown> = {}): void {
    this.events.push({ atS: this.nowS(), event, ...detail });
  }

  private onChat(state: ChatSnapshot): void {
    const atS = this.nowS();
    for (const turn of state.turns) {
      let record = this.turnById.get(turn.id);
      if (!record) {
        record = {
          kind: turn.system ? "system" : "user",
          text: turn.userText,
          rounds: 0,
          startedAtS: atS,
          endedAtS: null,
        };
        this.turnById.set(turn.id, record);
        this.turnRecords.push(record);
        this.event("turn_started", { kind: record.kind, text: record.text.slice(0, 80) });
      }
      const ended =
        turn.status === "done" || turn.status === "error" || turn.status === "interrupted";
      if (ended && record.endedAtS === null) {
        record.endedAtS = atS;
        this.event("turn_ended", {
          kind: record.kind,
          status: turn.status,
          // Whether the app read the project for the model before its first round (agent/stateBlock.ts).
          ...(record.kind === "user" ? { stateRead: Boolean(turn.stateBlock) } : {}),
        });
      }
    }
  }

  round(info: { kind: "tool_calls" | "text"; calls: number; wake: boolean }): void {
    this.rounds++;
    const turn = this.turnRecords.at(-1);
    if (turn) turn.rounds++;
    this.event("model_round", info);
  }

  look(file: WakeFile, answer: LookAnswer, said: string): void {
    this.looks.set(file.label, [...(this.looks.get(file.label) ?? []), answer]);
    if (answer === "words") this.wordsOf.add(file.label);
    this.event("look_answer", { file: file.label, answer, said });
  }

  captions(answer: CaptionsAnswer, said: string): void {
    this.captionAnswers.push(answer);
    this.event("captions_answer", { answer, said });
  }

  // ---- driving ---------------------------------------------------------------------------------------------

  private chat(): ChatStoreApi {
    if (!this.chatStore) throw new Error("the harness is not set up");
    return this.chatStore;
  }

  /** Runs virtual time, timer by timer, until `done()`; whatever is waiting on the engine, on a timer or on
   *  nothing but promises plays out in order, and the time it takes is the time that passes. */
  private async runUntil(done: () => boolean, what: string): Promise<void> {
    const began = Date.now();
    for (let step = 0; !done(); step++) {
      if (step > MAX_STEPS || Date.now() - began > MAX_TURN_VIRTUAL_S * 1000)
        throw new Error(
          `${what} did not end after ${step} steps and ${round3((Date.now() - began) / 1000)} virtual s ` +
            `(streaming=${this.chat().getState().streaming})`,
        );
      await vi.advanceTimersToNextTimerAsync();
    }
  }

  /** Promise chains played out, and a turn left running by the clock played to its end. */
  private async settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    await this.runUntil(() => !this.chat().getState().streaming, "the chat");
    await vi.advanceTimersByTimeAsync(0);
  }

  async say(text: string): Promise<void> {
    this.event("person_said", { text: text.slice(0, 80) });
    let sent = false;
    let failure: unknown = null;
    const sending = this.chat()
      .getState()
      .send(text)
      .catch((error: unknown) => {
        failure = error ?? new Error("the send failed");
      })
      .finally(() => {
        sent = true;
      });
    await this.runUntil(() => sent, `the turn for "${text.slice(0, 40)}"`);
    await sending;
    if (failure) throw failure;
    await this.settle();
  }

  async advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await this.settle();
  }

  async advanceTo(seconds: number): Promise<void> {
    await this.advance(Math.max(0, (seconds - this.nowS()) * 1000));
  }

  /** Background work the chat started has finished, reported as the app's own job queue gets it (jobNotes.ts). The
   *  queue wakes the assistant on its own for an export or a generation; for the words of a transcript the app
   *  has no wake yet, so a test uses this to stand one in and show that a scenario can be met. */
  settleJob(job: { tool: string; label: string; media_refs?: string[]; detail?: string }): void {
    this.event("job_settled", { tool: job.tool });
    notifyJobSettled(PROJECT_DIR, {
      id: `${job.tool}-${++this.jobs}`,
      status: "done",
      startedBy: "chat",
      ...job,
    });
  }

  settleExport(opts: { label?: string } = {}): void {
    this.settleJob({
      tool: "export",
      label: opts.label ?? "Export of the timeline",
      detail: "exported to the Downloads folder",
    });
  }

  lastLandingS(): number {
    const first = this.runs[0]?.startS ?? this.nowS();
    return round3(first + this.opts.engineSecondsPerFile * this.files.length);
  }

  // ---- reading ---------------------------------------------------------------------------------------------

  metrics(): WakeMetrics {
    const turns: TurnMetric[] = this.turnRecords.map((t) => ({
      kind: t.kind,
      textStart: t.text.slice(0, 80),
      rounds: t.rounds,
      startedAtS: t.startedAtS,
      endedAtS: t.endedAtS,
    }));
    const isWake = (i: number): boolean =>
      this.turnRecords[i].kind === "system" && this.turnRecords[i].text.startsWith(JOB_WAKE_LEAD);
    const landed = this.runs.filter((r) => r.endS !== null).map((r) => r.endS as number);
    return {
      turns,
      wakeTurns: turns.filter((_, i) => isWake(i)),
      systemTurns: this.turnRecords.filter((t) => t.kind === "system").length,
      modelRounds: this.rounds,
      engineRuns: this.runs.map((r) => ({ ...r })),
      looks: Object.fromEntries(this.looks),
      wordsFetched: this.wordsOf.size,
      wordsFetchedFiles: [...this.wordsOf].sort(),
      filesTotal: this.files.length,
      captionsAnswers: [...this.captionAnswers],
      finalAssistantTexts: this.chat()
        .getState()
        .turns.flatMap((t) => {
          const said = t.parts.filter((p) => p.kind === "text").at(-1);
          return said ? [String(said.text ?? "")] : [];
        }),
      lastLandingS: landed.length ? Math.max(...landed) : null,
      nowS: this.nowS(),
      networkCalls: this.blocked.length,
      refusedPrograms: [...(this.commands?.refused ?? [])],
      timeline: this.events.map((e) => ({ ...e })),
    };
  }

  async captionClips(): Promise<number> {
    if (!this.store) throw new Error("the harness is not set up");
    const timeline = await loadTimeline(this.store);
    return (timeline.tracks ?? [])
      .flatMap((track) => track.clips ?? [])
      .filter((clip) => clip.kind === "text" && clip.caption_group).length;
  }

  async writeEvidence(name: string): Promise<void> {
    const dir = process.env.L6_EVIDENCE_DIR;
    if (!dir) return;
    const body = {
      scenario: name,
      ...this.metrics(),
      finalTimeline: { captionClips: await this.captionClips() },
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
  }
}

export async function createWakeHarness(opts: WakeOptions): Promise<WakeHarness> {
  const harness = new Harness(opts);
  try {
    await harness.setup();
  } catch (error) {
    await harness.dispose();
    throw error;
  }
  return harness;
}
