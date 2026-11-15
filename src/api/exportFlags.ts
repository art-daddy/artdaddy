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
//               a word's time is the one the engine's own alignment found for its sound, so the first words of a clip
//               that begins with silence start where they are said; this release ships the behaviour off, so the
//               switch changes nothing yet (off: 0.27.0: whisper's own word times, the engine started as before)
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
};

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
/** At most one question to the server in this long, unless asked to ask. */
const REFRESH_MS = 10 * 60_000;
const TIMEOUT_MS = 3_000;

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
let askedAt = 0;
let inflight: Promise<void> | null = null;

/** Whether a behaviour is on right now. A name this client does not know is never on. */
export function exportFlag(name: ExportFlagName): boolean {
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
 *  turned off must stay off when the app opens offline). One request at a time, however many places ask; and
 *  only a look at a signed-in session uses up the wait, so signing in after the app opened still asks. */
export function refreshExportFlags(options: RefreshOptions = {}): Promise<void> {
  if (inflight) return inflight;
  const now = Date.now();
  if (!options.force && askedAt !== 0 && now - askedAt >= 0 && now - askedAt < REFRESH_MS)
    return Promise.resolve();
  const asking = ask(options).finally(() => {
    if (inflight === asking) inflight = null;
  });
  inflight = asking;
  return asking;
}

async function ask(options: RefreshOptions): Promise<void> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    if (!(await (options.signedIn ?? hasSession)())) return;
    askedAt = Date.now();
    const fetcher: Fetcher = options.fetcher ?? ((url, init) => authedFetch(url, init));
    const response = await fetcher(`${apiBase()}/client/export-flags`, {
      method: "GET",
      signal: timeout.signal,
    });
    if (!response.ok) return;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || (body as { v?: unknown }).v !== 1) return;
    const told = (body as { flags?: unknown }).flags;
    if (!told || typeof told !== "object") return;
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
  } catch {
    /* unreachable, slow, damaged: the last good answer (or the defaults) stands */
  } finally {
    clearTimeout(timer);
  }
}

/** Tests only. */
export function __setExportFlag(name: ExportFlagName, value: boolean): void {
  current = { ...current, [name]: value };
}

/** Tests only. */
export function __resetExportFlags(options: { keepStorage?: boolean } = {}): void {
  askedAt = 0;
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
