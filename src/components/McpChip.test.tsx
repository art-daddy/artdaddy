// The chat chip is where a person who just added the server to an agent looks first. It has to say that the agent got
// through, name it, and fall back to the invitation when nobody has asked lately.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import McpChip from "./McpChip";
import { ACTIVE_WINDOW_MS, useMcpConnections } from "../mcp/connections";
import { MCP_PORT, mcpStatus } from "../mcp/service";
import { useMcpPanel } from "../store/mcpPanel";

vi.mock("../mcp/service", async () => {
  const actual = await vi.importActual<typeof import("../mcp/service")>("../mcp/service");
  return { ...actual, mcpStatus: vi.fn(async () => ({ running: false, port: actual.MCP_PORT })) };
});

const claude = { name: "claude-code", version: "2.1.4" };
const codex = { name: "codex", version: "0.5" };
const running = (on: boolean) =>
  vi.mocked(mcpStatus).mockResolvedValue({ running: on, port: MCP_PORT });
const chip = () => screen.getByRole("button");

beforeEach(() => {
  useMcpPanel.setState({ open: false, running: false, starting: false });
  useMcpConnections.getState().clear();
});

describe("the chat chip", () => {
  it("invites a connection while the server is off", async () => {
    running(false);
    render(<McpChip />);
    expect(chip()).toHaveTextContent("Connect your own agent/MCP");
    expect(chip()).toHaveAttribute("title", "Let Claude, Cursor or Codex edit this project");
  });

  it("says it is waiting while the server is on and nobody has asked", async () => {
    running(true);
    render(<McpChip />);
    await vi.waitFor(() => expect(chip().title).toMatch(/waiting for Claude, Cursor or Codex/));
    expect(chip()).toHaveTextContent("Connect your own agent/MCP");
  });

  it("names the program that is asking, and when it last did", async () => {
    running(true);
    act(() => useMcpConnections.getState().asked(claude, Date.now() - 90_000));
    render(<McpChip />);

    await vi.waitFor(() => expect(chip()).toHaveTextContent("Connected: Claude Code"));
    expect(chip().title).toMatch(/Claude Code is connected .* last active 1 min ago/);
  });

  it("says how many more are connected", async () => {
    running(true);
    act(() => {
      useMcpConnections.getState().asked(claude, Date.now() - 2_000);
      useMcpConnections.getState().asked(codex, Date.now());
    });
    render(<McpChip />);
    await vi.waitFor(() => expect(chip()).toHaveTextContent("Connected: Codex +1"));
  });

  it("goes back to the invitation when the only program has gone quiet", async () => {
    running(true);
    act(() => useMcpConnections.getState().asked(claude, Date.now() - ACTIVE_WINDOW_MS - 1_000));
    render(<McpChip />);
    await vi.waitFor(() => expect(chip().title).toMatch(/waiting for Claude, Cursor or Codex/));
    expect(chip()).not.toHaveTextContent("Connected:");
  });

  it("does not say anything is connected when the server is off, even if a program was listed", async () => {
    running(false);
    act(() => useMcpConnections.getState().asked(claude));
    render(<McpChip />);
    await act(async () => undefined);
    expect(chip()).toHaveTextContent("Connect your own agent/MCP");
    expect(chip()).not.toHaveTextContent("Connected:");
  });

  it("opens the panel when clicked", async () => {
    running(true);
    render(<McpChip />);
    fireEvent.click(chip());
    expect(useMcpPanel.getState().open).toBe(true);
  });
});
