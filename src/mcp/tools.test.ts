// The MCP tool surface is DERIVED, not authored — these guard that it stays that way.
//
// A hand-maintained MCP schema would be a third definition of the tool surface (server
// definitions.py, bundled snapshot, MCP) and the three would drift silently: an external agent
// would call a tool with parameters the app rejects, and nothing here would fail.
import { beforeEach, describe, expect, it } from "vitest";

import { setContract } from "../contract";
import { MANAGE_PROJECT, mcpTools } from "./tools";

const CATALOG = {
  version: "9.9.9",
  tools: [
    {
      name: "add_clips",
      description: "Place clips on the timeline.",
      expensive: false,
      parameters: {
        type: "object",
        properties: { entries: { type: "array", items: { type: "object" } } },
        required: ["entries"],
      },
    },
    // A tool the contract gives no `parameters` for at all.
    { name: "get_timeline", description: "Read the timeline.", expensive: false },
    { name: "generate_image", description: "Generate an image.", expensive: true },
  ],
};

describe("mcp tool list", () => {
  beforeEach(() => setContract(CATALOG));

  it("exposes every contract tool, so MCP and the in-app agent cannot diverge", () => {
    const names = mcpTools().map((t) => t.name);
    for (const t of CATALOG.tools) expect(names).toContain(t.name);
  });

  it("carries the contract's descriptions through", () => {
    // Without descriptions an external agent has no way to know when to call anything, so an
    // empty description is a broken tool even though the list looks complete.
    const add = mcpTools().find((t) => t.name === "add_clips");
    expect(add?.description).toBe("Place clips on the timeline.");
    for (const tool of mcpTools()) expect(tool.description.length).toBeGreaterThan(0);
  });

  it("passes the contract's JSON Schema through unaltered", () => {
    const add = mcpTools().find((t) => t.name === "add_clips");
    expect(add?.inputSchema).toMatchObject({
      type: "object",
      properties: { entries: { type: "array" } },
      required: ["entries"],
    });
  });

  it("gives a no-parameter tool a valid object schema anyway", () => {
    // MCP clients reject a tool whose inputSchema is not an object schema; the contract simply
    // omits `parameters` for these, so a passthrough would emit `undefined` and break discovery.
    const t = mcpTools().find((x) => x.name === "get_timeline");
    expect(t?.inputSchema.type).toBe("object");
    expect(t?.inputSchema.properties).toEqual({});
  });

  it("adds manage_project, which has no contract entry", () => {
    // The one tool that exists only for MCP: an external session has no window to click in.
    expect(mcpTools().map((t) => t.name)).toContain("manage_project");
    expect(MANAGE_PROJECT.inputSchema.required).toContain("action");
  });

  it("tracks the contract rather than a frozen copy", () => {
    // The failure this catches: someone snapshots the list at module load, and every tool added
    // to the contract afterwards is invisible to external agents until the app is rebuilt.
    const before = mcpTools().length;
    setContract({
      version: "9.9.9",
      tools: [...CATALOG.tools, { name: "brand_new_tool", description: "Added later." }],
    });
    const after = mcpTools();
    expect(after.length).toBe(before + 1);
    expect(after.map((t) => t.name)).toContain("brand_new_tool");
  });

  it("is empty of contract tools before the contract loads", () => {
    // Not a bug, a documented state: the bundled snapshot has no descriptions or schemas, so the
    // list is only worth announcing once the live contract has arrived.
    setContract({ version: "", tools: [] });
    expect(mcpTools()).toEqual([MANAGE_PROJECT]);
  });
});
