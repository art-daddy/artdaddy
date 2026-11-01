// What the chat says a running turn is waiting on, and for how long. Pure: the live record in, words out.
//
// The old line said "working…" whatever was happening, so a person could not tell a model that was
// thinking from a transcription that had stalled from a turn that wanted their OK. This names the wait,
// shows how long it has lasted once that is worth showing, and after half a minute says the one thing
// that matters then: it is still going, and Stop is there.
import type { LiveCall, LiveRound } from "../store/liveWait";
import { runningPhrase } from "./toolSummary";

/** A wait shorter than this needs no clock: it would only flicker. */
export const SHOW_ELAPSED_AFTER_S = 3;
/** From here on the line says it is still going and that Stop is available. */
export const SLOW_AFTER_S = 30;

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
   *  turn is waiting on the person, not the other way round). */
  hint: string | null;
}

export interface WaitInput {
  round: LiveRound | null;
  calls: readonly LiveCall[];
  approvalSince: number | null;
  now: number;
}

const ROUND_LABEL = {
  preparing: "Getting ready",
  waiting: "Thinking",
  writing: "Writing",
} as const;

const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);

/** The wait the person should be shown, or null when the turn is not waiting on anything we know of.
 *  The person's own answer comes first, then a tool that is running (the one running longest), then
 *  the model. */
export function waitStatus(input: WaitInput): WaitStatus | null {
  const now = finite(input.now, 0);
  const make = (kind: WaitKind, label: string, since: number, hint: string | null): WaitStatus => {
    const started = finite(since, now);
    const elapsedS = Math.max(0, Math.floor((now - started) / 1000));
    const slow = kind !== "approval" && elapsedS >= SLOW_AFTER_S;
    return {
      kind,
      label,
      since: started,
      elapsedS,
      showElapsed: elapsedS >= SHOW_ELAPSED_AFTER_S,
      slow,
      hint: slow ? hint : null,
    };
  };

  if (input.approvalSince !== null)
    return make("approval", "Waiting for your OK", input.approvalSince, null);

  if (input.calls.length > 0) {
    let oldest = input.calls[0];
    for (const call of input.calls) if (call.startedAt < oldest.startedAt) oldest = call;
    const more = input.calls.length - 1;
    return make(
      "tool",
      more > 0 ? `${runningPhrase(oldest.name)} (+${more} more)` : runningPhrase(oldest.name),
      oldest.startedAt,
      "Still working on this. You can press Stop at any time.",
    );
  }

  if (input.round)
    return make(
      "model",
      ROUND_LABEL[input.round.phase],
      input.round.startedAt,
      "The AI is taking longer than usual. You can press Stop at any time.",
    );

  return null;
}

/** "0:07", "12:03", "1:02:03". Stops counting at 99:59:59: a wait past that is a wrong clock, not a time. */
export function clockText(totalSeconds: number): string {
  const s = Math.min(359_999, Math.max(0, Math.floor(finite(totalSeconds, 0))));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
