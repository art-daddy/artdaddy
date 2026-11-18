// HELD OFF ON PURPOSE, NOT DELETED (owner decision 2026-11-18): part of the held export-time guess machinery (flags
// `estimate_v2` and `pc_check`, both in OFF_IN_THIS_BUILD). Kept for a later release, so do not remove it as unused.
// The full note is in src/api/exportFlags.ts.
//
// The PC's class from the hidden speed test: the pure rules (the class from a ratio, the cut-offs' band) and the local store of the check's own answer for each probe.
// The cut-offs themselves are the server's (`pcClass()` of the flags reader, in memory only); this module keeps no copy of them. Nothing here reads the PC, builds a command or
// returns a speed, a thread count, a preset or an encoder: the class only decides who is warned and who has Quick preselected.
// Every read fails soft (a damaged, foreign or stale value is no value) and a write that fails is not a failure.
import type { PcClass } from "./exportTypes3c";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The cut-offs, in multiples of the video's length: the time a plain 1080p30 export takes on this PC divided by the video's length.
 *  A PC is fast up to `okOver` and OK up to `weakOver`, both INCLUDED: exactly 1.0 is fast and exactly 4.0 is OK. */
export const PC_CLASS_COMPILED = { okOver: 1, weakOver: 4 } as const;

export interface Cutoffs {
  okOver: number;
  weakOver: number;
}

/** The band the server's pair must stay inside (both ends included), so a typo there can never call every PC weak or fast. */
export const CUTOFF_BAND = {
  okOver: { min: 0.5, max: 2 },
  weakOver: { min: 2, max: 8 },
} as const;

/** PLACEHOLDERS, not fitted: `r_hat = k x 30 / b_fps + c0`, the ratio of the reference export estimated from the probe's speed B.
 *  The lane fits both on the rig matrix and replaces them here, in this one place. */
export const R_HAT_FIT = { k: 1, c0: 0 } as const;
const REFERENCE_FPS = 30;
const R_HAT_MAX = 1_000_000;

export const PC_CHECK_KEY = "artdaddy.pcCheck.v1";
export const PC_CHECK_TTL_MS = 30 * 86_400_000;

/** A time ahead of the clock by more than this was written while the clock was ahead (put back, or wrong) and is not believed. */
const CLOCK_SKEW_MS = 5 * 60_000;
const MAX_STORED_CHARS = 65_536;
const MAX_ENTRIES = 16;
const ID_MAX = 64;
const BUILD_MAX = 200;
const CORES_MAX = 4096;
const FPS_MAX = 100_000;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// The cut-offs ---------------------------------------------------------------------------------------------------------------

/** The server's pair, if and only if it is a pair inside the band: BOTH numbers or NEITHER (null: the compiled pair stands).
 *  The wire spelling (`ok_over`, `weak_over`) and this module's own (`okOver`, `weakOver`) are both read; an object that
 *  mixes the two spellings is ambiguous and is refused. A string, NaN or Infinity is not a number. */
export function acceptCutoffs(told: unknown): Cutoffs | null {
  try {
    if (!isObject(told)) return null;
    const has = (key: string) => Object.prototype.hasOwnProperty.call(told, key);
    const wire = has("ok_over") || has("weak_over");
    const own = has("okOver") || has("weakOver");
    if (wire === own) return null;
    const ok = wire ? told.ok_over : told.okOver;
    const weak = wire ? told.weak_over : told.weakOver;
    if (!isNumber(ok) || !isNumber(weak)) return null;
    const { okOver, weakOver } = CUTOFF_BAND;
    if (ok < okOver.min || ok > okOver.max || weak < weakOver.min || weak > weakOver.max)
      return null;
    return ok < weak ? { okOver: ok, weakOver: weak } : null;
  } catch {
    return null;
  }
}

/** The class of a PC from its ratio: up to `okOver` fast, up to `weakOver` OK, above it weak; no ratio (or one that is not a
 *  finite, non-negative number) is `unknown`. A pair outside the band is not used (the compiled pair stands). `unfinished` is
 *  never produced here: only the service knows a check did not finish. */
export function classOf(rHat: number | null, cutoffs?: Cutoffs): PcClass {
  if (typeof rHat !== "number" || !Number.isFinite(rHat) || rHat < 0) return "unknown";
  const { okOver, weakOver } = acceptCutoffs(cutoffs) ?? PC_CLASS_COMPILED;
  if (rHat <= okOver) return "fast";
  return rHat <= weakOver ? "ok" : "weak";
}

/** The ratio of the reference export from the probe's speed B (frames a second); null for no usable speed. Never negative. */
export function rHatOf(bFps: number | null): number | null {
  if (typeof bFps !== "number" || !Number.isFinite(bFps) || bFps <= 0) return null;
  const ratio = (R_HAT_FIT.k * REFERENCE_FPS) / bFps + R_HAT_FIT.c0;
  return Number.isNaN(ratio) ? null : Math.min(R_HAT_MAX, Math.max(0, ratio));
}

// The record ----------------------------------------------------------------------------------------------------------------

export interface PcCheckRecord {
  revision: number;
  build: string;
  atMs: number;
  cores: number;
  outcome: "done" | "unfinished";
  aFps: number | null;
  bFps: number | null;
  cFps: number | null;
  rHat: number | null;
  cls: PcClass;
}

/** What makes a stored record current: this probe revision, this build, this core count, and not older than `ttlMs`. */
export interface PcCheckNow {
  atMs: number;
  build: string;
  cores: number;
  revision: number;
}

/** The record if it is one this module could have written, else null: the right kinds and ranges, and an outcome that agrees
 *  with the rest (a finished check has a speed B, a ratio and a class of fast, OK or weak; one that did not finish has none). */
export function checkedRecord(value: unknown): PcCheckRecord | null {
  try {
    if (!isObject(value)) return null;
    const { revision, build, atMs, cores, outcome, aFps, bFps, cFps, rHat, cls } = value;
    const fpsOk = (fps: unknown): fps is number | null =>
      fps === null || (isNumber(fps) && fps >= 0 && fps <= FPS_MAX);
    const ratioOk = (ratio: unknown): ratio is number | null =>
      ratio === null || (isNumber(ratio) && ratio >= 0 && ratio <= R_HAT_MAX);
    if (!isInt(revision, 0, Number.MAX_SAFE_INTEGER)) return null;
    if (typeof build !== "string" || build.length > BUILD_MAX) return null;
    if (!isNumber(atMs) || atMs < 0) return null;
    if (!isInt(cores, 1, CORES_MAX)) return null;
    if (!fpsOk(aFps) || !fpsOk(bFps) || !fpsOk(cFps) || !ratioOk(rHat)) return null;
    if (outcome === "done") {
      if (bFps === null || bFps <= 0 || rHat === null) return null;
      if (cls !== "fast" && cls !== "ok" && cls !== "weak") return null;
    } else if (outcome === "unfinished") {
      if (bFps !== null || rHat !== null || cls !== "unfinished") return null;
    } else return null;
    return { revision, build, atMs, cores, outcome, aFps, bFps, cFps, rHat, cls };
  } catch {
    return null;
  }
}

/** Whether a record is the answer for `now`: not from another revision, build or core count, not older than `ttlMs`, not from
 *  the future. */
export function recordIsCurrent(
  record: PcCheckRecord,
  now: PcCheckNow,
  ttlMs: number = PC_CHECK_TTL_MS,
): boolean {
  if (record.revision !== now.revision || record.build !== now.build || record.cores !== now.cores)
    return false;
  const age = now.atMs - record.atMs;
  return age >= -CLOCK_SKEW_MS && age <= ttlMs;
}

/** The record of a check that could not finish: it counts as weak and is tried again later. */
export function unfinishedRecord(now: PcCheckNow): PcCheckRecord {
  return {
    revision: now.revision,
    build: now.build,
    atMs: now.atMs,
    cores: now.cores,
    outcome: "unfinished",
    aFps: null,
    bFps: null,
    cFps: null,
    rHat: null,
    cls: "unfinished",
  };
}

/** The class a record stands for under the cut-offs in force NOW, which are the server's pair (`pcClass()` of the flags reader), handed in by the caller: a pair the
 *  server moves applies to a PC that was measured earlier, without measuring again. `unfinished` for a check that did not finish, `unknown` for no record. */
export function classOfRecord(record: PcCheckRecord | null, cutoffs?: Cutoffs | null): PcClass {
  if (!record) return "unknown";
  if (record.outcome === "unfinished") return "unfinished";
  return classOf(record.rHat, cutoffs ?? undefined);
}

// The check's own store: one entry for each probe id -----------------------------------------------------------------------

/** The stored shape (the design's field names); the record's own names are the camel-cased ones. */
function toStored(record: PcCheckRecord): Record<string, unknown> {
  return {
    revision: record.revision,
    build: record.build,
    at: record.atMs,
    cores: record.cores,
    outcome: record.outcome,
    a_fps: record.aFps,
    b_fps: record.bFps,
    c_fps: record.cFps,
    r_hat: record.rHat,
    class: record.cls,
  };
}

function fromStored(entry: unknown): PcCheckRecord | null {
  if (!isObject(entry)) return null;
  return checkedRecord({
    revision: entry.revision,
    build: entry.build,
    atMs: entry.at,
    cores: entry.cores,
    outcome: entry.outcome,
    aFps: entry.a_fps,
    bFps: entry.b_fps,
    cFps: entry.c_fps,
    rHat: entry.r_hat,
    cls: entry.class,
  });
}

/** Every structurally sound entry of the store, oldest first; a damaged value, or damaged entries, are simply not there. */
function loadEntries(store: StorageLike): Map<string, Record<string, unknown>> {
  const entries = new Map<string, Record<string, unknown>>();
  try {
    const raw = store.getItem(PC_CHECK_KEY);
    if (typeof raw !== "string" || raw.length > MAX_STORED_CHARS) return entries;
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return entries;
    for (const [id, entry] of Object.entries(parsed))
      if (fromStored(entry) && isObject(entry)) entries.set(id, entry);
  } catch {
    /* a damaged store is an empty one */
  }
  return entries;
}

/** The probe's record if there is one and it is current (see {@link recordIsCurrent}); null otherwise, whatever the reason:
 *  missing, damaged, from another build or revision, older than `ttlMs` (30 days unless the probe says otherwise) or measured
 *  with a different core count. Never throws. */
export function readPcCheck(
  store: StorageLike | null,
  probeId: string,
  now: PcCheckNow,
  ttlMs: number = PC_CHECK_TTL_MS,
): PcCheckRecord | null {
  try {
    if (!store || typeof probeId !== "string" || probeId === "") return null;
    const record = fromStored(loadEntries(store).get(probeId));
    return record && recordIsCurrent(record, now, ttlMs) ? record : null;
  } catch {
    return null;
  }
}

/** Keeps the probe's record (replacing its earlier one, leaving every other probe's alone); a record that is not a well-formed
 *  one is not written. The store holds at most 16 probes. Never throws. */
export function writePcCheck(
  store: StorageLike | null,
  probeId: string,
  record: PcCheckRecord,
): void {
  try {
    if (!store || typeof probeId !== "string" || probeId === "" || probeId.length > ID_MAX) return;
    const checked = checkedRecord(record);
    if (!checked) return;
    const entries = loadEntries(store);
    entries.delete(probeId);
    entries.set(probeId, toStored(checked));
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
    store.setItem(PC_CHECK_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* the check is simply made again */
  }
}
