// Where the "Connect an AI agent" panel lives, so anything can open it — the Help menu, the
// chat controls, the assistant's empty state.
//
// `running` sits here rather than inside the panel because the chat chip has to show it too.
// A second copy polled independently would disagree with the panel's own toggle the moment
// someone switched the server off.
import { create } from "zustand";

import { mcpStarting, mcpStatus, onMcpChange } from "../mcp/service";

interface McpPanelState {
  open: boolean;
  running: boolean;
  /** A start is waiting for the port (the boot hook, or the switch), so "Stopped" would be half the truth. */
  starting: boolean;
  openPanel: () => void;
  closePanel: () => void;
  setRunning: (running: boolean) => void;
  refresh: () => Promise<void>;
}

export const useMcpPanel = create<McpPanelState>((set) => ({
  open: false,
  running: false,
  starting: mcpStarting(),
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
  setRunning: (running) => set({ running }),
  refresh: async () => {
    // No desktop host, or the server never started: both mean "not running" to the UI.
    try {
      set({ running: (await mcpStatus()).running });
    } catch {
      set({ running: false });
    }
  },
}));

// The server changes state without anyone on screen asking: the boot hook starts it, and now waits for a port that is
// still being let go instead of failing at once. What the panel and the chip show has to follow that.
onMcpChange(() => {
  useMcpPanel.setState({ starting: mcpStarting() });
  void useMcpPanel.getState().refresh();
});
