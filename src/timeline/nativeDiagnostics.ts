// What the app process prints at the end of every export run, read back for the report.
//
// The native side ends each run, success or failure, with a few diagnostic lines (src-tauri/src/jobs/
// stream.rs): the resident-memory peak and the limit it ran under, the temporary-space peak, and the
// commit limit and peak. They already feed the export-time estimate; here they also say how much
// memory an export really used and which limit stopped it, so the limits can be set from evidence.
//
// The formats are the Rust formats, word for word:
//   native render resident: {"limit":N,"sampled_peak":N,"workers_at_peak":[...]}
//   native render temporary: {"accounted_peak_payload_bytes":N}
//   native render budget: configured_commit=N, reported_peak=N; peak is accounting, not ...
//   native render failed: <why>
import type { ExportLimit } from "../api/exportVocabulary";

export interface NativeRunFacts {
  residentPeakBytes?: number;
  residentLimitBytes?: number;
  commitLimitBytes?: number;
  commitPeakBytes?: number;
  temporaryPeakBytes?: number;
}

const MIB = 1024 * 1024;
/** Memory is reported in steps of this many MiB: a band, not a fingerprint. */
const MIB_STEP = 128;

const whole = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function jsonAfter(line: string, marker: string): Record<string, unknown> | null {
  const at = line.indexOf(marker);
  if (at < 0) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(at + marker.length));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The facts in a run's stderr. The last of each line wins (a retried or sequenced run prints several);
 *  a line that is missing or malformed leaves its facts out rather than guessing them. */
export function parseNativeDiagnostics(stderr: string): NativeRunFacts {
  const facts: NativeRunFacts = {};
  for (const line of stderr.split(/\r?\n/)) {
    if (line.includes("native render resident: ")) {
      const parsed = jsonAfter(line, "native render resident: ");
      const peak = whole(parsed?.sampled_peak);
      const limit = whole(parsed?.limit);
      if (peak !== undefined && peak > 0) facts.residentPeakBytes = peak;
      if (limit !== undefined && limit > 0) facts.residentLimitBytes = limit;
    } else if (line.includes("native render temporary: ")) {
      const peak = whole(
        jsonAfter(line, "native render temporary: ")?.accounted_peak_payload_bytes,
      );
      if (peak !== undefined) facts.temporaryPeakBytes = peak;
    } else if (line.includes("native render budget: ")) {
      const found = /configured_commit=(\d+), reported_peak=(\d+)/.exec(line);
      if (found) {
        const limit = whole(Number(found[1]));
        const peak = whole(Number(found[2]));
        if (limit !== undefined && limit > 0) facts.commitLimitBytes = limit;
        if (peak !== undefined && peak > 0) facts.commitPeakBytes = peak;
      }
    }
  }
  return facts;
}

/** Bytes as MiB in steps of {@link MIB_STEP}, or undefined when there is nothing to report. */
export function mibBand(bytes: number | undefined): number | undefined {
  if (bytes === undefined || !(bytes > 0)) return undefined;
  const steps = Math.round(bytes / MIB / MIB_STEP);
  return Math.max(MIB_STEP, steps * MIB_STEP);
}

/** Which limit ended an export, read from the failure text. Only the explicit words of a limit count:
 *  the resident summary line and the "output write boundary refused completion" line are printed for
 *  EVERY failed run (they are consequences, not causes), so neither says anything here. */
export function limitThatFired(error: string, facts: NativeRunFacts): ExportLimit | undefined {
  const text = error.toLowerCase();
  if (!text) return undefined;
  if (/resident memory (?:budget exceeded|accounting failed)/.test(text)) return "resident";
  if (
    /workspace (?:allocation |entry )?budget exceeded|scratch budget|temporary budget exceeded/.test(
      text,
    )
  )
    return "scratch";
  if (/execution deadline|deadline expired/.test(text)) return "clock";
  // ffmpeg's own word for a memory request the system refused. When the job stayed under its commit cap
  // that is the machine itself; when it had reached the cap, it is the cap.
  if (/cannot allocate memory|out of memory|not enough memory/.test(text)) {
    const { commitLimitBytes: cap, commitPeakBytes: peak } = facts;
    if (!cap) return "os";
    return peak !== undefined && peak < cap * 0.8 ? "os" : "commit";
  }
  return undefined;
}
