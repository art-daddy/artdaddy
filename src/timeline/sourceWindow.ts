// Resolving a clip's SOURCE WINDOW (which frames of the media it shows) against
// its LENGTH on the timeline. Backs set_clip_properties' source_in/source_out/
// duration; `trim_clips` was retired in contract 1.7.0 and folded in here.
//
// WHY THIS SHAPE (settled after measuring two models against other NLEs' contract —
// do not re-open without re-reading this):
//
//  * `duration` is the ONLY authority for LENGTH. A lone source edge SLIPS: the
//    clip keeps its length and its position and shows different content. To trim,
//    the model sends `source_in` AND `duration`. This is other NLEs' rule exactly.
//    We probed it: gpt-5.4 sends both and trims correctly; gpt-5.4-mini sends
//    `source_in` alone, slips, and then claims it trimmed. That is a weak-model
//    failure, not a design flaw — Premiere/Resolve/FCP all carry slip as a
//    first-class operation, so the capability has to stay reachable.
//  * Trimming does NOT move the clip. Premiere pins the media (trim the head and
//    the remaining frames stay put, leaving a gap); we hold `timeline_in` instead
//    so no gap ever opens, because weaker models handle gaps badly.
//  * There is no `timeline_in`/`timeline_out` here. set_clip_properties broadcasts
//    the SAME values to every id, so an absolute timeline position would stack N
//    clips on one frame. Every field here is relative (a length) or per-clip (an
//    offset into that clip's OWN source), which is why broadcasting is safe.
//    Position lives in move_clips. other NLEs splits it the same way.
//  * `source_out` is ABSOLUTE (a source frame), not other NLEs' `trimEndFrame`
//    ("frames cut off the tail"), because that is how our clip model stores it and
//    how get_timeline reports it. The cost is that it can point past EOF, which
//    other NLEs' form cannot — hence the clamp below.
//
// PARITY: every window this returns satisfies sourceOut - sourceIn ===
// round(length * speed) — byte-identical to what deriveSourceSpans would compute.
// That is deliberate: it means derive is a no-op over our output and can never
// clobber a source_out the model asked for. Do not "simplify" the rounding here
// without re-checking deriveSourceSpans in engine.ts.

/** What the caller asked for. Absent/null = "not specified". */
export interface SourceWindowRequest {
  sourceIn?: number | null;
  sourceOut?: number | null;
  duration?: number | null;
}

export interface SourceWindowState {
  /** Current source in-point; undefined for a clip that has no window yet. */
  sourceIn: number | undefined;
  /** Current source out-point; undefined for a clip that has no window yet. */
  sourceOut: number | undefined;
  /** Current timeline length in frames (timeline_out - timeline_in). */
  length: number;
  /** Playback multiplier AFTER any speed change in the same call. */
  speed: number;
  /** True when `speed` was changed by this same call. */
  speedChanged: boolean;
  /** Real source length in frames; null when unknown or unbounded (image/text). */
  totalFrames: number | null;
}

export interface SourceWindowResult {
  sourceIn: number;
  sourceOut: number;
  /** New timeline length in frames. */
  length: number;
  /** Everything we silently did differently from the request. */
  notes: string[];
}

const present = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * Resolve a request against a clip's current window.
 *
 * Length authority, highest first:
 *   1. both source edges given -> the window itself sets the length (a trim);
 *      a `duration` that disagrees is ignored and noted, matching add_clips'
 *      source_span-vs-duration rule (coerce + say so, never a hard reject — a
 *      reject loops models that cannot retract the extra field).
 *   2. `duration` given -> that length.
 *   3. `speed` changed alone -> hold the SOURCE content, rescale the length.
 *   4. otherwise -> hold the current length (this is what makes a lone edge slip).
 */
export function resolveSourceWindow(
  req: SourceWindowRequest,
  state: SourceWindowState,
): SourceWindowResult {
  const notes: string[] = [];
  const speed = state.speed > 0 ? state.speed : 1;
  const curIn = present(state.sourceIn) ? state.sourceIn : 0;
  const curConsumed = present(state.sourceOut) ? state.sourceOut - curIn : null;

  const wantIn = present(req.sourceIn) ? Math.round(req.sourceIn) : null;
  const wantOut = present(req.sourceOut) ? Math.round(req.sourceOut) : null;
  const wantDur = present(req.duration) && req.duration >= 1 ? Math.round(req.duration) : null;
  const bothEdges = wantIn !== null && wantOut !== null;

  // Parity is `consumed === round(length * speed)` — deriveSourceSpans' exact
  // formula, so derive is a no-op over our output and can never overwrite a
  // source_out the caller asked for. Below 1x that product rounds to 0 for short
  // clips, so the shortest LEGAL length is the first one that consumes a whole
  // frame; clamping consumed to 1 instead would silently break parity.
  const consumedFor = (len: number): number => Math.round(len * speed);
  const minLength = Math.max(1, Math.ceil(0.5 / speed));
  /** Longest length whose source consumption fits `avail` frames; 0 if none does. */
  const fitLength = (avail: number): number => {
    let len = Math.max(minLength, Math.floor(avail / speed));
    while (len > minLength && consumedFor(len) > avail) len--;
    return consumedFor(len) <= avail ? len : 0;
  };

  let length: number;
  if (bothEdges) {
    length = Math.max(minLength, Math.round((wantOut - wantIn) / speed));
    if (wantDur !== null && wantDur !== length) {
      notes.push(
        `used the source window (${length} frames at ${speed}x); ignored duration=${wantDur} — they disagreed on the length.`,
      );
    }
  } else if (wantDur !== null) {
    length = Math.max(minLength, wantDur);
  } else if (state.speedChanged && curConsumed !== null && curConsumed > 0) {
    length = Math.max(minLength, Math.round(curConsumed / speed));
  } else {
    length = Math.max(minLength, state.length);
  }

  // At speed 1 the caller's span is always representable, so source_out survives
  // exactly. At a fractional speed it may not round-trip through an integer
  // length; we snap by at most a frame and say so, because an unsnapped window
  // fails validateTimeline's parity check (TOL 0.05) and would reject the edit.
  let consumed = consumedFor(length);
  if (bothEdges && consumed !== wantOut - wantIn) {
    notes.push(
      `snapped source_out to ${wantIn + consumed} (asked ${wantOut}) so the window matches a whole number of frames at ${speed}x.`,
    );
  }
  let sIn = wantIn !== null ? wantIn : wantOut !== null ? wantOut - consumed : curIn;

  // A source window can never start before the media does. Hold the LENGTH and
  // slide forward: a slip that runs into the head rail simply stops sliding.
  if (sIn < 0) {
    notes.push(`source_in clamped to 0 (asked for ${sIn}).`);
    sIn = 0;
  }

  const total = state.totalFrames;
  if (present(total) && total > 0) {
    if (consumed > total) {
      // Longer than the whole source — nothing can preserve the length. A head the caller
      // NAMED is still held: moving it would be the silent slip the branch below refuses,
      // and a tail-drag that resets source_in to 0 jumps the picture to different footage.
      const fromHead = wantIn !== null ? fitLength(Math.max(0, total - sIn)) : 0;
      if (fromHead > 0) {
        notes.push(
          `only ${total - sIn} source frames remain after source_in=${sIn}; shortened the clip to ${fromHead} frames.`,
        );
        length = fromHead;
        consumed = consumedFor(fromHead);
      } else {
        // No head named, or the named one sits at/past EOF and can hold nothing.
        const fit = fitLength(total);
        if (fit > 0) {
          sIn = 0;
          length = fit;
          consumed = consumedFor(fit);
          notes.push(
            `source is only ${total} frames long; shortened the clip to ${length} frames.`,
          );
        }
      }
    } else if (sIn + consumed > total) {
      const fit = wantIn !== null ? fitLength(total - sIn) : 0;
      if (fit > 0) {
        // They named the head explicitly — moving it would be a silent slip, the
        // exact failure this whole design exists to prevent. Shorten instead.
        notes.push(
          `only ${total - sIn} source frames remain after source_in=${sIn}; shortened the clip to ${fit} frames.`,
        );
        length = fit;
        consumed = consumedFor(fit);
      } else {
        // The head is free (or cannot hold even one frame), so it absorbs the
        // overrun: the slip stops at the tail rail with its length intact.
        notes.push(`clamped to the end of the source (${total} frames).`);
        sIn = Math.max(0, total - consumed);
      }
    }
  }

  return { sourceIn: sIn, sourceOut: sIn + consumed, length, notes };
}

/** True when the request touches the source window at all. */
export function touchesSourceWindow(req: SourceWindowRequest): boolean {
  return present(req.sourceIn) || present(req.sourceOut);
}
