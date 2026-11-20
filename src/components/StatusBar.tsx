// The status bar at the bottom of the window, as an editor has one (the owner's decision of 20 Nov 2026, in place of
// the chip that sat in the top bar). On the left, what goes on in the background: the speech chip (what is being
// transcribed, how far, Cancel) and, when a background transcription failed, that it did, what the error was and
// Retry. On the right, the credits that are left, which were on the chat's footer line.
// Local only: nothing in the bar is sent anywhere. A failure is reported to us by the indexer, as it always was.
import { useEffect, useId, useState, useSyncExternalStore } from "react";

import { creditsTitle, formatCredits, getUsage, refreshUsage, subscribeUsage } from "../api/usage";
import { openDiscord } from "../lib/community";
import { CREDITS_PAUSED } from "../lib/outOfCredits";
import {
  ENGINE_FAILURE_ID,
  retrySpeechFailures,
  useSpeechFailures,
  type SpeechFailure,
} from "../store/speechFailures";
import type { TranscriptFailureReason } from "../tools/speechFailure";
import SpeechChip from "./SpeechChip";
import { cn } from "./ui";

/** What each reason means for the person, in a line. The error itself is shown under it. */
const REASON_WORDS: Record<TranscriptFailureReason, string> = {
  model_unavailable: "The speech model could not be downloaded.",
  engine_unavailable: "The speech engine cannot start on this PC.",
  language_rejected: "The speech engine does not know that language.",
  audio_extraction_failed: "The sound of this file could not be read.",
  engine_failed: "The speech engine failed on this file.",
  cancelled: "Stopped.",
};

/** The most failures the tooltip lists; the rest are counted. */
const TIP_ROWS = 4;

const times = (n: number): string => (n === 1 ? "once" : `${n} times`);

/** What happens next for one failure, so that the person knows whether Retry is the way. */
function nextNote(f: SpeechFailure): string {
  if (f.id === ENGINE_FAILURE_ID)
    return "Nothing is transcribed on this PC until the engine starts. Retry tries it again.";
  return f.willRetry
    ? `Tried ${times(f.attempts)}. It is tried again by itself when the project next opens or changes; Retry does it now.`
    : `Tried ${times(f.attempts)}, and then stopped. Retry tries it again now.`;
}

function headlineOf(failures: readonly SpeechFailure[]): string {
  if (failures.length > 1) return `Transcription failed (${failures.length})`;
  const [only] = failures;
  return only.id === ENGINE_FAILURE_ID
    ? "Transcription is off: the speech engine cannot start"
    : `Transcription failed: ${only.label ?? "a file"}`;
}

/** A background transcription that failed: the headline, the exact errors on hover or focus (or pinned open with a
 *  click, to read or copy them), Retry and a way to close it. */
function SpeechFailureItem(): JSX.Element | null {
  const failures = useSpeechFailures((s) => s.failures);
  const dismissAll = useSpeechFailures((s) => s.dismissAll);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const tipId = useId();
  const any = failures.length > 0;

  // The tooltip goes with its failures, and does not open by itself for the next ones.
  useEffect(() => {
    if (!any) {
      setHover(false);
      setFocus(false);
      setPinned(false);
    }
  }, [any]);
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPinned(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinned]);

  if (!any) return null;
  const open = hover || focus || pinned;
  const shown = [...failures].reverse().slice(0, TIP_ROWS);
  const more = failures.length - shown.length;

  return (
    <div
      role="status"
      data-testid="speech-failure"
      className="relative flex min-w-0 items-center gap-1 rounded bg-red-950/70 px-1.5 text-red-200"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        data-testid="speech-failure-headline"
        aria-describedby={open ? tipId : undefined}
        aria-expanded={pinned}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        className="flex min-w-0 items-center gap-1 rounded py-0.5 text-[11px] hover:text-white"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" aria-hidden />
        <span className="max-w-[24rem] truncate">{headlineOf(failures)}</span>
      </button>
      <button
        type="button"
        aria-label="Retry transcription"
        onClick={() => void retrySpeechFailures()}
        className="rounded px-1 py-0.5 text-[11px] font-medium underline underline-offset-2 hover:text-white"
      >
        Retry
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismissAll}
        className="rounded px-1 text-[12px] leading-none hover:text-white"
      >
        ×
      </button>
      {open && (
        <div
          id={tipId}
          role="tooltip"
          data-testid="speech-failure-tip"
          className="absolute bottom-full left-0 z-[95] mb-1 w-96 max-w-[90vw] select-text space-y-2 rounded-md border border-edge bg-panel p-2.5 text-[11px] text-ink shadow-2xl"
        >
          {shown.map((f) => (
            <div key={f.id}>
              <div className="font-medium">{f.label ?? "The speech engine"}</div>
              <div className="text-ink-dim">{REASON_WORDS[f.reason]}</div>
              <div className="mt-0.5 max-h-24 overflow-hidden break-words font-mono text-[10px] text-neutral-400">
                {f.message}
              </div>
              <div className="mt-0.5 text-neutral-500">{nextNote(f)}</div>
            </div>
          ))}
          {more > 0 && <div className="text-neutral-500">{`and ${more} more`}</div>}
        </div>
      )}
    </div>
  );
}

/** The credits that are left, as the chat's footer line had them: the number, the pause everyone shares, or at zero
 *  the way out, which is the one thing someone stuck there needs. */
function Credits(): JSX.Element | null {
  const usage = useSyncExternalStore(subscribeUsage, getUsage);
  // The balance is read when the bar appears; the chat asks again after each turn, when its cost changes it.
  useEffect(() => {
    void refreshUsage();
  }, []);
  if (!usage.metered) return null;
  if (usage.globalPaused)
    return (
      <span className="tabular-nums text-amber-400" title={CREDITS_PAUSED}>
        AI paused - {formatCredits(Math.max(0, usage.remaining))} cr left
      </span>
    );
  if (usage.over)
    // At zero the number is the least useful thing we can show: it states the dead end
    // without the way out, which is the one thing someone stuck here needs.
    return (
      <button
        type="button"
        onClick={() => void openDiscord()}
        title={creditsTitle(usage)}
        className="whitespace-nowrap font-medium text-red-400 underline underline-offset-2 hover:text-red-300"
      >
        0 cr — Join our Discord to get more
      </button>
    );
  return (
    <span className="tabular-nums text-neutral-400" title={creditsTitle(usage)}>
      {formatCredits(Math.max(0, usage.remaining))} cr left
    </span>
  );
}

export default function StatusBar(): JSX.Element {
  return (
    <div
      data-testid="status-bar"
      role="group"
      aria-label="status bar"
      className={cn(
        "relative z-10 flex h-6 shrink-0 select-none items-center gap-2 border-t border-edge bg-neutral-950 px-2",
        "text-[11px] text-neutral-400",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <SpeechChip placement="up" />
        <SpeechFailureItem />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Credits />
      </div>
    </div>
  );
}
