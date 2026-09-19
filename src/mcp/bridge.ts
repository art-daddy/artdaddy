// The webview half of the MCP server.
//
// Rust owns the socket and the JSON-RPC framing; it forwards `tools/list` and `tools/call` here
// because this side owns the contract and the tool registry. Keeping the split at that line is
// what stops MCP from becoming a second implementation of the tool surface: an external agent
// runs the SAME `ToolHost.run()` the in-app agent does, against the SAME open project, so edits
// land in one undo history and one persisted document.
import { BRAND } from "../brand";
import { scrubAbsolutePaths } from "../agent/scrubPaths";
import { capToolResult } from "../agent/truncate";
import { mcpInstructions } from "./instructions";
import { mcpTools } from "./tools";

// Wire identifiers shared with Rust, not brand text: renaming one without the other
// silently drops every request.
const REQUEST_EVENT = "artdaddy://mcp-request";
const CANCEL_EVENT = "artdaddy://mcp-cancel";

// A client's Stop button arrives as `notifications/cancelled`; Rust maps it back to the bridge id
// and emits CANCEL_EVENT. Without this the tool runs to completion after the user gave up â€” a
// 4K render would keep burning CPU with nobody waiting for it.
const inFlight = new Map<number, AbortController>();

// The store, the tool host and the contract are loaded LAZILY, per request. Importing them at
// module scope would drag the entire tool registry into the app's first chunk purely because
// App.tsx mounts this, which is both a slower boot and an import cycle waiting to happen.
const projects = async () => (await import("../store/projects")).useProjects;
const contract = () => import("../contract");

/** Activating a project only sets `activeId`; the Shell opens its ProjectDocument in an effect a
 *  tick later, and every timeline mutation needs that document (`applyOp` refuses a bare store
 *  with "no open project for this store"). An external agent has no way to know that, so wait
 *  here rather than hand it a project it cannot edit yet. */
async function waitForDocument(id: string, ms = 15_000): Promise<boolean> {
  const { openDocumentById } = await import("../project/openDocuments");
  const deadline = Date.now() + ms;
  for (;;) {
    if (openDocumentById(id)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Open a project the way a click does: navigate to its route. The Shell owns the document
 *  lifecycle (it opens the editor, chat and tool host as one unit and closes them on the way
 *  out), so calling `projectDocuments.open` from here instead would create a SECOND lifecycle
 *  owner whose document the next route change would quietly close underneath the agent. */
async function activateProject(id: string): Promise<boolean | "signed-out"> {
  // That Shell only mounts once the auth gate is open. Waiting 15s for a document that cannot
  // appear would then report a routing problem, which is not what is wrong.
  const { isSignedOutGate } = await import("../store/auth");
  if (isSignedOutGate()) return "signed-out";
  const route = `/p/${id}`;
  if (window.location.pathname !== route) {
    window.history.pushState({}, "", route);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  return waitForDocument(id);
}

interface BridgeRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** MCP's result envelope. Tool payloads are JSON, so they travel as a text block; rendered frames
 *  travel beside it as image blocks (see `mcpImageBlocks`). */
function textResult(
  value: unknown,
  isError = false,
  extra: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }, ...extra], isError };
}

async function listTools(): Promise<Record<string, unknown>> {
  return { tools: mcpTools() };
}

/** Project navigation, the one tool that exists only for MCP: an external session has no window
 *  to click in and may start with nothing open. */
async function manageProject(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const useProjects = await projects();
  const store = useProjects.getState();
  const action = String(args.action ?? "");
  switch (action) {
    case "list": {
      await store.refresh();
      const { projects, activeId } = useProjects.getState();
      return textResult({
        active_id: activeId,
        projects: projects.map((p) => ({ id: p.id, name: p.name })),
      });
    }
    case "current": {
      // On a cold start `activeId` is restored from the persisted preference while the project
      // LIST is still empty, so looking the name up here found nothing and reported a project the
      // user has open as nameless. `list` already refreshes for exactly this reason; do it here
      // too, and only when the lookup actually misses so the usual call stays cheap.
      let { activeId, active } = (await projects()).getState();
      if (activeId && !active) {
        await store.refresh();
        ({ activeId, active } = (await projects()).getState());
      }
      return activeId
        ? textResult({ active_id: activeId, name: active?.name ?? null })
        : textResult({
            active_id: null,
            hint: "no project open â€” use action='open' or 'create'",
          });
    }
    case "open": {
      const id = String(args.id ?? "");
      if (!id) return textResult("open requires 'id' (from action='list')", true);
      const ready = await activateProject(id);
      if (ready === "signed-out")
        return textResult(
          {
            opened: id,
            ready: false,
            reason:
              "the app is showing its sign-in screen, so it has no editor open and no project can be activated",
            remedy: "sign in in the ArtDaddy window, then call manage_project action='open' again",
          },
          true,
        );
      // `ready:false` used to travel alone, and it is not an error, so a caller reasonably carried
      // on â€” and every later write went to the project that was still active. Say what it means and
      // what to do, and never let it read as success.
      return ready
        ? textResult({ opened: id, ready })
        : textResult(
            {
              opened: id,
              ready: false,
              reason:
                "the project did not finish opening, so it cannot be edited yet and the previously active project is still the one that will receive writes",
              remedy:
                "call manage_project action='current' to see what is actually active, then action='open' again. If the app shows 'already open somewhere else', close it there first.",
            },
            true,
          );
    }
    case "create": {
      const name = String(args.name ?? "").trim();
      if (!name) return textResult("create requires 'name'", true);
      const summary = await store.create(
        name,
        args.aspect ? String(args.aspect) : undefined,
        typeof args.fps === "number" ? args.fps : undefined,
      );
      // `create` only registers it on disk; opening is a separate act, and every timeline tool
      // needs the open document (`applyOp` refuses a bare store).
      const ready = await activateProject(summary.id);
      return textResult({ created: summary.id, name: summary.name, ready });
    }
    default:
      return textResult(`unknown action '${action}' â€” use list, current, open, or create`, true);
  }
}

async function callTool(
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const name = String(params.name ?? "");
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  if (name === "manage_project") return manageProject(args);

  const useProjects = await projects();
  const { activeId } = useProjects.getState();
  if (!activeId) {
    return textResult(
      "No project is open. Call manage_project with action='list' then action='open' first.",
      true,
    );
  }

  const { openToolHost } = await import("../tools/host");
  const host = openToolHost(activeId);
  await host.ready;
  // A session that opened its project through the UI (or a previous call) already has a document;
  // one that never did would fail deep inside the mutation with a confusing store error.
  const ready = await activateProject(activeId);
  // manage_project already refused a gated app; every OTHER tool used to discard this and run
  // anyway, so a signed-out session got whatever error the tool happened to raise -- deep in the
  // store for a local edit, an HTTP 401 for a hosted one -- and an agent has no way to read
  // either as "the human needs to sign in".
  if (ready === "signed-out") {
    return textResult(
      {
        tool: name,
        ran: false,
        reason:
          "the app is showing its sign-in screen, so it has no project open and no tool can run",
        remedy: "ask the user to sign in in the ArtDaddy window, then call this again",
      },
      true,
    );
  }
  // The catalog, not the tool host, decides what is callable. A withdrawn tool keeps its
  // implementation (so it can be brought back), so `host.has` still answers yes for one — and an
  // agent that remembers the name from an older session, or that skipped tools/list entirely,
  // would otherwise still reach it.
  const { allTools } = await contract();
  const offered = new Set(allTools().map((t) => t.name));
  if (!offered.has(name)) return textResult(`unknown tool: ${name}`, true);
  if (!host.has(name)) return textResult(`unknown tool: ${name}`, true);

  // No `origin` is passed: an MCP call is not part of a chat execution, so the mutation gate's
  // supersede check does not apply to it. It still runs under the project lock like any edit.
  const out = await host.run(name, args, signal);
  const failed = !!out && typeof out === "object" && (out as { ok?: boolean }).ok === false;
  const images = await mcpImageBlocks(out);
  return textResult(sanitizeForMcp(out), failed, images);
}

/** How many rendered frames one reply may carry, and how big each may be. A reply is JSON over a
 *  socket, so an uncapped inspect of a long timeline would be tens of MB of base64. */
const MAX_IMAGE_BLOCKS = 8;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Turn a tool's `_attachments` into MCP image content.
 *
 *  The in-app agent drains these into the next model round; over MCP they were first returned RAW
 *  (an absolute path an external client usually cannot open) and then, once this door started
 *  scrubbing paths, dropped entirely â€” so `inspect_timeline` and `inspect_media` reported
 *  `frames_attached: N` and delivered nothing viewable. MCP has an image content type; the frames
 *  belong in it. Video/audio attachments have no MCP block type, so they are still summarised in
 *  the text payload rather than sent. */
async function mcpImageBlocks(out: unknown): Promise<Array<Record<string, unknown>>> {
  const atts = (out as { _attachments?: unknown } | null)?._attachments;
  if (!Array.isArray(atts) || !atts.length) return [];
  const store = (await import("../tools/host"))
    .openToolHost((await projects()).getState().activeId as string)
    .store();
  if (!store) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const a of atts) {
    if (blocks.length >= MAX_IMAGE_BLOCKS) break;
    const path = String((a as { path?: unknown })?.path ?? "");
    const dot = path.lastIndexOf(".");
    const mime = IMAGE_MIME[dot >= 0 ? path.slice(dot).toLowerCase() : ""];
    if (!mime) continue; // video/audio: no MCP block type for it
    try {
      const size = await store.byteSize(path).catch(() => null);
      if (size !== null && size > MAX_IMAGE_BYTES) continue;
      const bytes = await store.readBytes(path);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      blocks.push({
        type: "image",
        data: btoa(bin),
        mimeType: mime,
        ...(String((a as { caption?: unknown }).caption ?? "")
          ? { _caption: String((a as { caption?: unknown }).caption) }
          : {}),
      });
    } catch {
      /* unreadable frame â€” the text payload still reports it */
    }
  }
  return blocks;
}

/** The same hygiene the in-app agent's results get (loop.ts `runCall`), which this door was
 *  skipping entirely: an external agent was handed the user's absolute directory paths, the
 *  internal `_attachments` field, and results of unbounded size. The paths are the sharp one â€”
 *  they are private, and they teach an agent to address media by path in a product whose whole
 *  rule is that it cannot. */
export function sanitizeForMcp(out: unknown): unknown {
  if (!out || typeof out !== "object" || Array.isArray(out)) return out;
  const rec = { ...(out as Record<string, unknown>) };
  // Attachments are model-facing parts the in-app loop drains into the next round; over MCP there
  // is nowhere to put them, and each carries an absolute path.
  delete rec._attachments;
  return capToolResult(scrubAbsolutePaths(rec));
}

/** The bridge's whole contract with Rust: one request in, one payload out. Exported so a test can
 *  drive the real boundary rather than a private helper. */
export async function dispatch(
  req: BridgeRequest,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // The gate belongs to the DOOR, not to each method: the socket binds at boot, outside the
  // AuthProvider gate, so a signed-out app still answers here. Refusing per method would leave
  // tools/list -- which needs no session to answer from the bundled catalog -- advertising a
  // surface the user cannot reach, and the next method added would start out ungated.
  const { isSignedOutGate } = await import("../store/auth");
  if (isSignedOutGate()) {
    return textResult(
      {
        ran: false,
        reason: `${BRAND.displayName} is signed out, so nothing can be listed or run`,
        remedy: `ask the user to sign in to ${BRAND.displayName}, then try again`,
      },
      true,
    );
  }

  switch (req.method) {
    case "tools/list":
      return listTools();
    case "tools/call":
      return callTool(req.params ?? {}, signal);
    default:
      return textResult(`unsupported bridge method: ${req.method}`, true);
  }
}

let wiring: Promise<void> | null = null;

/** Subscribe to Rust's bridge events. Idempotent, and retryable after a failure.
 *
 *  This REJECTS rather than warning. Binding the socket with no bridge behind it is worse than
 *  refusing the connection: every tools/call an agent makes would hang until the call timeout,
 *  because Rust blocks a connection thread waiting for a reply nobody is listening to send. */
export async function startMcpBridge(): Promise<void> {
  // A promise, not a boolean: the old flag was set BEFORE the awaits, so a `listen` that never
  // settled left the module permanently "started" with no listeners registered â€” the exact
  // bound-but-dead state above, and unrecoverable without a restart.
  wiring ??= wire().catch((e: unknown) => {
    wiring = null;
    throw e;
  });
  return wiring;
}

async function wire(): Promise<void> {
  const [{ listen }, { invoke }] = await Promise.all([
    import("@tauri-apps/api/event"),
    import("@tauri-apps/api/core"),
  ]);

  await listen<{ id: number }>(CANCEL_EVENT, (event) => {
    inFlight.get(event.payload.id)?.abort();
  });

  await listen<BridgeRequest>(REQUEST_EVENT, (event) => {
    const req = event.payload;
    const controller = new AbortController();
    inFlight.set(req.id, controller);
    // Never let a rejection escape: Rust is blocking a connection thread on this id, and a
    // missing reply stalls it until the call timeout rather than returning an error.
    void dispatch(req, controller.signal)
      .catch((e: unknown) => textResult(`${(e as Error)?.message ?? e}`, true))
      .then((payload) => {
        inFlight.delete(req.id);
        return invoke("mcp_reply", { id: req.id, payload });
      })
      .catch(() => inFlight.delete(req.id));
  });

  // Hand Rust the instruction text: `initialize` is answered there, before any bridge call.
  void mcpInstructions()
    .then((text) => invoke("mcp_set_instructions", { text }))
    .catch(() => undefined);
}

export const __testing = { dispatch, textResult };
