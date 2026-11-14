// The lean render paths' option and its inputs (Phase 3a). A plan built WITHOUT `ExportOptions.lean` is 0.27.0's plan byte for byte (the frozen graph
// corpus, `render.corpus.test.ts`, builds without it). The two production boundaries (`prepareRender`, `exportItems.ts`) pass it, with the six
// switches read from the export flags and whatever the builder asked ffmpeg about before they build again.
import { exportFlag, type ExportFlagName } from "../api/exportFlags";
import type { LeanFix } from "./leanRecord";

/** The six remote switches, by the name lane L2 adds on both sides (`FLAGS-AND-FACTS.md` Table A, rows 14 to 19, in this order). */
export const LEAN_FLAG_NAMES: Readonly<Record<LeanFix, string>> = {
  zoom: "lean_zoom",
  fades: "lean_fades",
  dip: "lean_dip",
  stills: "lean_stills",
  grade: "lean_grade",
  decoders: "lean_decoders",
};

/** What the builder wants ffmpeg to tell it about one picture before it can take a lean path: the filters the picture chain runs up to and including
 *  its pre-scale, each followed by `showinfo`. The answer is keyed by `key` (the input's path and the filter text). */
export interface LeanProbeRequest {
  key: string;
  path: string;
  /** The filter chain to run on the input's first frame, `setsar=1,showinfo,<pre-scale>,showinfo`. */
  filters: string;
}

/** What ffmpeg said: the pixel format and size the picture arrives in (after any automatic rotation), and its size after the pre-scale. */
export interface LeanProbed {
  fmt: string;
  source: readonly [number, number];
  scaled: readonly [number, number];
}

/** What the lean masks have spent in one export so far (graph text and drawbox filters); one object is shared by every part of a streamed export. */
export interface LeanMaskBudget {
  chars: number;
  boxes: number;
}

export interface LeanOptions {
  zoom?: boolean;
  fades?: boolean;
  dip?: boolean;
  stills?: boolean;
  grade?: boolean;
  decoders?: boolean;
  /** The person's Try again after a failure of an export that ran a lean fix: every lean path stays out of this build, and nothing is counted as kept (the record is
   *  empty; the retry's own trace event says it was a retry). */
  plain?: boolean;
  /** What leanProbe.ts read from ffmpeg for the requests an earlier build made. */
  probed?: ReadonlyMap<string, LeanProbed>;
  /** Filled by the builder with the probes it wanted and did not have; the async boundary answers them and builds again. */
  requests?: LeanProbeRequest[];
  /** The mask budget of the whole export (DESIGN-3a 2.1 item 6): the builder of one command spends from it, and a streamed export passes the same object to every part. */
  budget?: LeanMaskBudget;
}

/** The six switches as they stand now. A name this client does not know is never on (exportFlags.ts), so until lane L2 adds the names every fix stays
 *  off: the safe direction. */
export function readLeanFlags(): Pick<LeanOptions, LeanFix> {
  const on = (fix: LeanFix): boolean => exportFlag(LEAN_FLAG_NAMES[fix] as ExportFlagName);
  return {
    zoom: on("zoom"),
    fades: on("fades"),
    dip: on("dip"),
    stills: on("stills"),
    grade: on("grade"),
    decoders: on("decoders"),
  };
}
