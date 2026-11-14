// What a slow speech job says, and why it can say it (S2-09, ALIGNMENT 5.1): "Slow: this will take a
// while because {reason}. {advice}", each reason only from a fact the app already holds (the speech
// store's `SpeechFacts`). Pure: no clock, no store. The sentences are the ones the owner saw in the
// mockup pictures, character for character. Not offered, because nothing in the app reads it: on
// battery, asleep, hot.
import type { SpeechFacts } from "../store/speechJobs";

export type SlowReason = "gpu_paused" | "no_gpu" | "few_cores" | "busy";

/** The line under a slow note: what Cancel leaves the person with. */
export const CANCEL_NOTE =
  "Or cancel: the assistant and captions still transcribe just the parts they use, when they need them.";

const REASON = {
  gpu_paused:
    "the graphics chip stopped during an earlier transcription, so your processor is used for now",
  no_gpu: "speech is running on your processor (no graphics chip the app can use was found)",
  busy: "an export is running at the same time",
} as const;
const fewCoresReason = (cores: number): string =>
  `this PC has only ${cores} processor ${cores === 1 ? "core" : "cores"}`;

const ADVICE = {
  busy: "It should speed up when the export finishes.",
  gpu_paused:
    "Updating your graphics driver may fix this, and the app will try the chip again later.",
  processor: "Closing other programs helps a little.",
} as const;

const GENERIC = "Slow: this will take a while on this PC.";
const MAX_REASONS = 2;
/** At most this many processor cores is "few" (the job uses cores minus 2, so 2 threads on 4). */
const FEW_CORES = 4;

export interface SlowNote {
  /** The reasons given, in the order said; at most two. */
  codes: readonly SlowReason[];
  /** "Slow: this will take a while because {a} and {b}." or, with no reason, "... on this PC.". */
  head: string;
  /** What the person can do or expect; "" when there is nothing honest to say. */
  advice: string;
  /** The head, then the advice when there is one: the amber line of the popover. */
  sentence: string;
  cancelNote: string;
}

const isCount = (n: number | null): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 1;

/**
 * Reasons in this order: the chip held off after a crash, else no usable chip; few cores, only as a
 * SECOND reason (never with an export: the export is then the better one to name); an export running.
 * The advice is the export's first, as the owner's pictures have it (ALIGNMENT 5.1 says "the first
 * match" in table order, which would put the processor advice first), then the hold's, then the
 * processor's. `noGpu` is not read: the sentence says speech "is running on your processor", which
 * only `backend` can tell.
 */
export function slowNote(facts: SpeechFacts): SlowNote {
  const found: Array<[SlowReason, string]> = [];
  if (facts.gpuHeld) found.push(["gpu_paused", REASON.gpu_paused]);
  else if (facts.backend === "cpu") found.push(["no_gpu", REASON.no_gpu]);
  if (found.length > 0 && !facts.exportsBusy && isCount(facts.cores) && facts.cores <= FEW_CORES)
    found.push(["few_cores", fewCoresReason(facts.cores)]);
  if (facts.exportsBusy) found.push(["busy", REASON.busy]);

  const shown = found.slice(0, MAX_REASONS);
  const head = shown.length
    ? `Slow: this will take a while because ${shown.map(([, text]) => text).join(" and ")}.`
    : GENERIC;
  const advice = facts.exportsBusy
    ? ADVICE.busy
    : facts.gpuHeld
      ? ADVICE.gpu_paused
      : shown.length
        ? ADVICE.processor
        : "";
  return {
    codes: shown.map(([code]) => code),
    head,
    advice,
    sentence: advice ? `${head} ${advice}` : head,
    cancelNote: CANCEL_NOTE,
  };
}

/** Where the run is, in the person's words; null while the engine has not said. */
export function runningOn(
  facts: Pick<SpeechFacts, "backend" | "cores" | "threads">,
): string | null {
  if (facts.backend === "gpu") return "your graphics chip";
  if (facts.backend !== "cpu") return null;
  const { threads, cores } = facts;
  if (!isCount(threads) || !isCount(cores) || threads > cores) return "your processor";
  return `your processor, ${threads} of ${cores} ${cores === 1 ? "core" : "cores"}`;
}

/** Beyond any file: keeps a length finite whatever it is asked about. */
const MAX_S = 1e9;

/** "35 s", "3 min", "1 h 30 min": a length in the unit a person would say it in. */
export function lengthText(seconds: number): string {
  const s = seconds > 0 ? Math.min(seconds, MAX_S) : 0;
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  const minutes = Math.round(s / 60);
  if (s < 5400) return `${minutes} min`;
  // Whole minutes first, so 7199 s is "2 h 0 min" and not "1 h 60 min".
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** "about 2 min": how long is left, as the chip says it. */
export function about(seconds: number): string {
  return `about ${lengthText(seconds)}`;
}

/** "0.3×": the measured speed against real time, from the rate (seconds of work per second of audio).
 *  Null until a rate is measured. */
export function speedText(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return null;
  const speed = 1 / rate;
  if (speed >= 10) return `${Math.round(speed)}×`;
  if (speed >= 0.1) return `${Number(speed.toFixed(1))}×`;
  return `${Math.max(0.01, Number(speed.toFixed(2)))}×`;
}

/** "0.3× (1 min of audio takes about 3 min)"; null until a rate is measured. */
export function speedLine(rate: number | null): string | null {
  const speed = speedText(rate);
  return speed === null || rate === null
    ? null
    : `${speed} (1 min of audio takes ${about(60 * rate)})`;
}
