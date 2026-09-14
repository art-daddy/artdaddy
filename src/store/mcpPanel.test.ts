// The panel and the chat chip render in different places from one store. If they each kept
// their own copy of "is it running", switching the server off in the panel would leave the chip
// lit — the user would believe an external agent still had a way in.
import { describe, expect, it, vi, beforeEach } from "vitest";

import { useMcpPanel } from "./mcpPanel";

const status = vi.hoisted(() => vi.fn());
vi.mock("../mcp/service", async () => {
  const actual = await vi.importActual<typeof import("../mcp/service")>("../mcp/service");
  return { ...actual, mcpStatus: status };
});

beforeEach(() => {
  useMcpPanel.setState({ open: false, running: false });
  status.mockReset();
});

describe("the MCP panel store", () => {
  it("is the single owner of the panel's visibility", () => {
    // Every surface (Help menu, chat chip, empty state) calls these, so opening from one and
    // closing from another has to work.
    useMcpPanel.getState().openPanel();
    expect(useMcpPanel.getState().open).toBe(true);
    useMcpPanel.getState().closePanel();
    expect(useMcpPanel.getState().open).toBe(false);
  });

  it("reports the server's real state, not a hopeful default", async () => {
    status.mockResolvedValue({ running: true, port: 19787 });
    await useMcpPanel.getState().refresh();
    expect(useMcpPanel.getState().running).toBe(true);
  });

  it("goes dark when the status call throws", async () => {
    // The failure direction that matters: no desktop host, or the command errored. Leaving the
    // previous value would light the chip for a server nobody can reach.
    useMcpPanel.setState({ running: true });
    status.mockRejectedValue(new Error("no tauri"));
    await useMcpPanel.getState().refresh();
    expect(useMcpPanel.getState().running).toBe(false);
  });

  it("goes dark when the server reports stopped", async () => {
    useMcpPanel.setState({ running: true });
    status.mockResolvedValue({ running: false, port: 19787 });
    await useMcpPanel.getState().refresh();
    expect(useMcpPanel.getState().running).toBe(false);
  });
});
