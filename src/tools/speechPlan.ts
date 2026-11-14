// What to do with a speech transcription on a PC that may be slow (S2). Pure: no storage, no clock,
// no engine. The pace it reads is `speechPace.ts`, the one authority for "how long here".
//
// Two questions, both answered from this PC's own pace and the same ten minutes:
//   * a WHOLE file, as the background indexer would make it: a job on the processor that this PC
//     projects past the cap is not started by itself (it is `ondemand`: the parts a request uses are
//     transcribed when asked for); a job on the graphics chip is never deferred by its length alone;
//   * the PARTS of one file that a clip uses: the padded used spans merged into windows, each costed
//     on its own start-up, and joined across a gap only when reading the gap is cheaper than starting
//     again and the joined window still fits the cap.
// Nothing here starts, stops or queues anything: the caller does, and says what it decided.
import { projectedS, type PaceBook, type PaceModel, type SpeechBackend } from "./speechPace";

/** The longest a transcription may be projected to take on this PC before something that nobody asked
 *  for is not started by itself, and before a span the assistant chose is refused: ten minutes (owner
 *  decision 14 Nov 2026, S2-02 and S2-11). */
export const CAP_S = 600;

/** Why a whole-file job was planned as it was. `ok`: it runs on the graphics chip. `cpu_only`: it
 *  runs on the processor because that is all this PC has. `gpu_held`: on the processor because a
 *  crashed chip is being kept off. `cap`: not started by itself, the projection passes the cap. */
export type PlanWhy = "ok" | "cap" | "cpu_only" | "gpu_held";

export interface WholePlan {
  plan: "whole" | "ondemand";
  why: PlanWhy;
  /** About how long the whole file takes on the backend that would run it, in seconds. */
  projectedS: number;
}

export interface WholeFileInput {
  /** The backend a run would use if the chip were not held. */
  backend: SpeechBackend;
  /** The chip crashed before and is being kept off: whatever `backend` says, the processor runs. */
  held: boolean;
  /** The file's length in seconds of audio. */
  audioS: number;
  pace: PaceBook;
  capS?: number;
}

const usable = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Whole, or on demand, for one file. Garbage in is a decision out: an unknown length is none, an
 *  unknown backend is the processor, and a held chip is never planned as a chip run. */
export function planWholeFile(input: WholeFileInput): WholePlan {
  const capS = usable(input.capS) ? input.capS : CAP_S;
  const held = input.held === true;
  const onChip = !held && input.backend === "gpu";
  const model = onChip ? input.pace.gpu : input.pace.cpu;
  const projected = projectedS(model, input.audioS);
  if (onChip) return { plan: "whole", why: "ok", projectedS: projected };
  if (projected > capS) return { plan: "ondemand", why: "cap", projectedS: projected };
  return { plan: "whole", why: held ? "gpu_held" : "cpu_only", projectedS: projected };
}

/** One window of a file to transcribe, in source seconds. */
export interface SpanWindow {
  start: number;
  end: number;
  /** About how long this window takes on its own, start-up included. */
  projectedS: number;
  /** One used window that alone passes the cap: it cannot be made smaller, so the caller runs it and
   *  tells the person the time first. Never a window made by joining others. */
  overCap: boolean;
}

export interface SpanPlan {
  windows: SpanWindow[];
  /** The sum of the windows' own times. */
  projectedS: number;
}

export interface SpansInput {
  /** The source seconds that are used, as `[from, to]`: any order, any overlap. */
  usedSpans: ReadonlyArray<readonly [number, number]>;
  /** Audio kept either side of a used span, so a word its cut clips is heard whole. */
  padS: number;
  pace: PaceModel;
  capS?: number;
  /** Join two windows across the gap when that is cheaper than starting again (default true). A caller
   *  whose windows are KEYS (the transcript cache keeps a window under its own range) passes false: the
   *  windows then depend on the used spans alone, so a pace that moves after a run cannot make the same
   *  clips ask for a different window and transcribe the same audio again. */
  mergeGaps?: boolean;
}

/** The windows to transcribe for the used parts of ONE file. Used spans are padded and the ones that
 *  overlap are one window (the rule `get_transcript` already uses). Unless `mergeGaps` is false, two
 *  windows are then joined across the gap when reading the gap costs less than starting again (gap
 *  times rate below the start-up) and the joined window still fits the cap. Joining never costs more
 *  than not joining, and a window already past the cap is returned as it is, flagged, never joined to
 *  anything. */
export function planSpans(input: SpansInput): SpanPlan {
  const capS = usable(input.capS) ? input.capS : CAP_S;
  const pad = usable(input.padS) && input.padS > 0 ? input.padS : 0;
  const mergeGaps = input.mergeGaps !== false;
  const { pace } = input;
  const used: Array<[number, number]> = [];
  for (const span of Array.isArray(input.usedSpans) ? input.usedSpans : []) {
    const [a, b] = (Array.isArray(span) ? span : []) as readonly unknown[];
    if (!usable(a) || !usable(b)) continue;
    const start = Math.max(0, a);
    if (b > start) used.push([start, b]);
  }
  used.sort((p, q) => p[0] - q[0]);

  const base: Array<[number, number]> = [];
  for (const [a, b] of used) {
    const start = Math.max(0, a - pad);
    const end = b + pad;
    const last = base[base.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else base.push([start, end]);
  }

  const joined: Array<[number, number]> = [];
  for (const [start, end] of base) {
    const last = joined[joined.length - 1];
    if (
      mergeGaps &&
      last &&
      (start - last[1]) * pace.rate < pace.startupS &&
      projectedS(pace, end - last[0]) <= capS
    )
      last[1] = end;
    else joined.push([start, end]);
  }

  const windows = joined.map(([start, end]): SpanWindow => {
    const takes = projectedS(pace, end - start);
    return { start, end, projectedS: takes, overCap: takes > capS };
  });
  return { windows, projectedS: windows.reduce((n, w) => n + w.projectedS, 0) };
}
