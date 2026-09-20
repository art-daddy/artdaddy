// Connect-an-agent pane: what the port is, whether it's live, and the exact config to paste.
//
// The server is useless without this — an external agent can only reach the app if the user knows
// the endpoint exists. established desktop NLEs ships the same thing (Help > MCP Instructions) for the same
// reason, alongside the Settings toggle.
import { useEffect, useState } from "react";

import { BRAND } from "../brand";
import {
  claudeCodeCommand,
  cursorConfigJson,
  cursorInstallUrl,
  installClaudeConnector,
  type InstallOutcome,
  openInstallLink,
  vscodeInstallUrl,
} from "../mcp/install";
import {
  MCP_PORT,
  clearMcpLastError,
  mcpLastError,
  recordMcpError,
  setMcpEnabledPreference,
  startMcpServer,
  stopMcpServer,
} from "../mcp/service";
import { useMcpPanel } from "../store/mcpPanel";
import { Button, cn } from "./ui";

const endpoint = `http://127.0.0.1:${MCP_PORT}/mcp`;
// Must match the name mcp.rs advertises, since this is what the user pastes.
const server = BRAND.mcpServerName;

type Client = {
  label: string;
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
    install: cursorInstallUrl,
    note: "or add to ~/.cursor/mcp.json",
    code: cursorConfigJson(),
  },
  {
    label: "VS Code / Copilot",
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
    note: "installs for every project on Linux, macOS and Windows while ArtDaddy is running",
    code: claudeCodeCommand(),
  },
  { label: "Codex", code: `codex mcp add ${server} --url ${endpoint}` },
];

function Snippet({ label, code, note, install, installer }: Client) {
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState("");
  const [hint, setHint] = useState("");
  const [done, setDone] = useState(false);

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
      {note && <p className="text-[11px] text-neutral-500">{note}</p>}
      <pre className="mt-1 overflow-x-auto rounded border border-edge bg-black/40 p-2 text-[11px] leading-relaxed text-neutral-300">
        {code}
      </pre>
    </div>
  );
}

export default function McpPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(mcpLastError());
  const running = useMcpPanel((s) => s.running);
  const setRunning = useMcpPanel((s) => s.setRunning);
  const refresh = useMcpPanel((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Driven by whether the server IS running, never by the stored preference. Those disagree
  // exactly when the user needs this panel — a boot failure left the button reading "On" above
  // the word "Stopped", and clicking it turned the preference OFF instead of starting anything.
  const toggle = async () => {
    const next = !running;
    setBusy(true);
    setMcpEnabledPreference(next);
    try {
      const s = next ? await startMcpServer() : await stopMcpServer();
      setRunning(s.running);
      setError(null);
      clearMcpLastError();
    } catch (e) {
      setRunning(false);
      setError(recordMcpError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="text-sm text-neutral-300">
        Let an external agent — Claude Code, Cursor, Codex, Copilot — edit the project you have
        open, using the same tools the built-in assistant uses.
      </p>

      <div className="mt-3 flex items-center justify-between rounded border border-edge px-3 py-2">
        <div>
          <div className="text-xs font-medium text-neutral-200">MCP server</div>
          <div className="text-[11px] text-neutral-500">
            {running ? (
              <>
                Running on <span className="font-mono">127.0.0.1:{MCP_PORT}</span>
              </>
            ) : (
              "Stopped"
            )}
          </div>
        </div>
        <Button
          variant={running ? "primary" : "ghost"}
          onClick={() => void toggle()}
          disabled={busy}
        >
          {running ? "On" : "Off"}
        </Button>
      </div>

      <p className={cn("mt-2 text-[11px]", running ? "text-neutral-500" : "text-amber-400")}>
        {running
          ? "Reachable only from this machine — it is not exposed to your network."
          : "Turn this on before adding the server to an agent, or the connection will be refused."}
      </p>
      {!running && error ? (
        <p className="mt-1 break-words text-[11px] text-amber-400/80">
          It last failed with: {error}
        </p>
      ) : null}

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
