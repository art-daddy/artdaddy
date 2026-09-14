// Where the "Connect an AI agent" panel lives, so anything can open it — the Help menu, the
// chat controls, the assistant's empty state.
//
// `running` sits here rather than inside the panel because the chat chip has to show it too.
// A second copy polled independently would disagree with the panel's own toggle the moment
// someone switched the server off.
import { create } from "zustand";

import { mcpStatus } from "../mcp/service";

interface McpPanelState {
  open: boolean;
  running: boolean;
  openPanel: () => void;
  closePanel: () => void;
  setRunning: (running: boolean) => void;
  refresh: () => Promise<void>;
}

export const useMcpPanel = create<McpPanelState>((set) => ({
  open: false,
  running: false,
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
