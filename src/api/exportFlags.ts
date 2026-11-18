// The exporter's remote switches (Phase 3). Behaviours that could not be fully proven in the lab can each be switched
// off from the server without a release. Every entry says what "off" restores (0.27.0 is the app release before the
// switches added after the first eight; their restore text is word for word the one in the server's export_flags.py,
// which also says how the flags relate):
//   stall_stop  stop an export that has made no progress (off: it is only logged, as before)
//   plan_rung   start an export that would not fit with fewer threads (off: it starts as before)
//   pc_floor    stop an export when the PC itself runs short of memory (off: the job's own limits only)
//   chip_amd, chip_nvidia, chip_intel
//               that maker's graphics chip may be tested, offered and chosen (off: never; the processor encodes)
//   chip_default  Fast is chosen for the person when the export would take over a minute (off: still offered)
//   faster_x264 the processor's faster setting may be chosen for a slow export when no chip is usable (off: never)
//   speech_cpu_cap
//               the "transcribe less" group: a whole-file processor job projected over 10 minutes is not started by
//               itself and a running one projected past 20 minutes is stopped; the assistant's span limit follows this
//               PC's measured speed; captions ask only each clip's used part (off: 0.27.0: whole-file jobs are
//               planned as today (no cap, no live stop), the assistant's spans are limited by the fixed 10 minutes and
//               a longer one is queued whole in the background, and captions ask for the whole file)
//   speech_gpu_retry
//               a graphics chip that crashed during transcription is tried again after an app update or 6 hours
//               (off: the chip stays off for 7 days, as in 0.27.0)
//   import_note
//               a note rides on every message sent while the person's imports run, an `importing` list appears in
//               `library_op list`, the project state block and the MCP read, and an unresolved name says "still
//               importing" (off: 0.27.0: no note, no list, "not found")
//   canvas_ask_stills
//               a pictures-first drop on an Auto project asks the existing Keep Current / Change to Match question, and
//               the agent's placement result carries the "canvas is still the default" note (off: 0.27.0: nothing
//               asked, nothing said)
//   proxy_first_needed
//               the clip at the playhead (else the first on the timeline) goes to the front of the app's own proxy
//               queue (off: 0.27.0: first in, first out)
//   lean_zoom
//               a zooming picture or clip with fit cover gets the exact mask stream, as long as lean_stills is on
//               (off: a zooming picture or clip with fit cover keeps 0.27.0's per-pixel zoom mask on every frame
//               (slow, same picture); it is also what you get while lean_stills is off)
//   lean_fades
//               transition, wipe and fade masks and animated opacity run only on the frames that need them (off:
//               transition, wipe and fade masks and animated opacity run on every frame of their clip as in 0.27.0 (a
//               wipe-right clip keeps its thin dark line at the left edge))
//   lean_dip
//               the dip's colour layer is only as long as its gate (off: the dip's colour layer is as long as the
//               whole project (or partition) as in 0.27.0)
//   lean_stills
//               each picture is read once (off: each picture is read again for every frame as in 0.27.0; it also
//               switches lean_zoom off, because the held pictures pay for the zoom mask's memory)
//   lean_grade
//               a graded picture that is read once is graded once (off: a graded picture is graded for every frame as
//               in 0.27.0)
//   lean_decoders
//               a picture that a one-pass export reads once gets one decoder thread (off: ffmpeg's own decoder thread
//               count as in 0.27.0)
//   idle_rule
//               the no-progress stop v2: only an idle export is stopped early; a busy one gets 30 minutes for its first
//               picture and 15 between pictures (off: a silent export is stopped after 5 minutes before its first
//               report and 3 minutes after, whatever the processor and the disk are doing, as in 0.27.0; a busy one is
//               never given the longer ceilings)
//   auto_restart
//               the master of every automatic restart: the app may restart an export by itself, once, when a reason of
//               the shared table says so (off: the app never restarts an export by itself, whatever the reason (a
//               memory stop, a failed chip encode): the person sees the plain message and Try again, as in 0.27.0)
//   memory_restart
//               the memory safety net (both stages) (off: a memory stop never restarts the export by itself: the
//               person sees the plain message and Try again, as in 0.27.0)
//   restart_streamed
//               the net's second kind of route (stage 2, the memory-light engine) (off: the app's automatic restart
//               uses only a gentler setting, never the memory-light engine)
//   pc_check
//               the hidden 10-second speed test gives this PC a class (off: the speed test never runs and no PC class
//               exists: estimates use today's guess and this PC's earlier exports only, nothing asks "Check this PC's
//               speed first?", and Quick is never preselected)
//   estimate_v2
//               estimates price the recipe that will really run and learn from stopped runs too (off: estimates are
//               0.27.0's: the length-only guess and the history, with no project cost model, no learning from stopped
//               runs, no range and no "rough guess" wording; and the graphics-chip and faster-setting rules read
//               0.27.0's numbers again)
//   memory_shape
//               a first export's memory is predicted from the project's shape and can start at a gentler setting
//               (off: a first export's memory is the flat 2 GB reserve as in 0.27.0; nothing predicts it from the
//               project's shape, and no export starts at a gentler setting because of one)
//   quick_export
//               Quick export and the route question (no visible Fast) (off: there is no Quick export and no route
//               question; the Export dialog's Mode row (Full quality or Fast where a graphics chip passed) comes back
//               as in 0.27.0)
//   export_help
//               a slow render gets the banner, Switch to Quick and the new fields in the assistant's list (off: a
//               slow render says only what 0.27.0 says: no banner, no Switch to Quick, no new fields in the assistant's
//               export list)
//   chip_restart
//               a graphics-chip failure restarts once on the processor by itself (off: a graphics-chip failure waits
//               for the person's Try again, as in 0.27.0)
//   speech_wake
//               the assistant is brought back, once, when the words of the files it was told were not ready have
//               landed (off: as in 0.27.0 nothing brings it back and the person has to ask again)
//   speech_word_times
//               a launch of the speech engine may carry its own word times (`-dtw`) when the voice in the audio it
//               hears starts more than a second in, for a model file and an engine path measured for it, so the first
//               words of a clip that begins with that much quiet start where they are said (speechWordTimes.ts; the
//               build decides whether any launch does: this switch only takes it away) (off: 0.27.0: whisper's own
//               word times, the engine started as before)
//   quick_route
//               the Export dialog offers a Fast choice beside Quality: a smaller picture (one size step below the
//               project's), at most 30 frames a second, Medium quality unless one was set, and the graphics chip or the
//               faster setting (off: 0.28.0: the Export dialog has no Fast choice, and an export that asks for Fast
//               runs as Quality)
//
// `quick_export` and `quick_route` are independent. In 0.28.0 `quick_export` only decides whether the Graphics chip row is drawn (ChipRow.tsx, chipRow.ts) and whether the chat card's chip line offers
// "Turn off" (ChipLine.tsx); nothing reads it for a Fast export, which is `quick_route`. A name that has shipped is never renamed or dropped, so its entry above is kept as it was.
//
// THIS BUILD SHIPS `estimate_v2` AND `pc_check` OFF (OFF_IN_THIS_BUILD below), whatever the server says: the honest estimate did not meet the bar it was built against (E1, lane L11's
// fit n1-202611170115: 24 % of the judged cells within 2 times against 90 %, 0 of 11 weak-profile cells, 85 % of the measured times inside the shown range against 90 %, five cells 4 times or
// more under-estimated without "could take much longer"), and the speed check did not meet its (P1: the class and the reading against the reference export; P2: the disturbance of a running
// export; PROBE-VERDICT n1), so the numbers they would show cannot be backed. The code is in the build and every other behaviour above runs, except `quick_route` (next).
// HELD, NOT DELETED, ON PURPOSE (owner decision 2026-11-18): the 29 files marked "HELD OFF, NOT DELETED" at their top stay with their tests. Nobody should delete them as "dead code".
// Three things still run while they are held off: (1) the PC check service starts at launch in the desktop app (main.tsx:64, the dynamic import of timeline/estimateStart);
// (2) the chip test takes its turn in the PC check's slot (the gate in timeline/chipTest.ts:446-472, installed by timeline/pcCheckStart.ts:125); (3) the memory-shape prior's start setting,
// `shapeStart`, is worked out at an export's start when this PC has no measured peak for the shape, and thrown away (timeline/exportRung.ts:106-118; the picture gate's answers are all
// pending, and `memory_shape` is not in OFF_IN_THIS_BUILD). Line numbers are as of the commit that wrote this note.
// To light the estimate and the speed check again: remove their names from OFF_IN_THIS_BUILD (one line each, with exportFlags.test.ts, which pins the list) AND bring new evidence that the numbers
// they show can be backed (the bar and the miss are above: 24 % of the judged cells within 2 times against 90 %). The memory-shape prior also needs the owner's picture-gate answers (timeline/pictureGate.ts).
// The long version is in docs/EXPORTER_ARCHITECTURE.md, section "Deferred Export Speed And Settings Work", row IDEA-EXPORT-ESTIMATOR-DEFERRED-001.
//
// THIS BUILD ALSO SHIPS `quick_route` OFF, whatever the server says: the Fast choice is built in pieces, and this build has its rules and the export's plumbing but not the Export dialog's choice, its words or its screens, so
// nothing is there yet to draw it or to start it. The server's file already says true (the switch exists there), so a later build lights the choice by removing the name from OFF_IN_THIS_BUILD in one line, with the test that pins this.
//
// The client carries compiled defaults, and the server only ever tells it to switch something off (or back
// on). So every way this can fail lands on what the client already does: no session, no network, a slow or
// failing server, a damaged answer, a name or value it does not know. It never throws, never blocks an
// export (a refresh runs beside it) and is not the compatibility gate, which can stop the app from working.
import { apiBase } from "./config";
import { authedFetch, hasSession } from "./auth";
// The extra places to fetch the speech model from are checked by the one pure function that owns those rules.
import { acceptModelSources } from "../tools/modelManifest";

export const EXPORT_FLAG_NAMES = [
  "stall_stop",
  "plan_rung",
  "pc_floor",
  "chip_amd",
  "chip_nvidia",
  "chip_intel",
  "chip_default",
  "faster_x264",
  "speech_cpu_cap",
  "speech_gpu_retry",
  "import_note",
  "canvas_ask_stills",
  "proxy_first_needed",
  "lean_zoom",
  "lean_fades",
  "lean_dip",
  "lean_stills",
  "lean_grade",
  "lean_decoders",
  "idle_rule",
  "auto_restart",
  "memory_restart",
  "restart_streamed",
  "pc_check",
  "estimate_v2",
  "memory_shape",
  "quick_export",
  "export_help",
  "chip_restart",
  "speech_wake",
  "speech_word_times",
  "quick_route",
] as const;
export type ExportFlagName = (typeof EXPORT_FLAG_NAMES)[number];

/** What runs before the server has said anything. The gate decided these from the lab and the soak: on,
 *  because every flag gives a way back. */
export const COMPILED_FLAG_DEFAULTS: Readonly<Record<ExportFlagName, boolean>> = {
  stall_stop: true,
  plan_rung: true,
  pc_floor: true,
  chip_amd: true,
  chip_nvidia: true,
  chip_intel: true,
  chip_default: true,
  faster_x264: true,
  speech_cpu_cap: true,
  speech_gpu_retry: true,
  import_note: true,
  canvas_ask_stills: true,
  proxy_first_needed: true,
  lean_zoom: true,
  lean_fades: true,
  lean_dip: true,
  lean_stills: true,
  lean_grade: true,
  lean_decoders: true,
  idle_rule: true,
  auto_restart: true,
  memory_restart: true,
  restart_streamed: true,
  pc_check: true,
  estimate_v2: true,
  memory_shape: true,
  quick_export: true,
  export_help: true,
  chip_restart: true,
  speech_wake: true,
  speech_word_times: true,
  quick_route: true,
};

/** Behaviours that are in this build and NOT shipped: they stay off whatever the server says, whatever the compiled default says and whatever a stored answer holds, because the proof they were
 *  built against was not met, or the screens that would show them are not in this build (see the top of this file). The server's "back on" cannot reach them. A later build that meets its bars removes the name here, in one line, with the test that pins this. */
export const OFF_IN_THIS_BUILD: ReadonlySet<ExportFlagName> = new Set<ExportFlagName>([
  "estimate_v2",
  "pc_check",
  "quick_route",
]);

/** Tests only: forces the hold on (true) or off (false); null leaves it to the build's mode. */
let holdOverride: boolean | null = null;

/** Whether the build itself holds this behaviour off (so no answer, stored or fresh, can switch it on). A shipped or a development build holds it. The unit suite's mode is "test", which runs every behaviour, so the suite needs no
 *  setup of its own and a copy of this module that is loaded again (vi.resetModules()) is lifted too; the tests of the hold itself force it with `__setHeldOffByBuild`. */
export function isOffInThisBuild(name: ExportFlagName): boolean {
  if (!OFF_IN_THIS_BUILD.has(name)) return false;
  return holdOverride ?? import.meta.env.MODE !== "test";
}

/** The two cut-offs that turn this PC's speed-test score into fast / OK / weak (`ok_over` and `weak_over` on the
 *  wire). Unlike a flag, a number can move a threshold both ways, so a pair is only ever used as a whole. */
export interface PcClassCutoffs {
  okOver: number;
  weakOver: number;
}

/** What runs until the server has accepted another pair: the one the app was tuned with. */
export const COMPILED_PC_CLASS: Readonly<PcClassCutoffs> = { okOver: 1, weakOver: 4 };

/** The band each cut-off may be retuned within, both ends included. The server checks the same band before it
 *  serves a pair; a pair that is outside it, or is not ordered (okOver below weakOver), is not used at all. */
export const PC_CLASS_BANDS = {
  okOver: { min: 0.5, max: 2 },
  weakOver: { min: 2, max: 8 },
} as const;

function acceptPcClass(raw: unknown): PcClassCutoffs | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { ok_over: ok, weak_over: weak } = raw as Record<string, unknown>;
  // typeof leaves out booleans and strings; finite leaves out NaN and infinity.
  if (typeof ok !== "number" || typeof weak !== "number") return null;
  if (!Number.isFinite(ok) || !Number.isFinite(weak)) return null;
  const { okOver, weakOver } = PC_CLASS_BANDS;
  if (ok < okOver.min || ok > okOver.max || weak < weakOver.min || weak > weakOver.max) return null;
  return ok < weak ? { okOver: ok, weakOver: weak } : null;
}

const STORAGE_KEY = "artdaddy.exportFlags.v1";
/** At most one question to the server in this long after it answered, unless asked to ask. */
const REFRESH_MS = 10 * 60_000;
/** The server sleeps when nobody has used it for a few minutes. Waking it takes 21 to 26 seconds (the app's own text
 *  says up to 30), and the renewal of the session that may have to come first measured 18 to 43 (api/desktopAuth.ts),
 *  so a question waits a minute. It always runs beside other work, never in front of it. */
const TIMEOUT_MS = 60_000;
/** After a question that got no answer the next one waits this long, doubling for each miss in a row up to
 *  REFRESH_MS: a miss costs a minute, not the whole wait. */
const RETRY_MS = 60_000;
/** How often an app that stays open looks at whether its answer has become old. */
const WATCH_MS = 30_000;

function stored(): Record<ExportFlagName, boolean> {
  const flags = { ...COMPILED_FLAG_DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object")
      for (const name of EXPORT_FLAG_NAMES) {
        const value = (parsed as Record<string, unknown>)[name];
        if (typeof value === "boolean") flags[name] = value;
      }
  } catch {
    /* a damaged copy is the defaults */
  }
  return flags;
}

let current: Record<ExportFlagName, boolean> = stored();
/** Memory only, never written to storage: an app restart starts from the compiled pair and the first answer of the
 *  session retunes it. */
let currentPcClass: Readonly<PcClassCutoffs> = COMPILED_PC_CLASS;
/** Memory only, like the pair above: the extra places the answer named for fetching the speech model, as
 *  `acceptModelSources` accepted them (the whole list or none). */
let currentModelSources: readonly string[] = [];
/** When the last question ended (answered or not) and how long the next one that is not forced waits after that:
 *  REFRESH_MS after an answer, RETRY_MS doubled per miss in a row after none. A look that found nobody signed in
 *  changes neither, so signing in after the app opened still asks. */
let endedAt = 0;
let waitMs = REFRESH_MS;
let misses = 0;
let inflight: Promise<void> | null = null;

/** Whether a behaviour is on right now. A name this client does not know is never on, and neither is one the build holds off ({@link OFF_IN_THIS_BUILD}). */
export function exportFlag(name: ExportFlagName): boolean {
  if (isOffInThisBuild(name)) return false;
  return current[name] ?? false;
}

/** The cut-offs of the PC speed class right now: the pair the server last accepted this session, else the
 *  compiled one. */
export function pcClass(): Readonly<PcClassCutoffs> {
  return currentPcClass;
}

/** The extra places, beyond the compiled-in one, that the server last named for fetching the speech model this
 *  session; none until it has. They only say where to ask: what arrives is checked against the compiled size and
 *  SHA-256. */
export function speechModelSources(): readonly string[] {
  return currentModelSources;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface RefreshOptions {
  fetcher?: Fetcher;
  signedIn?: () => Promise<boolean>;
  force?: boolean;
  timeoutMs?: number;
}

/** Ask the server which behaviours to run, and keep the answer (also across a restart: a switch that was
 *  turned off must stay off when the app opens offline). One request at a time, however many places ask. The wait
 *  before the next question starts when this one ENDS: a full one after an answer, a short one after none (the
 *  server asleep, down, or an answer that is not one). Only a look at a signed-in session uses up a wait, so
 *  signing in after the app opened still asks. Never throws and never rejects. */
export function refreshExportFlags(options: RefreshOptions = {}): Promise<void> {
  if (inflight) return inflight;
  const now = Date.now();
  if (!options.force && endedAt !== 0 && now - endedAt >= 0 && now - endedAt < waitMs)
    return Promise.resolve();
  const asking: Promise<void> = ask(options)
    .then((outcome) => {
      // A reset (tests only) drops `inflight`: what an ask begun before it learns is not kept.
      if (outcome === "nobody" || inflight !== asking) return;
      endedAt = Date.now();
      misses = outcome === "answered" ? 0 : misses + 1;
      waitMs = misses === 0 ? REFRESH_MS : Math.min(REFRESH_MS, RETRY_MS * 2 ** (misses - 1));
    })
    .finally(() => {
      if (inflight === asking) inflight = null;
    });
  inflight = asking;
  return asking;
}

/** While the app stays open and visible, ask again once the answer is old (or the last question got none and its
 *  short wait is over), so a switch the server turned off reaches an app left open on an edit session within about
 *  ten minutes, not at the next export. It only looks every WATCH_MS, asks nothing while the window is hidden, and
 *  the rules above are the only ones there are: one question at a time, never sooner than its wait.
 *  `sessionAtHand` says whether a live session token is held already. When none is, no look is made: looking at a
 *  session would have to renew it (a read of the keychain and a call to the server) for nobody's work, so an app that
 *  nobody is using goes quiet when its token runs out, and an app that is being used keeps its token alive itself.
 *  Returns how to stop. */
export function keepExportFlagsFresh(sessionAtHand: () => boolean = () => true): () => void {
  const timer = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (!sessionAtHand()) return;
    void refreshExportFlags();
  }, WATCH_MS);
  return () => clearInterval(timer);
}

/** "answered": a valid answer was taken. "missed": none came in time, or it was not a valid one: nothing changed.
 *  "nobody": nobody is signed in, so nothing was asked. */
type Outcome = "answered" | "missed" | "nobody";

async function ask(options: RefreshOptions): Promise<Outcome> {
  const timeout = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The deadline is kept here and not left to the request: whatever comes after it is never taken (hear checks), and
  // a question that is stuck before its request (the sign-in look) still ends.
  const late = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      timeout.abort();
      resolve("missed");
    }, options.timeoutMs ?? TIMEOUT_MS);
  });
  try {
    return await Promise.race([hear(options, timeout.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function hear(options: RefreshOptions, signal: AbortSignal): Promise<Outcome> {
  try {
    if (!(await (options.signedIn ?? hasSession)())) return "nobody";
    if (signal.aborted) return "missed";
    const fetcher: Fetcher = options.fetcher ?? ((url, init) => authedFetch(url, init));
    const response = await fetcher(`${apiBase()}/client/export-flags`, { method: "GET", signal });
    if (!response.ok) return "missed";
    const body: unknown = await response.json();
    // Past the deadline a newer question may be asking, or have answered: this answer is old news.
    if (signal.aborted) return "missed";
    if (!body || typeof body !== "object" || (body as { v?: unknown }).v !== 1) return "missed";
    const told = (body as { flags?: unknown }).flags;
    if (!told || typeof told !== "object") return "missed";
    const next = { ...current };
    for (const name of EXPORT_FLAG_NAMES) {
      const value = (told as Record<string, unknown>)[name];
      if (typeof value === "boolean") next[name] = value;
    }
    current = next;
    // A valid answer without a valid pair puts the compiled pair back: an operator who removes the section must undo
    // a retune. An answer that is not valid (above) leaves the pair alone, as it leaves the flags.
    currentPcClass = acceptPcClass((body as { pc_class?: unknown }).pc_class) ?? COMPILED_PC_CLASS;
    // The same for the places: a valid answer that names none, or names any bad one, puts the list back to none.
    currentModelSources = acceptModelSources(
      (body as { speech_model_sources?: unknown }).speech_model_sources,
    );
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      /* not being able to remember is not a failure */
    }
    return "answered";
  } catch {
    /* unreachable, slow, damaged: the last good answer (or the defaults) stands */
    return "missed";
  }
}

/** Tests only. */
export function __setExportFlag(name: ExportFlagName, value: boolean): void {
  current = { ...current, [name]: value };
}

/** Tests only: force the hold on (true) or off (false); null goes back to the build mode's own answer (held in a shipped or development build, lifted under the unit suite). */
export function __setHeldOffByBuild(held: boolean | null): void {
  holdOverride = held;
}

/** Tests only. */
export function __resetExportFlags(options: { keepStorage?: boolean } = {}): void {
  endedAt = 0;
  waitMs = REFRESH_MS;
  misses = 0;
  inflight = null;
  currentPcClass = COMPILED_PC_CLASS;
  currentModelSources = [];
  if (!options.keepStorage) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* none */
    }
  }
  current = stored();
}
