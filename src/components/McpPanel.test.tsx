// The setup pane is the only way a user learns the endpoint exists, so its snippets have to be
// correct. A wrong port here is invisible in every other test and fails as "the agent can't
// connect" — with nothing to point at.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import McpPanel from "./McpPanel";
import { BRAND } from "../brand";
import { openInstallLink } from "../mcp/install";
import { ACTIVE_WINDOW_MS, useMcpConnections } from "../mcp/connections";
import {
  MCP_PORT,
  McpPortTakenError,
  McpStartCancelled,
  clearMcpLastError,
  mcpStatus,
  recordMcpError,
  startMcpServer,
  stopMcpServer,
} from "../mcp/service";
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
  useMcpPanel.setState({ open: false, running: false, starting: false });
  useMcpConnections.getState().clear();
  clearMcpLastError();
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

// A relaunch can leave the old copy holding the port for a few seconds, so the app now waits for it instead of failing
// at once. Whoever opens this pane in that moment must see "starting", not "stopped" with advice to switch it on.
describe("MCP setup pane: while the app waits for the port", () => {
  const stopped = () => vi.mocked(mcpStatus).mockResolvedValue({ running: false, port: MCP_PORT });

  it("says it is starting, not stopped, and does not ask to be switched on", async () => {
    stopped();
    act(() => useMcpPanel.setState({ starting: true }));
    render(<McpPanel />);

    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(screen.getByText(/waits up to 10 seconds/)).toBeInTheDocument();
    expect(screen.queryByText("Stopped")).toBeNull();
    expect(screen.queryByText(/Turn this on before adding/)).toBeNull();
    // Clicking now would start a second series of attempts on the same port.
    expect(screen.getByText("Off").closest("button")).toBeDisabled();
  });

  it("says how a start nobody here asked for ended, in words that name who held the port", async () => {
    stopped();
    act(() => useMcpPanel.setState({ starting: true }));
    render(<McpPanel />);
    expect(screen.queryByText(/It last failed with/)).toBeNull(); // not yet: it is still waiting

    recordMcpError(
      new McpPortTakenError("os error 10048", { holder: "other", process: "node.exe" }),
    );
    act(() => useMcpPanel.setState({ starting: false }));

    expect(await screen.findByText(/another program \(node\.exe\)/)).toBeInTheDocument();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("clears an old failure when the start that was waiting succeeds", async () => {
    stopped();
    recordMcpError(new Error("could not bind 127.0.0.1:19787: os error 10048"));
    act(() => useMcpPanel.setState({ starting: true }));
    render(<McpPanel />);

    clearMcpLastError();
    act(() => useMcpPanel.setState({ starting: false, running: true }));

    expect(screen.queryByText(/It last failed with/)).toBeNull();
    expect(await screen.findByText(/Running on/)).toBeInTheDocument();
  });

  it("asks for the start as the switch, so a wait is counted under the right door", async () => {
    stopped();
    render(<McpPanel />);
    fireEvent.click(await screen.findByText("Off"));
    await waitFor(() =>
      expect(vi.mocked(startMcpServer)).toHaveBeenCalledWith({ where: "toggle" }),
    );
  });

  it("treats a start cancelled by a switch-off as no failure: nothing is shown or reported", async () => {
    stopped();
    clearMcpLastError();
    vi.mocked(startMcpServer).mockRejectedValueOnce(new McpStartCancelled());
    render(<McpPanel />);
    fireEvent.click(await screen.findByText("Off"));
    await waitFor(() => expect(vi.mocked(startMcpServer)).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Off").closest("button")).toBeEnabled());

    expect(reported).toEqual([]);
    expect(screen.queryByText(/It last failed with/)).toBeNull();
  });
});

// Someone who has just pasted the setup into an agent needs to see that it worked. The pane lists the programs that have
// asked for something, says when each last did, and says plainly when nobody has.
describe("MCP setup pane: who has connected", () => {
  const running = () => vi.mocked(mcpStatus).mockResolvedValue({ running: true, port: MCP_PORT });
  const claude = { name: "claude-code", version: "2.1.4" };
  const rows = () =>
    within(screen.getByLabelText("Agents that have connected")).getAllByRole("listitem");

  it("says nobody has connected yet, and where to add the server", async () => {
    running();
    render(<McpPanel />);
    expect(await screen.findByText(/Waiting for an agent to connect/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Agents that have connected")).toBeNull();
  });

  it("names the program, its version, when it last asked and how many times", async () => {
    running();
    act(() => useMcpConnections.getState().asked(claude, Date.now() - 42_000));
    render(<McpPanel />);

    await screen.findByLabelText("Agents that have connected");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Claude Code 2.1.4");
    expect(rows()[0]).toHaveTextContent("last active 42 s ago");
    expect(rows()[0]).toHaveTextContent("1 request");
    expect(screen.queryByText(/Waiting for an agent/)).toBeNull();
  });

  it("shows a new connection as it happens, without reopening the pane", async () => {
    running();
    render(<McpPanel />);
    expect(await screen.findByText(/Waiting for an agent to connect/)).toBeInTheDocument();

    act(() => useMcpConnections.getState().connected(claude));
    act(() => useMcpConnections.getState().asked(claude));
    act(() => useMcpConnections.getState().asked(claude));

    expect(await screen.findByText(/last active just now/)).toBeInTheDocument();
    expect(rows()[0]).toHaveTextContent("2 requests");
  });

  it("shows a program that went quiet as seen earlier, not as connected", async () => {
    running();
    act(() => useMcpConnections.getState().asked(claude, Date.now() - ACTIVE_WINDOW_MS - 60_000));
    act(() => useMcpConnections.getState().asked({ name: "codex", version: "0.5" }, Date.now()));
    render(<McpPanel />);

    await screen.findByLabelText("Agents that have connected");
    const [recent, quiet] = rows();
    expect(recent).toHaveTextContent("Codex");
    expect(recent.querySelector("span")).toHaveClass("bg-emerald-400");
    expect(quiet).toHaveTextContent("Claude Code");
    expect(quiet.querySelector("span")).toHaveClass("bg-neutral-600");
  });

  it("claims nothing while the server is off", async () => {
    vi.mocked(mcpStatus).mockResolvedValue({ running: false, port: MCP_PORT });
    act(() => useMcpConnections.getState().asked(claude));
    render(<McpPanel />);

    expect(await screen.findByText(/Turn this on before adding/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Agents that have connected")).toBeNull();
    expect(screen.queryByText(/Waiting for an agent/)).toBeNull();
  });
});
