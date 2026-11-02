import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  legalClientText,
  MCP_CLIENTS,
  mcpClientFacts,
  normalizeMcpClient,
  type McpClient,
} from "./clientName";

describe("which program connected", () => {
  // Names the programs announce, as far as they are documented or seen. A name not on this list falls to
  // `other` with its own name kept, which is how a new one is found.
  it.each<[string, McpClient]>([
    ["claude-code", "claude_code"],
    ["Claude Code", "claude_code"],
    ["claude_code", "claude_code"],
    ["claude-ai", "claude_desktop"],
    ["Claude Desktop", "claude_desktop"],
    ["Claude", "claude_desktop"],
    ["Visual Studio Code", "vscode"],
    ["vscode-mcp-client", "vscode"],
    ["GitHub Copilot", "vscode"],
    ["github-copilot-developer", "vscode"],
    ["cursor-vscode", "cursor"],
    ["Cursor", "cursor"],
    ["codex", "codex"],
    ["codex-mcp-client", "codex"],
    ["OpenAI Codex CLI", "codex"],
    ["antigravity", "antigravity"],
    ["Antigravity", "antigravity"],
    ["windsurf-client", "windsurf"],
    ["codeium", "windsurf"],
    ["gemini-cli-mcp-client", "gemini_cli"],
    ["zed", "zed"],
    ["mcp-inspector", "inspector"],
    ["some-new-agent", "other"],
  ])("%s is %s", (name, expected) => {
    expect(normalizeMcpClient(name)).toBe(expected);
  });

  it("is unknown when the program said nothing, and never anything else for that", () => {
    for (const nothing of [undefined, null, "", "   ", 7, {}, [], true])
      expect(normalizeMcpClient(nothing), String(nothing)).toBe("unknown");
  });

  it("is a label from the closed list for ANY input, and never throws", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(MCP_CLIENTS).toContain(normalizeMcpClient(input));
      }),
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        expect(MCP_CLIENTS).toContain(normalizeMcpClient(input));
      }),
      { numRuns: 300 },
    );
  });

  it("does not care about case, and a program built on another is the more specific one", () => {
    for (const name of ["CLAUDE-CODE", "claude-code", "Claude-Code"])
      expect(normalizeMcpClient(name)).toBe("claude_code");
    expect(normalizeMcpClient("cursor-vscode")).toBe("cursor");
  });
});

describe("what is kept about it", () => {
  it("keeps the label, the name it gave and its version, in the characters names are made of", () => {
    expect(mcpClientFacts({ name: "Visual Studio Code", version: "1.102.3" })).toEqual({
      client: "vscode",
      name: "Visual_Studio_Code",
      version: "1.102.3",
    });
  });

  it("is empty and unknown for anything that is not a clientInfo", () => {
    for (const bad of [undefined, null, "claude", 5, [], () => 1])
      expect(mcpClientFacts(bad), String(bad)).toEqual({
        client: "unknown",
        name: "",
        version: "",
      });
  });

  it("cuts a long name and version, and lets nothing but the alphabet through, whatever it holds", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), fc.string({ maxLength: 400 }), (name, version) => {
        const facts = mcpClientFacts({ name, version });
        expect(facts.name).toMatch(/^[A-Za-z0-9_.:-]{0,40}$/);
        expect(facts.version).toMatch(/^[A-Za-z0-9_.:-]{0,20}$/);
        expect(MCP_CLIENTS).toContain(facts.client);
      }),
      { numRuns: 300 },
    );
  });

  it("keeps nothing a person could have written into a name: a path or an address becomes underscores", () => {
    const facts = mcpClientFacts({
      name: "C:\\Users\\Ada Lovelace\\agent.exe",
      version: "ada@example.com",
    });
    expect(facts.name).not.toMatch(/[\\ @]/);
    expect(facts.version).not.toMatch(/[@ ]/);
    expect(legalClientText("a b/c", 10)).toBe("a_b_c");
  });
});
