// The setup pane is the only way a user learns the endpoint exists, so its snippets have to be
// correct. A wrong port here is invisible in every other test and fails as "the agent can't
// connect" — with nothing to point at.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import McpPanel from "./McpPanel";
import { BRAND } from "../brand";
import type { McpClient } from "../mcp/clientName";
import { openInstallLink } from "../mcp/install";
import { ACTIVE_WINDOW_MS, useMcpConnections } from "../mcp/connections";
import { NEXT_STEP, useMcpSetups } from "../mcp/setups";
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
  useMcpPanel.setState({ open: false, running: false, runningSince: null, starting: false });
  useMcpConnections.getState().reset();
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
    fireEvent.click(await screen.findByText("Turn on"));
    await waitFor(() => expect(reported).toEqual([["mcp_enabled", undefined]]));
  });

  it("says the switch was turned off", async () => {
    vi.mocked(mcpStatus).mockResolvedValue({ running: true, port: MCP_PORT });
    render(<McpPanel />);
    fireEvent.click(await screen.findByText("Turn off"));
    await waitFor(() => expect(reported).toEqual([["mcp_disabled", undefined]]));
  });

  it("says nothing was switched on when the port is taken, and why, without the raw message", async () => {
    stopped();
    vi.mocked(startMcpServer).mockRejectedValueOnce(
      new Error("could not bind 127.0.0.1:19787: Only one usage of each socket address"),
    );
    render(<McpPanel />);
    fireEvent.click(await screen.findByText("Turn on"));
    await waitFor(() =>
      expect(reported).toEqual([["mcp_bind_failed", { reason: "port_in_use:toggle" }]]),
    );
    expect(JSON.stringify(reported)).not.toMatch(/127\.0\.0\.1|socket address/);
  });

  it("does not claim a switch the server did not follow", async () => {
    stopped();
    vi.mocked(startMcpServer).mockResolvedValueOnce({ running: false, port: MCP_PORT });
    render(<McpPanel />);
    fireEvent.click(await screen.findByText("Turn on"));
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
    expect(buttons).toHaveLength(6);
    for (const button of buttons) fireEvent.click(button);
    await waitFor(() => expect(reported).toHaveLength(6));
    expect(reported.map(([event, detail]) => [event, detail])).toEqual([
      ["mcp_config_written", { client: "cursor", reason: "copy" }],
      ["mcp_config_written", { client: "vscode", reason: "copy" }],
      ["mcp_config_written", { client: "claude_desktop", reason: "copy" }],
      ["mcp_config_written", { client: "claude_code", reason: "copy" }],
      ["mcp_config_written", { client: "codex", reason: "copy" }],
      ["mcp_config_written", { client: "antigravity", reason: "copy" }],
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
    expect(screen.queryByText("MCP server is off")).toBeNull();
    expect(screen.queryByText(/Turn this on before adding/)).toBeNull();
    // Clicking now would start a second series of attempts on the same port.
    expect(screen.getByText("Turn on").closest("button")).toBeDisabled();
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
    expect(screen.getByText("MCP server is off")).toBeInTheDocument();
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
    fireEvent.click(await screen.findByText("Turn on"));
    await waitFor(() =>
      expect(vi.mocked(startMcpServer)).toHaveBeenCalledWith({ where: "toggle" }),
    );
  });

  it("treats a start cancelled by a switch-off as no failure: nothing is shown or reported", async () => {
    stopped();
    clearMcpLastError();
    vi.mocked(startMcpServer).mockRejectedValueOnce(new McpStartCancelled());
    render(<McpPanel />);
    fireEvent.click(await screen.findByText("Turn on"));
    await waitFor(() => expect(vi.mocked(startMcpServer)).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Turn on").closest("button")).toBeEnabled());

    expect(reported).toEqual([]);
    expect(screen.queryByText(/It last failed with/)).toBeNull();
  });
});

// Someone who has just pasted the setup into an agent needs to see that it worked. The pane lists the programs that have
// asked for something, says when each last did, and says plainly when nobody has.
describe("MCP setup pane: who has connected", () => {
  const running = () => vi.mocked(mcpStatus).mockResolvedValue({ running: true, port: MCP_PORT });
  const claude = { name: "claude-code", version: "2.1.4" };
  const cursor = { name: "cursor-vscode", version: "1.0.0" };
  const rows = () =>
    within(screen.getByLabelText("Agents that have connected")).getAllByRole("listitem");

  it("says nobody has connected yet, and where to add the server", async () => {
    running();
    render(<McpPanel />);
    expect(await screen.findByText(/Waiting for an agent to connect/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Agents that have connected")).toBeNull();
  });

  it("names the program, its version, when it last used a tool and how many calls it made", async () => {
    running();
    act(() => {
      const s = useMcpConnections.getState();
      s.asked(claude, Date.now() - 45_000);
      s.answered(claude, "list", Date.now() - 44_000);
      s.answered(claude, "call", Date.now() - 42_000);
    });
    render(<McpPanel />);

    await screen.findByLabelText("Agents that have connected");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Claude Code 2.1.4");
    expect(rows()[0]).toHaveTextContent(/last tool call (42|43) s ago/); // the clock moves a little between the two readings
    expect(rows()[0]).toHaveTextContent("1 call");
    expect(screen.queryByText(/Waiting for an agent/)).toBeNull();
  });

  it("shows a connection as it moves on, without reopening the pane: hello, refused, tool list, tool call", async () => {
    running();
    render(<McpPanel />);
    expect(await screen.findByText(/Waiting for an agent to connect/)).toBeInTheDocument();

    act(() => useMcpConnections.getState().connected(claude));
    expect(await screen.findByText(/has not asked for tools yet/)).toBeInTheDocument();

    act(() => useMcpConnections.getState().asked(claude)); // asked, and refused: no tool list came back
    act(() => useMcpConnections.getState().asked(claude));
    expect(
      await screen.findByText(/asked for tools, but has not been given the tool list/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/has the tool list/)).toBeNull();

    act(() => useMcpConnections.getState().answered(claude, "list"));
    expect(await screen.findByText(/has the tool list · no tool used yet/)).toBeInTheDocument();

    act(() => useMcpConnections.getState().answered(claude, "call"));
    expect(await screen.findByText(/last tool call just now · 1 call/)).toBeInTheDocument();
    expect(screen.queryByText(/no tool used yet/)).toBeNull();
  });

  it("shows a program that went quiet as seen earlier, not as connected", async () => {
    running();
    act(() => {
      const s = useMcpConnections.getState();
      s.asked(claude, Date.now() - ACTIVE_WINDOW_MS - 60_000);
      s.answered(claude, "call", Date.now() - ACTIVE_WINDOW_MS - 60_000);
      s.asked({ name: "codex", version: "0.5" }, Date.now());
      s.answered({ name: "codex", version: "0.5" }, "call", Date.now());
    });
    render(<McpPanel />);

    await screen.findByLabelText("Agents that have connected");
    const [recent, quiet] = rows();
    expect(recent).toHaveTextContent("Codex");
    expect(recent.querySelector("span")).toHaveClass("bg-emerald-400");
    expect(quiet).toHaveTextContent("Claude Code");
    expect(quiet.querySelector("span")).toHaveClass("bg-neutral-600");
  });

  // UJ-085: the three states look different at a glance, and the warning for a program that holds the tool list and never uses a tool only
  // appears after three minutes, because a model may simply not have been asked to do anything yet.
  it("draws a hollow dot for a program that has only said hello, amber for one with the tool list, green for one that used a tool", async () => {
    running();
    act(() => {
      const s = useMcpConnections.getState();
      s.connected({ name: "codex", version: "0.5" }, Date.now() - 3_000);
      s.asked(cursor, Date.now() - 2_000);
      s.answered(cursor, "list", Date.now() - 2_000);
      s.asked(claude, Date.now() - 1_000);
      s.answered(claude, "call", Date.now() - 1_000);
    });
    render(<McpPanel />);
    await screen.findByLabelText("Agents that have connected");
    const dots = Object.fromEntries(
      rows().map((row) => [
        row.textContent?.split(" ")[0] ?? "",
        row.querySelector("span")?.className ?? "",
      ]),
    );
    expect(dots["Claude"]).toContain("bg-emerald-400");
    expect(dots["Cursor"]).toContain("bg-amber-400");
    expect(dots["Codex"]).toContain("border");
    expect(dots["Codex"]).not.toContain("bg-");
  });

  it("warns that a program has held the tool list for three minutes without using a tool, and not before", async () => {
    running();
    act(() => {
      const s = useMcpConnections.getState();
      s.asked(cursor, Date.now() - 2 * 60_000);
      s.answered(cursor, "list", Date.now() - (3 * 60_000 - 5_000));
    });
    const view = render(<McpPanel />);
    await screen.findByLabelText("Agents that have connected");
    expect(screen.queryByText(/has had the tool list for 3 minutes/)).toBeNull();
    view.unmount();

    act(() => {
      useMcpConnections.getState().clear();
      useMcpConnections.getState().asked(cursor, Date.now() - 4 * 60_000);
      useMcpConnections.getState().answered(cursor, "list", Date.now() - 3 * 60_000);
    });
    render(<McpPanel />);
    expect(
      await screen.findByText(
        "Cursor has had the tool list for 3 minutes and has not used a tool. If it shows an error or no tools, check its MCP log, then restart it.",
      ),
    ).toBeInTheDocument();
  });

  it("drops the warning once the program uses a tool", async () => {
    running();
    act(() => {
      const s = useMcpConnections.getState();
      s.asked(cursor, Date.now() - 6 * 60_000);
      s.answered(cursor, "list", Date.now() - 5 * 60_000);
    });
    render(<McpPanel />);
    expect(await screen.findByText(/has had the tool list for 3 minutes/)).toBeInTheDocument();
    act(() => useMcpConnections.getState().answered(cursor, "call"));
    await waitFor(() => expect(screen.queryByText(/has had the tool list/)).toBeNull());
    expect(rows()[0]).toHaveTextContent("last tool call just now");
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

// UJ-085: 8 of the 11 people who set up Claude Desktop, Cursor, VS Code or Claude Code never connected, and nothing said so. A setup that
// was written (copied or installed) and has produced nothing says so after three minutes, under that app's entry, with that app's next step.
describe("MCP setup pane: a setup that has produced nothing", () => {
  const running = () => vi.mocked(mcpStatus).mockResolvedValue({ running: true, port: MCP_PORT });
  const written = (client: McpClient, minutesAgo: number) =>
    act(() => useMcpSetups.getState().wrote(client, Date.now() - minutesAgo * 60_000));
  const hintFor = (label: string) =>
    screen.queryByText(new RegExp(`nothing from ${label} has connected yet`));
  // the server has been up for a while (the three minutes are counted from the later of the setup and the server coming up)
  const serverUp = (minutesAgo = 30) =>
    act(() =>
      useMcpPanel.setState({ running: true, runningSince: Date.now() - minutesAgo * 60_000 }),
    );

  beforeEach(() => useMcpSetups.getState().clear());

  it("says, under that app's entry, how long ago it was set up and what to do next", async () => {
    running();
    serverUp();
    written("claude_desktop", 4);
    render(<McpPanel />);
    expect(
      await screen.findByText(
        "Set up 4 min ago, and nothing from Claude Desktop has connected yet. Next: Open Settings → Extensions, install artdaddy.mcpb, then restart Claude Desktop.",
      ),
    ).toBeInTheDocument();
    // only that app's entry carries it
    expect(hintFor("Cursor")).toBeNull();
    expect(hintFor("Codex")).toBeNull();
  });

  it("is silent until three minutes have passed", async () => {
    running();
    written("codex", 2);
    render(<McpPanel />);
    await screen.findByText(/Waiting for an agent to connect/);
    expect(hintFor("Codex")).toBeNull();
  });

  it("goes the moment a program of that kind connects (setup first, connection later)", async () => {
    running();
    serverUp();
    written("cursor", 5);
    render(<McpPanel />);
    expect(await screen.findByText(/nothing from Cursor has connected yet/)).toBeInTheDocument();
    act(() => useMcpConnections.getState().connected({ name: "cursor-vscode", version: "1.0.0" }));
    await waitFor(() => expect(hintFor("Cursor")).toBeNull());
  });

  // The witness flipped the switch four times: the list of connected programs is emptied each time the server goes down, but an app that DID
  // connect in this run must never be reported as one that never did, and a server that has only just come back has not had three minutes.
  it("never says an app that connected earlier in this run never connected, after the switch was turned off and on", async () => {
    running();
    serverUp();
    written("cursor", 12);
    act(() => useMcpConnections.getState().connected({ name: "cursor-vscode", version: "1.0.0" }));
    act(() => useMcpConnections.getState().clear()); // what stopping the server does
    render(<McpPanel />);
    await screen.findByText(/Waiting for an agent to connect/);
    expect(hintFor("Cursor")).toBeNull();
  });

  it("does not say a setup has produced nothing while the server has only just come back up", async () => {
    running();
    serverUp(1); // up for one minute: the setup is old, the server is not
    written("codex", 20);
    render(<McpPanel />);
    await screen.findByText(/Waiting for an agent to connect/);
    expect(hintFor("Codex")).toBeNull();
  });

  it("never shows for an app that connected before the setup was written, and not for one of another kind", async () => {
    running();
    serverUp();
    act(() => useMcpConnections.getState().connected({ name: "codex", version: "0.5" }));
    written("codex", 10);
    written("vscode", 10);
    render(<McpPanel />);
    expect(
      await screen.findByText(/nothing from VS Code \/ Copilot has connected yet/),
    ).toBeInTheDocument();
    expect(hintFor("Codex")).toBeNull();
  });

  it("says nothing while the server is off", async () => {
    vi.mocked(mcpStatus).mockResolvedValue({ running: false, port: MCP_PORT });
    written("claude_code", 10);
    render(<McpPanel />);
    expect(await screen.findByText(/Turn this on before adding/)).toBeInTheDocument();
    expect(hintFor("Claude Code")).toBeNull();
  });

  it("is written by the real Copy and Install buttons, and every app the pane lists has a next step to give", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    running();
    render(<McpPanel />);
    for (const button of screen.getAllByText("Copy")) fireEvent.click(button);
    await waitFor(() => expect(Object.keys(useMcpSetups.getState().written)).toHaveLength(6));
    // anchored to the pane's own list: an app added to it without a next step fails here
    for (const client of Object.keys(useMcpSetups.getState().written))
      expect(NEXT_STEP[client as McpClient], client).toBeTruthy();

    useMcpSetups.getState().clear();
    fireEvent.click(screen.getAllByText("Install")[0]); // Cursor
    await waitFor(() => expect(Object.keys(useMcpSetups.getState().written)).toEqual(["cursor"]));
  });

  it("does not remember a setup whose install did not go through", async () => {
    running();
    vi.mocked(openInstallLink).mockResolvedValueOnce({ ok: false, message: "no handler" });
    render(<McpPanel />);
    fireEvent.click(screen.getAllByText("Install")[1]);
    await waitFor(() => expect(vi.mocked(openInstallLink)).toHaveBeenCalled());
    await Promise.resolve();
    expect(useMcpSetups.getState().written).toEqual({});
  });
});

// UJ-085: the server starts ON, so the first press on a button that only said "On" turned it OFF (4 of the 5 people with switch confusion). The
// state is in words and the action is named, in both states and while it starts.
describe("MCP setup pane: the switch says its state and its action", () => {
  const sw = () => screen.getByRole("switch", { name: /MCP server/ });

  it("on: 'MCP server is on' with Turn off, checked", async () => {
    vi.mocked(mcpStatus).mockResolvedValue({ running: true, port: MCP_PORT });
    render(<McpPanel />);
    expect(await screen.findByText("MCP server is on")).toBeInTheDocument();
    expect(sw()).toHaveAttribute("aria-checked", "true");
    expect(sw()).toHaveTextContent("Turn off");
    expect(screen.getByText(/Running on/)).toBeInTheDocument();
  });

  it("off: 'MCP server is off' with Turn on, unchecked, and why that matters", async () => {
    vi.mocked(mcpStatus).mockResolvedValue({ running: false, port: MCP_PORT });
    render(<McpPanel />);
    expect(await screen.findByText("MCP server is off")).toBeInTheDocument();
    expect(sw()).toHaveAttribute("aria-checked", "false");
    expect(sw()).toHaveTextContent("Turn on");
    expect(screen.getByText("Agents cannot connect until you turn it on.")).toBeInTheDocument();
  });

  it("starting: says so, and cannot be pressed", () => {
    vi.mocked(mcpStatus).mockResolvedValue({ running: false, port: MCP_PORT });
    act(() => useMcpPanel.setState({ starting: true }));
    render(<McpPanel />);
    expect(screen.getByText("MCP server is starting")).toBeInTheDocument();
    expect(sw()).toBeDisabled();
  });

  it("the first press on a server that is on does what the button says: it turns it off, and the words follow", async () => {
    vi.mocked(mcpStatus).mockResolvedValue({ running: true, port: MCP_PORT });
    render(<McpPanel />);
    fireEvent.click(await screen.findByText("Turn off"));
    await waitFor(() => expect(vi.mocked(stopMcpServer)).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("MCP server is off")).toBeInTheDocument();
    expect(sw()).toHaveTextContent("Turn on");
  });
});

// UJ-085: the dialog had no height limit, so at the app's 820 px-high window its title, the "MCP server" row and the switch ran off the top as soon as a
// program was listed and could not be clicked. The panel body scrolls inside a cap that leaves room for the title and the Close button. (The live check
// is in the replay.)
describe("the dialog that holds the pane", () => {
  it("keeps the pane inside a scroll container with a viewport-relative height cap, so its title and Close stay on screen", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/components/MenuBar.tsx"), "utf8");
    const from = source.indexOf('title="Connect an AI agent"');
    const to = source.indexOf("</Overlay>", from);
    expect(from, "the dialog moved: the check needs updating").toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    // a cap of at least 9rem leaves room for the title, the padding and the Close row inside an 820 px-high window
    expect(source.slice(from, to)).toMatch(
      /<div className="[^"]*max-h-\[calc\(100vh-(9|[12][0-9])(\.[0-9]+)?rem\)\][^"]*overflow-y-auto[^"]*">\s*<McpPanel \/>\s*<\/div>/,
    );
  });
});

describe("the entry for Antigravity", () => {
  const entry = () => screen.getByText("Antigravity").closest("div.mt-3") as HTMLElement;

  it("is copy-only, with the server's address under the key Antigravity reads (`url`), and names its config file", () => {
    render(<McpPanel />);
    expect(within(entry()).queryByText("Install")).toBeNull();
    expect(within(entry()).getByText("Copy")).toBeInTheDocument();
    const snippet = entry().querySelector("pre")!.textContent!;
    expect(JSON.parse(snippet)).toEqual({
      mcpServers: { [BRAND.mcpServerName]: { url: `http://127.0.0.1:${MCP_PORT}/mcp` } },
    });
    expect(snippet).not.toContain("serverUrl"); // the legacy spelling
    expect(entry()).toHaveTextContent("~/.gemini/config/mcp_config.json");
  });
});
