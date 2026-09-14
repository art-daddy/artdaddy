// Waking the agent when background work lands.
//
// A generation finishes long after the turn that started it ended, so its result has to re-enter
// the conversation from outside. Four rules decide when:
//
//   this chat only - the wake says "background work YOU started has finished ... continue what you
//                  were doing", so it may only fire for work THIS chat started. Two other drivers
//                  reach the same tools: the Export menu, and an external agent over MCP
//                  (bridge.ts runs the same ToolHost against the same project). Neither is part of
//                  this conversation. Measured on one real project: 12 exports nobody in the chat
//                  asked for produced 8 unattended billed rounds telling the model to carry on
//                  editing a timeline another driver was editing at that moment.
//   idle only    - a resume starts a new billed round. Landing one mid-turn would interleave with
//                  work the user is watching, so a completion arriving while a turn runs waits.
//   coalesced    - the model is told to parallelize independent gens, so several finishing within
//                  seconds of each other is the normal case. Each one waking the agent separately
//                  would cost a round each and read as spam. The window is measured from the FIRST
//                  completion, not the last, so a steady stream still lands.
//   never lost   - with no sink (project closed) the queue simply waits. Registering one delivers
//                  whatever accumulated, which is how a completion survives a switch or a reopen.
export interface SettledJob {
  id: string;
  tool: string;
  label: string;
  status: "done" | "failed";
  /** Who asked for this work. Required, not inferred: only "chat" resumes the conversation, and a
   *  submitter that cannot say defaults to "elsewhere" — the fail-safe direction (a missed wake
   *  costs a message, a wrong one costs a billed round that edits the project). */
  startedBy: "chat" | "elsewhere";
  media_refs?: string[];
  /** For work that produces no library media (an export): what to tell the model instead. */
  detail?: string;
  error?: string;
}

export interface JobSink {
  /** False while a turn is running, a completion is mid-delivery, or approval is pending. */
  isIdle: () => boolean;
  deliver: (jobs: SettledJob[]) => void;
}

/** How long to gather completions before waking the agent once for all of them. */
export const SETTLE_WINDOW_MS = 1500;

const queued = new Map<string, SettledJob[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const sinks = new Map<string, JobSink>();

/** Attach a project's chat. Delivers anything that landed while it was away. */
export function registerJobSink(projectDir: string, sink: JobSink): void {
  sinks.set(projectDir, sink);
  flushJobNotes(projectDir);
}

export function unregisterJobSink(projectDir: string): void {
  sinks.delete(projectDir);
}

/** Record a settled job and schedule the wake. Work another driver started is dropped here rather
 *  than filtered at delivery: it must never occupy the coalescing window either. */
export function notifyJobSettled(projectDir: string, job: SettledJob): void {
  if (job.startedBy !== "chat") return;
  const q = queued.get(projectDir);
  if (q) q.push(job);
  else queued.set(projectDir, [job]);
  // Window runs from the FIRST completion: resetting it on every arrival would let a steady
  // stream postpone the wake indefinitely.
  if (timers.has(projectDir)) return;
  timers.set(
    projectDir,
    setTimeout(() => {
      timers.delete(projectDir);
      flushJobNotes(projectDir);
    }, SETTLE_WINDOW_MS),
  );
}

/** Deliver queued completions if the chat can take them now. Safe to call at any time; the chat
 *  calls it when a turn ends. */
export function flushJobNotes(projectDir: string): void {
  if (timers.has(projectDir)) return; // still gathering
  const sink = sinks.get(projectDir);
  const q = queued.get(projectDir);
  if (!sink || !q?.length || !sink.isIdle()) return;
  // Cleared BEFORE delivering: deliver() starts a turn, and a completion arriving during it must
  // queue for the next wake rather than be dropped or replayed.
  queued.delete(projectDir);
  sink.deliver(q);
}

/** Completions still waiting on this project (for tests and diagnostics). */
export function pendingJobNotes(projectDir: string): readonly SettledJob[] {
  return queued.get(projectDir) ?? [];
}

/** Tests only. */
export function __resetJobNotes(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  queued.clear();
  sinks.clear();
}
