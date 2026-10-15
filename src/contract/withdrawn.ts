// Retained implementations withdrawn by the canonical client catalog. App/MCP discovery,
// dispatch and server adapters derive withdrawal from that same status field.
import { toolDefinitions } from ".";

export const WITHDRAWN_TOOLS: readonly string[] = toolDefinitions()
  .filter((tool) => tool.status === "withdrawn")
  .map((tool) => tool.name);
