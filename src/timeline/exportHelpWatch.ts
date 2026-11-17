// The slow banner's state for each running export, kept beside the queue's watch. The pure view-model (exportHelp.ts) says what to show for the facts it is handed; this keeps what the person has already answered, hands it
// the facts at every tick of the watch, and lets the card, the Export dialog and the assistant's export list read one state.
//
// All of it is advice: a throw, a number that is not a number or a facts record that cannot be read never reaches the export, and the remote switch is read at every look, so turning it off takes the banner away
// at once and turning it on brings it back.
import { exportFlag } from "../api/exportFlags";
import type { ExportReasonCode } from "../api/exportReason";
import { quietVerdict } from "./exportActivity";
import { noteFact3c } from "./exportFacts3c";
import {
  exportHelp,
  MAX_SLOW_BANNERS,
  type FirstPicture,
  type HelpInput,
  type HelpView,
} from "./exportHelp";
import { producedFraction } from "./exportRestart";
import type { EstimateBasis } from "./exportTypes3c";
import { timeLeftSeconds, type LiveFacts } from "./exportWords";
import { describeLower } from "./lowerWords";
import { quickAvailable } from "./quickAvailable";
import {
  ASSISTANT_SLOW_NOTE,
  ASSISTANT_SLOW_NOTE_NO_QUICK,
  KEEP_GOING_ENDED,
  KEEP_GOING_FINISHING,
} from "./routeWords";

/** What the queue knows about the export's record that the banner reads: the estimate it was admitted with, in either of the two forms the record has. */
export interface HelpRecordFacts {
  readonly expected?: { readonly seconds: number; readonly guessed?: boolean };
  readonly estimate?: { readonly seconds: number; readonly basis: EstimateBasis };
  /** The export has a way to be started again (a whole-timeline export of this session): the only kind that can be switched. */
  readonly canRetry?: boolean;
}

/** What one tick of the watch hands over. */
export interface HelpTickFacts {
  readonly record: HelpRecordFacts | undefined;
  /** The export's live feed (its stage, its share done, its own time left, when it last moved, what its processors do). */
  readonly feed: LiveFacts | null;
  /** Quick's estimate for this export, in seconds. The route side gives it; until that is merged the queue gives none. */
  readonly quickSeconds?: number | null;
}

export interface HelpState {
  /** What the person is shown now. */
  readonly view: HelpView;
  /** The person said keep going and no banner is on screen: one quiet line says so. */
  readonly keptGoing: boolean;
  /** Another slow banner can still come for this export (the limit of two is not spent): what the quiet line may promise. */
  readonly mayWarnAgain: boolean;
  /** The export is slower than said right now, whether or not the banner is on screen (the person may have silenced it): what the assistant is told. */
  readonly slow: HelpView | null;
}

export type KeepGoingKind = "slow" | "quiet";
/** Where the export is at the moment of the click: rendering, past its render (being checked or saved), or ended (or not there). */
export type RunPhase = "rendering" | "finishing" | "ended";
export type KeepGoingResult = { ok: true } | { ok: false; line: string };

type Shown = HelpInput["shown"];
const NOTHING_SHOWN: Shown = Object.freeze({
  slowShown: 0,
  silencedAtProjection: null,
  quietShown: false,
});

interface Entry {
  input: Omit<HelpInput, "shown" | "flagOn">;
  shown: Shown;
  /** The person pressed Keep going on a banner that was up. */
  answered: boolean;
  noted: { slow: boolean; quiet: boolean };
  signature: string;
  cache: { flag: boolean; state: HelpState } | null;
  picture: PictureWatch;
}

/** What the watch has seen of the run's first picture. It counts only where it saw the picture ARRIVE, a look that found none and a later one that found one, so the time it
 *  keeps is the picture's and not the watch's own late start. Where a look already finds a picture (the watch came late, or the picture was quick) it keeps nothing, and the
 *  banner counts from the export's start, as it did before this record. */
interface PictureWatch {
  /** The export's start (ms) this record belongs to: another start is another run. */
  startedAt: number;
  /** A look has found no picture yet. */
  waiting: boolean;
  /** The first look that found a picture after that: when (ms), and the share of the project produced. */
  first: { atMs: number; produced: number } | null;
}

const newPictureWatch = (): PictureWatch => ({
  startedAt: Number.NaN,
  waiting: false,
  first: null,
});

/** Takes one look at the run into the record. A look at a run that is not preparing or rendering is not a look at the picture, and a share that cannot be read is none. A first look that
 *  already finds a picture records nothing; a run that starts again under the same job, or a share that falls back, is looked at afresh, from this look on. */
function notePicture(
  watch: PictureWatch,
  startedAt: number,
  counting: boolean,
  produced: number,
  nowMs: number,
): void {
  if (!counting || !Number.isFinite(startedAt) || !Number.isFinite(nowMs)) return;
  if (watch.startedAt !== startedAt) {
    const looked = !Number.isNaN(watch.startedAt);
    watch.startedAt = startedAt;
    watch.first = null;
    watch.waiting = looked;
  } else if (watch.first !== null && produced < watch.first.produced) {
    watch.first = null;
    watch.waiting = true;
  }
  if (!(produced > 0)) {
    watch.first = null;
    watch.waiting = true;
  } else if (watch.first === null && watch.waiting) {
    watch.first = { atMs: nowMs, produced };
    watch.waiting = false;
  }
}

function firstPictureOf(watch: PictureWatch, startedAt: number): FirstPicture | null {
  return watch.first
    ? { atSeconds: (watch.first.atMs - startedAt) / 1000, produced: watch.first.produced }
    : null;
}

/** Exports watched at once are one or two; the bound only keeps a watch that never ended from growing the map. */
const MAX_ENTRIES = 50;
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

const flagOn = (): boolean => {
  try {
    return exportFlag("export_help") === true;
  } catch {
    return false;
  }
};

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // one listener that fails does not stop the others
    }
  }
}

export function subscribeHelp3c(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function expectationOf(record: HelpRecordFacts | undefined): {
  seconds: number | null;
  basis: EstimateBasis | null;
} {
  const estimate = record?.estimate;
  if (estimate && typeof estimate.seconds === "number")
    return { seconds: estimate.seconds, basis: estimate.basis };
  const expected = record?.expected;
  if (expected && typeof expected.seconds === "number")
    return { seconds: expected.seconds, basis: expected.guessed === true ? "guess" : "history" };
  return { seconds: null, basis: null };
}

function inputOf(facts: HelpTickFacts, nowMs: number): Entry["input"] | null {
  const feed = facts.feed;
  if (!feed) return null;
  const rendering = feed.stage === "preparing" || feed.stage === "rendering";
  const { verdict, quiet_for_s } = quietVerdict(feed, nowMs);
  // A streamed or sequence export's own time left is not a time left for the whole: its projection comes from the share of the project produced.
  const manySteps = typeof feed.steps === "number" && feed.steps > 1;
  const { seconds, basis } = expectationOf(facts.record);
  return {
    elapsedSeconds: (nowMs - feed.startedAt) / 1000,
    producedFraction: rendering ? producedFraction(feed) : 1,
    renderEtaSeconds: rendering && !manySteps ? timeLeftSeconds(feed, nowMs) : null,
    expectedSeconds: seconds,
    expectedBasis: basis,
    quickSeconds: typeof facts.quickSeconds === "number" ? facts.quickSeconds : null,
    quietSeconds: rendering ? quiet_for_s : 0,
    verdict,
    canSwitch: rendering && facts.record?.canRetry === true && quickAvailable(),
  };
}

/** The state for the switch as it is now. Cached by the switch's value so that a look that finds nothing changed gets the very same object. */
function stateOf(entry: Entry, flag: boolean): HelpState {
  if (entry.cache && entry.cache.flag === flag) return entry.cache.state;
  const input = { ...entry.input, flagOn: flag };
  const view = exportHelp({ ...input, shown: entry.shown });
  const open = exportHelp({ ...input, shown: NOTHING_SHOWN });
  const state: HelpState = {
    view,
    keptGoing: flag && entry.answered && view.kind === "none",
    mayWarnAgain: entry.shown.slowShown < MAX_SLOW_BANNERS,
    slow: open.kind === "slow" ? open : null,
  };
  entry.cache = { flag, state };
  return state;
}

const signatureOf = (state: HelpState): string =>
  JSON.stringify([
    state.view.kind,
    state.view.lines,
    state.view.buttons,
    // the quiet line has two wordings: one that promises a further banner and one that does not
    state.keptGoing && !state.mayWarnAgain ? "last" : state.keptGoing,
    state.slow
      ? [state.slow.projectedTotalSeconds, state.slow.quickAvailable, state.slow.quickSeconds]
      : null,
  ]);
/** What nothing on screen looks like: an export that has nothing to show does not tell anyone anything. */
const NOTHING_ON_SCREEN = JSON.stringify(["none", [], [], false, null]);

/** What changed on screen since the last look: said to whoever watches, and noted locally the first time each kind of banner is up. */
function settle(jobId: string, entry: Entry): void {
  const state = stateOf(entry, flagOn());
  if (state.view.kind === "slow" && !entry.noted.slow) {
    entry.noted.slow = true;
    noteFact3c(jobId, { help_shown: ["slow"] });
  }
  if (state.view.kind === "quiet" && !entry.noted.quiet) {
    entry.noted.quiet = true;
    noteFact3c(jobId, { help_shown: ["quiet"] });
  }
  const signature = signatureOf(state);
  if (signature === entry.signature) return;
  entry.signature = signature;
  notify();
}

/** One tick of the queue's watch on a running export. Never throws: a banner that cannot be worked out is no banner. */
export function noteHelpTick3c(
  jobId: string,
  facts: HelpTickFacts,
  nowMs: number = Date.now(),
): void {
  try {
    if (typeof jobId !== "string" || jobId === "") return;
    const feed = facts.feed;
    const input = inputOf(facts, nowMs);
    if (!input || !feed) return;
    const entry: Entry = entries.get(jobId) ?? {
      input,
      shown: NOTHING_SHOWN,
      answered: false,
      noted: { slow: false, quiet: false },
      signature: NOTHING_ON_SCREEN,
      cache: null,
      picture: newPictureWatch(),
    };
    notePicture(
      entry.picture,
      feed.startedAt,
      feed.stage === "preparing" || feed.stage === "rendering",
      input.producedFraction,
      nowMs,
    );
    entry.input = { ...input, firstPicture: firstPictureOf(entry.picture, feed.startedAt) };
    entry.cache = null;
    entries.set(jobId, entry);
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
    settle(jobId, entry);
  } catch {
    // advice is never worth disturbing an export over
  }
}

/** What the card, the dialog and the assistant read for the export: null when the watch has nothing about it (it has ended, or never began). */
export function helpOf3c(jobId: string): HelpState | null {
  try {
    const entry = entries.get(jobId);
    return entry ? stateOf(entry, flagOn()) : null;
  } catch {
    return null;
  }
}

/** The person pressed Keep going on the banner `kind`. The caller says where the export is at this moment, read where the click lands: once the render is over there is nothing to keep going and the click is
 *  refused with a line, leaving no state behind. A press on a banner that has gone by itself (or a second press on one already answered) is answered with nothing and counts for nothing. */
export function keepGoing3c(jobId: string, kind: KeepGoingKind, phase: RunPhase): KeepGoingResult {
  try {
    if (phase === "ended") return { ok: false, line: KEEP_GOING_ENDED };
    if (phase === "finishing") return { ok: false, line: KEEP_GOING_FINISHING };
    const entry = entries.get(jobId);
    if (!entry) return { ok: true };
    const state = stateOf(entry, flagOn());
    if (state.view.kind !== kind) return { ok: true };
    entry.shown =
      kind === "slow"
        ? {
            ...entry.shown,
            slowShown: entry.shown.slowShown + 1,
            silencedAtProjection: state.view.projectedTotalSeconds,
          }
        : { ...entry.shown, quietShown: true };
    entry.answered = true;
    entry.cache = null;
    settle(jobId, entry);
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/** The render has ended (however it ended): the export's banner state goes with it. */
export function endHelp3c(jobId: string): void {
  try {
    if (entries.delete(jobId)) notify();
  } catch {
    // nothing to forget
  }
}

/** What the assistant's export list says about a running export that is slower than said: the two facts, and what to do about it. Null when it is not slower than said. */
export function helpRowOf3c(
  jobId: string,
): { fields: Record<string, unknown>; note: string } | null {
  try {
    const entry = entries.get(jobId);
    if (!entry) return null;
    const { slow } = stateOf(entry, flagOn());
    if (!slow) return null;
    const quick = quickAvailable();
    return {
      fields: {
        slower_than_expected: true,
        ...(Number.isFinite(slow.projectedTotalSeconds)
          ? { projected_total_s: slow.projectedTotalSeconds }
          : {}),
        ...(quick && slow.quickAvailable
          ? {
              quick_available: true,
              ...(slow.quickSeconds !== null ? { quick_expected_s: slow.quickSeconds } : {}),
            }
          : {}),
      },
      note: quick ? ASSISTANT_SLOW_NOTE : ASSISTANT_SLOW_NOTE_NO_QUICK,
    };
  } catch {
    return null;
  }
}

/** The sentence of what to lower for a failure, or "" (the switch is off, or there is nothing true to say). */
export function lowerAdvice3c(code: ExportReasonCode, chipFailed: boolean = false): string {
  try {
    return flagOn() ? describeLower({ code, chipFailed, quick: quickAvailable() }) : "";
  } catch {
    return "";
  }
}

/** 0.27.0's sentence with the advice after it where there is some, and exactly as it was where there is none. */
export function withLowerAdvice3c(
  text: string,
  code: ExportReasonCode,
  chipFailed: boolean = false,
): string {
  const base = typeof text === "string" ? text : "";
  const advice = lowerAdvice3c(code, chipFailed);
  return advice ? (base ? `${base} ${advice}` : advice) : base;
}

/** Tests only. */
export function __resetHelp3c(): void {
  entries.clear();
  listeners.clear();
}
