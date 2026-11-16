// How the speech engine decodes, and which languages may use the faster setting.
//
// whisper-cli's own default is a beam search of 5: it keeps five readings of each stretch of
// speech and picks the best. Greedy decoding (a beam of 1) keeps the first one and runs about 1.5 to
// 1.8 times faster, and it costs accuracy in some languages and not in others. Which ones is not a
// guess: speechGate.json holds the accuracy gate's own measurements (a public test set per language,
// the error rate of each setting against today's with an interval around the difference) and this
// reads it. A language the gate cleared for a setting decodes with it. Every other language, and any
// language not known yet, keeps the engine's default, with exactly the arguments it always had.
//
// A setting records the path it was measured on (one that names none is a graphics-chip measurement), because
// the two paths give different results for one file. beamFor and greedyTable read the chip's only; the
// processor's are read through clearedOn, by speechModel.ts, which chooses the file a processor-only PC uses.
//
// Without a named language the language is only known AFTER the engine has run. So the first run
// PREDICTS it from what this machine last detected, and the result is CHECKED: a setting narrower
// than the one the detected language needs is never kept. finishWhisper refuses it and runWhisper
// runs again at the width that language needs.
import evidence from "./speechGate.json";
import type { SpeechBackend } from "./speechPace";
import { whisperCode } from "./whisperLanguages";

/** The engine's own default beam, and so every transcript made before this existed. */
export const DEFAULT_BEAM = 5;
export const GREEDY_BEAM = 1;

/** The model files the gate measured. They differ in accuracy, so the gate is per variant. */
export type ModelVariant = "f16" | "q8_0" | "q5_1";
const VARIANTS: readonly ModelVariant[] = ["f16", "q8_0", "q5_1"];
const isVariant = (v: unknown): v is ModelVariant => VARIANTS.includes(v as ModelVariant);

/** A setting is cleared for a language when it is at most this many points of error worse than
 *  today's, with an interval that rules out a loss of more than the second figure (twice the
 *  first). Two points is the owner's tolerance; it was one before 2026-11-02. */
export const MAX_POINT_LOSS = 2.0;
export const MAX_LOSS_UPPER = 4.0;

export interface GateResult {
  diff_points: number;
  ci_high: number;
}
export interface GateRow {
  set: string;
  language: string;
  results: Readonly<Record<string, GateResult>>;
}
export interface GateSetting {
  variant: string;
  beam: number;
  flags: readonly string[];
  /** The engine path the setting was measured on. Absent means the graphics chip, which is what every setting was
   *  before the processor was measured. The two paths give different results for one file (Dutch and Arabic cross
   *  the line on one and not the other), so a chip measurement is never read for a processor launch, nor the
   *  other way round. */
  backend?: SpeechBackend;
}
export interface GateEvidence {
  settings: Readonly<Record<string, GateSetting>>;
  rows: readonly GateRow[];
}

/** One result against the rule. Anything that is not a clear pass is not one. */
export function clears(result: GateResult | undefined): boolean {
  return (
    result !== undefined &&
    Number.isFinite(result.diff_points) &&
    Number.isFinite(result.ci_high) &&
    result.diff_points <= MAX_POINT_LOSS &&
    result.ci_high <= MAX_LOSS_UPPER
  );
}

/** The languages for which EVERY test set cleared `settingId`. A language measured on two kinds of
 *  speech must pass on both, and a language with no measurement is not cleared. */
export function clearedLanguages(rows: readonly GateRow[], settingId: string): ReadonlySet<string> {
  const allClear = new Map<string, boolean>();
  for (const row of rows) {
    allClear.set(
      row.language,
      (allClear.get(row.language) ?? true) && clears(row.results[settingId]),
    );
  }
  return new Set([...allClear].filter(([, ok]) => ok).map(([language]) => language));
}

/** The path a setting was measured on: the chip unless it says the processor. A setting that names any other path
 *  is on none, so it clears nothing anywhere. What the file holds is read as it is, not as the type says. */
export function measuredOn(setting: { readonly backend?: unknown }): SpeechBackend | null {
  const where = setting.backend;
  return where === undefined || where === "gpu" ? "gpu" : where === "cpu" ? "cpu" : null;
}

/** For each model variant, the languages greedy decoding is cleared for on the graphics chip, which is what
 *  {@link beamFor} reads. A setting measured on the processor is not read here: see {@link clearedOn}. */
export function greedyTable(ev: GateEvidence): ReadonlyMap<ModelVariant, ReadonlySet<string>> {
  const table = new Map<ModelVariant, ReadonlySet<string>>();
  for (const [id, setting] of Object.entries(ev.settings)) {
    const onChip = measuredOn(setting) === "gpu";
    if (onChip && setting.beam === GREEDY_BEAM && isVariant(setting.variant))
      table.set(setting.variant, clearedLanguages(ev.rows, id));
  }
  return table;
}

/** For each model variant and beam width, the languages the gate cleared on `backend`'s own measurements. What was
 *  measured on the other path says nothing here. When two settings measure one variant and width on one path, a
 *  language is cleared only if both clear it. */
export function clearedOn(
  ev: GateEvidence,
  backend: SpeechBackend,
): ReadonlyMap<ModelVariant, ReadonlyMap<number, ReadonlySet<string>>> {
  const table = new Map<ModelVariant, Map<number, ReadonlySet<string>>>();
  for (const [id, setting] of Object.entries(ev.settings)) {
    if (measuredOn(setting) !== backend || !isVariant(setting.variant)) continue;
    const byBeam = table.get(setting.variant) ?? new Map<number, ReadonlySet<string>>();
    const cleared = clearedLanguages(ev.rows, id);
    const before = byBeam.get(setting.beam);
    byBeam.set(setting.beam, before ? new Set([...before].filter((l) => cleared.has(l))) : cleared);
    table.set(setting.variant, byBeam);
  }
  return table;
}

/** The gate's evidence as the app ships it. */
export const SHIPPED_EVIDENCE: GateEvidence = evidence as GateEvidence;

const GREEDY = greedyTable(SHIPPED_EVIDENCE);

/** The beam this language decodes with on this model file: greedy where the gate cleared it, the
 *  engine's default everywhere else (and for any language it cannot name). */
export function beamFor(variant: ModelVariant, language: string): number {
  const code = whisperCode(language);
  return code && GREEDY.get(variant)?.has(code) ? GREEDY_BEAM : DEFAULT_BEAM;
}

/** The engine arguments for a beam. The default adds none, so a language that is not cleared is
 *  given the very arguments it always had. Anything that is not a beam of at least 1 is the
 *  default, never the narrowest setting. */
export function decodeArgs(beam: number): string[] {
  const whole = Math.trunc(beam);
  const width =
    Number.isFinite(whole) && whole >= GREEDY_BEAM ? Math.min(whole, DEFAULT_BEAM) : DEFAULT_BEAM;
  return width === DEFAULT_BEAM ? [] : ["-bs", String(width), "-bo", String(width)];
}

export interface DecodePlan {
  beam: number;
  /** The language the beam was chosen for, or null when nothing was known. */
  predicted: string | null;
}

/** What to decode with BEFORE the run. A named language is known; "auto" is predicted from the last
 *  language this machine detected; with neither, the default. */
export function planDecode(
  variant: ModelVariant,
  requested: string,
  last: string | null,
): DecodePlan {
  const predicted = whisperCode(requested) || last;
  return { beam: predicted ? beamFor(variant, predicted) : DEFAULT_BEAM, predicted };
}

/** Whether a run at `used` may be kept, given the language it turned out to be in. A wider beam
 *  than needed is always fine; an unknown language needs the default. */
export function acceptableBeam(used: number, variant: ModelVariant, detected: string): boolean {
  return used >= beamFor(variant, detected);
}

/** A transcript was made with a narrower beam than its language needs. It is never kept. */
export class WeakDecodeError extends Error {
  constructor(
    readonly detected: string,
    readonly used: number,
  ) {
    super(`decoded with a beam of ${used}, narrower than "${detected}" needs`);
    this.name = "WeakDecodeError";
  }
}

const LAST_KEY = "artdaddy.speech_language";
/** Where the last detected language is kept; exported so a test can put something odd there. */
export const SPEECH_LANGUAGE_KEY = LAST_KEY;

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The language this machine last detected, or null. Only a language the engine knows is believed:
 *  whatever else is stored is no history, never an error. */
export function lastSpeechLanguage(storage: Store | null = browserStorage()): string | null {
  try {
    return whisperCode(storage?.getItem(LAST_KEY) ?? "") || null;
  } catch {
    return null;
  }
}

/** Remember the language a run detected. Never throws: where nothing can be stored the next run
 *  simply starts from the default. */
export function rememberSpeechLanguage(
  language: string,
  storage: Store | null = browserStorage(),
): void {
  const code = whisperCode(language);
  if (!code) return;
  try {
    storage?.setItem(LAST_KEY, code);
  } catch {
    /* a full or blocked store only costs the next run its prediction */
  }
}
