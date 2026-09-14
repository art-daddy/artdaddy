// How long the playhead waits for the picture to catch up.
//
// The preview decodes off-thread, so at the start of playback (and after an edit swaps a
// decoder) there is a beat with no frame to show. The clock used to run straight through it:
// the playhead moved, audio played, and the canvas held one stale frame until decode caught
// up — so the user lost those seconds of their own video and heard them out of sync.
//
// Holding is only correct if it is BOUNDED. A source that never decodes must not freeze
// playback forever, and the worker cannot always know that it never will, so the wait has a
// ceiling: past it the clock runs regardless and the preview degrades to the old behaviour
// rather than deadlocking.
export const MAX_STALL_MS = 2000;

export class StallGate {
  private starved = false;
  private waitedMs = 0;

  constructor(private readonly ceilingMs: number = MAX_STALL_MS) {}

  /** Latest word from the preview worker. Recovery resets the budget, so a later stall
   *  gets its own full wait rather than inheriting an exhausted one. */
  setStarved(v: boolean): void {
    if (v === this.starved) return;
    this.starved = v;
    this.waitedMs = 0;
  }

  /** Whether the clock should HOLD this tick. Call exactly once per frame: it spends the
   *  wait budget. */
  hold(dtMs: number): boolean {
    if (!this.starved) return false;
    if (this.waitedMs >= this.ceilingMs) return false;
    this.waitedMs += Math.max(0, dtMs);
    return true;
  }

  /** A fresh press of play gets a full wait budget.
   *
   *  Deliberately does NOT clear `starved`: the worker owns that and only reports EDGES, so
   *  a gate that assumed "not starved" here would sit through the exact case this exists for
   *  - play pressed while the decoder is still cold, with no further message coming. */
  reset(): void {
    this.waitedMs = 0;
  }
}
