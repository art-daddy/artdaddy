// The setup pane is the only way a user learns the endpoint exists, so its snippets have to be
// correct. A wrong port here is invisible in every other test and fails as "the agent can't
// connect" — with nothing to point at.
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import McpPanel from "./McpPanel";
import { BRAND } from "../brand";
import { MCP_PORT } from "../mcp/service";
import { useMcpPanel } from "../store/mcpPanel";

vi.mock("../mcp/service", async () => {
  const actual = await vi.importActual<typeof import("../mcp/service")>("../mcp/service");
  return {
    ...actual,
    mcpStatus: vi.fn(async () => ({ running: true, port: actual.MCP_PORT })),
    startMcpServer: vi.fn(async () => ({ running: true, port: actual.MCP_PORT })),
    stopMcpServer: vi.fn(async () => ({ running: false, port: actual.MCP_PORT })),
  };
});

const codeBlocks = () =>
  Array.from(document.querySelectorAll("pre")).map((p) => p.textContent ?? "");

// The pane reads `running` from a module-level store now, so one test's refresh would otherwise
// leave the next one thinking the server is up.
beforeEach(() => useMcpPanel.setState({ open: false, running: false }));

describe("MCP setup pane", () => {
  it("advertises the port the server actually binds", () => {
    render(<McpPanel />);
    const blocks = codeBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    // The failure this catches: the pane hard-codes a port that drifts from MCP_PORT, so every
    // snippet the user pastes points somewhere nothing is listening. Only blocks that actually
    // CONFIGURE a connection are checked — Claude Desktop's is install steps, because its
    // config file cannot take a URL at all (see below).
    const configs = blocks.filter((c) => /127\.0\.0\.1|mcpServers|"servers"|--transport/.test(c));
    expect(configs.length).toBeGreaterThan(0);
    for (const code of configs) expect(code).toContain(`127.0.0.1:${MCP_PORT}/mcp`);
  });

  it("never hands Claude Desktop a URL config it cannot use", () => {
    // claude_desktop_config.json is stdio-only: it silently ignores the `"type": "http"` form
    // the other clients take. Shipping one taught people to set up something that could never
    // connect, and a tester lost an evening to it. The connector bundle is the only way in.
    render(<McpPanel />);
    const claude = codeBlocks().find((c) => /Install Extension/i.test(c));
    expect(claude, "the Claude Desktop block should describe installing the bundle").toBeTruthy();
    expect(claude).not.toMatch(/"type"\s*:\s*"http"/);
    expect(claude).not.toContain("mcpServers");
  });

  it("covers the clients that can connect with a URL alone", () => {
    render(<McpPanel />);
    for (const client of ["Claude Code", "Codex", "Cursor", "VS Code / Copilot"]) {
      expect(screen.getByText(client)).toBeInTheDocument();
    }
  });

  it("gives Linux users a complete Claude Code HTTP command", () => {
    render(<McpPanel />);
    expect(codeBlocks().find((code) => code.startsWith("claude mcp add"))).toBe(
      `claude mcp add --transport http ${BRAND.mcpServerName} http://127.0.0.1:${MCP_PORT}/mcp`,
    );
    expect(screen.getByText(/works on Linux, macOS and Windows/i)).toBeInTheDocument();
  });

  it("tells the agent how to reach a project, which nothing else would", () => {
    // An MCP session opens with no project; without this hint the first tool call fails and the
    // user has no idea why.
    render(<McpPanel />);
    expect(screen.getByText(/manage_project/)).toBeInTheDocument();
  });

  it("says it is machine-local, because 'a server is running' otherwise reads as exposed", async () => {
    render(<McpPanel />);
    // Only shown once the status resolves — before that the pane warns it is off instead.
    expect(await screen.findByText(/only from this machine/i)).toBeInTheDocument();
  });

  it("warns while it is stopped, so a failed connection is explained up front", () => {
    render(<McpPanel />);
    expect(screen.getByText(/Turn this on before adding the server/i)).toBeInTheDocument();
  });
});
