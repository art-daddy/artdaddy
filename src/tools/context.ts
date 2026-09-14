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
}
