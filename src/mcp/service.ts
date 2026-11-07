// Starting and stopping the local MCP server, and remembering whether the user wants it.
//
// Default ON (matching established desktop NLEs): the whole point is that an
// external agent can connect without the user first hunting for a setting. It binds to loopback
// only, so "on by default" does not expose anything to the network.
import { platform } from "../platform";
import { reportMcpEvent } from "../api/appEvents";
import { captureError } from "../observability/sentry";
import { startMcpBridge } from "./bridge";
import { useMcpConnections } from "./connections";

export const MCP_PORT = 19787;
/** How long a start keeps asking for the port while something else holds it. The usual holder is the copy of the app
 *  this one replaced (a relaunch, an update), which is still closing: waiting turns an error the person had to fix by
 *  hand into a start that simply works. A start never waits longer than this. */
export const MCP_BIND_WAIT_MS = 10_000;
const MCP_BIND_RETRY_MS = 500;
const PREF_KEY = "artdaddy.mcp.enabled";

export interface McpStatus {
  running: boolean;
  port: number;
}

/** Who answers on the port the app could not take, as the desktop side finds out (`mcp_port_holder`). `none` means
 *  nothing answers any more: it was let go in the meantime. */
export interface PortHolder {
  holder: "artdaddy" | "other" | "none";
  /** Another program's file name, when the system says. Only ever read by the message the person sees: never reported. */
  process?: string;
}

export function mcpEnabledPreference(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setMcpEnabledPreference(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "true" : "false");
  } catch {
    /* private mode: the preference just won't persist */
  }
}

async function core() {
  return (await import("@tauri-apps/api/core")).invoke;
}

export async function mcpStatus(): Promise<McpStatus> {
  if (platform.name !== "tauri") return { running: false, port: MCP_PORT };
  try {
    const invoke = await core();
    return await invoke<McpStatus>("mcp_status");
  } catch {
    return { running: false, port: MCP_PORT };
  }
}

/** What the wait for the port needs from time, so a test can run ten seconds of waiting in no time. */
export interface BindClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: BindClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface StartOptions {
  /** Which door asked (the boot hook or the panel's switch): kept with the report of a wait. */
  where?: "boot" | "toggle";
  clock?: BindClock;
}

export type BindFailure = "in_use" | "reserved" | "other";

const PORT_IN_USE = /(10048|address (already )?in use|EADDRINUSE|only one usage of each socket)/i;
// Windows sets whole ranges of ports aside for virtual machines and containers, and refuses to bind inside one.
const PORT_RESERVED = /(10013|forbidden by its access permissions)/i;

const rawMessage = (e: unknown): string => (e as Error)?.message ?? String(e);

/** The port stayed taken for the whole wait. Carries who held it, when that could be found out, so the one function that
 *  words the message and the one that counts the failure both see the same thing. */
export class McpPortTakenError extends Error {
  readonly holder: PortHolder | null;
  constructor(message: string, holder: PortHolder | null) {
    super(message);
    this.name = "McpPortTakenError";
    this.holder = holder;
  }
}

/** The server was switched off while a start was still waiting for the port, so that start must not take it afterwards. */
export class McpStartCancelled extends Error {
  constructor() {
    super("the MCP server was switched off before it started");
    this.name = "McpStartCancelled";
  }
}

export function classifyBindError(e: unknown): BindFailure {
  if (e instanceof McpPortTakenError) return "in_use";
  const raw = rawMessage(e);
  if (PORT_IN_USE.test(raw)) return "in_use";
  return PORT_RESERVED.test(raw) ? "reserved" : "other";
}

const HOLDERS: readonly unknown[] = ["artdaddy", "other", "none"];

/** What the desktop side said about who holds the port, kept only when it has the expected shape. The program's name is
 *  shown to a person, so it is cut down to plain letters, digits and `. _ - ( )`, the same set the desktop side keeps. */
export function readPortHolder(raw: unknown): PortHolder | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { holder, process } = raw as { holder?: unknown; process?: unknown };
  if (!HOLDERS.includes(holder)) return null;
  const name =
    typeof process === "string"
      ? process
          .replace(/[^\w .()-]/g, "")
          .slice(0, 64)
          .trim()
      : "";
  return { holder: holder as PortHolder["holder"], ...(name ? { process: name } : {}) };
}

async function findPortHolder(
  invoke: Awaited<ReturnType<typeof core>>,
): Promise<PortHolder | null> {
  try {
    return readPortHolder(await invoke<unknown>("mcp_port_holder", { port: MCP_PORT }));
  } catch {
    return null; // only an explanation is lost
  }
}

let starting: Promise<McpStatus> | null = null;
// How many times the server has been switched off. A start that began before the latest stop is stale.
let stops = 0;
// The latest stop still on its way to the desktop side. A start made straight after a stop waits for it, so the two commands
// cannot reach the server in the opposite order and leave it off while the screen says on.
let stopping: Promise<unknown> = Promise.resolve();

const changeListeners = new Set<() => void>();

/** Told whenever a start begins or ends and after a stop, so what the screen shows follows a start nobody on screen asked
 *  for (the boot hook, which now waits for the port instead of failing at once). */
export function onMcpChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function changed(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {
      /* a listener that throws must not break the start that told it */
    }
  }
}

export function mcpStarting(): boolean {
  return starting !== null;
}

const waitedSeconds = (ms: number): number =>
  Math.min(MCP_BIND_WAIT_MS / 1000, Math.max(1, Math.ceil(ms / 1000)));

async function bindWhenFree({
  where = "toggle",
  clock = realClock,
}: StartOptions): Promise<McpStatus> {
  const generation = stops;
  await stopping;
  // The bridge must be listening BEFORE the socket accepts anyone: a client that connects first
  // would have its tools/list time out against a bridge nobody is answering.
  await startMcpBridge();
  const invoke = await core();
  const began = clock.now();
  for (let attempt = 1; ; attempt += 1) {
    // Checked with nothing awaited between it and the command, so after a stop no start can follow it.
    if (generation !== stops) throw new McpStartCancelled();
    let status: McpStatus | undefined;
    try {
      status = await invoke<McpStatus>("mcp_start", { port: MCP_PORT });
    } catch (e) {
      // Only a taken port is worth waiting for: anything else will not get better by asking again.
      if (classifyBindError(e) !== "in_use") throw e;
      if (clock.now() - began + MCP_BIND_RETRY_MS > MCP_BIND_WAIT_MS) {
        throw new McpPortTakenError(rawMessage(e), await findPortHolder(invoke));
      }
    }
    if (status) {
      if (attempt > 1) {
        reportMcpEvent("mcp_bind_waited", {
          reason: `${waitedSeconds(clock.now() - began)}s:${where}`,
        });
      }
      return status;
    }
    await clock.sleep(MCP_BIND_RETRY_MS);
  }
}

export function startMcpServer(options: StartOptions = {}): Promise<McpStatus> {
  if (platform.name !== "tauri") return Promise.resolve({ running: false, port: MCP_PORT });
  // One start at a time: a second caller (the panel, while the boot hook is still waiting for the port) joins it instead
  // of running a second series of attempts on the same socket.
  if (starting) return starting;
  const attempt: Promise<McpStatus> = bindWhenFree(options)
    .then(
      (status) => {
        clearMcpLastError();
        return status;
      },
      (e: unknown) => {
        // Written down where it happens, so every caller (and the panel, which may be opened later) reads the same words.
        if (!(e instanceof McpStartCancelled)) recordMcpError(e);
        throw e;
      },
    )
    .finally(() => {
      if (starting === attempt) starting = null;
      changed();
    });
  starting = attempt;
  changed();
  return attempt;
}

export async function stopMcpServer(): Promise<McpStatus> {
  if (platform.name !== "tauri") return { running: false, port: MCP_PORT };
  // A start still waiting for the port is cancelled, and the next start is a new one rather than a join to it.
  stops += 1;
  starting = null;
  const stop = (async () => {
    const invoke = await core();
    return await invoke<McpStatus>("mcp_stop");
  })();
  stopping = stop.catch(() => undefined);
  const status = await stop;
  // Nobody is connected to a server that is off; whoever is still asking will be refused, and will be listed again if it
  // gets through after the next start.
  useMcpConnections.getState().clear();
  changed();
  return status;
}

let lastError: string | null = null;

/** Why the server is not running, when the preference says it should be. The panel shows this:
 *  a boot failure used to reach only `console.warn`, which no user opens and which release
 *  builds did not even write to the log file. */
export function mcpLastError(): string | null {
  return lastError;
}

export function clearMcpLastError(): void {
  lastError = null;
}

function portTakenMessage(holder: PortHolder | null): string {
  const taken = `Port ${MCP_PORT} is in use`;
  switch (holder?.holder) {
    case "artdaddy":
      return (
        `${taken} by another copy of this app: a second window, or another Windows account signed in on this ` +
        `computer. Close it (end it in Task Manager if you cannot see a window) and switch this back on.`
      );
    case "other":
      return (
        `${taken} by ${holder.process ? `another program (${holder.process})` : "another program"}. ` +
        `Close it and switch this back on.`
      );
    case "none":
      return `Port ${MCP_PORT} was busy a moment ago and looks free now. Switch this back on.`;
    default:
      return `${taken} by another copy of this app or another program. Close it and switch this back on.`;
  }
}

/** Turn a boot failure into something the person reading it can act on. Both the boot hook and
 *  the panel toggle go through here, so neither can show a rawer message than the other.
 *
 *  A taken port is the case that matters, and what to do depends on who holds it: another copy of this app (close it), another
 *  program (close that), or no one any more (try again). "os error 10048" told nobody any of that. */
export function explainMcpError(e: unknown): string {
  switch (classifyBindError(e)) {
    case "in_use":
      return portTakenMessage(e instanceof McpPortTakenError ? e.holder : null);
    case "reserved":
      return (
        `Windows has set port ${MCP_PORT} aside for something else (it does this for virtual machines and ` +
        `containers). Restarting the computer usually frees it.`
      );
    default:
      return rawMessage(e);
  }
}

const HOLDER_WORDS = { artdaddy: "_artdaddy", other: "_other", none: "_none" } as const;

/** Why the server did not start, as a closed word plus where it happened: what is worth counting is who holds the port
 *  (another copy of the app, another program, no one) and whether Windows reserved it. The raw message, which names
 *  addresses and paths, and the other program's name are never reported. */
export function mcpBindFailureReason(e: unknown, where: "boot" | "toggle"): string {
  const failure = classifyBindError(e);
  if (failure === "in_use") {
    const holder = e instanceof McpPortTakenError ? e.holder?.holder : undefined;
    return `port_in_use${holder ? HOLDER_WORDS[holder] : ""}:${where}`;
  }
  return `${failure === "reserved" ? "port_reserved" : "other"}:${where}`;
}

export function recordMcpError(e: unknown): string {
  lastError = explainMcpError(e);
  return lastError;
}

/** Boot hook: honour the preference. A failure here must never block the app — the editor works
 *  perfectly well with no external agent attached — but it must not be silent either. */
export async function initMcp(): Promise<void> {
  if (platform.name !== "tauri" || !mcpEnabledPreference()) return;
  // The effect that calls this runs again when the app is allowed to work, a few seconds into every launch. A start that is
  // already waiting for the port is that same start, and it reports for itself: once.
  if (mcpStarting()) return;
  try {
    await startMcpServer({ where: "boot" });
    clearMcpLastError();
  } catch (e) {
    if (e instanceof McpStartCancelled) return;
    captureError(e, { where: "initMcp" });
    reportMcpEvent("mcp_bind_failed", { reason: mcpBindFailureReason(e, "boot") });
    console.warn("[mcp] server did not start; external agents cannot connect", recordMcpError(e));
  }
}
