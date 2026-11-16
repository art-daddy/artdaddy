// The one place the PC check hears of the world. The service decides when a probe may run from six signals (an export queued or running, an export being asked, playback, a look or a
// background job, a project open, the person's last input) and stops a run the moment one turns busy; it reads nothing itself. This reads each source, tells the service whenever a
// source says it changed, and on a heartbeat for the ones with no event (playback, a project closing, the server's switch), so the check stops within a second and a half of anything
// that turns busy. A source that cannot be read is busy, which can only keep a check from starting.
import type { PcCheckService, PcCheckSignals } from "../platform/pcCheck";

/** How often the sources with no event are read. Under the check's one and a half seconds to stop, over the cost of a few property reads. */
export const HEARTBEAT_MS = 1_000;

export interface SignalReaders {
  /** An export is queued or running. */
  exportBusy(): boolean;
  /** An export is being asked its questions (a pending check-first question does not count: see exportAsk.ts). */
  exportAsked(): boolean;
  playing(): boolean;
  /** A look's whisper, a background job (a transcription or a loudness measurement) or a preview copy of an imported file is at work. */
  lookOrSpeechJob(): boolean;
  projectOpen(): boolean;
  lastInputAtMs(): number;
  /** The server's switch (`pc_check`): a change of it is something the service must hear of, though nothing else moved. */
  enabled(): boolean;
}

export interface SignalDeps {
  service: Pick<PcCheckService, "setSignals">;
  read: SignalReaders;
  /** Where changes are heard: each subscribes `onChange` and returns the unsubscribe. */
  listen: ReadonlyArray<(onChange: () => void) => () => void>;
  now(): number;
  setBeat(fn: () => void, ms: number): unknown;
  clearBeat(handle: unknown): void;
}

export interface SignalHandle {
  /** Reads every source and tells the service if anything differs from what it was last told. */
  push(): void;
  stop(): void;
}

/** Starts telling the service. Tells it once at once, then on every change a source announces and on every beat. */
export function startPcCheckSignals(deps: SignalDeps): SignalHandle {
  const { service, read, now } = deps;
  let lastKey: string | null = null;
  let stopped = false;
  const unsubscribers: Array<() => void> = [];

  // A source that fails to answer is busy: the service reads anything that is not exactly `false` as busy, and a project that is not exactly open as closed.
  const busy = (source: () => unknown): boolean => {
    try {
      return source() !== false;
    } catch {
      return true;
    }
  };
  const open = (): boolean => {
    try {
      return read.projectOpen() === true;
    } catch {
      return false;
    }
  };
  const input = (): number => {
    try {
      const at = read.lastInputAtMs();
      return typeof at === "number" && Number.isFinite(at) ? at : now();
    } catch {
      return now();
    }
  };
  const enabled = (): boolean => {
    try {
      return read.enabled() !== false;
    } catch {
      return true;
    }
  };

  function push(): void {
    if (stopped) return;
    try {
      const signals: PcCheckSignals = {
        exportBusy: busy(read.exportBusy),
        exportAsked: busy(read.exportAsked),
        playing: busy(read.playing),
        lookOrSpeechJob: busy(read.lookOrSpeechJob),
        projectOpen: open(),
        lastInputAtMs: input(),
      };
      const key = [
        signals.exportBusy,
        signals.exportAsked,
        signals.playing,
        signals.lookOrSpeechJob,
        signals.projectOpen,
        signals.lastInputAtMs,
        enabled(),
      ].join("|");
      if (key === lastKey) return;
      lastKey = key;
      service.setSignals(signals);
    } catch {
      // What the check hears is never worth disturbing anything: the service keeps the signals it last had.
    }
  }

  for (const subscribe of deps.listen) {
    try {
      unsubscribers.push(subscribe(push));
    } catch {
      // A source that cannot be listened to is still read at every beat.
    }
  }
  let beat: unknown = null;
  try {
    beat = deps.setBeat(push, HEARTBEAT_MS);
  } catch {
    // Without a beat the sources with no event are read when anything else changes.
  }
  push();

  return {
    push,
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const unsubscribe of unsubscribers.splice(0)) {
        try {
          unsubscribe();
        } catch {
          // Nothing to take back.
        }
      }
      try {
        if (beat !== null) deps.clearBeat(beat);
      } catch {
        // The beat does nothing once stopped.
      }
    },
  };
}
