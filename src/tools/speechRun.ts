// The glue between ONE run of the speech engine and the two things that observe it: the running-job
// monitor (`speechMonitor.ts`: what the job's output says) and the store the top-bar chip reads
// (`store/speechJobs.ts`). It only watches: it adds the run to the list when it launches, tells the list
// what the monitor learns, withdraws the run when it ends, and stops it when the person presses Cancel or the
// live check says the run is too slow. Nothing here can fail or slow a transcription: every call into the
// store, the monitor or the supervisor is wrapped, and an observer that throws changes nothing about the run.
// LOCAL ONLY: nothing is sent anywhere (T1-10 = C).
import { exportFlag } from "../api/exportFlags";
import { hostInfo } from "../platform/host";
import {
  registerCanceller,
  useSpeechJobs,
  type SpeechFacts,
  type SpeechJob,
  type SpeechPurpose,
} from "../store/speechJobs";
import { cpuOnlyNow } from "./speechBackend";
import { createSpeechMonitor, passesLiveCap, type MonitorSnapshot } from "./speechMonitor";
import { backendNow, readPace, recordSpeechRun } from "./speechPace";
import { CAP_S } from "./speechPlan";
import { recordPlan } from "./speechPlanLog";
import { exportsBusyNow, onExportsBusy } from "./workGate";

export type StopReason = "person" | "too_slow";

/** What is known about a run before it starts. */
export interface RunInfo {
  purpose: SpeechPurpose;
  /** What the person calls the file: its name. */
  label: string;
  /** Seconds of audio the run covers, when that is known. */
  spanS: number | null;
  /** The threads the engine is given (`-t`). */
  threads: number | null;
  /** A whole file that the background started by itself: the only kind the live check may stop. A request's
   *  own run (a look, captions, get_transcript) is never stopped by it (S2-13): only Cancel stops those. */
  liveStop: boolean;
  /** One process over several files: each file's segments restart at 0, so no position is read from it. */
  several: boolean;
}

export interface WatchInput extends RunInfo {
  /** The supervisor's job id for a run that has started. */
  id: string;
  /** The engine was launched with the graphics chip off (`-ng`). */
  cpuOnly: boolean;
  /** This launch is the retry after the chip crashed in this same run. */
  afterCrash: boolean;
  /** Stop this run (the same path for Cancel and for the live check). */
  stop: (how: StopReason) => void;
  /** The head of the job's log where the supervisor holds it (it streams stdout live, and stderr only at the
   *  end), for the backend the engine names. Null when the log is not available. */
  readLog?: () => Promise<string | null>;
  now?: () => number;
}

export interface RunWatch {
  /** Give this to the runner: it hears the job's output as it is written. */
  onStdout(chunk: string): void;
  /** The run ended. `code` is its exit status (null when it never reported one). Always call it. */
  finish(code: number | null, stoppedBy: StopReason | null): RunEnd;
}

export interface RunEnd {
  /** Seconds from launch to when audio began to move, corrected for the work behind the first words;
   *  null when it could not be told. */
  startupS: number | null;
  /** About how long the whole run would have taken, when the live check stopped it. */
  liveProjectedS: number | null;
}

/** Run `fn` and never let it fail: an observer's error is nobody's business. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* an observer can never change a run */
  }
}

/** The backend this PC's latest finished run used, when no hold keeps the chip off: what it did last is the
 *  fact the app holds about a chip it may not have. */
function lastRunWasOnProcessor(): boolean {
  try {
    if (cpuOnlyNow()) return false;
    const samples = readPace();
    return samples.length > 0 && backendNow(samples, hostInfo().os, false) === "cpu";
  } catch {
    return false;
  }
}

const QUIET: RunWatch = {
  onStdout: () => undefined,
  finish: () => ({ startupS: null, liveProjectedS: null }),
};

/** Watch one run. If anything at all goes wrong in setting the watch up, the run is simply not watched:
 *  an observer can never fail the transcription it observes. */
export function watchSpeechRun(input: WatchInput): RunWatch {
  try {
    return watchRun(input);
  } catch {
    return QUIET;
  }
}

function watchRun(input: WatchInput): RunWatch {
  const now = input.now ?? Date.now;
  const launchedAt = now();
  const monitor = createSpeechMonitor({ launchedAt, spanS: input.spanS });
  const held = cpuOnlyNow() || input.afterCrash;
  const facts: SpeechFacts = {
    // Launched with the chip off, the processor runs it: a fact. Otherwise only the engine's own log says.
    backend: input.cpuOnly ? "cpu" : null,
    gpuHeld: held,
    noGpu: !input.cpuOnly && lastRunWasOnProcessor(),
    cores: ((): number | null => {
      const n = Number(globalThis.navigator?.hardwareConcurrency);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    threads: input.threads,
    exportsBusy: exportsBusyNow(),
  };
  const job: SpeechJob = {
    id: input.id,
    purpose: input.purpose,
    label: input.label,
    spanS: input.spanS,
    phase: "starting",
    stop: null,
    enqueuedAt: launchedAt,
    startedAt: launchedAt,
    firstWordsAt: null,
    endedAt: null,
    doneS: 0,
    rate: null,
    etaS: null,
    facts,
  };
  const patch = (p: Parameters<ReturnType<typeof useSpeechJobs.getState>["patch"]>[1]): void =>
    safely(() => useSpeechJobs.getState().patch(input.id, p));

  safely(() => useSpeechJobs.getState().add(job));
  let withdraw: (() => void) | null = null;
  safely(() => {
    withdraw = registerCanceller(input.id, () => input.stop("person"));
  });
  let off: (() => void) | null = null;
  safely(() => {
    off = onExportsBusy((busy) => patch({ facts: { exportsBusy: busy } }));
  });

  let stopped = false;
  let ended = false;
  let liveProjectedS: number | null = null;
  let logReads = 0;
  let last: MonitorSnapshot = monitor.snapshot();

  const learn = (): void => {
    if (ended) return;
    const snap = monitor.snapshot();
    last = snap;
    patch({
      phase: snap.firstWordsAt === null ? "starting" : "running",
      firstWordsAt: snap.firstWordsAt,
      doneS: snap.doneS,
      rate: snap.rate,
      etaS: snap.etaS,
      facts: {
        ...(snap.backend === null ? {} : { backend: snap.backend, noGpu: snap.noGpu }),
      },
    });
    // The live check (S2-02): only a background whole file, only on the processor (the app launched it so,
    // or the engine said so, or the chip it does not have is what this PC's last run found), only once the
    // rate is measured, and only while the switch is on.
    if (stopped || !input.liveStop || !exportFlag("speech_cpu_cap")) return;
    const onProcessor =
      snap.backend === null ? input.cpuOnly || lastRunWasOnProcessor() : snap.backend === "cpu";
    const elapsedS = (now() - launchedAt) / 1000;
    if (!onProcessor || !passesLiveCap(elapsedS, snap.etaS, CAP_S)) return;
    stopped = true;
    liveProjectedS = elapsedS + (snap.etaS ?? 0);
    // What this run showed of the processor's pace is kept, so the next file is judged by it at admission
    // and not started only to be stopped again (a stopped run reports no timings of its own).
    safely(() =>
      recordSpeechRun(snap.doneS, elapsedS, "cpu", undefined, snap.startupS ?? undefined),
    );
    safely(() =>
      recordPlan({
        at: now(),
        file: input.label,
        plan: "ondemand",
        why: "cap",
        projectedS: liveProjectedS,
        backend: "cpu",
        held,
        where: "live",
      }),
    );
    safely(() => input.stop("too_slow"));
  };

  /** Once audio moves the engine's early log has been written: read what the supervisor holds of it, once,
   *  and again at the first rate if it was not there yet. Never waited for. */
  const readEarlyLog = (snap: MonitorSnapshot): void => {
    const read = input.readLog;
    if (!read || snap.backend !== null || snap.firstWordsAt === null || logReads >= 2) return;
    if (logReads === 1 && snap.rate === null) return;
    logReads++;
    void read()
      .then((text) => {
        if (!text) return;
        monitor.feed(text, now());
        learn();
      })
      .catch(() => undefined);
  };

  return {
    onStdout(chunk) {
      safely(() => {
        if (ended) return;
        monitor.feed(chunk, now());
        if (input.several) return;
        learn();
        readEarlyLog(last);
      });
    },
    finish(code, stoppedBy) {
      ended = true;
      safely(() => withdraw?.());
      safely(() => off?.());
      safely(() => {
        const how =
          code === 0
            ? "done"
            : stoppedBy === "person"
              ? "cancelled"
              : stoppedBy === "too_slow"
                ? "too_slow"
                : "failed";
        useSpeechJobs.getState().end(input.id, how, now());
      });
      return {
        startupS: input.several ? null : monitor.snapshot().startupS,
        liveProjectedS,
      };
    },
  };
}
