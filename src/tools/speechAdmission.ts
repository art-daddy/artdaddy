// A whole-file speech run that nobody asked for, on a PC that may be slow (S2-02): the one admission
// every such start goes through, the typed deferral it answers with, and what this session remembers
// about files it must not start again by itself. The decision is `speechPlan.ts`'s (pure); the facts it
// is fed are this PC's own (`speechPace.ts`, `speechBackend.ts`); this module only gathers them, keeps
// the decision in the local plan log, and says "not started" in a way the callers cannot mistake for a
// failure. With the switch `speech_cpu_cap` off nothing here decides anything: it is 0.27.0.
import { exportFlag } from "../api/exportFlags";
import { ArtDaddyError } from "../lib/errors";
import { hostInfo } from "../platform/host";
import { cpuOnlyNow } from "./speechBackend";
import { backendNow, paceBook, readPace, type SpeechBackend } from "./speechPace";
import { CAP_S, planWholeFile, type PlanWhy } from "./speechPlan";
import { recordPlan, type PlanRecord } from "./speechPlanLog";

/** What the planner said about one whole file, and what it was said about. */
export interface Admission {
  plan: "whole" | "ondemand";
  why: PlanWhy;
  /** About how long the whole file takes on the backend that would run it; null when its length is not known. */
  projectedS: number | null;
  backend: SpeechBackend;
  held: boolean;
  capS: number;
}

/** A whole-file run was not started, or was stopped once it ran, because this PC would take longer than
 *  the cap for it: the parts a request uses are transcribed when asked for instead. It is a deferral,
 *  never a failure: nothing is counted against the file or the engine, and nothing is reported. */
export class SpeechDeferredError extends ArtDaddyError {
  readonly code = "speech_deferred";
  readonly expected: boolean;
  /** True when the run had started and the live check stopped it (its time left passed twice the cap). */
  readonly stopped: boolean;
  constructor(
    readonly admission: Pick<Admission, "why" | "projectedS" | "capS">,
    options: { stopped?: boolean } = {},
  ) {
    super(deferredText(admission.projectedS, options.stopped === true));
    this.name = "SpeechDeferredError";
    this.expected = true;
    this.stopped = options.stopped === true;
  }
}

function deferredText(projectedS: number | null, stopped: boolean): string {
  const took =
    projectedS === null ? "too long" : `about ${Math.max(1, Math.round(projectedS / 60))} min`;
  return stopped
    ? `This file's transcription was stopped: on this PC it would take ${took}, so only the parts that are asked for are transcribed.`
    : `This file is not transcribed whole in the background: on this PC it would take ${took}, so only the parts that are asked for are transcribed.`;
}

/** Duck-typed on purpose, as `isSpeechEngineUnavailable` is: a module loaded twice (a page that
 *  reloaded its modules) must still be recognised. */
export function isSpeechDeferred(e: unknown): e is SpeechDeferredError {
  return (
    typeof e === "object" && e !== null && (e as { code?: unknown }).code === "speech_deferred"
  );
}

/** The planner's answer for ONE whole file that the background would start by itself, on this PC's own
 *  facts, written to the plan log. Null when the switch `speech_cpu_cap` is off (nothing is planned:
 *  0.27.0). Synchronous, so no caller waits on it, and it never throws: whatever cannot be read is a run,
 *  as it was before there was a planner. A graphics-chip run is never left out for its length; a length
 *  that is not known (null, or not a positive number) is a run too, on the processor as well: an unknown
 *  length is never a reason to leave a file untranscribed. */
export function admitWholeFile(input: {
  file: string;
  where: PlanRecord["where"];
  audioS: number | null;
  now?: number;
  /** A second look at a run the first already let through, where it can still be left undone (the audio read,
   *  the model installed): only a change, a deferral, is written to the plan log. */
  recheck?: boolean;
}): Admission | null {
  try {
    if (!exportFlag("speech_cpu_cap")) return null;
    const samples = readPace();
    const os = hostInfo().os;
    const held = cpuOnlyNow();
    const backend = backendNow(samples, os, held);
    const onChip = !held && backend === "gpu";
    const known =
      typeof input.audioS === "number" && Number.isFinite(input.audioS) && input.audioS > 0
        ? input.audioS
        : null;
    let admission: Admission = {
      plan: "whole",
      why: onChip ? "ok" : held ? "gpu_held" : "cpu_only",
      projectedS: null,
      backend,
      held,
      capS: CAP_S,
    };
    if (known !== null) {
      const decided = planWholeFile({ backend, held, audioS: known, pace: paceBook(samples, os) });
      admission = {
        ...admission,
        plan: decided.plan,
        why: decided.why,
        projectedS: decided.projectedS,
      };
    }
    if (!input.recheck || admission.plan === "ondemand")
      recordPlan({
        at: input.now ?? Date.now(),
        file: input.file,
        plan: admission.plan,
        why: admission.why,
        projectedS: admission.projectedS,
        backend,
        held,
        where: input.where,
      });
    return admission;
  } catch {
    return null;
  }
}

/** A fingerprint of everything the admission reads: while it is unchanged, planning a file held back for
 *  the cap again could only give the same answer, so it is not asked again. A lapsed hold on the graphics
 *  chip, a pace this PC measured since, or the switch turned off each change it. */
export function admissionSignature(): string {
  try {
    const samples = readPace();
    const os = hostInfo().os;
    const held = cpuOnlyNow();
    const book = paceBook(samples, os);
    return JSON.stringify([
      exportFlag("speech_cpu_cap"),
      held,
      backendNow(samples, os, held),
      book.cpu.startupS,
      book.cpu.rate,
      book.gpu.startupS,
      book.gpu.rate,
    ]);
  } catch {
    return "unreadable";
  }
}

/** A key for what the indexer holds back for this session: a file it must not start again by itself. */
const MEMORY_KEEP = 5000;
const cancelledByPerson = new Set<string>();
const onDemandThisSession = new Set<string>();

/** How long each file's audio is, as the indexer measured it (it sizes its batches by it): the one source
 *  of a length for the boundary of `runWhisper`, which never probes a file itself. Newest last. */
const LENGTHS_KEEP = 500;
const lengths = new Map<string, number>();

/** The indexer measured `path`: `seconds` of audio, or null when it could not be told. */
export function noteAudioLength(path: string, seconds: number | null): void {
  lengths.delete(path);
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return;
  lengths.set(path, seconds);
  while (lengths.size > LENGTHS_KEEP) {
    const oldest = lengths.keys().next();
    if (oldest.done) break;
    lengths.delete(oldest.value);
  }
}

/** What the indexer measured for `path`, or null. */
export function knownAudioLength(path: string): number | null {
  return lengths.get(path) ?? null;
}

function remember(set: Set<string>, key: string): void {
  set.delete(key);
  set.add(key);
  while (set.size > MEMORY_KEEP) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}

/** The person pressed Cancel on this file's whole-file run: the indexer does not start it again by itself
 *  this session. A request for a part of it (the assistant, captions) still transcribes that part. */
export function markCancelledByPerson(key: string): void {
  remember(cancelledByPerson, key);
}
export function wasCancelledByPerson(key: string): boolean {
  return cancelledByPerson.has(key);
}

/** The same fact told from the engine's side (F7): a whole-file run ended as the person's Cancel, whoever asked
 *  for it (the indexer, or a look over a whole short file). Keyed by the engine's own cache key for the file,
 *  language and model (its identity, never the path a project knows it by), so the background's run of the
 *  same file is recognised and left alone wherever its queue holds it under another name. Both kinds of key
 *  are in one set: they cannot be mistaken for one another. */
export function markRunCancelledByPerson(key: string | null): void {
  if (key) remember(cancelledByPerson, key);
}
export function wasRunCancelledByPerson(key: string | null): boolean {
  return key !== null && cancelledByPerson.has(key);
}

/** The live check stopped this file's whole-file run for being too slow: it falls back to the parts a request
 *  uses for the rest of the session, and the indexer does not start it again. */
export function markOnDemandThisSession(key: string): void {
  remember(onDemandThisSession, key);
}
export function isOnDemandThisSession(key: string): boolean {
  return onDemandThisSession.has(key);
}

/** Tests only. */
export function __resetSpeechSession(): void {
  cancelledByPerson.clear();
  onDemandThisSession.clear();
  lengths.clear();
}
