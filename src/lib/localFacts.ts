// A small record, kept ON THIS PC, of closed words and bounded numbers about the speech model's
// download and about waiting for speech. It is NEVER SENT anywhere. A later release may send it, but
// only after the owner has approved a privacy text that names it; until then nothing may, and
// localFactsNeverSent.test.ts fails if anything that talks to a server reaches for it.
//
// What goes in is REBUILT from known fields, never copied: a word outside its closed list drops its
// field (or the whole fact, when it is the event), a number is clamped into its bounds, and nothing
// else the caller held (a path, an error text, a name) can reach storage. What comes out is checked
// again the same way, because the stored text is only text and anything can have edited it.
import { isModelFailureKind, type ModelFailureKind } from "../tools/modelFailure";

export const FACTS_KEY = "artdaddy.local_facts.v1";
/** The newest facts kept, per stream. */
export const FACT_RING = 40;

export const MODEL_FACT_EVENTS = [
  "download_started",
  "download_finished",
  "download_failed",
  "download_cancelled",
] as const;
export const MODEL_FACT_SOURCES = ["primary", "extra_1", "extra_2", "extra_3"] as const;
export const WAKE_FACT_EVENTS = [
  "registered",
  "landed",
  "released",
  "woke",
  "held_typing",
  "skipped_fetched",
  "capped",
  "no_credits",
  "expired",
  "dropped",
  "flag_off",
] as const;
export const WAKE_FILE_BANDS = ["1", "2_4", "5_9", "10_plus"] as const;

export interface ModelFact {
  event: (typeof MODEL_FACT_EVENTS)[number];
  source?: (typeof MODEL_FACT_SOURCES)[number];
  attempts?: number;
  seconds?: number;
  bytes?: number;
  reason?: ModelFailureKind;
  at: number;
}

export interface WakeFact {
  event: (typeof WAKE_FACT_EVENTS)[number];
  files?: (typeof WAKE_FILE_BANDS)[number];
  at: number;
}

export type FactStream = "model_download" | "speech_wake";

type Store = Pick<Storage, "getItem" | "setItem">;

const MAX_ATTEMPTS = 12;
const MAX_SECONDS = 86_400;
const MAX_BYTES = 2_147_483_647;

interface Facts {
  model_download: ModelFact[];
  speech_wake: WakeFact[];
}

const noFacts = (): Facts => ({ model_download: [], speech_wake: [] });

function browserStorage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A property of `from` itself. One it merely inherits (a polluted prototype, an object made from
 *  another) is not something the caller put there. */
const own = (from: object, key: string): unknown =>
  Object.hasOwn(from, key) ? (from as Record<string, unknown>)[key] : undefined;

function word<T extends string>(list: readonly T[], value: unknown): T | undefined {
  return list.find((listed) => listed === value);
}

/** A whole number inside the bounds, or undefined when it is not a finite number at all. */
function bounded(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function cleanModelFact(raw: unknown): ModelFact | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = word(MODEL_FACT_EVENTS, own(raw, "event"));
  const at = finite(own(raw, "at"));
  if (event === undefined || at === undefined) return null;
  const source = word(MODEL_FACT_SOURCES, own(raw, "source"));
  const attempts = bounded(own(raw, "attempts"), 1, MAX_ATTEMPTS);
  const seconds = bounded(own(raw, "seconds"), 0, MAX_SECONDS);
  const bytes = bounded(own(raw, "bytes"), 0, MAX_BYTES);
  const reason = own(raw, "reason");
  // Built from literals, never by assignment: an assignment is refused when a prototype carries a
  // read-only property of the same name, and a literal defines its own property regardless.
  return {
    event,
    ...(source !== undefined && { source }),
    ...(attempts !== undefined && { attempts }),
    ...(seconds !== undefined && { seconds }),
    ...(bytes !== undefined && { bytes }),
    ...(isModelFailureKind(reason) && { reason }),
    at,
  };
}

function cleanWakeFact(raw: unknown): WakeFact | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = word(WAKE_FACT_EVENTS, own(raw, "event"));
  const at = finite(own(raw, "at"));
  if (event === undefined || at === undefined) return null;
  const files = word(WAKE_FILE_BANDS, own(raw, "files"));
  return { event, ...(files !== undefined && { files }), at };
}

/** The facts of one stream in a parsed record: each one cleaned, the unusable skipped, the newest
 *  FACT_RING kept. */
function newest<T>(list: unknown, clean: (raw: unknown) => T | null): T[] {
  if (!Array.isArray(list)) return [];
  const kept: T[] = [];
  for (const raw of list) {
    const fact = clean(raw);
    if (fact !== null) kept.push(fact);
  }
  return kept.slice(-FACT_RING);
}

/** What the storage holds, cleaned. Text that is missing, is not JSON or has the wrong shape reads as
 *  no facts. A storage that THROWS is different: that throw is left for the caller, so that nothing
 *  is written over what could not be read. */
function readFactBook(storage: Store): Facts {
  const text: unknown = storage.getItem(FACTS_KEY);
  if (typeof text !== "string") return noFacts();
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return noFacts();
  }
  if (typeof root !== "object" || root === null) return noFacts();
  return {
    model_download: newest(own(root, "model_download"), cleanModelFact),
    speech_wake: newest(own(root, "speech_wake"), cleanWakeFact),
  };
}

/** Keep a fact on this PC. Never throws: where nothing can be stored, or the fact is not one, nothing
 *  is kept. */
export function recordFact(stream: "model_download", fact: ModelFact, storage?: Store | null): void;
export function recordFact(stream: "speech_wake", fact: WakeFact, storage?: Store | null): void;
export function recordFact(
  stream: FactStream,
  fact: ModelFact | WakeFact,
  storage: Store | null = browserStorage(),
): void {
  try {
    if (!storage) return;
    const model = stream === "model_download" ? cleanModelFact(fact) : null;
    const wake = stream === "speech_wake" ? cleanWakeFact(fact) : null;
    if (!model && !wake) return;
    const facts = readFactBook(storage);
    if (model) facts.model_download = [...facts.model_download, model].slice(-FACT_RING);
    if (wake) facts.speech_wake = [...facts.speech_wake, wake].slice(-FACT_RING);
    storage.setItem(FACTS_KEY, JSON.stringify(facts));
  } catch {
    /* a full, blocked or missing store only costs this fact */
  }
}

/** The facts kept for a stream, oldest first, each one valid. Never throws. */
export function readFacts(stream: "model_download", storage?: Store | null): readonly ModelFact[];
export function readFacts(stream: "speech_wake", storage?: Store | null): readonly WakeFact[];
export function readFacts(
  stream: FactStream,
  storage: Store | null = browserStorage(),
): readonly (ModelFact | WakeFact)[] {
  try {
    if (!storage) return [];
    const facts = readFactBook(storage);
    if (stream === "model_download") return facts.model_download;
    if (stream === "speech_wake") return facts.speech_wake;
    return [];
  } catch {
    return [];
  }
}

/** How many files a wake covered, as a band, so the record never holds the count itself. Anything
 *  that is not a positive number is the first band. */
export function fileBand(files: number): (typeof WAKE_FILE_BANDS)[number] {
  if (typeof files !== "number" || !(files >= 2)) return "1";
  if (files < 5) return "2_4";
  if (files < 10) return "5_9";
  return "10_plus";
}

/** Forget every fact. Never throws. */
export function clearFacts(storage: Store | null = browserStorage()): void {
  try {
    storage?.setItem(FACTS_KEY, JSON.stringify(noFacts()));
  } catch {
    /* nothing to clear where nothing can be written */
  }
}
