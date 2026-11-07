// Which program is connected, from what it announces about itself when it connects (MCP's `initialize`
// carries `clientInfo: { name, version }`). Until now the app answered `initialize` and threw that away, so
// the 14 users and 2,274 calls over MCP could not be told apart: the agent that drives the editor was the
// biggest unknown in the data. This is the one place a name becomes a label.
//
// Two things are kept, both about a PROGRAM and never about the person: a label from a closed list (so
// counts are countable) and the name it announced, cut to the characters a name is made of, so a client we
// do not know yet shows up under its own name instead of vanishing into "other".

/** The labels a client can have. Written down again on the server (analytics.py MCP_CLIENTS). */
export const MCP_CLIENTS = [
  "claude_code",
  "claude_desktop",
  "vscode",
  "cursor",
  "codex",
  "antigravity",
  "windsurf",
  "gemini_cli",
  "zed",
  "inspector",
  "other",
  "unknown",
] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

/** What a person calls each program, for the panel. Every label has one (a test walks the whole list); `other` has no name
 *  of its own, so the panel shows what that program announced instead. */
export const MCP_CLIENT_TITLES: Record<McpClient, string> = {
  claude_code: "Claude Code",
  claude_desktop: "Claude Desktop",
  vscode: "VS Code / Copilot",
  cursor: "Cursor",
  codex: "Codex",
  antigravity: "Antigravity",
  windsurf: "Windsurf",
  gemini_cli: "Gemini CLI",
  zed: "Zed",
  inspector: "MCP Inspector",
  other: "Another program",
  unknown: "An agent",
};

/** The most characters of a program's announced name and version that are kept. Written down again on the
 *  server (schemas.py AgentBatchBody), which cuts rather than refuses. */
export const MCP_CLIENT_NAME_MAX = 40;
export const MCP_CLIENT_VERSION_MAX = 20;

/** In the order they are tried: the first that matches wins, so a name that mentions two programs ("cursor-vscode",
 *  an editor built on VS Code) is the more specific one. */
const RULES: ReadonlyArray<readonly [RegExp, McpClient]> = [
  [/cursor/, "cursor"],
  [/windsurf|codeium/, "windsurf"],
  [/antigravity/, "antigravity"],
  [/claude[\s_.-]*code/, "claude_code"],
  [/claude/, "claude_desktop"],
  [/codex/, "codex"],
  [/gemini/, "gemini_cli"],
  [/copilot|vs[\s_.-]*code|visual[\s_.-]*studio/, "vscode"],
  [/\bzed\b/, "zed"],
  [/inspector/, "inspector"],
];

const NAME_ALPHABET = /[^A-Za-z0-9_.:-]/g;

/** A program's name or version as the characters names are made of (anything else becomes `_`), cut to `cap`. */
export function legalClientText(value: unknown, cap: number): string {
  return typeof value === "string" ? value.trim().replace(NAME_ALPHABET, "_").slice(0, cap) : "";
}

/** The label for a client name. Any input: a name nobody has heard of is `other`, no name at all is `unknown`,
 *  and nothing here ever throws. */
export function normalizeMcpClient(name: unknown): McpClient {
  if (typeof name !== "string" || !name.trim()) return "unknown";
  const lowered = name.toLowerCase();
  for (const [pattern, label] of RULES) if (pattern.test(lowered)) return label;
  return "other";
}

export interface McpClientFacts {
  /** The closed label. */
  client: McpClient;
  /** What the program called itself, in the name alphabet and at most MCP_CLIENT_NAME_MAX characters. */
  name: string;
  /** Its version, in the name alphabet and at most MCP_CLIENT_VERSION_MAX characters. */
  version: string;
}

/** What is recorded about a connecting client, from the `clientInfo` Rust carries across. */
export function mcpClientFacts(info: unknown): McpClientFacts {
  const record = info && typeof info === "object" ? (info as Record<string, unknown>) : {};
  return {
    client: normalizeMcpClient(record.name),
    name: legalClientText(record.name, MCP_CLIENT_NAME_MAX),
    version: legalClientText(record.version, MCP_CLIENT_VERSION_MAX),
  };
}
