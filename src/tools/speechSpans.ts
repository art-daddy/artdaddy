// The stretches of a file that the clips on the timeline play, and the windows to transcribe for them
// (S2-10). One place for the rule, shared by get_transcript and add_captions: only what a clip plays is
// transcribed, plus a second either side, and the windows of one file that overlap are one window.
// Pure: no engine, no storage.
import { clipSourceSpanSeconds } from "../timeline/helpers";
import type { Clip } from "../timeline/model";
import { currentPaceModel, type PaceModel } from "./speechPace";
import { planSpans, type SpanWindow } from "./speechPlan";

/** Audio transcribed either side of what a clip plays, so a word its cut clips is heard whole. */
export const SPAN_PAD_S = 1;

/** The SOURCE seconds `clip` plays inside [fromFrame, toFrame) of the timeline, or null. */
export function playedSpan(
  clip: Clip,
  fps: number,
  fromFrame: number,
  toFrame: number,
): [number, number] | null {
  const tin = Number(clip.timeline_in) || 0;
  const tout = Number(clip.timeline_out) || 0;
  const a = Math.max(tin, fromFrame);
  const b = Math.min(tout, toFrame);
  if (!(b > a)) return null;
  const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
  const sourceIn = (Number(clip.source_in) || 0) + (a - tin) * speed;
  return clipSourceSpanSeconds(
    { source_in: sourceIn, timeline_in: a, timeline_out: b, speed },
    fps,
  );
}

/** The stretch transcribed for a clip: what it plays, and {@link SPAN_PAD_S} either side. */
export const padded = (span: readonly [number, number]): { start: number; end: number } => ({
  start: Math.max(0, span[0] - SPAN_PAD_S),
  end: span[1] + SPAN_PAD_S,
});

/** The window to transcribe for each use of a file: the used spans of one file, padded, with the ones
 *  that overlap made one window, so a split clip is one window and not two. The windows depend on the
 *  used spans ALONE (never on this PC's pace): the transcript cache keeps a window under its own range,
 *  so a window that moved after a run would be asked for again. A window that alone passes the cap is
 *  flagged `overCap`, costed on `pace`. Every use gets the window that holds its padded span. */
export function spanWindows<U extends { span: [number, number] }>(
  uses: readonly U[],
  fileOf: (use: U) => string,
  pace: PaceModel = currentPaceModel(),
): Map<U, SpanWindow> {
  const byFile = new Map<string, U[]>();
  for (const use of uses) byFile.set(fileOf(use), [...(byFile.get(fileOf(use)) ?? []), use]);
  const out = new Map<U, SpanWindow>();
  for (const list of byFile.values()) {
    const { windows } = planSpans({
      usedSpans: list.map((use) => use.span),
      padS: SPAN_PAD_S,
      pace,
      mergeGaps: false,
    });
    for (const use of list) {
      const own = padded(use.span);
      const holder = windows.find((w) => w.start <= own.start && own.end <= w.end);
      if (holder) out.set(use, holder);
      else {
        // A span `planSpans` could not read (not a number): its own padded stretch, costed alone.
        const [alone] = planSpans({
          usedSpans: [use.span],
          padS: SPAN_PAD_S,
          pace,
          mergeGaps: false,
        }).windows;
        out.set(use, alone ?? { ...own, projectedS: 0, overCap: false });
      }
    }
  }
  return out;
}
