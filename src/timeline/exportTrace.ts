// The story of one export, as a bounded ordered list of states, and the watch that notices when an
// export stops moving. Pure: the clock is passed in, nothing here touches the app, the network or the
// disk, so the rules are testable without an export.
//
// Why it exists: a report used to say THAT an export failed, cancelled or hung, never WHAT happened
// first. With this, one report tells the whole story: which dialogs it met and what was chosen, which
// stage it was in, who cancelled and where, which limit or stall ended it. Every event is a code from
// the closed list in api/exportEvents.ts (the server's list), a time, and at most one code and two
// small numbers. Never a name, a path or media.
import {
  EXPORT_TRACE_MAX_EVENTS,
  type ExportTraceEvent,
  type ExportTraceValue,
  type TraceEvent,
} from "../api/exportVocabulary";
import { createProgressReader, type RenderProgress } from "./ffmpegProgress";

/** Slots kept back for the end of the story, so a long run cannot crowd out how it ended. Enough for
 *  every kind of ending a story can hold: the stalls (capped below), a guard, a retry, a cancel and the outcome. */
export const ENDING_RESERVE = 8;
/** Stalls recorded in one story, so a run that stalls again and again cannot use the slots kept back
 *  for how it ended; the longest silence is still reported once, at the end. */
export const MAX_STALLS_LOGGED = 3;
const ENDINGS: ReadonlySet<ExportTraceEvent> = new Set([
  "outcome",
  "cancelled",
  "guard_tripped",
  "stall_detected",
  "retry",
  "chip_failed",
  "verify_failed",
  "interrupted_found",
]);
const FACT_MAX = 2_147_483_647;

const whole = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(FACT_MAX, Math.round(value))) : 0;

export class ExportTrace {
  private readonly events: TraceEvent[] = [];
  private readonly origin: number;
  private dropped = 0;

  constructor(private readonly clock: () => number = Date.now) {
    this.origin = clock();
  }

  /** Milliseconds since the request that started the export. */
  elapsedMs(): number {
    return Math.max(0, Math.round(this.clock() - this.origin));
  }

  /** Add a state. The first events fill the list up to a reserve; the last slots are for how it ended
   *  (`outcome`, `cancelled`, a guard or a stall), so a long story never hides its ending. Returns
   *  false when there was no room. */
  record(e: ExportTraceEvent, v: ExportTraceValue | "" = "", n = 0, m = 0): boolean {
    const room = ENDINGS.has(e)
      ? EXPORT_TRACE_MAX_EVENTS
      : EXPORT_TRACE_MAX_EVENTS - ENDING_RESERVE;
    if (this.events.length >= room) {
      this.dropped++;
      return false;
    }
    this.events.push({ e, t: this.elapsedMs(), v, n: whole(n), m: whole(m) });
    return true;
  }

  /** Whether an event of this kind and value is already the last one: a repeated stage is not news. */
  lastIs(e: ExportTraceEvent, v: ExportTraceValue | ""): boolean {
    const last = this.events[this.events.length - 1];
    return last !== undefined && last.e === e && last.v === v;
  }

  /** The events so far, in order, as copies. */
  snapshot(): TraceEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  /** How many events found no room (for tests and for the local log). */
  droppedCount(): number {
    return this.dropped;
  }
}

/** One bit per reason the pre-start check can raise, so one number says which were on the screen. */
export const CONFIRM_REASON_BITS: Readonly<Record<string, number>> = {
  outside_promise: 1,
  memory_unknown: 2,
  memory_shortage: 4,
  disk_unknown: 8,
  disk_shortage: 16,
  temporary_limit: 32,
  time_unknown: 64,
  execution_limit: 128,
  slow: 256,
  long: 512,
};

export type ExportStage = "queued" | "preparing" | "rendering" | "checking" | "saving";

/** Where an export was when it ended, as the number a trace event carries (`cancelled`'s `n`). */
export const STAGE_CODES: Readonly<Record<ExportStage, number>> = {
  queued: 0,
  preparing: 1,
  rendering: 2,
  checking: 3,
  saving: 4,
};

const GIB = 1024 ** 3;

/** Everything the queue remembers about one export's story: its trace, the watch on its run, the
 *  stage it is in (so a cancel can say where), and the machine facts seen at the start. One per
 *  export, created when the request arrives. */
export class ExportStory {
  readonly trace: ExportTrace;
  watch: RunWatch | null = null;
  stage: ExportStage = "queued";
  ramTotalGib: number | undefined;
  ramFreeGib: number | undefined;
  /** The longest time the run went without moving, seconds, once the run has ended. */
  longestGapS: number | undefined;
  /** A cancel is told once, however many times the button was pressed. */
  cancelNoted = false;
  /** Told of every stage entered (the chat card follows the run through it). */
  onEnter: ((stage: ExportStage) => void) | undefined;

  constructor(clock: () => number = Date.now) {
    this.trace = new ExportTrace(clock);
  }

  /** Move to a stage and say so, once: a stage the story already ends with is not repeated. */
  enter(stage: ExportStage): void {
    this.stage = stage;
    if (stage === "queued") return;
    if (!this.trace.lastIs("stage", stage)) this.trace.record("stage", stage);
    try {
      this.onEnter?.(stage);
    } catch {
      /* a listener must never disturb an export */
    }
  }

  /** The memory the PC had when the export was checked, in whole GiB. */
  noteMachine(resources: {
    total_memory_bytes: number | null;
    available_memory_bytes: number | null;
  }): void {
    const gib = (bytes: number | null) =>
      bytes !== null && Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes / GIB) : undefined;
    this.ramTotalGib = gib(resources.total_memory_bytes);
    this.ramFreeGib = gib(resources.available_memory_bytes);
  }
}

/** A run that has not moved for this long is logged as a stall. Log only: nothing is stopped. */
export const STALL_LOG_SECONDS = 60;
/** A longest gap shorter than this is not worth a line in the story. */
const GAP_WORTH_RECORDING_SECONDS = 10;

/** Watches one running export for movement.
 *
 *  Feed it the progress the process prints (`chunk`) and call `tick` every few seconds. Movement is a
 *  change in the frame count or the output time: ffmpeg prints a progress block every half second even
 *  when it is stuck, and a stuck one repeats the same numbers, so a block arriving is NOT a sign of
 *  life, a block that differs from the last is. Records the longest gap between movements, and a
 *  `stall_detected` event once per gap of STALL_LOG_SECONDS. The kind of stall (frozen, spinning, slow
 *  start) needs the process's CPU and disk activity, which the page does not have, so the kind is left
 *  blank here and the percentage reached is kept. */
export class RunWatch {
  private lastFrame = -1;
  private lastOutMs = -1;
  private lastMove: number;
  private longestGapMs = 0;
  private loggedThisGap = false;
  private stallsLogged = 0;
  private percent = 0;
  private moving = false;
  private readonly reader: (chunk: string) => void;

  constructor(
    private readonly trace: ExportTrace,
    /** Length of the finished video in ms, to say how far a stall got. 0 when unknown. */
    private readonly totalMs: number,
    private readonly clock: () => number = Date.now,
    /** Told once, when the run first moves. Without it the watch records the rendering stage itself. */
    private readonly onFirstMovement?: () => void,
  ) {
    this.lastMove = clock();
    this.reader = createProgressReader((record) => this.progress(record));
  }

  /** The process's own progress output, as it arrives. */
  chunk(text: string): void {
    this.reader(text);
  }

  progress(record: Pick<RenderProgress, "frame" | "outMs">): void {
    const now = this.clock();
    if (record.frame !== this.lastFrame || record.outMs !== this.lastOutMs) {
      this.longestGapMs = Math.max(this.longestGapMs, now - this.lastMove);
      this.lastMove = now;
      this.lastFrame = record.frame;
      this.lastOutMs = record.outMs;
      this.loggedThisGap = false;
      if (this.totalMs > 0)
        this.percent = Math.min(100, Math.max(0, Math.round((record.outMs / this.totalMs) * 100)));
      if (!this.moving) {
        this.moving = true;
        if (this.onFirstMovement) this.onFirstMovement();
        else if (!this.trace.lastIs("stage", "rendering")) this.trace.record("stage", "rendering");
      }
    }
  }

  /** Call every few seconds while the export runs. */
  tick(): void {
    const gap = this.clock() - this.lastMove;
    this.longestGapMs = Math.max(this.longestGapMs, gap);
    if (!this.loggedThisGap && gap >= STALL_LOG_SECONDS * 1000) {
      this.loggedThisGap = true;
      if (this.stallsLogged < MAX_STALLS_LOGGED) {
        this.stallsLogged++;
        this.trace.record("stall_detected", "", Math.round(gap / 1000), this.percent);
      }
    }
  }

  /** The run ended: the longest gap is final. Records it when it is worth a line. */
  finish(): number {
    this.tick();
    const seconds = Math.round(this.longestGapMs / 1000);
    if (seconds >= GAP_WORTH_RECORDING_SECONDS)
      this.trace.record("heartbeat_gap", "", seconds, this.percent);
    return seconds;
  }

  percentReached(): number {
    return this.percent;
  }
}
