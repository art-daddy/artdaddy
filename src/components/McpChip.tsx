// The chat's way into the MCP panel, and the one place that shows at a glance whether an outside agent is working here.
import { useEffect } from "react";

import { agoLabel, isActive, programTitle, useMcpConnections } from "../mcp/connections";
import { useMcpPanel } from "../store/mcpPanel";
import { cn } from "./ui";
import { useNow } from "./useNow";

/** MCP is the app's most-missed feature because it lived only in the Help menu. Sat next to the
 *  model controls, where someone wondering whether another agent can drive this is already
 *  looking, and named for what it DOES — "MCP" alone means nothing to most people. The dot also
 *  gives the server's state a permanent home — previously the only way to tell it was running
 *  was to reopen the dialog. Once a program has asked for something lately it says which one, so
 *  a person who just pasted the setup into Claude Code sees that it worked. */
export default function McpChip() {
  const running = useMcpPanel((s) => s.running);
  const openPanel = useMcpPanel((s) => s.openPanel);
  const refresh = useMcpPanel((s) => s.refresh);
  const programs = useMcpConnections((s) => s.programs);
  const now = useNow(30_000, running && programs.length > 0);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const lately = running ? programs.filter((p) => isActive(p, now)) : [];
  const lead = lately[0];
  const label = lead
    ? `Connected: ${programTitle(lead)}${lately.length > 1 ? ` +${lately.length - 1}` : ""}`
    : "Connect your own agent/MCP";
  const title = !running
    ? "Let Claude, Cursor or Codex edit this project"
    : lead
      ? `${programTitle(lead)} is connected and can edit this project — last active ${agoLabel(now - lead.lastActiveAt)}`
      : "MCP server is running — waiting for Claude, Cursor or Codex to connect";

  return (
    <button
      onClick={openPanel}
      title={title}
      className={cn(
        "flex min-w-0 max-w-full items-center gap-1 rounded px-1.5 py-1 hover:bg-neutral-800",
        running ? "text-brand" : "text-neutral-400",
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", running ? "bg-brand" : "bg-neutral-600")}
      />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
