// Pure interaction math for the timeline's pointer tools — marquee selection, the razor
// cut point, and track reordering. Kept out of TimelineEditor.tsx so the rules are
// testable without a DOM, matching how geometry.ts already splits from the component.

export interface Span {
  id: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A drag can start at any corner, so order the two points before anything reads them. */
export function normalizeBox(ax: number, ay: number, bx: number, by: number): Box {
  return {
    x0: Math.min(ax, bx),
    y0: Math.min(ay, by),
    x1: Math.max(ax, bx),
    y1: Math.max(ay, by),
  };
}

/** Ids of every span the box TOUCHES. Premiere selects on overlap, not containment —
 *  requiring full containment makes a marquee useless on clips wider than the viewport. */
export function idsInBox(spans: readonly Span[], box: Box): string[] {
  return spans
    .filter((s) => s.x0 <= box.x1 && s.x1 >= box.x0 && s.y0 <= box.y1 && s.y1 >= box.y0)
    .map((s) => s.id);
}

/** Whether a marquee drag is deliberate rather than a click that wobbled. */
export function isMarqueeDrag(box: Box, threshold = 4): boolean {
  return box.x1 - box.x0 >= threshold || box.y1 - box.y0 >= threshold;
}

/** The frame a razor click cuts at, or null when the cut would produce an empty piece.
 *  Splitting exactly on an edge is a no-op that would still cost an undo entry. */
export function razorFrame(
  clip: { timeline_in?: unknown; timeline_out?: unknown },
  frame: number,
): number | null {
  const tin = Number(clip.timeline_in);
  const tout = Number(clip.timeline_out);
  if (!Number.isFinite(tin) || !Number.isFinite(tout)) return null;
  const at = Math.round(frame);
  return at > tin && at < tout ? at : null;
}

/** New z values for a track dragged to another slot WITHIN ITS OWN KIND.
 *
 *  `group` is in DISPLAY order, topmost first, and the topmost track composites ON TOP —
 *  so slot 0 takes the HIGHEST z. Getting that backwards silently inverts the stack: the
 *  label moves where you dropped it while the picture layers the other way.
 *
 *  Only tracks whose z actually changes are returned, because each one is a separate
 *  set_track call and therefore a separate undo entry — an unchanged track must not
 *  contribute one. Video never interleaves with audio, so the two groups reorder
 *  independently and a cross-kind drop is refused rather than silently clamped. */
export function reorderZ(
  group: readonly { id: string; z: number }[],
  movedId: string,
  toIndex: number,
): { id: string; z: number }[] {
  const from = group.findIndex((t) => t.id === movedId);
  if (from < 0) return [];
  const to = Math.max(0, Math.min(group.length - 1, Math.round(toIndex)));
  if (to === from) return [];
  const order = group.map((t) => t.id);
  order.splice(to, 0, ...order.splice(from, 1));
  // Reuse the group's EXISTING z values (highest first, to match display order) so a
  // reorder never renumbers the group onto a different scale and reshuffles it against
  // other kinds.
  const slots = group.map((t) => t.z).sort((a, b) => b - a);
  const out: { id: string; z: number }[] = [];
  order.forEach((id, i) => {
    const before = group.find((t) => t.id === id)!.z;
    if (before !== slots[i]) out.push({ id, z: slots[i] });
  });
  return out;
}
