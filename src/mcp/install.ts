// One-click MCP install links.
//
// Cursor and VS Code both register a server from a URL, so the app can hand the OS a link and
// let the editor write its own config. Claude Code and Codex have no such scheme — they are CLI
// only, so those stay as a copyable command rather than a button that pretends to be one.
//
// The two formats differ in a way that is easy to get backwards:
//   Cursor  — base64 of the INNER server object, with the name as a separate query param.
//   VS Code — url-encoded JSON of the WHOLE entry, name included, after the scheme.
import { BRAND } from "../brand";
import { platform } from "../platform";
import { MCP_PORT } from "./service";

const endpoint = (): string => `http://127.0.0.1:${MCP_PORT}/mcp`;
const serverName = (): string => BRAND.mcpServerName;

export function cursorInstallUrl(): string {
  const config = btoa(JSON.stringify({ type: "http", url: endpoint() }));
  return `https://cursor.com/en/install-mcp?name=${encodeURIComponent(serverName())}&config=${encodeURIComponent(config)}`;
}

export function vscodeInstallUrl(insiders = false): string {
  const entry = JSON.stringify({ name: serverName(), type: "http", url: endpoint() });
  return `${insiders ? "vscode-insiders" : "vscode"}:mcp/install?${encodeURIComponent(entry)}`;
}

/** Why an install attempt ended the way it did. The message is shown verbatim, so it has to say
 *  what the user should DO — "couldn't open" tells them nothing they can act on. */
export type InstallOutcome = { ok: true } | { ok: false; message: string };

const NO_DESKTOP = "Installing from here needs the desktop app. Use the config below.";

/** Outside the desktop shell there is nothing to hand a link to. Asked of the platform rather
 *  than inferred from whatever the failure happened to say: on the web build the import SUCCEEDS
 *  and `invoke` is simply undefined, so the user was shown "Cannot read properties of undefined
 *  (reading 'invoke')" — a developer's error message in a product surface. */
const onDesktop = (): boolean => platform.name === "tauri";

/** Open an install link through the Rust allowlist.
 *
 *  A resolved promise means the OS ACCEPTED the url — not that anything was installed. Windows
 *  reports success for a scheme nobody registered, so a button wired straight to this would say
 *  "done" to a user who has no such editor. Callers must keep the copyable config visible. */
export async function openInstallLink(url: string): Promise<InstallOutcome> {
  if (!onDesktop()) return { ok: false, message: NO_DESKTOP };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_install_link", { url });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: reason(e) };
  }
}

/** Install the Claude Desktop connector by handing it the bundled `.mcpb`.
 *
 *  Unlike the url handlers this one CAN be checked: Rust looks for the app before opening
 *  anything and returns a message naming the missing piece. */
export async function installClaudeConnector(): Promise<InstallOutcome> {
  if (!onDesktop()) return { ok: false, message: NO_DESKTOP };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_mcp_bundle");
    return { ok: true };
  } catch (e) {
    return { ok: false, message: reason(e) };
  }
}

function reason(e: unknown): string {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  // Rust's own refusals read as instructions; anything else is an internals failure the user can
  // do nothing with, so it becomes the actionable fallback rather than a stack-trace fragment.
  if (!text || /invoke|dynamically imported|is not a function|undefined|__TAURI/i.test(text))
    return NO_DESKTOP;
  return text;
}
