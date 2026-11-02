// The setup pane is the only way a user learns the endpoint exists, so its snippets have to be
// correct. A wrong port here is invisible in every other test and fails as "the agent can't
// connect" — with nothing to point at.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import McpPanel from "./McpPanel";
import { BRAND } from "../brand";
import { openInstallLink } from "../mcp/install";
import { MCP_PORT, mcpStatus, startMcpServer, stopMcpServer } from "../mcp/service";
import { useMcpPanel } from "../store/mcpPanel";

const reported = vi.hoisted(() => [] as Array<[string, unknown]>);
vi.mock("../api/appEvents", () => ({
  reportMcpEvent: (event: string, detail?: unknown) => void reported.push([event, detail]),
}));

vi.mock("../mcp/install", async () => {
  const actual = await vi.importActual<typeof import("../mcp/install")>("../mcp/install");
  return {
    ...actual,
    openInstallLink: vi.fn(async () => ({ ok: true as const })),
    installClaudeConnector: vi.fn(async () => ({ ok: true as const })),
  };
});

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
beforeEach(() => {
  useMcpPanel.setState({ open: false, running: false });
  reported.length = 0;
});

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
      `claude mcp add --scope user --transport http ${BRAND.mcpServerName} http://127.0.0.1:${MCP_PORT}/mcp`,
    );
    expect(screen.getByText(/every project on Linux, macOS and Windows/i)).toBeInTheDocument();
  });

  it("uses Cursor's global cross-platform config shape", () => {
    render(<McpPanel />);
    const cursor = codeBlocks().find((code) => code.includes('"mcpServers"'));
    expect(JSON.parse(cursor!)).toEqual({
      mcpServers: {
        [BRAND.mcpServerName]: { url: `http://127.0.0.1:${MCP_PORT}/mcp` },
      },
    });
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

// What the person does here is recorded as which switch they used and which agent they set up: the program's
// label and a word, nothing they typed.
describe("MCP setup pane: what the person does is reported", () => {
  const stopped = () => vi.mocked(mcpStatus).mockResolvedValue({ running: false, port: MCP_PORT });

  it("says the switch was turned on, only once the server really is on", async () => {
    stopped();
    render(<McpPanel />);
    fireEvent.click(await screen.findByText("Off"));
    await waitFor(() => expect(reported).toEqual([["mcp_enabled", undefined]]));
  });

  it("says the switch was turned off", async () => {
    vi.mocked(mcpStatus).mockResolvedValue({ running: true, port: MCP_PORT });
    render(<McpPanel />);
    fireEvent.click(await screen.findByText("On"));
    await waitFor(() => expect(reported).toEqual([["mcp_disabled", undefined]]));
  });

  it("says nothing was switched on when the port is taken, and why, without the raw message", async () => {
    stopped();
    vi.mocked(startMcpServer).mockRejectedValueOnce(
      new Error("could not bind 127.0.0.1:19787: Only one usage of each socket address"),
    );
    render(<McpPanel />);
    fireEvent.click(await screen.findByText("Off"));
    await waitFor(() =>
      expect(reported).toEqual([["mcp_bind_failed", { reason: "port_in_use:toggle" }]]),
    );
    expect(JSON.stringify(reported)).not.toMatch(/127\.0\.0\.1|socket address/);
  });

  it("does not claim a switch the server did not follow", async () => {
    stopped();
    vi.mocked(startMcpServer).mockResolvedValueOnce({ running: false, port: MCP_PORT });
    render(<McpPanel />);
    fireEvent.click(await screen.findByText("Off"));
    await waitFor(() => expect(vi.mocked(startMcpServer)).toHaveBeenCalled());
    await Promise.resolve();
    expect(reported).toEqual([]);
    expect(vi.mocked(stopMcpServer)).not.toHaveBeenCalled();
  });

  it("says which agent's setup was copied, for every agent the pane lists", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<McpPanel />);
    const buttons = screen.getAllByText("Copy");
    expect(buttons).toHaveLength(5);
    for (const button of buttons) fireEvent.click(button);
    await waitFor(() => expect(reported).toHaveLength(5));
    expect(reported.map(([event, detail]) => [event, detail])).toEqual([
      ["mcp_config_written", { client: "cursor", reason: "copy" }],
      ["mcp_config_written", { client: "vscode", reason: "copy" }],
      ["mcp_config_written", { client: "claude_desktop", reason: "copy" }],
      ["mcp_config_written", { client: "claude_code", reason: "copy" }],
      ["mcp_config_written", { client: "codex", reason: "copy" }],
    ]);
  });

  it("says which agent was installed, and nothing when the install did not go through", async () => {
    render(<McpPanel />);
    const [cursor, vscode] = screen.getAllByText("Install");
    fireEvent.click(cursor);
    await waitFor(() => expect(reported).toHaveLength(1));
    expect(reported[0]).toEqual(["mcp_config_written", { client: "cursor", reason: "install" }]);

    vi.mocked(openInstallLink).mockResolvedValueOnce({ ok: false, message: "no handler" });
    fireEvent.click(vscode);
    await waitFor(() => expect(vi.mocked(openInstallLink)).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(reported).toHaveLength(1);
  });
});
