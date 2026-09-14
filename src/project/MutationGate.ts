import type { ProjectId, SessionId } from "./types";
import { ArtDaddyError } from "../lib/errors";

/** Submission after close began. The caller maps this to a `closing` outcome. */
export class ProjectClosingError extends ArtDaddyError {
  readonly code = "project_closing";
  readonly expected = true;
  readonly kind = "closing" as const;
  constructor(message = "the project is closing") {
    super(message);
    this.name = "ProjectClosingError";
  }
}

/** The document changed under a mutation (stale session, revision, or superseded chat
 *  branch/execution). The caller maps this to a `conflict`/`stale_origin` outcome. */
export class MutationConflictError extends ArtDaddyError {
  readonly code = "mutation_conflict";
  readonly expected = true;
  readonly kind = "conflict" as const;
  constructor(message = "the document changed under this mutation") {
    super(message);
    this.name = "MutationConflictError";
  }
}

/** The mutation's abort signal fired before it was admitted. */
export class MutationAbortedError extends ArtDaddyError {
  readonly code = "mutation_aborted";
  readonly expected = true;
  readonly kind = "cancelled" as const;
  constructor(message = "the mutation was aborted before admission") {
    super(message);
    this.name = "MutationAbortedError";
  }
}

/** Identity a chat/agent-originated mutation carries so a superseded branch/execution can be
 *  rejected at the final commit even after an SDK ignores cancellation. */
export interface MutationOrigin {
  readonly chatSessionId: string;
  readonly branchId: number;
  readonly executionId: number;
}

export interface MutationRequest {
  /** A stable operation name (telemetry + errors), e.g. "timeline.commit". */
  readonly operation: string;
  /** The document session the caller captured at SUBMISSION. */
  readonly documentSessionId: SessionId;
  /** Optional chat-branch/execution identity for agent-originated mutations. */
  readonly origin?: MutationOrigin;
  /** Optional cancellation, checked at submission. */
  readonly signal?: AbortSignal;
}

/** The per-lease context. `assertCanCommit()` is called RIGHT BEFORE the synchronous commit to
 *  reject a cancellation/supersede that landed while the mutation waited in the queue; after it
 *  succeeds the commit must finish (non-cancellable). `markCommitted()` is then called AFTER the
 *  mutation actually changed state, so the gate advances the revision ONLY for a real committed
 *  mutation — a read, a no-op, or a rejected/`{ok:false}` commit never calls it and never bumps. */
export interface MutationContext {
  readonly projectId: ProjectId;
  readonly sessionId: SessionId;
  readonly baseRevision: number;
  assertCanCommit(): void;
  markCommitted(): void;
}

/** The one mandatory boundary for authoritative mutations of a document. It is not an optional
 *  guard a caller can forget: a mutation only runs by acquiring a lease through `run()`, which
 *  releases automatically in `finally`. Callbacks execute one at a time in FIFO order. Long work
 *  (download/model/probe) does NOT run here — it stages under the job scope and then requests a
 *  short final commit. `beginClose()` closes admission synchronously, rejects work not yet leased,
 *  and resolves once the one already-leased commit settles. */
export class MutationGate {
  private closing = false;
  private running = false;
  private revision = 0;
  private readonly queue: Array<{ proceed: () => void; reject: (e: Error) => void }> = [];
  private readonly idleWaiters: Array<() => void> = [];
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly projectId: ProjectId,
    private readonly sessionId: SessionId,
    /** Is this agent origin (chat branch/execution) still current? Absent => always current. */
    private readonly isOriginCurrent: (origin: MutationOrigin) => boolean = () => true,
  ) {}

  /** Current committed revision (monotonic). Advances ONLY when a mutation actually changed the
   *  document state — signaled by the operation via `ctx.markCommitted()`. Reads, no-ops, and
   *  rejected / `{ok:false}` commits leave it unchanged, so a consumer can trust a bump means "the
   *  authoritative state changed". */
  currentRevision(): number {
    return this.revision;
  }

  /** Acquire a lease, run `operation`, and release automatically. Preflight (phase, session,
   *  branch, cancellation) happens synchronously at submission; a failure throws before queuing.
   *  The revision advances iff the operation called `ctx.markCommitted()` (a real state change). */
  async run<T>(
    request: MutationRequest,
    operation: (ctx: MutationContext) => Promise<T>,
  ): Promise<T> {
    this.preflight(request);
    await this.acquire();
    // Lease held: no other callback runs until we release.
    const baseRevision = this.revision;
    let committed = false;
    const ctx: MutationContext = {
      projectId: this.projectId,
      sessionId: this.sessionId,
      baseRevision,
      assertCanCommit: () => this.assertCanCommit(request, baseRevision),
      markCommitted: () => {
        committed = true;
      },
    };
    try {
      return await operation(ctx);
    } finally {
      // Advance ONLY for a real committed mutation (markCommitted). A read / no-op / {ok:false} commit
      // never marks, so it never bumps — a spurious bump would falsely signal "the document changed".
      if (committed) this.revision++;
      this.release();
    }
  }

  /** Close admission synchronously, reject every not-yet-leased submission, and resolve once the
   *  one already-leased commit (if any) settles. Idempotent — returns the same promise. */
  beginClose(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const entry of this.queue.splice(0)) entry.reject(new ProjectClosingError());
    this.closePromise = this.waitForIdle();
    return this.closePromise;
  }

  /** Resolve once no commit is running and the queue is empty. */
  waitForIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private preflight(request: MutationRequest): void {
    if (this.closing)
      throw new ProjectClosingError(
        `cannot ${request.operation}: project ${this.projectId} is closing`,
      );
    if (request.documentSessionId !== this.sessionId)
      throw new MutationConflictError(`stale document session for ${request.operation}`);
    if (request.signal?.aborted)
      throw new MutationAbortedError(`${request.operation} aborted before admission`);
    if (request.origin && !this.isOriginCurrent(request.origin))
      throw new MutationConflictError(`superseded chat branch/execution for ${request.operation}`);
  }

  private assertCanCommit(request: MutationRequest, baseRevision: number): void {
    // Lifecycle: we are the currently-leased commit, so `closing` is fine here (beginClose waits
    // for us). Re-check the cross-cutting identity + cancellation that a submission-time preflight
    // can't — the mutation may have waited in the queue behind others, and its signal / branch /
    // session could have changed while it waited:
    if (request.signal?.aborted)
      throw new MutationAbortedError(`${request.operation} aborted while queued`);
    if (request.documentSessionId !== this.sessionId)
      throw new MutationConflictError(`stale document session for ${request.operation}`);
    if (this.revision !== baseRevision)
      throw new MutationConflictError(`revision changed under ${request.operation}`);
    if (request.origin && !this.isOriginCurrent(request.origin))
      throw new MutationConflictError(`superseded chat branch/execution for ${request.operation}`);
  }

  private acquire(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ proceed: resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) {
      this.notifyIdle();
      return;
    }
    this.running = true;
    next.proceed();
  }

  private release(): void {
    this.running = false;
    this.pump();
  }

  private notifyIdle(): void {
    if (this.running || this.queue.length > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
