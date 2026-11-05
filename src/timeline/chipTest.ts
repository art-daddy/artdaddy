// The graphics chip proves itself before an export may use it (exporter document 19.7, I-S4-1).
//
// For each chip the PC reports, in order of preference, a short test encodes real frames with the SAME arguments the
// export uses, decodes the file back and compares it with the source (SSIM): the frame count must be right, the picture
// must not be garbage, and at the 1080p class it must be as good as the processor's own encode at the same setting. The
// 4K class is tested the same way (a chip's size limits are only proved by encoding at the size), but without the slow
// processor reference: it is only offered to a chip that already passed the 1080p parity test.
//
// A pass is remembered for a month and a failure for a day, per maker, device, driver, size class, app build and test
// revision, so a driver update or a new build tests again. Anything that cannot be tested right now (an export is
// running, the test was stopped) is not remembered: it is simply tried again later. Every outcome ends in "no chip",
// which is the processor's encode: nothing here can make an export fail.
import { exportFlag, type ExportFlagName } from "../api/exportFlags";
import {
  resolveExportResources,
  runCapabilityProbe,
  type GraphicsAdapter,
  type ProbeOutcome,
} from "../platform/host";
import {
  CHIP_PREFERENCE,
  SIZE_CLASS_LIMITS,
  chipVideoArgs,
  type ChipMaker,
  type SizeClass,
} from "./exportEncoder";

/** Bumped whenever the test means something different, so that a pass remembered by an older test is not believed.
 *  1: the first test (30 frames a second at both classes; a file compared at its own length).
 *  2: each class tested at the fastest frame rate it admits; the compare ends with the file, so a short file is counted
 *     as short. */
export const CHIP_TEST_REVISION = 2;
export const TEST_FRAMES = 30;
/** Below this score against the source the picture is garbage (a driver bug), not merely compressed: valid encodes of the
 *  test clip score 0.78 to 0.92 (exporter document 19.7), a black or garbled one far less. */
export const SSIM_FLOOR = 0.6;
/** The chip may score this much lower than the processor on the same clip before it is "worse than the processor". */
export const SSIM_PARITY_MARGIN = 0.03;
export const PASS_TTL_MS = 30 * 86_400_000;
export const FAIL_TTL_MS = 24 * 3_600_000;
export const SUSPECT_MS = 24 * 3_600_000;
const ENCODE_TIMEOUT_MS = 30_000;
const COMPARE_TIMEOUT_MS = 30_000;
const REFERENCE_TIMEOUT_MS = 90_000;
const STORAGE_KEY = "artdaddy.chipTest.v1";
const MAX_REMEMBERED = 32;

export type ChipTestResult =
  | "passed"
  | "no_device"
  | "encode_failed"
  | "garbled"
  | "below_x264"
  | "wrong_frames"
  | "timed_out"
  | "cached_pass"
  | "cached_fail"
  | "skipped_busy";

export interface ChipVerdict {
  readonly maker: ChipMaker;
  readonly adapter: GraphicsAdapter;
  readonly sizeClass: SizeClass;
  readonly ok: boolean;
  readonly result: ChipTestResult;
  /** The chip's score against the source, times a thousand (0 when there was none). */
  readonly ssimMilli: number;
  readonly ms: number;
}

/** One line of what happened, for the export's story. */
export interface ChipTestEvent {
  readonly maker: ChipMaker;
  readonly sizeClass: SizeClass;
  readonly result: ChipTestResult;
  readonly ms: number;
  readonly ssimMilli: number;
}

export interface ChipLookup {
  /** A chip that is proven for the size class and may be used, or null (the processor encodes). */
  readonly chip: ChipVerdict | null;
  readonly events: readonly ChipTestEvent[];
}

export interface ChipDeps {
  adapters(): Promise<readonly GraphicsAdapter[]>;
  probe(
    args: readonly string[],
    options: { timeoutMs: number; kind: string },
  ): Promise<ProbeOutcome>;
  files: {
    dir(): Promise<string>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
  };
  storage: Pick<Storage, "getItem" | "setItem">;
  now(): number;
  release: string;
}

// The commands ---------------------------------------------------------------------------------------------------

const SIZES: Record<SizeClass, { w: number; h: number }> = {
  hd: { w: 1080, h: 1920 },
  uhd: { w: 3840, h: 2160 },
};

/** A clip with texture: test patterns with fine detail and a mild, fixed-seed noise (a flat clip would pass any encoder), at
 *  the class's size and at the fastest frame rate the class admits (what a chip proves here is what it may be given: a
 *  1080p60 export is not served on a 30 fps pass). The first thirty frames are the same however many are made. */
export function chipTestSource(sizeClass: SizeClass, frames = TEST_FRAMES): string {
  const { w, h } = SIZES[sizeClass];
  const rate = SIZE_CLASS_LIMITS[sizeClass].fps;
  return `testsrc2=size=${w}x${h}:rate=${rate}:duration=${frames / rate},noise=alls=8:allf=t:all_seed=7,format=yuv420p`;
}

const QUIET = ["-hide_banner", "-nostdin", "-v", "error"];

/** The chip's encode of the test clip: the export's own encoder arguments, at Medium, the tier the test stands for. */
export function chipEncodeArgs(maker: ChipMaker, sizeClass: SizeClass, out: string): string[] {
  const { codec, pixFmt, rate } = chipVideoArgs(maker, "medium");
  return [
    ...QUIET,
    "-f",
    "lavfi",
    "-i",
    chipTestSource(sizeClass),
    "-c:v",
    codec,
    "-pix_fmt",
    pixFmt,
    "-r",
    String(SIZE_CLASS_LIMITS[sizeClass].fps),
    ...rate,
    "-an",
    "-y",
    out,
  ];
}

/** The processor's encode of the same clip at Medium (CRF 23, the encoder's own default speed): what the chip is held to. */
export function referenceEncodeArgs(sizeClass: SizeClass, out: string): string[] {
  return [
    ...QUIET,
    "-f",
    "lavfi",
    "-i",
    chipTestSource(sizeClass),
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(SIZE_CLASS_LIMITS[sizeClass].fps),
    "-preset",
    "medium",
    "-crf",
    "23",
    "-y",
    out,
  ];
}

/** Decode `file` and compare it with the same source: the score and the frame count are in ffmpeg's own report.
 *  The source is LONGER than the file on purpose and the comparison ends with the shorter input, the file. With equal
 *  lengths ssim repeats the shorter input's last frame, so a file one frame short would report a full count (seen with
 *  the real ffmpeg); this way the count is the file's own, short or long. */
export function ssimArgs(file: string, sizeClass: SizeClass): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "info",
    "-i",
    file,
    "-f",
    "lavfi",
    "-i",
    chipTestSource(sizeClass, TEST_FRAMES * 2),
    "-lavfi",
    "[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]ssim=shortest=1",
    "-f",
    "null",
    "-",
  ];
}

/** The overall score and the frames decoded, from ffmpeg's report of a compare pass; null for what it did not say. */
export function readSsim(report: string): { ssim: number | null; frames: number | null } {
  const score = /SSIM\b[^\n]*?\bAll:([0-9]+(?:\.[0-9]+)?)/.exec(report);
  const value = score ? Number(score[1]) : null;
  const counts = [...report.matchAll(/frame=\s*(\d+)/g)];
  const last = counts.length ? Number(counts[counts.length - 1][1]) : null;
  return {
    ssim: value !== null && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null,
    frames: last !== null && Number.isSafeInteger(last) ? last : null,
  };
}

/** What a finished test means. The order is the order of trust: a file that cannot be read, then a wrong length, then a
 *  picture that is garbage, then one worse than the processor's (when the reference was run). */
export function judge(input: {
  code: number;
  frames: number | null;
  ssim: number | null;
  reference: number | null;
}): "passed" | "garbled" | "wrong_frames" | "below_x264" {
  if (input.code !== 0 || input.ssim === null) return "garbled";
  if (input.frames !== TEST_FRAMES) return "wrong_frames";
  if (input.ssim < SSIM_FLOOR) return "garbled";
  if (input.reference !== null && input.ssim < input.reference - SSIM_PARITY_MARGIN)
    return "below_x264";
  return "passed";
}

// What is remembered --------------------------------------------------------------------------------------------

interface Remembered {
  readonly ok: boolean;
  readonly result: ChipTestResult;
  readonly ssimMilli: number;
  readonly at: number;
}
interface Memory {
  results: Record<string, Remembered>;
  suspect: Record<string, number>;
}

/** How far a remembered time may be ahead of the clock before it is not believed (the clock was put back, or the file is
 *  not what this app wrote). */
const CLOCK_SKEW_MS = 5 * 60_000;
const RESULTS: ReadonlySet<string> = new Set<ChipTestResult>([
  "passed",
  "no_device",
  "encode_failed",
  "garbled",
  "below_x264",
  "wrong_frames",
  "timed_out",
]);

/** One remembered result, or null when it is not one this module could have written. A remembered answer decides whether
 *  a chip may be used without being tested, so it is believed only if it is exactly right: the right kinds, a real result
 *  that agrees with its verdict, a time that is a time and not from the future. Anything else is a retest. */
function rememberedResult(value: unknown, now: number): Remembered | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const { ok, result, ssimMilli, at } = entry;
  if (typeof ok !== "boolean" || typeof result !== "string" || !RESULTS.has(result)) return null;
  if (ok !== (result === "passed")) return null;
  if (
    typeof ssimMilli !== "number" ||
    !Number.isFinite(ssimMilli) ||
    ssimMilli < 0 ||
    ssimMilli > 1000
  )
    return null;
  if (typeof at !== "number" || !Number.isFinite(at) || at > now + CLOCK_SKEW_MS) return null;
  return { ok, result: result as ChipTestResult, ssimMilli, at };
}

function load(deps: ChipDeps): Memory {
  const memory: Memory = { results: {}, suspect: {} };
  try {
    const raw: unknown = JSON.parse(deps.storage.getItem(STORAGE_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const { results, suspect } = raw as Record<string, unknown>;
      const now = deps.now();
      if (results && typeof results === "object")
        for (const [key, value] of Object.entries(results)) {
          const entry = rememberedResult(value, now);
          if (entry) memory.results[key] = entry;
        }
      if (suspect && typeof suspect === "object")
        for (const [key, until] of Object.entries(suspect))
          // Never longer than a suspicion is ever set for, whatever the file says.
          if (
            typeof until === "number" &&
            Number.isFinite(until) &&
            until <= now + SUSPECT_MS + CLOCK_SKEW_MS
          )
            memory.suspect[key] = until;
    }
  } catch {
    /* a damaged memory is no memory */
  }
  return memory;
}

function save(deps: ChipDeps, memory: Memory): void {
  const keys = Object.keys(memory.results);
  if (keys.length > MAX_REMEMBERED)
    for (const key of keys
      .sort((a, b) => memory.results[a].at - memory.results[b].at)
      .slice(0, keys.length - MAX_REMEMBERED))
      delete memory.results[key];
  try {
    deps.storage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    /* the test is simply run again next time */
  }
}

const keyOf = (adapter: GraphicsAdapter, sizeClass: SizeClass, deps: ChipDeps): string =>
  [adapter.maker, adapter.device, adapter.driver, sizeClass, deps.release, CHIP_TEST_REVISION].join(
    "|",
  );
const suspectKey = (adapter: GraphicsAdapter): string =>
  [adapter.maker, adapter.device, adapter.driver].join("|");

/** The chips set aside in this run of the app, whatever could be written down: a chip that failed an export must not be
 *  offered again at once because storage is off or full. */
const setAside = new Map<string, number>();

/** When a chip set aside in this run may be offered again, or 0. A time further ahead than any suspicion is ever set for
 *  was taken while the clock was ahead of what it is now (put back, or wrong), and is dropped as the written memory drops
 *  it: a chip is never kept off for years by a clock that was wrong for a minute. */
function setAsideUntil(key: string, now: number): number {
  const until = setAside.get(key) ?? 0;
  if (until > now + SUSPECT_MS + CLOCK_SKEW_MS) {
    setAside.delete(key);
    return 0;
  }
  return until;
}

/** A chip that failed a real export is not offered again for a day, whatever its test said. Never throws. */
export function markChipSuspect(adapter: GraphicsAdapter, given?: ChipDeps): void {
  try {
    const deps = given ?? realDeps();
    const until = deps.now() + SUSPECT_MS;
    setAside.set(suspectKey(adapter), until);
    const memory = load(deps);
    memory.suspect[suspectKey(adapter)] = until;
    save(deps, memory);
  } catch {
    /* a chip that cannot be set aside for good is still set aside for this run of the app */
  }
}

// Running a test ------------------------------------------------------------------------------------------------

const NO_DEVICE =
  /no (?:\w+ )?capable|cannot load|no device|device not found|not found|unsupported device/i;

interface Run {
  readonly result: ChipTestResult;
  readonly ssimMilli: number;
  readonly ms: number;
  /** Not to be remembered: nothing was learned about the chip. */
  readonly transient?: true;
}

async function runTest(
  adapter: GraphicsAdapter,
  sizeClass: SizeClass,
  deps: ChipDeps,
): Promise<Run | null> {
  const started = deps.now();
  const spent = () => Math.max(0, deps.now() - started);
  const dir = await deps.files.dir();
  const chipFile = `${dir}/${sizeClass}-${adapter.maker}.mp4`;
  const referenceFile = `${dir}/${sizeClass}-ref.mp4`;
  try {
    await deps.files.mkdir(dir);
    const encoded = await deps.probe(chipEncodeArgs(adapter.maker, sizeClass, chipFile), {
      timeoutMs: ENCODE_TIMEOUT_MS,
      kind: "chip-test-encode",
    });
    if (encoded.kind === "stopped") return null;
    if (encoded.kind === "busy")
      return { result: "skipped_busy", ssimMilli: 0, ms: spent(), transient: true };
    if (encoded.kind === "timeout") return { result: "timed_out", ssimMilli: 0, ms: spent() };
    if (encoded.code !== 0)
      return {
        result: NO_DEVICE.test(encoded.stderr) ? "no_device" : "encode_failed",
        ssimMilli: 0,
        ms: spent(),
      };
    const compared = await deps.probe(ssimArgs(chipFile, sizeClass), {
      timeoutMs: COMPARE_TIMEOUT_MS,
      kind: "chip-test-compare",
    });
    if (compared.kind === "stopped") return null;
    if (compared.kind === "busy")
      return { result: "skipped_busy", ssimMilli: 0, ms: spent(), transient: true };
    if (compared.kind === "timeout") return { result: "timed_out", ssimMilli: 0, ms: spent() };
    const seen = readSsim(compared.stderr);
    const milli = seen.ssim === null ? 0 : Math.round(seen.ssim * 1000);
    // Cheapest verdicts first: a chip that already failed the picture does not need the slow reference.
    const early = judge({
      code: compared.code,
      frames: seen.frames,
      ssim: seen.ssim,
      reference: null,
    });
    if (early !== "passed") return { result: early, ssimMilli: milli, ms: spent() };
    let reference: number | null = null;
    if (sizeClass === "hd") {
      const made = await deps.probe(referenceEncodeArgs(sizeClass, referenceFile), {
        timeoutMs: REFERENCE_TIMEOUT_MS,
        kind: "chip-test-encode-ref",
      });
      if (made.kind === "stopped") return null;
      if (made.kind === "busy")
        return { result: "skipped_busy", ssimMilli: milli, ms: spent(), transient: true };
      if (made.kind === "timeout" || made.code !== 0)
        // The processor's own reference could not be made: nothing can be said about the chip, and a slow PC that
        // cannot make it in time is not a PC to hand a long export to on trust.
        return { result: "timed_out", ssimMilli: milli, ms: spent() };
      const against = await deps.probe(ssimArgs(referenceFile, sizeClass), {
        timeoutMs: COMPARE_TIMEOUT_MS,
        kind: "chip-test-compare-ref",
      });
      if (against.kind === "stopped") return null;
      if (against.kind === "busy")
        return { result: "skipped_busy", ssimMilli: milli, ms: spent(), transient: true };
      if (against.kind === "timeout") return { result: "timed_out", ssimMilli: milli, ms: spent() };
      // The comparison is what keeps a chip that is worse than the processor out: when it cannot be made (an error, nothing
      // readable, the wrong number of frames) the chip is not proven, and it must not pass because the reference said nothing.
      const seenReference = readSsim(against.stderr);
      if (against.code !== 0 || seenReference.ssim === null || seenReference.frames !== TEST_FRAMES)
        return { result: "timed_out", ssimMilli: milli, ms: spent() };
      reference = seenReference.ssim;
    }
    const result = judge({ code: compared.code, frames: seen.frames, ssim: seen.ssim, reference });
    return { result, ssimMilli: milli, ms: spent() };
  } catch {
    return { result: "encode_failed", ssimMilli: 0, ms: spent() };
  } finally {
    // The files are a test's own, and the largest is tens of megabytes at 4K: always removed, best effort.
    await Promise.all(
      [chipFile, referenceFile].map((path) => deps.files.remove(path).catch(() => undefined)),
    );
  }
}

const inflight = new Map<string, Promise<ChipVerdict | null>>();

/** The results of the tests that really ran, until someone takes them. The test usually runs when the Export dialog
 *  opens, long before the export it serves, so the export's report is where they are told. */
const unreported: ChipTestEvent[] = [];
/** The most results one look can make: two classes for each of the most chips a PC reports (cleanAdapters keeps eight). */
const MAX_UNREPORTED = 16;

/** The tests that ran since this was last asked, oldest first, once. Remembered answers are never in it. */
export function takeChipTestEvents(): ChipTestEvent[] {
  return unreported.splice(0, unreported.length);
}

/** `task`, or `fallback` as soon as `signal` says the caller has stopped waiting. A test is shared between whoever asks
 *  for it and always runs to its end (its answer is remembered for the next caller), so a caller's signal ends its own
 *  wait and nothing else. */
function untilAborted<T>(
  task: Promise<T>,
  signal: AbortSignal | undefined,
  fallback: T,
): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    const stop = () => resolve(fallback);
    signal.addEventListener("abort", stop, { once: true });
    const settle = (value: T) => {
      signal.removeEventListener("abort", stop);
      resolve(value);
    };
    task.then(settle, () => settle(fallback));
  });
}

/** The state of one chip at one size class: remembered, or tested now (`allowRun`). Records every outcome in `events`. */
async function verdictFor(
  adapter: GraphicsAdapter,
  sizeClass: SizeClass,
  options: { allowRun: boolean; signal?: AbortSignal },
  deps: ChipDeps,
  events: ChipTestEvent[],
): Promise<ChipVerdict | null> {
  const key = keyOf(adapter, sizeClass, deps);
  const event = (result: ChipTestResult, ms = 0, ssimMilli = 0): void => {
    events.push({ maker: adapter.maker, sizeClass, result, ms, ssimMilli });
  };
  const verdict = (
    ok: boolean,
    result: ChipTestResult,
    ssimMilli: number,
    ms: number,
  ): ChipVerdict => ({
    maker: adapter.maker,
    adapter,
    sizeClass,
    ok,
    result,
    ssimMilli,
    ms,
  });
  const memory = load(deps);
  const known = memory.results[key];
  if (known) {
    const fresh = deps.now() - known.at < (known.ok ? PASS_TTL_MS : FAIL_TTL_MS);
    if (fresh) {
      event(known.ok ? "cached_pass" : "cached_fail", 0, known.ssimMilli);
      return known.ok ? verdict(true, "cached_pass", known.ssimMilli, 0) : null;
    }
  }
  if (!options.allowRun) return null;
  const pending = inflight.get(key);
  if (pending) return untilAborted(pending, options.signal, null);
  const task = (async (): Promise<ChipVerdict | null> => {
    const run = await runTest(adapter, sizeClass, deps);
    if (!run) return null;
    event(run.result, run.ms, run.ssimMilli);
    unreported.push({
      maker: adapter.maker,
      sizeClass,
      result: run.result,
      ms: run.ms,
      ssimMilli: run.ssimMilli,
    });
    if (unreported.length > MAX_UNREPORTED) unreported.shift();
    if (!run.transient) {
      const next = load(deps);
      next.results[key] = {
        ok: run.result === "passed",
        result: run.result,
        ssimMilli: run.ssimMilli,
        at: deps.now(),
      };
      save(deps, next);
    }
    return run.result === "passed" ? verdict(true, "passed", run.ssimMilli, run.ms) : null;
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return untilAborted(task, options.signal, null);
}

const FLAG_OF: Record<ChipMaker, ExportFlagName> = {
  amd: "chip_amd",
  nvidia: "chip_nvidia",
  intel: "chip_intel",
};

/** A chip that may be used for an export at `sizeClass`: the first, in order of preference, that is switched on, not under
 *  suspicion and proven (remembered, or tested now when `allowRun`). Never throws; "no chip" is the processor's encode. */
export async function findChip(
  sizeClass: SizeClass,
  options: { allowRun: boolean; signal?: AbortSignal },
  given?: ChipDeps,
): Promise<ChipLookup> {
  const events: ChipTestEvent[] = [];
  try {
    if (options.signal?.aborted) return { chip: null, events: [] };
    const deps = given ?? realDeps();
    const adapters = await deps.adapters();
    const memory = load(deps);
    const candidates = [...adapters]
      .filter(
        (adapter) =>
          exportFlag(FLAG_OF[adapter.maker]) &&
          !((memory.suspect[suspectKey(adapter)] ?? 0) > deps.now()) &&
          !(setAsideUntil(suspectKey(adapter), deps.now()) > deps.now()),
      )
      .sort((a, b) => CHIP_PREFERENCE.indexOf(a.maker) - CHIP_PREFERENCE.indexOf(b.maker));
    for (const adapter of candidates) {
      // The 4K class is offered only to a chip that was good enough, against the processor, at 1080p.
      if (sizeClass === "uhd") {
        const parity = await verdictFor(adapter, "hd", options, deps, events);
        if (options.signal?.aborted) break;
        if (!parity) continue;
      }
      const found = await verdictFor(adapter, sizeClass, options, deps, events);
      if (options.signal?.aborted) break;
      if (found) return { chip: found, events: [...events] };
    }
  } catch {
    /* the processor encodes */
  }
  // A copy: a test that outlives a caller who stopped waiting must not write into what that caller was handed.
  return { chip: null, events: [...events] };
}

// The real PC ---------------------------------------------------------------------------------------------------

function realDeps(): ChipDeps {
  return {
    adapters: async () => (await resolveExportResources("")).adapters ?? [],
    probe: (args, options) => runCapabilityProbe(args, options),
    files: {
      dir: async () => {
        const { appCacheRoot } = await import("../tools/dataRoot");
        return `${await appCacheRoot()}/chip-test`;
      },
      mkdir: async (path) => {
        const { TauriFs } = await import("../tools/tauri");
        await new TauriFs().mkdir(path);
      },
      remove: async (path) => {
        const { TauriFs } = await import("../tools/tauri");
        await new TauriFs().remove(path);
      },
    },
    storage: localStorage,
    now: () => Date.now(),
    release: __ARTDADDY_RELEASE__,
  };
}

/** Tests only. */
export function __resetChipTests(): void {
  inflight.clear();
  unreported.length = 0;
  setAside.clear();
}
