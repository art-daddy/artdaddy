// What the chat says a running turn is waiting on, and for how long. Pure: the live record in, words out.
//
// The old line said "working…" whatever was happening, so a person could not tell a model that was
// thinking from a transcription that had stalled from a turn that wanted their OK. This names the wait,
// shows how long it has lasted once that is worth showing, and after half a minute says the one thing
// that matters then: it is still going, and Stop is there.
import type { LiveCall, LiveRound } from "../store/liveWait";
import { MODEL_DOWNLOAD_NOTE } from "../store/modelDownload";
import { runningPhrase } from "./toolSummary";

/** A wait shorter than this needs no clock: it would only flicker. */
export const SHOW_ELAPSED_AFTER_S = 3;
/** From here on the line says it is still going and that Stop is available. */
export const SLOW_AFTER_S = 30;
/** The clock stops here, at 99:59:59: a wait past it is a wrong clock, not a time. */
export const CLOCK_MAX_S = 359_999;

/** What a tool that is waiting for speech says it is doing, whatever it is usually called. */
export const TRANSCRIBING_LABEL = "Transcribing the audio";
export const DOWNLOADING_MODEL_LABEL = "Downloading the speech model (one time)";

export type WaitKind = "approval" | "tool" | "model";

export interface WaitStatus {
  kind: WaitKind;
  /** What is being waited on, without a closing ellipsis. */
  label: string;
  /** When this wait began (ms). */
  since: number;
  elapsedS: number;
  showElapsed: boolean;
  slow: boolean;
  /** One sentence for a slow wait; null while it is not slow, and always for an approval (the
   *  turn is waiting on the person, not the other way round). A wait that needs explaining from
   *  the first second (the speech model's one-time download, a request waiting for the last
   *  one to finish) says so at once. */
  hint: string | null;
}

export interface WaitInput {
  round: LiveRound | null;
  calls: readonly LiveCall[];
  approvalSince: number | null;
  now: number;
  /** Names of the tools waiting for speech to be transcribed right now. */
  speechTools?: readonly string[];
  /** The speech model is downloading, which is what any speech wait is then waiting for. */
  downloadingModel?: boolean;
}

const ROUND_LABEL = {
  preparing: "Getting ready",
  waiting: "Thinking",
  writing: "Writing",
} as const;

/** What a round says while its request, not the model, is what is waiting. A reconnect lasts about a second, so it
 *  explains itself only if it drags on; the busy wait starts at 15 s, so it says why straight away. */
const ROUND_NOTE = {
  reconnecting: {
    label: "Reconnecting",
    hint: "Still trying to reach the server. You can press Stop at any time.",
    explainAtOnce: false,
  },
  busy: {
    label: "Waiting for your last request",
    hint: "Your last request is still finishing, so this one starts when it ends. You can press Stop at any time.",
    explainAtOnce: true,
  },
} as const;

const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);

/** The wait the person should be shown, or null when the turn is not waiting on anything we know of.
 *  The person's own answer comes first, then a tool that is running (the one running longest), then
 *  the model. */
export function waitStatus(input: WaitInput): WaitStatus | null {
  const now = finite(input.now, 0);
  const make = (
    kind: WaitKind,
    label: string,
    since: number,
    hint: string | null,
    hintFromStart = false,
  ): WaitStatus => {
    const started = finite(since, now);
    // Two finite times at opposite extremes still subtract to Infinity, so the result is capped.
    const elapsedS = Math.min(CLOCK_MAX_S, Math.max(0, Math.floor((now - started) / 1000)));
    const slow = kind !== "approval" && elapsedS >= SLOW_AFTER_S;
    return {
      kind,
      label,
      since: started,
      elapsedS,
      showElapsed: elapsedS >= SHOW_ELAPSED_AFTER_S,
      slow,
      hint: slow || hintFromStart ? hint : null,
    };
  };

  if (input.approvalSince !== null)
    return make("approval", "Waiting for your OK", input.approvalSince, null);

  if (input.calls.length > 0) {
    let oldest = input.calls[0];
    for (const call of input.calls) if (call.startedAt < oldest.startedAt) oldest = call;
    const more = input.calls.length - 1;
    const onSpeech = input.speechTools?.includes(oldest.name) === true;
    const downloading = onSpeech && input.downloadingModel === true;
    const phrase = downloading
      ? DOWNLOADING_MODEL_LABEL
      : onSpeech
        ? TRANSCRIBING_LABEL
        : runningPhrase(oldest.name);
    return make(
      "tool",
      more > 0 ? `${phrase} (+${more} more)` : phrase,
      oldest.startedAt,
      downloading
        ? `${MODEL_DOWNLOAD_NOTE} You can press Stop at any time.`
        : "Still working on this. You can press Stop at any time.",
      downloading,
    );
  }

  if (input.round) {
    const note = input.round.note ? ROUND_NOTE[input.round.note] : null;
    return make(
      "model",
      note?.label ?? ROUND_LABEL[input.round.phase],
      input.round.startedAt,
      note?.hint ?? "The AI is taking longer than usual. You can press Stop at any time.",
      note?.explainAtOnce ?? false,
    );
  }

  return null;
}

/** "0:07", "12:03", "1:02:03". Stops counting at 99:59:59: a wait past that is a wrong clock, not a time. */
export function clockText(totalSeconds: number): string {
  const s = Math.min(CLOCK_MAX_S, Math.max(0, Math.floor(finite(totalSeconds, 0))));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
