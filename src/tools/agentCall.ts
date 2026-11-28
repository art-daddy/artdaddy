// Which agent tool call a store view belongs to. The agent's view of the project store (agentStore.ts) answers this
// key with the call it was made for, so whatever that call commits through it (an edit now, or a clip a generation
// places later) is known to be the agent's and whose. The editor's own store has no such key: an edit made through it
// is the person's own (timeline/agentUndo.ts).
import type { AgentEditCall } from "../api/agentEvents";
import type { ProjectStoreAccess } from "./store";

export const AGENT_CALL: unique symbol = Symbol("artdaddy.agentCall");

/** The agent call a store view belongs to; `null` for an agent's view whose call is not known; `undefined` for a store that
 *  is not an agent's at all (the editor's, the person's). */
export function agentCallOf(store: ProjectStoreAccess): AgentEditCall | null | undefined {
  return (store as unknown as { [AGENT_CALL]?: AgentEditCall | null })[AGENT_CALL];
}
