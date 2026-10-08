import type { CommandRunner } from "./command";
import type { ProjectStoreAccess } from "./store";
import type { MutationOrigin } from "../project/MutationGate";

// What a client-side tool handler receives: the co-located project store (for
// resolving refs + paths) and a command runner (to spawn binaries).
export interface ClientToolContext {
  store: ProjectStoreAccess;
  runner: CommandRunner;
  /** Abort signal for the current turn (Stop propagation). Threaded into the
   *  command runner (kills a running sidecar) and the /ai proxy calls (cancels a
   *  paid generation). Undefined outside a cancellable turn. */
  signal?: AbortSignal;
  /** The chat execution that initiated this tool run (agent commits only), so the mutation gate can
   *  reject a commit from a SUPERSEDED execution. Absent for manual editor edits (always current). */
  origin?: MutationOrigin;
  /** The same context with its runner no longer bound to the turn, for work a tool hands off to
   *  outlive it (a queued export); that work brings its own signal. Absent where nothing binds it. */
  detach?: () => ClientToolContext;
  /** Work nobody is waiting on: the project's indexer, which took its turn before it started
   *  (`workGate.ts`). Its whisper does not queue among the looks'. Absent: someone is waiting. */
  background?: boolean;
}
