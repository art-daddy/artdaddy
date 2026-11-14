// The decision to start an export again by itself, once, after a memory stop. Pure: everything arrives in one facts
// object, nothing here reads the PC, a switch or a clock, starts anything or asks anyone, and the answer is always a
// decision, never a throw (a fact that cannot be read refuses).
//
// A reason to restart is one ROW of AUTO_RESTART_REASONS and nothing else: its own rule (which failures are its and
// what it changes) and its words. What every reason must respect is checked here, for every row, so a row cannot skip
// it: the master switch and the row's own, a cancel, the one automatic restart an export may have whatever its
// reason, a way to start the export again, and a project that is still the one that was asked for.
import type { ExportReasonCode } from "../api/exportReason";
import type { ExportLimit } from "../api/exportVocabulary";
import type { ChipMaker, ExportEncoder } from "./exportEncoder";
import { ceilingBytes, cleanLadder, planRung, type Ladder, type Rung } from "./exportPlan";

/** The report carries the restart facts (`retry` with the value `app` on the restarted export, and the percent done in
 *  `outcome`) only when this is true. HELD: the owner has not yet approved the one privacy text that covers them (14 Nov);
 *  the last step of the build flips it, together with the test that pins what the report body then holds. */
export const SEND_RESTART_FACTS = false;

/** A stop with this share of the project (or more) already produced is too late to start again: the lost work would
 *  be most of what the restart saves. */
export const FIRST_QUARTER = 0.25;
/** Half of the two ceilings of the no-progress rule (30 minutes to the first report, 15 between pictures): a route
 *  whose own start-up or longest silence measured longer would be stopped, or nearly, by that rule. */
export const MAX_FIRST_REPORT_WAIT_S = 900;
export const MAX_LONGEST_GAP_S = 450;
/** A route expected to take longer than this is not offered: the native deadline for one export is 8 hours. */
export const MAX_ROUTE_SECONDS = 6 * 3600;
/** A route is taken for its speed only when it peaks at no more than this share of the memory ceiling now. */
export const ROOM_SHARE = 0.85;

/** The guards that say the PC itself ran short (stage 1), and the ones that say the export reached its own ceiling
 *  (stage 2). `scratch` and `clock` are not memory and never restart. */
export const PC_SHORT_GUARDS: readonly ExportLimit[] = Object.freeze(["pc_floor", "os"]);
export const OWN_CEILING_GUARDS: readonly ExportLimit[] = Object.freeze(["resident", "commit"]);

export type RestartEngine = "file-sequence-v1" | "partition-pipes-v1";
const STREAMED = "partition-pipes-v1";
const MIB = 1024 * 1024;

/** What the facts say about the project, for a route row to match on (the app's `RenderWorkload` plus what the export
 *  was asked to read and which effects it uses). */
export interface RestartWorkload {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSeconds: number;
  readonly visualClips: number;
  readonly captionClips: number;
  readonly audioClips: number;
  readonly peakVisualLayers: number;
  readonly peakMediaLayers: number;
  readonly sourceInputs: number;
  readonly effects: readonly string[];
}

/** The switches the caller read once, at the decision. A reason's own switch is a key of its own. */
export interface RestartFlags {
  readonly auto_restart: boolean;
  readonly memory_restart: boolean;
  readonly restart_streamed: boolean;
  readonly plan_rung: boolean;
  readonly [flag: string]: boolean;
}

/** Everything a decision may read, in one object built by the caller before the decision. A fact that is missing or
 *  cannot be read counts against a restart. */
export interface RestartFacts {
  readonly failure: {
    readonly code: ExportReasonCode;
    /** The limit that fired (`limitThatFired`), null when the failure does not say. */
    readonly guard: ExportLimit | null;
    /** How the no-progress rule ended the run, when it did. */
    readonly stopKind: "idle" | "ceiling" | null;
    readonly stopSeconds: number | null;
  };
  readonly attempt: {
    /** 1 for the first attempt of an export. */
    readonly number: number;
    /** The rung the failed run used, its ladder (the rungs its command really has: what the queue reads, which is
     *  [0] with the rungs switched off) and its engine. */
    readonly rung: Rung;
    readonly ladder: Ladder;
    readonly engine: RestartEngine;
    readonly encoder: ExportEncoder;
    readonly chipMaker: ChipMaker | null;
    /** The kind of restart this attempt already is (the route a person's Try again starts from), if any. */
    readonly stickyRoute: RestartedAs | null;
  };
  readonly progress: {
    /** How much of the project had been produced, 0 to 1 (`producedFraction`). */
    readonly producedFraction: number;
    readonly elapsedSeconds: number;
    readonly activeSeconds: number;
    /** What the failed run was expected to take in all, null when nothing says. */
    readonly expectedSeconds: number | null;
  };
  readonly machine: {
    /** Free memory as the pre-start check reads it now. */
    readonly freeBytes: number | null;
    /** The peak sampled in the failed run and the limit in force, for the guard that fired. */
    readonly failedPeakBytes: number | null;
    readonly limitBytes: number | null;
  };
  readonly request: {
    readonly retryClosureExists: boolean;
    /** The project is the one the first attempt was admitted on. */
    readonly snapshotUnchanged: boolean;
    readonly aborted: boolean;
    readonly flags: RestartFlags;
    /** Automatic restarts already used by this export, by any reason. */
    readonly autoRestartsUsed: number;
  };
  /** Null when the project's facts are not known: no table row can match it. */
  readonly workload: RestartWorkload | null;
}

/** The only things a restart may change. */
export interface RestartOverride {
  readonly rung?: Rung;
  readonly engine?: "partition-pipes-v1";
  readonly processor?: true;
}
export const OVERRIDE_KEYS = ["rung", "engine", "processor"] as const;
export type OverrideKey = (typeof OVERRIDE_KEYS)[number];

/** What a restart is called to the assistant (`restarted`). */
export const RESTARTED_AS = ["gentler_setting", "memory_light_route", "processor"] as const;
export type RestartedAs = (typeof RESTARTED_AS)[number];

/** The reasons a failure is not restarted, in the one order they are checked in: the first that applies is the answer,
 *  and a test pins the order. A row goes down the list and stops at its first refusal; the answer is the refusal of
 *  the row that went furthest, so a failure that no row is about gets the first word, `not_memory`. */
export const REFUSAL_ORDER = [
  "not_memory",
  "flag_off",
  "cancelled",
  "second",
  "no_closure",
  "edited",
  "late",
  "no_route",
  "pc_short",
] as const;
export type RestartRefusal = (typeof REFUSAL_ORDER)[number];
/** The four a row's own rule may give; the others are decided for every row. */
type RowRefusal = "not_memory" | "late" | "no_route" | "pc_short";
const ROW_REFUSALS: readonly string[] = ["not_memory", "late", "no_route", "pc_short"];

export type RestartDecision =
  | {
      readonly restart: true;
      readonly reason: string;
      readonly override: RestartOverride;
      readonly restarted: RestartedAs;
      /** The route started, as the report's number: 0, 1 or 2 for a rung, 10 for the streamed engine. */
      readonly routeM: number;
      /** The rung that failed, as the report's number. */
      readonly failedRungN: number;
    }
  | { readonly restart: false; readonly why: RestartRefusal };

/** What a decision leaves in the local record (a bug report reads it; nothing is sent). `refused_at_door` is the
 *  queue's own: the pre-start check turned a decided restart down. */
export const RESTART_RECORDS = [
  "eligible",
  "late",
  "second",
  "no_route",
  "pc_short",
  "flag_off",
  "no_closure",
  "refused_at_door",
  "cancelled",
  "edited",
] as const;
export type RestartRecord = (typeof RESTART_RECORDS)[number];

/** The local record of a decision, or null when there is nothing to record (the failure was not a restart reason's). */
export function recordOf(decision: RestartDecision): RestartRecord | null {
  if (decision?.restart === true) return "eligible";
  const why: unknown = decision?.why;
  if (why === "not_memory") return null;
  return RESTART_RECORDS.find((record) => record === why) ?? null;
}

/** The words of a reason: the line on the row while the first attempt is cleaned up and the next set going, the line
 *  it keeps once the restarted export runs, what the person reads if the restart stops for the same reason, and what
 *  the assistant is told. None may promise a picture, a likeness or a speed. */
export interface RestartWords {
  readonly gap: string;
  readonly after: string;
  readonly failedAgain: string;
  readonly assistantNote: string;
}

export type RowVerdict =
  | { readonly eligible: true; readonly override: RestartOverride }
  | { readonly eligible: false; readonly why: RowRefusal };

export interface RestartContext {
  readonly table: readonly RouteRow[];
}

/** One reason to restart. The row's own rule is `trigger`, a pure function of the facts: it says which failures are its
 *  (`not_memory` for any other), when it is too late (`late`) and what it would change (`override`, within the keys
 *  the row declares). It does not check the switches, a cancel, the count, the closure or the project: `decideRestart`
 *  does, for every row. */
export interface AutoRestartReason {
  readonly reason: string;
  /** Who owns the row and may change it (the table is shared). */
  readonly owner: string;
  readonly restarted: RestartedAs;
  /** The row's own switch (the master `auto_restart` must be on too). */
  readonly flag: string;
  readonly override: readonly OverrideKey[];
  readonly trigger: (facts: RestartFacts, context: RestartContext) => RowVerdict;
  readonly words: RestartWords;
  /** Where the row is proven: the ids of the witnesses that exercise it. */
  readonly witnesses: readonly string[];
}

/** One measured route for a shape of project (from the lab table): it is offered only to a project it `matches`, and
 *  only with what the table measured. A project that matches no row gets no route from the table. */
export interface RouteRow {
  readonly id: string;
  readonly matches: (workload: RestartWorkload) => boolean;
  readonly route: { readonly rung?: Rung; readonly engine?: "partition-pipes-v1" };
  /** What the route peaks at as a share (above 0, below 1) of what the NORMAL route needed on this shape: applied to
   *  the failed run's anchor only when that run was on the normal route. And/or the peak itself in MiB. Where both
   *  are given the larger is believed; one at least is needed. */
  readonly peakFactor?: number;
  readonly peakMiB?: number;
  /** Seconds to its first report and its longest silence, as measured. */
  readonly firstReportWaitS: number;
  readonly longestGapS: number;
  /** How long the route takes as a multiple of the normal route's time. */
  readonly timeFactor: number;
  /** Where the numbers come from (the lab table's file and section). */
  readonly evidence: string;
  /** The route's picture met the bar and was agreed. Only the streamed engine needs it. */
  readonly pictureCleared?: boolean;
}

/** The measured routes. Empty until the lab table exists, so an own-ceiling stop is not restarted yet. */
export const ROUTE_TABLE: readonly RouteRow[] = Object.freeze([]);

export interface DecideOptions {
  /** The routes an own-ceiling stop may restart on; absent, ROUTE_TABLE. */
  readonly table?: readonly RouteRow[];
  /** The reasons to consider; absent, AUTO_RESTART_REASONS. A test passes a stand-in row here, and a later reason
   *  that lives in its own file could be tried the same way before it is added to the table. */
  readonly rows?: readonly AutoRestartReason[];
}

const isRung = (value: unknown): value is Rung => value === 0 || value === 1 || value === 2;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const amount = (value: unknown): number | null => {
  const found = finite(value);
  return found !== null && found >= 0 ? found : null;
};
const positive = (value: unknown): number | null => {
  const found = finite(value);
  return found !== null && found > 0 ? found : null;
};
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const count = (value: unknown, least: number, otherwise: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= least ? value : otherwise;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

const WORKLOAD_COUNTS = [
  "width",
  "height",
  "fps",
  "durationSeconds",
  "visualClips",
  "captionClips",
  "audioClips",
  "peakVisualLayers",
  "peakMediaLayers",
  "sourceInputs",
] as const;

function readWorkload(raw: unknown): RestartWorkload | null {
  const source = record(raw);
  const counts: Partial<Record<(typeof WORKLOAD_COUNTS)[number], number>> = {};
  for (const key of WORKLOAD_COUNTS) {
    const value = amount(source[key]);
    if (value === null) return null;
    counts[key] = value;
  }
  const { effects } = source;
  if (!Array.isArray(effects) || !effects.every((name) => typeof name === "string")) return null;
  return { ...(counts as Record<(typeof WORKLOAD_COUNTS)[number], number>), effects: [...effects] };
}

/** The facts as a decision reads them: a new frozen object in which every value that cannot be read is one that
 *  counts against a restart (an unreadable progress is not early, an unreadable rung is the gentlest, an unreadable
 *  engine is the one with no gentler route, an unreadable flag is off). */
function readFacts(raw: unknown): RestartFacts {
  const root = record(raw);
  const failure = record(root.failure);
  const attempt = record(root.attempt);
  const progress = record(root.progress);
  const machine = record(root.machine);
  const request = record(root.request);
  const produced = finite(progress.producedFraction);
  const flags: Record<string, boolean> = {
    auto_restart: false,
    memory_restart: false,
    restart_streamed: false,
    plan_rung: false,
  };
  for (const [name, on] of Object.entries(record(request.flags))) flags[name] = on === true;
  return deepFreeze({
    failure: {
      code: (text(failure.code) ?? "") as ExportReasonCode,
      guard: text(failure.guard) as ExportLimit | null,
      stopKind:
        failure.stopKind === "idle" || failure.stopKind === "ceiling" ? failure.stopKind : null,
      stopSeconds: amount(failure.stopSeconds),
    },
    attempt: {
      number: count(attempt.number, 1, 1),
      rung: isRung(attempt.rung) ? attempt.rung : 2,
      ladder: Array.isArray(attempt.ladder) ? cleanLadder(attempt.ladder) : [0],
      engine: attempt.engine === "file-sequence-v1" ? attempt.engine : STREAMED,
      encoder: (text(attempt.encoder) ?? "x264-crf") as ExportEncoder,
      chipMaker: text(attempt.chipMaker) as ChipMaker | null,
      stickyRoute: RESTARTED_AS.find((kind) => kind === attempt.stickyRoute) ?? null,
    },
    progress: {
      producedFraction: produced !== null && produced >= 0 ? Math.min(1, produced) : Number.NaN,
      elapsedSeconds: amount(progress.elapsedSeconds) ?? 0,
      activeSeconds: amount(progress.activeSeconds) ?? 0,
      expectedSeconds: positive(progress.expectedSeconds),
    },
    machine: {
      freeBytes: amount(machine.freeBytes),
      failedPeakBytes: positive(machine.failedPeakBytes),
      limitBytes: positive(machine.limitBytes),
    },
    request: {
      retryClosureExists: request.retryClosureExists === true,
      snapshotUnchanged: request.snapshotUnchanged === true,
      aborted: request.aborted !== false,
      flags: flags as RestartFlags,
      autoRestartsUsed: count(request.autoRestartsUsed, 0, 1),
    },
    workload: readWorkload(root.workload),
  });
}

/** How much of the PROJECT a run had produced, 0 to 1, from what the card knows. A single-step export: the card's
 *  fraction. A sequence or streamed export: the card's bar is scaled over twice the project (the parts, then the final
 *  encode of the same length), so the parts' share is twice the bar and, once the final encode has begun, all of it.
 *  A fraction that is not a number counts as 0 (the stops that matter are at the start); a step that cannot be read is
 *  not taken for the last one. */
export function producedFraction(live: {
  readonly fraction: number | null;
  readonly step: number | null;
  readonly steps: number | null;
}): number {
  const known = typeof live.fraction === "number" && !Number.isNaN(live.fraction);
  const fraction = Math.min(1, Math.max(0, known ? (live.fraction as number) : 0));
  const { step, steps } = live;
  if (typeof steps !== "number" || steps <= 1) return fraction;
  if (typeof step === "number" && Number.isInteger(step) && step >= steps - 1) return 1;
  return Math.min(1, 2 * fraction);
}

/** What the app's own stop for standing still says to a reason (exportTrace.ts `stalledOut`): an IDLE stop, at the idle
 *  limits (the processors had done next to nothing), or a CEILING stop (the PC stayed busy: the spinning kind, or a stop at
 *  `ceilingSeconds` or later, the busy ceilings being above the idle limits). Nothing and nothing when the export was not
 *  stopped for standing still, or the stop cannot be read. */
export function stopFactsOf(
  stall: { readonly kind: string; readonly seconds: number } | null | undefined,
  ceilingSeconds: number,
): { stopKind: "idle" | "ceiling" | null; stopSeconds: number | null } {
  const seconds = stall ? amount(stall.seconds) : null;
  if (!stall || seconds === null) return { stopKind: null, stopSeconds: null };
  return {
    stopKind: stall.kind === "spinning" || seconds >= ceilingSeconds ? "ceiling" : "idle",
    stopSeconds: seconds,
  };
}

/** Whether anyone asked to Cancel the export that a failure ended: the person, the assistant, or the app quitting. The export's
 *  controller is aborted by a Cancel and also by the app's own stop for standing still, and that stop is not a Cancel; a Cancel
 *  is told by having been asked (whatever the controller says), or by the controller being aborted when the app did not do it. */
export function wasCancelAsked(read: {
  readonly aborted: boolean;
  readonly appStopped: boolean;
  readonly asked: boolean;
}): boolean {
  return read.asked || (read.aborted && !read.appStopped);
}

/** What the failed run says the export needed, for a prediction: where the export stopped at its own limit, at least
 *  the larger of its peak and that limit; where the PC ran short, the peak it reached. Null when it says nothing. */
export function anchorBytes(
  guard: string | null,
  failedPeakBytes: number | null,
  limitBytes: number | null,
): number | null {
  if (guard === "pc_floor" || guard === "os") return failedPeakBytes;
  if (guard !== "resident" && guard !== "commit") return null;
  if (failedPeakBytes === null) return limitBytes;
  return limitBytes === null ? failedPeakBytes : Math.max(failedPeakBytes, limitBytes);
}

const between = (value: unknown, low: number, high: number): boolean =>
  typeof value === "number" && value > low && value < high;
const seconds = (value: unknown): boolean => amount(value) !== null;

/** What is wrong with a route row, by field; empty when it is a row the chooser can use. A row with a problem is
 *  never offered, and the table's conformance test fails on it. */
export function routeRowProblems(row: RouteRow): string[] {
  const source = record(row);
  const { rung, engine } = record(source.route);
  const problems: string[] = [];
  if (typeof source.id !== "string" || source.id.trim() === "") problems.push("id");
  if (typeof source.matches !== "function") problems.push("matches");
  if (rung !== undefined && !isRung(rung)) problems.push("route.rung");
  if (engine !== undefined && engine !== STREAMED) problems.push("route.engine");
  if (rung === undefined && engine === undefined) problems.push("route");
  if (engine === STREAMED && rung !== undefined && rung !== 0) problems.push("route.rung");
  if (source.peakFactor !== undefined && !between(source.peakFactor, 0, 1))
    problems.push("peakFactor");
  if (source.peakMiB !== undefined && !between(source.peakMiB, 0, Infinity))
    problems.push("peakMiB");
  if (source.peakFactor === undefined && source.peakMiB === undefined) problems.push("peak");
  if (!seconds(source.firstReportWaitS)) problems.push("firstReportWaitS");
  if (!seconds(source.longestGapS)) problems.push("longestGapS");
  if (!between(source.timeFactor, 0, Infinity)) problems.push("timeFactor");
  if (typeof source.evidence !== "string" || source.evidence.trim() === "")
    problems.push("evidence");
  if (source.pictureCleared !== undefined && typeof source.pictureCleared !== "boolean")
    problems.push("pictureCleared");
  return problems;
}

const refuse = (why: RowRefusal): RowVerdict => ({ eligible: false, why });

/** Where a route stands on the way down: the one-pass rungs 0, 1 and 2, then the streamed engine. A higher step is a
 *  lighter route. */
const STREAMED_STEP = 3;
const stepOf = (route: { readonly rung?: Rung; readonly engine?: string }): number =>
  route.engine === STREAMED ? STREAMED_STEP : (route.rung ?? 0);

function matches(row: RouteRow, workload: RestartWorkload): boolean {
  try {
    return row.matches(workload) === true;
  } catch {
    return false;
  }
}

interface Gathered {
  predictedBytes: number | null;
  firstReportWaitS: number;
  longestGapS: number;
  timeFactor: number;
  cleared: boolean;
}

const larger = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

/** The route an own-ceiling stop restarts on, from the rows that match the project: the fastest that fits with room to
 *  spare, else the lightest that fits at all. A route is offered only if it is lighter than the failed one in the order
 *  of routes AND in the peak it is predicted to reach, is a command the export really has, was not measured to be
 *  stopped by the no-progress rule or too slow to finish, and (the streamed engine) has its picture cleared. */
function chooseRoute(facts: RestartFacts, table: readonly RouteRow[]): RowVerdict {
  const { failure, attempt, progress, machine, request, workload } = facts;
  const anchor = anchorBytes(failure.guard, machine.failedPeakBytes, machine.limitBytes);
  if (anchor === null || workload === null) return refuse("no_route");
  const failedStep = stepOf(attempt);
  // Rows for one route are believed at their worst: a project that several rows match gets the heaviest peak, the
  // longest waits and the slowest time among them, and the streamed engine only if every one cleared its picture.
  const gathered = new Map<number, Gathered>();
  for (const row of table) {
    if (routeRowProblems(row).length > 0 || !matches(row, workload)) continue;
    const step = stepOf(row.route);
    const byFactor =
      row.peakFactor !== undefined && failedStep === 0 ? anchor * row.peakFactor : null;
    const byFigure = row.peakMiB !== undefined ? row.peakMiB * MIB : null;
    const seen = gathered.get(step);
    gathered.set(step, {
      predictedBytes: larger(seen?.predictedBytes ?? null, larger(byFactor, byFigure)),
      firstReportWaitS: Math.max(seen?.firstReportWaitS ?? 0, row.firstReportWaitS),
      longestGapS: Math.max(seen?.longestGapS ?? 0, row.longestGapS),
      timeFactor: Math.max(seen?.timeFactor ?? 0, row.timeFactor),
      cleared: (seen?.cleared ?? true) && row.pictureCleared === true,
    });
  }
  const expected = progress.expectedSeconds;
  const usable = (step: number, route: Gathered): boolean => {
    if (step <= failedStep) return false;
    if (step === STREAMED_STEP) {
      if (!request.flags.restart_streamed || !route.cleared) return false;
    } else if (!request.flags.plan_rung || !attempt.ladder.includes(step as Rung)) return false;
    if (route.firstReportWaitS > MAX_FIRST_REPORT_WAIT_S) return false;
    if (route.longestGapS > MAX_LONGEST_GAP_S) return false;
    // With no expected time the route's own length cannot be checked: only one no slower than the failed run passes.
    return expected === null
      ? route.timeFactor <= 1
      : route.timeFactor * expected <= MAX_ROUTE_SECONDS;
  };
  const offers: { step: number; predictedBytes: number }[] = [];
  for (const [step, route] of gathered)
    if (route.predictedBytes !== null && route.predictedBytes < anchor && usable(step, route))
      offers.push({ step, predictedBytes: route.predictedBytes });
  if (offers.length === 0) return refuse("no_route");
  if (machine.freeBytes === null) return refuse("pc_short");
  const ceiling = ceilingBytes(machine.freeBytes);
  const fitting = offers.filter((offer) => offer.predictedBytes <= ceiling);
  if (fitting.length === 0) return refuse("pc_short");
  const roomy = fitting
    .filter((offer) => offer.predictedBytes <= ROOM_SHARE * ceiling)
    .sort((a, b) => a.step - b.step);
  const lightest = [...fitting].sort(
    (a, b) => a.predictedBytes - b.predictedBytes || b.step - a.step,
  );
  const { step } = roomy[0] ?? lightest[0];
  return {
    eligible: true,
    override: step === STREAMED_STEP ? { engine: STREAMED } : { rung: step as Rung },
  };
}

const early = (facts: RestartFacts): boolean => facts.progress.producedFraction < FIRST_QUARTER;
const ownsGuard = (guards: readonly ExportLimit[], guard: ExportLimit | null): boolean =>
  guard !== null && guards.includes(guard);

/** Stage 1: the PC itself ran short, so one step gentler on the export's own ladder, if the planner (the one the
 *  pre-start check will ask again, on the same evidence) says that step fits. */
function memoryShort(facts: RestartFacts): RowVerdict {
  const { failure, attempt, machine, request } = facts;
  if (failure.code !== "memory_limit" || !ownsGuard(PC_SHORT_GUARDS, failure.guard))
    return refuse("not_memory");
  if (!early(facts)) return refuse("late");
  // The streamed engine has no gentler step, and with the rungs switched off there is none.
  const next =
    attempt.engine === STREAMED || !request.flags.plan_rung
      ? undefined
      : attempt.ladder.find((rung) => rung > attempt.rung);
  if (next === undefined) return refuse("no_route");
  // A restart is a bet that the PC now has room: with no reading of its free memory there is nothing to bet on.
  if (machine.freeBytes === null) return refuse("pc_short");
  const plan = planRung({
    samples: [{ rung: attempt.rung, bytes: machine.failedPeakBytes }],
    freeBytes: machine.freeBytes,
    minRung: next,
    ladder: attempt.ladder,
  });
  return plan.fits ? { eligible: true, override: { rung: plan.rung } } : refuse("pc_short");
}

/** Stage 2: the export reached its own ceiling, so a route from the measured table (none yet: no restart). */
function memoryCeiling(facts: RestartFacts, { table }: RestartContext): RowVerdict {
  if (facts.failure.code !== "memory_limit" || !ownsGuard(OWN_CEILING_GUARDS, facts.failure.guard))
    return refuse("not_memory");
  if (!early(facts)) return refuse("late");
  return chooseRoute(facts, table);
}

const MEMORY_FAILED_AGAIN =
  "Your PC ran short of memory, even on a lighter setting. Close other programs and try again.";
const MEMORY_NOTE =
  "The app restarted this export once by itself because the PC ran short of memory. It is the same export (same job_id): do not start another.";

const REASONS: readonly AutoRestartReason[] = [
  {
    reason: "memory_short",
    owner: "3b",
    restarted: "gentler_setting",
    flag: "memory_restart",
    override: ["rung"],
    trigger: memoryShort,
    words: {
      gap: "Starting again on a gentler setting…",
      after:
        "Started again on a gentler setting because your PC ran short of memory. It may take longer; your export settings are kept.",
      failedAgain: MEMORY_FAILED_AGAIN,
      assistantNote: MEMORY_NOTE,
    },
    witnesses: ["M2", "M3", "M4", "M5", "M9", "M17"],
  },
  {
    reason: "memory_ceiling",
    owner: "3b",
    restarted: "memory_light_route",
    flag: "memory_restart",
    override: ["rung", "engine"],
    trigger: memoryCeiling,
    words: {
      gap: "Starting again on the memory-light route…",
      after:
        "Started again on the memory-light route because your PC ran short of memory. It may take longer; your export settings are kept.",
      failedAgain: MEMORY_FAILED_AGAIN,
      assistantNote: MEMORY_NOTE,
    },
    witnesses: ["M1", "M2b", "M3", "M4", "M9", "M14", "M17", "P1"],
  },
];

/** Every reason an export may be started again by itself, in the order they are tried. Closed: a reason is added
 *  here, with its words, its switch and its witnesses, and nowhere else. */
export const AUTO_RESTART_REASONS: readonly AutoRestartReason[] = Object.freeze(
  REASONS.map((row) => Object.freeze(row)),
);

/** The row of a reason, or null. */
export function restartRow(reason: string): AutoRestartReason | null {
  return AUTO_RESTART_REASONS.find((row) => row.reason === reason) ?? null;
}

const rank = (why: RestartRefusal): number => REFUSAL_ORDER.indexOf(why);
const refusal = (why: RestartRefusal): RestartDecision => ({ restart: false, why });
const earlier = (why: RestartRefusal, other: RestartRefusal | null): RestartRefusal =>
  other === null || rank(why) <= rank(other) ? why : other;

/** What every reason must respect, in the order of REFUSAL_ORDER; the first that applies. */
function sharedRefusal(row: AutoRestartReason, { request }: RestartFacts): RestartRefusal | null {
  if (!request.flags.auto_restart || request.flags[row.flag] !== true) return "flag_off";
  if (request.aborted) return "cancelled";
  if (request.autoRestartsUsed !== 0) return "second";
  if (!request.retryClosureExists) return "no_closure";
  if (!request.snapshotUnchanged) return "edited";
  return null;
}

/** A row's own rule, read safely: a row that throws or answers with anything else has no route. */
function verdictOf(
  row: AutoRestartReason,
  facts: RestartFacts,
  context: RestartContext,
): RowVerdict {
  try {
    const verdict = row.trigger(facts, context);
    if (verdict.eligible === true)
      return typeof verdict.override === "object" && verdict.override !== null
        ? verdict
        : refuse("no_route");
    return ROW_REFUSALS.includes(verdict.why) ? verdict : refuse("no_route");
  } catch {
    return refuse("no_route");
  }
}

/** A row's decision may change only what the row declares, only to something the export really has, and must change
 *  something: a restart on the same command would fail the same way. */
function restartOf(
  row: AutoRestartReason,
  override: RestartOverride,
  attempt: RestartFacts["attempt"],
): RestartDecision {
  const declared: readonly string[] = row.override;
  const keys = Object.keys(override);
  if (keys.length === 0 || keys.some((key) => !declared.includes(key))) return refusal("no_route");
  const { rung, engine, processor } = override;
  const real =
    (rung === undefined || (isRung(rung) && attempt.ladder.includes(rung))) &&
    (engine === undefined || engine === STREAMED) &&
    (processor === undefined || processor === true);
  const changes =
    (rung !== undefined && rung !== attempt.rung) ||
    (engine !== undefined && engine !== attempt.engine) ||
    (processor === true && attempt.chipMaker !== null);
  if (!real || !changes) return refusal("no_route");
  return {
    restart: true,
    reason: row.reason,
    override: {
      ...(rung !== undefined ? { rung } : {}),
      ...(engine !== undefined ? { engine } : {}),
      ...(processor !== undefined ? { processor } : {}),
    },
    restarted: row.restarted,
    routeM: engine === STREAMED ? 10 : (rung ?? 0),
    failedRungN: attempt.rung,
  };
}

function judge(
  row: AutoRestartReason,
  facts: RestartFacts,
  context: RestartContext,
): RestartDecision {
  const own = verdictOf(row, facts, context);
  const shared = sharedRefusal(row, facts);
  if (!own.eligible) return refusal(earlier(own.why, shared));
  if (shared !== null) return refusal(shared);
  return restartOf(row, own.override, facts.attempt);
}

/** Whether to start a failed export again by itself, and how. Total: whatever it is given, it answers. A row that
 *  covers the failure decides; when no row does, the answer is `not_memory`. Two rows covering one failure is a
 *  mistake in the table (the first in table order would win, and a test fails first). */
export function decideRestart(facts: RestartFacts, options?: DecideOptions): RestartDecision {
  try {
    const read = readFacts(facts);
    const context: RestartContext = { table: options?.table ?? ROUTE_TABLE };
    let furthest: RestartRefusal = "not_memory";
    for (const row of options?.rows ?? AUTO_RESTART_REASONS) {
      const decision = judge(row, read, context);
      if (decision.restart) return decision;
      if (rank(decision.why) > rank(furthest)) furthest = decision.why;
    }
    return refusal(furthest);
  } catch {
    return refusal("not_memory");
  }
}

/** The reasons whose own rule accepts this failure, before the checks every reason shares. No failure may make two
 *  of them true: the table's order is only a tie-break, and a test fails if it is ever needed. */
export function eligibleReasons(facts: RestartFacts, options?: DecideOptions): string[] {
  try {
    const read = readFacts(facts);
    const context: RestartContext = { table: options?.table ?? ROUTE_TABLE };
    return [...(options?.rows ?? AUTO_RESTART_REASONS)]
      .filter((row) => verdictOf(row, read, context).eligible)
      .map((row) => row.reason);
  } catch {
    return [];
  }
}
