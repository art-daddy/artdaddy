// Connect-an-agent pane: what the port is, whether it's live, and the exact config to paste.
//
// The server is useless without this — an external agent can only reach the app if the user knows
// the endpoint exists. established desktop NLEs ships the same thing (Help > MCP Instructions) for the same
// reason, alongside the Settings toggle.
import { useEffect, useState } from "react";

import { BRAND } from "../brand";
import { reportMcpEvent } from "../api/appEvents";
import {
  claudeCodeCommand,
  cursorConfigJson,
  cursorInstallUrl,
  installClaudeConnector,
  type InstallOutcome,
  openInstallLink,
  vscodeInstallUrl,
} from "../mcp/install";
import type { McpClient } from "../mcp/clientName";
import {
  MCP_BIND_WAIT_MS,
  MCP_PORT,
  McpStartCancelled,
  clearMcpLastError,
  mcpBindFailureReason,
  mcpLastError,
  recordMcpError,
  setMcpEnabledPreference,
  startMcpServer,
  stopMcpServer,
} from "../mcp/service";
import {
  agoLabel,
  isActive,
  programState,
  programTitle,
  useMcpConnections,
  type ConnectedProgram,
} from "../mcp/connections";
import { setupHint, useMcpSetups } from "../mcp/setups";
import { useMcpPanel } from "../store/mcpPanel";
import { Button, cn } from "./ui";
import { useNow } from "./useNow";

const endpoint = `http://127.0.0.1:${MCP_PORT}/mcp`;
// Must match the name mcp.rs advertises, since this is what the user pastes.
const server = BRAND.mcpServerName;

type Client = {
  label: string;
  /** The label this program is counted under (the same list a connecting program is normalised to). */
  client: McpClient;
  code: string;
  note?: string;
  /** Editors that can register a server from a URL. The config below stays as the fallback:
   *  the link does nothing if that editor is not installed. */
  install?: () => string;
  /** Clients we install directly rather than through a url handler, so the attempt can report
   *  a real reason instead of "the OS accepted it". */
  installer?: () => Promise<InstallOutcome>;
};

const CLIENTS: Client[] = [
  {
    label: "Cursor",
    client: "cursor",
    install: cursorInstallUrl,
    note: "or add to ~/.cursor/mcp.json",
    code: cursorConfigJson(),
  },
  {
    label: "VS Code / Copilot",
    client: "vscode",
    install: () => vscodeInstallUrl(),
    note: "or add to .vscode/mcp.json",
    code: `{
  "servers": {
    "${server}": { "type": "http", "url": "${endpoint}" }
  }
}`,
  },
  {
    label: "Claude Desktop",
    client: "claude_desktop",
    installer: installClaudeConnector,
    note: "Windows/macOS. Install saves the connector and shows you where it is.",
    // NOT a config snippet: claude_desktop_config.json is stdio-only and silently ignores the
    // `"type": "http"` form the other clients use, so pasting one here taught people to set up
    // something that could never connect. These are the steps that actually work.
    code: `1. Press Install above (saves artdaddy.mcpb and opens the folder)
2. Claude Desktop -> Settings -> Extensions -> Install Extension
3. Choose artdaddy.mcpb

ArtDaddy must be running for Claude to reach it.`,
  },
  // CLI-only: neither ships a URL handler, so a button here could only shell out to their
  // binary, which this app is not allowed to do.
  {
    label: "Claude Code",
    client: "claude_code",
    note: "installs for every project on Linux, macOS and Windows while ArtDaddy is running",
    code: claudeCodeCommand(),
  },
  { label: "Codex", client: "codex", code: `codex mcp add ${server} --url ${endpoint}` },
  // Copy only: Antigravity has no URL handler to install from. The file, the key (`url`; `serverUrl` is the old spelling) and the transport (Streamable HTTP, which is
  // what this server speaks) are what its own installed documentation says; not yet seen running.
  {
    label: "Antigravity",
    client: "antigravity",
    note: "or add to ~/.gemini/config/mcp_config.json, then restart Antigravity",
    code: `{
  "mcpServers": {
    "${server}": { "url": "${endpoint}" }
  }
}`,
  },
];

function Snippet({ label, client, code, note, install, installer }: Client) {
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState("");
  const [hint, setHint] = useState("");
  const [done, setDone] = useState(false);
  const writtenAt = useMcpSetups((s) => s.written[client]);
  const wrote = useMcpSetups((s) => s.wrote);
  const programs = useMcpConnections((s) => s.programs);
  const running = useMcpPanel((s) => s.running);
  const now = useNow(10_000, running && writtenAt !== undefined);
  // A setup that was written and has produced nothing: said under that app's entry only, never on the chip.
  const nudge = setupHint(client, writtenAt, programs, now, running);

  const run = async (): Promise<InstallOutcome> =>
    installer ? await installer() : await openInstallLink(install!());

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-neutral-300">{label}</span>
        <div className="flex items-center gap-2">
          {(install || installer) && (
            <Button
              variant="primary"
              onClick={() => {
                setFailure("");
                setHint("");
                setDone(false);
                void run().then((r) => {
                  if (r.ok) {
                    setDone(true);
                    wrote(client);
                    reportMcpEvent("mcp_config_written", { client, reason: "install" });
                    // An instruction must not vanish on a timer the way a tick can: this is the
                    // step the user still has to perform, not a confirmation that it is done.
                    if (r.message) setHint(r.message);
                    setTimeout(() => setDone(false), 2000);
                  } else setFailure(r.message);
                });
              }}
            >
              {done ? "Opened" : "Install"}
            </Button>
          )}
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(code).then(() => {
                setCopied(true);
                wrote(client);
                reportMcpEvent("mcp_config_written", { client, reason: "copy" });
                setTimeout(() => setCopied(false), 1200);
              });
            }}
            className="text-[11px] text-neutral-500 hover:text-neutral-200"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      {failure && <p className="text-[11px] text-amber-400">{failure}</p>}
      {hint && <p className="text-[11px] text-emerald-400">{hint}</p>}
      {nudge && (
        <p className="text-[11px] text-amber-400">
          Set up {nudge.ago}, and nothing from {label} has connected yet. Next: {nudge.next}
        </p>
      )}
      {note && <p className="text-[11px] text-neutral-500">{note}</p>}
      <pre className="mt-1 overflow-x-auto rounded border border-edge bg-black/40 p-2 text-[11px] leading-relaxed text-neutral-300">
        {code}
      </pre>
    </div>
  );
}

/** How long a program may hold the tool list without using a tool before the panel says so. */
const LISTED_WARNING_AFTER_MS = 3 * 60_000;

/** What a program has been SEEN to do, in words: it said hello, it was given the tool list, it used a tool. */
function programDetail(p: ConnectedProgram, now: number): string {
  switch (programState(p)) {
    case "used":
      return `last tool call ${agoLabel(now - (p.lastCallAt ?? p.lastActiveAt))} · ${p.calls} ${p.calls === 1 ? "call" : "calls"}`;
    case "listed":
      return "has the tool list · no tool used yet";
    default:
      return p.requests > 0
        ? `connected ${agoLabel(now - p.connectedAt)} · asked for tools, but has not been given the tool list`
        : `connected ${agoLabel(now - p.connectedAt)} · has not asked for tools yet`;
  }
}

/** Who has connected since the server came up, and how far each got, so a person who just added it to an agent can see whether it worked.
 *  Over HTTP there is no connection to show, only requests: a line says what the program was seen to do, never more. */
function ConnectedPrograms() {
  const programs = useMcpConnections((s) => s.programs);
  const now = useNow(5_000, programs.length > 0);

  if (programs.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-neutral-500">
        Waiting for an agent to connect. Add the server to one of the apps below.
      </p>
    );
  }
  return (
    <ul className="mt-2 space-y-1" aria-label="Agents that have connected">
      {programs.map((p) => {
        const state = programState(p);
        const stuck =
          state === "listed" && p.listedAt !== null && now - p.listedAt >= LISTED_WARNING_AFTER_MS;
        return (
          <li key={p.key} className="text-[11px] text-neutral-300">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  !isActive(p, now)
                    ? "bg-neutral-600"
                    : state === "used"
                      ? "bg-emerald-400"
                      : state === "listed"
                        ? "bg-amber-400"
                        : "border border-neutral-500",
                )}
              />
              <span className="min-w-0 truncate">
                {programTitle(p)}
                {p.version ? ` ${p.version}` : ""}
              </span>
              <span className="shrink-0 text-neutral-500">· {programDetail(p, now)}</span>
            </div>
            {stuck && (
              <p className="mt-0.5 pl-3 text-amber-400">
                {programTitle(p)} has had the tool list for 3 minutes and has not used a tool. If it
                shows an error or no tools, check its MCP log, then restart it.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function McpPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(mcpLastError());
  const running = useMcpPanel((s) => s.running);
  const starting = useMcpPanel((s) => s.starting);
  const setRunning = useMcpPanel((s) => s.setRunning);
  const refresh = useMcpPanel((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A start that nobody here asked for (the app's own boot) can end while this is open: say how it ended.
  useEffect(() => {
    if (!starting) setError(mcpLastError());
  }, [starting]);

  // Driven by whether the server IS running, never by the stored preference. Those disagree
  // exactly when the user needs this panel — a boot failure left the button reading "On" above
  // the word "Stopped", and clicking it turned the preference OFF instead of starting anything.
  const toggle = async () => {
    const next = !running;
    setBusy(true);
    setMcpEnabledPreference(next);
    try {
      const s = next ? await startMcpServer({ where: "toggle" }) : await stopMcpServer();
      setRunning(s.running);
      setError(null);
      clearMcpLastError();
      // The switch, as the person used it: only when the server really is in the state they asked for.
      if (s.running === next) reportMcpEvent(next ? "mcp_enabled" : "mcp_disabled");
    } catch (e) {
      if (e instanceof McpStartCancelled) return; // switched off again while it waited: nothing failed
      setRunning(false);
      setError(recordMcpError(e));
      if (next) reportMcpEvent("mcp_bind_failed", { reason: mcpBindFailureReason(e, "toggle") });
    } finally {
      setBusy(false);
    }
  };

  const waiting = busy || starting;

  return (
    <div>
      <p className="text-sm text-neutral-300">
        Let an external agent — Claude Code, Cursor, Codex, Copilot — edit the project you have
        open, using the same tools the built-in assistant uses.
      </p>

      <div className="mt-3 flex items-center justify-between rounded border border-edge px-3 py-2">
        <div>
          <div className="text-xs font-medium text-neutral-200">
            {running
              ? "MCP server is on"
              : waiting
                ? "MCP server is starting"
                : "MCP server is off"}
          </div>
          <div className="text-[11px] text-neutral-500">
            {running ? (
              <>
                Running on <span className="font-mono">127.0.0.1:{MCP_PORT}</span>
              </>
            ) : waiting ? (
              "Starting…"
            ) : (
              "Agents cannot connect until you turn it on."
            )}
          </div>
        </div>
        {/* The state is in the words above and the action is named here: a button that only said "On" turned the server OFF on the first press (the server starts on). */}
        <button
          type="button"
          role="switch"
          aria-checked={running}
          aria-label="MCP server"
          onClick={() => void toggle()}
          disabled={waiting}
          className="flex shrink-0 items-center gap-2 text-[11px] text-neutral-300 hover:text-neutral-100 disabled:opacity-50"
        >
          <span
            className={cn(
              "relative h-4 w-7 rounded-full transition-colors",
              running ? "bg-brand" : "bg-neutral-700",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all",
                running ? "left-3.5" : "left-0.5",
              )}
            />
          </span>
          <span>{running ? "Turn off" : "Turn on"}</span>
        </button>
      </div>

      <p
        className={cn(
          "mt-2 text-[11px]",
          running || waiting ? "text-neutral-500" : "text-amber-400",
        )}
      >
        {running
          ? "Reachable only from this machine — it is not exposed to your network."
          : waiting
            ? `If the app was just restarted, the old copy can take a few seconds to let go of port ${MCP_PORT}. This waits up to ${MCP_BIND_WAIT_MS / 1000} seconds.`
            : "Turn this on before adding the server to an agent, or the connection will be refused."}
      </p>
      {!running && !waiting && error ? (
        <p className="mt-1 break-words text-[11px] text-amber-400/80">
          It last failed with: {error}
        </p>
      ) : null}
      {running ? <ConnectedPrograms /> : null}

      {CLIENTS.map((c) => (
        <Snippet key={c.label} {...c} />
      ))}

      <p className="mt-3 text-[11px] text-neutral-500">
        A session starts with no project selected — ask the agent to run <code>manage_project</code>{" "}
        first to list and open one.
      </p>
    </div>
  );
}
