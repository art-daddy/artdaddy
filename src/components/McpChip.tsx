// The chat's way into the MCP panel, and the one place that shows at a glance whether an outside agent is working here.
import { useEffect } from "react";

import {
  agoLabel,
  isActive,
  leadProgram,
  programState,
  programTitle,
  useMcpConnections,
} from "../mcp/connections";
import { useMcpPanel } from "../store/mcpPanel";
import { cn } from "./ui";
import { useNow } from "./useNow";

/** MCP is the app's most-missed feature because it lived only in the Help menu. Sat next to the
 *  model controls, where someone wondering whether another agent can drive this is already
 *  looking, and named for what it DOES — "MCP" alone means nothing to most people. The dot also
 *  gives the server's state a permanent home — previously the only way to tell it was running
 *  was to reopen the dialog. It says what the program has been SEEN to do and no more: "Connected" and
 *  "can edit this project" only after a tool call, because an agent can connect eleven times, be handed
 *  the tool list and never call a tool, and a chip that said "Connected" then sent the person to look for
 *  the fault in the wrong place. */
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
  const lead = leadProgram(lately);
  const state = lead ? programState(lead) : null;
  const name = lead ? programTitle(lead) : "";
  // "+N" is how many other programs are heard from lately; after "Connected:" it counts only those that used a tool too, so it never reads as two connected when one only listed.
  const others = lately.filter((p) => p !== lead);
  const more = (state === "used" ? others.filter((p) => programState(p) === "used") : others)
    .length;
  const plus = more > 0 ? ` +${more}` : "";
  const label = !lead
    ? "Connect your own agent/MCP"
    : state === "used"
      ? `Connected: ${name}${plus}`
      : `${name}: ${state === "listed" ? "no tool used yet" : "connected"}${plus}`;
  const title = !running
    ? "Let Claude, Cursor or Codex edit this project"
    : !lead
      ? "MCP server is running — waiting for Claude, Cursor or Codex to connect"
      : state === "used"
        ? `${name} used a tool ${agoLabel(now - (lead.lastCallAt ?? lead.lastActiveAt))} and can edit this project`
        : state === "listed"
          ? `${name} has the tool list but has not used a tool yet`
          : lead.requests > 0
            ? `${name} connected and asked for tools, but has not been given the tool list`
            : `${name} connected but has not asked for any tools yet`;

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
