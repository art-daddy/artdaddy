// "An export is being asked": from the moment the person's click (or an assistant's call) becomes a request until the request is admitted or refused, including every question it puts to the person. The queue's own busy flag follows
// only exports that are queued or running, so an export in its question phase is invisible to it; the PC check reads this one instead and stops, and does not start, while an export is asked.
//
// The question that offers the PC check ("Check this PC's speed first?") is itself asked inside a request. It must not count against the very check it offers, so whoever asks it wraps it in `suspendExportAsk`. A suspension belongs to
// the requests that are open when it is made: when the last of them ends it is over, so one that is never released cannot make a later request not count.
let depth = 0;
let suspended = 0;
let generation = 0;
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of [...listeners])
    try {
      fn();
    } catch {
      // A listener's failure is not another's, and never an export's.
    }
}

/** A request for an export has begun. Call the returned function once when it is admitted, refused or ended (more than once is the same as once). */
export function beginExportAsk(): () => void {
  depth++;
  changed();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      suspended = 0;
      generation++;
    }
    changed();
  };
}

/** The person clicked Export: the request has not reached the queue yet (the project's plan is made first, which can take seconds), but the check must stop now. It lets go after `ms` at the latest, or when
 *  the returned function is called, whichever comes first; by then the queue has taken over, or the request has ended. */
export function holdExportAsk(ms = 30_000): () => void {
  const release = beginExportAsk();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(release, Math.max(0, ms));
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    release();
  };
}

/** A question that must not count as "an export is being asked" is pending (the check-first question). Call the returned function when it is answered or gone. Outside any request it asks nothing and does nothing. */
export function suspendExportAsk(): () => void {
  if (depth === 0) return () => undefined;
  suspended++;
  const mine = generation;
  changed();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    if (mine !== generation) return;
    suspended = Math.max(0, suspended - 1);
    changed();
  };
}

/** Whether an export is being asked its questions right now (a pending check-first question does not count). */
export function exportAskedNow(): boolean {
  return depth - suspended > 0;
}

export function subscribeExportAsk(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Tests only. */
export function __resetExportAsk(): void {
  depth = 0;
  suspended = 0;
  generation++;
  listeners.clear();
}
