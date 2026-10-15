// The tool surface an external MCP client sees.
//
// Every entry is DERIVED from the live contract (`src/contract`) — the same catalog the in-app
// agent uses. Hand-writing MCP schemas here would make this a third definition of the tool
// surface, alongside the server's definitions.py and the bundled snapshot, and the three would
// drift. The only thing added is `manage_project`, which exists because an MCP session can start
// with nothing open and has no window to click in.
import { toolDefinition, toolsForSurface, type ParamSchema } from "../contract";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: ParamSchema & { type: "object" };
}

/** MCP requires an object schema on every tool; the contract omits `parameters` for no-arg tools. */
const EMPTY_OBJECT: ParamSchema & { type: "object" } = { type: "object", properties: {} };

const manage = toolDefinition("manage_project");
if (!manage) throw new Error("manage_project is missing from the client catalog");
export const MANAGE_PROJECT: McpTool = {
  name: manage.name,
  description: manage.description ?? "",
  inputSchema: toObjectSchema(manage.parameters),
};

/** The MCP tool list: every contract tool plus project navigation. Empty until the contract
 *  loads — callers should announce the list only once it is non-empty. */
export function mcpTools(): McpTool[] {
  return toolsForSurface("mcp").map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: toObjectSchema(t.parameters),
  }));
}

function toObjectSchema(schema: ParamSchema | undefined): ParamSchema & { type: "object" } {
  if (!schema || schema.type !== "object") return EMPTY_OBJECT;
  return { ...schema, type: "object", properties: schema.properties ?? {} };
}
