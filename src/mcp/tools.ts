// The tool surface an external MCP client sees.
//
// Every entry is DERIVED from the live contract (`src/contract`) — the same catalog the in-app
// agent uses. Hand-writing MCP schemas here would make this a third definition of the tool
// surface, alongside the server's definitions.py and the bundled snapshot, and the three would
// drift. The only thing added is `manage_project`, which exists because an MCP session can start
// with nothing open and has no window to click in.
import { BRAND } from "../brand";
import { allTools, paramSchema, type ParamSchema } from "../contract";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: ParamSchema & { type: "object" };
}

/** MCP requires an object schema on every tool; the contract omits `parameters` for no-arg tools. */
const EMPTY_OBJECT: ParamSchema & { type: "object" } = { type: "object", properties: {} };

export const MANAGE_PROJECT: McpTool = {
  name: "manage_project",
  description:
    `List, open, or create ${BRAND.displayName} projects. An MCP session may begin with NO project open, and ` +
    "every other tool acts on the open one — so call this with action='list' and then " +
    "action='open' before reading or editing a timeline. action='current' reports what is open.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string" },
      id: { type: "string" },
      name: { type: "string" },
      aspect: { type: "string" },
      fps: { type: "number" },
    },
    required: ["action"],
  },
};

/** The MCP tool list: every contract tool plus project navigation. Empty until the contract
 *  loads — callers should announce the list only once it is non-empty. */
export function mcpTools(): McpTool[] {
  const tools = allTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toObjectSchema(paramSchema(t.name)),
  }));
  return [...tools, MANAGE_PROJECT];
}

function toObjectSchema(schema: ParamSchema | undefined): ParamSchema & { type: "object" } {
  if (!schema || schema.type !== "object") return EMPTY_OBJECT;
  return { ...schema, type: "object", properties: schema.properties ?? {} };
}
